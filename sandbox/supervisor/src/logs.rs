//! Log batching, scrubbing and shipping (brief §3.6; b9 §4.2).
//!
//! b9 ingests one JSON `LogBatch` per request: `{ workspaceId, sandboxName, sessionId, build,
//! entries: [{ ts, level, source, msg, fields? }] }`, ≤ 200 entries and ≤ 256 KiB (413 above),
//! answers 204. `sessionId` is `manifest.session.id` (the Vercel sandbox session; D1's per-connect
//! `sid` travels inside `fields`). Agent logs are also written to stderr as JSON lines so the
//! control plane's `runCommand({ stderr })` sees them.

use std::borrow::Cow;
use std::collections::{BTreeMap, VecDeque};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, LazyLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use base64::Engine as _;
use bytes::Bytes;
use parking_lot::{Mutex, RwLock};
use regex::Regex;
use tokio::io::{AsyncBufRead, AsyncBufReadExt as _, AsyncRead};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;
use tracing_subscriber::Registry;
use tracing_subscriber::fmt::MakeWriter;
use tracing_subscriber::layer::{Context, Layer};

use crate::control_plane::{ControlPlane, ControlPlaneError};

/// Default flush interval; `manifest.logs.flushIntervalSecs` wins.
pub const FLUSH_INTERVAL: Duration = Duration::from_secs(5);
/// Ceiling on entries per batch; `manifest.logs.maxBatch` may lower it.
pub const MAX_BATCH_LINES: usize = 200;
/// Ceiling on bytes per batch (b9's 413 limit); `manifest.logs.maxBatchBytes` may lower it.
pub const MAX_BATCH_BYTES: usize = 256 * 1024;
/// Cap on one pumped line: the first 64 KiB ship with `fields.truncated = true` and the rest of
/// the line is discarded (a deliberate simplification of the brief's "split into pieces": `msg`
/// is capped at [`MAX_MSG_BYTES`] anyway, so continuation pieces would carry nothing useful).
pub const MAX_LINE_BYTES: usize = 64 * 1024;
/// `msg` is truncated with `…[+N bytes]` beyond this.
pub const MAX_MSG_BYTES: usize = 8 * 1024;
/// Queue ceiling in lines while the control plane is unreachable (oldest dropped beyond).
pub const MAX_QUEUE_LINES: usize = 5_000;
/// Queue ceiling in bytes while the control plane is unreachable (oldest dropped beyond).
pub const MAX_QUEUE_BYTES: usize = 8 * 1024 * 1024;
/// Token bucket per source; excess lines are counted, not shipped (BUILD-SPEC §7.3).
pub const PER_SOURCE_RATE: (usize, Duration) = (200, Duration::from_secs(1));
/// Cap on one structured field value of an agent entry (after [`scrub`]); larger values are cut
/// with the [`truncate_msg`] marker so a control-plane error body or a `Debug` dump can never
/// grow an entry past the batch ceiling.
pub const MAX_FIELD_BYTES: usize = 1024;
/// Cap on the number of structured fields shipped with one agent entry.
pub const MAX_FIELDS: usize = 32;
/// Secret values shorter than this are not registered for redaction: redacting every `1` or
/// `true` in the logs would destroy them for no gain.
pub const MIN_SECRET_LEN: usize = 8;
/// After this many consecutive accepted batches a batch size halved by a 413 grows back one step
/// (until the configured ceiling), so one oversized entry does not throttle the rest of the boot.
pub const BATCH_RECOVERY_SUCCESSES: u32 = 20;

/// One shipped log line.
#[derive(Clone, Debug, serde::Serialize)]
pub struct LogEntry {
    /// Unix ms.
    pub ts: u64,
    /// `"error" | "warn" | "info" | "debug" | "trace"`.
    pub level: &'static str,
    /// `"server" | "agent" | "post_create" | "post_start" | "post_attach" | "dotfiles" | "proxy" |
    /// "prebuild" | "warm"`, or `"server:<module_path>"` when the server line carries one.
    pub source: String,
    /// ≤ [`MAX_MSG_BYTES`] after [`scrub`].
    pub msg: String,
    /// `sid`, `epoch`, `truncated`, `dropped`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fields: Option<serde_json::Map<String, serde_json::Value>>,
}

/// `POST …/logs` body.
#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LogBatch<'a> {
    /// Workspace id.
    pub workspace_id: &'a str,
    /// Sandbox name.
    pub sandbox_name: &'a str,
    /// `manifest.session.id`.
    pub session_id: &'a str,
    /// Image build id.
    pub build: &'a str,
    /// The entries.
    pub entries: &'a [LogEntry],
}

/// Where a pumped line came from.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LogSource {
    /// `zed-remote-server` stderr.
    Server,
    /// The agent's own tracing events.
    Agent,
    /// `postCreateCommand` output.
    PostCreate,
    /// `postStartCommand` output.
    PostStart,
    /// `postAttachCommand` output.
    PostAttach,
    /// Dotfiles installer output.
    Dotfiles,
    /// Private-port proxy events.
    Proxy,
    /// Prebuild steps.
    Prebuild,
    /// LSP warm-up client.
    Warm,
    /// The manifest's optional services (`dockerd`; b10 §3.16, CONTRACTS §7.6).
    Services,
}

impl LogSource {
    /// Wire name of the source.
    pub fn as_str(self) -> &'static str {
        match self {
            LogSource::Server => "server",
            LogSource::Agent => "agent",
            LogSource::PostCreate => "post_create",
            LogSource::PostStart => "post_start",
            LogSource::PostAttach => "post_attach",
            LogSource::Dotfiles => "dotfiles",
            LogSource::Proxy => "proxy",
            LogSource::Prebuild => "prebuild",
            LogSource::Warm => "warm",
            LogSource::Services => "services",
        }
    }
}

/// Current unix time in milliseconds (0 before the epoch, which never happens).
pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// b2's `ServeLogRecord` subset.
#[derive(serde::Deserialize)]
struct ServeLogRecord {
    ts_ms: Option<u64>,
    level: Option<u8>,
    module_path: Option<String>,
    message: Option<String>,
    session_id: Option<String>,
    epoch: Option<u64>,
}

