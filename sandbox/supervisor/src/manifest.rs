//! Serde types for the `SandboxManifest` (brief §3.4, §4.1; b9 §4.7; schema
//! `docs/contracts/sandbox-manifest.v1.json`, fixture `docs/contracts/fixtures/manifest.example.json`
//! per D19) and the supported `devcontainer.json` subset (BUILD-SPEC §6.3).
//!
//! Unknown manifest fields are ignored for forward compatibility (b9 also emits
//! `sandboxGeneration`, `proxySlots` and `jwt.portAudience`, none of which the supervisor reads:
//! the proxy slots come from `Config::proxy_slots`, D21).

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Component, Path, PathBuf};

use anyhow::{Context as _, anyhow, bail};

use crate::config::{Config, INFRA_PORTS, SecretString};

/// The manifest version this build understands.
pub const MANIFEST_VERSION: u32 = 1;

/// `GET {api}/sandboxes/{name}/manifest` (§4.1). Field docs name the validation rule where one applies.
#[derive(Clone, Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Manifest {
    /// Must be [`MANIFEST_VERSION`].
    pub version: u32,
    /// `== ZS_WORKSPACE_ID` (the prebuild id for `pb-` principals).
    pub workspace_id: String,
    /// `== ZS_SANDBOX_NAME`.
    pub sandbox_name: String,
    /// Owner; `"system"` for prebuilds (logs only).
    pub user_id: String,
    /// `workspaces.server_build`; `!= ZS_BUILD_ID` → health `degraded`, not fatal.
    pub build: String,
    /// `workspaces.client_build`: the build string the server must accept in `Hello`
    /// (D23/D26). Absent means client and server were built from one commit, so the
    /// supervisor's own `ZS_BUILD_ID` is passed as `--client-build`.
    #[serde(default)]
    pub client_build: Option<String>,
    /// Sandbox region, e.g. `iad1`.
    pub region: String,
    /// Repository to clone.
    pub repo: RepoSpec,
    /// `/workspaces/<repo.name>`; absolute, lexically normal, under `ZS_WORKSPACES_DIR`.
    pub workspace_dir: PathBuf,
    /// Rebuild only (D9): presigned tarball to extract at `/`.
    #[serde(default)]
    pub restore: Option<RestoreSpec>,
    /// Owner's dotfiles repository.
    #[serde(default)]
    pub dotfiles: Option<DotfilesSpec>,
    /// NON-secret literals (`ZS_WORKSPACE_ID`, `ZS_REGION`, devcontainer `remoteEnv`); filtered per §3.3.
    #[serde(default)]
    pub env: BTreeMap<String, String>,
    /// Names only; the values arrived in the `runCommand` environment.
    #[serde(default)]
    pub secret_names: Vec<String>,
    /// `{ issuer, audience, publicKeys }` → `serve --issuer/--audience/--jwt-public-key`.
    pub jwt: JwtSpec,
    /// Standard base64 (padded) of 32 bytes; HMAC key of the port bootstrap token (§3.10); per
    /// generation. Optional: the control plane does not emit it today (CONTRACTS §14 M12 – b9
    /// mints ES256 port tokens instead), and a manifest without it boots with the private-port
    /// proxies off rather than failing the whole workspace.
    #[serde(default)]
    pub port_session_secret: Option<SecretString>,
    /// Current forwards; seeds `ForwardsState`.
    #[serde(default)]
    pub forwards: Vec<Forward>,
    /// Pool ports declared at create (BUILD-SPEC §5.2).
    #[serde(default)]
    pub port_pool: Vec<u16>,
    /// Idle threshold.
    pub idle: IdleSpec,
    /// Vercel sandbox session; `id` is `LogBatch.sessionId`, `resumed` is the control plane's hint.
    pub session: SessionSpec,
    /// The devcontainer block (b10 §4.4; D38): authoritative when `source` is `manifest`, else
    /// `{ configHash }` is a hint and §3.14 parses the checkout.
    #[serde(default)]
    pub devcontainer: Option<DevcontainerSpec>,
    /// `{ settings, keymap }`: JSONC text as JSON strings; written verbatim (D18).
    #[serde(default)]
    pub settings: Option<SettingsDocs>,
    /// Log batching parameters (defaults 5 s / 200 / 256 KiB).
    #[serde(default)]
    pub logs: LogsSpec,
    /// Activity ping interval (default 30 s; must be ≥ 10 s).
    #[serde(default)]
    pub activity: ActivitySpec,
    /// → `serve --allowed-origin …` (D5; b9 §7 item 7c).
    #[serde(default)]
    pub allowed_origins: Vec<String>,
    /// → `POST /control/extensions {"install": …}` after the server is up (D5; BUILD-SPEC §9).
    #[serde(default)]
    pub extensions: Vec<String>,
    /// `{ id, branch, commit }` for `pb-` principals.
    #[serde(default)]
    pub prebuild: Option<PrebuildSpec>,
}

/// `manifest.repo`.
#[derive(Clone, Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoSpec {
    /// GitHub owner.
    pub owner: String,
    /// Repository name (also the workspace directory name).
    pub name: String,
    /// HTTPS clone URL; auth comes from the credential helper.
    pub clone_url: String,
    /// Default branch.
    pub default_branch: String,
    /// Branch name, or a 40-hex sha when pinned.
    pub revision: String,
    /// `0` = full clone.
    #[serde(default)]
    pub depth: u32,
    /// `"refs/pull/N/head"` for PR workspaces (D18; b9 §7 item 7a); fetched first when set.
    #[serde(default, rename = "ref")]
    pub git_ref: Option<String>,
}

/// `manifest.restore` (rebuild only, D9).
#[derive(Clone, Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RestoreSpec {
    /// Presigned Blob GET URL, valid 1 h, minted per manifest fetch (b9 §4.7).
    pub tarball_url: String,
    /// Hex sha256 of the archive, when known.
    #[serde(default)]
    pub sha256: Option<String>,
}

/// `manifest.dotfiles`.
#[derive(Clone, Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DotfilesSpec {
    /// Clone URL of the dotfiles repository.
    pub repo_url: String,
    /// Explicit installer; otherwise `DOTFILES_INSTALLERS` are probed (§3.14).
    #[serde(default)]
    pub install_command: Option<String>,
}

/// `manifest.jwt`.
#[derive(Clone, Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JwtSpec {
    /// Expected `iss` claim.
    pub issuer: String,
    /// Expected `aud` claim (b9 owns it; may differ from the sandbox name).
    pub audience: String,
    /// SPKI `PUBLIC KEY` PEM blocks, active key first (two during rotation).
    pub public_keys: Vec<String>,
}

/// One forward as seen by the supervisor, the server (`PortsBody.forwards`) and the control plane
/// (`ForwardView`).
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Forward {
    /// Target port inside the sandbox.
    pub port: u16,
    /// Public (`*.vercel.run` host) or private (proxy slot + cookie).
    pub visibility: Visibility,
    /// Optional label from `portsAttributes` or the UI.
    #[serde(default)]
    pub label: Option<String>,
    /// Public: slot/pool URL; private: the control plane's `/open` link (D8).
    #[serde(default)]
    pub url: Option<String>,
    /// Private only: the proxy slot the control plane allocated (D8/D21); learned from the first
    /// valid bootstrap token when absent (§3.11).
    #[serde(default)]
    pub slot: Option<u16>,
}

/// Forward visibility.
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Visibility {
    /// Reachable through the sandbox's public hostname for that port.
    Public,
    /// Reachable only through a proxy slot with a valid `zs_port_session` cookie.
    Private,
}

/// `manifest.idle`.
#[derive(Clone, Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IdleSpec {
    /// Idle threshold in minutes.
    pub minutes: u32,
}

/// `manifest.session`.
#[derive(Clone, Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionSpec {
    /// Vercel sandbox session id (`LogBatch.sessionId`).
    pub id: String,
    /// Unix ms.
    pub started_at: u64,
    /// Unix ms; must exceed `started_at`.
    pub cap_at: u64,
    /// Control plane's resume hint; the first-boot marker decides (§3.16 step 1).
    #[serde(default)]
    pub resumed: bool,
}

