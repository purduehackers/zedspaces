//! Environment and filesystem contract for `zs-agent` (brief §3.3 and §4.6).
//!
//! The environment is read once at startup; every other module receives a `&Config`. The port
//! map below is the **D21** map from `DECISIONS.md`, which supersedes the brief's §3.3 table:
//!
//! | Port | Bind | Owner | Declared to Vercel | Purpose |
//! |---|---|---|---|---|
//! | 8443 | `0.0.0.0` | `zed-remote-server serve --listen` | yes | `/rpc`, `/files`, `/extensions/*`, public `/health` |
//! | 8444-8447 | `0.0.0.0` | `zs-agent` proxy slots 0-3 | yes | private-port proxy (D8/D21), cookie-gated |
//! | 8448 | `0.0.0.0` | `zs-agent` health listener | yes | `GET /health`, minimal unauthenticated body |
//! | 8449 | – | reserved | no | part of the infra set, unbound |
//! | 8450 | `127.0.0.1` | `zs-agent` local API | no | `/ports`, `/extensions`, `/git-token`, `/lifecycle`, `/health` detail (`ZS_SUPERVISOR_URL`) |
//! | 8451 | `127.0.0.1` | `zed-remote-server serve --control-listen` | no | `/control/lifecycle`, `/control/ports`, `/control/extensions` |
//!
//! Forward pool: `3000, 3001, 4000, 5000, 5173, 8000, 8080, 8888`. The infrastructure set
//! `8443-8451` is excluded from user forwards everywhere.

use std::collections::{BTreeMap, BTreeSet};
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::os::unix::fs::DirBuilderExt;
use std::path::{Path, PathBuf};

/// Re-export so callers name one secret type; `ExposeSecret` is imported where a value is used.
pub use secrecy::SecretString;

/// Default parent directory of workspace checkouts (`ZS_WORKSPACES_DIR`).
pub const DEFAULT_WORKSPACES_DIR: &str = "/workspaces";
/// Default path of the `zed-remote-server` binary (`ZS_SERVER_BIN`).
pub const DEFAULT_SERVER_BIN: &str = "/usr/local/bin/zed-remote-server";
/// `zed-remote-server serve --listen` port (declared, public).
pub const RPC_PORT: u16 = 8443;
/// D21 private-port proxy slots (declared, public); one private forward per slot.
pub const PROXY_SLOTS: [u16; 4] = [8444, 8445, 8446, 8447];
/// D21 supervisor health listener (declared, public): `GET /health` with the minimal body only.
pub const HEALTH_PORT: u16 = 8448;
/// D21 supervisor loopback API (`ZS_SUPERVISOR_URL`); bound to `127.0.0.1`, never declared.
pub const LOCAL_API_PORT: u16 = 8450;
/// D21 `serve --control-listen` port; loopback, owned by the server, never declared.
pub const SERVER_CONTROL_PORT: u16 = 8451;
/// D21 infrastructure set `8443-8451`, excluded from user forwards everywhere (8449 is reserved).
pub const INFRA_PORTS: [u16; 9] = [8443, 8444, 8445, 8446, 8447, 8448, 8449, 8450, 8451];
/// Path prefix appended to `ZS_CONTROL_URL` (which already ends in `/api`).
pub const SANDBOX_API_PREFIX: &str = "/sandboxes";
/// D21 default of `ZS_SUPERVISOR_URL` (and of the server's `DEFAULT_SUPERVISOR_URL`).
pub const DEFAULT_SUPERVISOR_URL: &str = "http://127.0.0.1:8450";
/// Variables the supervisor strips from every child environment (§3.3; D18/D29): children talk to
/// the supervisor over loopback instead. `ZS_CONTROL_SECRET` never exists and
/// `ZS_CONTROL_PLANE_URL` is not read (D29), but a caller-set one is scrubbed too.
pub const STRIPPED_CHILD_VARS: [&str; 5] = [
    "ZS_SANDBOX_TOKEN",
    "ZS_CONTROL_URL",
    "ZS_CONTROL_PLANE_URL",
    "ZS_BYPASS_SECRET",
    "ZS_CONTROL_SECRET",
];
/// The only `ZS_`-prefixed keys `manifest.env` may carry into a child environment (§3.3).
pub const PASSTHROUGH_ZS_VARS: [&str; 3] = ["ZS_WORKSPACE_ID", "ZS_SANDBOX_NAME", "ZS_REGION"];
/// b9's `RESERVED_SECRET_NAMES`: `manifest.env`/`remoteEnv` literals under these names are dropped
/// with a warning, because they come from the repository's `devcontainer.json`.
pub const RESERVED_ENV_NAMES: [&str; 12] = [
    "LD_PRELOAD",
    "LD_LIBRARY_PATH",
    "BASH_ENV",
    "ENV",
    "PROMPT_COMMAND",
    "GIT_ASKPASS",
    "SSH_ASKPASS",
    "GIT_CONFIG_PARAMETERS",
    "HOME",
    "PATH",
    "USER",
    "SHELL",
];
/// `SHELL` exported to children when the process environment lacks one (b3 §7.10; D28).
pub const DEFAULT_SHELL: &str = "/bin/bash";
/// `USER` exported to children when the process environment lacks one (D28).
pub const DEFAULT_USER: &str = "ubuntu";
/// `LANG` exported to children when the process environment lacks one (D28).
pub const DEFAULT_LANG: &str = "C.UTF-8";
/// `PATH` exported to children when the process environment lacks one (D28); mirrors the
/// universal image's `PATH` (`/vercel/.local/bin`, pnpm/npm globals, then the system dirs).
pub const DEFAULT_PATH: &str = "/vercel/.local/bin:/vercel/.global/pnpm/bin:/vercel/.global/npm/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";

