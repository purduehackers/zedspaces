//! Activity ping relay and lifecycle notice policy (brief §3.15; D13, D18, D29).
//!
//! The control plane decides the deadlines (`idleStopAt`, `sessionCapAt`, `stop`) and hands them
//! to the supervisor on every ping as an `ActivityDirective`; the supervisor turns them into b4's
//! lifecycle notices locally (BUILD-SPEC §5.5: `idle_stop_in` 5 min before, `session_cap_in`
//! 30 min before) and reports what D13 needs (`lastInputAt`, `busy`, `phase`, `cpuBusyPct`).

use std::collections::BTreeMap;
use std::sync::{Arc, OnceLock};
use std::time::Duration;

use tokio_util::sync::CancellationToken;

use crate::bootstrap::{Cancelled, CommandSpec};
use crate::config::Config;
use crate::control_plane::{
    ActivityDirective, ActivityReport, ControlPlane, ControlPlaneError, ListeningPortWire,
};
use crate::logs::LogShipper;
use crate::manifest::Manifest;
use crate::ports::ListeningState;
use crate::server::{LifecycleBody, ServerControl};
use crate::state::{AgentState, ForwardsState, HealthStatus, Phase, ServerHealth};

/// Default ping interval; `manifest.activity.intervalSecs` wins (≥ 10 s).
pub const DEFAULT_PING_INTERVAL: Duration = Duration::from_secs(30);
/// Lead time of the `idle_stop_in` notice (BUILD-SPEC §7.5).
pub const IDLE_NOTICE_LEAD: Duration = Duration::from_secs(5 * 60);
/// Lead time of the `session_cap_in` notice (BUILD-SPEC §7.5: 23.5 h of 24 h).
pub const CAP_NOTICE_LEAD: Duration = Duration::from_secs(30 * 60);
/// Lower bound on the ping interval (b9 rate-limits activity at 10/min).
pub const MIN_PING_INTERVAL: Duration = Duration::from_secs(10);
/// How long a running `postAttachCommand` gets to notice the shutdown token (and kill its
/// process group) before its task is aborted.
pub const POST_ATTACH_CANCEL_GRACE: Duration = Duration::from_secs(1);
/// Ceiling on `listening[]` in one activity report (CONTRACTS §7.5: `≤ 256`).
pub const MAX_LISTENING: usize = 256;

/// The periodic ping task.
pub struct ActivityRelay {
    control: ControlPlane,
    server: ServerControl,
    state: Arc<AgentState>,
    forwards: ForwardsState,
    listening: ListeningState,
    config: Arc<Config>,
    manifest: Arc<Manifest>,
    interval: Duration,
    shutdown: CancellationToken,
    post_attach: Arc<OnceLock<PostAttach>>,
    /// The spawned `postAttachCommand`, so the relay never blocks a ping on it (D13: the control
    /// plane must keep seeing `busy` pings while it runs) and can reap it on shutdown.
    post_attach_task: Option<tokio::task::JoinHandle<()>>,
    logs: LogShipper,
    cpu: CpuSampler,
}

/// `postAttachCommand` and the environment to run it in. The relay starts right after the manifest
/// (§3.15) while the devcontainer is only parsed after the checkout (§3.16 step 3), so `start`
/// fills this slot once; a session cannot attach before the server is up, which is later still.
#[derive(Clone, Debug)]
pub struct PostAttach {
    /// The specs from `devcontainer.postAttachCommand`.
    pub specs: Vec<CommandSpec>,
    /// `Config::child_env` with the manifest and `remoteEnv` literals merged.
    pub env: BTreeMap<String, String>,
}

/// `/proc/stat` sampler for D13/D18 `cpuBusyPct`.
#[derive(Default)]
pub struct CpuSampler {
    prev: Option<(u64, u64)>,
}

impl CpuSampler {
    /// `100 · (1 − Δ(idle+iowait)/Δtotal)` clamped to 0..=100; `None` on the first call or when
    /// `/proc/stat` is unreadable (never fails the ping).
    pub fn sample(&mut self) -> Option<f32> {
        let text = Self::read_proc_stat()?;
        let current = Self::parse_stat_line(text.lines().next()?)?;
        self.observe(current)
    }