/// `manifest.devcontainer` (b10 §4.4; D38). Every field but `configHash` has a serde default, so
/// a control plane that sends only `{ configHash }` parses as `source: checkout` and the
/// supervisor reads the checkout exactly as before.
#[derive(Clone, Debug, Default, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DevcontainerSpec {
    /// `contentHash` of the normalised config, bare hex; the post-create marker is
    /// `format!("{MARKER_V}:{config_hash}")` (`bootstrap::MARKER_V`), never the hash alone.
    pub config_hash: String,
    /// Informational.
    #[serde(default)]
    pub image_build_id: Option<String>,
    /// `manifest` (authoritative) or `checkout` (use `DevcontainerConfig::load`).
    #[serde(default)]
    pub source: DevcontainerSource,
    /// Tagged lifecycle commands.
    #[serde(default)]
    pub lifecycle: LifecycleSpec,
    /// Already key-filtered by the control plane; filtered again by `Config::child_env`.
    #[serde(default)]
    pub remote_env: BTreeMap<String, String>,
    /// Ports to forward at boot.
    #[serde(default)]
    pub forward_ports: Vec<u16>,
    /// Keys are plain ports already (the control plane dropped the rest).
    #[serde(default)]
    pub ports_attributes: BTreeMap<String, PortAttributes>,
    /// Defaults for auto-detected ports.
    #[serde(default)]
    pub other_ports_attributes: Option<PortAttributes>,
    /// `customizations.zed` (extensions already reduced to the maintainer-allowed ones, D39).
    #[serde(default)]
    pub zed: ZedCustomizations,
    /// Services to start beside the server (`dockerd`).
    #[serde(default)]
    pub services: Vec<Service>,
    /// Allowlisted Feature names present (`node`, `go`, …): the warm-up's implied probes.
    #[serde(default)]
    pub features: Vec<String>,
}

/// Where the effective devcontainer config comes from.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DevcontainerSource {
    /// Read `.devcontainer/devcontainer.json` from the checkout (b8 §3.14).
    #[default]
    Checkout,
    /// The manifest block is the config (D38).
    Manifest,
}

/// `manifest.devcontainer.lifecycle` (D37 adds `onCreate` and `updateContent`).
#[derive(Clone, Debug, Default, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LifecycleSpec {
    /// Runs first in the post-create phase.
    #[serde(default)]
    pub on_create: Option<ManifestLifecycleCommand>,
    /// Runs second in the post-create phase.
    #[serde(default)]
    pub update_content: Option<ManifestLifecycleCommand>,
    /// Runs last in the post-create phase.
    #[serde(default)]
    pub post_create: Option<ManifestLifecycleCommand>,
    /// Every boot.
    #[serde(default)]
    pub post_start: Option<ManifestLifecycleCommand>,
    /// First session attach of a boot.
    #[serde(default)]
    pub post_attach: Option<ManifestLifecycleCommand>,
}

/// The tagged form of a lifecycle command the manifest carries (`{ kind: "shell" | "argv" |
/// "parallel", … }`). The checkout's untagged [`LifecycleCommand`] lives beside it; conversion
/// goes one way, into [`LifecycleCommand`], so `run_lifecycle` keeps taking exactly one type.
#[derive(Clone, Debug, serde::Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum ManifestLifecycleCommand {
    /// `bash -lc`.
    Shell {
        /// The script.
        command: String,
    },
    /// argv.
    Argv {
        /// The argv.
        argv: Vec<String>,
    },
    /// Named commands run in parallel.
    Parallel {
        /// The named leaves.
        commands: BTreeMap<String, ManifestLifecycleLeaf>,
    },
}

/// One entry of the tagged parallel form.
#[derive(Clone, Debug, serde::Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum ManifestLifecycleLeaf {
    /// `bash -lc`.
    Shell {
        /// The script.
        command: String,
    },
    /// argv.
    Argv {
        /// The argv.
        argv: Vec<String>,
    },
}

impl From<ManifestLifecycleLeaf> for LifecycleCommandLeaf {
    fn from(leaf: ManifestLifecycleLeaf) -> Self {
        match leaf {
            ManifestLifecycleLeaf::Shell { command } => LifecycleCommandLeaf::Shell(command),
            ManifestLifecycleLeaf::Argv { argv } => LifecycleCommandLeaf::Argv(argv),
        }
    }
}

impl From<ManifestLifecycleCommand> for LifecycleCommand {
    fn from(command: ManifestLifecycleCommand) -> Self {
        match command {
            ManifestLifecycleCommand::Shell { command } => LifecycleCommand::Shell(command),
            ManifestLifecycleCommand::Argv { argv } => LifecycleCommand::Argv(argv),
            ManifestLifecycleCommand::Parallel { commands } => LifecycleCommand::Parallel(
                commands
                    .into_iter()
                    .map(|(name, leaf)| (name, leaf.into()))
                    .collect(),
            ),
        }
    }
}

/// `customizations.zed.prebuild`: steering for the warm-up (b10 §3.15).
#[derive(Clone, Debug, Default, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrebuildHints {
    /// Repo-relative probe files opened first.
    #[serde(default)]
    pub files: Vec<String>,
    /// Default for `ZS_PREBUILD_WARM_CMD` when the repo row has none.
    #[serde(default)]
    pub command: Option<String>,
}

/// A service the supervisor starts beside the server (b10 §3.16; D40 resolves b8 §7 item 24).
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Service {
    /// `sudo -n dockerd` in its own process group, waited on with `docker info`.
    Dockerd,
}

/// `manifest.settings`: JSONC documents carried as JSON strings, written verbatim (D18).
#[derive(Clone, Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsDocs {
    /// `~/.config/zed/settings.json` contents.
    pub settings: String,
    /// `~/.config/zed/keymap.json` contents.
    pub keymap: String,
}

/// `manifest.logs`.
#[derive(Clone, Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LogsSpec {
    /// Seconds between flushes (default 5).
    #[serde(default = "d_flush")]
    pub flush_interval_secs: u64,
    /// Entries per batch (default and ceiling 200).
    #[serde(default = "d_batch")]
    pub max_batch: usize,
    /// Bytes per batch (default and ceiling 262 144).
    #[serde(default = "d_batch_bytes")]
    pub max_batch_bytes: usize,
}

impl Default for LogsSpec {
    fn default() -> Self {
        Self {
            flush_interval_secs: d_flush(),
            max_batch: d_batch(),
            max_batch_bytes: d_batch_bytes(),
        }
    }
}

/// `manifest.activity`.
#[derive(Clone, Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivitySpec {
    /// Seconds between activity pings (default 30; b9 rate-limits at 10/min, so ≥ 10).
    #[serde(default = "d_interval")]
    pub interval_secs: u64,
}

impl Default for ActivitySpec {
    fn default() -> Self {
        Self {
            interval_secs: d_interval(),
        }
    }
}

/// `manifest.prebuild` for `pb-` principals.
#[derive(Clone, Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrebuildSpec {
    /// Prebuild id.
    pub id: String,
    /// Branch being prebuilt.
    pub branch: String,
    /// Commit being prebuilt (`repo.revision` equals it).
    pub commit: String,
}

fn d_flush() -> u64 {
    5
}
fn d_batch() -> usize {
    200
}
fn d_batch_bytes() -> usize {
    262_144
}
fn d_interval() -> u64 {
    30
}

impl Manifest {
    /// `serde_json` plus the environment-independent validation rules; `validate` adds the
    /// cross-checks that need a [`Config`] (identity, `workspacesDir`, the proxy-slot set – a
    /// `ZS_PROXY_SLOTS` override must not be second-guessed here against the compiled default).
    pub fn parse(bytes: &[u8]) -> anyhow::Result<Self> {
        let manifest: Self = serde_json::from_slice(bytes).context("manifest: invalid JSON")?;
        manifest.check_shape(None)?;
        Ok(manifest)
    }