/// Converts one server stderr line: JSON objects following b2's `ServeLogRecord` (`ts_ms`,
/// `level` 1..=5, `message`, `module_path`, `session_id`, `epoch`) are mapped; anything else
/// becomes an `info` entry with the raw text. Always passes through [`scrub`].
pub fn entry_from_server(line: &str, now_ms: u64) -> LogEntry {
    let trimmed = line.trim_end();
    if trimmed.starts_with('{')
        && let Ok(record) = serde_json::from_str::<ServeLogRecord>(trimmed)
        && let Some(message) = record.message
    {
        let mut fields = serde_json::Map::new();
        if let Some(sid) = record.session_id {
            fields.insert("sid".to_string(), serde_json::Value::String(sid));
        }
        if let Some(epoch) = record.epoch {
            fields.insert("epoch".to_string(), serde_json::Value::from(epoch));
        }
        let source = match record.module_path {
            Some(module) if !module.is_empty() => format!("server:{module}"),
            _ => "server".to_string(),
        };
        return LogEntry {
            ts: record.ts_ms.unwrap_or(now_ms),
            level: level_name(record.level.unwrap_or(3)),
            source,
            msg: truncate_msg(scrub(&message)),
            fields: (!fields.is_empty()).then_some(fields),
        };
    }
    LogEntry {
        ts: now_ms,
        level: "info",
        source: "server".to_string(),
        msg: truncate_msg(scrub(trimmed)),
        fields: None,
    }
}

/// b2 numeric levels (`log::Level` order) to wire names.
pub fn level_name(level: u8) -> &'static str {
    match level {
        1 => "error",
        2 => "warn",
        3 => "info",
        4 => "debug",
        5 => "trace",
        _ => "info",
    }
}

/// Truncates `msg` to [`MAX_MSG_BYTES`] on a char boundary, appending `…[+N bytes]`.
pub fn truncate_msg(msg: Cow<'_, str>) -> String {
    truncate_with_marker(msg, MAX_MSG_BYTES)
}

/// Truncates `text` to at most `max` bytes on a char boundary, appending `…[+N bytes]` when
/// anything was cut. `max` is the cut point, so the result may exceed it by the marker.
pub fn truncate_with_marker(text: Cow<'_, str>, max: usize) -> String {
    if text.len() <= max {
        return text.into_owned();
    }
    let cut = floor_char_boundary(&text, max);
    let extra = text.len() - cut;
    format!("{}…[+{extra} bytes]", &text[..cut])
}

/// Shortens `text` in place to at most `max` bytes without ever splitting a char (the
/// `String::truncate` precondition that panics – and with `panic = "abort"` kills the agent –
/// when a multi-byte char straddles the cut).
pub fn truncate_at_boundary(text: &mut String, max: usize) {
    if text.len() > max {
        let cut = floor_char_boundary(text, max);
        text.truncate(cut);
    }
}

/// The largest char boundary `<= index` (`index` itself when it is one or is past the end).
fn floor_char_boundary(text: &str, index: usize) -> usize {
    if index >= text.len() {
        return text.len();
    }
    let mut cut = index;
    while !text.is_char_boundary(cut) {
        cut -= 1;
    }
    cut
}

static SCRUB_PATTERNS: LazyLock<Vec<Regex>> = LazyLock::new(|| {
    [
        r"gh[pousr]_[A-Za-z0-9]{20,}",
        r"github_pat_[A-Za-z0-9_]{20,}",
        r"zsb_[A-Za-z0-9_-]{20,}",
        r"eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}",
        r"v1\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}",
        r"(?i)bearer\s+[A-Za-z0-9._~+/=-]{16,}",
        r"x-access-token:[^@\s]+@",
        r"zs_port_token=[^&\s]+",
        r"zs_port_session=[^;\s]+",
        r"(?i)x-vercel-protection-bypass:\s*\S+",
        r"[?&]token=[^&\s]+",
    ]
    .into_iter()
    .map(|pattern| Regex::new(pattern).expect("static scrub pattern compiles"))
    .collect()
});

/// Secret **values** to redact by exact match, longest first (so a value that contains another
/// is replaced whole). Filled by [`register_secret_values`] once the manifest names the secrets;
/// empty until then.
static SECRET_VALUES: LazyLock<RwLock<Vec<String>>> = LazyLock::new(|| RwLock::new(Vec::new()));

/// Registers secret values for redaction by [`scrub`]. Shape matching cannot catch a user's
/// `DATABASE_URL` or API key (BUILD-SPEC §10 item 4 promises scrubbed logs, and every lifecycle
/// command runs with those secrets in its environment), but the supervisor holds both the names
/// (`manifest.secretNames`) and the values (its own environment), so it redacts them verbatim
/// plus their base64 (standard and URL-safe) and percent-encoded forms. Values shorter than
/// [`MIN_SECRET_LEN`] are ignored. Cumulative across calls; duplicates are dropped.
pub fn register_secret_values(values: impl IntoIterator<Item = String>) {
    let mut registry = SECRET_VALUES.write();
    for value in values {
        if value.len() < MIN_SECRET_LEN {
            continue;
        }
        let mut forms = vec![
            value.clone(),
            base64::engine::general_purpose::STANDARD.encode(&value),
            base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(&value),
            percent_encode_value(&value),
        ];
        forms.retain(|form| form.len() >= MIN_SECRET_LEN);
        for form in forms {
            if !registry.contains(&form) {
                registry.push(form);
            }
        }
    }
    registry.sort_by(|a, b| b.len().cmp(&a.len()).then_with(|| a.cmp(b)));
}

/// Number of registered secret forms (tests and diagnostics; never the values).
pub fn registered_secret_count() -> usize {
    SECRET_VALUES.read().len()
}

/// `encodeURIComponent`-style percent encoding (RFC 3986 unreserved characters kept).
fn percent_encode_value(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'.' | b'_' | b'~') {
            out.push(byte as char);
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

/// Redacts token shapes: GitHub tokens (`gh[pousr]_…`, `github_pat_…`), sandbox tokens
/// (`zsb_…`), JWTs, `v1.<b64>.<b64>` port tokens and cookies, `Bearer …`, `x-access-token:…@`,
/// `zs_port_token=`, `zs_port_session=`, `x-vercel-protection-bypass:` and `?token=` (presigned
/// Blob URLs) → `[redacted]`; then every value registered with [`register_secret_values`].
pub fn scrub(message: &str) -> Cow<'_, str> {
    let mut current = Cow::Borrowed(message);
    for pattern in SCRUB_PATTERNS.iter() {
        if pattern.is_match(&current) {
            let replaced = pattern.replace_all(&current, "[redacted]").into_owned();
            current = Cow::Owned(replaced);
        }
    }
    let secrets = SECRET_VALUES.read();
    for secret in secrets.iter() {
        if current.contains(secret.as_str()) {
            let replaced = current.replace(secret.as_str(), "[redacted]");
            current = Cow::Owned(replaced);
        }
    }
    current
}

