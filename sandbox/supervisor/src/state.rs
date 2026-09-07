//! Shared runtime state read by the health listeners and the activity relay (brief §3.8, §4.4),
//! plus the in-memory forward list (`ForwardsState`).
//!
//! D21 splits health into two bodies: the public `8448` listener serves only [`MinimalHealth`]
//! (`{ ok, phase, build, serverUp, uptimeSec }`); the loopback `8450` API serves the full
//! [`HealthReport`].

use std::collections::BTreeMap;
use std::sync::{Arc, RwLock};
use std::time::Instant;

use tokio::sync::watch;

use crate::config::PROXY_SLOTS;
use crate::logs::scrub;
use crate::manifest::{Forward, Visibility};

/// Supervisor health status.
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum HealthStatus {
    /// Boot in progress (HTTP 503).
    Booting,
    /// Server usable (HTTP 200).
    Ready,
    /// Server usable, something went wrong (HTTP 200; `lastError` says what).
    Degraded,
    /// Shutdown in progress (HTTP 503).
    Stopping,
}

/// Boot phase (D13: the control plane honours a non-ready phase as activity).
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Phase {
    /// Fetching the manifest.
    Manifest,
    /// Restoring the rebuild tarball.
    Restore,
    /// Cloning the repository.
    Clone,
    /// Spawning `zed-remote-server serve`.
    ServerStarting,
    /// Starting the manifest's optional services (`dockerd`; b10 §3.16, D40).
    Services,
    /// Installing dotfiles.
    Dotfiles,
    /// Running `postCreateCommand`.
    PostCreate,
    /// Running `postStartCommand`.
    PostStart,
    /// Prebuild only: LSP warm-up.
    Warm,
    /// Steady state.
    Ready,
}

/// Interior state; short critical sections only, never held across an await.
pub struct AgentState {
    inner: parking_lot::RwLock<AgentStateInner>,
    /// `Some(started_at_ms)` while a server child is accepting on its listeners, `None`
    /// otherwise; every change wakes the port watcher and the start hooks (extensions, the
    /// `resumed` notice) so they re-drive the freshly (re)spawned server.
    server_up: watch::Sender<Option<u64>>,
}

/// The mutable fields behind [`AgentState`].
pub struct AgentStateInner {
    /// Image build id (`ZS_BUILD_ID`).
    pub build: String,
    /// Health status.
    pub status: HealthStatus,
    /// Boot phase.
    pub phase: Phase,
    /// This boot resumes a stopped sandbox (first-boot marker).
    pub resumed: bool,
    /// Agent start time.
    pub started_at: Instant,
    /// Last error, scrubbed on read.
    pub last_error: Option<String>,
    /// Server process status.
    pub server: ServerStatus,
    /// Every proxy slot is bound and serving.
    pub proxy_running: bool,
    /// Proxy slots (D21 default; `Config::proxy_slots` when overridden).
    pub proxy_slots: Vec<u16>,
    /// Last successful `GET 127.0.0.1:8443/health`.
    pub server_health: Option<ServerHealth>,
    /// First `session_active == true` observed this boot (drives postAttach).
    pub session_seen: bool,
    /// Number of lifecycle commands / warm-ups running right now (D13 `busy = count > 0`);
    /// postAttach can overlap postCreate/postStart, so a bool that either could clear was
    /// wrong.
    pub busy_count: usize,
    /// `manifest.build`.
    pub manifest_build: Option<String>,
    /// `ZS_REGION`.
    pub region: Option<String>,
}

/// Server process status.
#[derive(Clone, Debug, Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerStatus {
    /// Reported as "a child is alive **and** accepting": the raw process flag is `&&`-ed with
    /// [`ServerStatus::listening`] on the wire (see [`ServerStatus::reported`]), because the
    /// control plane computes `ready = ok && server.running` and a child that has not bound
    /// `8443` yet must not count.
    pub running: bool,
    /// The child printed `ZS_LISTENING=` or answered `/health` (cleared on exit).
    pub listening: bool,
    /// Child pid.
    pub pid: Option<u32>,
    /// Respawns this boot.
    pub restarts: u32,
    /// Last exit code.
    pub last_exit: Option<i32>,
    /// Unix ms of the last spawn.
    pub started_at_ms: Option<u64>,
    /// `CRASH_LOOP_LIMIT` hit; no more respawns.
    pub crash_loop: bool,
}