    /// Every rule from §4.1: version; identity equals the environment; `workspace_dir` under
    /// `workspaces_dir`; keys and secrets well-formed; ports outside the infra set; slots valid
    /// (against `config.proxy_slots`, D21), unique and private-only; session ordering; tarball
    /// scheme; origins; interval and batch ceilings.
    pub fn validate(&self, config: &Config) -> anyhow::Result<()> {
        self.check_shape(Some(&config.proxy_slots))?;
        if self.workspace_id != config.workspace_id {
            bail!(
                "manifest: workspaceId {:?} != ZS_WORKSPACE_ID {:?}",
                self.workspace_id,
                config.workspace_id
            );
        }
        if self.sandbox_name != config.sandbox_name {
            bail!(
                "manifest: sandboxName {:?} != ZS_SANDBOX_NAME {:?}",
                self.sandbox_name,
                config.sandbox_name
            );
        }
        if !self.workspace_dir.starts_with(&config.workspaces_dir)
            || self.workspace_dir == config.workspaces_dir
        {
            bail!(
                "manifest: workspaceDir {} is not inside {}",
                self.workspace_dir.display(),
                config.workspaces_dir.display()
            );
        }
        if let Some(restore) = &self.restore {
            crate::control_plane::check_tarball_url(&restore.tarball_url, config.insecure_cookies)
                .map_err(|error| anyhow!("manifest: {error}"))?;
        }
        // Clone URLs are `https://github.com/…` from the control plane; `file://` and `http://`
        // exist for the local test harnesses only (`ZS_INSECURE_COOKIES=1` / `ZS_LOCAL=1`).
        let allow_local = config.insecure_cookies || config.local;
        check_git_url_scheme(&self.repo.clone_url, "repo.cloneUrl", allow_local)?;
        if let Some(dotfiles) = &self.dotfiles {
            check_git_url_scheme(&dotfiles.repo_url, "dotfiles.repoUrl", allow_local)?;
        }
        Ok(())
    }

    /// `ZS_LOCAL=1` (a developer machine): the control plane always emits
    /// `workspaceDir = /workspaces/<name>`, which is relocated under `workspaces_dir`
    /// (`ZS_WORKSPACES_DIR`) so [`Manifest::validate`], the clone, the server's
    /// `--workspace-root` and every lifecycle command use the local checkout. A directory
    /// already under `workspaces_dir`, or one outside `/workspaces`, is left alone.
    pub fn relocate_workspace_dir(&mut self, workspaces_dir: &Path) {
        if self.workspace_dir.starts_with(workspaces_dir) {
            return;
        }
        if let Ok(rest) = self
            .workspace_dir
            .strip_prefix(crate::config::DEFAULT_WORKSPACES_DIR)
            && !rest.as_os_str().is_empty()
        {
            self.workspace_dir = workspaces_dir.join(rest);
        }
    }

    /// Decoded `portSessionSecret` (called once by start; never logged); an error when absent.
    pub fn port_session_key(&self) -> anyhow::Result<[u8; 32]> {
        use secrecy::ExposeSecret as _;
        let secret = self
            .port_session_secret
            .as_ref()
            .ok_or_else(|| anyhow!("manifest: portSessionSecret is absent"))?;
        crate::port_auth::decode_secret(secret.expose_secret())
            .map_err(|error| anyhow!("manifest: portSessionSecret: {error}"))
    }

    /// The control plane's resume hint; "resumed" is decided by the first-boot marker (§3.16).
    pub fn resumed_hint(&self) -> bool {
        self.session.resumed
    }

    /// Rules that need no environment; `slots`, when given, is the allowed proxy-slot set
    /// (`Config::proxy_slots`). Slot uniqueness and private-only hold either way.
    fn check_shape(&self, slots: Option<&[u16]>) -> anyhow::Result<()> {
        if self.version != MANIFEST_VERSION {
            bail!("manifest: unsupported version {}", self.version);
        }
        if !self.workspace_dir.is_absolute()
            || !self
                .workspace_dir
                .components()
                .all(|c| matches!(c, Component::RootDir | Component::Normal(_)))
        {
            bail!("manifest: workspaceDir must be absolute and lexically normal");
        }
        if self.jwt.public_keys.is_empty() {
            bail!("manifest: jwt.publicKeys is empty");
        }
        for (index, pem) in self.jwt.public_keys.iter().enumerate() {
            if !(pem.contains("-----BEGIN PUBLIC KEY-----")
                && pem.contains("-----END PUBLIC KEY-----"))
            {
                bail!("manifest: jwt.publicKeys[{index}] is not a PEM PUBLIC KEY block");
            }
        }
        if self.jwt.issuer.trim().is_empty() || self.jwt.audience.trim().is_empty() {
            bail!("manifest: jwt.issuer and jwt.audience must be non-empty");
        }
        // Everything handed to git as a positional is shape-checked here as well as passed
        // after `--`: a value starting with `-` would otherwise parse as a git option.
        check_git_ref(&self.repo.revision, "repo.revision")?;
        if let Some(git_ref) = self
            .repo
            .git_ref
            .as_deref()
            .filter(|r| !r.trim().is_empty())
        {
            check_git_ref(git_ref, "repo.ref")?;
        }
        check_git_url_shape(&self.repo.clone_url, "repo.cloneUrl")?;
        if let Some(dotfiles) = &self.dotfiles {
            check_git_url_shape(&dotfiles.repo_url, "dotfiles.repoUrl")?;
        }
        if self.port_session_secret.is_some() {
            self.port_session_key()?;
        }
        let mut seen_slots = BTreeSet::new();
        for forward in &self.forwards {
            if forward.port == 0 || INFRA_PORTS.contains(&forward.port) {
                bail!("manifest: forwards[].port {} is not allowed", forward.port);
            }
            if let Some(slot) = forward.slot {
                if forward.visibility != Visibility::Private {
                    bail!(
                        "manifest: forwards[].slot on a public forward (port {})",
                        forward.port
                    );
                }
                if let Some(slots) = slots
                    && !slots.contains(&slot)
                {
                    bail!("manifest: forwards[].slot {slot} is not a proxy slot");
                }
                if !seen_slots.insert(slot) {
                    bail!("manifest: forwards[].slot {slot} is used twice");
                }
            }
        }
        for port in &self.port_pool {
            if *port == 0 || INFRA_PORTS.contains(port) {
                bail!("manifest: portPool entry {port} is not allowed");
            }
        }
        if self.session.cap_at <= self.session.started_at {
            bail!("manifest: session.capAt must be after session.startedAt");
        }
        if let Some(restore) = &self.restore
            && !(restore.tarball_url.starts_with("https://")
                || restore.tarball_url.starts_with("http://"))
        {
            bail!("manifest: restore.tarballUrl must be an http(s) URL");
        }
        for origin in &self.allowed_origins {
            if !is_origin(origin) {
                bail!("manifest: allowedOrigins entry {origin:?} is not an origin");
            }
        }
        if self.activity.interval_secs < 10 {
            bail!("manifest: activity.intervalSecs must be >= 10");
        }
        if self.logs.max_batch > 200 || self.logs.max_batch == 0 {
            bail!("manifest: logs.maxBatch must be in 1..=200");
        }
        if self.logs.max_batch_bytes > 262_144 || self.logs.max_batch_bytes == 0 {
            bail!("manifest: logs.maxBatchBytes must be in 1..=262144");
        }
        Ok(())
    }
}

/// `git check-ref-format`-style rules for a branch name, sha or refspec that reaches `git fetch`
/// / `git checkout` as a positional: non-empty, no leading `-`, no control characters or
/// whitespace, none of `~ ^ : ? * [ \`, no `..`, `@{` or `//`, not starting or ending with `/`,
/// not ending with `.` or `.lock`.
pub fn check_git_ref(value: &str, what: &str) -> anyhow::Result<()> {
    if value.is_empty() {
        bail!("manifest: {what} is empty");
    }
    if value.starts_with('-') {
        bail!("manifest: {what} must not start with '-'");
    }
    if value.chars().any(|c| {
        c.is_ascii_control()
            || c.is_whitespace()
            || matches!(c, '~' | '^' | ':' | '?' | '*' | '[' | '\\')
    }) {
        bail!("manifest: {what} contains characters git refuses");
    }
    if value.contains("..")
        || value.contains("@{")
        || value.contains("//")
        || value.starts_with('/')
        || value.ends_with('/')
        || value.ends_with('.')
        || value.ends_with(".lock")
        || value == "@"
    {
        bail!("manifest: {what} is not a valid git ref");
    }
    Ok(())
}

/// A clone URL is an absolute URL with no leading `-`, no control characters or whitespace,
/// and one of the schemes git is expected to see here (`https`, `http`, `file`); with a host
/// for the network schemes. The scheme allowed in production is decided by
/// [`check_git_url_scheme`] (it needs the config).
pub fn check_git_url_shape(value: &str, what: &str) -> anyhow::Result<reqwest::Url> {
    if value.starts_with('-') {
        bail!("manifest: {what} must not start with '-'");
    }
    if value
        .chars()
        .any(|c| c.is_ascii_control() || c.is_whitespace())
    {
        bail!("manifest: {what} contains control characters or whitespace");
    }
    let url = reqwest::Url::parse(value).map_err(|error| anyhow!("manifest: {what}: {error}"))?;
    match url.scheme() {
        "https" | "http" => {
            if url.host_str().is_none() {
                bail!("manifest: {what} has no host");
            }
        }
        "file" => {}
        other => bail!("manifest: {what} scheme {other}:// is not allowed"),
    }
    Ok(url)
}

