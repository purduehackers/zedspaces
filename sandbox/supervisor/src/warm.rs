//! Headless language-server warm-up client for prebuilds (brief §3.16a; D14; BUILD-SPEC §6.4).
//!
//! `zs-agent` speaks b1's wire protocol to the server it just started: `Sec-WebSocket-Protocol:
//! zs.v1, <jwt>`, a `hello` text frame (with the D25 `instance` nonce), `hello_ack`, then binary
//! envelopes (`u32 LE len || prost(Envelope)`, [`crate::proto::messages`]). It adds the workspace
//! as a worktree and opens one buffer per detected language, which makes the headless `LspStore`
//! start – and download into `languages_dir()` – every language server; everything it fetches
//! lands in the snapshot. It never sends `SaveClientState` (b4 §3.15 item 7).
//!
//! Heartbeats are server → client every 5 s (D22); the client answers WebSocket protocol pings
//! natively (tungstenite queues the pong) and treats a socket silent for 90 s as dead.

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use anyhow::{Context as _, anyhow, bail};
use futures_util::{SinkExt as _, StreamExt as _};
use prost::Message as _;
use rand::RngCore as _;
use secrecy::{ExposeSecret as _, SecretString};
use tokio::net::TcpStream;
use tokio_tungstenite::WebSocketStream;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::client::IntoClientRequest as _;
use tokio_tungstenite::tungstenite::protocol::WebSocketConfig;
use tokio_tungstenite::tungstenite::protocol::frame::CloseFrame;
use tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode;
use tokio_util::sync::CancellationToken;

use crate::config::Config;
use crate::logs::{LogEntry, LogShipper, LogSource, now_ms, scrub};
use crate::manifest::Manifest;
use crate::proto::messages;
use crate::state::{AgentState, Phase};

/// Hard cap on the warm-up budget.
pub const WARM_BUDGET_MAX: Duration = Duration::from_secs(15 * 60);
/// No `UpdateLanguageServer`/`LanguageServerLog` traffic for this long ⇒ done.
pub const WARM_SETTLE: Duration = Duration::from_secs(20);
/// One probe file per language, plus a second for TS/JS (tsserver + eslint).
pub const WARM_MAX_FILES: usize = 24;
/// Interval of the server's `heartbeat` control frame (D22); six misses ⇒ dead.
pub const WARM_HEARTBEAT: Duration = Duration::from_secs(5);
/// Silence after which the socket is considered dead (D22).
pub const WARM_DEAD_AFTER: Duration = Duration::from_secs(90);
/// b1 `SUBPROTOCOL`.
pub const SUBPROTOCOL: &str = "zs.v1";
/// b1 `MAX_FRAME_BYTES`.
pub const MAX_FRAME_BYTES: usize = 16 * 1024 * 1024;
/// `REMOTE_SERVER_PROJECT_ID` (`zed/crates/proto/src/proto.rs`).
pub const REMOTE_PROJECT_ID: u64 = 0;
/// Lifetime of the warm-up session token.
pub const WARM_TOKEN_TTL_SECS: u64 = 900;
/// How long one `OpenBufferByPath` may take before the file is given up on.
pub const OPEN_BUFFER_TIMEOUT: Duration = Duration::from_secs(60);
/// Language probe table: extensions (or file names) in priority order.
pub const PROBE_EXTENSIONS: [&str; 22] = [
    "rs",
    "go",
    "py",
    "ts",
    "tsx",
    "js",
    "jsx",
    "json",
    "css",
    "html",
    "yaml",
    "yml",
    "sh",
    "bash",
    "c",
    "cc",
    "cpp",
    "h",
    "toml",
    "lua",
    "Dockerfile",
    "md",
];
/// Directories skipped while looking for probe files.
pub const PROBE_SKIP_DIRS: [&str; 6] =
    [".git", "node_modules", "target", "vendor", "dist", "build"];
/// Maximum walk depth for probe files.
pub const PROBE_MAX_DEPTH: usize = 6;

/// Walk depth for the Feature-implied probes a repo may keep deeper than [`PROBE_MAX_DEPTH`].
pub const PROBE_DEEP_DEPTH: usize = 12;

