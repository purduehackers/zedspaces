//! Cookie-gated private-port reverse proxy (brief §3.11; D8, D21).
//!
//! **Routing decision: one listener per proxy slot, slot-bound target port, no path prefix, no
//! Host routing.** Each declared sandbox port has its own `https://<id>.vercel.run` host, so the
//! Host header on a slot is constant; a path prefix breaks web apps that emit absolute paths. The
//! control plane allocates one of the four D21 slots (`8444-8447`) per private forward and every
//! request on slot `S` is forwarded verbatim to `127.0.0.1:<port bound to S>` (or `[::1]` when
//! the socket table shows a v6-only listener).
//!
//! Entry: `GET {origin}/api/workspaces/{id}/ports/{port}/open` → 303 to
//! `https://<slot-host>/__zs/auth?zs_port_token=<token>&next=/`; the proxy verifies the token
//! under `portSessionSecret`, binds the slot to the token's port when unbound (or follows
//! `forwards[].slot`), mints its cookie for its own host and redirects to `next`.
//!
//! The cookie is signed with a per-boot key that lives only in memory, so every resume invalidates
//! every cookie and a private port costs one click per session (nothing secret reaches the
//! snapshotted disk, BUILD-SPEC §10.4).

use std::collections::HashMap;
use std::convert::Infallible;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use anyhow::{Context as _, anyhow};
use bytes::Bytes;
use http_body_util::{BodyExt as _, Full};
use hyper::body::Incoming;
use hyper::header::{
    ACCEPT, CACHE_CONTROL, CONNECTION, CONTENT_TYPE, COOKIE, HOST, HeaderValue, LOCATION,
    REFERRER_POLICY, SET_COOKIE, UPGRADE,
};
use hyper::service::service_fn;
use hyper::{HeaderMap, Method, Request, Response, StatusCode, Uri};
use hyper_util::rt::{TokioIo, TokioTimer};
use rand::RngCore as _;
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{OwnedSemaphorePermit, Semaphore};
use tokio_util::sync::CancellationToken;

use crate::config::PROXY_SLOTS;
use crate::logs::{LogEntry, LogShipper, LogSource, now_ms, scrub};
use crate::manifest::{Forward, Visibility};
use crate::port_auth::{
    AuthError, BOOTSTRAP_MAX_AGE_SECS, BOOTSTRAP_PARAM, COOKIE_NAME, COOKIE_TTL_SECS, PortSession,
    PortTokenCodec, clear_cookie_header, cookie_from_header, decode_secret, safe_next,
    set_cookie_header,
};
use crate::ports::{ListeningState, is_infra_port};
use crate::state::{AgentState, ForwardsState, SlotError};

/// Bootstrap route on every slot.
pub const AUTH_PATH: &str = "/__zs/auth";
/// Cookie-clearing route on every slot.
pub const LOGOUT_PATH: &str = "/__zs/logout";
/// Plain requests in flight per slot; the permit is released at the 101 hand-off.
pub const MAX_INFLIGHT: usize = 256;
/// Upgraded tunnels per slot.
pub const MAX_UPGRADED: usize = 1024;
/// hyper `header_read_timeout` on the client side (requires `.timer(TokioTimer::new())` or hyper
/// panics) and the budget for the upstream's response head (§3.11 step 6: `504
/// upstream_timeout` beyond it; the body is never timed).
pub const HEADER_TIMEOUT: Duration = Duration::from_secs(30);

/// Boxed body type shared by the proxy and the API listeners.
pub type BoxBody = http_body_util::combinators::BoxBody<Bytes, hyper::Error>;

/// One slot's configuration; `bootstrap`/`cookies` are shared by all slots of a boot.
#[derive(Clone)]
pub struct ProxyConfig {
    /// Slot port (one of `Config::proxy_slots`).
    pub slot: u16,
    /// `proxy_bind_ip:slot` (tests override with an ephemeral port).
    pub listen: SocketAddr,
    /// Verifier keyed by `manifest.portSessionSecret`.
    pub bootstrap: Arc<PortTokenCodec>,
    /// Per-boot cookie signer.
    pub cookies: Arc<PortTokenCodec>,
    /// Expected `ws` claim.
    pub workspace_id: String,
    /// Emit `Secure` on cookies and `X-Forwarded-Proto: https`.
    pub secure_cookies: bool,
    /// Slot bindings.
    pub forwards: ForwardsState,
    /// Address-family hints for upstream selection.
    pub listening: ListeningState,
    /// Per-boot replay/revocation state, shared by every slot.
    pub sessions: Arc<SessionGuard>,
}

/// Per-boot replay and revocation state shared by every slot. A bootstrap token is redeemed
/// **once** (the control plane mints a fresh `jti` per `/open`, and the token travels in the
/// query string of a top-level navigation, i.e. browser history and every access log on the
/// way); a cookie whose `jti` was logged out is refused for the rest of its lifetime, so
/// `/__zs/logout` revokes rather than merely clearing the browser's copy. Both maps are pruned
/// of expired entries on every insert and live only in memory (a resume empties them, as it does
/// the cookie key).
#[derive(Default)]
pub struct SessionGuard {
    inner: parking_lot::Mutex<SessionGuardInner>,
}

