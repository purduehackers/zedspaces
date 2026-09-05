//! First-boot and every-boot filesystem work (brief §3.14; D9, D18).
//!
//! Runs as the invoking user (`ubuntu`), never `sudo`. Every long step takes the `shutdown`
//! token: a `SIGTERM` during restore/clone/dotfiles/postCreate kills the running child group and
//! returns an error without leaving half-finished state behind.

use std::collections::{BTreeMap, BTreeSet};
use std::io::Write as _;
use std::os::unix::fs::OpenOptionsExt as _;
use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock};
use std::time::Duration;

use anyhow::{anyhow, bail};
use regex::Regex;
use tokio_util::sync::CancellationToken;

use crate::config::{Config, ensure_private_dir};
use crate::control_plane::ControlPlane;
use crate::logs::{LogShipper, LogSource};
use crate::manifest::{
    DevcontainerConfig, DevcontainerSource, DotfilesSpec, LifecycleCommand, LifecycleCommandLeaf,
    Manifest, RepoSpec, RestoreSpec, Service, SettingsDocs,
};
use crate::state::AgentState;

/// `postCreateCommand` budget.
pub const POST_CREATE_TIMEOUT: Duration = Duration::from_secs(30 * 60);
/// `postStartCommand` budget.
pub const POST_START_TIMEOUT: Duration = Duration::from_secs(10 * 60);
/// `postAttachCommand` budget.
pub const POST_ATTACH_TIMEOUT: Duration = Duration::from_secs(10 * 60);
/// Dotfiles clone + installer budget.
pub const DOTFILES_TIMEOUT: Duration = Duration::from_secs(10 * 60);
/// Rebuild tarball download + extraction budget.
pub const RESTORE_TIMEOUT: Duration = Duration::from_secs(20 * 60);
/// `git fetch` budget for the initial checkout.
pub const CLONE_TIMEOUT: Duration = Duration::from_secs(20 * 60);
/// Budget for the short git steps around the fetch (`init`, `remote add`, `switch`).
pub const GIT_STEP_TIMEOUT: Duration = Duration::from_secs(2 * 60);
/// Installer scripts probed in a dotfiles checkout, in order.
pub const DOTFILES_INSTALLERS: [&str; 8] = [
    "install.sh",
    "install",
    "bootstrap.sh",
    "bootstrap",
    "script/bootstrap",
    "setup.sh",
    "setup",
    "script/setup",
];

/// Boot markers under `<state>/markers`.
pub struct Markers {
    dir: PathBuf,
}

impl Markers {
    /// Markers rooted at `dir` (created 0700 on the first write).
    pub fn new(dir: PathBuf) -> Self {
        Self { dir }
    }

    /// `clone.done` – written only after the atomic rename of the checkout.
    pub fn clone_done(&self) -> bool {
        self.dir.join("clone.done").exists()
    }

    /// Writes `clone.done`.
    pub fn set_clone_done(&self) -> std::io::Result<()> {
        self.write("clone.done", "1")
    }

    /// Contents of `post-create.done`: `sha256:<hex>` of the devcontainer file bytes, or `"none"`.
    pub fn post_create_done(&self) -> Option<String> {
        self.read("post-create.done")
    }

    /// Writes `post-create.done`.
    pub fn set_post_create_done(&self, hash: &str) -> std::io::Result<()> {
        self.write("post-create.done", hash)
    }

    /// Contents of `dotfiles.done`: the dotfiles repo URL.
    pub fn dotfiles_done(&self) -> Option<String> {
        self.read("dotfiles.done")
    }

    /// Writes `dotfiles.done`.
    pub fn set_dotfiles_done(&self, repo_url: &str) -> std::io::Result<()> {
        self.write("dotfiles.done", repo_url)
    }

    /// `first-boot.done` exists ⇒ this boot is a resume (drives `resumed` and the `resumed` notice).
    pub fn first_boot_done(&self) -> bool {
        self.dir.join("first-boot.done").exists()
    }

    /// Writes `first-boot.done`.
    pub fn set_first_boot_done(&self) -> std::io::Result<()> {
        self.write("first-boot.done", "1")
    }

    /// Missing marker or a different hash.
    pub fn needs_post_create(&self, current_hash: &str) -> bool {
        self.post_create_done().as_deref() != Some(current_hash)
    }

    /// `settings.sha256` / `keymap.sha256`: sha256 of the text last written by the supervisor.
    pub fn settings_written(&self, kind: &str) -> Option<String> {
        self.read(&format!("{kind}.sha256"))
    }

    /// Writes `<kind>.sha256`.
    pub fn set_settings_written(&self, kind: &str, sha256: &str) -> std::io::Result<()> {
        self.write(&format!("{kind}.sha256"), sha256)
    }

    fn read(&self, name: &str) -> Option<String> {
        std::fs::read_to_string(self.dir.join(name))
            .ok()
            .map(|contents| contents.trim().to_string())
    }

    fn write(&self, name: &str, contents: &str) -> std::io::Result<()> {
        ensure_private_dir(&self.dir)?;
        let final_path = self.dir.join(name);
        let tmp_path = self.dir.join(format!("{name}.tmp"));
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(0o600)
            .open(&tmp_path)?;
        file.write_all(contents.as_bytes())?;
        file.sync_all()?;
        std::fs::rename(tmp_path, final_path)
    }
}

/// A step was interrupted by `SIGTERM`; the caller unwinds without leaving half-finished state
/// and exits 0 (§3.16 step 3).
#[derive(Debug, thiserror::Error)]
#[error("cancelled")]
pub struct Cancelled;

/// How the checkout is created from `manifest.repo` (§3.14; D18 `repo.ref`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FetchPlan {
    /// The refspec handed to `git fetch`.
    pub refspec: String,
    /// `--depth` when the manifest asks for a shallow checkout.
    pub depth: Option<u32>,
    /// Branch to create at `FETCH_HEAD`, or `None` for a detached checkout.
    pub branch: Option<String>,
}

/// `repo.ref` wins (D18: `refs/pull/<n>/head`), then a 40-hex `revision` (fetched by sha, because
/// a shallow clone cannot reach a non-tip commit), then `refs/heads/<revision>`.
pub fn fetch_plan(repo: &RepoSpec) -> FetchPlan {
    let depth = (repo.depth > 0).then_some(repo.depth);
    if let Some(git_ref) = repo.git_ref.as_deref().filter(|r| !r.trim().is_empty()) {
        return FetchPlan {
            refspec: git_ref.to_string(),
            depth,
            branch: None,
        };
    }
    if is_sha(&repo.revision) {
        return FetchPlan {
            refspec: repo.revision.clone(),
            depth,
            branch: None,
        };
    }
    FetchPlan {
        refspec: format!("refs/heads/{}", repo.revision),
        depth,
        branch: Some(repo.revision.clone()),
    }
}

fn is_sha(revision: &str) -> bool {
    revision.len() == 40 && revision.chars().all(|c| c.is_ascii_hexdigit())
}

/// Repository materialisation into `manifest.workspace_dir` (decision table in §3.14): nothing
/// when `dir/.git` exists and `clone_done`; a truncated attempt is removed; `manifest.restore`
/// → [`restore_tarball`]; otherwise `git init <dir>.partial`, `git fetch [--depth N] origin
/// <refspec>` ([`fetch_plan`]), checkout, `mv <dir>.partial <dir>`, `set_clone_done`. Auth comes
/// from the credential helper, so the loopback API must already be listening.
pub async fn materialize_repo(
    manifest: &Manifest,
    config: &Config,
    control: &ControlPlane,
    logs: &LogShipper,
    shutdown: &CancellationToken,
) -> anyhow::Result<()> {
    let markers = Markers::new(config.markers_dir());
    let dir = &manifest.workspace_dir;
    let partial = partial_dir(dir);
    if dir.join(".git").is_dir() && markers.clone_done() {
        tracing::info!(dir = %dir.display(), "workspace checkout already present");
        return Ok(());
    }
    if dir.exists() {
        tracing::warn!(dir = %dir.display(), "removing a truncated earlier checkout");
        remove_tree(dir).await?;
    }
    let _ = remove_tree(&partial).await;
    let _ = remove_tree(&config.restore_dir()).await;

    if let Some(restore) = &manifest.restore {
        restore_tarball(restore, config, control, logs, shutdown).await?;
        markers.set_clone_done()?;
        return Ok(());
    }

    if let Some(parent) = dir.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let plan = fetch_plan(&manifest.repo);
    let env = config.child_env(&BTreeMap::new(), &BTreeMap::new());
    let result = clone_into(&partial, manifest, &plan, &env, logs, shutdown).await;
    if let Err(error) = result {
        let _ = remove_tree(&partial).await;
        return Err(error);
    }
    std::fs::rename(&partial, dir)?;
    markers.set_clone_done()?;
    tracing::info!(dir = %dir.display(), refspec = %plan.refspec, "workspace checkout ready");
    Ok(())
}