impl ServerStatus {
    /// The wire view: `running` means alive and accepting.
    pub fn reported(&self) -> ServerStatus {
        ServerStatus {
            running: self.running && self.listening,
            ..self.clone()
        }
    }
}

/// b2 §3.8 `HealthResponse` subset (`worktrees`/`auth_failures` deliberately not modelled).
#[derive(Clone, Debug, serde::Deserialize, serde::Serialize)]
pub struct ServerHealth {
    /// Server build id.
    pub build: String,
    /// Server version string.
    pub version: String,
    /// Seconds since the server started.
    pub uptime_secs: u64,
    /// A session is attached.
    pub session_active: bool,
    /// Unix ms of the last input envelope (D20 exclusions apply).
    #[serde(default)]
    pub last_input_at: Option<u64>,
    /// b2 §3.7 `SessionMeta`; its `session_id` key (the JWT `sid`) feeds the activity ping.
    #[serde(default)]
    pub session: Option<serde_json::Value>,
    /// Dirty buffer count.
    #[serde(default)]
    pub dirty_buffers: Option<u32>,
}

impl ServerHealth {
    /// `session.session_id` when a session is attached.
    pub fn session_id(&self) -> Option<&str> {
        self.session.as_ref()?.get("session_id")?.as_str()
    }
}

/// `GET /health` full body (§4.4), served on the loopback API (D21).
#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HealthReport {
    /// Health status.
    pub status: HealthStatus,
    /// Boot phase.
    pub phase: Phase,
    /// Image build id.
    pub build: String,
    /// `manifest.build`.
    pub manifest_build: Option<String>,
    /// `ZS_REGION`.
    pub region: Option<String>,
    /// Resumed boot.
    pub resumed: bool,
    /// Lifecycle command or warm-up running.
    pub busy: bool,
    /// Agent uptime.
    pub uptime_secs: u64,
    /// Scrubbed last error.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_error: Option<String>,
    /// Server status and last health.
    pub server: ServerReport,
    /// Proxy status and slot bindings.
    pub proxy: ProxyReport,
    /// Forward list with URLs (loopback only).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub forwards: Option<Vec<Forward>>,
    /// Listening ports.
    pub listening: Vec<u16>,
}

/// `HealthReport.server`.
#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerReport {
    /// Process status, flattened.
    #[serde(flatten)]
    pub status: ServerStatus,
    /// Last `/health` body from the server.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub health: Option<ServerHealth>,
}

/// `HealthReport.proxy`: slot port → bound target port.
#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProxyReport {
    /// Every slot is bound and serving.
    pub running: bool,
    /// Slot port → bound target port.
    pub slots: BTreeMap<u16, Option<u16>>,
}

/// D21 public health body on `8448`: nothing sensitive.
#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MinimalHealth {
    /// `status ∈ { ready, degraded }`.
    pub ok: bool,
    /// Boot phase.
    pub phase: Phase,
    /// Image build id.
    pub build: String,
    /// The server process is alive and accepting on its listeners.
    pub server_up: bool,
    /// Agent uptime.
    pub uptime_sec: u64,
}

/// RAII handle from [`AgentState::busy_guard`]: `busy` stays `true` until the last guard drops.
pub struct BusyGuard {
    state: Arc<AgentState>,
}

impl Drop for BusyGuard {
    fn drop(&mut self) {
        let mut inner = self.state.inner.write();
        inner.busy_count = inner.busy_count.saturating_sub(1);
    }
}

impl AgentState {
    /// Status `Booting`, phase `Manifest`, `started_at = Instant::now()` (no `Default`: `Instant`
    /// has none).
    pub fn new(build: String, region: Option<String>) -> Arc<Self> {
        let (server_up, _) = watch::channel(None);
        Arc::new(Self {
            inner: parking_lot::RwLock::new(AgentStateInner {
                build,
                status: HealthStatus::Booting,
                phase: Phase::Manifest,
                resumed: false,
                started_at: Instant::now(),
                last_error: None,
                server: ServerStatus::default(),
                proxy_running: false,
                proxy_slots: PROXY_SLOTS.to_vec(),
                server_health: None,
                session_seen: false,
                busy_count: 0,
                manifest_build: None,
                region,
            }),
            server_up,
        })
    }

