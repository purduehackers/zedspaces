//! Orchestration for `start` (create **and** resume – `resume` is `start --resumed`) and
//! `prebuild` (brief §3.16; D14). Exit codes are in [`BootError`].
//!
//! `start` sequence: pid/run dir + control secret → SIGTERM handlers → listeners 8448 + 8450 and
//! the log shipper up **first** → manifest (fatal exit 3 after a 60 s grace) → JWT keys,
//! forwards, activity relay → restore/clone (exit 4) → `write_settings` → devcontainer parse →
//! `clear_stale_server` → spawn server, `wait_for_server(60 s)` → proxies + port watcher →
//! `ready` → `POST /control/extensions`, `resumed` notice if resumed → dotfiles / postCreate /
//! postStart beside the server with `busy = true` → `forwardPorts` → `first-boot.done` →
//! `phase = ready`. Stop: `status = stopping` → cancel lifecycle task → `stop_child` → log flush →
//! remove pid file and secret → exit 0 (≈ 21 s worst case, inside b9's 25 s).

use std::collections::BTreeMap;
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::sync::{Arc, OnceLock};
use std::time::Duration;

use anyhow::anyhow;
use tokio_util::sync::CancellationToken;

use crate::activity::{ActivityRelay, PostAttach};
use crate::api::ApiDeps;
use crate::bootstrap::{
    self, Cancelled, Markers, extension_install_list, post_create_marker, write_jwt_keys,
};
use crate::config::{Config, ensure_private_dir};
use crate::control_plane::{ControlPlane, ForwardRequest};
use crate::logs::{LogShipper, LogShipperConfig, LogSource};
use crate::manifest::{DevcontainerConfig, Forward, Manifest, Visibility, parse_port_key};
use crate::port_auth::PortTokenCodec;
use crate::ports::{self, ListeningState};
use crate::proxy::{self, ProxyConfig, SessionGuard};
use crate::server::{
    self, LOG_FLUSH_DEADLINE, LifecycleBody, ServerControl, ServerSpec, Supervisor,
};
use crate::state::{AgentState, ForwardsState, HealthStatus, Phase};
use crate::warm;

/// Exit code: success.
pub const EXIT_OK: u8 = 0;
/// Exit code: generic failure.
pub const EXIT_GENERIC: u8 = 1;
/// Exit code: configuration error (incl. `start` under `ZS_PREBUILD=1`).
pub const EXIT_CONFIG: u8 = 2;
/// Exit code: manifest unavailable.
pub const EXIT_MANIFEST: u8 = 3;
/// Exit code: repository materialisation failed.
pub const EXIT_REPO: u8 = 4;

/// How long both listeners stay up after a fatal manifest failure before the process exits 3.
/// Under D21 the public `8448` body is minimal, so the reason is readable only on the loopback
/// API (`runCommand curl 127.0.0.1:8450/health` → `lastError`); b9's `waitUntilReady` keys the
/// fast-fail on the supervisor command's exit code (`docs/contracts/sandbox-api.md`).
pub const MANIFEST_FAILURE_GRACE: Duration = Duration::from_secs(60);
/// Readiness budget for the freshly spawned server; missing it is `degraded`, not fatal.
pub const SERVER_READY_TIMEOUT: Duration = Duration::from_secs(60);
/// Listening-port scan interval (§3.7).
pub const PORT_SCAN_INTERVAL: Duration = Duration::from_secs(2);
/// Backoff (seconds) between attempts to hand a freshly accepting server its extension install
/// list and the `resumed` notice; retried until a 2xx, the next respawn, or shutdown.
pub const SERVER_HOOK_BACKOFF: [u64; 5] = [1, 2, 5, 10, 30];
/// `comm` of the supervisor binary; [`stop_previous_agent`] signals nothing else.
pub const AGENT_COMM: &str = "zs-agent";
/// Poll pause of `zs-agent wait-ready` (D29: bounded polling, never one fixed wait).
pub const WAIT_READY_POLL: Duration = Duration::from_secs(2);
/// How long the lifecycle task gets to notice the shutdown token (and kill its process group)
/// before it is aborted; keeps the whole stop path inside b9's 25 s wait.
pub const LIFECYCLE_CANCEL_GRACE: Duration = Duration::from_secs(1);
/// How long a previous `zs-agent` (a live pid-file holder) gets to leave after `SIGTERM` before
/// this boot goes on and binds the listeners regardless.
pub const PREVIOUS_AGENT_GRACE: Duration = Duration::from_secs(3);
/// File name of the prebuild warm-up public key inside `jwt/` (§3.16a; CONTRACTS §6.2).
pub const WARM_KEY_FILE: &str = "key-warm.pem";

/// `zs-agent start` arguments.
#[derive(clap::Args, Debug, Clone, Default)]
pub struct StartArgs {
    /// This boot resumes a stopped sandbox (`zs-agent resume`; b9 onResume). A hint only – the
    /// first-boot marker decides.
    #[arg(long)]
    pub resumed: bool,
    /// The supervisor runs on a developer machine: the same switch as `ZS_LOCAL=1` (the control
    /// plane's local backend sets the variable; this flag is for running the binary by hand).
    #[arg(long, hide = true)]
    pub local: bool,
}

/// Boot failures that map to a distinct exit code (§3.17).
#[derive(Debug, thiserror::Error)]
pub enum BootError {
    /// Environment or flag problem → exit 2.
    #[error("config: {0}")]
    Config(String),
    /// Manifest could not be fetched or validated → exit 3.
    #[error("manifest: {0}")]
    Manifest(String),
    /// Clone or tarball restore failed → exit 4.
    #[error("repo: {0}")]
    Repo(String),
}

impl BootError {
    /// The process exit code for this failure.
    pub fn exit_code(&self) -> u8 {
        match self {
            BootError::Config(_) => EXIT_CONFIG,
            BootError::Manifest(_) => EXIT_MANIFEST,
            BootError::Repo(_) => EXIT_REPO,
        }
    }
}

/// `zs-agent start` / `zs-agent resume`: refuses to run under `ZS_PREBUILD=1` (exit 2), then the
/// boot sequence described in the module docs.
pub async fn run(args: StartArgs, config: Config) -> anyhow::Result<()> {
    if config.prebuild {
        return Err(
            BootError::Config("ZS_PREBUILD=1 is set; use `zs-agent prebuild`".to_string()).into(),
        );
    }
    let config = Arc::new(config);
    let boot = Boot::start(config, args.resumed).await?;
    boot.run().await
}