/// `https://` only, unless `allow_local` (the test harnesses clone from `file://` and `http://`).
fn check_git_url_shape_scheme(
    url: &reqwest::Url,
    what: &str,
    allow_local: bool,
) -> anyhow::Result<()> {
    if url.scheme() == "https" || allow_local {
        return Ok(());
    }
    bail!(
        "manifest: {what} must be https:// (got {}://)",
        url.scheme()
    )
}

/// [`check_git_url_shape`] plus the production scheme rule.
pub fn check_git_url_scheme(value: &str, what: &str, allow_local: bool) -> anyhow::Result<()> {
    let url = check_git_url_shape(value, what)?;
    check_git_url_shape_scheme(&url, what, allow_local)
}

/// `scheme://host[:port]` with no path, query, fragment or credentials.
fn is_origin(value: &str) -> bool {
    let Ok(url) = reqwest::Url::parse(value) else {
        return false;
    };
    matches!(url.scheme(), "http" | "https")
        && url.host_str().is_some()
        && url.path() == "/"
        && !value.ends_with('/')
        && url.query().is_none()
        && url.fragment().is_none()
        && url.username().is_empty()
        && url.password().is_none()
}

/// The `devcontainer.json` subset (BUILD-SPEC §6.3), parsed leniently (comments, trailing commas)
/// from the checkout, or built from the manifest's [`DevcontainerSpec`] (D38).
#[derive(Clone, Debug, Default, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DevcontainerConfig {
    /// Runs first in the post-create phase (D37).
    #[serde(default)]
    pub on_create_command: Option<LifecycleCommand>,
    /// Runs second in the post-create phase (D37).
    #[serde(default)]
    pub update_content_command: Option<LifecycleCommand>,
    /// Runs once per config hash, after the clone (30 min budget shared by the three stages).
    #[serde(default)]
    pub post_create_command: Option<LifecycleCommand>,
    /// Runs on every boot (10 min budget).
    #[serde(default)]
    pub post_start_command: Option<LifecycleCommand>,
    /// Runs on the first session attach of a boot (10 min budget).
    #[serde(default)]
    pub post_attach_command: Option<LifecycleCommand>,
    /// Literals merged into the server and lifecycle environments after `${containerEnv:…}` expansion.
    #[serde(default)]
    pub remote_env: BTreeMap<String, String>,
    /// Ports requested as forwards at boot.
    #[serde(default)]
    pub forward_ports: Vec<u16>,
    /// Keys parsed with [`parse_port_key`]; ranges, `host:port` and regex keys are ignored with a warning.
    #[serde(default)]
    pub ports_attributes: BTreeMap<String, PortAttributes>,
    /// Defaults for ports without a `portsAttributes` entry.
    #[serde(default)]
    pub other_ports_attributes: Option<PortAttributes>,
    /// Feature ids (checkout form); only `docker-in-docker` is read (it implies the `dockerd` service).
    #[serde(default)]
    pub features: BTreeMap<String, serde_json::Value>,
    /// `customizations.zed`.
    #[serde(default)]
    pub customizations: Option<Customizations>,
    /// Where this config came from; a manifest-sourced config's `zed.extensions` were reduced
    /// to the maintainer-allowed ones by the control plane (D39) and are installed; a
    /// checkout's are offered in the dashboard only.
    #[serde(skip)]
    pub source: DevcontainerSource,
    /// Services the manifest asked for (manifest source only; see [`DevcontainerConfig::services`]).
    #[serde(skip)]
    pub manifest_services: Vec<Service>,
}

/// `customizations` (only the `zed` key is read).
#[derive(Clone, Debug, Default, serde::Deserialize)]
pub struct Customizations {
    /// Our customization key.
    #[serde(default)]
    pub zed: Option<ZedCustomizations>,
}

/// `customizations.zed` (BUILD-SPEC §6.3; D39).
#[derive(Clone, Debug, Default, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ZedCustomizations {
    /// Extension ids merged into the `POST /control/extensions` install list (§3.14).
    #[serde(default)]
    pub extensions: Vec<String>,
    /// The presentation-only settings overlay (already allowlisted by the control plane).
    #[serde(default)]
    pub settings: Option<serde_json::Value>,
    /// Warm-up steering (b10 §3.15).
    #[serde(default)]
    pub prebuild: Option<PrebuildHints>,
    /// Explicit service opt-in besides the `docker-in-docker` Feature.
    #[serde(default)]
    pub services: Vec<Service>,
}

impl DevcontainerConfig {
    /// The config the manifest carries (D38): tagged commands converted, extensions trusted.
    pub fn from_spec(spec: &DevcontainerSpec) -> Self {
        let lifecycle = spec.lifecycle.clone();
        Self {
            on_create_command: lifecycle.on_create.map(Into::into),
            update_content_command: lifecycle.update_content.map(Into::into),
            post_create_command: lifecycle.post_create.map(Into::into),
            post_start_command: lifecycle.post_start.map(Into::into),
            post_attach_command: lifecycle.post_attach.map(Into::into),
            remote_env: spec.remote_env.clone(),
            forward_ports: spec.forward_ports.clone(),
            ports_attributes: spec.ports_attributes.clone(),
            other_ports_attributes: spec.other_ports_attributes.clone(),
            features: spec
                .features
                .iter()
                .map(|name| (name.clone(), serde_json::Value::Object(Default::default())))
                .collect(),
            customizations: Some(Customizations {
                zed: Some(spec.zed.clone()),
            }),
            source: DevcontainerSource::Manifest,
            manifest_services: spec.services.clone(),
        }
    }

    /// `customizations.zed`, when present.
    pub fn zed(&self) -> Option<&ZedCustomizations> {
        self.customizations
            .as_ref()
            .and_then(|customizations| customizations.zed.as_ref())
    }

    /// The services to start beside the server: the manifest's, `customizations.zed.services`,
    /// and `dockerd` whenever the `docker-in-docker` Feature is requested (D40).
    pub fn services(&self) -> Vec<Service> {
        let mut out: Vec<Service> = self.manifest_services.clone();
        if let Some(zed) = self.zed() {
            for service in &zed.services {
                if !out.contains(service) {
                    out.push(*service);
                }
            }
        }
        let docker_in_docker = self.features.keys().any(|id| {
            let name = id.rsplit('/').next().unwrap_or(id);
            let name = name.split([':', '@']).next().unwrap_or(name);
            name == "docker-in-docker"
        });
        if docker_in_docker && !out.contains(&Service::Dockerd) {
            out.push(Service::Dockerd);
        }
        out
    }

    /// The settings overlay to merge under the user's settings: only a manifest-sourced config
    /// carries one the control plane has allowlisted (b10 §3.1 rule 9); a checkout's is ignored.
    pub fn settings_overlay(&self) -> Option<&serde_json::Value> {
        if self.source != DevcontainerSource::Manifest {
            return None;
        }
        self.zed()
            .and_then(|zed| zed.settings.as_ref())
            .filter(|value| value.is_object())
    }

    /// Allowlisted Feature names (`node`, `go`, …) for the warm-up's implied probes.
    pub fn feature_names(&self) -> Vec<String> {
        self.features
            .keys()
            .map(|id| {
                let name = id.rsplit('/').next().unwrap_or(id);
                name.split([':', '@']).next().unwrap_or(name).to_string()
            })
            .collect()
    }
}

/// A containers.dev lifecycle command: string (shell), array (argv) or object (named, parallel).
#[derive(Clone, Debug, serde::Deserialize)]
#[serde(untagged)]
pub enum LifecycleCommand {
    /// Run through `bash -lc`.
    Shell(String),
    /// Run as argv.
    Argv(Vec<String>),
    /// Named commands run in parallel.
    Parallel(BTreeMap<String, LifecycleCommandLeaf>),
}