#[derive(Default)]
struct SessionGuardInner {
    /// Redeemed bootstrap `jti` → `exp`.
    redeemed: HashMap<String, u64>,
    /// Revoked cookie `jti` → `exp`.
    revoked: HashMap<String, u64>,
}

impl SessionGuard {
    /// Records a bootstrap token as used; `false` when its `jti` was redeemed before.
    pub fn redeem(&self, jti: &str, exp: u64, now: u64) -> bool {
        let mut inner = self.inner.lock();
        prune(&mut inner.redeemed, now);
        if inner.redeemed.contains_key(jti) {
            return false;
        }
        inner.redeemed.insert(jti.to_string(), exp);
        true
    }

    /// Revokes a cookie until `exp`.
    pub fn revoke(&self, jti: &str, exp: u64, now: u64) {
        let mut inner = self.inner.lock();
        prune(&mut inner.revoked, now);
        inner.revoked.insert(jti.to_string(), exp);
    }

    /// Whether a cookie `jti` was revoked (and has not expired since).
    pub fn is_revoked(&self, jti: &str, now: u64) -> bool {
        let inner = self.inner.lock();
        inner.revoked.get(jti).is_some_and(|exp| *exp > now)
    }

    /// Entries tracked right now, `(redeemed, revoked)`; tests.
    pub fn len(&self) -> (usize, usize) {
        let inner = self.inner.lock();
        (inner.redeemed.len(), inner.revoked.len())
    }

    /// True when nothing is tracked.
    pub fn is_empty(&self) -> bool {
        self.len() == (0, 0)
    }
}

fn prune(map: &mut HashMap<String, u64>, now: u64) {
    map.retain(|_, exp| *exp > now);
}

/// `zs-agent proxy` arguments (brief §3.17): run only the proxy slots, without a manifest.
#[derive(clap::Args, Debug, Clone)]
pub struct ProxyArgs {
    /// Bind address for every slot.
    #[arg(long, default_value = "0.0.0.0")]
    pub bind_ip: IpAddr,
    /// Subset of the proxy slots to run (default: all of `8444,8445,8446,8447`).
    #[arg(long)]
    pub slot: Vec<u16>,
    /// File holding the base64 `portSessionSecret` (bootstrap key).
    #[arg(long, required = true)]
    pub secret_file: PathBuf,
    /// Expected `ws` claim.
    #[arg(long)]
    pub workspace_id: String,
    /// Initial `<slot>=<port>` bindings (tests).
    #[arg(long)]
    pub bind: Vec<String>,
    /// Omit `Secure` on cookies (plain http tests).
    #[arg(long)]
    pub insecure_cookies: bool,
}

/// Everything one slot's connection tasks share.
struct SlotRuntime {
    config: Arc<ProxyConfig>,
    logs: Option<LogShipper>,
    inflight: Arc<Semaphore>,
    upgraded: Arc<Semaphore>,
}

impl SlotRuntime {
    fn new(config: ProxyConfig, logs: Option<LogShipper>) -> Arc<Self> {
        Arc::new(Self {
            config: Arc::new(config),
            logs,
            inflight: Arc::new(Semaphore::new(MAX_INFLIGHT)),
            upgraded: Arc::new(Semaphore::new(MAX_UPGRADED)),
        })
    }

    /// Ships one `source: "proxy"` line; scrubbed, since request data flows through here.
    fn log(&self, level: &'static str, message: impl Into<String>) {
        let message = message.into();
        tracing::debug!(target: "zs_agent::proxy", slot = self.config.slot, "{message}");
        if let Some(shipper) = &self.logs {
            shipper.push(LogEntry {
                ts: now_ms(),
                level,
                source: LogSource::Proxy.as_str().to_string(),
                msg: scrub(&message).into_owned(),
                fields: None,
            });
        }
    }
}

/// Binds one slot's listener. Split out of [`run`] so `run_all` can report `proxy.running` only
/// once every slot is bound, and so tests can serve on an ephemeral port they can read back.
pub async fn bind(config: &ProxyConfig) -> std::io::Result<TcpListener> {
    TcpListener::bind(config.listen).await
}

/// One task per slot; binds all of them first, marks `proxy.running`, then serves until
/// `shutdown`.
pub async fn run_all(
    configs: Vec<ProxyConfig>,
    state: Arc<AgentState>,
    logs: LogShipper,
    shutdown: CancellationToken,
) -> anyhow::Result<()> {
    let mut bound = Vec::with_capacity(configs.len());
    for config in configs {
        let listener = bind(&config)
            .await
            .with_context(|| format!("binding proxy slot {} on {}", config.slot, config.listen))?;
        bound.push((listener, config));
    }
    let slots: Vec<u16> = bound.iter().map(|(_, config)| config.slot).collect();
    state.update(|inner| {
        inner.proxy_slots = slots.clone();
        inner.proxy_running = true;
    });
    tracing::info!(slots = ?slots, "proxy slots listening");

    let mut tasks = Vec::with_capacity(bound.len());
    for (listener, config) in bound {
        tasks.push(tokio::spawn(serve(
            listener,
            config,
            Some(logs.clone()),
            shutdown.clone(),
        )));
    }
    for task in tasks {
        let _ = task.await;
    }
    state.update(|inner| inner.proxy_running = false);
    Ok(())
}