    /// Marks the current child as accepting (`ZS_LISTENING=` seen on its stdout, or a `/health`
    /// probe answered) and wakes the `server_up` watchers when that is news.
    pub fn mark_server_listening(&self) {
        let generation = {
            let mut inner = self.inner.write();
            if !inner.server.running || inner.server.listening {
                return;
            }
            inner.server.listening = true;
            inner.server.started_at_ms
        };
        self.server_up.send_replace(generation);
    }

    /// Records a child's exit: no pid, not running, not listening, and – since the body came
    /// from a process that no longer exists – no `server_health` either, so the activity relay
    /// stops reporting a dead server's session as attached.
    pub fn mark_server_exited(&self, exit_code: Option<i32>) {
        {
            let mut inner = self.inner.write();
            inner.server.running = false;
            inner.server.listening = false;
            inner.server.pid = None;
            inner.server.last_exit = exit_code;
            inner.server_health = None;
        }
        self.server_up.send_replace(None);
    }

    /// A watch that carries `Some(started_at_ms)` while a child is accepting; see
    /// [`AgentState::mark_server_listening`].
    pub fn server_up_watch(&self) -> watch::Receiver<Option<u64>> {
        self.server_up.subscribe()
    }

    /// Holds `busy = true` (D13) until the returned guard drops; nests across overlapping
    /// lifecycle commands.
    pub fn busy_guard(self: &Arc<Self>) -> BusyGuard {
        self.inner.write().busy_count += 1;
        BusyGuard {
            state: self.clone(),
        }
    }

    /// D13: a lifecycle command or the warm-up is running.
    pub fn busy(&self) -> bool {
        self.inner.read().busy_count > 0
    }

    /// Sets the boot phase.
    pub fn set_phase(&self, phase: Phase) {
        self.inner.write().phase = phase;
    }

    /// Sets the health status.
    pub fn set_status(&self, status: HealthStatus) {
        self.inner.write().status = status;
    }

    /// Current health status.
    pub fn status(&self) -> HealthStatus {
        self.inner.read().status
    }

    /// Current boot phase.
    pub fn phase(&self) -> Phase {
        self.inner.read().phase
    }

    /// Records the last error (scrubbed when reported).
    pub fn set_error(&self, error: impl Into<String>) {
        self.inner.write().last_error = Some(error.into());
    }

    /// Runs `f` under the write lock (setters not worth a method each).
    pub fn update(&self, f: impl FnOnce(&mut AgentStateInner)) {
        f(&mut self.inner.write());
    }

    /// Runs `f` under the read lock.
    pub fn read<T>(&self, f: impl FnOnce(&AgentStateInner) -> T) -> T {
        f(&self.inner.read())
    }

    /// The loopback health body (§4.4). `full == false` omits `forwards`; every other field is
    /// present for any caller.
    pub fn snapshot(&self, full: bool, forwards: &[Forward], listening: &[u16]) -> HealthReport {
        let inner = self.inner.read();
        let slots = inner
            .proxy_slots
            .iter()
            .map(|slot| {
                let bound = forwards
                    .iter()
                    .find(|f| f.slot == Some(*slot))
                    .map(|f| f.port);
                (*slot, bound)
            })
            .collect();
        HealthReport {
            status: inner.status,
            phase: inner.phase,
            build: inner.build.clone(),
            manifest_build: inner.manifest_build.clone(),
            region: inner.region.clone(),
            resumed: inner.resumed,
            busy: inner.busy_count > 0,
            uptime_secs: inner.started_at.elapsed().as_secs(),
            last_error: inner
                .last_error
                .as_deref()
                .map(|error| scrub(error).into_owned()),
            server: ServerReport {
                status: inner.server.reported(),
                health: inner.server_health.clone(),
            },
            proxy: ProxyReport {
                running: inner.proxy_running,
                slots,
            },
            forwards: full.then(|| forwards.to_vec()),
            listening: listening.to_vec(),
        }
    }