/// Batching parameters, known once the manifest is.
#[derive(Clone, Debug)]
pub struct LogShipperConfig {
    /// Flush interval.
    pub flush_interval: Duration,
    /// Entries per batch.
    pub max_batch: usize,
    /// Bytes per batch.
    pub max_batch_bytes: usize,
    /// `LogBatch.workspaceId`.
    pub workspace_id: String,
    /// `LogBatch.sandboxName`.
    pub sandbox_name: String,
    /// `LogBatch.sessionId`.
    pub session_id: String,
    /// `LogBatch.build`.
    pub build: String,
}

/// Producer handle: cheap to clone, never blocks.
#[derive(Clone)]
pub struct LogShipper {
    tx: mpsc::Sender<LogEntry>,
    config: Arc<Mutex<Option<LogShipperConfig>>>,
    dropped: Arc<AtomicU64>,
}

/// Owner handle for the batching task; consumed by the final flush.
pub struct LogShipperHandle {
    task: tokio::task::JoinHandle<()>,
    /// Cancelled by [`LogShipperHandle::flush`]; a token (not a `Notify`) so a stop request that
    /// lands while the batcher is inside an HTTP POST is not lost.
    stop: CancellationToken,
}

impl LogShipper {
    /// Spawns the batching task: flush on `max_batch`, `max_batch_bytes`, or every
    /// `flush_interval`; failed POSTs re-queue (bounded); a 413 halves the batch size (growing
    /// back after [`BATCH_RECOVERY_SUCCESSES`] accepted batches) and a 413 on a batch of one
    /// drops that entry. Entries pushed before `configure` runs are held in the queue.
    pub fn start(control: ControlPlane, build: String) -> (Self, LogShipperHandle) {
        let (tx, rx) = mpsc::channel::<LogEntry>(MAX_QUEUE_LINES);
        let config = Arc::new(Mutex::new(None));
        let dropped = Arc::new(AtomicU64::new(0));
        let stop = CancellationToken::new();
        let batcher = Batcher {
            control,
            build,
            config: config.clone(),
            dropped: dropped.clone(),
            queue: VecDeque::new(),
            queue_bytes: 0,
            max_batch: MAX_BATCH_LINES,
            successes: 0,
            buckets: BTreeMap::new(),
            reported_dropped: 0,
        };
        let task = tokio::spawn(batcher.run(rx, stop.clone()));
        (
            Self {
                tx,
                config,
                dropped,
            },
            LogShipperHandle { task, stop },
        )
    }

    /// Sets the batch identity and limits once, after the manifest.
    pub fn configure(&self, config: LogShipperConfig) {
        *self.config.lock() = Some(config);
    }

    /// Current configuration, if `configure` has run.
    pub fn config(&self) -> Option<LogShipperConfig> {
        self.config.lock().clone()
    }

    /// `try_send`; drops with a counter when the channel is full.
    pub fn push(&self, entry: LogEntry) {
        if self.tx.try_send(entry).is_err() {
            self.dropped.fetch_add(1, Ordering::Relaxed);
        }
    }

    /// Entries dropped so far because the queue was full.
    pub fn dropped(&self) -> u64 {
        self.dropped.load(Ordering::Relaxed)
    }

    /// A `tracing_subscriber` layer turning the agent's own `tracing::*` events into
    /// `source: "agent"` entries.
    pub fn tracing_layer(&self) -> impl Layer<Registry> + Send + Sync + use<> {
        ShipperLayer {
            shipper: self.clone(),
        }
    }

    /// Pumps a child's stdout/stderr into `push` with the given source. Lines longer than
    /// [`MAX_LINE_BYTES`] ship their head with `fields.truncated = true` and the rest is dropped,
    /// so one runaway line can never grow the agent's memory.
    pub async fn pump<R: AsyncRead + Unpin>(&self, reader: R, source: LogSource) {
        self.pump_observed(reader, source, |_| {}).await;
    }

    /// [`LogShipper::pump`] with a hook that sees every raw line first: the server supervisor uses
    /// it to keep the crash tail (§3.9) without reading the stream twice.
    pub async fn pump_observed<R: AsyncRead + Unpin>(
        &self,
        reader: R,
        source: LogSource,
        mut observe: impl FnMut(&str),
    ) {
        let mut reader = tokio::io::BufReader::new(reader);
        let mut line = Vec::with_capacity(1024);
        while let Ok(Some(truncated)) = read_line_capped(&mut reader, &mut line).await {
            let text = String::from_utf8_lossy(&line);
            observe(&text);
            let mut entry = match source {
                LogSource::Server => entry_from_server(&text, now_ms()),
                other => LogEntry {
                    ts: now_ms(),
                    level: "info",
                    source: other.as_str().to_string(),
                    msg: truncate_msg(scrub(&text)),
                    fields: None,
                },
            };
            if truncated {
                entry
                    .fields
                    .get_or_insert_with(serde_json::Map::new)
                    .insert("truncated".to_string(), serde_json::Value::Bool(true));
            }
            self.push(entry);
        }
    }
}

/// Reads one `\n`-terminated line into `out` (cleared first), keeping at most [`MAX_LINE_BYTES`]
/// and discarding the rest of an over-long line. `Ok(None)` at end of input with nothing buffered;
/// `Ok(Some(truncated))` otherwise.
async fn read_line_capped<R: AsyncBufRead + Unpin>(
    reader: &mut R,
    out: &mut Vec<u8>,
) -> std::io::Result<Option<bool>> {
    out.clear();
    let mut truncated = false;
    let mut saw_input = false;
    loop {
        let available = match reader.fill_buf().await {
            Ok(buffer) => buffer,
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(error) => return Err(error),
        };
        if available.is_empty() {
            return Ok(saw_input.then_some(truncated));
        }
        saw_input = true;
        let (chunk, consumed, done) = match available.iter().position(|byte| *byte == b'\n') {
            Some(index) => (&available[..index], index + 1, true),
            None => {
                let len = available.len();
                (available, len, false)
            }
        };
        let room = MAX_LINE_BYTES.saturating_sub(out.len());
        if chunk.len() > room {
            out.extend_from_slice(&chunk[..room]);
            truncated = true;
        } else {
            out.extend_from_slice(chunk);
        }
        reader.consume(consumed);
        if done {
            return Ok(Some(truncated));
        }
    }
}