/// One slot: bind, then [`serve`].
pub async fn run(
    config: ProxyConfig,
    state: Arc<AgentState>,
    logs: LogShipper,
    shutdown: CancellationToken,
) -> anyhow::Result<()> {
    run_all(vec![config], state, logs, shutdown).await
}

/// Accept loop over an already-bound listener: `hyper::server::conn::http1::Builder` with
/// `.timer(TokioTimer::new()).header_read_timeout(HEADER_TIMEOUT)` and
/// `serve_connection(..).with_upgrades()`. Returns when `shutdown` fires; in-flight tunnels are
/// dropped with the runtime.
pub async fn serve(
    listener: TcpListener,
    config: ProxyConfig,
    logs: Option<LogShipper>,
    shutdown: CancellationToken,
) {
    let slot = config.slot;
    let runtime = SlotRuntime::new(config, logs);
    loop {
        let accepted = tokio::select! {
            _ = shutdown.cancelled() => break,
            accepted = listener.accept() => accepted,
        };
        let (stream, peer) = match accepted {
            Ok(pair) => pair,
            Err(error) => {
                runtime.log("warn", format!("slot {slot} accept failed: {error}"));
                continue;
            }
        };
        let _ = stream.set_nodelay(true);
        let runtime = runtime.clone();
        tokio::spawn(async move {
            let service = service_fn(move |req: Request<Incoming>| {
                let runtime = runtime.clone();
                async move { handle(runtime, peer, req).await }
            });
            let connection = hyper::server::conn::http1::Builder::new()
                .timer(TokioTimer::new())
                .header_read_timeout(HEADER_TIMEOUT)
                .serve_connection(TokioIo::new(stream), service)
                .with_upgrades();
            if let Err(error) = connection.await {
                tracing::debug!(target: "zs_agent::proxy", slot, %error, "connection ended");
            }
        });
    }
    tracing::info!(slot, "proxy slot stopped");
}

/// `zs-agent proxy`: builds one [`ProxyConfig`] per requested slot from [`ProxyArgs`] and runs
/// them until `SIGTERM`/`SIGINT`. Used by the image smoke test and by operators; it reads no
/// manifest, so `--bind` seeds the forward list the control plane would otherwise supply.
pub async fn run_standalone(args: ProxyArgs) -> anyhow::Result<()> {
    let secret_text = std::fs::read_to_string(&args.secret_file)
        .with_context(|| format!("reading {}", args.secret_file.display()))?;
    let key = decode_secret(&secret_text)
        .map_err(|error| anyhow!("{}: {error}", args.secret_file.display()))?;
    let slots = if args.slot.is_empty() {
        PROXY_SLOTS.to_vec()
    } else {
        args.slot.clone()
    };
    let forwards = ForwardsState::with_slots(&slots);
    for spec in &args.bind {
        let (slot, port) = parse_bind(spec)?;
        if !slots.contains(&slot) {
            return Err(anyhow!("--bind {spec}: {slot} is not one of the slots"));
        }
        if is_infra_port(port) || port == 0 {
            return Err(anyhow!("--bind {spec}: {port} is not a forwardable port"));
        }
        forwards.insert(Forward {
            port,
            visibility: Visibility::Private,
            label: None,
            url: None,
            slot: Some(slot),
        });
    }

    let bootstrap = Arc::new(PortTokenCodec::new(key));
    let cookies = Arc::new(PortTokenCodec::random());
    let listening = ListeningState::default();
    let sessions = Arc::new(SessionGuard::default());
    let configs: Vec<ProxyConfig> = slots
        .iter()
        .map(|slot| ProxyConfig {
            slot: *slot,
            listen: SocketAddr::new(args.bind_ip, *slot),
            bootstrap: bootstrap.clone(),
            cookies: cookies.clone(),
            workspace_id: args.workspace_id.clone(),
            secure_cookies: !args.insecure_cookies,
            forwards: forwards.clone(),
            listening: listening.clone(),
            sessions: sessions.clone(),
        })
        .collect();

    let build = std::env::var("ZS_BUILD_ID").unwrap_or_else(|_| "dev".to_string());
    let state = AgentState::new(build, None);
    let shutdown = CancellationToken::new();
    spawn_signal_handler(shutdown.clone());

    let mut bound = Vec::with_capacity(configs.len());
    for config in configs {
        let listener = bind(&config)
            .await
            .with_context(|| format!("binding proxy slot {} on {}", config.slot, config.listen))?;
        bound.push((listener, config));
    }
    state.update(|inner| inner.proxy_running = true);
    let mut tasks = Vec::with_capacity(bound.len());
    for (listener, config) in bound {
        tasks.push(tokio::spawn(serve(
            listener,
            config,
            None,
            shutdown.clone(),
        )));
    }
    for task in tasks {
        let _ = task.await;
    }
    Ok(())
}