/// Everything `zs-agent` reads from its environment (brief §3.3, §4.6; D21; D29).
#[derive(Clone, Debug)]
pub struct Config {
    /// `ZS_CONTROL_URL` – the API base **including** `/api`, e.g. `https://zs.example.com/api`
    /// (b9 §3.18 `controlApiBase()`); trailing slash stripped. D29 makes it canonical and removes
    /// the `ZS_CONTROL_PLANE_URL` fallback.
    pub control_api_base: reqwest::Url,
    /// `ZS_BYPASS_SECRET` → header `x-vercel-protection-bypass` on every control-plane call (D18).
    pub bypass_secret: Option<SecretString>,
    /// `ZS_SANDBOX_TOKEN` (`zsb_…`), the bearer for every control-plane call.
    pub sandbox_token: SecretString,
    /// `ZS_SANDBOX_NAME` (`sb-…` workspace, `pb-…` prebuild).
    pub sandbox_name: String,
    /// `ZS_WORKSPACE_ID`; cross-checked against `manifest.workspaceId` (the prebuild id for `pb-` principals).
    pub workspace_id: String,
    /// `ZS_REGION`; informational (logged, echoed in health).
    pub region: Option<String>,
    /// `ZS_BUILD_ID` (baked into the image); `"dev"` when absent so local runs still boot.
    pub build_id: String,
    /// `ZS_PREBUILD=1`: `start` refuses to run when set, `prebuild` requires it (D14).
    pub prebuild: bool,
    /// `ZS_WORKSPACES_DIR`, default `/workspaces`.
    pub workspaces_dir: PathBuf,
    /// `ZS_STATE_DIR`, default `$HOME/.zs`.
    pub state_dir: PathBuf,
    /// `ZS_DATA_DIR`, default `$XDG_DATA_HOME/zed` or `$HOME/.local/share/zed` (mirrors Zed's
    /// `paths::data_dir()`); the tarball restore target, otherwise logging only.
    pub data_dir: PathBuf,
    /// `ZS_SERVER_BIN`, default `/usr/local/bin/zed-remote-server`.
    pub server_bin: PathBuf,
    /// `ZS_HEALTH_LISTEN`, default `0.0.0.0:<ZS_HEALTH_PORT or 8448>` (D21).
    pub health_listen: SocketAddr,
    /// `ZS_LOCAL_API_LISTEN`, default `127.0.0.1:8450`; must be loopback (validated).
    pub local_api_listen: SocketAddr,
    /// `ZS_PROXY_BIND_IP`, default `0.0.0.0`; the slot ports come from `proxy_slots`.
    pub proxy_bind_ip: IpAddr,
    /// `ZS_PROXY_SLOTS`, default `8444,8445,8446,8447` (D21); unique, non-empty, disjoint from the
    /// other bound infra ports.
    pub proxy_slots: Vec<u16>,
    /// `ZS_RPC_LISTEN`, default `0.0.0.0:8443`.
    pub rpc_listen: SocketAddr,
    /// `ZS_SERVER_CONTROL_LISTEN`, default `127.0.0.1:8451` (D21); passed as `--control-listen`;
    /// must be loopback (validated).
    pub server_control_listen: SocketAddr,
    /// `ZS_INSECURE_COOKIES=1` (local docker test over plain http): omit `Secure` on the proxy
    /// cookie and allow `http://` restore tarball URLs.
    pub insecure_cookies: bool,
    /// `HOME` (`/vercel` in the universal image).
    pub home: PathBuf,
    /// `ZS_LOCAL=1`: the supervisor runs on a developer machine (the control plane's local
    /// backend) instead of inside a sandbox. `manifest.workspaceDir` (`/workspaces/<name>`) is
    /// relocated under `ZS_WORKSPACES_DIR`, and the listening-port discovery falls back to
    /// `lsof` where there is no `/proc` (macOS). Nothing sandbox-only is disabled otherwise.
    pub local: bool,
}