impl LogShipperHandle {
    /// Final flush with a hard deadline (used on SIGTERM): the batching task is asked to stop,
    /// drains what is queued and ships it, and is abandoned when `deadline` passes. Returns
    /// `true` when the task finished inside the deadline.
    pub async fn flush(self, deadline: Duration) -> bool {
        self.stop.cancel();
        if tokio::time::timeout(deadline, self.task).await.is_err() {
            tracing::warn!(
                deadline_ms = deadline.as_millis() as u64,
                "log flush deadline passed; dropping the remaining queue"
            );
            return false;
        }
        true
    }
}

/// Envelope overhead of a [`LogBatch`] around its entries (identity fields plus JSON syntax).
const BATCH_ENVELOPE_BYTES: usize = 512;

/// The batching task behind [`LogShipper`].
struct Batcher {
    control: ControlPlane,
    build: String,
    config: Arc<Mutex<Option<LogShipperConfig>>>,
    dropped: Arc<AtomicU64>,
    queue: VecDeque<(LogEntry, usize)>,
    queue_bytes: usize,
    /// Halved when the control plane answers 413; grows back one step per
    /// [`BATCH_RECOVERY_SUCCESSES`] accepted batches.
    max_batch: usize,
    /// Accepted batches since the last 413 (or the last recovery step).
    successes: u32,
    /// Per-source token bucket: source → (window start, lines this window).
    buckets: BTreeMap<String, (Instant, usize)>,
    /// Drops already reported as an `agent` entry.
    reported_dropped: u64,
}

impl Batcher {
    async fn run(mut self, mut rx: mpsc::Receiver<LogEntry>, stop: CancellationToken) {
        let mut next_flush = Instant::now() + self.flush_interval();
        loop {
            let stopped = tokio::select! {
                entry = rx.recv() => match entry {
                    Some(entry) => {
                        self.enqueue(entry);
                        if self.batch_ready() {
                            self.flush().await;
                            next_flush = Instant::now() + self.flush_interval();
                        }
                        false
                    }
                    None => true,
                },
                _ = tokio::time::sleep_until(next_flush.into()) => {
                    self.flush().await;
                    next_flush = Instant::now() + self.flush_interval();
                    false
                }
                _ = stop.cancelled() => true,
            };
            // A stop that arrived while a flush was in flight is seen here, not lost.
            if stopped || stop.is_cancelled() {
                break;
            }
        }
        rx.close();
        while let Ok(entry) = rx.try_recv() {
            self.enqueue(entry);
        }
        self.drain().await;
    }

    /// Ships everything still queued, one batch per iteration, and stops at the first failed
    /// POST. Without a configuration (the boot never got a manifest) nothing can be shipped, so
    /// the queue is counted as dropped and released instead of being spun on forever.
    async fn drain(&mut self) {
        // Every configured `flush` pops at least one entry, so this bound is never reached; it
        // is a guard against ever turning the shutdown path into a busy loop again.
        let mut remaining_rounds = MAX_QUEUE_LINES + 1;
        while !self.queue.is_empty() && remaining_rounds > 0 {
            remaining_rounds -= 1;
            if self.settings().is_none() {
                let dropped = self.queue.len() as u64;
                self.queue.clear();
                self.queue_bytes = 0;
                self.dropped.fetch_add(dropped, Ordering::Relaxed);
                tracing::debug!(dropped, "log shipper stopped before it was configured");
                break;
            }
            if !self.flush().await {
                break;
            }
        }
    }

    fn settings(&self) -> Option<LogShipperConfig> {
        self.config.lock().clone()
    }

    fn flush_interval(&self) -> Duration {
        self.settings()
            .map(|config| config.flush_interval)
            .unwrap_or(FLUSH_INTERVAL)
    }

    fn batch_ready(&self) -> bool {
        let (max_batch, max_bytes) = match self.settings() {
            Some(config) => (
                self.max_batch.min(config.max_batch),
                config.max_batch_bytes.min(MAX_BATCH_BYTES),
            ),
            None => return false,
        };
        self.queue.len() >= max_batch.max(1)
            || self.queue_bytes + BATCH_ENVELOPE_BYTES >= max_bytes.max(1)
    }

    /// Applies the per-source rate limit and the queue ceilings, counting every drop.
    fn enqueue(&mut self, entry: LogEntry) {
        if !self.allow(&entry.source) {
            self.dropped.fetch_add(1, Ordering::Relaxed);
            return;
        }
        let size = entry_size(&entry);
        self.queue.push_back((entry, size));
        self.queue_bytes += size;
        while self.queue.len() > MAX_QUEUE_LINES || self.queue_bytes > MAX_QUEUE_BYTES {
            match self.queue.pop_front() {
                Some((_, size)) => {
                    self.queue_bytes = self.queue_bytes.saturating_sub(size);
                    self.dropped.fetch_add(1, Ordering::Relaxed);
                }
                None => break,
            }
        }
    }

    /// [`PER_SOURCE_RATE`] token bucket keyed by `source`.
    fn allow(&mut self, source: &str) -> bool {
        let (limit, window) = PER_SOURCE_RATE;
        let now = Instant::now();
        let bucket = self
            .buckets
            .entry(source.to_string())
            .or_insert((now, 0usize));
        if now.duration_since(bucket.0) >= window {
            *bucket = (now, 0);
        }
        if bucket.1 >= limit {
            return false;
        }
        bucket.1 += 1;
        true
    }

    /// One `agent` entry per flush counting the lines dropped since the previous one.
    fn note_drops(&mut self) {
        let dropped = self.dropped.load(Ordering::Relaxed);
        if dropped <= self.reported_dropped {
            return;
        }
        let delta = dropped - self.reported_dropped;
        self.reported_dropped = dropped;
        let mut fields = serde_json::Map::new();
        fields.insert("dropped".to_string(), serde_json::Value::from(delta));
        let entry = LogEntry {
            ts: now_ms(),
            level: "warn",
            source: LogSource::Agent.as_str().to_string(),
            msg: format!("dropped {delta} log lines"),
            fields: Some(fields),
        };
        let size = entry_size(&entry);
        self.queue.push_back((entry, size));
        self.queue_bytes += size;
    }