/// `SIGTERM`/`SIGINT` → cancel, for the standalone proxy (the full agent installs its own).
fn spawn_signal_handler(shutdown: CancellationToken) {
    tokio::spawn(async move {
        use tokio::signal::unix::{SignalKind, signal};
        let (Ok(mut term), Ok(mut interrupt)) = (
            signal(SignalKind::terminate()),
            signal(SignalKind::interrupt()),
        ) else {
            return;
        };
        tokio::select! {
            _ = term.recv() => {}
            _ = interrupt.recv() => {}
        }
        shutdown.cancel();
    });
}

/// `"<slot>=<port>"`.
fn parse_bind(spec: &str) -> anyhow::Result<(u16, u16)> {
    let (slot, port) = spec
        .split_once('=')
        .ok_or_else(|| anyhow!("--bind {spec}: expected <slot>=<port>"))?;
    Ok((
        slot.trim()
            .parse()
            .with_context(|| format!("--bind {spec}: slot"))?,
        port.trim()
            .parse()
            .with_context(|| format!("--bind {spec}: port"))?,
    ))
}

/// Request flow (§3.11): `/__zs/auth` bootstrap → cookie → forward (origin-form URI, hop-by-hop
/// headers stripped but `Upgrade`/`Sec-WebSocket-*` kept and `Connection: upgrade` re-inserted,
/// `Host: 127.0.0.1:<port>`, `X-Forwarded-*`, `zs_port_session` stripped from `Cookie`), 101
/// tunnelled with `copy_bidirectional`; 502 `upstream_unavailable` on connect refusal.
async fn handle(
    runtime: Arc<SlotRuntime>,
    peer: SocketAddr,
    req: Request<Incoming>,
) -> Result<Response<BoxBody>, Infallible> {
    let Ok(permit) = runtime.inflight.clone().try_acquire_owned() else {
        return Ok(json_response(
            StatusCode::SERVICE_UNAVAILABLE,
            serde_json::json!({ "error": "proxy_busy" }),
        ));
    };
    let path = req.uri().path().to_string();
    if path == AUTH_PATH {
        return Ok(bootstrap_route(&runtime, &req, peer));
    }
    if path == LOGOUT_PATH {
        return Ok(logout_route(&runtime, &req));
    }
    Ok(forward(runtime, req, permit).await)
}

/// `/__zs/logout`: revokes the presented cookie (if it verifies) for the rest of its lifetime
/// and clears it in the browser.
fn logout_route(runtime: &SlotRuntime, req: &Request<Incoming>) -> Response<BoxBody> {
    let config = &runtime.config;
    let now = now_ms() / 1000;
    if let Some(cookie) = req
        .headers()
        .get(COOKIE)
        .and_then(|value| value.to_str().ok())
        .and_then(cookie_from_header)
        && let Ok(session) =
            config
                .cookies
                .verify(cookie, &config.workspace_id, now, COOKIE_TTL_SECS)
    {
        config.sessions.revoke(&session.jti, session.exp, now);
        runtime.log(
            "info",
            format!(
                "slot {} revoked a session for port {}",
                config.slot, session.port
            ),
        );
    }
    let mut response = empty_response(StatusCode::NO_CONTENT);
    set_cookie(&mut response, clear_cookie_header(config.secure_cookies));
    response
}

/// `GET /__zs/auth?zs_port_token=…&next=…`: verify the control plane's bootstrap token, bind the
/// slot, mint this slot's cookie and redirect to `next`.
fn bootstrap_route(
    runtime: &SlotRuntime,
    req: &Request<Incoming>,
    peer: SocketAddr,
) -> Response<BoxBody> {
    let config = &runtime.config;
    if req.method() != Method::GET {
        return json_response(
            StatusCode::METHOD_NOT_ALLOWED,
            serde_json::json!({ "error": "method_not_allowed" }),
        );
    }
    let query = req.uri().query().unwrap_or_default();
    let Some(token) = query_param(query, BOOTSTRAP_PARAM) else {
        return auth_failure(
            runtime,
            req,
            StatusCode::UNAUTHORIZED,
            "port_session_required",
        );
    };
    let now = now_ms() / 1000;
    let session =
        match config
            .bootstrap
            .verify(&token, &config.workspace_id, now, BOOTSTRAP_MAX_AGE_SECS)
        {
            Ok(session) => session,
            Err(error) => {
                runtime.log(
                    "warn",
                    format!(
                        "slot {} rejected a bootstrap token from {}: {error}",
                        config.slot,
                        peer.ip()
                    ),
                );
                let code = match error {
                    AuthError::Expired => "port_session_expired",
                    AuthError::WrongWorkspace => "wrong_workspace",
                    AuthError::BadPort => "port_not_allowed",
                    _ => "port_session_invalid",
                };
                return auth_failure(runtime, req, StatusCode::UNAUTHORIZED, code);
            }
        };
    // Single use: a replayed token (browser history, an access log, a shared link) mints no
    // second cookie; the control plane's `/open` hands out a fresh one per click.
    if !config.sessions.redeem(&session.jti, session.exp, now) {
        runtime.log(
            "warn",
            format!(
                "slot {} refused a replayed bootstrap token from {}",
                config.slot,
                peer.ip()
            ),
        );
        return auth_failure(
            runtime,
            req,
            StatusCode::UNAUTHORIZED,
            "port_session_invalid",
        );
    }

    // Slot binding: follow `forwards[].slot` when the control plane sent one, otherwise let the
    // first valid token bind this slot to its port (§3.11). A port that another slot already
    // serves is never moved: that would invalidate every cookie on the original slot host.
    match config.forwards.slot_port(config.slot) {
        Some(bound) if bound == session.port => {}
        Some(_) => {
            return auth_failure(runtime, req, StatusCode::UNAUTHORIZED, "port_session_stale");
        }
        None => match config.forwards.bind_slot(config.slot, session.port) {
            Ok(()) => runtime.log(
                "info",
                format!("slot {} bound to port {}", config.slot, session.port),
            ),
            Err(SlotError::SlotBusy { .. } | SlotError::PortBoundElsewhere { .. }) => {
                return auth_failure(runtime, req, StatusCode::UNAUTHORIZED, "port_session_stale");
            }
            Err(error) => {
                runtime.log(
                    "warn",
                    format!(
                        "slot {} cannot serve port {}: {error}",
                        config.slot, session.port
                    ),
                );
                return json_response(
                    StatusCode::NOT_FOUND,
                    serde_json::json!({ "error": "port_not_forwarded", "port": session.port }),
                );
            }
        },
    }

    let cookie = config.cookies.sign(&PortSession {
        ws: config.workspace_id.clone(),
        port: session.port,
        sub: session.sub,
        iat: now,
        exp: now + COOKIE_TTL_SECS,
        jti: random_jti(),
    });
    let next = safe_next(query_param(query, "next").as_deref());
    let mut response = empty_response(StatusCode::SEE_OTHER);
    if let Ok(location) = HeaderValue::from_str(&next) {
        response.headers_mut().insert(LOCATION, location);
    }
    // The token is in this request's URL; keep it out of the Referer of whatever `next` loads.
    response
        .headers_mut()
        .insert(REFERRER_POLICY, HeaderValue::from_static("no-referrer"));
    set_cookie(
        &mut response,
        set_cookie_header(&cookie, COOKIE_TTL_SECS, config.secure_cookies),
    );
    response
}