/// `remove_dir_all` on the blocking pool: a large tree can take seconds, during which the boot
/// task must stay responsive to `SIGTERM` (b9 waits 25 s on a stop). A missing path is not an
/// error.
async fn remove_tree(path: &Path) -> std::io::Result<()> {
    let path = path.to_path_buf();
    tokio::task::spawn_blocking(move || match std::fs::remove_dir_all(&path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        other => other,
    })
    .await
    .map_err(std::io::Error::other)?
}

/// `git init` / `remote add` / `fetch` / `switch` into the staging directory. Every value that
/// came from the manifest sits after `--`, so it can never be parsed as a git option (it is also
/// shape-checked by `Manifest::check_shape`).
async fn clone_into(
    partial: &Path,
    manifest: &Manifest,
    plan: &FetchPlan,
    env: &BTreeMap<String, String>,
    logs: &LogShipper,
    shutdown: &CancellationToken,
) -> anyhow::Result<()> {
    std::fs::create_dir_all(partial)?;
    let git = |args: &[&str]| -> Vec<String> {
        std::iter::once("git".to_string())
            .chain(args.iter().map(|arg| (*arg).to_string()))
            .collect()
    };
    run_command(
        &git(&["init", "--quiet"]),
        partial,
        env,
        GIT_STEP_TIMEOUT,
        LogSource::Agent,
        logs,
        shutdown,
    )
    .await?;
    run_command(
        &git(&["remote", "add", "--", "origin", &manifest.repo.clone_url]),
        partial,
        env,
        GIT_STEP_TIMEOUT,
        LogSource::Agent,
        logs,
        shutdown,
    )
    .await?;
    let mut fetch = git(&["fetch", "--no-tags", "--progress", "origin", "--"]);
    if let Some(depth) = plan.depth {
        fetch.insert(2, format!("--depth={depth}"));
    }
    fetch.push(plan.refspec.clone());
    run_command(
        &fetch,
        partial,
        env,
        CLONE_TIMEOUT,
        LogSource::Agent,
        logs,
        shutdown,
    )
    .await?;
    let checkout = git(&switch_args(plan.branch.as_deref()));
    run_command(
        &checkout,
        partial,
        env,
        GIT_STEP_TIMEOUT,
        LogSource::Agent,
        logs,
        shutdown,
    )
    .await
}

fn switch_args(branch: Option<&str>) -> Vec<&str> {
    match branch {
        Some(branch) => vec!["switch", "-C", branch, "FETCH_HEAD"],
        None => vec!["switch", "--detach", "FETCH_HEAD"],
    }
}

/// `<dir>.partial`, the staging path a clone is assembled in.
pub fn partial_dir(dir: &Path) -> PathBuf {
    let mut name = dir.as_os_str().to_os_string();
    name.push(".partial");
    PathBuf::from(name)
}

/// Rebuild restore (D9): stream `control.restore_tarball(url)` through a sha256 hasher into
/// `tar -xzf - -C <restore_dir>`, verify `sha256` when set, then move `workspaces/*` →
/// `<workspaces_dir>/`, `vercel/.local/share/zed` → `<data_dir>` and (pre-D9 archives)
/// `vercel/.config/zed` → `<home>/.config/zed`. Runs before the server starts, so no process holds
/// any of these paths.
pub async fn restore_tarball(
    spec: &RestoreSpec,
    config: &Config,
    control: &ControlPlane,
    logs: &LogShipper,
    shutdown: &CancellationToken,
) -> anyhow::Result<()> {
    let restore_dir = config.restore_dir();
    let _ = remove_tree(&restore_dir).await;
    std::fs::create_dir_all(&restore_dir)?;
    let env = config.child_env(&BTreeMap::new(), &BTreeMap::new());
    let outcome = download_and_extract(spec, &restore_dir, &env, control, logs, shutdown).await;
    if let Err(error) = outcome {
        let _ = remove_tree(&restore_dir).await;
        return Err(error);
    }
    // The moves (and the cross-device copy fallback) are synchronous filesystem work; keep
    // them off the runtime workers so a SIGTERM during a large restore is still observed.
    let layout = {
        let restore_dir = restore_dir.clone();
        let config = config.clone();
        tokio::task::spawn_blocking(move || apply_restore_layout(&restore_dir, &config))
            .await
            .map_err(|error| anyhow!("restore layout task: {error}"))
    };
    let _ = remove_tree(&restore_dir).await;
    layout?
}

/// The `tar -xzf - -C <restore_dir>` child. Its environment is the stripped child environment
/// (CONTRACTS §7.2: `ZS_SANDBOX_TOKEN`, `ZS_CONTROL_URL`, `ZS_BYPASS_SECRET`, … reach no child)
/// minus `TAR_OPTIONS`, which GNU tar would honour from the environment.
pub fn tar_command(restore_dir: &Path, env: &BTreeMap<String, String>) -> tokio::process::Command {
    let mut command = tokio::process::Command::new("tar");
    command
        .arg("-xzf")
        .arg("-")
        .arg("-C")
        .arg(restore_dir)
        .env_clear()
        .envs(env.iter().filter(|(key, _)| key.as_str() != "TAR_OPTIONS"))
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .process_group(0)
        .kill_on_drop(false);
    command
}

/// Streams the presigned tarball into `tar` while hashing it, and checks the digest.
async fn download_and_extract(
    spec: &RestoreSpec,
    restore_dir: &Path,
    env: &BTreeMap<String, String>,
    control: &ControlPlane,
    logs: &LogShipper,
    shutdown: &CancellationToken,
) -> anyhow::Result<()> {
    use futures_util::StreamExt as _;
    use sha2::{Digest as _, Sha256};
    use tokio::io::AsyncWriteExt as _;

    let stream = control.restore_tarball(&spec.tarball_url).await?;
    let mut stream = std::pin::pin!(stream);
    let mut child = tar_command(restore_dir, env).spawn()?;
    let pid = child.id().unwrap_or_default();
    if let Some(stderr) = child.stderr.take() {
        let logs = logs.clone();
        tokio::spawn(async move { logs.pump(stderr, LogSource::Agent).await });
    }
    let mut stdin = child
        .stdin
        .take()
        .ok_or_else(|| anyhow!("tar has no stdin"))?;
    let mut hasher = Sha256::new();
    let mut bytes = 0u64;
    let feed = async {
        while let Some(chunk) = stream.next().await {
            let chunk = chunk?;
            hasher.update(&chunk);
            bytes += chunk.len() as u64;
            stdin.write_all(&chunk).await?;
        }
        stdin.flush().await?;
        drop(stdin);
        anyhow::Ok(())
    };
    tokio::select! {
        result = feed => result?,
        _ = shutdown.cancelled() => {
            crate::server::kill_group(pid);
            return Err(Cancelled.into());
        }
        _ = tokio::time::sleep(RESTORE_TIMEOUT) => {
            crate::server::kill_group(pid);
            bail!("restore timed out after {}s", RESTORE_TIMEOUT.as_secs());
        }
    }
    let status = tokio::time::timeout(RESTORE_TIMEOUT, child.wait()).await??;
    if !status.success() {
        bail!("tar exited with {status}");
    }
    let digest = hex::encode(hasher.finalize());
    verify_sha256(spec.sha256.as_deref(), &digest)?;
    tracing::info!(bytes, sha256 = %digest, "restore tarball extracted");
    Ok(())
}