/// Picks the probe files of a warm-up (b10 §3.15 item 3, §3.16): `hints`
/// (`customizations.zed.prebuild.files`: repo-relative, existing, no `..`) first, then the first
/// existing file per language of the [`PROBE_EXTENSIONS`] table walking the checkout (skipping
/// [`PROBE_SKIP_DIRS`], depth ≤ [`PROBE_MAX_DEPTH`]), then a deeper walk for the extensions the
/// allowlisted `feature_langs` (`node`, `python`, `go`, `rust`, `java`) imply and the table walk
/// did not find; deduplicated, at most [`WARM_MAX_FILES`].
pub fn pick_probe_files(root: &Path, hints: &[String], feature_langs: &[&str]) -> Vec<PathBuf> {
    let mut out: Vec<PathBuf> = Vec::new();
    for hint in hints {
        let path = Path::new(hint);
        if path.is_absolute()
            || path
                .components()
                .any(|component| matches!(component, std::path::Component::ParentDir))
        {
            tracing::warn!(hint, "ignoring prebuild probe hint outside the checkout");
            continue;
        }
        if !root.join(path).is_file() {
            tracing::warn!(hint, "ignoring missing prebuild probe hint");
            continue;
        }
        if !out.iter().any(|existing| existing == path) {
            out.push(path.to_path_buf());
        }
        if out.len() >= WARM_MAX_FILES {
            return out;
        }
    }
    let mut best = walk_probes(root, PROBE_MAX_DEPTH, None);
    let implied: BTreeSet<usize> = feature_langs
        .iter()
        .flat_map(|lang| feature_extensions(lang))
        .filter_map(|extension| probe_index(&format!("x.{extension}")))
        .filter(|index| !best.contains_key(index))
        .collect();
    if !implied.is_empty() {
        for (index, path) in walk_probes(root, PROBE_DEEP_DEPTH, Some(&implied)) {
            best.entry(index).or_insert(path);
        }
    }
    for path in best.into_values() {
        if out.len() >= WARM_MAX_FILES {
            break;
        }
        if !out.contains(&path) {
            out.push(path);
        }
    }
    out
}

/// Extensions a Feature implies (b10 §3.15 item 3).
fn feature_extensions(lang: &str) -> &'static [&'static str] {
    match lang {
        "node" => &["ts", "js"],
        "python" => &["py"],
        "go" => &["go"],
        "rust" => &["rs"],
        "java" => &["java"],
        _ => &[],
    }
}

/// The first file per [`PROBE_EXTENSIONS`] index (or per index in `wanted`) under `root`.
fn walk_probes(
    root: &Path,
    max_depth: usize,
    wanted: Option<&BTreeSet<usize>>,
) -> BTreeMap<usize, PathBuf> {
    let mut best: BTreeMap<usize, PathBuf> = BTreeMap::new();
    let mut queue: Vec<(PathBuf, usize)> = vec![(root.to_path_buf(), 0)];
    while let Some((dir, depth)) = queue.pop() {
        let Ok(read) = std::fs::read_dir(&dir) else {
            continue;
        };
        let mut entries: Vec<PathBuf> = read
            .filter_map(|entry| entry.ok().map(|entry| entry.path()))
            .collect();
        entries.sort();
        for path in entries {
            let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
                continue;
            };
            if path.is_dir() {
                if depth < max_depth && !PROBE_SKIP_DIRS.contains(&name) {
                    queue.push((path, depth + 1));
                }
                continue;
            }
            let Some(index) = probe_index(name) else {
                continue;
            };
            if let Some(wanted) = wanted
                && !wanted.contains(&index)
            {
                continue;
            }
            let Ok(relative) = path.strip_prefix(root) else {
                continue;
            };
            best.entry(index).or_insert_with(|| relative.to_path_buf());
        }
    }
    best
}

/// Index of a file name in [`PROBE_EXTENSIONS`] (whole-name match first, then extension).
fn probe_index(file_name: &str) -> Option<usize> {
    if let Some(index) = PROBE_EXTENSIONS
        .iter()
        .position(|candidate| *candidate == file_name)
    {
        return Some(index);
    }
    let extension = file_name.rsplit_once('.')?.1;
    PROBE_EXTENSIONS
        .iter()
        .position(|candidate| *candidate == extension)
}