/// Cookie check, then a verbatim reverse proxy to the slot's bound port.
async fn forward(
    runtime: Arc<SlotRuntime>,
    mut req: Request<Incoming>,
    permit: OwnedSemaphorePermit,
) -> Response<BoxBody> {
    let target = match authorize(&runtime, &req) {
        Ok(port) => port,
        Err(response) => return *response,
    };
    let upstream_addr = SocketAddr::new(upstream_ip(&runtime.config.listening, target), target);
    let stream = match TcpStream::connect(upstream_addr).await {
        Ok(stream) => stream,
        Err(error) => {
            runtime.log(
                "warn",
                format!("upstream {upstream_addr} unavailable: {error}"),
            );
            return json_response(
                StatusCode::BAD_GATEWAY,
                serde_json::json!({ "error": "upstream_unavailable", "port": target }),
            );
        }
    };
    let _ = stream.set_nodelay(true);
    let (mut sender, connection) =
        match hyper::client::conn::http1::handshake(TokioIo::new(stream)).await {
            Ok(pair) => pair,
            Err(error) => {
                runtime.log(
                    "warn",
                    format!("upstream {upstream_addr} handshake: {error}"),
                );
                return json_response(
                    StatusCode::BAD_GATEWAY,
                    serde_json::json!({ "error": "upstream_unavailable", "port": target }),
                );
            }
        };
    // `with_upgrades` on the client connection is what makes `hyper::upgrade::on(response)` work.
    tokio::spawn(async move {
        if let Err(error) = connection.with_upgrades().await {
            tracing::debug!(target: "zs_agent::proxy", %error, "upstream connection ended");
        }
    });

    // Take the client's upgrade handle out before the request is consumed.
    let client_upgrade = hyper::upgrade::on(&mut req);
    let original_host = req
        .headers()
        .get(HOST)
        .and_then(|value| value.to_str().ok())
        .map(str::to_string);
    let scheme = if runtime.config.secure_cookies {
        "https".to_string()
    } else {
        req.uri().scheme_str().unwrap_or("http").to_string()
    };
    let origin_form: Uri = req
        .uri()
        .path_and_query()
        .map(|path_and_query| path_and_query.as_str())
        .unwrap_or("/")
        .parse()
        .unwrap_or_else(|_| Uri::from_static("/"));
    *req.uri_mut() = origin_form;
    {
        let headers = req.headers_mut();
        strip_hop_by_hop(headers);
        match headers
            .get(COOKIE)
            .and_then(|value| value.to_str().ok())
            .map(strip_port_cookie)
        {
            Some(Some(kept)) => {
                if let Ok(value) = HeaderValue::from_str(&kept) {
                    headers.insert(COOKIE, value);
                }
            }
            Some(None) => {
                headers.remove(COOKIE);
            }
            None => {}
        }
        if let Ok(host) = HeaderValue::from_str(&upstream_addr.to_string()) {
            headers.insert(HOST, host);
        }
        if let Some(value) = original_host.and_then(|host| HeaderValue::from_str(&host).ok()) {
            headers.insert("x-forwarded-host", value);
        }
        headers.insert(
            "x-forwarded-proto",
            HeaderValue::from_str(&scheme).unwrap_or(HeaderValue::from_static("https")),
        );
        headers.insert(
            "x-forwarded-port",
            HeaderValue::from_str(&target.to_string()).unwrap_or(HeaderValue::from_static("0")),
        );
    }

    // §3.11 step 6: the response head must arrive within HEADER_TIMEOUT so a hung upstream cannot
    // pin an inflight permit for as long as the browser keeps its socket open; the body streams
    // untimed after that.
    let mut response = match tokio::time::timeout(HEADER_TIMEOUT, sender.send_request(req)).await {
        Ok(Ok(response)) => response,
        Ok(Err(error)) => {
            runtime.log("warn", format!("upstream {upstream_addr} failed: {error}"));
            return json_response(
                StatusCode::BAD_GATEWAY,
                serde_json::json!({ "error": "upstream_unavailable", "port": target }),
            );
        }
        Err(_) => {
            runtime.log(
                "warn",
                format!(
                    "upstream {upstream_addr} sent no response head within {}s",
                    HEADER_TIMEOUT.as_secs()
                ),
            );
            return json_response(
                StatusCode::GATEWAY_TIMEOUT,
                serde_json::json!({ "error": "upstream_timeout", "port": target }),
            );
        }
    };

    if response.status() != StatusCode::SWITCHING_PROTOCOLS {
        let (parts, body) = response.into_parts();
        let mut response = Response::from_parts(parts, body.boxed());
        strip_hop_by_hop(response.headers_mut());
        return response;
    }

    // 101: hand the two upgraded streams to a tunnel task and release the request permit, so a
    // slot full of idle WebSockets never starves plain requests.
    let upstream_upgrade = hyper::upgrade::on(&mut response);
    let (parts, _body) = response.into_parts();
    let mut client_response = Response::from_parts(parts, full_body(Bytes::new()));
    strip_hop_by_hop(client_response.headers_mut());
    drop(permit);
    let Ok(tunnel_permit) = runtime.upgraded.clone().try_acquire_owned() else {
        return json_response(
            StatusCode::SERVICE_UNAVAILABLE,
            serde_json::json!({ "error": "too_many_tunnels" }),
        );
    };
    tokio::spawn(async move {
        let _permit = tunnel_permit;
        match tokio::try_join!(client_upgrade, upstream_upgrade) {
            Ok((client_io, upstream_io)) => {
                let mut client_io = TokioIo::new(client_io);
                let mut upstream_io = TokioIo::new(upstream_io);
                if let Err(error) =
                    tokio::io::copy_bidirectional(&mut client_io, &mut upstream_io).await
                {
                    tracing::debug!(target: "zs_agent::proxy", %error, "tunnel ended");
                }
            }
            Err(error) => {
                tracing::debug!(target: "zs_agent::proxy", %error, "upgrade failed");
            }
        }
    });
    client_response
}