/// `manifest.restore.sha256` against the digest of the bytes that were streamed into `tar`:
/// a mismatch fails the restore (exit 4) so a truncated or swapped archive never becomes the
/// workspace. `None` (the control plane did not know the digest) accepts any archive.
pub fn verify_sha256(expected: Option<&str>, digest: &str) -> anyhow::Result<()> {
    if let Some(expected) = expected
        .map(str::trim)
        .filter(|expected| !expected.is_empty())
        && !expected.eq_ignore_ascii_case(digest)
    {
        bail!("restore tarball sha256 mismatch (expected {expected}, got {digest})");
    }
    Ok(())
}

/// Moves the extracted tree into place: the archive is rooted at `/` and carries `workspaces/…`
/// plus `vercel/…` (the sandbox `$HOME`, mapped onto this boot's `HOME`). GNU tar confines the
/// extraction to `restore_dir`, but it materialises symlink members with absolute or `..`
/// targets at the end of the archive, so every directory this function descends through is
/// checked to be a real directory first: an archive whose `workspaces` entry is a symlink to
/// `..` would otherwise make the move step relocate `<state>/run`, `markers` and `jwt`.
fn apply_restore_layout(restore_dir: &Path, config: &Config) -> anyhow::Result<()> {
    let workspaces = restore_dir.join("workspaces");
    let vercel = restore_dir.join("vercel");
    for path in [
        workspaces.clone(),
        vercel.clone(),
        vercel.join(".local"),
        vercel.join(".local/share"),
        vercel.join(".local/share/zed"),
        vercel.join(".config"),
        vercel.join(".config/zed"),
    ] {
        refuse_symlink(&path)?;
    }
    if workspaces.is_dir() {
        std::fs::create_dir_all(&config.workspaces_dir)?;
        for entry in std::fs::read_dir(&workspaces)? {
            let entry = entry?;
            if entry.file_type()?.is_symlink() {
                tracing::warn!(
                    name = %entry.file_name().to_string_lossy(),
                    "restore archive: skipping a symlinked workspace root"
                );
                continue;
            }
            move_path(
                &entry.path(),
                &config.workspaces_dir.join(entry.file_name()),
            )?;
        }
    }
    let data = vercel.join(".local/share/zed");
    if data.exists() {
        move_path(&data, &config.data_dir)?;
    }
    let settings = vercel.join(".config/zed");
    if settings.exists() {
        move_path(&settings, &config.home.join(".config").join("zed"))?;
    }
    Ok(())
}

/// Fails the restore when `path` exists and is a symlink (never followed).
fn refuse_symlink(path: &Path) -> anyhow::Result<()> {
    if let Ok(metadata) = std::fs::symlink_metadata(path)
        && metadata.file_type().is_symlink()
    {
        bail!(
            "restore archive: {} is a symlink; refusing to follow it",
            path.display()
        );
    }
    Ok(())
}

/// `rename` where possible, falling back to a recursive copy across mount points. An existing
/// destination is replaced; a symlink there is unlinked, never followed.
fn move_path(from: &Path, to: &Path) -> std::io::Result<()> {
    if let Ok(metadata) = std::fs::symlink_metadata(to) {
        if metadata.is_dir() {
            std::fs::remove_dir_all(to)?;
        } else {
            std::fs::remove_file(to)?;
        }
    }
    if let Some(parent) = to.parent() {
        std::fs::create_dir_all(parent)?;
    }
    match std::fs::rename(from, to) {
        Ok(()) => Ok(()),
        Err(_) => {
            copy_tree(from, to)?;
            if from.is_dir() {
                std::fs::remove_dir_all(from)
            } else {
                std::fs::remove_file(from)
            }
        }
    }
}

/// Recursive copy preserving symlinks (the cross-device fallback of [`move_path`]).
fn copy_tree(from: &Path, to: &Path) -> std::io::Result<()> {
    let metadata = std::fs::symlink_metadata(from)?;
    if metadata.file_type().is_symlink() {
        let target = std::fs::read_link(from)?;
        return std::os::unix::fs::symlink(target, to);
    }
    if metadata.is_dir() {
        std::fs::create_dir_all(to)?;
        for entry in std::fs::read_dir(from)? {
            let entry = entry?;
            copy_tree(&entry.path(), &to.join(entry.file_name()))?;
        }
        return Ok(());
    }
    std::fs::copy(from, to).map(|_| ())
}

/// Clone to `$HOME/dotfiles` if absent; run `install_command` if set, else the first existing
/// [`DOTFILES_INSTALLERS`] entry (`bash -lc`, cwd = dotfiles dir); if none, symlink every
/// top-level dotfile into `$HOME` without overwriting. Failures are non-fatal to the boot; the
/// caller records them in `lastError`.
pub async fn install_dotfiles(
    spec: &DotfilesSpec,
    config: &Config,
    logs: &LogShipper,
    shutdown: &CancellationToken,
) -> anyhow::Result<()> {
    let dir = config.home.join("dotfiles");
    let env = config.child_env(&BTreeMap::new(), &BTreeMap::new());
    if !dir.join(".git").is_dir() {
        let _ = remove_tree(&dir).await;
        let argv = vec![
            "git".to_string(),
            "clone".to_string(),
            "--depth=1".to_string(),
            "--".to_string(),
            spec.repo_url.clone(),
            dir.to_string_lossy().into_owned(),
        ];
        run_command(
            &argv,
            &config.home,
            &env,
            DOTFILES_TIMEOUT,
            LogSource::Dotfiles,
            logs,
            shutdown,
        )
        .await?;
    }
    let installer = spec
        .install_command
        .clone()
        .or_else(|| pick_dotfiles_installer(&dir).map(|script| format!("./{script}")));
    let result = match installer {
        Some(command) => {
            let argv = vec!["bash".to_string(), "-lc".to_string(), command];
            run_command(
                &argv,
                &dir,
                &env,
                DOTFILES_TIMEOUT,
                LogSource::Dotfiles,
                logs,
                shutdown,
            )
            .await
        }
        None => {
            let linked = link_dotfiles(&dir, &config.home)?;
            tracing::info!(linked, "dotfiles linked (no installer script)");
            Ok(())
        }
    };
    warn_about_storing_credential_helpers(&config.home, &env).await;
    result
}

/// Credential helpers that persist what git hands them (`credential.helper = store` writes
/// `~/.git-credentials`; the keychain/secret-service ones persist too). `cache` keeps tokens in
/// memory only and is fine.
pub const STORING_CREDENTIAL_HELPERS: [&str; 5] =
    ["store", "osxkeychain", "libsecret", "manager", "wincred"];

/// The platform helper never writes a token to disk, but git calls *every* configured helper's
/// `store`, so a user-level storing helper from the dotfiles would persist the one-hour `ghs_`
/// token inside the snapshotted `$HOME` (BUILD-SPEC §10.4). The user's choice is not overridden;
/// it is logged so the limitation is visible in the workspace logs.
pub async fn warn_about_storing_credential_helpers(home: &Path, env: &BTreeMap<String, String>) {
    let output = tokio::process::Command::new("git")
        .args(["config", "--global", "--get-all", "credential.helper"])
        .current_dir(home)
        .env_clear()
        .envs(env)
        .stdin(std::process::Stdio::null())
        .output()
        .await;
    let Ok(output) = output else {
        return;
    };
    let helpers = String::from_utf8_lossy(&output.stdout);
    for helper in storing_helpers(&helpers) {
        tracing::warn!(
            helper,
            "the dotfiles configure a credential helper that persists tokens; GitHub tokens \
             minted by the platform will be written to $HOME by it"
        );
    }
}

/// The storing helpers among `git config --get-all credential.helper` output lines.
pub fn storing_helpers(config_output: &str) -> Vec<String> {
    config_output
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .filter(|line| {
            let name = line.split_whitespace().next().unwrap_or_default();
            let name = name.rsplit('/').next().unwrap_or(name);
            let name = name.strip_prefix("git-credential-").unwrap_or(name);
            STORING_CREDENTIAL_HELPERS.contains(&name)
        })
        .map(str::to_string)
        .collect()
}

/// The first [`DOTFILES_INSTALLERS`] entry that exists in the checkout.
pub fn pick_dotfiles_installer(dir: &Path) -> Option<&'static str> {
    DOTFILES_INSTALLERS
        .into_iter()
        .find(|script| dir.join(script).is_file())
}