/// Everything step 1 brings up, shared by the rest of the boot.
struct Boot {
    config: Arc<Config>,
    state: Arc<AgentState>,
    control: ControlPlane,
    logs: LogShipper,
    logs_handle: crate::logs::LogShipperHandle,
    forwards: ForwardsState,
    listening: ListeningState,
    server_control: ServerControl,
    markers: Markers,
    shutdown: CancellationToken,
    tasks: Vec<tokio::task::JoinHandle<()>>,
    /// Service process groups started beside the server (b10 §3.16), killed in `finish`.
    service_groups: Vec<bootstrap::ChildGroup>,
    resumed: bool,
}

impl Boot {
    /// §3.16 step 1: run directory, control secret, signal handlers, both listeners and the log
    /// shipper – before anything can fail, so `GET /health` answers from the first second. A
    /// listener that cannot be bound is a configuration error (exit 2): a boot whose health
    /// listener is silent would otherwise sit unobservable until b9's 35 min probe gives up.
    async fn start(config: Arc<Config>, resumed_hint: bool) -> anyhow::Result<Self> {
        let control = ControlPlane::new(config.clone())?;
        let (logs, logs_handle) = LogShipper::start(control.clone(), config.build_id.clone());
        crate::logs::init_tracing(Some(&logs));

        ensure_private_dir(&config.state_dir)?;
        let run_dir = config.run_dir();
        stop_previous_agent(&config.pid_file()).await;
        let _ = std::fs::remove_dir_all(&run_dir);
        ensure_private_dir(&run_dir)?;
        std::fs::write(config.pid_file(), std::process::id().to_string())?;
        let control_secret = Supervisor::generate_control_secret();
        Supervisor::write_control_secret(&control_secret, &run_dir)?;

        let shutdown = CancellationToken::new();
        install_signal_handlers(shutdown.clone());

        let state = AgentState::new(config.build_id.clone(), config.region.clone());
        let markers = Markers::new(config.markers_dir());
        // The marker proves a resume; when it is absent the control plane's word (`zs-agent
        // resume`, and later `manifest.session.resumed`) is taken: a first boot that was stopped
        // during a long `postCreateCommand` never got to write the marker, yet the VM that comes
        // back *is* resumed.
        let marker = markers.first_boot_done();
        let resumed = marker || resumed_hint;
        if marker != resumed_hint {
            tracing::info!(
                marker,
                flag = resumed_hint,
                resumed,
                "resume hint and first-boot marker disagree"
            );
        }
        state.update(|inner| {
            inner.resumed = resumed;
            inner.proxy_slots = config.proxy_slots.clone();
        });

        let forwards = ForwardsState::with_slots(&config.proxy_slots);
        let listening = ListeningState::default();
        let server_control = ServerControl::new(
            SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), config.rpc_listen.port()),
            config.server_control_listen,
            control_secret.clone(),
        )?;
        let deps = Arc::new(ApiDeps {
            state: state.clone(),
            control: control.clone(),
            forwards: forwards.clone(),
            listening: listening.clone(),
            control_secret,
            server: OnceLock::new(),
        });
        let _ = deps.server.set(server_control.clone());

        // Bind synchronously: a failure here is reported through the exit code instead of being
        // buried in a spawned task's log line.
        let (health, local) =
            match crate::api::bind(config.health_listen, config.local_api_listen).await {
                Ok(listeners) => listeners,
                Err(error) => {
                    tracing::error!(error = %error, "supervisor listeners failed to bind");
                    let _ = std::fs::remove_file(config.pid_file());
                    let _ = std::fs::remove_file(config.control_secret_file());
                    return Err(BootError::Config(format!("listeners: {error:#}")).into());
                }
            };
        let tasks = vec![tokio::spawn(crate::api::serve_bound(
            health,
            local,
            deps,
            shutdown.clone(),
        ))];

        Ok(Self {
            config,
            state,
            control,
            logs,
            logs_handle,
            forwards,
            listening,
            server_control,
            markers,
            shutdown,
            tasks,
            service_groups: Vec::new(),
            resumed,
        })
    }

    /// Steps 2 to 8.
    async fn run(mut self) -> anyhow::Result<()> {
        let manifest = match self.fetch_manifest().await {
            Ok(manifest) => Arc::new(manifest),
            Err(error) => {
                self.shutdown_tasks().await;
                return Err(error);
            }
        };

        let post_attach: Arc<OnceLock<PostAttach>> = Arc::new(OnceLock::new());
        {
            let relay = ActivityRelay::new(
                self.control.clone(),
                self.server_control.clone(),
                self.state.clone(),
                self.forwards.clone(),
                self.listening.clone(),
                self.config.clone(),
                manifest.clone(),
                self.shutdown.clone(),
                post_attach.clone(),
                self.logs.clone(),
            );
            self.tasks.push(tokio::spawn(relay.run()));
        }

        // Step 3: the checkout, the settings and the devcontainer.
        self.state.set_phase(if manifest.restore.is_some() {
            Phase::Restore
        } else {
            Phase::Clone
        });
        let materialized = bootstrap::materialize_repo(
            &manifest,
            &self.config,
            &self.control,
            &self.logs,
            &self.shutdown,
        )
        .await;
        if let Err(error) = materialized {
            if error.downcast_ref::<Cancelled>().is_some() {
                tracing::info!("stopped during the checkout; nothing was left behind");
                self.finish(None).await;
                return Ok(());
            }
            self.state.set_error(format!("repo: {error}"));
            self.state.set_status(HealthStatus::Degraded);
            self.shutdown_tasks().await;
            return Err(BootError::Repo(error.to_string()).into());
        }
        // The manifest block is authoritative when it says so (D38); else the checkout is parsed.
        let devcontainer =
            match bootstrap::effective_devcontainer(&manifest, &manifest.workspace_dir) {
                Ok(devcontainer) => devcontainer,
                Err(error) => {
                    tracing::warn!(error = %error, "devcontainer.json could not be parsed");
                    self.state.set_error(format!("devcontainer: {error}"));
                    self.state.set_status(HealthStatus::Degraded);
                    None
                }
            };
        let (devcontainer, devcontainer_marker) = match devcontainer {
            Some((config, marker)) => (Some(config), Some(marker)),
            None => (None, None),
        };
        let overlay = devcontainer
            .as_ref()
            .and_then(|config| config.settings_overlay().cloned());
        if let Some(docs) = &manifest.settings
            && let Err(error) =
                bootstrap::write_settings(docs, overlay.as_ref(), &self.config.home, &self.markers)
        {
            tracing::warn!(error = %error, "could not write the workspace settings");
            self.state.set_error(format!("settings: {error}"));
        }
        // `${containerEnv:NAME}` resolves against the process environment plus the manifest's
        // literals (containers.dev semantics); an unknown name expands to the empty string.
        let mut expansion_base: BTreeMap<String, String> = std::env::vars().collect();
        expansion_base.extend(manifest.env.clone());
        let remote_env = devcontainer
            .as_ref()
            .map(|config| config.expand_remote_env(&expansion_base))
            .unwrap_or_default();
        let child_env = self.config.child_env(&manifest.env, &remote_env);
        if let Some(config) = &devcontainer
            && let Some(command) = &config.post_attach_command
        {
            let _ = post_attach.set(PostAttach {
                specs: bootstrap::lifecycle_specs(command, "post_attach"),
                env: child_env.clone(),
            });
        }

        // Step 4: the server, the proxy slots and the port watcher.
        let supervisor = self.spawn_server(&manifest, &child_env, None).await?;
        if self.shutdown.is_cancelled() {
            // SIGTERM (or `stop: true`) arrived while the server was coming up: go straight to
            // the stop sequence instead of starting more work.
            tracing::info!("shutdown requested while the server was starting");
            self.state.set_status(HealthStatus::Stopping);
            self.finish(supervisor).await;
            return Ok(());
        }
        // The checkout is in place and the server exists: from here a snapshot resumes
        // something meaningful, so the next boot is a resume even if this one is stopped in the
        // middle of a 30-minute `postCreateCommand` (the post-create/dotfiles markers keep their
        // own idempotence).
        if let Err(error) = self.markers.set_first_boot_done() {
            tracing::warn!(error = %error, "could not write the first-boot marker");
        }
        self.spawn_proxies(&manifest);
        {
            let server = self.server_control.clone();
            let forwards = self.forwards.clone();
            let listening = self.listening.clone();
            let state = self.state.clone();
            let shutdown = self.shutdown.clone();
            self.tasks.push(tokio::spawn(ports::watch(
                PORT_SCAN_INTERVAL,
                server,
                forwards,
                listening,
                state,
                shutdown,
            )));
        }

        // Step 4b (b10 §3.16, D40): the manifest's services (`dockerd`) beside the server.
        let services = devcontainer
            .as_ref()
            .map(|config| config.services())
            .unwrap_or_default();
        if !services.is_empty() {
            self.state.set_phase(Phase::Services);
            let groups =
                bootstrap::start_services(&services, &self.logs, &self.state, &self.shutdown).await;
            self.service_groups.extend(groups);
        }

        // Step 5: the extension install list and the resume notice, delivered to every server
        // that starts accepting (a respawned `serve` remembers neither).
        let install = extension_install_list(&manifest, devcontainer.as_ref());
        self.spawn_server_hooks(install);

        // Step 6: dotfiles, postCreate, postStart and the devcontainer forwards, beside the server.
        let lifecycle = self.spawn_lifecycle(
            manifest.clone(),
            devcontainer,
            devcontainer_marker,
            child_env,
        );

        // Step 8: wait for SIGTERM or a `stop: true` directive.
        self.shutdown.cancelled().await;
        tracing::info!("shutdown requested");
        self.state.set_status(HealthStatus::Stopping);
        // The lifecycle task watches the same token and `SIGKILL`s its process group when it
        // fires; abort only if it has not noticed within the grace.
        let mut lifecycle = lifecycle;
        if tokio::time::timeout(LIFECYCLE_CANCEL_GRACE, &mut lifecycle)
            .await
            .is_err()
        {
            lifecycle.abort();
        }
        self.finish(supervisor).await;
        Ok(())
    }

    /// §3.16 step 2. A failure keeps the health listener up for [`MANIFEST_FAILURE_GRACE`] so the
    /// control plane's probe reads `lastError` before the process exits 3.
    async fn fetch_manifest(&mut self) -> anyhow::Result<Manifest> {
        self.state.set_phase(Phase::Manifest);
        let mut manifest = match self.control.manifest().await {
            Ok(manifest) => manifest,
            Err(error) => return Err(self.manifest_failed(error.to_string()).await),
        };
        if self.config.local {
            // ZS_LOCAL=1: `/workspaces/<name>` lives under `ZS_WORKSPACES_DIR` on this machine.
            manifest.relocate_workspace_dir(&self.config.workspaces_dir);
        }
        if let Err(error) = manifest.validate(&self.config) {
            return Err(self.manifest_failed(error.to_string()).await);
        }
        // The manifest names the secrets; their values are in this process's environment
        // (inherited by every lifecycle command). Register them so nothing that leaves through
        // the log shipper or stderr carries a value (BUILD-SPEC §10 item 4).
        crate::logs::register_secret_values(
            manifest
                .secret_names
                .iter()
                .filter_map(|name| std::env::var(name).ok()),
        );
        if !self.resumed && manifest.session.resumed {
            tracing::info!("first-boot marker absent; the control plane reports a resume");
            self.resumed = true;
            self.state.update(|inner| inner.resumed = true);
        }
        if manifest.build != self.config.build_id {
            tracing::warn!(
                manifest_build = %manifest.build,
                image_build = %self.config.build_id,
                "build_mismatch"
            );
            self.state.set_error(format!(
                "build_mismatch: manifest {} != image {}",
                manifest.build, self.config.build_id
            ));
            self.state.set_status(HealthStatus::Degraded);
        }
        self.state
            .update(|inner| inner.manifest_build = Some(manifest.build.clone()));
        self.logs.configure(LogShipperConfig {
            flush_interval: Duration::from_secs(manifest.logs.flush_interval_secs.max(1)),
            max_batch: manifest.logs.max_batch,
            max_batch_bytes: manifest.logs.max_batch_bytes,
            workspace_id: manifest.workspace_id.clone(),
            sandbox_name: manifest.sandbox_name.clone(),
            session_id: manifest.session.id.clone(),
            build: self.config.build_id.clone(),
        });
        write_jwt_keys(&manifest.jwt.public_keys, &self.config.jwt_dir())?;
        self.forwards.replace(manifest.forwards.clone());
        tracing::info!(
            workspace = %manifest.workspace_id,
            build = %manifest.build,
            resumed = self.resumed,
            "manifest fetched"
        );
        Ok(manifest)
    }

    /// The status stays `booting` (public body `ok: false`, loopback `lastError`): nothing is
    /// usable, so `degraded` ("usable, with a problem") would be the wrong signal to the probe.
    async fn manifest_failed(&self, reason: String) -> anyhow::Error {
        tracing::error!(reason, "manifest unavailable");
        self.state.set_error(format!("manifest: {reason}"));
        tokio::select! {
            _ = tokio::time::sleep(MANIFEST_FAILURE_GRACE) => {}
            _ = self.shutdown.cancelled() => {}
        }
        BootError::Manifest(reason).into()
    }

    /// §3.16 step 4: clear a leftover server, spawn ours and wait for its `/health`. The
    /// readiness wait races the shutdown token so a `SIGTERM` during a slow start is honoured at
    /// once (b9 waits ≤ 25 s on the stop). `warm_key_pem` (prebuild only) is written as
    /// [`WARM_KEY_FILE`] and passed as one extra `--jwt-public-key`.
    async fn spawn_server(
        &mut self,
        manifest: &Arc<Manifest>,
        child_env: &BTreeMap<String, String>,
        warm_key_pem: Option<&str>,
    ) -> anyhow::Result<Option<Arc<Supervisor>>> {
        self.state.set_phase(Phase::ServerStarting);
        let jwt_dir = self.config.jwt_dir();
        let mut jwt_keys = write_jwt_keys(&manifest.jwt.public_keys, &jwt_dir)?;
        if let Some(pem) = warm_key_pem {
            jwt_keys.push(bootstrap::write_pem_file(
                &jwt_dir.join(WARM_KEY_FILE),
                pem,
            )?);
        }
        let spec = ServerSpec {
            bin: self.config.server_bin.clone(),
            listen: self.config.rpc_listen,
            jwt_key_files: jwt_keys,
            workspace_id: manifest.workspace_id.clone(),
            audience: manifest.jwt.audience.clone(),
            issuer: manifest.jwt.issuer.clone(),
            workspace_root: manifest.workspace_dir.clone(),
            client_build: manifest
                .client_build
                .clone()
                .unwrap_or_else(|| self.config.build_id.clone()),
            allowed_origins: manifest.allowed_origins.clone(),
            control_secret_file: self.config.control_secret_file(),
            control_listen: self.config.server_control_listen,
            supervisor_url: self.config.supervisor_url(),
            port_file: self.config.server_port_file(),
            env: child_env.clone(),
            cwd: manifest.workspace_dir.clone(),
        };
        let supervisor = Arc::new(Supervisor::new(
            spec,
            self.state.clone(),
            self.logs.clone(),
            self.server_control.clone(),
            self.control.clone(),
            self.shutdown.clone(),
        ));
        if let Err(error) = supervisor.clear_stale_server().await {
            tracing::warn!(error = %error, "could not clear a stale server");
        }
        {
            let supervisor = supervisor.clone();
            self.tasks.push(tokio::spawn(async move {
                if let Err(error) = supervisor.run().await {
                    tracing::error!(error = %error, "server supervision stopped");
                }
            }));
        }
        let ready = tokio::select! {
            result = server::wait_for_server(&self.server_control, SERVER_READY_TIMEOUT) => Some(result),
            _ = self.shutdown.cancelled() => None,
        };
        match ready {
            Some(Ok(health)) => {
                tracing::info!(build = %health.build, version = %health.version, "server ready");
                self.state
                    .update(|inner| inner.server_health = Some(health));
                self.state.mark_server_listening();
                if self.state.status() != HealthStatus::Degraded {
                    self.state.set_status(HealthStatus::Ready);
                }
            }
            Some(Err(error)) => {
                tracing::error!(error = %error, "server_not_ready");
                self.state.set_error("server_not_ready");
                self.state.set_status(HealthStatus::Degraded);
            }
            None => {
                tracing::info!("stopped while waiting for the server to answer /health");
            }
        }
        Ok(Some(supervisor))
    }

    /// One cookie-gated proxy per D21 slot, all sharing the manifest's bootstrap key and one
    /// per-boot cookie key.
    fn spawn_proxies(&mut self, manifest: &Arc<Manifest>) {
        if manifest.port_session_secret.is_none() {
            // The control plane mints ES256 port tokens and sends no HMAC secret (M12): the
            // workspace is fully usable without private forwards, so this is not `degraded`.
            tracing::warn!("manifest carries no portSessionSecret; private-port proxies are off");
            self.state.update(|inner| inner.proxy_running = false);
            return;
        }
        let bootstrap = match manifest.port_session_key() {
            Ok(key) => Arc::new(PortTokenCodec::new(key)),
            Err(error) => {
                tracing::error!(error = %error, "portSessionSecret unusable; private forwards are off");
                self.state.set_error("port_session_secret");
                return;
            }
        };
        let cookies = Arc::new(PortTokenCodec::random());
        let sessions = Arc::new(SessionGuard::default());
        let configs: Vec<ProxyConfig> = self
            .config
            .proxy_slots
            .iter()
            .map(|slot| ProxyConfig {
                slot: *slot,
                listen: SocketAddr::new(self.config.proxy_bind_ip, *slot),
                bootstrap: bootstrap.clone(),
                cookies: cookies.clone(),
                workspace_id: manifest.workspace_id.clone(),
                secure_cookies: !self.config.insecure_cookies,
                forwards: self.forwards.clone(),
                listening: self.listening.clone(),
                sessions: sessions.clone(),
            })
            .collect();
        let state = self.state.clone();
        let logs = self.logs.clone();
        let shutdown = self.shutdown.clone();
        self.tasks.push(tokio::spawn(async move {
            if let Err(error) = proxy::run_all(configs, state.clone(), logs, shutdown).await {
                tracing::error!(error = %error, "private-port proxy stopped");
                state.update(|inner| inner.proxy_running = false);
            }
        }));
    }

    /// §3.16 step 5, re-driven for every child: whenever a server starts accepting
    /// (`AgentState::server_up_watch`), it is handed the extension install list (D5; the server
    /// skips ids it already has on disk) and – on a resumed boot – the `resumed` notice, which
    /// b4 holds until a session attaches. Each POST is retried with [`SERVER_HOOK_BACKOFF`]
    /// until a 2xx, the next respawn or shutdown; the notice is sent until its first 2xx and
    /// never again in this boot.
    fn spawn_server_hooks(&mut self, install: Vec<String>) {
        let server = self.server_control.clone();
        let shutdown = self.shutdown.clone();
        let mut server_up = self.state.server_up_watch();
        let mut resumed_pending = self.resumed;
        self.tasks.push(tokio::spawn(async move {
            loop {
                let generation = *server_up.borrow_and_update();
                if let Some(generation) = generation {
                    if !install.is_empty()
                        && deliver_until_acked(
                            "extension install list",
                            generation,
                            &mut server_up,
                            &shutdown,
                            || server.post_extensions(&install),
                        )
                        .await
                    {
                        tracing::info!(count = install.len(), "extension install list handed over");
                    }
                    if resumed_pending
                        && deliver_until_acked(
                            "resumed notice",
                            generation,
                            &mut server_up,
                            &shutdown,
                            || server.post_lifecycle(&RESUMED),
                        )
                        .await
                    {
                        tracing::info!("resumed notice delivered");
                        resumed_pending = false;
                    }
                }
                tokio::select! {
                    _ = shutdown.cancelled() => return,
                    changed = server_up.changed() => {
                        if changed.is_err() {
                            return;
                        }
                    }
                }
            }
        }));
    }

    /// §3.16 step 6, beside the running server: dotfiles, `postCreateCommand` (once per
    /// devcontainer hash), `postStartCommand` (every boot), the devcontainer's `forwardPorts`,
    /// then `first-boot.done` and `phase = ready`.
    fn spawn_lifecycle(
        &self,
        manifest: Arc<Manifest>,
        devcontainer: Option<DevcontainerConfig>,
        devcontainer_marker: Option<String>,
        env: BTreeMap<String, String>,
    ) -> tokio::task::JoinHandle<()> {
        let config = self.config.clone();
        let state = self.state.clone();
        let logs = self.logs.clone();
        let control = self.control.clone();
        let forwards = self.forwards.clone();
        let markers = Markers::new(self.config.markers_dir());
        let shutdown = self.shutdown.clone();
        tokio::spawn(async move {
            if let Some(spec) = &manifest.dotfiles {
                state.set_phase(Phase::Dotfiles);
                if markers.dotfiles_done().as_deref() == Some(spec.repo_url.as_str()) {
                    tracing::info!("dotfiles already installed");
                } else {
                    let busy = state.busy_guard();
                    let result = bootstrap::install_dotfiles(spec, &config, &logs, &shutdown).await;
                    drop(busy);
                    match result {
                        Ok(()) => {
                            if let Err(error) = markers.set_dotfiles_done(&spec.repo_url) {
                                tracing::warn!(error = %error, "could not write the dotfiles marker");
                            }
                        }
                        Err(error) => {
                            tracing::warn!(error = %error, "dotfiles installation failed");
                            state.set_error(format!("dotfiles: {error}"));
                        }
                    }
                }
            }
            if shutdown.is_cancelled() {
                return;
            }

            // D37: onCreate → updateContent → postCreate share the 30-minute budget and one marker.
            let marker = devcontainer_marker.unwrap_or_else(|| post_create_marker(None));
            let stages = devcontainer
                .as_ref()
                .map(bootstrap::post_create_stages)
                .unwrap_or_default();
            if markers.needs_post_create(&marker) {
                state.set_phase(Phase::PostCreate);
                if !stages.is_empty() {
                    let result = bootstrap::run_lifecycle_sequence(
                        stages,
                        &manifest.workspace_dir,
                        &env,
                        bootstrap::POST_CREATE_TIMEOUT,
                        LogSource::PostCreate,
                        &logs,
                        &state,
                        &shutdown,
                    )
                    .await;
                    match result {
                        Ok(()) => {
                            if let Err(error) = markers.set_post_create_done(&marker) {
                                tracing::warn!(error = %error, "could not write the post-create marker");
                            }
                        }
                        Err(error) => {
                            tracing::error!(error = %error, "postCreateCommand failed");
                            state.set_error(format!("post_create: {error}"));
                            state.set_status(HealthStatus::Degraded);
                        }
                    }
                } else if let Err(error) = markers.set_post_create_done(&marker) {
                    tracing::warn!(error = %error, "could not write the post-create marker");
                }
            }
            if shutdown.is_cancelled() {
                return;
            }

            if let Some(command) = devcontainer
                .as_ref()
                .and_then(|config| config.post_start_command.clone())
            {
                state.set_phase(Phase::PostStart);
                let specs = bootstrap::lifecycle_specs(&command, "post_start");
                if let Err(error) = bootstrap::run_lifecycle(
                    specs,
                    &manifest.workspace_dir,
                    &env,
                    bootstrap::POST_START_TIMEOUT,
                    LogSource::PostStart,
                    &logs,
                    &state,
                    &shutdown,
                )
                .await
                {
                    tracing::warn!(error = %error, "postStartCommand failed");
                    state.set_error(format!("post_start: {error}"));
                }
            }
            if shutdown.is_cancelled() {
                return;
            }

            if let Some(devcontainer) = &devcontainer {
                request_devcontainer_forwards(devcontainer, &control, &forwards).await;
            }
            // `busy` is a counted guard now: a postAttach still running keeps it up.
            state.set_phase(Phase::Ready);
            if state.status() == HealthStatus::Booting {
                state.set_status(HealthStatus::Ready);
            }
            tracing::info!("workspace ready");
        })
    }

    /// §3.16 step 8: stop the server, flush the logs and clear the run directory.
    ///
    /// The shutdown token is cancelled **before** the child is stopped: `Supervisor::run` reads
    /// it when the child exits to tell a deliberate stop from a crash, so cancelling it later
    /// (the prebuild's normal exit, a `postCreateCommand` failure) would ship a bogus
    /// `server_crash` report, bump `restarts` and race a respawn against the task abort.
    async fn finish(mut self, supervisor: Option<Arc<Supervisor>>) {
        self.state.set_status(HealthStatus::Stopping);
        self.shutdown.cancel();
        if let Some(supervisor) = supervisor
            && let Err(error) = supervisor.stop_child().await
        {
            tracing::warn!(error = %error, "stopping the server failed");
        }
        for task in std::mem::take(&mut self.tasks) {
            task.abort();
        }
        // The service process groups (`dockerd`) go with the lifecycle task (b10 §3.16).
        for group in std::mem::take(&mut self.service_groups) {
            tracing::info!(service = group.name, pid = group.pid, "stopping service");
            group.kill().await;
        }
        self.logs.push(crate::logs::LogEntry {
            ts: crate::logs::now_ms(),
            level: "info",
            source: LogSource::Agent.as_str().to_string(),
            msg: "shutdown complete".to_string(),
            fields: None,
        });
        self.logs_handle.flush(LOG_FLUSH_DEADLINE).await;
        let _ = std::fs::remove_file(self.config.pid_file());
        let _ = std::fs::remove_file(self.config.control_secret_file());
        tracing::info!("zs-agent stopped");
    }

    /// Tears the boot down on a fatal error (no server was started).
    async fn shutdown_tasks(self) {
        self.finish(None).await;
    }
}