/// Cookie → slot binding → target port, or the 401/404 to answer with.
fn authorize(
    runtime: &SlotRuntime,
    req: &Request<Incoming>,
) -> Result<u16, Box<Response<BoxBody>>> {
    let config = &runtime.config;
    let cookie = req
        .headers()
        .get(COOKIE)
        .and_then(|value| value.to_str().ok())
        .and_then(cookie_from_header);
    let Some(cookie) = cookie else {
        return Err(Box::new(auth_failure(
            runtime,
            req,
            StatusCode::UNAUTHORIZED,
            "port_session_required",
        )));
    };
    let now = now_ms() / 1000;
    let session = config
        .cookies
        .verify(cookie, &config.workspace_id, now, COOKIE_TTL_SECS)
        .map_err(|_| {
            Box::new(auth_failure(
                runtime,
                req,
                StatusCode::UNAUTHORIZED,
                "port_session_required",
            ))
        })?;
    if config.sessions.is_revoked(&session.jti, now) {
        return Err(Box::new(auth_failure(
            runtime,
            req,
            StatusCode::UNAUTHORIZED,
            "port_session_required",
        )));
    }
    match config.forwards.slot_port(config.slot) {
        None => Err(Box::new(json_response(
            StatusCode::NOT_FOUND,
            serde_json::json!({ "error": "slot_unbound" }),
        ))),
        Some(bound) if bound != session.port => Err(Box::new(auth_failure(
            runtime,
            req,
            StatusCode::UNAUTHORIZED,
            "port_session_stale",
        ))),
        Some(bound) => Ok(bound),
    }
}

/// The refusal body for a missing/rejected cookie or token: JSON, or a bare HTML page for a
/// browser navigation. It carries no link back – the control plane owns the entry link – and it
/// always clears the cookie.
fn auth_failure(
    runtime: &SlotRuntime,
    req: &Request<Incoming>,
    status: StatusCode,
    code: &str,
) -> Response<BoxBody> {
    let wants_html = req
        .headers()
        .get(ACCEPT)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|accept| accept.contains("text/html"));
    let mut response = if wants_html {
        html_response(
            status,
            "<!doctype html><meta charset=\"utf-8\"><title>Sign in required</title>\
             <h1>This port is private</h1>\
             <p>Open it from your workspace's ports panel to sign in.</p>",
        )
    } else {
        json_response(status, serde_json::json!({ "error": code }))
    };
    set_cookie(
        &mut response,
        clear_cookie_header(runtime.config.secure_cookies),
    );
    response
}