    /// `/proc/stat` is Linux-only; every other host (a developer's macOS under `ZS_LOCAL=1`)
    /// simply reports no `cpuBusyPct`, which the control plane accepts.
    #[cfg(target_os = "linux")]
    fn read_proc_stat() -> Option<String> {
        std::fs::read_to_string("/proc/stat").ok()
    }

    #[cfg(not(target_os = "linux"))]
    fn read_proc_stat() -> Option<String> {
        None
    }

    /// The pure step behind [`CpuSampler::sample`]: feeds one `(busy, total)` reading and returns
    /// the busy percentage since the previous one (`None` for the first reading or a zero delta).
    pub fn observe(&mut self, current: (u64, u64)) -> Option<f32> {
        let previous = self.prev.replace(current);
        let (busy_before, total_before) = previous?;
        let (busy_now, total_now) = current;
        let total_delta = total_now.checked_sub(total_before)?;
        if total_delta == 0 {
            return None;
        }
        let idle_delta = (total_now - busy_now).saturating_sub(total_before - busy_before);
        let pct = 100.0 * (1.0 - idle_delta as f64 / total_delta as f64);
        Some(pct.clamp(0.0, 100.0) as f32)
    }

    /// Parses `cpu user nice system idle iowait irq softirq steal …` (jiffies, cumulative) into
    /// `(busy, total)` where `busy = total − idle − iowait`.
    pub fn parse_stat_line(line: &str) -> Option<(u64, u64)> {
        let mut fields = line.split_whitespace();
        if fields.next()? != "cpu" {
            return None;
        }
        let values: Vec<u64> = fields
            .take(8)
            .map(str::parse)
            .collect::<Result<_, _>>()
            .ok()?;
        if values.len() < 5 {
            return None;
        }
        let total: u64 = values.iter().sum();
        let idle = values[3] + values[4];
        Some((total - idle, total))
    }
}

/// Pure notice policy (unit-tested):
/// * `IdleStopIn { seconds }` once per distinct `idle_stop_at` value when
///   `idle_stop_at − now ≤ IDLE_NOTICE_LEAD`; `SessionCapIn` likewise with `CAP_NOTICE_LEAD`;
/// * `stop: true` → [`NoticePolicy::stop_requested`] becomes true once (the caller runs the same
///   shutdown path as SIGTERM); the policy never emits `Stopping` itself;
/// * `Resumed` is not the policy's job (posted by start right after the server is healthy).
#[derive(Default, Debug)]
pub struct NoticePolicy {
    idle_notified_for: Option<u64>,
    cap_notified_for: Option<u64>,
    stop_seen: bool,
}

impl NoticePolicy {
    /// Applies one directive at `now_ms`, returning the notices to post.
    pub fn accept(&mut self, directive: &ActivityDirective, now_ms: u64) -> Vec<LifecycleBody> {
        let mut notices = Vec::new();
        if let Some(at) = directive.idle_stop_at
            && at.saturating_sub(now_ms) <= IDLE_NOTICE_LEAD.as_millis() as u64
            && self.idle_notified_for != Some(at)
        {
            self.idle_notified_for = Some(at);
            notices.push(LifecycleBody::IdleStopIn {
                seconds: seconds_until(at, now_ms),
            });
        }
        if let Some(at) = directive.session_cap_at
            && at.saturating_sub(now_ms) <= CAP_NOTICE_LEAD.as_millis() as u64
            && self.cap_notified_for != Some(at)
        {
            self.cap_notified_for = Some(at);
            notices.push(LifecycleBody::SessionCapIn {
                seconds: seconds_until(at, now_ms),
            });
        }
        if directive.stop {
            self.stop_seen = true;
        }
        notices
    }

    /// A `stop: true` directive has been seen.
    pub fn stop_requested(&self) -> bool {
        self.stop_seen
    }
}

fn seconds_until(at_ms: u64, now_ms: u64) -> u32 {
    u32::try_from(at_ms.saturating_sub(now_ms) / 1000).unwrap_or(u32::MAX)
}