    /// The D21 public body for `8448`.
    pub fn minimal(&self) -> MinimalHealth {
        let inner = self.inner.read();
        MinimalHealth {
            ok: matches!(inner.status, HealthStatus::Ready | HealthStatus::Degraded),
            phase: inner.phase,
            build: inner.build.clone(),
            server_up: inner.server.running && inner.server.listening,
            uptime_sec: inner.started_at.elapsed().as_secs(),
        }
    }
}

/// Why a slot could not be bound.
#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum SlotError {
    /// The port is not a private forward.
    #[error("port {0} is not a private forward")]
    NotPrivateForward(u16),
    /// The slot serves another live forward.
    #[error("slot {slot} is bound to port {port}")]
    SlotBusy { slot: u16, port: u16 },
    /// The slot is not one of this boot's proxy slots.
    #[error("{0} is not a proxy slot")]
    UnknownSlot(u16),
    /// The port is already served by another slot; a token must not move a live binding.
    #[error("port {port} is bound to slot {slot}")]
    PortBoundElsewhere { port: u16, slot: u16 },
}

/// In-memory copy of the forward list; the control plane is the persistent store.
#[derive(Clone)]
pub struct ForwardsState {
    inner: Arc<RwLock<ForwardsInner>>,
    changed: watch::Sender<u64>,
}

struct ForwardsInner {
    forwards: BTreeMap<u16, Forward>,
    /// slot → port (D8).
    slots: BTreeMap<u16, u16>,
    known_slots: Vec<u16>,
}

impl Default for ForwardsState {
    fn default() -> Self {
        Self::new()
    }
}

impl ForwardsState {
    /// Empty list over the D21 default slots.
    pub fn new() -> Self {
        Self::with_slots(&PROXY_SLOTS)
    }

    /// Empty list over the given proxy slots (`Config::proxy_slots`).
    pub fn with_slots(slots: &[u16]) -> Self {
        let (changed, _) = watch::channel(0);
        Self {
            inner: Arc::new(RwLock::new(ForwardsInner {
                forwards: BTreeMap::new(),
                slots: BTreeMap::new(),
                known_slots: slots.to_vec(),
            })),
            changed,
        }
    }

    /// Replaces the list wholesale; no-op (no `changed` bump) when equal. Re-derives `slots` from
    /// `forwards[].slot`, keeps token-learned bindings whose port is still a private forward,
    /// drops the rest.
    pub fn replace(&self, forwards: Vec<Forward>) {
        self.replace_if_unchanged(forwards, None);
    }

    /// The current change counter; pair with [`ForwardsState::replace_if_unchanged`] so a
    /// directive built from a report that predates a local `/ports` insert cannot undo it.
    pub fn generation(&self) -> u64 {
        *self.changed.borrow()
    }

    /// [`ForwardsState::replace`] guarded by a generation: when `expected` is `Some(g)` and the
    /// list changed since `g` (a `/ports` insert or remove landed while the ping was in flight),
    /// the older list is ignored and `false` is returned; the next ping carries the merged
    /// state anyway.
    pub fn replace_if_unchanged(&self, forwards: Vec<Forward>, expected: Option<u64>) -> bool {
        let mut inner = self.inner.write().unwrap_or_else(|e| e.into_inner());
        if let Some(expected) = expected
            && *self.changed.borrow() != expected
        {
            return false;
        }
        let mut next: BTreeMap<u16, Forward> = forwards.into_iter().map(|f| (f.port, f)).collect();
        let mut slots: BTreeMap<u16, u16> = BTreeMap::new();
        for forward in next.values() {
            if let Some(slot) = forward.slot
                && inner.known_slots.contains(&slot)
            {
                slots.insert(slot, forward.port);
            }
        }
        for (slot, port) in &inner.slots {
            let still_private = next
                .get(port)
                .is_some_and(|f| f.visibility == Visibility::Private);
            if still_private && !slots.contains_key(slot) && !slots.values().any(|p| p == port) {
                slots.insert(*slot, *port);
            }
        }
        for (slot, port) in &slots {
            if let Some(forward) = next.get_mut(port) {
                forward.slot = Some(*slot);
            }
        }
        if next == inner.forwards && slots == inner.slots {
            return true;
        }
        inner.forwards = next;
        inner.slots = slots;
        drop(inner);
        self.bump();
        true
    }