/// Ephemeral P-256 key pair for the prebuild boot.
pub struct WarmKey {
    /// PKCS#8 PEM; never touches disk.
    pub private_pem: SecretString,
    /// SPKI PEM; written as `<jwt_dir>/key-warm.pem` and passed as an extra `--jwt-public-key`.
    /// Empty when the key was loaded from a file for `zs-agent warm` (only signing is needed).
    pub public_pem: String,
}

/// A minted warm-up token together with the `sid` it carries, so `Hello.session_id` can match the
/// JWT (b2 warns on a mismatch).
#[derive(Clone, Debug)]
pub struct WarmToken {
    /// The ES256 JWT; an RFC 2616 token, so it fits in `Sec-WebSocket-Protocol`.
    pub token: String,
    /// `sid` claim, `"warm-<jti>"`.
    pub session_id: String,
}

/// Claims b2's verifier checks (`iss`, `aud`, `exp`) plus the `ws`/`sid` binding.
#[derive(Debug, serde::Serialize, serde::Deserialize)]
pub struct WarmClaims {
    /// Issuer, from `manifest.jwt.issuer`.
    pub iss: String,
    /// Audience, from `manifest.jwt.audience`.
    pub aud: String,
    /// Always `"zs-agent-warm"` (CONTRACTS §5.1).
    pub sub: String,
    /// Workspace id.
    pub ws: String,
    /// Session id, `"warm-<jti>"`.
    pub sid: String,
    /// Issued at, unix seconds.
    pub iat: u64,
    /// Expiry, unix seconds (`iat + 900`).
    pub exp: u64,
    /// Replay id.
    pub jti: String,
}

/// `p256::SecretKey` from 32 random bytes → PKCS#8 / SPKI PEM (`jsonwebtoken`'s `rust_crypto`
/// backend signs from the PKCS#8 PEM; `serve` verifies from the SPKI PEM).
pub fn generate_warm_key() -> anyhow::Result<WarmKey> {
    use p256::pkcs8::{EncodePrivateKey as _, EncodePublicKey as _, LineEnding};

    let mut bytes = [0u8; 32];
    let secret = loop {
        rand::rng().fill_bytes(&mut bytes);
        // Rejects the vanishingly rare out-of-range scalar instead of biasing it into range.
        if let Ok(secret) = p256::SecretKey::from_slice(&bytes) {
            break secret;
        }
    };
    let private_pem = secret
        .to_pkcs8_pem(LineEnding::LF)
        .map_err(|error| anyhow!("encoding the warm-up private key: {error}"))?;
    let public_pem = secret
        .public_key()
        .to_public_key_pem(LineEnding::LF)
        .map_err(|error| anyhow!("encoding the warm-up public key: {error}"))?;
    Ok(WarmKey {
        private_pem: SecretString::from(private_pem.to_string()),
        public_pem,
    })
}

/// ES256 JWT with b2's claim set: `iss = manifest.jwt.issuer`, `aud = manifest.jwt.audience`,
/// `sub = "zs-agent-warm"`, `ws = workspace_id`, `sid = "warm-<jti>"`, `iat`, `exp = iat + 900`,
/// `jti`.
pub fn mint_warm_token(key: &WarmKey, manifest: &Manifest, now: u64) -> anyhow::Result<WarmToken> {
    mint_token(
        key,
        &manifest.jwt.issuer,
        &manifest.jwt.audience,
        &manifest.workspace_id,
        now,
    )
}