/// One entry of the object form.
#[derive(Clone, Debug, serde::Deserialize)]
#[serde(untagged)]
pub enum LifecycleCommandLeaf {
    /// Run through `bash -lc`.
    Shell(String),
    /// Run as argv.
    Argv(Vec<String>),
}

/// `portsAttributes` value (label and visibility; other keys ignored).
#[derive(Clone, Debug, Default, serde::Deserialize)]
pub struct PortAttributes {
    /// Forward label.
    #[serde(default)]
    pub label: Option<String>,
    /// Forward visibility (private when absent).
    #[serde(default)]
    pub visibility: Option<Visibility>,
}

impl DevcontainerConfig {
    /// `<repo>/.devcontainer/devcontainer.json`, then `<repo>/.devcontainer.json`; `Ok(None)` if
    /// neither exists. Returns the raw bytes too so the caller can hash them (`sha256:<hex>`) for
    /// the post-create marker.
    pub fn load(repo_root: &Path) -> anyhow::Result<Option<(Self, Vec<u8>)>> {
        let candidates = [
            repo_root.join(".devcontainer").join("devcontainer.json"),
            repo_root.join(".devcontainer.json"),
        ];
        for path in candidates {
            if path.is_file() {
                let bytes =
                    std::fs::read(&path).with_context(|| format!("reading {}", path.display()))?;
                let config: Self = serde_json_lenient::from_slice(&bytes)
                    .with_context(|| format!("parsing {}", path.display()))?;
                return Ok(Some((config, bytes)));
            }
        }
        Ok(None)
    }

    /// `${containerEnv:NAME}` and `${localEnv:NAME}` → lookup in `base`; unknown → empty string
    /// (containers.dev semantics). A platform name (`ZS_*` outside the passthrough identity
    /// set) expands to the empty string whatever `base` holds: the key filter of
    /// `config::manifest_env_key_allowed` would otherwise be bypassed on the value side
    /// (`"TOKEN": "${containerEnv:ZS_SANDBOX_TOKEN}"`, D18).
    pub fn expand_remote_env(&self, base: &BTreeMap<String, String>) -> BTreeMap<String, String> {
        self.remote_env
            .iter()
            .map(|(key, value)| (key.clone(), expand_env_refs(value, base)))
            .collect()
    }
}

/// Whether `${containerEnv:name}` may read `name` from the supervisor's environment: every
/// `ZS_*` name but the passthrough identity set is refused (mirrors `substitute.ts`).
pub fn env_ref_allowed(name: &str) -> bool {
    !name.starts_with("ZS_") || crate::config::PASSTHROUGH_ZS_VARS.contains(&name)
}

fn expand_env_refs(value: &str, base: &BTreeMap<String, String>) -> String {
    let mut out = String::with_capacity(value.len());
    let mut rest = value;
    while let Some(start) = rest.find("${") {
        out.push_str(&rest[..start]);
        let after = &rest[start + 2..];
        let Some(end) = after.find('}') else {
            out.push_str(&rest[start..]);
            return out;
        };
        let inner = &after[..end];
        let replacement = inner
            .strip_prefix("containerEnv:")
            .or_else(|| inner.strip_prefix("localEnv:"))
            .map(|name| {
                // `${containerEnv:NAME:default}` is not a documented form, but a name is cut at
                // the first `:` so a platform name can never hide behind one.
                let name = name.split(':').next().unwrap_or(name);
                if !env_ref_allowed(name) {
                    tracing::warn!(name, "remoteEnv reference to a platform variable refused");
                    return String::new();
                }
                base.get(name).cloned().unwrap_or_default()
            });
        match replacement {
            Some(text) => out.push_str(&text),
            None => {
                out.push_str("${");
                out.push_str(inner);
                out.push('}');
            }
        }
        rest = &after[end + 1..];
    }
    out.push_str(rest);
    out
}

/// `"3000"` → `Some(3000)`; `"3000-3999"`, `"localhost:3000"`, `".+"` → `None`.
pub fn parse_port_key(key: &str) -> Option<u16> {
    key.parse::<u16>().ok().filter(|port| *port > 0)
}

#[cfg(test)]
mod tests {
    use super::*;

    const EXAMPLE: &str = include_str!("../../../docs/contracts/fixtures/manifest.example.json");

    fn example_config(manifest: &Manifest) -> Config {
        let env = BTreeMap::from([
            ("ZS_CONTROL_URL", "https://zs.example.com/api".to_string()),
            ("ZS_SANDBOX_TOKEN", "zsb_test".to_string()),
            ("ZS_SANDBOX_NAME", manifest.sandbox_name.clone()),
            ("ZS_WORKSPACE_ID", manifest.workspace_id.clone()),
            ("HOME", "/vercel".to_string()),
        ]);
        Config::from_lookup(|key| env.get(key).cloned()).unwrap()
    }

    const SCHEMA: &str = include_str!("../../../docs/contracts/sandbox-manifest.v1.json");

    #[test]
    fn manifest_without_port_session_secret_parses_and_validates() {
        let mut json = example_json();
        json.as_object_mut().unwrap().remove("portSessionSecret");
        let manifest = Manifest::parse(serde_json::to_vec(&json).unwrap().as_slice()).unwrap();
        assert!(manifest.port_session_secret.is_none());
        assert!(manifest.port_session_key().is_err());
        manifest.validate(&example_config(&manifest)).unwrap();
    }

    #[test]
    fn relocate_workspace_dir_maps_the_sandbox_prefix_onto_the_local_dir() {
        let mut manifest = Manifest::parse(EXAMPLE.as_bytes()).unwrap();
        manifest.workspace_dir = PathBuf::from("/workspaces/api");
        manifest.relocate_workspace_dir(Path::new("/tmp/zs-local/sb-1/workspaces"));
        assert_eq!(
            manifest.workspace_dir,
            PathBuf::from("/tmp/zs-local/sb-1/workspaces/api")
        );
        // Idempotent, and a directory that is already local stays put.
        manifest.relocate_workspace_dir(Path::new("/tmp/zs-local/sb-1/workspaces"));
        assert_eq!(
            manifest.workspace_dir,
            PathBuf::from("/tmp/zs-local/sb-1/workspaces/api")
        );
        // The bare `/workspaces` root is not relocated (validate rejects it either way).
        let mut bare = Manifest::parse(EXAMPLE.as_bytes()).unwrap();
        bare.workspace_dir = PathBuf::from("/workspaces");
        bare.relocate_workspace_dir(Path::new("/tmp/zs-local/sb-1/workspaces"));
        assert_eq!(bare.workspace_dir, PathBuf::from("/workspaces"));
        // Validation passes against a local `ZS_WORKSPACES_DIR` after relocation.
        let mut manifest = Manifest::parse(EXAMPLE.as_bytes()).unwrap();
        manifest.workspace_dir = PathBuf::from("/workspaces/api");
        let env = BTreeMap::from([
            ("ZS_CONTROL_URL", "https://zs.example.com/api".to_string()),
            ("ZS_SANDBOX_TOKEN", "zsb_test".to_string()),
            ("ZS_SANDBOX_NAME", manifest.sandbox_name.clone()),
            ("ZS_WORKSPACE_ID", manifest.workspace_id.clone()),
            ("HOME", "/tmp/zs-local/sb-1/home".to_string()),
            (
                "ZS_WORKSPACES_DIR",
                "/tmp/zs-local/sb-1/workspaces".to_string(),
            ),
            ("ZS_LOCAL", "1".to_string()),
        ]);
        let config = Config::from_lookup(|key| env.get(key).cloned()).unwrap();
        assert!(manifest.validate(&config).is_err());
        manifest.relocate_workspace_dir(&config.workspaces_dir);
        manifest.validate(&config).unwrap();
    }

    fn example_json() -> serde_json::Value {
        serde_json::from_str(EXAMPLE).unwrap()
    }

