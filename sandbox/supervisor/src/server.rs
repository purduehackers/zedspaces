//! Spawns and supervises `zed-remote-server serve` (brief §3.9; D5, D18, D21, D28).
//!
//! Generates the control secret and writes it to `run/control.secret` (the only place it exists,
//! D18); client for the server's `/control/*` (loopback control listener, `127.0.0.1:8451` under
//! D21) and `/health` (public listener, `127.0.0.1:8443`).

use std::collections::{BTreeMap, VecDeque};
use std::io::Write as _;
use std::net::SocketAddr;
use std::os::unix::fs::OpenOptionsExt as _;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;
use std::sync::atomic::{AtomicU32, Ordering};
use std::time::{Duration, Instant};

use anyhow::bail;
use nix::sys::signal::{self, Signal};
use nix::unistd::Pid;
use parking_lot::Mutex;
use rand::RngCore as _;
use secrecy::{ExposeSecret as _, SecretString};
use tokio_util::sync::CancellationToken;

use crate::control_plane::{ClientErrorReport, ControlPlane};
use crate::logs::{LogShipper, LogSource};
use crate::manifest::{Forward, Visibility};
use crate::ports::ListeningPort;
use crate::state::{AgentState, HealthStatus, ServerHealth};

/// Respawn backoff in seconds; resets after 60 s of stable running.
pub const RESTART_BACKOFF: [u64; 6] = [1, 2, 4, 8, 16, 30];
/// 6 exits inside 10 min → stop respawning, `degraded`, `lastError = "server_crash_loop"`.
pub const CRASH_LOOP_LIMIT: (u32, Duration) = (6, Duration::from_secs(600));
/// Stderr lines kept for the crash report.
pub const CRASH_TAIL_LINES: usize = 200;
/// Ceiling on the crash tail shipped to `POST /client-errors` (b9 accepts ≤ 64 KiB).
pub const CRASH_TAIL_BYTES: usize = 64 * 1024;
/// How long [`Supervisor::clear_stale_server`] waits for a killed listener's port to free.
pub const STALE_PORT_GRACE: Duration = Duration::from_secs(2);
/// D18: exceeds b4's `STOPPING_FLUSH_TIMEOUT` (5 s) so the client's `SaveClientState` gets its
/// full window.
pub const STOPPING_POST_TIMEOUT: Duration = Duration::from_secs(7);
/// Wait after `SIGTERM` before the process-group `SIGKILL`; the whole stop path fits b9's 25 s.
pub const TERM_GRACE: Duration = Duration::from_secs(10);
/// Final log flush budget on shutdown.
pub const LOG_FLUSH_DEADLINE: Duration = Duration::from_secs(3);
/// Request timeout for `GET /health` on the server's public listener.
pub const HEALTH_TIMEOUT: Duration = Duration::from_secs(3);
/// Request timeout for `/control/ports` and `/control/extensions`.
pub const CONTROL_TIMEOUT: Duration = Duration::from_secs(3);
/// A child that stayed up this long resets the respawn backoff.
pub const STABLE_AFTER: Duration = Duration::from_secs(60);
/// Poll pause while waiting for a child to exit or a port to free.
pub const REAP_POLL: Duration = Duration::from_millis(100);
/// Longest pause between `GET /health` probes in [`wait_for_server`] (D29: bounded polling).
pub const READY_POLL_MAX: Duration = Duration::from_secs(2);
/// File name of the control secret inside `run/`.
pub const CONTROL_SECRET_FILE_NAME: &str = "control.secret";