/// Why `Config::from_env` refused the environment.
#[derive(Debug, thiserror::Error)]
pub enum ConfigError {
    /// A required variable is unset or empty.
    #[error("missing required environment variable {0}")]
    Missing(&'static str),
    /// A variable is set but unusable; the second field says why.
    #[error("invalid {0}: {1}")]
    Invalid(&'static str, String),
}

impl Config {
    /// Reads the process environment (brief §3.3, §4.6).
    pub fn from_env() -> Result<Self, ConfigError> {
        Self::from_lookup(|key| std::env::var(key).ok())
    }

    /// Builds a `Config` from an arbitrary lookup function (tests and embedding; the process
    /// environment is not touched). Empty values count as unset.
    pub fn from_lookup(lookup: impl Fn(&str) -> Option<String>) -> Result<Self, ConfigError> {
        let get = |key: &str| lookup(key).filter(|value| !value.trim().is_empty());

        let control_api_base = {
            let raw = get("ZS_CONTROL_URL").ok_or(ConfigError::Missing("ZS_CONTROL_URL"))?;
            let trimmed = raw.trim().trim_end_matches('/');
            let url = reqwest::Url::parse(trimmed)
                .map_err(|error| ConfigError::Invalid("ZS_CONTROL_URL", error.to_string()))?;
            if !matches!(url.scheme(), "http" | "https") || url.host_str().is_none() {
                return Err(ConfigError::Invalid(
                    "ZS_CONTROL_URL",
                    "expected an absolute http(s) URL ending in /api".to_string(),
                ));
            }
            url
        };
        let bypass_secret = get("ZS_BYPASS_SECRET").map(SecretString::from);
        let sandbox_token = get("ZS_SANDBOX_TOKEN")
            .map(SecretString::from)
            .ok_or(ConfigError::Missing("ZS_SANDBOX_TOKEN"))?;
        let sandbox_name = get("ZS_SANDBOX_NAME").ok_or(ConfigError::Missing("ZS_SANDBOX_NAME"))?;
        if !is_path_segment(&sandbox_name) {
            return Err(ConfigError::Invalid(
                "ZS_SANDBOX_NAME",
                "expected [A-Za-z0-9._-]+".to_string(),
            ));
        }
        let workspace_id = get("ZS_WORKSPACE_ID").ok_or(ConfigError::Missing("ZS_WORKSPACE_ID"))?;
        let region = get("ZS_REGION");
        let build_id = get("ZS_BUILD_ID").unwrap_or_else(|| "dev".to_string());
        let prebuild = get("ZS_PREBUILD").is_some_and(|value| matches!(value.trim(), "1" | "true"));
        let home = PathBuf::from(get("HOME").ok_or(ConfigError::Missing("HOME"))?);
        let workspaces_dir = get("ZS_WORKSPACES_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from(DEFAULT_WORKSPACES_DIR));
        let state_dir = get("ZS_STATE_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|| home.join(".zs"));
        let data_dir = get("ZS_DATA_DIR").map(PathBuf::from).unwrap_or_else(|| {
            get("XDG_DATA_HOME")
                .map(|xdg| PathBuf::from(xdg).join("zed"))
                .unwrap_or_else(|| home.join(".local").join("share").join("zed"))
        });
        let server_bin = get("ZS_SERVER_BIN")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from(DEFAULT_SERVER_BIN));

        let health_port = match get("ZS_HEALTH_PORT") {
            Some(raw) => raw
                .trim()
                .parse::<u16>()
                .map_err(|error| ConfigError::Invalid("ZS_HEALTH_PORT", error.to_string()))?,
            None => HEALTH_PORT,
        };
        let health_listen = parse_addr(
            "ZS_HEALTH_LISTEN",
            get("ZS_HEALTH_LISTEN"),
            SocketAddr::new(IpAddr::V4(Ipv4Addr::UNSPECIFIED), health_port),
        )?;
        let local_api_listen = parse_addr(
            "ZS_LOCAL_API_LISTEN",
            get("ZS_LOCAL_API_LISTEN"),
            SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), LOCAL_API_PORT),
        )?;
        if !local_api_listen.ip().is_loopback() {
            return Err(ConfigError::Invalid(
                "ZS_LOCAL_API_LISTEN",
                "must be a loopback address".to_string(),
            ));
        }
        let proxy_bind_ip = match get("ZS_PROXY_BIND_IP") {
            Some(raw) => raw
                .trim()
                .parse::<IpAddr>()
                .map_err(|error| ConfigError::Invalid("ZS_PROXY_BIND_IP", error.to_string()))?,
            None => IpAddr::V4(Ipv4Addr::UNSPECIFIED),
        };
        let proxy_slots = match get("ZS_PROXY_SLOTS") {
            Some(raw) => parse_slots(&raw)?,
            None => PROXY_SLOTS.to_vec(),
        };
        let rpc_listen = parse_addr(
            "ZS_RPC_LISTEN",
            get("ZS_RPC_LISTEN"),
            SocketAddr::new(IpAddr::V4(Ipv4Addr::UNSPECIFIED), RPC_PORT),
        )?;
        let server_control_listen = parse_addr(
            "ZS_SERVER_CONTROL_LISTEN",
            get("ZS_SERVER_CONTROL_LISTEN"),
            SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), SERVER_CONTROL_PORT),
        )?;
        if !server_control_listen.ip().is_loopback() {
            return Err(ConfigError::Invalid(
                "ZS_SERVER_CONTROL_LISTEN",
                "must be a loopback address".to_string(),
            ));
        }
        for slot in &proxy_slots {
            let clashes = [
                ("ZS_HEALTH_LISTEN", health_listen.port()),
                ("ZS_LOCAL_API_LISTEN", local_api_listen.port()),
                ("ZS_RPC_LISTEN", rpc_listen.port()),
                ("ZS_SERVER_CONTROL_LISTEN", server_control_listen.port()),
            ];
            if let Some((name, _)) = clashes.iter().find(|(_, port)| port == slot) {
                return Err(ConfigError::Invalid(
                    "ZS_PROXY_SLOTS",
                    format!("slot {slot} collides with {name}"),
                ));
            }
        }
        let insecure_cookies =
            get("ZS_INSECURE_COOKIES").is_some_and(|value| matches!(value.trim(), "1" | "true"));
        let local = get("ZS_LOCAL").is_some_and(|value| matches!(value.trim(), "1" | "true"));