    #[test]
    fn example_manifest_parses() {
        let manifest = Manifest::parse(EXAMPLE.as_bytes()).unwrap();
        assert_eq!(manifest.version, 1);
        assert_eq!(manifest.repo.git_ref, None);
        assert!(manifest.restore.is_none());
        assert_eq!(manifest.forwards.len(), 1);
        assert!(manifest.forwards[0].url.is_some());
        assert_eq!(manifest.forwards[0].slot, Some(8444));
        assert_eq!(manifest.forwards[0].visibility, Visibility::Private);
        assert_eq!(
            manifest.settings.as_ref().unwrap().settings,
            "// user settings\n{ \"theme\": \"One Dark\" }",
            "JSONC text is carried verbatim, never parsed"
        );
        assert_eq!(manifest.logs.max_batch, 200);
        assert_eq!(manifest.activity.interval_secs, 30);
        assert!(manifest.prebuild.is_none());
        assert_eq!(manifest.port_session_key().unwrap().len(), 32);
        manifest.validate(&example_config(&manifest)).unwrap();

        // `logs` / `activity` defaults apply when the keys are absent.
        let mut json = example_json();
        json.as_object_mut().unwrap().remove("logs");
        json.as_object_mut().unwrap().remove("activity");
        let manifest = Manifest::parse(json.to_string().as_bytes()).unwrap();
        assert_eq!(manifest.logs.flush_interval_secs, 5);
        assert_eq!(manifest.logs.max_batch, 200);
        assert_eq!(manifest.logs.max_batch_bytes, 262_144);
        assert_eq!(manifest.activity.interval_secs, 30);
    }

    #[test]
    fn identity_mismatch_is_rejected() {
        let manifest = Manifest::parse(EXAMPLE.as_bytes()).unwrap();
        let mut config = example_config(&manifest);
        config.workspace_id = "ws_other".to_string();
        assert!(manifest.validate(&config).is_err());
        let mut config = example_config(&manifest);
        config.sandbox_name = "sb-other".to_string();
        assert!(manifest.validate(&config).is_err());
    }

    #[test]
    fn prebuild_manifest_parses() {
        let mut json = example_json();
        json["userId"] = serde_json::json!("system");
        json["dotfiles"] = serde_json::Value::Null;
        json["workspaceId"] = serde_json::json!("pb_01J8XQ4K2M9N3P5R7T9V1X3Z5B");
        json["sandboxName"] = serde_json::json!("pb-01j8xq4k2m9n3p5r7t9v1x3z5b");
        json["repo"]["revision"] = serde_json::json!("0123456789abcdef0123456789abcdef01234567");
        json["prebuild"] = serde_json::json!({
            "id": "pb_01J8XQ4K2M9N3P5R7T9V1X3Z5B",
            "branch": "main",
            "commit": "0123456789abcdef0123456789abcdef01234567",
        });
        json["forwards"] = serde_json::json!([]);
        let manifest = Manifest::parse(json.to_string().as_bytes()).unwrap();
        let prebuild = manifest.prebuild.as_ref().unwrap();
        assert_eq!(prebuild.branch, "main");
        assert_eq!(prebuild.commit, manifest.repo.revision);
        assert!(manifest.dotfiles.is_none());
        assert_eq!(manifest.user_id, "system");
        manifest.validate(&example_config(&manifest)).unwrap();
        validate_against_schema(&json);
    }

    /// Mutates the fixture per case and expects `parse` or `validate` to refuse it (brief §6.1
    /// `validate_rejects`).
    type Mutation = Box<dyn Fn(&mut serde_json::Value)>;

    #[test]
    fn validate_rejects() {
        let cases: Vec<(&str, Mutation)> = vec![
            (
                "version 2",
                Box::new(|j| j["version"] = serde_json::json!(2)),
            ),
            (
                "workspaceDir /etc (outside the workspaces dir)",
                Box::new(|j| j["workspaceDir"] = serde_json::json!("/etc")),
            ),
            (
                "workspaceDir equal to the workspaces dir",
                Box::new(|j| j["workspaceDir"] = serde_json::json!("/workspaces")),
            ),
            (
                "../ component",
                Box::new(|j| j["workspaceDir"] = serde_json::json!("/workspaces/../etc")),
            ),
            (
                "relative workspaceDir",
                Box::new(|j| j["workspaceDir"] = serde_json::json!("workspaces/api")),
            ),
            (
                "empty publicKeys",
                Box::new(|j| j["jwt"]["publicKeys"] = serde_json::json!([])),
            ),
            (
                "key that is not a PEM block",
                Box::new(|j| j["jwt"]["publicKeys"] = serde_json::json!(["nope"])),
            ),
            (
                "empty issuer",
                Box::new(|j| j["jwt"]["issuer"] = serde_json::json!(" ")),
            ),
            (
                "forward on 8450",
                Box::new(|j| j["forwards"][0]["port"] = serde_json::json!(8450)),
            ),
            (
                "forward on port 0",
                Box::new(|j| j["forwards"][0]["port"] = serde_json::json!(0)),
            ),
            (
                "slot 8452 outside the proxy slots",
                Box::new(|j| j["forwards"][0]["slot"] = serde_json::json!(8452)),
            ),
            (
                "slot on a public forward",
                Box::new(|j| j["forwards"][0]["visibility"] = serde_json::json!("public")),
            ),
            (
                "two forwards on slot 8444",
                Box::new(|j| {
                    let second = serde_json::json!({ "port": 3001, "visibility": "private", "label": null, "url": null, "slot": 8444 });
                    j["forwards"].as_array_mut().unwrap().push(second);
                }),
            ),
            (
                "31-byte portSessionSecret",
                Box::new(|j| {
                    j["portSessionSecret"] =
                        serde_json::json!("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==")
                }),
            ),
            (
                "portPool entry in the infra set",
                Box::new(|j| j["portPool"] = serde_json::json!([3000, 8448])),
            ),
            (
                "session.capAt <= startedAt",
                Box::new(|j| j["session"]["capAt"] = j["session"]["startedAt"].clone()),
            ),
            (
                "restore.tarballUrl http:// without insecure mode",
                Box::new(|j| {
                    j["restore"] =
                        serde_json::json!({ "tarballUrl": "http://blob/x.tgz", "sha256": null })
                }),
            ),
            (
                "restore.tarballUrl with a bad scheme",
                Box::new(|j| {
                    j["restore"] =
                        serde_json::json!({ "tarballUrl": "ftp://blob/x.tgz", "sha256": null })
                }),
            ),
            (
                "allowedOrigins entry with a path",
                Box::new(|j| j["allowedOrigins"] = serde_json::json!(["https://x/path"])),
            ),
            (
                "allowedOrigins entry with a trailing slash",
                Box::new(|j| j["allowedOrigins"] = serde_json::json!(["https://x/"])),
            ),
            (
                "activity.intervalSecs 5",
                Box::new(|j| j["activity"]["intervalSecs"] = serde_json::json!(5)),
            ),
            (
                "logs.maxBatch 500",
                Box::new(|j| j["logs"]["maxBatch"] = serde_json::json!(500)),
            ),
            (
                "logs.maxBatchBytes 0",
                Box::new(|j| j["logs"]["maxBatchBytes"] = serde_json::json!(0)),
            ),
            (
                "cloneUrl that parses as a git option",
                Box::new(|j| {
                    j["repo"]["cloneUrl"] = serde_json::json!("--upload-pack=touch /tmp/x")
                }),
            ),
            (
                "cloneUrl over ssh",
                Box::new(|j| {
                    j["repo"]["cloneUrl"] = serde_json::json!("ssh://git@github.com/acme/api.git")
                }),
            ),
            (
                "cloneUrl over plain http in production",
                Box::new(|j| {
                    j["repo"]["cloneUrl"] = serde_json::json!("http://github.com/acme/api.git")
                }),
            ),
            (
                "cloneUrl with a newline",
                Box::new(|j| {
                    j["repo"]["cloneUrl"] = serde_json::json!("https://github.com/acme/api.git\n-x")
                }),
            ),
            (
                "revision that parses as a git option",
                Box::new(|j| j["repo"]["revision"] = serde_json::json!("--upload-pack=x")),
            ),
            (
                "revision with whitespace",
                Box::new(|j| j["repo"]["revision"] = serde_json::json!("main branch")),
            ),
            (
                "revision with ..",
                Box::new(|j| j["repo"]["revision"] = serde_json::json!("a..b")),
            ),
            (
                "ref that parses as a git option",
                Box::new(|j| j["repo"]["ref"] = serde_json::json!("-oProxyCommand=x")),
            ),
            (
                "ref with a control character",
                Box::new(|j| j["repo"]["ref"] = serde_json::json!("refs/pull/1/head\u{7}")),
            ),
            (
                "dotfiles.repoUrl that parses as a git option",
                Box::new(
                    |j| j["dotfiles"] = serde_json::json!({ "repoUrl": "-c core.sshCommand=x", "installCommand": null }),
                ),
            ),
            (
                "dotfiles.repoUrl over ftp",
                Box::new(|j| {
                    j["dotfiles"] =
                        serde_json::json!({ "repoUrl": "ftp://x/y.git", "installCommand": null })
                }),
            ),
            (
                "restore.tarballUrl pointing at loopback",
                Box::new(
                    |j| j["restore"] = serde_json::json!({ "tarballUrl": "https://127.0.0.1:8451/control/x", "sha256": null }),
                ),
            ),
            (
                "restore.tarballUrl pointing at the metadata address",
                Box::new(
                    |j| j["restore"] = serde_json::json!({ "tarballUrl": "https://169.254.169.254/x.tgz", "sha256": null }),
                ),
            ),
        ];
        for (name, mutate) in cases {
            let mut json = example_json();
            mutate(&mut json);
            let bytes = json.to_string();
            let refused = match Manifest::parse(bytes.as_bytes()) {
                Err(_) => true,
                Ok(manifest) => manifest.validate(&example_config(&manifest)).is_err(),
            };
            assert!(refused, "{name} should be refused");
        }
        // Rules that only `validate` can apply (they need the environment).
        let manifest = Manifest::parse(EXAMPLE.as_bytes()).unwrap();
        let mut config = example_config(&manifest);
        config.workspaces_dir = PathBuf::from("/srv");
        assert!(
            manifest.validate(&config).is_err(),
            "workspaceDir outside ZS_WORKSPACES_DIR"
        );
        // `parse` does not second-guess the slot against the compiled default: an overridden
        // `ZS_PROXY_SLOTS` decides in `validate`.
        let mut json = example_json();
        json["forwards"][0]["slot"] = serde_json::json!(9444);
        let manifest = Manifest::parse(json.to_string().as_bytes()).unwrap();
        let mut config = example_config(&manifest);
        assert!(
            manifest.validate(&config).is_err(),
            "9444 is not a default slot"
        );
        config.proxy_slots = vec![9444, 9445, 9446, 9447];
        manifest.validate(&config).unwrap();
        // An `http://` tarball is fine under ZS_INSECURE_COOKIES=1 (the local docker test), and
        // so are `file://` / `http://` clone URLs (the test harnesses' bare repositories).
        let mut json = example_json();
        json["restore"] = serde_json::json!({ "tarballUrl": "http://blob/x.tgz", "sha256": null });
        json["repo"]["cloneUrl"] = serde_json::json!("file:///tmp/fixture.git");
        json["dotfiles"] = serde_json::json!({ "repoUrl": "http://127.0.0.1:9/dotfiles.git", "installCommand": null });
        let manifest = Manifest::parse(json.to_string().as_bytes()).unwrap();
        let mut config = example_config(&manifest);
        assert!(manifest.validate(&config).is_err(), "not in production");
        config.insecure_cookies = true;
        manifest.validate(&config).unwrap();
        let mut config = example_config(&manifest);
        config.local = true;
        json["restore"] = serde_json::Value::Null;
        let manifest = Manifest::parse(json.to_string().as_bytes()).unwrap();
        manifest.validate(&config).unwrap();
    }