/// Everything needed to build the `serve` command line and environment.
pub struct ServerSpec {
    /// `zed-remote-server` path.
    pub bin: PathBuf,
    /// `--listen` (default `0.0.0.0:8443`).
    pub listen: SocketAddr,
    /// Materialized `manifest.jwt.publicKeys`.
    pub jwt_key_files: Vec<PathBuf>,
    /// `--workspace-id`.
    pub workspace_id: String,
    /// `--audience` (`manifest.jwt.audience`).
    pub audience: String,
    /// `--issuer` (`manifest.jwt.issuer`).
    pub issuer: String,
    /// `--workspace-root` (`manifest.workspaceDir`).
    pub workspace_root: PathBuf,
    /// `--client-build` (`ZS_BUILD_ID`).
    pub client_build: String,
    /// `manifest.allowedOrigins` → one `--allowed-origin` each (D5).
    pub allowed_origins: Vec<String>,
    /// `run/control.secret` (D5/D18).
    pub control_secret_file: PathBuf,
    /// `--control-listen` (`127.0.0.1:8451`, D21).
    pub control_listen: SocketAddr,
    /// `--supervisor-url` (`http://127.0.0.1:8450`; also exported as `ZS_SUPERVISOR_URL`).
    pub supervisor_url: String,
    /// `--port-file`.
    pub port_file: PathBuf,
    /// Complete child environment (`Config::child_env`); NO `ZS_CONTROL_SECRET` (D18).
    pub env: BTreeMap<String, String>,
    /// Working directory (`workspace_root`).
    pub cwd: PathBuf,
}

impl ServerSpec {
    /// Exactly: `<bin> serve --listen <listen> --jwt-public-key <f>… --workspace-id <ws>
    /// --audience <aud> --issuer <iss> --workspace-root <root> --client-build <build>
    /// --allowed-origin <o>… --control-secret-file <run/control.secret> --control-listen
    /// 127.0.0.1:8451 --supervisor-url http://127.0.0.1:8450 --port-file <pf>` (b2 §3.9
    /// `ServeArgs`; D5/D18/D21). Stdin null, stdout and stderr piped, own process group,
    /// `kill_on_drop(false)`, environment replaced by `env`.
    pub fn command(&self) -> tokio::process::Command {
        let mut command = tokio::process::Command::new(&self.bin);
        command.args(self.argv());
        command
            .env_clear()
            .envs(&self.env)
            .current_dir(&self.cwd)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .process_group(0)
            .kill_on_drop(false);
        command
    }

    /// The arguments after the binary, in order (for tests and logging).
    pub fn argv(&self) -> Vec<String> {
        let mut argv = vec![
            "serve".to_string(),
            "--listen".to_string(),
            self.listen.to_string(),
        ];
        for key in &self.jwt_key_files {
            argv.push("--jwt-public-key".to_string());
            argv.push(key.to_string_lossy().into_owned());
        }
        argv.extend([
            "--workspace-id".to_string(),
            self.workspace_id.clone(),
            "--audience".to_string(),
            self.audience.clone(),
            "--issuer".to_string(),
            self.issuer.clone(),
            "--workspace-root".to_string(),
            self.workspace_root.to_string_lossy().into_owned(),
            "--client-build".to_string(),
            self.client_build.clone(),
        ]);
        for origin in &self.allowed_origins {
            argv.push("--allowed-origin".to_string());
            argv.push(origin.clone());
        }
        argv.extend([
            "--control-secret-file".to_string(),
            self.control_secret_file.to_string_lossy().into_owned(),
            "--control-listen".to_string(),
            self.control_listen.to_string(),
            "--supervisor-url".to_string(),
            self.supervisor_url.clone(),
            "--port-file".to_string(),
            self.port_file.to_string_lossy().into_owned(),
        ]);
        argv
    }
}

/// Client for the server's loopback listeners; cheap to clone.
#[derive(Clone)]
pub struct ServerControl {
    http: reqwest::Client,
    health_base: String,
    control_base: String,
    secret: SecretString,
}

impl ServerControl {
    /// `health_addr` is the public listener (`127.0.0.1:8443`), `control_addr` the control
    /// listener (`127.0.0.1:8451`); `secret` is the bearer for `/control/*`. The client bypasses
    /// any proxy and never leaves loopback.
    pub fn new(
        health_addr: SocketAddr,
        control_addr: SocketAddr,
        secret: SecretString,
    ) -> anyhow::Result<Self> {
        let http = reqwest::Client::builder()
            .no_proxy()
            .connect_timeout(Duration::from_secs(2))
            .build()?;
        Ok(Self {
            http,
            health_base: format!("http://{health_addr}"),
            control_base: format!("http://{control_addr}"),
            secret,
        })
    }