impl ActivityRelay {
    /// Bundles the dependencies; the interval is `manifest.activity.intervalSecs` clamped to
    /// [`MIN_PING_INTERVAL`].
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        control: ControlPlane,
        server: ServerControl,
        state: Arc<AgentState>,
        forwards: ForwardsState,
        listening: ListeningState,
        config: Arc<Config>,
        manifest: Arc<Manifest>,
        shutdown: CancellationToken,
        post_attach: Arc<OnceLock<PostAttach>>,
        logs: LogShipper,
    ) -> Self {
        let interval = Duration::from_secs(manifest.activity.interval_secs).max(MIN_PING_INTERVAL);
        Self {
            control,
            server,
            state,
            forwards,
            listening,
            config,
            manifest,
            interval,
            shutdown,
            post_attach,
            post_attach_task: None,
            logs,
            cpu: CpuSampler::default(),
        }
    }

    /// The configuration the relay reports against (`ZS_REGION`, identity, listeners).
    pub fn config(&self) -> &Arc<Config> {
        &self.config
    }

    /// The effective ping interval.
    pub fn interval(&self) -> Duration {
        self.interval
    }

    /// Started right after the manifest. Every `interval`: server health → `state.server_health`
    /// (first `session_active` runs `postAttachCommand` once); build the `ActivityReport`
    /// (`last_input_at = now` while busy or not ready, `cpu.sample()`, `busy`, `phase`,
    /// `listening`); POST; on success `forwards.replace(d.forwards)` when present,
    /// `policy.accept` → `post_lifecycle` each, `stop_requested()` → fire `shutdown`; 401 →
    /// degraded once; 410 → stop the loop; other errors → log and keep the interval.
    pub async fn run(mut self) {
        let mut policy = NoticePolicy::default();
        let mut unauthorized = false;
        // A fixed cadence: the work (health probe, POST with retries, notices) no longer adds
        // to the pause, so the gap between pings is `interval` unless the work itself took
        // longer (then `Delay` schedules the next tick a full period after the late one).
        let mut ticker = tokio::time::interval(self.interval);
        ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            tokio::select! {
                _ = self.shutdown.cancelled() => break,
                _ = ticker.tick() => {}
            }
            self.poll_server_health().await;
            match self.ping(&mut policy).await {
                PingOutcome::Continue => {}
                PingOutcome::Unauthorized => {
                    if !unauthorized {
                        unauthorized = true;
                        tracing::error!("sandbox token rejected; the server keeps running");
                        self.state.set_error("sandbox token rejected");
                        self.state.set_status(HealthStatus::Degraded);
                    }
                }
                PingOutcome::Retired => {
                    tracing::error!("sandbox retired; stopping the activity relay");
                    self.state.set_error("sandbox retired");
                    break;
                }
                PingOutcome::Stop => {
                    tracing::warn!("stop_directive");
                    self.shutdown.cancel();
                    break;
                }
            }
        }
        self.reap_post_attach().await;
    }

    /// On shutdown, gives a running `postAttachCommand` [`POST_ATTACH_CANCEL_GRACE`] to kill its
    /// process group (`run_command` does that as soon as the token fires) and aborts it
    /// otherwise. When the loop ended for another reason (410) the task is left to finish.
    async fn reap_post_attach(&mut self) {
        let Some(mut task) = self.post_attach_task.take() else {
            return;
        };
        if !self.shutdown.is_cancelled() {
            return;
        }
        if tokio::time::timeout(POST_ATTACH_CANCEL_GRACE, &mut task)
            .await
            .is_err()
        {
            task.abort();
        }
    }

    /// Refreshes `state.server_health` (the probe has its own 3 s timeout) and, on the first
    /// attached session of this boot, spawns `postAttachCommand` as its own task so the ping
    /// cadence – and the `busy: true` it reports meanwhile – is never blocked by it. While no
    /// child is running there is nothing to probe and no health to keep (`mark_server_exited`
    /// cleared it), so the report says `sessionActive: false`.
    async fn poll_server_health(&mut self) {
        if !self.state.read(|inner| inner.server.running) {
            self.state.update(|inner| inner.server_health = None);
            return;
        }
        let health = match self.server.health().await {
            Ok(health) => health,
            Err(error) => {
                tracing::debug!(error = %error, "server health probe failed");
                return;
            }
        };
        self.accept_health(health);
    }

    /// Records one `/health` body and starts `postAttachCommand` on the first attached session.
    fn accept_health(&mut self, health: ServerHealth) {
        let attached = health.session_active;
        let first_attach = self.state.read(|inner| attached && !inner.session_seen);
        self.state.update(|inner| {
            inner.server_health = Some(health);
            if attached {
                inner.session_seen = true;
            }
        });
        // A `/health` answer is proof the child is accepting.
        self.state.mark_server_listening();
        if first_attach && let Some(plan) = self.post_attach.get() {
            self.spawn_post_attach(plan.clone());
        }
    }

    fn spawn_post_attach(&mut self, plan: PostAttach) {
        let cwd = self.manifest.workspace_dir.clone();
        let logs = self.logs.clone();
        let state = self.state.clone();
        let shutdown = self.shutdown.clone();
        self.post_attach_task = Some(tokio::spawn(async move {
            tracing::info!("first session attached; running postAttachCommand");
            let result = crate::bootstrap::run_lifecycle(
                plan.specs,
                &cwd,
                &plan.env,
                crate::bootstrap::POST_ATTACH_TIMEOUT,
                crate::logs::LogSource::PostAttach,
                &logs,
                &state,
                &shutdown,
            )
            .await;
            match result {
                Ok(()) => tracing::info!("postAttachCommand finished"),
                Err(error) if error.downcast_ref::<Cancelled>().is_some() => {
                    tracing::info!("postAttachCommand stopped with the sandbox");
                }
                Err(error) => {
                    tracing::warn!(error = %error, "postAttachCommand failed");
                    state.set_error(format!("post_attach: {error}"));
                }
            }
        }));
    }

    /// One `POST /activity` plus the directive handling (§3.15 step 3).
    async fn ping(&mut self, policy: &mut NoticePolicy) -> PingOutcome {
        let now = crate::logs::now_ms();
        let snapshot = self.state.read(|inner| ReportSnapshot {
            status: inner.status,
            phase: inner.phase,
            busy: inner.busy_count > 0,
            agent_uptime_secs: inner.started_at.elapsed().as_secs(),
            server_health: inner.server_health.clone(),
        });
        // b9's schema takes at most MAX_LISTENING entries (a 400 beyond); the list is sorted by
        // port, so the lowest ports win.
        let listening: Vec<ListeningPortWire> = self
            .listening
            .current()
            .into_iter()
            .take(MAX_LISTENING)
            .map(|port| ListeningPortWire {
                port: port.port,
                pid: port.pid,
                process: port.process_name,
                loopback_only: port.loopback_only,
            })
            .collect();
        let cpu_busy_pct = self.cpu.sample();
        let report = build_report(now, &snapshot, cpu_busy_pct, listening);
        // The forward list this report was built from; a directive answering it must not undo
        // a `/ports` insert or remove that landed while the POST was in flight.
        let forwards_generation = self.forwards.generation();
        let directive = match self.control.activity(&report).await {
            Ok(directive) => directive,
            Err(ControlPlaneError::Unauthorized) => return PingOutcome::Unauthorized,
            Err(ControlPlaneError::Retired) => return PingOutcome::Retired,
            Err(error) => {
                tracing::warn!(error = %error, "activity ping failed");
                return PingOutcome::Continue;
            }
        };
        if let Some(forwards) = directive.forwards.clone()
            && !self
                .forwards
                .replace_if_unchanged(forwards, Some(forwards_generation))
        {
            tracing::debug!("forward list changed during the ping; directive list skipped");
        }
        // The control plane's clock wins over the sandbox's for the countdowns (D29); the
        // fallback is read *after* the round trip, which can span the retry budget.
        let reference = directive.server_time.unwrap_or_else(crate::logs::now_ms);
        for notice in policy.accept(&directive, reference) {
            if let Err(error) = self.server.post_lifecycle(&notice).await {
                tracing::warn!(error = %error, notice = ?notice, "lifecycle notice failed");
            }
        }
        if policy.stop_requested() {
            return PingOutcome::Stop;
        }
        PingOutcome::Continue
    }
}