    #[test]
    fn git_refs_and_urls_are_shape_checked() {
        for ok in [
            "main",
            "feature/x-1",
            "0123456789abcdef0123456789abcdef01234567",
            "refs/pull/12/head",
            "refs/heads/release-2026.09",
        ] {
            check_git_ref(ok, "x").unwrap_or_else(|error| panic!("{ok}: {error}"));
        }
        for bad in [
            "",
            "-x",
            "--upload-pack=x",
            "a b",
            "a\tb",
            "a..b",
            "a@{1}",
            "a//b",
            "/a",
            "a/",
            "a.",
            "a.lock",
            "a:b",
            "a~1",
            "a^",
            "a?",
            "a*",
            "a[b",
            "a\\b",
            "@",
        ] {
            assert!(check_git_ref(bad, "x").is_err(), "{bad:?} must be refused");
        }
        check_git_url_shape("https://github.com/acme/api.git", "x").unwrap();
        check_git_url_shape("file:///tmp/x.git", "x").unwrap();
        for bad in [
            "-oProxyCommand=x",
            "https://github.com/a b",
            "ssh://git@github.com/x",
            "git@github.com:acme/api.git",
            "https://",
            "",
        ] {
            assert!(
                check_git_url_shape(bad, "x").is_err(),
                "{bad:?} must be refused"
            );
        }
        assert!(check_git_url_scheme("http://github.com/x", "x", false).is_err());
        check_git_url_scheme("http://github.com/x", "x", true).unwrap();
        check_git_url_scheme("https://github.com/x", "x", false).unwrap();
    }

    #[test]
    fn fixture_validates_against_schema() {
        let schema: serde_json::Value = serde_json::from_str(SCHEMA).unwrap();
        assert_eq!(
            schema["$schema"],
            "https://json-schema.org/draft/2020-12/schema"
        );
        validate_against_schema(&example_json());
        // The validator is not a rubber stamp: a broken fixture is caught.
        let mut json = example_json();
        json["forwards"][0]["visibility"] = serde_json::json!("hidden");
        assert!(
            schema_errors(&schema, &json, "$")
                .iter()
                .any(|e| e.contains("visibility"))
        );
        let mut json = example_json();
        json.as_object_mut().unwrap().remove("jwt");
        assert!(
            schema_errors(&schema, &json, "$")
                .iter()
                .any(|e| e.contains("jwt"))
        );
        let mut json = example_json();
        json["session"]["startedAt"] = serde_json::json!("soon");
        assert!(!schema_errors(&schema, &json, "$").is_empty());
    }

    fn validate_against_schema(json: &serde_json::Value) {
        let schema: serde_json::Value = serde_json::from_str(SCHEMA).unwrap();
        let errors = schema_errors(&schema, json, "$");
        assert!(errors.is_empty(), "schema violations: {errors:#?}");
    }

    /// A small JSON Schema checker covering what `sandbox-manifest.v1.json` uses: `type` (single
    /// or list), `required`, `properties`, `additionalProperties` (schema form), `items`, `enum`,
    /// `minimum`/`maximum`, `minLength`, `minItems`, `pattern`. No jsonschema crate.
    fn schema_errors(
        schema: &serde_json::Value,
        value: &serde_json::Value,
        path: &str,
    ) -> Vec<String> {
        use serde_json::Value;
        let mut errors = Vec::new();
        let type_ok = |name: &str| match name {
            "object" => value.is_object(),
            "array" => value.is_array(),
            "string" => value.is_string(),
            "integer" => value.as_i64().is_some() || value.as_u64().is_some(),
            "number" => value.is_number(),
            "boolean" => value.is_boolean(),
            "null" => value.is_null(),
            _ => false,
        };
        match &schema["type"] {
            Value::String(name) => {
                if !type_ok(name) {
                    errors.push(format!("{path}: expected {name}, got {value}"));
                    return errors;
                }
            }
            Value::Array(names) if !names.iter().filter_map(Value::as_str).any(type_ok) => {
                errors.push(format!("{path}: expected one of {names:?}, got {value}"));
                return errors;
            }
            _ => {}
        }
        if let Some(allowed) = schema["enum"].as_array()
            && !allowed.contains(value)
        {
            errors.push(format!("{path}: {value} not in {allowed:?}"));
        }
        if let Some(text) = value.as_str() {
            if let Some(min) = schema["minLength"].as_u64()
                && (text.chars().count() as u64) < min
            {
                errors.push(format!("{path}: shorter than {min}"));
            }
            if let Some(pattern) = schema["pattern"].as_str() {
                let re = regex::Regex::new(pattern).unwrap();
                if !re.is_match(text) {
                    errors.push(format!("{path}: {text:?} does not match {pattern}"));
                }
            }
        }
        if let Some(number) = value.as_f64() {
            if let Some(min) = schema["minimum"].as_f64()
                && number < min
            {
                errors.push(format!("{path}: {number} < {min}"));
            }
            if let Some(max) = schema["maximum"].as_f64()
                && number > max
            {
                errors.push(format!("{path}: {number} > {max}"));
            }
        }
        if let Some(object) = value.as_object() {
            if let Some(required) = schema["required"].as_array() {
                for key in required.iter().filter_map(Value::as_str) {
                    if !object.contains_key(key) {
                        errors.push(format!("{path}: missing required {key}"));
                    }
                }
            }
            let properties = schema["properties"].as_object();
            for (key, child) in object {
                let child_path = format!("{path}.{key}");
                if let Some(child_schema) = properties.and_then(|p| p.get(key)) {
                    errors.extend(schema_errors(child_schema, child, &child_path));
                } else if schema["additionalProperties"].is_object() {
                    errors.extend(schema_errors(
                        &schema["additionalProperties"],
                        child,
                        &child_path,
                    ));
                }
            }
        }
        if let Some(items) = value.as_array() {
            if let Some(min) = schema["minItems"].as_u64()
                && (items.len() as u64) < min
            {
                errors.push(format!("{path}: fewer than {min} items"));
            }
            if schema["items"].is_object() {
                for (index, item) in items.iter().enumerate() {
                    errors.extend(schema_errors(
                        &schema["items"],
                        item,
                        &format!("{path}[{index}]"),
                    ));
                }
            }
        }
        errors
    }