    /// Ships at most one batch. `false` means the batch failed and was re-queued.
    async fn flush(&mut self) -> bool {
        self.note_drops();
        let Some(config) = self.settings() else {
            return true;
        };
        if self.queue.is_empty() {
            return true;
        }
        let max_batch = self.max_batch.min(config.max_batch).max(1);
        let max_bytes = config.max_batch_bytes.clamp(1024, MAX_BATCH_BYTES);
        let mut entries = Vec::new();
        let mut bytes = BATCH_ENVELOPE_BYTES;
        while entries.len() < max_batch {
            let Some((_, size)) = self.queue.front() else {
                break;
            };
            if !entries.is_empty() && bytes + size > max_bytes {
                break;
            }
            let Some((entry, size)) = self.queue.pop_front() else {
                break;
            };
            bytes += size;
            self.queue_bytes = self.queue_bytes.saturating_sub(size);
            entries.push(entry);
        }
        let batch = LogBatch {
            workspace_id: &config.workspace_id,
            sandbox_name: &config.sandbox_name,
            session_id: &config.session_id,
            build: if config.build.is_empty() {
                &self.build
            } else {
                &config.build
            },
            entries: &entries,
        };
        match self.control.logs(&batch).await {
            Ok(()) => {
                self.note_success(config.max_batch);
                true
            }
            Err(error) => {
                if let ControlPlaneError::Status { status: 413, .. } = &error {
                    self.successes = 0;
                    if entries.len() <= 1 {
                        // One entry the control plane will never take: re-queueing it would
                        // pin the head of the queue forever (a batch of one that is 413'd
                        // again and again) while every later line waits behind it. Count it
                        // as dropped and move on.
                        self.dropped
                            .fetch_add(entries.len() as u64, Ordering::Relaxed);
                        tracing::debug!(
                            bytes,
                            "dropping a log entry the control plane refuses as too large"
                        );
                        return false;
                    }
                    self.max_batch = (max_batch / 2).max(1);
                }
                self.requeue(entries);
                false
            }
        }
    }

    /// Grows a 413-halved batch size back towards `ceiling` after
    /// [`BATCH_RECOVERY_SUCCESSES`] accepted batches, one doubling at a time.
    fn note_success(&mut self, ceiling: usize) {
        let ceiling = ceiling.clamp(1, MAX_BATCH_LINES);
        if self.max_batch >= ceiling {
            self.successes = 0;
            return;
        }
        self.successes += 1;
        if self.successes >= BATCH_RECOVERY_SUCCESSES {
            self.successes = 0;
            self.max_batch = (self.max_batch * 2).min(ceiling);
        }
    }

    /// Puts a failed batch back at the head of the queue, trimming to the ceilings.
    fn requeue(&mut self, entries: Vec<LogEntry>) {
        for entry in entries.into_iter().rev() {
            let size = entry_size(&entry);
            self.queue.push_front((entry, size));
            self.queue_bytes += size;
        }
        while self.queue.len() > MAX_QUEUE_LINES || self.queue_bytes > MAX_QUEUE_BYTES {
            match self.queue.pop_front() {
                Some((_, size)) => {
                    self.queue_bytes = self.queue_bytes.saturating_sub(size);
                    self.dropped.fetch_add(1, Ordering::Relaxed);
                }
                None => break,
            }
        }
    }
}

/// Encoded size of one entry inside a batch (plus its separator).
fn entry_size(entry: &LogEntry) -> usize {
    serde_json::to_vec(entry)
        .map(|bytes| bytes.len())
        .unwrap_or(entry.msg.len() + entry.source.len() + 64)
        + 1
}

/// `serde_json` encoding of a batch; the caller checks `max_batch_bytes` and splits.
pub fn encode_batch(batch: &LogBatch<'_>) -> Bytes {
    Bytes::from(serde_json::to_vec(batch).expect("LogBatch serialises"))
}

/// Installs the global subscriber: `RUST_LOG` filter (default `info`), JSON lines on stderr, and
/// – when a shipper is given – its layer so agent events also reach the control plane. A second
/// call is a no-op.
pub fn init_tracing(shipper: Option<&LogShipper>) {
    use tracing_subscriber::layer::SubscriberExt as _;
    use tracing_subscriber::util::SubscriberInitExt as _;
    let filter = tracing_subscriber::EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info"));
    let fmt = tracing_subscriber::fmt::layer()
        .json()
        .with_writer(ScrubStderr);
    let _ = Registry::default()
        .with(shipper.map(LogShipper::tracing_layer))
        .with(filter)
        .with(fmt)
        .try_init();
}

struct ShipperLayer {
    shipper: LogShipper,
}

/// Collects one event's `message` and structured fields. Every string value – `Display`,
/// `Debug` and `&str` alike – passes through [`scrub`] and is capped at [`MAX_FIELD_BYTES`]:
/// `error = %e` on a reqwest failure carries the request URL (a presigned Blob URL), `body` on a
/// control-plane refusal carries the raw response, and `argv = ?spec.argv` carries whatever a
/// `postCreateCommand` inlines (registry tokens, `x-access-token:…@` clone URLs). At most
/// [`MAX_FIELDS`] fields are kept; the rest are counted in `fields_dropped`.
#[derive(Default)]
struct FieldVisitor {
    message: String,
    fields: serde_json::Map<String, serde_json::Value>,
    fields_dropped: usize,
}

impl FieldVisitor {
    fn insert(&mut self, name: &str, value: serde_json::Value) {
        if self.fields.len() >= MAX_FIELDS && !self.fields.contains_key(name) {
            self.fields_dropped += 1;
            return;
        }
        self.fields.insert(name.to_string(), value);
    }

    fn insert_text(&mut self, name: &str, text: &str) {
        let scrubbed = truncate_with_marker(scrub(text), MAX_FIELD_BYTES);
        self.insert(name, serde_json::Value::String(scrubbed));
    }

    fn finish(mut self) -> (String, Option<serde_json::Map<String, serde_json::Value>>) {
        if self.fields_dropped > 0 {
            self.fields.insert(
                "fields_dropped".to_string(),
                serde_json::Value::from(self.fields_dropped as u64),
            );
        }
        let message = truncate_msg(scrub(&self.message));
        let fields = (!self.fields.is_empty()).then_some(self.fields);
        (message, fields)
    }
}

impl tracing::field::Visit for FieldVisitor {
    fn record_debug(&mut self, field: &tracing::field::Field, value: &dyn std::fmt::Debug) {
        if field.name() == "message" {
            self.message = format!("{value:?}");
        } else {
            self.insert_text(field.name(), &format!("{value:?}"));
        }
    }