/// Symlinks every top-level dotfile (except `.git`) into `home`, never overwriting an existing
/// entry. Returns how many links were made.
pub fn link_dotfiles(dir: &Path, home: &Path) -> std::io::Result<usize> {
    let mut linked = 0;
    for entry in std::fs::read_dir(dir)? {
        let entry = entry?;
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if !name.starts_with('.') || name == ".git" || name == "." || name == ".." {
            continue;
        }
        let target = home.join(name.as_ref());
        if std::fs::symlink_metadata(&target).is_ok() {
            continue;
        }
        std::os::unix::fs::symlink(entry.path(), &target)?;
        linked += 1;
    }
    Ok(linked)
}

/// Version segment of the manifest-sourced post-create marker (`<MARKER_V>:<contentHash>`, b10
/// §3.1 / §3.16): bumping it re-runs `postCreateCommand` everywhere on purpose; a schema change
/// that moves `contentHash` alone does not.
pub const MARKER_V: u32 = 1;

/// The devcontainer config this boot runs with (b10 §3.16; D38): the manifest block when it is
/// authoritative (`source: manifest`, no file read), else the checkout's file through
/// [`DevcontainerConfig::load`]. Returns the config and the post-create marker value.
pub fn effective_devcontainer(
    manifest: &Manifest,
    repo_root: &Path,
) -> anyhow::Result<Option<(DevcontainerConfig, String)>> {
    if let Some(spec) = &manifest.devcontainer
        && spec.source == DevcontainerSource::Manifest
    {
        return Ok(Some((
            DevcontainerConfig::from_spec(spec),
            format!("{MARKER_V}:{}", spec.config_hash),
        )));
    }
    match DevcontainerConfig::load(repo_root)? {
        Some((config, bytes)) => {
            if let Some(spec) = &manifest.devcontainer
                && !spec.config_hash.is_empty()
                && spec.config_hash != sha256_hex(&bytes)
            {
                tracing::debug!(
                    manifest = %spec.config_hash,
                    "manifest devcontainer hash differs from the checkout's raw bytes (expected for a normalised hash)"
                );
            }
            Ok(Some((config, post_create_marker(Some(&bytes)))))
        }
        None => Ok(None),
    }
}

/// Deep merge of `over` onto `base` (objects recurse; everything else, arrays included, is
/// replaced by `over`).
fn deep_merge(base: serde_json::Value, over: serde_json::Value) -> serde_json::Value {
    match (base, over) {
        (serde_json::Value::Object(mut base), serde_json::Value::Object(over)) => {
            for (key, value) in over {
                let merged = match base.remove(&key) {
                    Some(existing) => deep_merge(existing, value),
                    None => value,
                };
                base.insert(key, merged);
            }
            serde_json::Value::Object(base)
        }
        (_, over) => over,
    }
}

/// The user's JSONC settings deep-merged OVER `overlay` (user wins on conflict, arrays replaced
/// not concatenated), rendered as JSON. Unparsable user text is returned verbatim so a typo in the
/// user's settings never loses the document; the overlay is then skipped.
pub fn merge_settings_overlay(user_text: &str, overlay: &serde_json::Value) -> String {
    let user: serde_json::Value = if user_text.trim().is_empty() {
        serde_json::Value::Object(Default::default())
    } else {
        match serde_json_lenient::from_str(user_text) {
            Ok(value) => value,
            Err(error) => {
                tracing::warn!(error = %error, "user settings are not JSONC; skipping the devcontainer overlay");
                return user_text.to_string();
            }
        }
    };
    let merged = deep_merge(overlay.clone(), user);
    serde_json::to_string_pretty(&merged).unwrap_or_else(|_| user_text.to_string())
}

/// Writes `settings` and `keymap` to `~/.config/zed/{settings.json,keymap.json}` (atomic rename)
/// whenever the sha256 differs from `markers.settings_written(kind)` or the file is missing. Runs
/// after [`restore_tarball`], so the control plane's copy wins over an archived one. Without an
/// `overlay` the settings text is written **verbatim** (JSONC, D18); with one (the manifest's
/// allowlisted `customizations.zed.settings`, b10 §3.16) the user's text is merged over it and the
/// sandbox file loses its comments — the control plane's copy, the one the user edits, is untouched.
pub fn write_settings(
    docs: &SettingsDocs,
    overlay: Option<&serde_json::Value>,
    home: &Path,
    markers: &Markers,
) -> std::io::Result<()> {
    let dir = home.join(".config").join("zed");
    std::fs::create_dir_all(&dir)?;
    let settings_text = match overlay {
        Some(overlay) => merge_settings_overlay(&docs.settings, overlay),
        None => docs.settings.clone(),
    };
    for (kind, file, text) in [
        ("settings", "settings.json", &settings_text),
        ("keymap", "keymap.json", &docs.keymap),
    ] {
        let digest = sha256_hex(text.as_bytes());
        let path = dir.join(file);
        if path.is_file() && markers.settings_written(kind).as_deref() == Some(digest.as_str()) {
            continue;
        }
        let tmp = dir.join(format!("{file}.tmp"));
        std::fs::write(&tmp, text.as_bytes())?;
        std::fs::rename(&tmp, &path)?;
        markers.set_settings_written(kind, &digest)?;
        tracing::info!(path = %path.display(), "wrote workspace {kind}");
    }
    Ok(())
}

