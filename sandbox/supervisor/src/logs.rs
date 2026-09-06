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