    fn record_str(&mut self, field: &tracing::field::Field, value: &str) {
        if field.name() == "message" {
            self.message = value.to_string();
        } else {
            self.insert_text(field.name(), value);
        }
    }

    fn record_u64(&mut self, field: &tracing::field::Field, value: u64) {
        self.insert(field.name(), serde_json::Value::from(value));
    }

    fn record_i64(&mut self, field: &tracing::field::Field, value: i64) {
        self.insert(field.name(), serde_json::Value::from(value));
    }

    fn record_bool(&mut self, field: &tracing::field::Field, value: bool) {
        self.insert(field.name(), serde_json::Value::Bool(value));
    }
}

impl<S: tracing::Subscriber> Layer<S> for ShipperLayer {
    fn on_event(&self, event: &tracing::Event<'_>, _ctx: Context<'_, S>) {
        let mut visitor = FieldVisitor::default();
        event.record(&mut visitor);
        let level = match *event.metadata().level() {
            tracing::Level::ERROR => "error",
            tracing::Level::WARN => "warn",
            tracing::Level::INFO => "info",
            tracing::Level::DEBUG => "debug",
            tracing::Level::TRACE => "trace",
        };
        let (msg, fields) = visitor.finish();
        self.shipper.push(LogEntry {
            ts: now_ms(),
            level,
            source: LogSource::Agent.as_str().to_string(),
            msg,
            fields,
        });
    }
}

/// `MakeWriter` for the stderr JSON lines: each event is buffered and passed through [`scrub`]
/// before it reaches stderr, which the control plane's `runCommand({ stderr })` captures. The
/// shipped copy is scrubbed field by field; this covers the copy that leaves through the
/// process's own stderr, secret values included.
struct ScrubStderr;

impl<'a> MakeWriter<'a> for ScrubStderr {
    type Writer = ScrubbedLine;

    fn make_writer(&'a self) -> Self::Writer {
        ScrubbedLine { buffer: Vec::new() }
    }
}

/// One buffered event, scrubbed and written to stderr on flush/drop.
struct ScrubbedLine {
    buffer: Vec<u8>,
}

impl std::io::Write for ScrubbedLine {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        self.buffer.extend_from_slice(bytes);
        Ok(bytes.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        if self.buffer.is_empty() {
            return Ok(());
        }
        let text = String::from_utf8_lossy(&self.buffer);
        let scrubbed = scrub(&text);
        let mut stderr = std::io::stderr().lock();
        stderr.write_all(scrubbed.as_bytes())?;
        self.buffer.clear();
        Ok(())
    }
}