    /// `http://127.0.0.1:8443`.
    pub fn health_base(&self) -> &str {
        &self.health_base
    }

    /// `http://127.0.0.1:8451`.
    pub fn control_base(&self) -> &str {
        &self.control_base
    }

    /// `GET {health_base}/health` (loopback → full body).
    pub async fn health(&self) -> anyhow::Result<ServerHealth> {
        let response = self
            .http
            .get(format!("{}/health", self.health_base))
            .timeout(HEALTH_TIMEOUT)
            .send()
            .await?;
        let status = response.status();
        if !status.is_success() {
            bail!("server /health returned {}", status.as_u16());
        }
        Ok(response.json::<ServerHealth>().await?)
    }

    /// `POST {control_base}/control/lifecycle`, expects 204; request timeout
    /// [`STOPPING_POST_TIMEOUT`] for `Stopping`, 3 s otherwise.
    pub async fn post_lifecycle(&self, body: &LifecycleBody) -> anyhow::Result<()> {
        let timeout = match body {
            LifecycleBody::Stopping => STOPPING_POST_TIMEOUT,
            _ => CONTROL_TIMEOUT,
        };
        self.post("control/lifecycle", body, timeout).await
    }

    /// `POST {control_base}/control/ports` with [`PortsBody`], expects 204.
    pub async fn post_ports(
        &self,
        ports: &[ListeningPort],
        forwards: &[Forward],
    ) -> anyhow::Result<()> {
        let body = PortsBody {
            ports,
            forwards: forwards.iter().map(PortForwardWire::from).collect(),
        };
        self.post("control/ports", &body, CONTROL_TIMEOUT).await
    }

    /// `POST {control_base}/control/extensions {"install": [...]}`, expects 204 (D5; b4 §4.2).
    pub async fn post_extensions(&self, install: &[String]) -> anyhow::Result<()> {
        self.post(
            "control/extensions",
            &ExtensionsBody { install },
            CONTROL_TIMEOUT,
        )
        .await
    }

    /// One authenticated POST to the control listener; any 2xx is success.
    async fn post<T: serde::Serialize + ?Sized>(
        &self,
        path: &str,
        body: &T,
        timeout: Duration,
    ) -> anyhow::Result<()> {
        let response = self
            .http
            .post(format!("{}/{path}", self.control_base))
            .bearer_auth(self.secret.expose_secret())
            .timeout(timeout)
            .json(body)
            .send()
            .await?;
        let status = response.status();
        if !status.is_success() {
            let detail = response.text().await.unwrap_or_default();
            bail!("{path} returned {}: {detail}", status.as_u16());
        }
        Ok(())
    }

    /// The bearer presented on `/control/*`.
    pub fn bearer(&self) -> &str {
        self.secret.expose_secret()
    }
}

/// `POST /control/lifecycle` body; mirrors b4 §3.10 (D29 snake_case kinds).
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum LifecycleBody {
    /// Idle stop in `seconds`.
    IdleStopIn { seconds: u32 },
    /// Session cap in `seconds`.
    SessionCapIn { seconds: u32 },
    /// Stop imminent; the server flushes the client state.
    Stopping,
    /// The sandbox resumed; held by the server until a session attaches.
    Resumed,
}

/// Wire form of b4's `PortsBody` (b4 §4.2): `forwards[].url` is a non-optional string there, so
/// `None` → `""`.
#[derive(Debug, serde::Serialize)]
pub struct PortsBody<'a> {
    /// Listening ports.
    pub ports: &'a [ListeningPort],
    /// Forwards.
    pub forwards: Vec<PortForwardWire>,
}

/// One forward in [`PortsBody`].
#[derive(Debug, serde::Serialize)]
pub struct PortForwardWire {
    /// Port.
    pub port: u16,
    /// Visibility.
    pub visibility: Visibility,
    /// Label.
    pub label: Option<String>,
    /// URL (`""` when unknown).
    pub url: String,
}