        Ok(Self {
            control_api_base,
            bypass_secret,
            sandbox_token,
            sandbox_name,
            workspace_id,
            region,
            build_id,
            prebuild,
            workspaces_dir,
            state_dir,
            data_dir,
            server_bin,
            health_listen,
            local_api_listen,
            proxy_bind_ip,
            proxy_slots,
            rpc_listen,
            server_control_listen,
            insecure_cookies,
            home,
            local,
        })
    }

    /// `{control_api_base}/sandboxes/{sandbox_name}/{suffix}`.
    pub fn sandbox_api_url(&self, suffix: &str) -> reqwest::Url {
        let base = self.control_api_base.as_str().trim_end_matches('/');
        let suffix = suffix.trim_start_matches('/');
        let joined = format!("{base}{SANDBOX_API_PREFIX}/{}/{suffix}", self.sandbox_name);
        reqwest::Url::parse(&joined)
            .expect("control_api_base is an absolute URL and sandbox_name is a path segment")
    }

    /// `http://{local_api_listen}` – exported as `ZS_SUPERVISOR_URL` and passed as `--supervisor-url`.
    pub fn supervisor_url(&self) -> String {
        format!("http://{}", self.local_api_listen)
    }

    /// `<state>/run` (pid, port file, control secret) – cleared on every start.
    pub fn run_dir(&self) -> PathBuf {
        self.state_dir.join("run")
    }

    /// `<state>/markers` (`clone.done`, `post-create.done`, `dotfiles.done`, `first-boot.done`,
    /// `settings.sha256`, `keymap.sha256`).
    pub fn markers_dir(&self) -> PathBuf {
        self.state_dir.join("markers")
    }

    /// `<state>/jwt` (public key PEMs, 0600).
    pub fn jwt_dir(&self) -> PathBuf {
        self.state_dir.join("jwt")
    }

    /// `<state>/restore.partial` (tarball staging, §3.14).
    pub fn restore_dir(&self) -> PathBuf {
        self.state_dir.join("restore.partial")
    }

    /// `run/zs-agent.pid`.
    pub fn pid_file(&self) -> PathBuf {
        self.run_dir().join("zs-agent.pid")
    }

    /// `run/server.port`.
    pub fn server_port_file(&self) -> PathBuf {
        self.run_dir().join("server.port")
    }

    /// `run/control.secret` (0600; D18: the secret travels as a file path, never as an
    /// environment value).
    pub fn control_secret_file(&self) -> PathBuf {
        self.run_dir().join("control.secret")
    }

    /// The environment handed to every child (server, lifecycle commands): process environment ∪
    /// filtered `manifest.env` ∪ filtered expanded `remoteEnv` ∪ `{ ZS_SUPERVISOR_URL,
    /// ZS_CONTROL_SECRET_FILE }` minus [`STRIPPED_CHILD_VARS`], with `SHELL`, `USER`, `HOME`,
    /// `PATH` and `LANG` filled when missing (§3.3; D28). No secret is added (D18).
    pub fn child_env(
        &self,
        manifest_env: &BTreeMap<String, String>,
        remote_env: &BTreeMap<String, String>,
    ) -> BTreeMap<String, String> {
        self.child_env_from(std::env::vars(), manifest_env, remote_env)
    }

    /// [`Config::child_env`] over an explicit base environment instead of the process's (tests,
    /// and any caller that already holds a snapshot).
    pub fn child_env_from(
        &self,
        base: impl IntoIterator<Item = (String, String)>,
        manifest_env: &BTreeMap<String, String>,
        remote_env: &BTreeMap<String, String>,
    ) -> BTreeMap<String, String> {
        let mut env: BTreeMap<String, String> = base.into_iter().collect();
        for (source, literals) in [("manifest.env", manifest_env), ("remoteEnv", remote_env)] {
            for (key, value) in literals {
                if manifest_env_key_allowed(key) {
                    env.insert(key.clone(), value.clone());
                } else {
                    tracing::warn!(source, key, "dropping reserved environment literal");
                }
            }
        }
        for key in STRIPPED_CHILD_VARS {
            env.remove(key);
        }
        env.insert("ZS_SUPERVISOR_URL".to_string(), self.supervisor_url());
        env.insert(
            "ZS_CONTROL_SECRET_FILE".to_string(),
            self.control_secret_file().to_string_lossy().into_owned(),
        );
        env.entry("SHELL".to_string())
            .or_insert_with(|| DEFAULT_SHELL.to_string());
        env.entry("USER".to_string())
            .or_insert_with(runtime_user_name);
        env.entry("HOME".to_string())
            .or_insert_with(|| self.home.to_string_lossy().into_owned());
        env.entry("PATH".to_string())
            .or_insert_with(|| DEFAULT_PATH.to_string());
        env.entry("LANG".to_string())
            .or_insert_with(|| DEFAULT_LANG.to_string());
        env
    }
}