    #[test]
    fn devcontainer_jsonc_loads() {
        let repo = tempfile::tempdir().unwrap();
        assert!(DevcontainerConfig::load(repo.path()).unwrap().is_none());

        let text = r#"{
            // the workspace image
            "name": "api",
            /* lifecycle */
            "postCreateCommand": "npm ci",
            "forwardPorts": [3000, 5173],
            "portsAttributes": { "3000": { "label": "web", "visibility": "public" } },
            "customizations": { "zed": { "extensions": ["toml"] } },
        }"#;
        std::fs::create_dir_all(repo.path().join(".devcontainer")).unwrap();
        std::fs::write(
            repo.path().join(".devcontainer/devcontainer.json"),
            text.as_bytes(),
        )
        .unwrap();
        let (config, bytes) = DevcontainerConfig::load(repo.path()).unwrap().unwrap();
        assert_eq!(bytes, text.as_bytes(), "the raw bytes are returned to hash");
        assert_eq!(config.forward_ports, vec![3000, 5173]);
        assert_eq!(
            config.ports_attributes["3000"].visibility,
            Some(Visibility::Public)
        );
        assert_eq!(
            config
                .customizations
                .and_then(|customizations| customizations.zed)
                .map(|zed| zed.extensions),
            Some(vec!["toml".to_string()])
        );

        // The `.devcontainer/` file wins over the root one.
        std::fs::write(repo.path().join(".devcontainer.json"), b"{}").unwrap();
        let (_, bytes) = DevcontainerConfig::load(repo.path()).unwrap().unwrap();
        assert_eq!(bytes, text.as_bytes());
    }

    #[test]
    fn devcontainer_block_parses_and_defaults() {
        // b10 §6.5: the old `{ configHash }` shape parses as `checkout` with empty defaults.
        let mut json = example_json();
        json["devcontainer"] = serde_json::json!({ "configHash": "9f8e7d6c5b4a39281706f5e4d3c2b1a09f8e7d6c5b4a39281706f5e4d3c2b1a0" });
        let manifest = Manifest::parse(json.to_string().as_bytes()).unwrap();
        let spec = manifest.devcontainer.unwrap();
        assert_eq!(spec.source, DevcontainerSource::Checkout);
        assert!(spec.lifecycle.post_create.is_none());
        assert!(spec.services.is_empty());

        // The full block (the committed fixture carries one): tagged commands and services.
        let manifest = Manifest::parse(EXAMPLE.as_bytes()).unwrap();
        let spec = manifest.devcontainer.unwrap();
        assert_eq!(spec.source, DevcontainerSource::Manifest);
        assert!(matches!(
            spec.lifecycle.post_create,
            Some(ManifestLifecycleCommand::Shell { .. })
        ));
        assert_eq!(spec.forward_ports, vec![3000]);
        assert_eq!(spec.services, vec![Service::Dockerd]);
        assert_eq!(spec.zed.extensions, vec!["toml".to_string()]);
        let config = DevcontainerConfig::from_spec(&spec);
        assert!(matches!(
            config.post_create_command,
            Some(LifecycleCommand::Shell(_))
        ));
        assert_eq!(config.services(), vec![Service::Dockerd]);
        assert_eq!(config.source, DevcontainerSource::Manifest);
        assert_eq!(
            config.ports_attributes["3000"].visibility,
            Some(Visibility::Private)
        );

        // A typo in `services` fails deserialisation.
        let mut json = example_json();
        json["devcontainer"]["services"] = serde_json::json!(["dockerdd"]);
        assert!(Manifest::parse(json.to_string().as_bytes()).is_err());

        // The parallel form converts leaf by leaf.
        let mut json = example_json();
        json["devcontainer"]["lifecycle"]["postCreate"] = serde_json::json!({
            "kind": "parallel",
            "commands": { "a": { "kind": "shell", "command": "echo a" }, "b": { "kind": "argv", "argv": ["true"] } }
        });
        let manifest = Manifest::parse(json.to_string().as_bytes()).unwrap();
        let config = DevcontainerConfig::from_spec(&manifest.devcontainer.unwrap());
        match config.post_create_command {
            Some(LifecycleCommand::Parallel(commands)) => {
                assert!(matches!(commands["a"], LifecycleCommandLeaf::Shell(_)));
                assert!(matches!(commands["b"], LifecycleCommandLeaf::Argv(_)));
            }
            other => panic!("unexpected {other:?}"),
        }
    }

    #[test]
    fn checkout_config_derives_services_and_trust() {
        let config: DevcontainerConfig = serde_json_lenient::from_str(
            r#"{
                "features": { "ghcr.io/devcontainers/features/docker-in-docker:2": {}, "node": "20" },
                "customizations": { "zed": { "extensions": ["toml"], "settings": { "theme": "x" } } }
            }"#,
        )
        .unwrap();
        assert_eq!(config.source, DevcontainerSource::Checkout);
        assert_eq!(config.services(), vec![Service::Dockerd]);
        // A checkout's settings overlay is never applied (D39): only the control plane's allowlisted one is.
        assert!(config.settings_overlay().is_none());
        let mut names = config.feature_names();
        names.sort();
        assert_eq!(
            names,
            vec!["docker-in-docker".to_string(), "node".to_string()]
        );
    }

    #[test]
    fn devcontainer_helpers() {
        assert_eq!(parse_port_key("3000"), Some(3000));
        assert_eq!(parse_port_key("3000-3999"), None);
        assert_eq!(parse_port_key("localhost:3000"), None);
        assert_eq!(parse_port_key("0"), None);
        let config: DevcontainerConfig = serde_json_lenient::from_str(
            r#"{ // comment
                "postCreateCommand": "npm ci",
                "remoteEnv": {
                    "A": "${containerEnv:HOME}/x", "B": "${localEnv:MISSING}", "C": "${other}",
                    "TOKEN": "${containerEnv:ZS_SANDBOX_TOKEN}", "BYPASS": "x${localEnv:ZS_BYPASS_SECRET}y",
                    "URL": "${containerEnv:ZS_CONTROL_URL:fallback}", "WS": "${containerEnv:ZS_WORKSPACE_ID}"
                },
            }"#,
        )
        .unwrap();
        let base = BTreeMap::from([
            ("HOME".to_string(), "/vercel".to_string()),
            ("ZS_SANDBOX_TOKEN".to_string(), "zsb_secret".to_string()),
            ("ZS_BYPASS_SECRET".to_string(), "bypass".to_string()),
            ("ZS_CONTROL_URL".to_string(), "https://zs".to_string()),
            ("ZS_WORKSPACE_ID".to_string(), "ws_1".to_string()),
        ]);
        let expanded = config.expand_remote_env(&base);
        assert_eq!(expanded["A"], "/vercel/x");
        assert_eq!(expanded["B"], "");
        assert_eq!(expanded["C"], "${other}");
        // The value side of the ZS_* filter (D18): platform variables never reach a child.
        assert_eq!(expanded["TOKEN"], "");
        assert_eq!(expanded["BYPASS"], "xy");
        assert_eq!(expanded["URL"], "");
        // The passthrough identity set stays readable.
        assert_eq!(expanded["WS"], "ws_1");
        assert!(env_ref_allowed("HOME"));
        assert!(env_ref_allowed("ZS_REGION"));
        assert!(!env_ref_allowed("ZS_CONTROL_SECRET_FILE"));
        assert!(matches!(
            config.post_create_command,
            Some(LifecycleCommand::Shell(_))
        ));
    }
}