impl From<&Forward> for PortForwardWire {
    fn from(forward: &Forward) -> Self {
        Self {
            port: forward.port,
            visibility: forward.visibility,
            label: forward.label.clone(),
            url: forward.url.clone().unwrap_or_default(),
        }
    }
}

/// `POST /control/extensions` body.
#[derive(Debug, serde::Serialize)]
pub struct ExtensionsBody<'a> {
    /// Extension ids to install.
    pub install: &'a [String],
}

/// Owns the spawn loop for one boot.
pub struct Supervisor {
    spec: ServerSpec,
    state: Arc<AgentState>,
    logs: LogShipper,
    control: ServerControl,
    cp: ControlPlane,
    shutdown: CancellationToken,
    child_pid: Arc<AtomicU32>,
}

impl Supervisor {
    /// Bundles the dependencies; nothing is spawned until [`Supervisor::run`].
    pub fn new(
        spec: ServerSpec,
        state: Arc<AgentState>,
        logs: LogShipper,
        control: ServerControl,
        cp: ControlPlane,
        shutdown: CancellationToken,
    ) -> Self {
        Self {
            spec,
            state,
            logs,
            control,
            cp,
            shutdown,
            child_pid: Arc::new(AtomicU32::new(0)),
        }
    }

    /// The spec this supervisor runs.
    pub fn spec(&self) -> &ServerSpec {
        &self.spec
    }

    /// Pid of the live child (0 when none).
    pub fn child_pid(&self) -> Arc<AtomicU32> {
        self.child_pid.clone()
    }

    /// 32 random bytes → hex (`rand::rng().fill_bytes`, rand 0.9).
    pub fn generate_control_secret() -> SecretString {
        let mut bytes = [0u8; 32];
        rand::rng().fill_bytes(&mut bytes);
        SecretString::from(hex::encode(bytes))
    }

    /// Writes the secret to `run/control.secret` (0600, no trailing newline; created fresh on
    /// every boot, never reused from a snapshot). Returns the path.
    pub fn write_control_secret(secret: &SecretString, run_dir: &Path) -> std::io::Result<PathBuf> {
        crate::config::ensure_private_dir(run_dir)?;
        let path = run_dir.join(CONTROL_SECRET_FILE_NAME);
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(0o600)
            .open(&path)?;
        file.write_all(secret.expose_secret().as_bytes())?;
        file.sync_all()?;
        Ok(path)
    }

    /// Before the first spawn: `ports::owner_of_port(8443)` and the control port; if another
    /// process holds either (a server left over from a crashed/restarted agent) →
    /// `killpg(SIGKILL)` on its process group, log `stale_server_killed {pid, comm, port}`, wait
    /// ≤ 2 s for the ports to free.
    pub async fn clear_stale_server(&self) -> anyhow::Result<()> {
        let ours = std::process::id();
        for port in [self.spec.listen.port(), self.spec.control_listen.port()] {
            let owner = match crate::ports::owner_of_port(port) {
                Ok(owner) => owner,
                Err(error) => {
                    // No `/proc` (a developer machine): nothing to clear, and `serve` will tell us
                    // soon enough with `EADDRINUSE`.
                    tracing::debug!(error = %error, port, "cannot inspect the socket table");
                    continue;
                }
            };
            let Some((pid, comm)) = owner else { continue };
            if pid == ours {
                continue;
            }
            // On a developer machine the control plane allocated these ports with bind(0)/close
            // before the boot, so an unrelated process may have taken one in between (another
            // test suite binding an ephemeral port); it is reported, never killed. In the
            // sandbox the owner can only be a server of an earlier boot.
            if crate::ports::lsof::enabled() && !names_server_binary(&comm, &self.spec.bin) {
                tracing::warn!(pid, comm = %comm, port, "port_held_by_foreign_process");
                continue;
            }
            tracing::warn!(pid, comm = %comm, port, "stale_server_killed");
            kill_group(pid);
            let deadline = Instant::now() + STALE_PORT_GRACE;
            while Instant::now() < deadline {
                if matches!(crate::ports::owner_of_port(port), Ok(None)) {
                    break;
                }
                tokio::time::sleep(REAP_POLL).await;
            }
        }
        Ok(())
    }

