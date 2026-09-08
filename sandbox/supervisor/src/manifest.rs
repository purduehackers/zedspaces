//! Workspace manifest and supported devcontainer configuration types.
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
    /// Must match `ZS_WORKSPACE_ID`.
    pub workspace_id: String,
    /// `== ZS_SANDBOX_NAME`.
    pub sandbox_name: String,
    /// Shared-space user ID (logs only).
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
    /// Optional HMAC bootstrap key for private forwards. Public previews need no key.
    #[serde(default)]
    pub port_session_secret: Option<SecretString>,
    /// Current forwards; seeds `ForwardsState`.
    #[serde(default)]
    pub forwards: Vec<Forward>,
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
}

/// `manifest.repo`.
#[derive(Clone, Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoSpec {
    /// GitHub owner.
    pub owner: String,
    /// Repository name (also the workspace directory name).
    pub name: String,
    /// Public HTTPS clone URL.
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
    /// Public: proxy slot URL; private: the control plane's `/open` link (D8).
    #[serde(default)]
    pub url: Option<String>,
    /// The proxy slot the control plane allocated; private slots can also be learned from the first
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
    /// Enabled devcontainer feature names.
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
    /// (against `config.proxy_slots`, D21), unique; session ordering; tarball
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
    /// (`Config::proxy_slots`). Slot uniqueness holds either way.
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