/// Prefixes one step down from [`RESERVED_ENV_NAMES`] (b10 §3.1 rule 7): the loader, git and
/// Perl read them, so a repository-controlled `remoteEnv` may not set them either.
pub const DANGEROUS_ENV_PREFIXES: [&str; 3] = ["LD_", "GIT_", "PERL5"];
/// Exact names of the same class (b10 §3.1 rule 7).
pub const DANGEROUS_ENV_NAMES: [&str; 3] = ["NODE_OPTIONS", "PYTHONSTARTUP", "PYTHONPATH"];

/// Whether a `manifest.env`/`remoteEnv` key may reach a child: `ZS_*` keys other than the three
/// identity keys, b9's reserved names and the loader/git/interpreter class of b10 §3.1 rule 7
/// are refused (§3.3). The control plane filters on the way in; this filters on the way out, so
/// an older control plane cannot inject `LD_PRELOAD` into `zed-remote-server`.
pub fn manifest_env_key_allowed(key: &str) -> bool {
    if key.starts_with("ZS_") && !PASSTHROUGH_ZS_VARS.contains(&key) {
        return false;
    }
    if DANGEROUS_ENV_PREFIXES
        .iter()
        .any(|prefix| key.starts_with(prefix))
        || DANGEROUS_ENV_NAMES.contains(&key)
    {
        return false;
    }
    !RESERVED_ENV_NAMES.contains(&key)
}