    /// Spawn loop: start child, read `ZS_LISTENING=`/`ZS_CONTROL_LISTENING=` from stdout, pump
    /// stderr into `logs` (and a ring of [`CRASH_TAIL_LINES`]), wait for exit; on exit while not
    /// shutting down: `killpg(SIGKILL)` the dead child's group, ship a `server_crash` entry with
    /// the tail and `cp.client_error(kind: "server_crash", stack: tail)`, bump `restarts`, sleep
    /// backoff, respawn – unless [`CRASH_LOOP_LIMIT`] is hit. Returns when `shutdown` fires and
    /// the child is gone.
    /// Takes `&self` (not `self`) so the stop path can call [`Supervisor::stop_child`] on the same
    /// instance while this loop is awaiting the child.
    pub async fn run(&self) -> anyhow::Result<()> {
        let mut backoff = 0usize;
        let mut exits: VecDeque<Instant> = VecDeque::new();
        let mut first = true;
        while !self.shutdown.is_cancelled() {
            if !first {
                // A respawn into a port still held by the previous child's lingering socket (or
                // by a user process) would exit at once and count towards the crash loop; the
                // sweep is cheap and skips our own pid.
                if let Err(error) = self.clear_stale_server().await {
                    tracing::warn!(error = %error, "could not clear a stale server before the respawn");
                }
                if self.shutdown.is_cancelled() {
                    break;
                }
            }
            first = false;
            let started = Instant::now();
            let child = match self.spec.command().spawn() {
                Ok(child) => child,
                Err(error) => {
                    let message = format!("server spawn failed: {error}");
                    tracing::error!(error = %error, bin = %self.spec.bin.display(), "server spawn failed");
                    self.state.set_error(message);
                    self.state.set_status(HealthStatus::Degraded);
                    if !self.pause(&mut backoff).await {
                        break;
                    }
                    continue;
                }
            };
            // Publish the pid before the first await so `stop_child` can always find the child;
            // a stop that landed between the loop check and the spawn is honoured right here.
            let pid = child.id().unwrap_or_default();
            self.child_pid.store(pid, Ordering::SeqCst);
            if self.shutdown.is_cancelled() {
                tracing::info!(
                    pid,
                    "stop requested during the spawn; killing the new child"
                );
                kill_group(pid);
                let _ = self.reap(child).await;
                self.child_pid.store(0, Ordering::SeqCst);
                break;
            }
            let (pid, exit) = self.supervise_child(child).await;
            let stopping = self.shutdown.is_cancelled();
            self.state.mark_server_exited(exit.tail_code);
            self.child_pid.store(0, Ordering::SeqCst);
            // Sweep the child's group either way: language servers and PTYs outlive their
            // parent, and on the stop path `stop_child` may have raced this exit.
            kill_group(pid);
            if stopping {
                break;
            }
            self.report_crash(pid, &exit);
            let now = Instant::now();
            exits.push_back(now);
            while exits
                .front()
                .is_some_and(|at| now.duration_since(*at) > CRASH_LOOP_LIMIT.1)
            {
                exits.pop_front();
            }
            self.state.update(|inner| inner.server.restarts += 1);
            if exits.len() as u32 >= CRASH_LOOP_LIMIT.0 {
                tracing::error!(restarts = exits.len(), "server_crash_loop");
                self.state.update(|inner| inner.server.crash_loop = true);
                self.state.set_error("server_crash_loop");
                self.state.set_status(HealthStatus::Degraded);
                return Ok(());
            }
            if started.elapsed() >= STABLE_AFTER {
                backoff = 0;
            }
            if !self.pause(&mut backoff).await {
                break;
            }
        }
        Ok(())
    }

    /// Waits for a child that was killed before it was ever supervised (the stop-during-spawn
    /// path), with a short bound so a stuck reap cannot delay the stop sequence.
    async fn reap(&self, mut child: tokio::process::Child) -> Option<std::process::ExitStatus> {
        tokio::time::timeout(TERM_GRACE, child.wait())
            .await
            .ok()
            .and_then(Result::ok)
    }