/// Lower-case hex sha256 of `bytes`.
pub fn sha256_hex(bytes: &[u8]) -> String {
    use sha2::{Digest as _, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    hex::encode(hasher.finalize())
}

/// Marker contents for the post-create step: `sha256:<hex>` of the devcontainer file, or `"none"`
/// when the repository has none (so adding one later re-runs `postCreateCommand`).
pub fn post_create_marker(devcontainer_bytes: Option<&[u8]>) -> String {
    match devcontainer_bytes {
        Some(bytes) => format!("sha256:{}", sha256_hex(bytes)),
        None => "none".to_string(),
    }
}

/// Writes each `manifest.jwt.publicKeys[i]` to `<jwt_dir>/key-<i>.pem` (0600), removes stale
/// `key-*.pem` files, returns the paths in order (active key first).
pub fn write_jwt_keys(pems: &[String], jwt_dir: &Path) -> std::io::Result<Vec<PathBuf>> {
    ensure_private_dir(jwt_dir)?;
    for entry in std::fs::read_dir(jwt_dir)? {
        let entry = entry?;
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if name.starts_with("key-") && name.ends_with(".pem") {
            std::fs::remove_file(entry.path())?;
        }
    }
    let mut paths = Vec::with_capacity(pems.len());
    for (index, pem) in pems.iter().enumerate() {
        paths.push(write_pem_file(
            &jwt_dir.join(format!("key-{index}.pem")),
            pem,
        )?);
    }
    Ok(paths)
}

/// Writes one PEM block to `path` (0600, newline-terminated) and returns the path; used for the
/// manifest keys and for the prebuild warm-up key (`key-warm.pem`, §3.16a).
pub fn write_pem_file(path: &Path, pem: &str) -> std::io::Result<PathBuf> {
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .open(path)?;
    file.write_all(pem.as_bytes())?;
    if !pem.ends_with('\n') {
        file.write_all(b"\n")?;
    }
    Ok(path.to_path_buf())
}

static EXTENSION_ID: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^[a-z0-9][a-z0-9_-]{0,63}$").expect("static pattern"));

/// `manifest.extensions ∪ devcontainer.customizations.zed.extensions`, deduplicated, ids
/// validated (`^[a-z0-9][a-z0-9_-]{0,63}$`); posted with `ServerControl::post_extensions` once the
/// server is healthy (D5). A checkout's extensions are **not** installed (D39: repo-declared
/// extensions need a per-repo opt-in, which the control plane applies before it puts them in the
/// manifest block); only a manifest-sourced config contributes.
pub fn extension_install_list(
    manifest: &Manifest,
    devcontainer: Option<&DevcontainerConfig>,
) -> Vec<String> {
    let from_devcontainer = devcontainer
        .filter(|config| config.source == DevcontainerSource::Manifest)
        .and_then(|config| config.zed())
        .map(|zed| zed.extensions.iter())
        .into_iter()
        .flatten();
    let mut seen = BTreeSet::new();
    let mut out = Vec::new();
    for id in manifest.extensions.iter().chain(from_devcontainer) {
        if !EXTENSION_ID.is_match(id) {
            tracing::warn!(id, "ignoring invalid extension id");
            continue;
        }
        if seen.insert(id.clone()) {
            out.push(id.clone());
        }
    }
    out
}

/// The post-create stages in order (D37): `onCreateCommand` → `updateContentCommand` →
/// `postCreateCommand`, each as its specs; empty commands yield no stage.
pub fn post_create_stages(config: &DevcontainerConfig) -> Vec<(&'static str, Vec<CommandSpec>)> {
    let mut out = Vec::new();
    for (label, command) in [
        ("on_create", &config.on_create_command),
        ("update_content", &config.update_content_command),
        ("post_create", &config.post_create_command),
    ] {
        if let Some(command) = command {
            let specs = lifecycle_specs(command, label);
            if !specs.is_empty() {
                out.push((label, specs));
            }
        }
    }
    out
}

/// Runs `stages` one after another inside one shared `budget` (b10 §3.16: the three post-create
/// stages share the 30-minute window); the first failing stage ends the sequence.
#[allow(clippy::too_many_arguments)]
pub async fn run_lifecycle_sequence(
    stages: Vec<(&'static str, Vec<CommandSpec>)>,
    cwd: &Path,
    env: &BTreeMap<String, String>,
    budget: Duration,
    source: LogSource,
    logs: &LogShipper,
    state: &Arc<AgentState>,
    shutdown: &CancellationToken,
) -> anyhow::Result<()> {
    let started = std::time::Instant::now();
    for (label, specs) in stages {
        let remaining = budget.saturating_sub(started.elapsed());
        if remaining.is_zero() {
            bail!("{label}: the post-create budget is exhausted");
        }
        run_lifecycle(specs, cwd, env, remaining, source, logs, state, shutdown)
            .await
            .map_err(|error| anyhow!("{label}: {error}"))?;
    }
    Ok(())
}

/// A service process group started by [`start_services`] (`dockerd`), killed on stop.
pub struct ChildGroup {
    /// Log label.
    pub name: &'static str,
    /// Process-group leader pid.
    pub pid: u32,
    child: tokio::process::Child,
}

impl ChildGroup {
    /// `SIGKILL` to the whole group (the lifecycle task's stop path), then the leader is
    /// reaped (bounded by [`SERVICE_REAP_TIMEOUT`]) so a stopped `dockerd` never lingers as a
    /// zombie of the supervisor.
    pub async fn kill(mut self) {
        crate::server::kill_group(self.pid);
        let _ = self.child.start_kill();
        if tokio::time::timeout(SERVICE_REAP_TIMEOUT, self.child.wait())
            .await
            .is_err()
        {
            tracing::warn!(
                service = self.name,
                pid = self.pid,
                "service did not exit after SIGKILL"
            );
        }
    }

    /// Whether the group leader has already exited (a service that died mid-session).
    // ZS-TODO(b10): nothing polls this yet — a `dockerd` that dies mid-session is only noticed
    // by the next `docker` call; the supervisor's lifecycle task should poll it and surface the
    // death through `AgentState::set_error` (b10 §3.16 leaves the service non-fatal either way).
    pub fn exited(&mut self) -> Option<std::process::ExitStatus> {
        self.child.try_wait().ok().flatten()
    }
}

/// How long a service gets to answer its readiness probe.
pub const SERVICE_READY_TIMEOUT: Duration = Duration::from_secs(30);
/// How long the stop path waits for a killed service's leader to be reaped.
pub const SERVICE_REAP_TIMEOUT: Duration = Duration::from_secs(5);

/// Starts the manifest's services beside the server (b10 §3.16, D40): `Service::Dockerd` is
/// `sudo -n dockerd` in its own process group, its output shipped under `services`, waited on
/// with `docker info` for ≤ [`SERVICE_READY_TIMEOUT`]. A failure is non-fatal (`lastError`).
pub async fn start_services(
    services: &[Service],
    logs: &LogShipper,
    state: &Arc<AgentState>,
    shutdown: &CancellationToken,
) -> Vec<ChildGroup> {
    let mut out = Vec::new();
    for service in services {
        match service {
            Service::Dockerd => match start_dockerd(logs, shutdown).await {
                Ok(group) => {
                    tracing::info!(pid = group.pid, "dockerd up");
                    out.push(group);
                }
                Err(error) => {
                    tracing::warn!(error = %error, "dockerd failed to start");
                    state.set_error(format!("dockerd: {error}"));
                }
            },
        }
    }
    out
}

async fn start_dockerd(
    logs: &LogShipper,
    shutdown: &CancellationToken,
) -> anyhow::Result<ChildGroup> {
    let mut child = tokio::process::Command::new("sudo")
        .args(["-n", "dockerd"])
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .process_group(0)
        .kill_on_drop(false)
        .spawn()
        .map_err(|error| anyhow!("sudo dockerd: {error}"))?;
    let pid = child.id().unwrap_or_default();
    if let Some(stdout) = child.stdout.take() {
        let logs = logs.clone();
        tokio::spawn(async move { logs.pump(stdout, LogSource::Services).await });
    }
    if let Some(stderr) = child.stderr.take() {
        let logs = logs.clone();
        tokio::spawn(async move { logs.pump(stderr, LogSource::Services).await });
    }
    let deadline = std::time::Instant::now() + SERVICE_READY_TIMEOUT;
    loop {
        if shutdown.is_cancelled() {
            crate::server::kill_group(pid);
            bail!("cancelled");
        }
        let ready = tokio::process::Command::new("docker")
            .arg("info")
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .await
            .map(|status| status.success())
            .unwrap_or(false);
        if ready {
            return Ok(ChildGroup {
                name: "dockerd",
                pid,
                child,
            });
        }
        if let Ok(Some(status)) = child.try_wait() {
            bail!("dockerd exited with {status}");
        }
        if std::time::Instant::now() >= deadline {
            crate::server::kill_group(pid);
            let _ = child.wait().await;
            bail!(
                "dockerd did not answer `docker info` within {}s",
                SERVICE_READY_TIMEOUT.as_secs()
            );
        }
        tokio::time::sleep(Duration::from_secs(1)).await;
    }
}

/// One lifecycle command to run.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CommandSpec {
    /// argv.
    pub argv: Vec<String>,
    /// Came from the string form (`bash -lc`).
    pub shell: bool,
    /// Log label (`post_create`, `post_create:web`, …).
    pub label: String,
}

/// string → `["bash","-lc",s]` shell=true; array → argv; object → one spec per entry (run in
/// parallel by [`run_lifecycle`]). Empty commands are skipped.
pub fn lifecycle_specs(command: &LifecycleCommand, label: &str) -> Vec<CommandSpec> {
    fn shell_spec(script: &str, label: String) -> Option<CommandSpec> {
        (!script.trim().is_empty()).then(|| CommandSpec {
            argv: vec!["bash".to_string(), "-lc".to_string(), script.to_string()],
            shell: true,
            label,
        })
    }
    fn argv_spec(argv: &[String], label: String) -> Option<CommandSpec> {
        (!argv.is_empty()).then(|| CommandSpec {
            argv: argv.to_vec(),
            shell: false,
            label,
        })
    }
    match command {
        LifecycleCommand::Shell(script) => {
            shell_spec(script, label.to_string()).into_iter().collect()
        }
        LifecycleCommand::Argv(argv) => argv_spec(argv, label.to_string()).into_iter().collect(),
        LifecycleCommand::Parallel(entries) => entries
            .iter()
            .filter_map(|(name, leaf)| {
                let label = format!("{label}:{name}");
                match leaf {
                    LifecycleCommandLeaf::Shell(script) => shell_spec(script, label),
                    LifecycleCommandLeaf::Argv(argv) => argv_spec(argv, label),
                }
            })
            .collect(),
    }
}

/// Runs specs (parallel for the object form) in their own process group, cwd = workspace dir,
/// env = `Config::child_env`; stdout/stderr lines → `logs` with `source`; holds a `busy` guard
/// for the duration (D13; nests with an overlapping postAttach); non-zero exit → `Err` with the
/// exit code; timeout or `shutdown` → `killpg(SIGKILL)` and `Err`.
#[allow(clippy::too_many_arguments)]
pub async fn run_lifecycle(
    specs: Vec<CommandSpec>,
    cwd: &Path,
    env: &BTreeMap<String, String>,
    timeout: Duration,
    source: LogSource,
    logs: &LogShipper,
    state: &Arc<AgentState>,
    shutdown: &CancellationToken,
) -> anyhow::Result<()> {
    if specs.is_empty() {
        return Ok(());
    }
    let _busy = state.busy_guard();
    let results = futures_util::future::join_all(specs.iter().map(|spec| async move {
        tracing::info!(label = %spec.label, argv = ?spec.argv, "lifecycle command");
        let outcome = run_command(&spec.argv, cwd, env, timeout, source, logs, shutdown).await;
        (spec.label.clone(), outcome)
    }))
    .await;
    let mut failure = None;
    for (label, outcome) in results {
        match outcome {
            Ok(()) => tracing::info!(label = %label, "lifecycle command finished"),
            Err(error) => {
                tracing::error!(label = %label, error = %error, "lifecycle command failed");
                if failure.is_none() {
                    failure = Some(anyhow!("{label}: {error}"));
                }
            }
        }
    }
    match failure {
        Some(error) => Err(error),
        None => Ok(()),
    }
}

/// Spawns one child in its own process group, pumps both streams into `logs` and waits for it.
/// A timeout or a fired `shutdown` `SIGKILL`s the whole group; a non-zero exit is an error.
pub async fn run_command(
    argv: &[String],
    cwd: &Path,
    env: &BTreeMap<String, String>,
    timeout: Duration,
    source: LogSource,
    logs: &LogShipper,
    shutdown: &CancellationToken,
) -> anyhow::Result<()> {
    let (program, args) = argv.split_first().ok_or_else(|| anyhow!("empty command"))?;
    let mut child = tokio::process::Command::new(program)
        .args(args)
        .current_dir(cwd)
        .env_clear()
        .envs(env)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .process_group(0)
        .kill_on_drop(false)
        .spawn()
        .map_err(|error| anyhow!("{program}: {error}"))?;
    let pid = child.id().unwrap_or_default();
    let mut pumps = Vec::with_capacity(2);
    if let Some(stdout) = child.stdout.take() {
        let logs = logs.clone();
        pumps.push(tokio::spawn(async move { logs.pump(stdout, source).await }));
    }
    if let Some(stderr) = child.stderr.take() {
        let logs = logs.clone();
        pumps.push(tokio::spawn(async move { logs.pump(stderr, source).await }));
    }
    let status = tokio::select! {
        status = child.wait() => status?,
        _ = shutdown.cancelled() => {
            crate::server::kill_group(pid);
            let _ = child.wait().await;
            return Err(Cancelled.into());
        }
        _ = tokio::time::sleep(timeout) => {
            crate::server::kill_group(pid);
            let _ = child.wait().await;
            bail!("{program} timed out after {}s", timeout.as_secs());
        }
    };
    for pump in pumps {
        let _ = tokio::time::timeout(Duration::from_secs(2), pump).await;
    }
    if !status.success() {
        bail!(
            "{program} exited with {}",
            status
                .code()
                .map(|code| code.to_string())
                .unwrap_or_else(|| "a signal".to_string())
        );
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn markers_roundtrip() {
        let dir = tempfile::tempdir().unwrap();
        let markers = Markers::new(dir.path().join("markers"));
        assert!(!markers.clone_done());
        assert!(!markers.first_boot_done());
        assert!(markers.needs_post_create("sha256:a"));
        markers.set_clone_done().unwrap();
        markers.set_post_create_done("sha256:a").unwrap();
        markers.set_first_boot_done().unwrap();
        markers
            .set_settings_written("settings", "deadbeef")
            .unwrap();
        assert!(markers.clone_done());
        assert!(markers.first_boot_done());
        assert!(!markers.needs_post_create("sha256:a"));
        assert!(markers.needs_post_create("sha256:b"));
        assert_eq!(
            markers.settings_written("settings").as_deref(),
            Some("deadbeef")
        );
        assert_eq!(markers.settings_written("keymap"), None);
    }

    #[test]
    fn jwt_keys_are_written_in_order() {
        use std::os::unix::fs::PermissionsExt as _;
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("key-9.pem"), "stale").unwrap();
        std::fs::write(dir.path().join("key-warm.pem"), "stale warm key").unwrap();
        let paths = write_jwt_keys(
            &["A".to_string(), "B\n".to_string(), "C".to_string()],
            dir.path(),
        )
        .unwrap();
        assert_eq!(paths.len(), 3);
        assert_eq!(std::fs::read_to_string(&paths[0]).unwrap(), "A\n");
        assert_eq!(std::fs::read_to_string(&paths[1]).unwrap(), "B\n");
        assert!(!dir.path().join("key-9.pem").exists());
        assert!(
            !dir.path().join("key-warm.pem").exists(),
            "a leftover warm key is swept"
        );
        for path in &paths {
            let mode = std::fs::metadata(path).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode, 0o600, "{}", path.display());
        }
        // Three keys then two: only key-0 and key-1 remain, active key first.
        let paths = write_jwt_keys(&["D".to_string(), "E".to_string()], dir.path()).unwrap();
        assert_eq!(
            paths,
            vec![dir.path().join("key-0.pem"), dir.path().join("key-1.pem")]
        );
        assert!(!dir.path().join("key-2.pem").exists());
        assert_eq!(std::fs::read_to_string(&paths[0]).unwrap(), "D\n");
        // The warm key is a sibling file that the manifest key rewrite does not renumber.
        let warm = write_pem_file(&dir.path().join("key-warm.pem"), "W").unwrap();
        assert_eq!(std::fs::read_to_string(&warm).unwrap(), "W\n");
        assert_eq!(
            std::fs::metadata(&warm).unwrap().permissions().mode() & 0o777,
            0o600
        );
    }

    #[test]
    fn restore_digest_check() {
        let digest = "ab".repeat(32);
        assert!(verify_sha256(None, &digest).is_ok());
        assert!(verify_sha256(Some(""), &digest).is_ok());
        assert!(verify_sha256(Some(&digest), &digest).is_ok());
        assert!(verify_sha256(Some(&digest.to_uppercase()), &digest).is_ok());
        let error = verify_sha256(Some(&"cd".repeat(32)), &digest).unwrap_err();
        assert!(error.to_string().contains("sha256 mismatch"), "{error}");
    }

    #[test]
    fn lifecycle_forms() {
        let shell = lifecycle_specs(&LifecycleCommand::Shell("npm ci".into()), "post_create");
        assert_eq!(shell[0].argv, vec!["bash", "-lc", "npm ci"]);
        assert!(shell[0].shell);
        let argv = lifecycle_specs(
            &LifecycleCommand::Argv(vec!["make".into(), "x".into()]),
            "post_start",
        );
        assert_eq!(argv[0].argv, vec!["make", "x"]);
        assert!(!argv[0].shell);
        let parallel = lifecycle_specs(
            &LifecycleCommand::Parallel(BTreeMap::from([
                (
                    "a".to_string(),
                    LifecycleCommandLeaf::Shell("echo a".into()),
                ),
                ("b".to_string(), LifecycleCommandLeaf::Argv(vec![])),
            ])),
            "post_create",
        );
        assert_eq!(parallel.len(), 1);
        assert_eq!(parallel[0].label, "post_create:a");
    }

    fn repo(revision: &str, git_ref: Option<&str>, depth: u32) -> RepoSpec {
        RepoSpec {
            owner: "acme".to_string(),
            name: "api".to_string(),
            clone_url: "https://github.com/acme/api.git".to_string(),
            default_branch: "main".to_string(),
            revision: revision.to_string(),
            depth,
            git_ref: git_ref.map(str::to_string),
        }
    }

    #[test]
    fn refspec_selection() {
        // D18: an explicit ref wins and is checked out detached.
        let plan = fetch_plan(&repo("main", Some("refs/pull/12/head"), 1));
        assert_eq!(plan.refspec, "refs/pull/12/head");
        assert_eq!(plan.depth, Some(1));
        assert_eq!(plan.branch, None);
        // A pinned sha is fetched by sha, because a shallow clone cannot reach a non-tip commit.
        let sha = "0123456789abcdef0123456789abcdef01234567";
        let plan = fetch_plan(&repo(sha, None, 0));
        assert_eq!(plan.refspec, sha);
        assert_eq!(plan.depth, None);
        assert_eq!(plan.branch, None);
        // A branch name is fetched by ref and checked out as that branch.
        let plan = fetch_plan(&repo("dev", None, 0));
        assert_eq!(plan.refspec, "refs/heads/dev");
        assert_eq!(plan.branch.as_deref(), Some("dev"));
    }

    #[test]
    fn branch_and_detached_switch_args() {
        assert_eq!(
            switch_args(Some("dev")),
            vec!["switch", "-C", "dev", "FETCH_HEAD"]
        );
        assert_eq!(switch_args(None), vec!["switch", "--detach", "FETCH_HEAD"]);
    }

    #[test]
    fn write_settings_is_verbatim_and_idempotent() {
        let dir = tempfile::tempdir().unwrap();
        let markers = Markers::new(dir.path().join("markers"));
        let docs = SettingsDocs {
            settings: "// user settings\n{ \"theme\": \"One Dark\" }".to_string(),
            keymap: "[]".to_string(),
        };
        write_settings(&docs, None, dir.path(), &markers).unwrap();
        let settings_path = dir.path().join(".config/zed/settings.json");
        assert_eq!(
            std::fs::read_to_string(&settings_path).unwrap(),
            docs.settings
        );
        assert_eq!(
            std::fs::read_to_string(dir.path().join(".config/zed/keymap.json")).unwrap(),
            "[]"
        );
        // The same text again is not rewritten.
        std::fs::write(&settings_path, "touched by the user").unwrap();
        write_settings(&docs, None, dir.path(), &markers).unwrap();
        assert_eq!(
            std::fs::read_to_string(&settings_path).unwrap(),
            "touched by the user"
        );
        // A changed document from the control plane wins.
        let changed = SettingsDocs {
            settings: "{}".to_string(),
            keymap: docs.keymap.clone(),
        };
        write_settings(&changed, None, dir.path(), &markers).unwrap();
        assert_eq!(std::fs::read_to_string(&settings_path).unwrap(), "{}");
        // A file the supervisor never wrote (a restored archive) is replaced.
        std::fs::remove_file(&settings_path).unwrap();
        write_settings(&changed, None, dir.path(), &markers).unwrap();
        assert!(settings_path.is_file());
    }

    #[test]
    fn dotfiles_installer_pick_and_linking() {
        let dir = tempfile::tempdir().unwrap();
        let dotfiles = dir.path().join("dotfiles");
        let home = dir.path().join("home");
        std::fs::create_dir_all(&dotfiles).unwrap();
        std::fs::create_dir_all(&home).unwrap();
        assert_eq!(pick_dotfiles_installer(&dotfiles), None);
        std::fs::write(dotfiles.join("bootstrap.sh"), "#!/bin/sh\n").unwrap();
        assert_eq!(pick_dotfiles_installer(&dotfiles), Some("bootstrap.sh"));
        std::fs::write(dotfiles.join("install.sh"), "#!/bin/sh\n").unwrap();
        assert_eq!(pick_dotfiles_installer(&dotfiles), Some("install.sh"));

        std::fs::write(dotfiles.join(".zshrc"), "z").unwrap();
        std::fs::write(dotfiles.join(".bashrc"), "b").unwrap();
        std::fs::create_dir_all(dotfiles.join(".git")).unwrap();
        std::fs::write(home.join(".bashrc"), "existing").unwrap();
        assert_eq!(link_dotfiles(&dotfiles, &home).unwrap(), 1);
        assert_eq!(std::fs::read_to_string(home.join(".zshrc")).unwrap(), "z");
        assert_eq!(
            std::fs::read_to_string(home.join(".bashrc")).unwrap(),
            "existing"
        );
        assert!(!home.join(".git").exists());
    }

    #[test]
    fn restore_layout_mapping() {
        let root = tempfile::tempdir().unwrap();
        let restore = root.path().join("restore.partial");
        std::fs::create_dir_all(restore.join("workspaces/api")).unwrap();
        std::fs::write(restore.join("workspaces/api/x"), "x").unwrap();
        std::fs::create_dir_all(restore.join("vercel/.local/share/zed")).unwrap();
        std::fs::write(restore.join("vercel/.local/share/zed/y"), "y").unwrap();
        std::fs::create_dir_all(restore.join("vercel/.config/zed")).unwrap();
        std::fs::write(restore.join("vercel/.config/zed/settings.json"), "{}").unwrap();

        let home = root.path().join("home");
        let workspaces = root.path().join("workspaces");
        let data = home.join(".local/share/zed");
        let env = BTreeMap::from([
            ("ZS_CONTROL_URL", "https://zs.example.com/api".to_string()),
            ("ZS_SANDBOX_TOKEN", "zsb_test".to_string()),
            ("ZS_SANDBOX_NAME", "sb-test".to_string()),
            ("ZS_WORKSPACE_ID", "ws_test".to_string()),
            ("HOME", home.to_string_lossy().into_owned()),
            (
                "ZS_WORKSPACES_DIR",
                workspaces.to_string_lossy().into_owned(),
            ),
            ("ZS_DATA_DIR", data.to_string_lossy().into_owned()),
        ]);
        let config = Config::from_lookup(|key| env.get(key).cloned()).unwrap();
        apply_restore_layout(&restore, &config).unwrap();
        assert_eq!(
            std::fs::read_to_string(workspaces.join("api/x")).unwrap(),
            "x"
        );
        assert_eq!(std::fs::read_to_string(data.join("y")).unwrap(), "y");
        assert_eq!(
            std::fs::read_to_string(home.join(".config/zed/settings.json")).unwrap(),
            "{}"
        );
        // An archive without the `vercel/` entries is fine.
        let bare = root.path().join("bare");
        std::fs::create_dir_all(bare.join("workspaces/api")).unwrap();
        std::fs::write(bare.join("workspaces/api/z"), "z").unwrap();
        apply_restore_layout(&bare, &config).unwrap();
        assert!(workspaces.join("api/z").is_file());
        assert!(!workspaces.join("api/x").exists(), "the entry is replaced");

        // A `workspaces` entry that is a symlink (tar materialises `workspaces -> ..` last) is
        // refused outright rather than followed into the state directory.
        let crafted = root.path().join("crafted");
        std::fs::create_dir_all(&crafted).unwrap();
        std::os::unix::fs::symlink("..", crafted.join("workspaces")).unwrap();
        let error = apply_restore_layout(&crafted, &config).unwrap_err();
        assert!(error.to_string().contains("symlink"), "{error}");
        // A symlinked entry *inside* `workspaces` is skipped, the real ones move.
        let mixed = root.path().join("mixed");
        std::fs::create_dir_all(mixed.join("workspaces/real")).unwrap();
        std::fs::write(mixed.join("workspaces/real/r"), "r").unwrap();
        std::os::unix::fs::symlink("/", mixed.join("workspaces/escape")).unwrap();
        apply_restore_layout(&mixed, &config).unwrap();
        assert!(workspaces.join("real/r").is_file());
        assert!(!workspaces.join("escape").exists());
        // A symlinked `vercel/.local/share` is refused too.
        let deep = root.path().join("deep");
        std::fs::create_dir_all(deep.join("vercel/.local")).unwrap();
        std::os::unix::fs::symlink("/etc", deep.join("vercel/.local/share")).unwrap();
        assert!(apply_restore_layout(&deep, &config).is_err());
    }

    #[test]
    fn tar_runs_with_the_stripped_child_environment() {
        let env = BTreeMap::from([
            ("ZS_CONTROL_URL", "https://zs.example.com/api".to_string()),
            ("ZS_SANDBOX_TOKEN", "zsb_test".to_string()),
            ("ZS_SANDBOX_NAME", "sb-test".to_string()),
            ("ZS_WORKSPACE_ID", "ws_test".to_string()),
            ("HOME", "/tmp".to_string()),
        ]);
        let config = Config::from_lookup(|key| env.get(key).cloned()).unwrap();
        let base: Vec<(String, String)> = [
            ("ZS_SANDBOX_TOKEN", "zsb_leak"),
            ("ZS_BYPASS_SECRET", "bypass"),
            ("ZS_CONTROL_URL", "https://zs.example.com/api"),
            ("TAR_OPTIONS", "--overwrite"),
            ("PATH", "/usr/bin:/bin"),
            ("HOME", "/tmp"),
        ]
        .into_iter()
        .map(|(k, v)| (k.to_string(), v.to_string()))
        .collect();
        let child_env = config.child_env_from(base, &BTreeMap::new(), &BTreeMap::new());
        let command = tar_command(Path::new("/tmp/restore.partial"), &child_env);
        let envs: BTreeMap<String, Option<String>> = command
            .as_std()
            .get_envs()
            .map(|(key, value)| {
                (
                    key.to_string_lossy().into_owned(),
                    value.map(|v| v.to_string_lossy().into_owned()),
                )
            })
            .collect();
        for stripped in [
            "ZS_SANDBOX_TOKEN",
            "ZS_BYPASS_SECRET",
            "ZS_CONTROL_URL",
            "TAR_OPTIONS",
        ] {
            assert!(!envs.contains_key(stripped), "{stripped} reached tar");
        }
        assert_eq!(envs["PATH"].as_deref(), Some("/usr/bin:/bin"));
        assert_eq!(
            envs["ZS_SUPERVISOR_URL"].as_deref(),
            Some("http://127.0.0.1:8450")
        );
        let argv: Vec<String> = command
            .as_std()
            .get_args()
            .map(|arg| arg.to_string_lossy().into_owned())
            .collect();
        assert_eq!(argv, vec!["-xzf", "-", "-C", "/tmp/restore.partial"]);
    }

    #[test]
    fn storing_credential_helpers_are_recognised() {
        assert_eq!(
            storing_helpers(
                "!zs-agent credential\nstore\ncache --timeout=3600\n/usr/lib/git-core/git-credential-libsecret\nosxkeychain\n"
            ),
            vec![
                "store",
                "/usr/lib/git-core/git-credential-libsecret",
                "osxkeychain"
            ]
        );
        assert!(storing_helpers("!zs-agent credential\ncache\n").is_empty());
        assert!(storing_helpers("").is_empty());
    }

    #[test]
    fn post_create_marker_tracks_the_devcontainer() {
        assert_eq!(post_create_marker(None), "none");
        let marker = post_create_marker(Some(b"{}"));
        assert!(marker.starts_with("sha256:"));
        assert_ne!(marker, post_create_marker(Some(b"{ }")));
        assert_eq!(marker, post_create_marker(Some(b"{}")));
    }

    #[test]
    fn partial_dir_is_a_sibling() {
        assert_eq!(
            partial_dir(Path::new("/workspaces/api")),
            PathBuf::from("/workspaces/api.partial")
        );
    }

    #[test]
    fn extension_ids_are_validated_and_deduplicated() {
        let manifest = Manifest::parse(include_bytes!(
            "../../../docs/contracts/fixtures/manifest.example.json"
        ))
        .unwrap();
        let mut devcontainer: DevcontainerConfig = serde_json_lenient::from_str(
            r#"{ "customizations": { "zed": { "extensions": ["toml", "html", "Bad Id"] } } }"#,
        )
        .unwrap();
        // A checkout's extensions need the per-repo opt-in (D39): only the manifest's list installs.
        let ids = extension_install_list(&manifest, Some(&devcontainer));
        assert_eq!(ids, vec!["toml", "dockerfile"]);
        devcontainer.source = DevcontainerSource::Manifest;
        let ids = extension_install_list(&manifest, Some(&devcontainer));
        assert_eq!(ids, vec!["toml", "dockerfile", "html"]);
    }

    #[test]
    fn effective_devcontainer_prefers_manifest() {
        // b10 §6.5: with `source: manifest` no file is read (the checkout carries a different
        // config) and the marker is `1:<configHash>`; with `checkout` the file is loaded.
        let manifest = Manifest::parse(include_bytes!(
            "../../../docs/contracts/fixtures/manifest.example.json"
        ))
        .unwrap();
        let repo = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(repo.path().join(".devcontainer")).unwrap();
        std::fs::write(
            repo.path().join(".devcontainer/devcontainer.json"),
            br#"{ "postCreateCommand": "echo checkout" }"#,
        )
        .unwrap();
        let (config, marker) = effective_devcontainer(&manifest, repo.path())
            .unwrap()
            .unwrap();
        assert_eq!(config.source, DevcontainerSource::Manifest);
        assert_eq!(
            marker,
            format!(
                "{MARKER_V}:{}",
                manifest.devcontainer.as_ref().unwrap().config_hash
            )
        );
        assert!(!matches!(
            config.post_create_command,
            Some(LifecycleCommand::Shell(ref script)) if script == "echo checkout"
        ));

        let mut json: serde_json::Value = serde_json::from_slice(include_bytes!(
            "../../../docs/contracts/fixtures/manifest.example.json"
        ))
        .unwrap();
        json["devcontainer"] = serde_json::json!({ "configHash": "0".repeat(64) });
        let manifest = Manifest::parse(json.to_string().as_bytes()).unwrap();
        let (config, marker) = effective_devcontainer(&manifest, repo.path())
            .unwrap()
            .unwrap();
        assert_eq!(config.source, DevcontainerSource::Checkout);
        assert!(marker.starts_with("sha256:"));
        assert!(matches!(
            config.post_create_command,
            Some(LifecycleCommand::Shell(ref script)) if script == "echo checkout"
        ));
        // No file and no authoritative block: nothing to run.
        let empty = tempfile::tempdir().unwrap();
        assert!(
            effective_devcontainer(&manifest, empty.path())
                .unwrap()
                .is_none()
        );
    }

    #[test]
    fn settings_overlay_merge() {
        // b10 §6.5: user wins on conflict, objects merge, arrays are replaced, JSONC is accepted.
        let overlay = serde_json::json!({ "theme": "x", "tab_size": 2, "lsp": { "b": 2 }, "wrap_guides": [80] });
        let merged = merge_settings_overlay(
            "// user\n{ \"theme\": \"One Dark\", \"lsp\": { \"a\": 1 }, \"wrap_guides\": [100, 120], }",
            &overlay,
        );
        let value: serde_json::Value = serde_json::from_str(&merged).unwrap();
        assert_eq!(
            value,
            serde_json::json!({ "theme": "One Dark", "tab_size": 2, "lsp": { "a": 1, "b": 2 }, "wrap_guides": [100, 120] })
        );
        // Empty user text takes the overlay alone; broken user text is kept verbatim.
        let value: serde_json::Value =
            serde_json::from_str(&merge_settings_overlay("", &overlay)).unwrap();
        assert_eq!(value["tab_size"], 2);
        assert_eq!(merge_settings_overlay("{ broken", &overlay), "{ broken");

        // The marker covers the overlay: the same user text with a different overlay is rewritten.
        let dir = tempfile::tempdir().unwrap();
        let markers = Markers::new(dir.path().join("markers"));
        let docs = SettingsDocs {
            settings: "{ \"theme\": \"One Dark\" }".to_string(),
            keymap: "[]".to_string(),
        };
        write_settings(&docs, Some(&overlay), dir.path(), &markers).unwrap();
        let path = dir.path().join(".config/zed/settings.json");
        let first: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(first["tab_size"], 2);
        let other = serde_json::json!({ "tab_size": 4 });
        write_settings(&docs, Some(&other), dir.path(), &markers).unwrap();
        let second: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(second["tab_size"], 4);
    }

    #[test]
    fn lifecycle_sequence_order() {
        // b10 §6.5: on_create → update_content → post_create, each contributing its specs.
        let config: DevcontainerConfig = serde_json_lenient::from_str(
            r#"{ "postCreateCommand": "echo c", "onCreateCommand": ["true"], "updateContentCommand": { "x": "echo u" } }"#,
        )
        .unwrap();
        let stages = post_create_stages(&config);
        let labels: Vec<&str> = stages.iter().map(|(label, _)| *label).collect();
        assert_eq!(labels, vec!["on_create", "update_content", "post_create"]);
        assert_eq!(stages[1].1[0].label, "update_content:x");
        let none: DevcontainerConfig = serde_json_lenient::from_str("{}").unwrap();
        assert!(post_create_stages(&none).is_empty());
    }
}