/// The agent-state fields one activity report is built from.
#[derive(Clone, Debug)]
pub struct ReportSnapshot {
    /// Health status.
    pub status: HealthStatus,
    /// Boot phase.
    pub phase: Phase,
    /// A lifecycle command or the warm-up is running.
    pub busy: bool,
    /// Seconds since the agent started.
    pub agent_uptime_secs: u64,
    /// The last `/health` body from the server, if any.
    pub server_health: Option<ServerHealth>,
}

/// Builds the D13 report: `last_input_at = now` while `busy || phase != ready` (the workspace
/// counts as active whatever the server reports), the server's own value otherwise.
pub fn build_report<'a>(
    now: u64,
    snapshot: &'a ReportSnapshot,
    cpu_busy_pct: Option<f32>,
    listening: Vec<ListeningPortWire>,
) -> ActivityReport<'a> {
    let health = snapshot.server_health.as_ref();
    let bootstrapping = snapshot.busy || snapshot.phase != Phase::Ready;
    ActivityReport {
        last_input_at: if bootstrapping {
            Some(now)
        } else {
            health.and_then(|health| health.last_input_at)
        },
        session_active: health.is_some_and(|health| health.session_active),
        sid: health.and_then(|health| health.session_id()),
        server_uptime_secs: health.map(|health| health.uptime_secs).unwrap_or(0),
        agent_uptime_secs: snapshot.agent_uptime_secs,
        status: snapshot.status,
        cpu_busy_pct,
        busy: snapshot.busy,
        phase: snapshot.phase,
        listening,
    }
}