/// [`mint_warm_token`] without a manifest (`zs-agent warm`).
pub fn mint_token(
    key: &WarmKey,
    issuer: &str,
    audience: &str,
    workspace_id: &str,
    now: u64,
) -> anyhow::Result<WarmToken> {
    let jti = random_hex();
    let claims = WarmClaims {
        iss: issuer.to_string(),
        aud: audience.to_string(),
        sub: "zs-agent-warm".to_string(),
        ws: workspace_id.to_string(),
        sid: format!("warm-{jti}"),
        iat: now,
        exp: now + WARM_TOKEN_TTL_SECS,
        jti,
    };
    let key = jsonwebtoken::EncodingKey::from_ec_pem(key.private_pem.expose_secret().as_bytes())
        .context("loading the warm-up signing key")?;
    let token = jsonwebtoken::encode(
        &jsonwebtoken::Header::new(jsonwebtoken::Algorithm::ES256),
        &claims,
        &key,
    )
    .context("signing the warm-up token")?;
    Ok(WarmToken {
        session_id: claims.sid,
        token,
    })
}

/// What the warm-up observed.
#[derive(Debug, Default)]
pub struct WarmOutcome {
    /// Language server names seen in `UpdateLanguageServer`.
    pub servers_seen: BTreeSet<String>,
    /// Buffers opened.
    pub files_opened: usize,
    /// Wall time spent.
    pub elapsed: Duration,
    /// `true` when LSP traffic went quiet before the budget expired.
    pub settled: bool,
}

/// `zs-agent warm` arguments (brief §3.17): the same routine against an already running server,
/// without a manifest.
#[derive(clap::Args, Debug, Clone)]
pub struct WarmArgs {
    /// PKCS#8 PEM of the ES256 key whose public half the server trusts.
    #[arg(long)]
    pub private_key: PathBuf,
    /// `ws` claim.
    #[arg(long)]
    pub workspace_id: String,
    /// `aud` claim.
    #[arg(long)]
    pub audience: String,
    /// `iss` claim.
    #[arg(long, default_value = "zs")]
    pub issuer: String,
    /// Checkout to add as the worktree.
    #[arg(long)]
    pub workspace_root: PathBuf,
    /// Server public listener.
    #[arg(long, default_value = "http://127.0.0.1:8443")]
    pub server_url: String,
    /// Budget in seconds.
    #[arg(long, default_value_t = 300)]
    pub budget_secs: u64,
}

/// Everything one warm-up run needs; built from the manifest or from [`WarmArgs`].
struct WarmPlan {
    server_url: String,
    token: WarmToken,
    build: String,
    workspace_id: String,
    workspace_root: PathBuf,
    budget: Duration,
    /// `customizations.zed.prebuild.files`: repo-relative probe files opened first (b10 §3.15).
    hints: Vec<String>,
    /// Allowlisted Feature names (`node`, `go`, …) whose implied probes are added (b10 §3.15).
    feature_langs: Vec<String>,
}

/// Runs the warm-up against the server started by `prebuild` (§3.16a steps 1-5). Failures are the
/// caller's to log: a prebuild is not failed by a warm-up that could not connect.
pub async fn run(
    config: &Config,
    manifest: &Manifest,
    key: &WarmKey,
    budget: Duration,
    logs: &LogShipper,
    state: &Arc<AgentState>,
    shutdown: &CancellationToken,
) -> anyhow::Result<WarmOutcome> {
    state.set_phase(Phase::Warm);
    let _busy = state.busy_guard();
    let spec = manifest.devcontainer.as_ref();
    let plan = WarmPlan {
        server_url: format!("http://127.0.0.1:{}", config.rpc_listen.port()),
        token: mint_warm_token(key, manifest, now_ms() / 1000)?,
        build: config.build_id.clone(),
        workspace_id: manifest.workspace_id.clone(),
        workspace_root: manifest.workspace_dir.clone(),
        budget: budget.min(WARM_BUDGET_MAX),
        hints: spec
            .and_then(|spec| spec.zed.prebuild.as_ref())
            .map(|hints| hints.files.clone())
            .unwrap_or_default(),
        feature_langs: spec.map(|spec| spec.features.clone()).unwrap_or_default(),
    };
    drive(plan, Some(logs), Some(shutdown)).await
}