/// Requests a forward for every `devcontainer.forwardPorts` entry that is not forwarded yet, using
/// `portsAttributes` for the label and visibility (private by default; a refused private forward –
/// no free slot – is logged, not fatal).
async fn request_devcontainer_forwards(
    devcontainer: &DevcontainerConfig,
    control: &ControlPlane,
    forwards: &ForwardsState,
) {
    let known: Vec<u16> = forwards
        .current()
        .into_iter()
        .map(|forward| forward.port)
        .collect();
    for port in &devcontainer.forward_ports {
        if known.contains(port) || ports::is_infra_port(*port) {
            continue;
        }
        // `portsAttributes[port]`, then `otherPortsAttributes`, then (no label, private).
        let attributes = devcontainer
            .ports_attributes
            .iter()
            .find(|(key, _)| parse_port_key(key) == Some(*port))
            .map(|(_, attributes)| attributes)
            .or(devcontainer.other_ports_attributes.as_ref());
        let visibility = attributes
            .and_then(|attributes| attributes.visibility)
            .unwrap_or(Visibility::Private);
        let label = attributes.and_then(|attributes| attributes.label.clone());
        match control
            .forward(ForwardRequest {
                port: *port,
                visibility,
                label: label.as_deref(),
            })
            .await
        {
            Ok(response) => forwards.insert(Forward {
                port: *port,
                visibility: response.visibility,
                label,
                url: response.url,
                slot: response.slot,
            }),
            Err(error) => {
                tracing::warn!(port, error = %error, "devcontainer forwardPorts entry refused");
            }
        }
    }
}