/// Removes hop-by-hop headers (`Connection`, `Keep-Alive`, `Proxy-*`, `TE`, `Trailer`,
/// `Transfer-Encoding`), keeping `Upgrade` and `Sec-WebSocket-*`, then re-inserts
/// `Connection: upgrade` when `Upgrade` is present.
fn strip_hop_by_hop(headers: &mut HeaderMap) {
    for name in [
        "connection",
        "keep-alive",
        "proxy-authenticate",
        "proxy-authorization",
        "proxy-connection",
        "te",
        "trailer",
        "transfer-encoding",
    ] {
        headers.remove(name);
    }
    ensure_connection_upgrade(headers);
}

/// Inserts `Connection: upgrade` iff `Upgrade` is present (tungstenite and Node refuse the
/// handshake without it).
fn ensure_connection_upgrade(headers: &mut HeaderMap) {
    if headers.contains_key(UPGRADE) {
        headers.insert(CONNECTION, HeaderValue::from_static("upgrade"));
    }
}

/// Drops the `zs_port_session` pair from a `Cookie` header value; `None` when nothing is left.
fn strip_port_cookie(cookie_header: &str) -> Option<String> {
    let prefix = format!("{COOKIE_NAME}=");
    let kept: Vec<&str> = cookie_header
        .split(';')
        .map(str::trim)
        .filter(|pair| !pair.is_empty() && !pair.starts_with(&prefix))
        .collect();
    (!kept.is_empty()).then(|| kept.join("; "))
}

/// `127.0.0.1` unless the port is v6-only → `::1`.
fn upstream_ip(listening: &ListeningState, port: u16) -> IpAddr {
    match listening.address_family(port) {
        Some((false, true)) => IpAddr::V6(Ipv6Addr::LOCALHOST),
        _ => IpAddr::V4(Ipv4Addr::LOCALHOST),
    }
}

/// One value from an `a=b&c=d` query string, with `%XX` decoded (`+` is left alone: these values
/// are URL paths, where a literal `+` is not a space).
fn query_param(query: &str, name: &str) -> Option<String> {
    query
        .split('&')
        .filter_map(|pair| pair.split_once('='))
        .find(|(key, _)| *key == name)
        .map(|(_, value)| percent_decode(value))
        .filter(|value| !value.is_empty())
}

/// Decodes `%XX` escapes; invalid escapes are kept verbatim.
fn percent_decode(value: &str) -> String {
    let bytes = value.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' && index + 2 < bytes.len() {
            let hex = std::str::from_utf8(&bytes[index + 1..index + 3])
                .ok()
                .and_then(|hex| u8::from_str_radix(hex, 16).ok());
            if let Some(byte) = hex {
                out.push(byte);
                index += 3;
                continue;
            }
        }
        out.push(bytes[index]);
        index += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// 16 random bytes, hex; the token's replay id.
fn random_jti() -> String {
    let mut bytes = [0u8; 16];
    rand::rng().fill_bytes(&mut bytes);
    hex::encode(bytes)
}

/// Appends a `Set-Cookie` header, ignoring an unrepresentable value.
fn set_cookie(response: &mut Response<BoxBody>, value: String) {
    if let Ok(value) = HeaderValue::from_str(&value) {
        response.headers_mut().append(SET_COOKIE, value);
    }
}

/// A complete in-memory body.
pub fn full_body(bytes: impl Into<Bytes>) -> BoxBody {
    Full::new(bytes.into())
        .map_err(|never| match never {})
        .boxed()
}