/// `zs-agent warm`: the same routine driven by [`WarmArgs`].
pub async fn run_standalone(args: WarmArgs) -> anyhow::Result<WarmOutcome> {
    let private_pem = std::fs::read_to_string(&args.private_key)
        .with_context(|| format!("reading {}", args.private_key.display()))?;
    let key = WarmKey {
        private_pem: SecretString::from(private_pem),
        public_pem: String::new(),
    };
    let plan = WarmPlan {
        server_url: args.server_url.clone(),
        token: mint_token(
            &key,
            &args.issuer,
            &args.audience,
            &args.workspace_id,
            now_ms() / 1000,
        )?,
        build: std::env::var("ZS_BUILD_ID").unwrap_or_else(|_| "dev".to_string()),
        workspace_id: args.workspace_id.clone(),
        workspace_root: args.workspace_root.clone(),
        budget: Duration::from_secs(args.budget_secs).min(WARM_BUDGET_MAX),
        hints: Vec::new(),
        feature_langs: Vec::new(),
    };
    drive(plan, None, None).await
}

/// `http://host:port` → `ws://host:port/rpc` (b1 §4.3). `https` is refused: the warm-up only ever
/// talks to `127.0.0.1`, and no TLS backend is linked into `zs-agent`'s WebSocket client.
pub fn rpc_ws_url(server_url: &str) -> anyhow::Result<(String, String, u16)> {
    let url = reqwest::Url::parse(server_url).context("parsing the server url")?;
    if !matches!(url.scheme(), "http" | "ws") {
        bail!("{server_url}: the warm-up client speaks plain ws:// to loopback only");
    }
    let host = url.host_str().unwrap_or("127.0.0.1").to_string();
    let port = url.port().unwrap_or(8443);
    Ok((format!("ws://{host}:{port}/rpc"), host, port))
}

/// Steps 1-5 of §3.16a.
async fn drive(
    plan: WarmPlan,
    logs: Option<&LogShipper>,
    shutdown: Option<&CancellationToken>,
) -> anyhow::Result<WarmOutcome> {
    let started = Instant::now();
    let deadline = started + plan.budget;
    let (ws_url, host, port) = rpc_ws_url(&plan.server_url)?;

    let stream = TcpStream::connect((host.as_str(), port))
        .await
        .with_context(|| format!("connecting to {host}:{port}"))?;
    let _ = stream.set_nodelay(true);
    let mut request = ws_url.as_str().into_client_request()?;
    request.headers_mut().insert(
        "sec-websocket-protocol",
        format!("{SUBPROTOCOL}, {}", plan.token.token).parse()?,
    );
    let config = WebSocketConfig {
        max_frame_size: Some(MAX_FRAME_BYTES),
        max_message_size: Some(MAX_FRAME_BYTES),
        ..WebSocketConfig::default()
    };
    let (socket, response) =
        tokio_tungstenite::client_async_with_config(request, stream, Some(config))
            .await
            .with_context(|| format!("upgrading {ws_url}"))?;
    let negotiated = response
        .headers()
        .get("sec-websocket-protocol")
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default();
    if negotiated != SUBPROTOCOL {
        bail!("server negotiated subprotocol {negotiated:?}, expected {SUBPROTOCOL:?}");
    }

    let mut client = WarmClient {
        socket,
        next_id: 1,
        servers_seen: BTreeSet::new(),
        last_lsp: Instant::now(),
        logs,
        shutdown,
    };

    // 2. hello / hello_ack, then the first binary envelope (`RemoteStarted`).
    let hello = Hello {
        kind: "hello",
        protocol: 1,
        build: plan.build.clone(),
        workspace_id: plan.workspace_id.clone(),
        session_id: plan.token.session_id.clone(),
        identifier: format!("zs-agent-warm/{}", random_hex()),
        instance: random_hex(),
        reconnect: false,
        takeover: false,
        client: "desktop",
        epoch: None,
    };
    client
        .send(Message::Text(serde_json::to_string(&hello)?))
        .await?;
    client.await_hello_ack(deadline).await?;
    client.await_remote_started(deadline).await?;

    // 3. worktree, then one buffer per language.
    let root = plan.workspace_root.to_string_lossy().into_owned();
    let worktree_id = client.add_worktree(&root, deadline).await?;
    let feature_langs: Vec<&str> = plan.feature_langs.iter().map(String::as_str).collect();
    let probes = pick_probe_files(&plan.workspace_root, &plan.hints, &feature_langs);
    client.log(
        "info",
        format!("warm-up opening {} probe file(s) in {root}", probes.len()),
    );
    let mut files_opened = 0usize;
    for probe in &probes {
        if Instant::now() >= deadline {
            break;
        }
        let path = probe.to_string_lossy().into_owned();
        match client.open_buffer(worktree_id, &path, deadline).await {
            Ok(true) => files_opened += 1,
            Ok(false) => client.log("warn", format!("warm-up could not open {path}")),
            Err(error) => {
                client.log("warn", format!("warm-up gave up on {path}: {error}"));
                break;
            }
        }
    }

    // 4. observe until the language servers go quiet, or the budget runs out.
    let settled = client.settle(deadline).await;

    // 5. close; the server treats a client close as a detach.
    let _ = client
        .socket
        .close(Some(CloseFrame {
            code: CloseCode::Normal,
            reason: "warm-up complete".into(),
        }))
        .await;

    let outcome = WarmOutcome {
        servers_seen: std::mem::take(&mut client.servers_seen),
        files_opened,
        elapsed: started.elapsed(),
        settled,
    };
    client.log(
        "info",
        format!(
            "warm-up finished: {} file(s), servers [{}], settled={}, {}s",
            outcome.files_opened,
            outcome
                .servers_seen
                .iter()
                .cloned()
                .collect::<Vec<_>>()
                .join(", "),
            outcome.settled,
            outcome.elapsed.as_secs()
        ),
    );
    Ok(outcome)
}