/// A live `zs-agent` named by the pid file (a previous instance that was never stopped) is
/// asked to leave with `SIGTERM` and given [`PREVIOUS_AGENT_GRACE`]; otherwise its listeners
/// would keep this boot from binding 8448/8450. A dead pid is ignored, and so is a live one
/// that is not a `zs-agent` (`comm` check) or that is this process or its parent: after an
/// unclean stop the file survives into the snapshot, pids restart low on resume, and the number
/// can belong to anything – including the `sh -c` that launched this very boot.
async fn stop_previous_agent(pid_file: &std::path::Path) {
    let Ok(raw) = std::fs::read_to_string(pid_file) else {
        return;
    };
    let Ok(pid) = raw.trim().parse::<i32>() else {
        return;
    };
    if pid <= 1 || pid as u32 == std::process::id() || pid == nix::unistd::getppid().as_raw() {
        return;
    }
    let target = nix::unistd::Pid::from_raw(pid);
    if nix::sys::signal::kill(target, None).is_err() {
        return;
    }
    let comm = crate::ports::process_name(pid as u32);
    if comm != AGENT_COMM {
        tracing::warn!(
            pid,
            comm = %comm,
            "stale pid file names a process that is not zs-agent; leaving it alone"
        );
        return;
    }
    tracing::warn!(
        pid,
        "a previous zs-agent is still running; asking it to stop"
    );
    let _ = nix::sys::signal::kill(target, nix::sys::signal::Signal::SIGTERM);
    let deadline = std::time::Instant::now() + PREVIOUS_AGENT_GRACE;
    while std::time::Instant::now() < deadline {
        if nix::sys::signal::kill(target, None).is_err() {
            tracing::info!(pid, "previous zs-agent exited");
            return;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    tracing::warn!(pid, "previous zs-agent did not exit in time; continuing");
}

/// The `resumed` notice body (a `'static` for the hook closure).
const RESUMED: LifecycleBody = LifecycleBody::Resumed;

/// Retries `attempt` with [`SERVER_HOOK_BACKOFF`] until it succeeds (`true`), or until the
/// server generation moves on / shutdown fires (`false`; the caller re-reads the watch).
async fn deliver_until_acked<Fut>(
    what: &str,
    generation: u64,
    server_up: &mut tokio::sync::watch::Receiver<Option<u64>>,
    shutdown: &CancellationToken,
    mut attempt: impl FnMut() -> Fut,
) -> bool
where
    Fut: std::future::Future<Output = anyhow::Result<()>>,
{
    let mut tries = 0usize;
    loop {
        match attempt().await {
            Ok(()) => return true,
            Err(error) => {
                if tries == 0 {
                    tracing::warn!(error = %error, what, "hand-off to the server failed; retrying");
                } else {
                    tracing::debug!(error = %error, what, tries, "hand-off to the server failed; retrying");
                }
            }
        }
        let pause = SERVER_HOOK_BACKOFF[tries.min(SERVER_HOOK_BACKOFF.len() - 1)];
        tries += 1;
        tokio::select! {
            _ = shutdown.cancelled() => return false,
            _ = tokio::time::sleep(Duration::from_secs(pause)) => {}
            changed = server_up.changed() => {
                if changed.is_err() || *server_up.borrow() != Some(generation) {
                    return false;
                }
            }
        }
    }
}

/// `SIGTERM` (b9's stop) and `SIGINT` (a terminal) both fire the shutdown token once.
fn install_signal_handlers(shutdown: CancellationToken) {
    tokio::spawn(async move {
        let mut term =
            match tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
                Ok(signal) => signal,
                Err(error) => {
                    tracing::error!(error = %error, "cannot install the SIGTERM handler");
                    return;
                }
            };
        let mut interrupt =
            match tokio::signal::unix::signal(tokio::signal::unix::SignalKind::interrupt()) {
                Ok(signal) => signal,
                Err(error) => {
                    tracing::error!(error = %error, "cannot install the SIGINT handler");
                    return;
                }
            };
        tokio::select! {
            _ = term.recv() => tracing::info!("SIGTERM received"),
            _ = interrupt.recv() => tracing::info!("SIGINT received"),
        }
        shutdown.cancel();
    });
}

/// `zs-agent prebuild` (D14): requires `ZS_PREBUILD=1`; manifest, clone, server with the
/// ephemeral warm-up key, `POST /control/extensions`, `postCreateCommand`, `warm::run` with
/// `min(15 min, 48 min − elapsed)`, optional `ZS_PREBUILD_WARM_CMD`, `stop_child`, log flush,
/// exit 0 (non-zero on manifest/clone/postCreate failure; warm-up failures are logged only).
pub async fn run_prebuild(config: Config) -> anyhow::Result<()> {
    if !config.prebuild {
        return Err(BootError::Config("prebuild requires ZS_PREBUILD=1".to_string()).into());
    }
    let config = Arc::new(config);
    let boot = Boot::start(config, false).await?;
    boot.run_prebuild().await
}

/// Whole-prebuild budget the warm-up must fit inside; the control plane gives up at 50 min
/// (b9 §4.8), so everything after `postCreateCommand` is capped at 48 min from boot.
pub const PREBUILD_TOTAL_BUDGET: Duration = Duration::from_secs(48 * 60);
/// Shell command run after the language-server warm-up (`repos.prebuild_warm_command`).
pub const PREBUILD_WARM_CMD_VAR: &str = "ZS_PREBUILD_WARM_CMD";

impl Boot {
    /// The prebuild boot (§3.16 "prebuild sequence"; D14). Steps 1-3 are the same as `start`
    /// minus the dotfiles and the activity relay (`idleStopAt` is null for prebuilds and nothing
    /// consumes the pings); then the server comes up trusting one extra, ephemeral warm-up key,
    /// the extension install list and `postCreateCommand` populate the disk, the headless warm-up
    /// starts (and downloads) every language server into `languages_dir()`, the optional
    /// `ZS_PREBUILD_WARM_CMD` runs with whatever budget is left, and the process exits 0 so the
    /// control plane can snapshot. Warm-up failures are logged, never fatal.
    async fn run_prebuild(mut self) -> anyhow::Result<()> {
        let started = std::time::Instant::now();
        let manifest = match self.fetch_manifest().await {
            Ok(manifest) => Arc::new(manifest),
            Err(error) => {
                self.shutdown_tasks().await;
                return Err(error);
            }
        };
        tracing::info!(
            prebuild = ?manifest.prebuild.as_ref().map(|spec| &spec.id),
            "prebuild boot"
        );

        // Step 3: the checkout, the settings and the devcontainer.
        self.state.set_phase(if manifest.restore.is_some() {
            Phase::Restore
        } else {
            Phase::Clone
        });
        let materialized = bootstrap::materialize_repo(
            &manifest,
            &self.config,
            &self.control,
            &self.logs,
            &self.shutdown,
        )
        .await;
        if let Err(error) = materialized {
            if error.downcast_ref::<Cancelled>().is_some() {
                self.finish(None).await;
                return Ok(());
            }
            self.state.set_error(format!("repo: {error}"));
            self.state.set_status(HealthStatus::Degraded);
            self.shutdown_tasks().await;
            return Err(BootError::Repo(error.to_string()).into());
        }
        let (devcontainer, devcontainer_marker) =
            match bootstrap::effective_devcontainer(&manifest, &manifest.workspace_dir) {
                Ok(Some((config, marker))) => (Some(config), Some(marker)),
                Ok(None) => (None, None),
                Err(error) => {
                    tracing::warn!(error = %error, "devcontainer.json could not be parsed");
                    self.state.set_error(format!("devcontainer: {error}"));
                    (None, None)
                }
            };
        let overlay = devcontainer
            .as_ref()
            .and_then(|config| config.settings_overlay().cloned());
        if let Some(docs) = &manifest.settings
            && let Err(error) =
                bootstrap::write_settings(docs, overlay.as_ref(), &self.config.home, &self.markers)
        {
            tracing::warn!(error = %error, "could not write the workspace settings");
        }
        let remote_env = devcontainer
            .as_ref()
            .map(|config| config.expand_remote_env(&manifest.env))
            .unwrap_or_default();
        let child_env = self.config.child_env(&manifest.env, &remote_env);

        // Step 4: the server, trusting the manifest's keys **plus** the warm-up's ephemeral key
        // (`jwt/key-warm.pem`, one extra `--jwt-public-key`); the private half never leaves this
        // process.
        let warm_key = warm::generate_warm_key()?;
        let supervisor = self
            .spawn_server(&manifest, &child_env, Some(&warm_key.public_pem))
            .await?;
        if self.shutdown.is_cancelled() {
            self.finish(supervisor).await;
            return Ok(());
        }

        // Step 5: the extensions land in the snapshot (b4 §3.15 item 7), so this is awaited
        // rather than spawned.
        let install = extension_install_list(&manifest, devcontainer.as_ref());
        if !install.is_empty() {
            match self.server_control.post_extensions(&install).await {
                Ok(()) => tracing::info!(count = install.len(), "extensions requested"),
                Err(error) => tracing::warn!(error = %error, "extension hand-off failed"),
            }
        }

        // Step 6: the post-create sequence (D37), once per devcontainer hash. A failure fails the prebuild.
        if !self.shutdown.is_cancelled() {
            let marker = devcontainer_marker
                .clone()
                .unwrap_or_else(|| post_create_marker(None));
            if self.markers.needs_post_create(&marker) {
                self.state.set_phase(Phase::PostCreate);
                let stages = devcontainer
                    .as_ref()
                    .map(bootstrap::post_create_stages)
                    .unwrap_or_default();
                if !stages.is_empty() {
                    if let Err(error) = bootstrap::run_lifecycle_sequence(
                        stages,
                        &manifest.workspace_dir,
                        &child_env,
                        bootstrap::POST_CREATE_TIMEOUT,
                        LogSource::PostCreate,
                        &self.logs,
                        &self.state,
                        &self.shutdown,
                    )
                    .await
                    {
                        tracing::error!(error = %error, "postCreateCommand failed");
                        self.state.set_error(format!("post_create: {error}"));
                        self.state.set_status(HealthStatus::Degraded);
                        self.finish(supervisor).await;
                        return Err(anyhow!("postCreateCommand failed: {error}"));
                    }
                }
                if let Err(error) = self.markers.set_post_create_done(&marker) {
                    tracing::warn!(error = %error, "could not write the post-create marker");
                }
            }
        }

        // Step 7: the headless warm-up, then the optional warm command, inside what is left of
        // the 48 min budget (D14; §3.16a).
        if !self.shutdown.is_cancelled() {
            let budget = prebuild_remaining(started).min(warm::WARM_BUDGET_MAX);
            if budget.is_zero() {
                tracing::warn!("no budget left for the language-server warm-up");
            } else {
                match warm::run(
                    &self.config,
                    &manifest,
                    &warm_key,
                    budget,
                    &self.logs,
                    &self.state,
                    &self.shutdown,
                )
                .await
                {
                    Ok(outcome) => tracing::info!(
                        files = outcome.files_opened,
                        servers = outcome.servers_seen.len(),
                        settled = outcome.settled,
                        secs = outcome.elapsed.as_secs(),
                        "language-server warm-up finished"
                    ),
                    // A warm-up that cannot connect costs a colder snapshot, not the prebuild.
                    Err(error) => {
                        tracing::warn!(error = %error, "language-server warm-up failed");
                        self.state.set_error(format!("warm: {error}"));
                    }
                }
            }
        }
        // `ZS_PREBUILD_WARM_CMD`, falling back to `customizations.zed.prebuild.command` (b10 §3.16;
        // the control plane already resolves this server-side, the fallback keeps an older one working).
        let warm_command = std::env::var(PREBUILD_WARM_CMD_VAR)
            .ok()
            .filter(|command| !command.trim().is_empty())
            .or_else(|| {
                manifest
                    .devcontainer
                    .as_ref()
                    .and_then(|spec| spec.zed.prebuild.as_ref())
                    .and_then(|hints| hints.command.clone())
                    .filter(|command| !command.trim().is_empty())
            });
        if !self.shutdown.is_cancelled()
            && let Some(command) = warm_command
        {
            let remaining = prebuild_remaining(started);
            if remaining.is_zero() {
                tracing::warn!("no budget left for {PREBUILD_WARM_CMD_VAR}");
            } else {
                let specs = bootstrap::lifecycle_specs(
                    &crate::manifest::LifecycleCommand::Shell(command),
                    "prebuild_warm",
                );
                if let Err(error) = bootstrap::run_lifecycle(
                    specs,
                    &manifest.workspace_dir,
                    &child_env,
                    remaining,
                    LogSource::Prebuild,
                    &self.logs,
                    &self.state,
                    &self.shutdown,
                )
                .await
                {
                    tracing::warn!(error = %error, "{PREBUILD_WARM_CMD_VAR} failed");
                    self.state.set_error(format!("prebuild_warm: {error}"));
                }
            }
        }

        // Step 8: the warm-up key is per boot; nothing of it may reach the snapshot.
        let warm_key_file = self.config.jwt_dir().join(WARM_KEY_FILE);
        if let Err(error) = std::fs::remove_file(&warm_key_file)
            && error.kind() != std::io::ErrorKind::NotFound
        {
            tracing::warn!(error = %error, path = %warm_key_file.display(), "could not remove the warm-up key");
        }
        self.state.set_phase(Phase::Ready);
        self.finish(supervisor).await;
        Ok(())
    }
}

/// Time left of [`PREBUILD_TOTAL_BUDGET`] since the boot started.
fn prebuild_remaining(started: std::time::Instant) -> Duration {
    PREBUILD_TOTAL_BUDGET.saturating_sub(started.elapsed())
}

/// `zs-agent stop`: `SIGTERM` the pid-file process and wait ≤ `timeout` for it to exit.
pub async fn stop(config: &Config, timeout: Duration) -> anyhow::Result<()> {
    let path = config.pid_file();
    let raw =
        std::fs::read_to_string(&path).map_err(|error| anyhow!("{}: {error}", path.display()))?;
    let pid: i32 = raw
        .trim()
        .parse()
        .map_err(|error| anyhow!("{}: {error}", path.display()))?;
    let target = nix::unistd::Pid::from_raw(pid);
    nix::sys::signal::kill(target, nix::sys::signal::Signal::SIGTERM)
        .map_err(|error| anyhow!("kill {pid}: {error}"))?;
    let deadline = std::time::Instant::now() + timeout;
    while std::time::Instant::now() < deadline {
        if nix::sys::signal::kill(target, None).is_err() {
            return Ok(());
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    Err(anyhow!("agent {pid} did not exit within {timeout:?}"))
}

/// `zs-agent wait-ready`: poll the health listener (bounded polling with 2 s pauses, D29)
/// until `status ∈ {ready, degraded (if allowed)}` and `phase == ready`; `Ok(true)` when ready,
/// `Ok(false)` on timeout.
pub async fn wait_ready(
    config: &Config,
    timeout: Duration,
    allow_degraded: bool,
) -> anyhow::Result<bool> {
    let url = format!(
        "http://{}:{}/health",
        if config.health_listen.ip().is_unspecified() {
            IpAddr::V4(Ipv4Addr::LOCALHOST)
        } else {
            config.health_listen.ip()
        },
        config.health_listen.port()
    );
    let client = reqwest::Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(5))
        .build()?;
    let deadline = std::time::Instant::now() + timeout;
    loop {
        if let Ok(response) = client.get(&url).send().await
            && let Ok(body) = response.json::<serde_json::Value>().await
        {
            let phase = body["phase"].as_str().unwrap_or_default();
            let ready = match body["status"].as_str() {
                Some("ready") => true,
                Some("degraded") => allow_degraded,
                // The public listener answers the minimal D21 body, which has `ok` instead.
                None => body["ok"].as_bool().unwrap_or(false),
                _ => false,
            };
            if ready && phase == "ready" {
                return Ok(true);
            }
        }
        if std::time::Instant::now() + WAIT_READY_POLL >= deadline {
            return Ok(false);
        }
        tokio::time::sleep(WAIT_READY_POLL).await;
    }
}