impl Drop for ScrubbedLine {
    fn drop(&mut self) {
        let _ = std::io::Write::flush(self);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scrub_redacts_known_shapes() {
        let cases = [
            "token ghp_abcdefghijklmnopqrstuvwxyz0123",
            "auth zsb_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789",
            "jwt eyJhbGciOiJFUzI1NiJ9.eyJzdWIiOiJ4In0.c2lnbmF0dXJlLXNpZ25hdHVyZQ",
            "cookie zs_port_session=v1.abc.def; other=1",
            "url https://blob/x.tgz?token=abcdef",
            "hdr Authorization: Bearer abcdefghijklmnopqrstuvwxyz",
        ];
        for case in cases {
            let scrubbed = scrub(case);
            assert!(scrubbed.contains("[redacted]"), "{case} → {scrubbed}");
        }
        assert!(matches!(scrub("plain line"), Cow::Borrowed(_)));
        assert_eq!(
            scrub("https://x-access-token:abc@github.com/acme/api.git"),
            "https://[redacted]github.com/acme/api.git"
        );
        assert_eq!(
            scrub("hdr x-vercel-protection-bypass: s3cret and zs_port_token=v1.a.b&next=/"),
            "hdr [redacted] and [redacted]&next=/"
        );
    }

    #[test]
    fn server_json_line_mapped() {
        let entry = entry_from_server(
            r#"{"ts_ms":5,"level":2,"module_path":"remote_server::serve","message":"hi","session_id":"s1","epoch":3}"#,
            9,
        );
        assert_eq!(entry.ts, 5);
        assert_eq!(entry.level, "warn");
        assert_eq!(entry.source, "server:remote_server::serve");
        assert_eq!(entry.msg, "hi");
        let fields = entry.fields.unwrap();
        assert_eq!(fields["sid"], "s1");
        assert_eq!(fields["epoch"], 3);
        let raw = entry_from_server("listening on 0.0.0.0:8443", 9);
        assert_eq!(raw.ts, 9);
        assert_eq!(raw.source, "server");
        assert_eq!(raw.level, "info");
    }

    #[test]
    fn long_messages_are_truncated() {
        let long = "x".repeat(MAX_MSG_BYTES + 10);
        let out = truncate_msg(Cow::Borrowed(&long));
        assert!(out.ends_with("…[+10 bytes]"));
    }

    #[test]
    fn truncation_never_splits_a_char() {
        // `…` is three bytes; a cut in the middle of it must land before it.
        let mut text = format!("{}…tail", "a".repeat(10));
        truncate_at_boundary(&mut text, 11);
        assert_eq!(text, "a".repeat(10));
        let mut text = format!("{}…tail", "a".repeat(10));
        truncate_at_boundary(&mut text, 12);
        assert_eq!(text, "a".repeat(10));
        let mut text = format!("{}…tail", "a".repeat(10));
        truncate_at_boundary(&mut text, 13);
        assert_eq!(text, format!("{}…", "a".repeat(10)));
        let mut short = "abc".to_string();
        truncate_at_boundary(&mut short, 100);
        assert_eq!(short, "abc");
        let marked = truncate_with_marker(Cow::Owned(format!("{}…x", "a".repeat(10))), 11);
        assert_eq!(marked, format!("{}…[+4 bytes]", "a".repeat(10)));
    }

    const SECRET: &str = "hunter2-super-secret-value";

    #[test]
    fn secret_values_are_redacted_in_every_form() {
        register_secret_values(vec![SECRET.to_string(), "short".to_string()]);
        assert!(
            registered_secret_count() >= 3,
            "raw, base64 and base64url forms"
        );
        let raw = format!("DATABASE_URL=postgres://u:{SECRET}@db/x");
        assert_eq!(
            scrub(&raw),
            "DATABASE_URL=postgres://u:[redacted]@db/x",
            "the raw value is redacted"
        );
        let b64 = base64::engine::general_purpose::STANDARD.encode(SECRET);
        assert!(scrub(&format!("auth {b64}")).contains("[redacted]"));
        let b64url = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(SECRET);
        assert!(scrub(&format!("x={b64url}")).contains("[redacted]"));
        let encoded = percent_encode_value("hunter2 super/secret+value");
        register_secret_values(vec!["hunter2 super/secret+value".to_string()]);
        assert!(
            scrub(&format!("q={encoded}")).contains("[redacted]"),
            "{encoded}"
        );
        // A value below MIN_SECRET_LEN is never registered.
        assert!(matches!(scrub("short and plain"), Cow::Borrowed(_)));
    }

    fn manual_shipper() -> (LogShipper, mpsc::Receiver<LogEntry>) {
        let (tx, rx) = mpsc::channel::<LogEntry>(64);
        (
            LogShipper {
                tx,
                config: Arc::new(Mutex::new(None)),
                dropped: Arc::new(AtomicU64::new(0)),
            },
            rx,
        )
    }

    #[tokio::test]
    async fn pumped_lifecycle_output_redacts_secret_values() {
        register_secret_values(vec![SECRET.to_string()]);
        let (shipper, mut rx) = manual_shipper();
        let output = format!("+ export API_KEY={SECRET}\nnpm ERR! token {SECRET} rejected\n");
        shipper
            .pump(
                std::io::Cursor::new(output.into_bytes()),
                LogSource::PostCreate,
            )
            .await;
        let first = rx.try_recv().unwrap();
        assert_eq!(first.source, "post_create");
        assert_eq!(first.msg, "+ export API_KEY=[redacted]");
        let second = rx.try_recv().unwrap();
        assert_eq!(second.msg, "npm ERR! token [redacted] rejected");
        assert!(rx.try_recv().is_err());
    }

    #[test]
    fn tracing_fields_are_scrubbed_and_capped() {
        use tracing_subscriber::layer::SubscriberExt as _;
        register_secret_values(vec![SECRET.to_string()]);
        let (shipper, mut rx) = manual_shipper();
        let subscriber = Registry::default().with(ShipperLayer { shipper });
        tracing::subscriber::with_default(subscriber, || {
            let argv = vec![
                "git".to_string(),
                "clone".to_string(),
                "https://x-access-token:ghs_abcdefghijklmnopqrstuvwxyz@github.com/acme/api.git"
                    .to_string(),
            ];
            let body = "b".repeat(5000);
            tracing::warn!(
                argv = ?argv,
                body = %body,
                env = %format!("TOKEN={SECRET}"),
                count = 3u64,
                "lifecycle command"
            );
        });
        let entry = rx.try_recv().expect("the event was shipped");
        assert_eq!(entry.msg, "lifecycle command");
        let fields = entry.fields.expect("fields");
        let argv = fields["argv"].as_str().unwrap();
        assert!(argv.contains("[redacted]"), "{argv}");
        assert!(!argv.contains("ghs_"), "{argv}");
        let body = fields["body"].as_str().unwrap();
        assert!(body.len() <= MAX_FIELD_BYTES + 32, "{}", body.len());
        assert!(body.ends_with("…[+3976 bytes]"), "{body}");
        assert_eq!(fields["env"], "TOKEN=[redacted]");
        assert_eq!(fields["count"], 3);
    }

    #[test]
    fn too_many_fields_are_counted() {
        let mut visitor = FieldVisitor::default();
        for index in 0..(MAX_FIELDS + 5) {
            visitor.insert(&format!("f{index}"), serde_json::Value::from(index as u64));
        }
        let (_, fields) = visitor.finish();
        let fields = fields.unwrap();
        assert_eq!(fields.len(), MAX_FIELDS + 1);
        assert_eq!(fields["fields_dropped"], 5);
    }

    #[test]
    fn halved_batch_size_recovers_after_accepted_batches() {
        let mut batcher = test_batcher();
        batcher.max_batch = 25;
        for _ in 0..(BATCH_RECOVERY_SUCCESSES - 1) {
            batcher.note_success(200);
        }
        assert_eq!(batcher.max_batch, 25);
        batcher.note_success(200);
        assert_eq!(batcher.max_batch, 50);
        for _ in 0..BATCH_RECOVERY_SUCCESSES {
            batcher.note_success(60);
        }
        assert_eq!(batcher.max_batch, 60, "never above the configured ceiling");
        for _ in 0..BATCH_RECOVERY_SUCCESSES {
            batcher.note_success(60);
        }
        assert_eq!(batcher.max_batch, 60);
    }

    #[test]
    fn batch_encoding() {
        let entries = vec![
            LogEntry {
                ts: 1,
                level: "info",
                source: "agent".into(),
                msg: "a".into(),
                fields: None,
            },
            LogEntry {
                ts: 2,
                level: "warn",
                source: "server".into(),
                msg: "b".into(),
                fields: None,
            },
        ];
        let bytes = encode_batch(&LogBatch {
            workspace_id: "ws",
            sandbox_name: "sb",
            session_id: "ses",
            build: "b1",
            entries: &entries,
        });
        let value: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(value["workspaceId"], "ws");
        assert_eq!(value["sandboxName"], "sb");
        assert_eq!(value["sessionId"], "ses");
        assert_eq!(value["build"], "b1");
        assert_eq!(value["entries"].as_array().unwrap().len(), 2);
    }

    #[tokio::test]
    async fn long_lines_are_split_with_a_truncated_marker() {
        let mut input = vec![b'x'; MAX_LINE_BYTES + 4096];
        input.push(b'\n');
        input.extend_from_slice(b"short\n");
        let mut reader = tokio::io::BufReader::new(std::io::Cursor::new(input));
        let mut line = Vec::new();
        assert_eq!(
            read_line_capped(&mut reader, &mut line).await.unwrap(),
            Some(true)
        );
        assert_eq!(line.len(), MAX_LINE_BYTES);
        assert_eq!(
            read_line_capped(&mut reader, &mut line).await.unwrap(),
            Some(false)
        );
        assert_eq!(line, b"short");
        assert_eq!(
            read_line_capped(&mut reader, &mut line).await.unwrap(),
            None
        );
    }

    fn test_batcher() -> Batcher {
        let env = std::collections::BTreeMap::from([
            ("ZS_CONTROL_URL", "http://127.0.0.1:1/api"),
            ("ZS_SANDBOX_TOKEN", "zsb_test"),
            ("ZS_SANDBOX_NAME", "sb-test"),
            ("ZS_WORKSPACE_ID", "ws_test"),
            ("HOME", "/tmp"),
        ]);
        let config =
            crate::config::Config::from_lookup(|key| env.get(key).map(|v| v.to_string())).unwrap();
        let control = ControlPlane::new(Arc::new(config)).unwrap();
        Batcher {
            control,
            build: "b1".to_string(),
            config: Arc::new(Mutex::new(None)),
            dropped: Arc::new(AtomicU64::new(0)),
            queue: VecDeque::new(),
            queue_bytes: 0,
            max_batch: MAX_BATCH_LINES,
            successes: 0,
            buckets: BTreeMap::new(),
            reported_dropped: 0,
        }
    }

    fn entry(source: &str) -> LogEntry {
        LogEntry {
            ts: 1,
            level: "info",
            source: source.to_string(),
            msg: "x".repeat(64),
            fields: None,
        }
    }

    #[test]
    fn per_source_rate_limit() {
        let mut batcher = test_batcher();
        for _ in 0..1_000 {
            batcher.enqueue(entry("server"));
        }
        assert_eq!(batcher.queue.len(), PER_SOURCE_RATE.0);
        assert_eq!(
            batcher.dropped.load(Ordering::Relaxed),
            1_000 - PER_SOURCE_RATE.0 as u64
        );
        // A different source has its own bucket.
        batcher.enqueue(entry("agent"));
        assert_eq!(batcher.queue.len(), PER_SOURCE_RATE.0 + 1);
    }

    #[test]
    fn queue_is_bounded_and_drops_are_reported() {
        let mut batcher = test_batcher();
        for index in 0..(MAX_QUEUE_LINES + 500) {
            // One bucket per source keeps the rate limiter out of the way.
            batcher.enqueue(entry(&format!("s{index}")));
        }
        assert_eq!(batcher.queue.len(), MAX_QUEUE_LINES);
        assert!(batcher.queue_bytes <= MAX_QUEUE_BYTES);
        assert_eq!(batcher.dropped.load(Ordering::Relaxed), 500);
        batcher.note_drops();
        let notice = batcher.queue.back().unwrap().0.clone();
        assert_eq!(notice.source, "agent");
        assert_eq!(notice.fields.unwrap()["dropped"], 500);
        batcher.note_drops();
        assert_eq!(batcher.queue.back().unwrap().0.msg, notice.msg);
    }

    #[tokio::test]
    async fn drain_without_configure_releases_the_queue() {
        // The pre-manifest exit path: entries were queued, `configure` never ran, the shipper is
        // told to stop. The task must finish (it used to spin forever on `flush() == true`).
        let mut batcher = test_batcher();
        let dropped = batcher.dropped.clone();
        let (tx, rx) = mpsc::channel::<LogEntry>(16);
        tx.try_send(entry("agent")).unwrap();
        tx.try_send(entry("server")).unwrap();
        let stop = CancellationToken::new();
        stop.cancel();
        batcher.enqueue(entry("proxy"));
        tokio::time::timeout(Duration::from_secs(2), batcher.run(rx, stop))
            .await
            .expect("the batcher stops promptly when it was never configured");
        assert_eq!(dropped.load(Ordering::Relaxed), 3);
        drop(tx);
    }

    #[tokio::test]
    async fn a_stop_during_a_flush_is_not_lost() {
        // The stop signal is a token: cancelling it before the batcher is even polled (the
        // equivalent of a `notify_waiters` fired while the batcher was inside a POST) still ends
        // the task, and the unreachable control plane makes the drain give up after one failed
        // batch instead of hanging.
        let mut batcher = test_batcher();
        batcher.config.lock().replace(LogShipperConfig {
            flush_interval: Duration::from_secs(60),
            max_batch: 10,
            max_batch_bytes: 4096,
            workspace_id: "ws".into(),
            sandbox_name: "sb".into(),
            session_id: "ses".into(),
            build: "b1".into(),
        });
        batcher.enqueue(entry("agent"));
        let (_tx, rx) = mpsc::channel::<LogEntry>(16);
        let stop = CancellationToken::new();
        stop.cancel();
        tokio::time::timeout(Duration::from_secs(10), batcher.run(rx, stop))
            .await
            .expect("a cancelled stop token ends the batcher");
    }

    #[test]
    fn manifest_limits_are_clamped_to_the_ceilings() {
        // A manifest asking for more than the b9 ceilings is clamped, never trusted.
        let mut batcher = test_batcher();
        batcher.config.lock().replace(LogShipperConfig {
            flush_interval: FLUSH_INTERVAL,
            max_batch: 500,
            max_batch_bytes: 10 * 1024 * 1024,
            workspace_id: "ws".into(),
            sandbox_name: "sb".into(),
            session_id: "ses".into(),
            build: "b1".into(),
        });
        for index in 0..(MAX_BATCH_LINES - 1) {
            batcher.enqueue(entry(&format!("s{index}")));
        }
        assert!(
            !batcher.batch_ready(),
            "199 entries stay below the 200 ceiling"
        );
        batcher.enqueue(entry("last"));
        assert!(batcher.batch_ready(), "500 was clamped to MAX_BATCH_LINES");
        // A lower manifest value is honoured as-is.
        let mut batcher = test_batcher();
        batcher.config.lock().replace(LogShipperConfig {
            flush_interval: FLUSH_INTERVAL,
            max_batch: 50,
            max_batch_bytes: 65_536,
            workspace_id: "ws".into(),
            sandbox_name: "sb".into(),
            session_id: "ses".into(),
            build: "b1".into(),
        });
        for index in 0..50 {
            batcher.enqueue(entry(&format!("s{index}")));
        }
        assert!(batcher.batch_ready());
    }

    #[tokio::test]
    async fn flush_without_configure_keeps_the_queue() {
        let mut batcher = test_batcher();
        batcher.enqueue(entry("agent"));
        assert!(batcher.flush().await);
        assert_eq!(batcher.queue.len(), 1);
        batcher.config.lock().replace(LogShipperConfig {
            flush_interval: FLUSH_INTERVAL,
            max_batch: 10,
            max_batch_bytes: 4096,
            workspace_id: "ws".into(),
            sandbox_name: "sb".into(),
            session_id: "ses".into(),
            build: "b1".into(),
        });
        // The control plane is unreachable, so the batch is re-queued rather than lost.
        assert!(!batcher.flush().await);
        assert_eq!(batcher.queue.len(), 1);
    }
}