/// The `hello` text frame (b1 §4.2 field names; D25 adds `instance`).
#[derive(Debug, serde::Serialize)]
struct Hello {
    #[serde(rename = "type")]
    kind: &'static str,
    protocol: u32,
    build: String,
    workspace_id: String,
    session_id: String,
    identifier: String,
    instance: String,
    reconnect: bool,
    takeover: bool,
    client: &'static str,
    epoch: Option<u64>,
}

/// One decoded frame from the server.
enum Event {
    /// A JSON control frame (`hello_ack`, `heartbeat`, `log`).
    Text(serde_json::Value),
    /// A binary envelope.
    Envelope(Box<messages::Envelope>),
    /// The socket closed.
    Closed,
}

/// The warm-up's socket plus the bookkeeping the settle timer needs.
struct WarmClient<'a> {
    socket: WebSocketStream<TcpStream>,
    next_id: u32,
    servers_seen: BTreeSet<String>,
    last_lsp: Instant,
    logs: Option<&'a LogShipper>,
    shutdown: Option<&'a CancellationToken>,
}

impl WarmClient<'_> {
    fn log(&self, level: &'static str, message: impl Into<String>) {
        let message = message.into();
        tracing::info!(target: "zs_agent::warm", "{message}");
        if let Some(shipper) = self.logs {
            shipper.push(LogEntry {
                ts: now_ms(),
                level,
                source: LogSource::Warm.as_str().to_string(),
                msg: scrub(&message).into_owned(),
                fields: None,
            });
        }
    }

    async fn send(&mut self, message: Message) -> anyhow::Result<()> {
        self.socket.send(message).await.map_err(Into::into)
    }

    /// Reads the next frame, honouring the run budget, the D22 silence limit and `SIGTERM`.
    async fn recv(&mut self, deadline: Instant) -> anyhow::Result<Event> {
        let now = Instant::now();
        if now >= deadline {
            bail!("warm-up budget exhausted");
        }
        let wait = (deadline - now).min(WARM_DEAD_AFTER);
        let cancelled = async {
            match self.shutdown {
                Some(token) => token.cancelled().await,
                None => std::future::pending().await,
            }
        };
        let message = tokio::select! {
            _ = cancelled => bail!("warm-up cancelled"),
            message = tokio::time::timeout(wait, self.socket.next()) => message,
        };
        match message {
            Err(_) if Instant::now() >= deadline => bail!("warm-up budget exhausted"),
            Err(_) => bail!(
                "no frame for {}s: the server is gone",
                WARM_DEAD_AFTER.as_secs()
            ),
            Ok(None) => Ok(Event::Closed),
            Ok(Some(Err(error))) => Err(error.into()),
            Ok(Some(Ok(Message::Text(text)))) => Ok(Event::Text(
                serde_json::from_str(&text).unwrap_or(serde_json::Value::Null),
            )),
            Ok(Some(Ok(Message::Binary(bytes)))) => {
                Ok(Event::Envelope(Box::new(decode_envelope_frame(&bytes)?)))
            }
            // Ping/Pong are answered by tungstenite itself; Close ends the stream next poll.
            Ok(Some(Ok(Message::Close(_)))) => Ok(Event::Closed),
            Ok(Some(Ok(_))) => Ok(Event::Text(serde_json::Value::Null)),
        }
    }

    async fn await_hello_ack(&mut self, deadline: Instant) -> anyhow::Result<()> {
        loop {
            match self.recv(deadline).await? {
                Event::Text(value) => {
                    if value.get("type").and_then(serde_json::Value::as_str) == Some("hello_ack") {
                        let resumed = value
                            .get("resumed")
                            .and_then(serde_json::Value::as_bool)
                            .unwrap_or(false);
                        self.log("info", format!("warm-up attached (resumed={resumed})"));
                        return Ok(());
                    }
                }
                Event::Envelope(_) => bail!("server sent an envelope before hello_ack"),
                Event::Closed => bail!("server closed before hello_ack"),
            }
        }
    }

    async fn await_remote_started(&mut self, deadline: Instant) -> anyhow::Result<()> {
        loop {
            match self.recv(deadline).await? {
                Event::Envelope(envelope) => {
                    self.observe(&envelope);
                    if matches!(
                        envelope.payload,
                        Some(messages::envelope::Payload::RemoteStarted(_))
                    ) {
                        return Ok(());
                    }
                }
                Event::Text(_) => {}
                Event::Closed => bail!("server closed before RemoteStarted"),
            }
        }
    }

    /// Sends one request envelope and pumps frames until its response arrives.
    async fn request(
        &mut self,
        payload: messages::envelope::Payload,
        deadline: Instant,
    ) -> anyhow::Result<messages::Envelope> {
        let id = self.next_id;
        self.next_id += 1;
        let envelope = messages::Envelope {
            id,
            payload: Some(payload),
            ..Default::default()
        };
        self.send(Message::Binary(encode_envelope_frame(&envelope)))
            .await?;
        loop {
            match self.recv(deadline).await? {
                Event::Envelope(envelope) => {
                    self.observe(&envelope);
                    if envelope.responding_to == Some(id) {
                        return Ok(*envelope);
                    }
                    self.answer_housekeeping(&envelope).await?;
                }
                Event::Text(_) => {}
                Event::Closed => bail!("server closed while waiting for a response"),
            }
        }
    }

    async fn add_worktree(&mut self, path: &str, deadline: Instant) -> anyhow::Result<u64> {
        let response = self
            .request(
                messages::envelope::Payload::AddWorktree(messages::AddWorktree {
                    path: path.to_string(),
                    project_id: REMOTE_PROJECT_ID,
                    visible: true,
                }),
                deadline,
            )
            .await?;
        match response.payload {
            Some(messages::envelope::Payload::AddWorktreeResponse(response)) => {
                Ok(response.worktree_id)
            }
            Some(messages::envelope::Payload::Error(error)) => {
                bail!("AddWorktree failed: {}", error.message)
            }
            _ => bail!("AddWorktree got an unexpected response"),
        }
    }

    /// `Ok(false)` when the server answered with an `Error` (a probe file that cannot be opened is
    /// skipped, not fatal).
    async fn open_buffer(
        &mut self,
        worktree_id: u64,
        path: &str,
        deadline: Instant,
    ) -> anyhow::Result<bool> {
        let open_deadline = deadline.min(Instant::now() + OPEN_BUFFER_TIMEOUT);
        let response = self
            .request(
                messages::envelope::Payload::OpenBufferByPath(messages::OpenBufferByPath {
                    project_id: REMOTE_PROJECT_ID,
                    worktree_id,
                    path: path.to_string(),
                }),
                open_deadline,
            )
            .await?;
        Ok(matches!(
            response.payload,
            Some(messages::envelope::Payload::OpenBufferResponse(_))
        ))
    }

    /// Pumps frames until [`WARM_SETTLE`] passes with no LSP traffic (`true`) or the budget runs
    /// out (`false`).
    async fn settle(&mut self, deadline: Instant) -> bool {
        self.last_lsp = Instant::now();
        loop {
            let quiet_for = self.last_lsp.elapsed();
            if quiet_for >= WARM_SETTLE {
                return true;
            }
            let settle_deadline = Instant::now() + (WARM_SETTLE - quiet_for);
            let wait_until = settle_deadline.min(deadline);
            match self.recv(wait_until).await {
                Ok(Event::Envelope(envelope)) => {
                    self.observe(&envelope);
                    if self.answer_housekeeping(&envelope).await.is_err() {
                        return false;
                    }
                }
                Ok(Event::Text(_)) => {}
                Ok(Event::Closed) => return false,
                // A budget or settle timeout both land here; only the settle one counts as done.
                Err(_) => {
                    if Instant::now() >= deadline {
                        return false;
                    }
                    if self.last_lsp.elapsed() >= WARM_SETTLE {
                        return true;
                    }
                }
            }
        }
    }

    /// Records language-server traffic and resets the settle timer.
    fn observe(&mut self, envelope: &messages::Envelope) {
        match &envelope.payload {
            Some(messages::envelope::Payload::UpdateLanguageServer(update)) => {
                self.last_lsp = Instant::now();
                if let Some(name) = &update.server_name {
                    self.servers_seen.insert(name.clone());
                }
            }
            Some(messages::envelope::Payload::LanguageServerLog(_)) => {
                self.last_lsp = Instant::now();
            }
            _ => {}
        }
    }

    /// Answers the one envelope the server expects a reply to (`FlushBufferedMessages` → `Ack`);
    /// `Ping`/`Ack` and everything else are ignored (§3.16a step 3).
    async fn answer_housekeeping(&mut self, envelope: &messages::Envelope) -> anyhow::Result<()> {
        if matches!(
            envelope.payload,
            Some(messages::envelope::Payload::FlushBufferedMessages(_))
        ) {
            let id = self.next_id;
            self.next_id += 1;
            let ack = messages::Envelope {
                id,
                responding_to: Some(envelope.id),
                payload: Some(messages::envelope::Payload::Ack(messages::Ack {})),
                ..Default::default()
            };
            self.send(Message::Binary(encode_envelope_frame(&ack)))
                .await?;
        }
        Ok(())
    }
}