/// What the relay does after one ping.
#[derive(Debug, PartialEq, Eq)]
enum PingOutcome {
    /// Keep pinging.
    Continue,
    /// The token was rejected (health goes `degraded`, the loop continues).
    Unauthorized,
    /// The sandbox was retired; stop the loop.
    Retired,
    /// The control plane asked for a stop; run the shutdown path.
    Stop,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn directive(idle: Option<u64>, cap: Option<u64>, stop: bool) -> ActivityDirective {
        ActivityDirective {
            idle_stop_at: idle,
            session_cap_at: cap,
            stop,
            forwards: None,
            server_time: None,
        }
    }

    #[test]
    fn notice_policy() {
        let mut policy = NoticePolicy::default();
        let now = 1_000_000_000;
        let idle_at = now + 10 * 60 * 1000;
        assert!(
            policy
                .accept(&directive(Some(idle_at), None, false), now)
                .is_empty()
        );
        let later = idle_at - 4 * 60 * 1000;
        assert_eq!(
            policy.accept(&directive(Some(idle_at), None, false), later),
            vec![LifecycleBody::IdleStopIn { seconds: 240 }]
        );
        assert!(
            policy
                .accept(&directive(Some(idle_at), None, false), later + 1000)
                .is_empty()
        );
        let moved = idle_at + 60 * 1000;
        assert_eq!(
            policy.accept(&directive(Some(moved), None, false), later + 2000),
            vec![LifecycleBody::IdleStopIn { seconds: 298 }]
        );
        let cap_at = now + 20 * 60 * 1000;
        let notices = policy.accept(&directive(None, Some(cap_at), true), now);
        assert_eq!(notices, vec![LifecycleBody::SessionCapIn { seconds: 1200 }]);
        assert!(policy.stop_requested());
    }

    #[test]
    fn activity_report_carries_the_d13_fields() {
        let report = ActivityReport {
            last_input_at: Some(1_756_800_123_456),
            session_active: true,
            sid: Some("ses_1"),
            server_uptime_secs: 120,
            agent_uptime_secs: 130,
            status: HealthStatus::Ready,
            cpu_busy_pct: Some(12.5),
            busy: true,
            phase: Phase::PostCreate,
            listening: vec![ListeningPortWire {
                port: 3000,
                pid: 42,
                process: "node".to_string(),
                loopback_only: true,
            }],
        };
        let json = serde_json::to_value(&report).unwrap();
        assert_eq!(json["lastInputAt"], 1_756_800_123_456u64);
        assert_eq!(json["sessionActive"], true);
        assert_eq!(json["sid"], "ses_1");
        assert_eq!(json["status"], "ready");
        assert_eq!(json["busy"], true);
        assert_eq!(json["phase"], "post_create");
        assert_eq!(json["cpuBusyPct"], 12.5);
        assert_eq!(json["listening"][0]["process"], "node");
        assert_eq!(json["listening"][0]["loopbackOnly"], true);
        // The first ping has no CPU sample and omits the key rather than sending null.
        let first = ActivityReport {
            cpu_busy_pct: None,
            sid: None,
            ..report
        };
        let json = serde_json::to_value(&first).unwrap();
        assert!(json.get("cpuBusyPct").is_none());
        assert!(json.get("sid").is_none());
    }