/// A JSON response with `Cache-Control: no-store`.
pub fn json_response(status: StatusCode, json: serde_json::Value) -> Response<BoxBody> {
    let mut response = Response::new(full_body(serde_json::to_vec(&json).unwrap_or_default()));
    *response.status_mut() = status;
    response
        .headers_mut()
        .insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
    response
        .headers_mut()
        .insert(CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response
}

/// A bodyless response with `Cache-Control: no-store` (204 and 303).
pub fn empty_response(status: StatusCode) -> Response<BoxBody> {
    let mut response = Response::new(full_body(Bytes::new()));
    *response.status_mut() = status;
    response
        .headers_mut()
        .insert(CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response
}

/// An HTML response with `Cache-Control: no-store` (browser navigations to a private port).
pub fn html_response(status: StatusCode, html: &'static str) -> Response<BoxBody> {
    let mut response = Response::new(full_body(Bytes::from_static(html.as_bytes())));
    *response.status_mut() = status;
    response.headers_mut().insert(
        CONTENT_TYPE,
        HeaderValue::from_static("text/html; charset=utf-8"),
    );
    response
        .headers_mut()
        .insert(CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ports::ListeningPort;

    #[test]
    fn strip_hop_by_hop_keeps_upgrade_and_readds_connection() {
        let mut headers = HeaderMap::new();
        headers.insert(CONNECTION, HeaderValue::from_static("keep-alive"));
        headers.insert("transfer-encoding", HeaderValue::from_static("chunked"));
        headers.insert("upgrade", HeaderValue::from_static("websocket"));
        headers.insert("sec-websocket-key", HeaderValue::from_static("abc"));
        strip_hop_by_hop(&mut headers);
        assert!(!headers.contains_key("transfer-encoding"));
        assert_eq!(headers.get(CONNECTION).unwrap(), "upgrade");
        assert!(headers.contains_key("sec-websocket-key"));
        assert_eq!(headers.get("upgrade").unwrap(), "websocket");
    }

    #[test]
    fn no_upgrade_no_connection_header() {
        let mut headers = HeaderMap::new();
        headers.insert(CONNECTION, HeaderValue::from_static("keep-alive"));
        headers.insert("te", HeaderValue::from_static("trailers"));
        strip_hop_by_hop(&mut headers);
        assert!(!headers.contains_key(CONNECTION));
        assert!(!headers.contains_key("te"));
    }

    #[test]
    fn strip_port_cookie_keeps_the_rest() {
        assert_eq!(
            strip_port_cookie("a=1; zs_port_session=v1.x.y; b=2"),
            Some("a=1; b=2".to_string())
        );
        assert_eq!(strip_port_cookie("zs_port_session=v1.x.y"), None);
        assert_eq!(
            strip_port_cookie("zs_port_session_other=1"),
            Some("zs_port_session_other=1".to_string())
        );
    }

    #[test]
    fn upstream_ip_prefers_v4() {
        let listening = ListeningState::default();
        listening.set(vec![
            ListeningPort {
                port: 3000,
                pid: 1,
                process_name: "node".into(),
                v4: false,
                v6: true,
                loopback_only: true,
            },
            ListeningPort {
                port: 4000,
                pid: 1,
                process_name: "node".into(),
                v4: true,
                v6: true,
                loopback_only: false,
            },
        ]);
        assert_eq!(
            upstream_ip(&listening, 3000),
            IpAddr::V6(Ipv6Addr::LOCALHOST)
        );
        assert_eq!(
            upstream_ip(&listening, 4000),
            IpAddr::V4(Ipv4Addr::LOCALHOST)
        );
        assert_eq!(
            upstream_ip(&listening, 5000),
            IpAddr::V4(Ipv4Addr::LOCALHOST)
        );
    }

    #[test]
    fn query_params_are_decoded() {
        let query = "zs_port_token=v1.a.b&next=%2Fa%3Fb%3D1";
        assert_eq!(
            query_param(query, BOOTSTRAP_PARAM).as_deref(),
            Some("v1.a.b")
        );
        assert_eq!(query_param(query, "next").as_deref(), Some("/a?b=1"));
        assert_eq!(query_param(query, "missing"), None);
        assert_eq!(query_param("next=", "next"), None);
        assert_eq!(percent_decode("a+b%2"), "a+b%2");
    }

    #[test]
    fn bind_specs_parse() {
        assert_eq!(parse_bind("8444=3000").unwrap(), (8444, 3000));
        assert!(parse_bind("8444").is_err());
        assert!(parse_bind("x=3000").is_err());
    }

    #[test]
    fn next_open_redirect_vectors_fall_back_to_root() {
        // Straight from the query string: decoded by `query_param`, judged by `safe_next`.
        for query in [
            "zs_port_token=t&next=%2F%09%2Fevil.example",
            "zs_port_token=t&next=%2F%0a%2Fevil.example",
            "zs_port_token=t&next=%2F%0d%0a%2Fevil.example",
            "zs_port_token=t&next=%2F%5c%5cevil.example",
            "zs_port_token=t&next=%2F%2f%09%2fevil.example",
            "zs_port_token=t&next=%2F%2Fevil.example",
            "zs_port_token=t&next=%2F%5Cevil.example",
            "zs_port_token=t&next=https%3A%2F%2Fevil.example",
            "zs_port_token=t&next=%2F%00%2Fevil.example",
        ] {
            let next = safe_next(query_param(query, "next").as_deref());
            assert_eq!(next, "/", "{query}");
            assert!(HeaderValue::from_str(&next).is_ok());
        }
        let next = safe_next(query_param("next=%2Fapp%2Fpage%3Fq%3Dcaf%C3%A9", "next").as_deref());
        assert_eq!(next, "/app/page?q=caf%C3%A9");
        assert!(HeaderValue::from_str(&next).is_ok());
    }

    #[test]
    fn session_guard_redeems_once_and_revokes_until_expiry() {
        let guard = SessionGuard::default();
        assert!(guard.is_empty());
        assert!(guard.redeem("j1", 1_000, 100));
        assert!(!guard.redeem("j1", 1_000, 100), "a second use is a replay");
        assert!(guard.redeem("j2", 1_000, 100));
        assert_eq!(guard.len(), (2, 0));
        // Expired entries are pruned on the next insert.
        assert!(guard.redeem("j3", 5_000, 2_000));
        assert_eq!(guard.len(), (1, 0));
        assert!(
            guard.redeem("j1", 5_000, 2_000),
            "an expired jti cannot be replayed anyway"
        );
        guard.revoke("c1", 3_000, 2_000);
        assert!(guard.is_revoked("c1", 2_500));
        assert!(
            !guard.is_revoked("c1", 3_000),
            "revocation ends with the cookie"
        );
        assert!(!guard.is_revoked("c2", 2_500));
    }
}