/// `u32 LE len || prost(Envelope)` (`zed/crates/remote/src/protocol.rs`), carried in one binary
/// WebSocket frame.
pub fn encode_envelope_frame(envelope: &messages::Envelope) -> Vec<u8> {
    let body = envelope.encode_to_vec();
    let mut frame = Vec::with_capacity(4 + body.len());
    frame.extend_from_slice(&(body.len() as u32).to_le_bytes());
    frame.extend_from_slice(&body);
    frame
}

/// Inverse of [`encode_envelope_frame`]; rejects a truncated or oversized frame.
pub fn decode_envelope_frame(frame: &[u8]) -> anyhow::Result<messages::Envelope> {
    if frame.len() < 4 {
        bail!("envelope frame shorter than its length prefix");
    }
    let length = u32::from_le_bytes([frame[0], frame[1], frame[2], frame[3]]) as usize;
    if length > MAX_FRAME_BYTES {
        bail!("envelope frame of {length} bytes exceeds the {MAX_FRAME_BYTES} byte ceiling");
    }
    let body = frame
        .get(4..4 + length)
        .ok_or_else(|| anyhow!("envelope frame truncated: {} < {}", frame.len() - 4, length))?;
    messages::Envelope::decode(body).map_err(Into::into)
}

/// 16 random bytes, hex.
fn random_hex() -> String {
    let mut bytes = [0u8; 16];
    rand::rng().fill_bytes(&mut bytes);
    hex::encode(bytes)
}