    /// Runs one child to completion: marks it live (accepting only once it says so), pumps its
    /// streams and keeps the crash tail.
    async fn supervise_child(&self, mut child: tokio::process::Child) -> (u32, ChildExit) {
        let pid = child.id().unwrap_or_default();
        self.child_pid.store(pid, Ordering::SeqCst);
        self.state.update(|inner| {
            inner.server.running = true;
            inner.server.listening = false;
            inner.server.pid = Some(pid);
            inner.server.started_at_ms = Some(crate::logs::now_ms());
        });
        tracing::info!(pid, argv = ?self.spec.argv(), "zed-remote-server serve started");
        let tail = Arc::new(Mutex::new(VecDeque::<String>::with_capacity(
            CRASH_TAIL_LINES,
        )));
        let stdout = child.stdout.take().map(|stdout| {
            let logs = self.logs.clone();
            let state = self.state.clone();
            tokio::spawn(async move {
                logs.pump_observed(stdout, LogSource::Server, |line| {
                    if let Some(rest) = line.strip_prefix("ZS_LISTENING=") {
                        tracing::info!(addr = rest.trim(), "server listening");
                        state.mark_server_listening();
                    } else if let Some(rest) = line.strip_prefix("ZS_CONTROL_LISTENING=") {
                        tracing::info!(addr = rest.trim(), "server control listener up");
                    }
                })
                .await;
            })
        });
        let stderr = child.stderr.take().map(|stderr| {
            let logs = self.logs.clone();
            let tail = tail.clone();
            tokio::spawn(async move {
                logs.pump_observed(stderr, LogSource::Server, |line| {
                    let mut tail = tail.lock();
                    if tail.len() == CRASH_TAIL_LINES {
                        tail.pop_front();
                    }
                    tail.push_back(line.to_string());
                })
                .await;
            })
        });
        let status = child.wait().await;
        for task in [stdout, stderr].into_iter().flatten() {
            let _ = tokio::time::timeout(Duration::from_secs(2), task).await;
        }
        let (code, description) = match status {
            Ok(status) => (status.code(), status.to_string()),
            Err(error) => (None, format!("wait failed: {error}")),
        };
        let tail = tail.lock().iter().cloned().collect::<Vec<_>>().join("\n");
        (
            pid,
            ChildExit {
                tail_code: code,
                description,
                tail,
            },
        )
    }

    /// Ships the crash tail to the log stream and, from a spawned task, to `POST /client-errors`
    /// (§3.9). The POST is not awaited: with the control plane unreachable it can take a minute
    /// of retries, and the respawn must only wait the [`RESTART_BACKOFF`].
    fn report_crash(&self, pid: u32, exit: &ChildExit) {
        tracing::error!(pid, exit = %exit.description, "server exited; restarting");
        self.logs.push(crate::logs::LogEntry {
            ts: crate::logs::now_ms(),
            level: "error",
            source: LogSource::Agent.as_str().to_string(),
            msg: format!("server_crash: {}", exit.description),
            fields: None,
        });
        let stack = (!exit.tail.is_empty()).then(|| {
            let mut tail = crate::logs::scrub(&exit.tail).into_owned();
            // Never `String::truncate` here: a multi-byte char at the cut would panic, and with
            // `panic = "abort"` that takes the whole agent down in the middle of crash handling.
            crate::logs::truncate_at_boundary(&mut tail, CRASH_TAIL_BYTES);
            tail
        });
        let message = crate::logs::scrub(&exit.description).into_owned();
        let build = self.spec.client_build.clone();
        let cp = self.cp.clone();
        tokio::spawn(async move {
            let report = ClientErrorReport {
                build: &build,
                kind: "server_crash",
                message,
                stack,
                marks: None,
            };
            if let Err(error) = cp.client_error(&report).await {
                tracing::debug!(error = %error, "could not report the server crash");
            }
        });
    }