    #[test]
    fn cpu_stat_line() {
        assert_eq!(
            CpuSampler::parse_stat_line("cpu  100 0 50 800 50 0 0 0 0 0"),
            Some((150, 1000))
        );
        assert_eq!(
            CpuSampler::parse_stat_line("cpu  100 0 100 700 100 0 0 0 0 0"),
            Some((200, 1000))
        );
        assert_eq!(CpuSampler::parse_stat_line("cpu0 1 2 3 4 5 6 7 8"), None);
        assert_eq!(CpuSampler::parse_stat_line("intr 1 2"), None);
        assert_eq!(CpuSampler::parse_stat_line("cpu 1 2"), None);
    }

    #[test]
    fn cpu_sampler_needs_two_samples() {
        let mut sampler = CpuSampler::default();
        assert_eq!(
            sampler.observe((200, 1000)),
            None,
            "the first sample has no delta"
        );
        // 100 busy jiffies out of 200 elapsed → 50 %.
        assert_eq!(sampler.observe((300, 1200)), Some(50.0));
        // No time passed: no percentage rather than a division by zero.
        assert_eq!(sampler.observe((300, 1200)), None);
        assert_eq!(sampler.observe((400, 1300)), Some(100.0));
    }

    #[test]
    fn stop_directive_once() {
        let mut policy = NoticePolicy::default();
        let now = 1_000_000_000;
        assert!(policy.accept(&directive(None, None, true), now).is_empty());
        assert!(policy.stop_requested());
        // A second `stop: true` neither re-triggers anything nor emits a `Stopping` body: the
        // stop path posts that exactly once itself.
        let again = policy.accept(&directive(None, None, true), now + 1000);
        assert!(again.is_empty());
        assert!(policy.stop_requested());
        assert!(
            !again.iter().any(|n| matches!(n, LifecycleBody::Stopping)),
            "the policy never emits Stopping"
        );
    }

    fn health(last_input_at: Option<u64>) -> ServerHealth {
        ServerHealth {
            build: "b1".to_string(),
            version: "b1+x".to_string(),
            uptime_secs: 42,
            session_active: true,
            last_input_at,
            session: Some(serde_json::json!({ "session_id": "ses_9" })),
            dirty_buffers: Some(0),
        }
    }

    #[test]
    fn ping_marks_busy_active() {
        let now = 1_756_800_999_000u64;
        let mut snapshot = ReportSnapshot {
            status: HealthStatus::Ready,
            phase: Phase::PostCreate,
            busy: true,
            agent_uptime_secs: 7,
            server_health: Some(health(Some(1))),
        };
        // Busy → the workspace is active now, whatever the server last saw.
        let report = build_report(now, &snapshot, Some(3.5), vec![]);
        assert_eq!(report.last_input_at, Some(now));
        assert!(report.busy);
        assert_eq!(report.sid, Some("ses_9"));
        let json = serde_json::to_value(&report).unwrap();
        assert_eq!(json["busy"], true);
        assert_eq!(json["phase"], "post_create");
        assert_eq!(json["cpuBusyPct"], 3.5);
        // Not busy but not ready either (still cloning) → still active.
        snapshot.busy = false;
        snapshot.phase = Phase::Clone;
        assert_eq!(
            build_report(now, &snapshot, None, vec![]).last_input_at,
            Some(now)
        );
        // Ready and idle → the server's own value wins (or null when the server has none).
        snapshot.phase = Phase::Ready;
        assert_eq!(
            build_report(now, &snapshot, None, vec![]).last_input_at,
            Some(1)
        );
        snapshot.server_health = Some(health(None));
        let report = build_report(now, &snapshot, None, vec![]);
        assert_eq!(report.last_input_at, None);
        assert_eq!(report.server_uptime_secs, 42);
        snapshot.server_health = None;
        let report = build_report(now, &snapshot, None, vec![]);
        assert_eq!(report.last_input_at, None);
        assert!(!report.session_active);
        assert_eq!(report.sid, None);
    }

    #[test]
    fn lifecycle_body_kinds_are_snake_case() {
        assert_eq!(
            serde_json::to_string(&LifecycleBody::IdleStopIn { seconds: 300 }).unwrap(),
            r#"{"kind":"idle_stop_in","seconds":300}"#
        );
        assert_eq!(
            serde_json::to_string(&LifecycleBody::Stopping).unwrap(),
            r#"{"kind":"stopping"}"#
        );
        assert_eq!(
            serde_json::to_string(&LifecycleBody::Resumed).unwrap(),
            r#"{"kind":"resumed"}"#
        );
    }
}