/// The name of the user `zs-agent` runs as (b10 §3.16): the passwd entry of the current uid, then
/// `/etc/zs/user` (written by the layer fixup of a repo image, whose uid-1000 user may be `node`
/// or `vscode`), then [`DEFAULT_USER`].
pub fn runtime_user_name() -> String {
    let from_uid = nix::unistd::User::from_uid(nix::unistd::getuid())
        .ok()
        .flatten()
        .map(|user| user.name);
    let from_file = std::fs::read_to_string("/etc/zs/user")
        .ok()
        .map(|text| text.trim().to_string());
    resolve_user_name(from_uid, from_file)
}

/// The pure resolution behind [`runtime_user_name`]: uid lookup, then the fixup file, then the default.
pub fn resolve_user_name(from_uid: Option<String>, from_file: Option<String>) -> String {
    from_uid
        .filter(|name| !name.is_empty())
        .or_else(|| from_file.filter(|name| !name.is_empty()))
        .unwrap_or_else(|| DEFAULT_USER.to_string())
}

/// Creates `path` (and parents) with mode `0700` when it does not exist yet.
pub fn ensure_private_dir(path: &Path) -> std::io::Result<()> {
    std::fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(path)
}

fn parse_addr(
    name: &'static str,
    raw: Option<String>,
    default: SocketAddr,
) -> Result<SocketAddr, ConfigError> {
    match raw {
        Some(raw) => raw
            .trim()
            .parse::<SocketAddr>()
            .map_err(|error| ConfigError::Invalid(name, error.to_string())),
        None => Ok(default),
    }
}

fn parse_slots(raw: &str) -> Result<Vec<u16>, ConfigError> {
    let mut slots = Vec::new();
    let mut seen = BTreeSet::new();
    for item in raw.split(',') {
        let item = item.trim();
        if item.is_empty() {
            continue;
        }
        let port: u16 = item
            .parse()
            .map_err(|error| ConfigError::Invalid("ZS_PROXY_SLOTS", format!("{item}: {error}")))?;
        if port == 0 {
            return Err(ConfigError::Invalid("ZS_PROXY_SLOTS", "port 0".to_string()));
        }
        if !seen.insert(port) {
            return Err(ConfigError::Invalid(
                "ZS_PROXY_SLOTS",
                format!("duplicate slot {port}"),
            ));
        }
        slots.push(port);
    }
    if slots.is_empty() {
        return Err(ConfigError::Invalid(
            "ZS_PROXY_SLOTS",
            "no slots".to_string(),
        ));
    }
    Ok(slots)
}

fn is_path_segment(value: &str) -> bool {
    !value.is_empty()
        && value
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
}