    /// Idempotent per port (b4 §7 item 8: `ForwardPort` may be replayed); binds `slot` when given.
    pub fn insert(&self, forward: Forward) {
        let mut inner = self.inner.write().unwrap_or_else(|e| e.into_inner());
        if inner.forwards.get(&forward.port) == Some(&forward) {
            return;
        }
        inner.slots.retain(|_, port| *port != forward.port);
        if let Some(slot) = forward.slot {
            inner.slots.insert(slot, forward.port);
        }
        inner.forwards.insert(forward.port, forward);
        drop(inner);
        self.bump();
    }

    /// Removes a forward and unbinds any slot pointing at `port`.
    pub fn remove(&self, port: u16) {
        let mut inner = self.inner.write().unwrap_or_else(|e| e.into_inner());
        let removed = inner.forwards.remove(&port).is_some();
        let before = inner.slots.len();
        inner.slots.retain(|_, bound| *bound != port);
        let unbound = inner.slots.len() != before;
        drop(inner);
        if removed || unbound {
            self.bump();
        }
    }

    /// The current list (with `slot` reflecting live bindings).
    pub fn current(&self) -> Vec<Forward> {
        let inner = self.inner.read().unwrap_or_else(|e| e.into_inner());
        inner.forwards.values().cloned().collect()
    }

    /// Port bound to `slot`, if any.
    pub fn slot_port(&self, slot: u16) -> Option<u16> {
        let inner = self.inner.read().unwrap_or_else(|e| e.into_inner());
        inner.slots.get(&slot).copied()
    }

    /// Public proxies need no cookie; only explicitly public bindings qualify.
    pub fn public_slot_port(&self, slot: u16) -> Option<u16> {
        let inner = self.inner.read().unwrap_or_else(|e| e.into_inner());
        let port = *inner.slots.get(&slot)?;
        inner
            .forwards
            .get(&port)
            .filter(|forward| forward.visibility == Visibility::Public)
            .map(|_| port)
    }

    /// Token-learned binding (§3.11); refuses when `port` is not a private forward, when the
    /// slot is bound to another live forward, or when `port` is already served by another slot
    /// (a valid token presented on the wrong slot must not move the binding the control plane
    /// allocated and invalidate every cookie on the original slot host).
    pub fn bind_slot(&self, slot: u16, port: u16) -> Result<(), SlotError> {
        let mut inner = self.inner.write().unwrap_or_else(|e| e.into_inner());
        if !inner.known_slots.contains(&slot) {
            return Err(SlotError::UnknownSlot(slot));
        }
        let is_private = inner
            .forwards
            .get(&port)
            .is_some_and(|f| f.visibility == Visibility::Private);
        if !is_private {
            return Err(SlotError::NotPrivateForward(port));
        }
        if let Some(existing) = inner.slots.get(&slot).copied() {
            if existing == port {
                return Ok(());
            }
            if inner.forwards.contains_key(&existing) {
                return Err(SlotError::SlotBusy {
                    slot,
                    port: existing,
                });
            }
        }
        if let Some((bound_slot, _)) = inner
            .slots
            .iter()
            .find(|(bound_slot, bound)| **bound == port && **bound_slot != slot)
        {
            return Err(SlotError::PortBoundElsewhere {
                port,
                slot: *bound_slot,
            });
        }
        inner.slots.insert(slot, port);
        if let Some(forward) = inner.forwards.get_mut(&port) {
            forward.slot = Some(slot);
        }
        drop(inner);
        self.bump();
        Ok(())
    }

    /// Every known slot → bound port (or `None`).
    pub fn slots(&self) -> BTreeMap<u16, Option<u16>> {
        let inner = self.inner.read().unwrap_or_else(|e| e.into_inner());
        inner
            .known_slots
            .iter()
            .map(|slot| (*slot, inner.slots.get(slot).copied()))
            .collect()
    }

    /// A watch that ticks on every change.
    pub fn changed(&self) -> watch::Receiver<u64> {
        self.changed.subscribe()
    }

    fn bump(&self) {
        self.changed.send_modify(|version| *version += 1);
    }
}