    /// Sleeps the next respawn backoff; `false` when the shutdown fired instead.
    async fn pause(&self, backoff: &mut usize) -> bool {
        let seconds = RESTART_BACKOFF[(*backoff).min(RESTART_BACKOFF.len() - 1)];
        *backoff += 1;
        tokio::select! {
            _ = tokio::time::sleep(Duration::from_secs(seconds)) => true,
            _ = self.shutdown.cancelled() => false,
        }
    }

    /// Stop sequence (BUILD-SPEC 6.2 stop, b4 §3.10, D18), total ≤ ≈ 18 s:
    /// 1. `post_lifecycle(Stopping)` with [`STOPPING_POST_TIMEOUT`];
    /// 2. `kill(pid, SIGTERM)` to the child pid only;
    /// 3. wait ≤ [`TERM_GRACE`] for exit;
    /// 4. `killpg(pgid, SIGKILL)` (always – sweeps orphaned LSPs/PTYs);
    /// 5. reap.
    pub async fn stop_child(&self) -> anyhow::Result<()> {
        let pid = self.child_pid.load(Ordering::SeqCst);
        if pid == 0 {
            return Ok(());
        }
        // 1. Give the client its full `SaveClientState` window (D6/D18).
        match self.control.post_lifecycle(&LifecycleBody::Stopping).await {
            Ok(()) => tracing::info!("stopping notice acknowledged"),
            Err(error) => tracing::warn!(error = %error, "stopping notice failed; continuing"),
        }
        // 2-3. SIGTERM the child only, then wait for it to flush and exit.
        let _ = signal::kill(Pid::from_raw(pid as i32), Signal::SIGTERM);
        let deadline = Instant::now() + TERM_GRACE;
        while Instant::now() < deadline {
            if !self.state.read(|inner| inner.server.running) {
                break;
            }
            tokio::time::sleep(REAP_POLL).await;
        }
        // 4. Sweep the group either way: language servers and PTYs are in it. Re-read the pid:
        //    a respawn that raced the stop is swept too.
        kill_group(pid);
        let current = self.child_pid.load(Ordering::SeqCst);
        if current != 0 && current != pid {
            kill_group(current);
        }
        Ok(())
    }
}

/// One child's exit, with the stderr tail kept for the crash report.
struct ChildExit {
    tail_code: Option<i32>,
    description: String,
    tail: String,
}

/// `SIGKILL` to the process group led by `pid`, falling back to the process itself when it never
/// became a group leader. Every child the agent spawns is its own group leader
/// (`process_group(0)`), so this sweeps the language servers, PTYs and shells under it.
pub fn kill_group(pid: u32) {
    if pid == 0 {
        return;
    }
    let target = Pid::from_raw(pid as i32);
    if signal::killpg(target, Signal::SIGKILL).is_err() {
        let _ = signal::kill(target, Signal::SIGKILL);
    }
}

/// Whether `comm` (the process name as `/proc/<pid>/comm` or `lsof` report it – possibly a
/// full path, possibly truncated) names the server binary `bin`.
fn names_server_binary(comm: &str, bin: &Path) -> bool {
    let bin_name = bin
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default();
    let comm_name = Path::new(comm)
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default();
    !comm_name.is_empty()
        && !bin_name.is_empty()
        && (bin_name.starts_with(&comm_name) || comm_name.starts_with(&bin_name))
}

/// Poll `GET /health` until it answers or `deadline` passes; used by start (readiness) and tests.
/// Bounded polling with growing pauses (D29), never one fixed wait.
pub async fn wait_for_server(
    control: &ServerControl,
    deadline: Duration,
) -> anyhow::Result<ServerHealth> {
    let until = Instant::now() + deadline;
    let mut pause = Duration::from_millis(200);
    loop {
        match control.health().await {
            Ok(health) => return Ok(health),
            Err(error) => {
                if Instant::now() + pause >= until {
                    bail!(
                        "server did not answer /health within {}s: {error}",
                        deadline.as_secs()
                    );
                }
            }
        }
        tokio::time::sleep(pause).await;
        pause = (pause * 2).min(READY_POLL_MAX);
    }
}
