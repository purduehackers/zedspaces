//! End-to-end tests for the private-port proxy (brief §6.2 `proxy_roundtrip.rs`).
//!
//! Two slots run on ephemeral loopback ports sharing one bootstrap codec, in front of in-process
//! upstreams: one on `127.0.0.1:0` that echoes `method path?query` and performs a **strict**
//! WebSocket handshake (it refuses a request without `Connection: upgrade`, exactly as tungstenite
//! and Node's parser do), and one bound only to `[::1]:0`.

use std::collections::HashMap;
use std::convert::Infallible;
use std::net::SocketAddr;
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use futures_util::{SinkExt as _, StreamExt as _};
use http_body_util::{BodyExt as _, Full};
use hyper::body::{Bytes, Incoming};
use hyper::service::service_fn;
use hyper::{Request, Response, StatusCode};
use hyper_util::rt::TokioIo;
use tokio::net::{TcpListener, TcpStream};
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::client::IntoClientRequest as _;
use tokio_tungstenite::tungstenite::handshake::derive_accept_key;
use tokio_tungstenite::tungstenite::protocol::Role;
use tokio_util::sync::CancellationToken;

use zs_agent::manifest::{Forward, Visibility};
use zs_agent::port_auth::{COOKIE_NAME, PortSession, PortTokenCodec};
use zs_agent::ports::{ListeningPort, ListeningState};
use zs_agent::proxy::{self, BoxBody, ProxyConfig, SessionGuard};
use zs_agent::state::ForwardsState;

const WORKSPACE: &str = "ws_test";
const SECRET: [u8; 32] = [3u8; 32];

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs()
}

fn full(bytes: impl Into<Bytes>) -> BoxBody {
    Full::new(bytes.into())
        .map_err(|never| match never {})
        .boxed()
}

/// What the upstream saw on one request.
#[derive(Clone, Debug, Default)]
struct Seen {
    host: Option<String>,
    cookie: Option<String>,
    forwarded_host: Option<String>,
    forwarded_proto: Option<String>,
    forwarded_port: Option<String>,
}

/// In-process origin server behind a slot.
struct Upstream {
    addr: SocketAddr,
    seen: Arc<Mutex<Vec<Seen>>>,
}

impl Upstream {
    async fn start(bind: &str) -> Self {
        let listener = TcpListener::bind(bind).await.unwrap();
        let addr = listener.local_addr().unwrap();
        let seen = Arc::new(Mutex::new(Vec::new()));
        let recorder = seen.clone();
        tokio::spawn(async move {
            loop {
                let Ok((stream, _)) = listener.accept().await else {
                    return;
                };
                let recorder = recorder.clone();
                tokio::spawn(async move {
                    let service = service_fn(move |req: Request<Incoming>| {
                        let recorder = recorder.clone();
                        async move { Ok::<_, Infallible>(respond(req, recorder)) }
                    });
                    let _ = hyper::server::conn::http1::Builder::new()
                        .serve_connection(TokioIo::new(stream), service)
                        .with_upgrades()
                        .await;
                });
            }
        });
        Self { addr, seen }
    }

    fn seen(&self) -> Vec<Seen> {
        self.seen.lock().unwrap().clone()
    }
}

fn header(req: &Request<Incoming>, name: &str) -> Option<String> {
    req.headers()
        .get(name)
        .and_then(|value| value.to_str().ok())
        .map(str::to_string)
}

/// Echoes `method path?query`, or performs a strict WebSocket handshake and echoes frames.
fn respond(mut req: Request<Incoming>, recorder: Arc<Mutex<Vec<Seen>>>) -> Response<BoxBody> {
    recorder.lock().unwrap().push(Seen {
        host: header(&req, "host"),
        cookie: header(&req, "cookie"),
        forwarded_host: header(&req, "x-forwarded-host"),
        forwarded_proto: header(&req, "x-forwarded-proto"),
        forwarded_port: header(&req, "x-forwarded-port"),
    });

    let upgrade = header(&req, "upgrade").unwrap_or_default().to_lowercase();
    if upgrade == "websocket" {
        let connection = header(&req, "connection")
            .unwrap_or_default()
            .to_lowercase();
        let key = header(&req, "sec-websocket-key");
        // Strict, like tungstenite: no `Connection: upgrade` (or no key) → refuse.
        let (Some(key), true) = (key, connection.contains("upgrade")) else {
            let mut response = Response::new(full("missing connection: upgrade"));
            *response.status_mut() = StatusCode::BAD_REQUEST;
            return response;
        };
        let accept = derive_accept_key(key.as_bytes());
        tokio::spawn(async move {
            let Ok(upgraded) = hyper::upgrade::on(&mut req).await else {
                return;
            };
            let mut socket = tokio_tungstenite::WebSocketStream::from_raw_socket(
                TokioIo::new(upgraded),
                Role::Server,
                None,
            )
            .await;
            while let Some(Ok(message)) = socket.next().await {
                match message {
                    Message::Text(text) => {
                        if socket
                            .send(Message::Text(format!("echo:{text}")))
                            .await
                            .is_err()
                        {
                            return;
                        }
                    }
                    Message::Close(_) => return,
                    _ => {}
                }
            }
        });
        let mut response = Response::new(full(Bytes::new()));
        *response.status_mut() = StatusCode::SWITCHING_PROTOCOLS;
        let headers = response.headers_mut();
        headers.insert("upgrade", "websocket".parse().unwrap());
        headers.insert("connection", "Upgrade".parse().unwrap());
        headers.insert("sec-websocket-accept", accept.parse().unwrap());
        return response;
    }

    let path = req
        .uri()
        .path_and_query()
        .map(|pq| pq.as_str().to_string())
        .unwrap_or_default();
    Response::new(full(format!("{} {path}", req.method())))
}

/// Two proxy slots on ephemeral ports over one shared forward list.
struct Harness {
    slots: Vec<SocketAddr>,
    forwards: ForwardsState,
    listening: ListeningState,
    bootstrap: Arc<PortTokenCodec>,
    shutdown: CancellationToken,
}

impl Harness {
    async fn start() -> Self {
        let bootstrap = Arc::new(PortTokenCodec::new(SECRET));
        let cookies = Arc::new(PortTokenCodec::random());
        let forwards = ForwardsState::with_slots(&[8444, 8445]);
        let listening = ListeningState::default();
        let sessions = Arc::new(SessionGuard::default());
        let shutdown = CancellationToken::new();
        let mut slots = Vec::new();
        for slot in [8444u16, 8445] {
            let config = ProxyConfig {
                slot,
                listen: "127.0.0.1:0".parse().unwrap(),
                bootstrap: bootstrap.clone(),
                cookies: cookies.clone(),
                workspace_id: WORKSPACE.to_string(),
                secure_cookies: false,
                forwards: forwards.clone(),
                listening: listening.clone(),
                sessions: sessions.clone(),
            };
            let listener = proxy::bind(&config).await.unwrap();
            slots.push(listener.local_addr().unwrap());
            tokio::spawn(proxy::serve(listener, config, None, shutdown.clone()));
        }
        Self {
            slots,
            forwards,
            listening,
            bootstrap,
            shutdown,
        }
    }

    /// A fresh token per call: bootstrap tokens are single-use, so the `jti` must be unique
    /// (the control plane mints a new one per `/open`).
    fn token(&self, port: u16, iat: u64, exp: u64) -> String {
        static NEXT_JTI: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let serial = NEXT_JTI.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        self.bootstrap.sign(&PortSession {
            ws: WORKSPACE.to_string(),
            port,
            sub: "user_1".to_string(),
            iat,
            exp,
            jti: format!("j{port}-{iat}-{serial}"),
        })
    }

    fn private_forward(&self, port: u16) {
        self.forwards.insert(Forward {
            port,
            visibility: Visibility::Private,
            label: None,
            url: None,
            slot: None,
        });
    }
}

impl Drop for Harness {
    fn drop(&mut self) {
        self.shutdown.cancel();
    }
}

fn client() -> reqwest::Client {
    reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .no_proxy()
        .timeout(Duration::from_secs(10))
        .build()
        .unwrap()
}

/// The `zs_port_session` value from a `Set-Cookie` header.
fn cookie_value(response: &reqwest::Response) -> Option<String> {
    let header = response
        .headers()
        .get_all(reqwest::header::SET_COOKIE)
        .iter()
        .filter_map(|value| value.to_str().ok())
        .find(|value| value.starts_with(&format!("{COOKIE_NAME}=")))?;
    let value = header.split(';').next()?.split_once('=')?.1.to_string();
    (!value.is_empty()).then_some(value)
}

fn set_cookie_attributes(response: &reqwest::Response) -> Vec<String> {
    response
        .headers()
        .get_all(reqwest::header::SET_COOKIE)
        .iter()
        .filter_map(|value| value.to_str().ok().map(str::to_string))
        .collect()
}

#[tokio::test(flavor = "multi_thread")]
async fn bootstrap_binds_a_slot_and_proxies() {
    let upstream = Upstream::start("127.0.0.1:0").await;
    let harness = Harness::start().await;
    let port = upstream.addr.port();
    harness.private_forward(port);
    let slot = harness.slots[0];
    let http = client();

    // No cookie → 401 JSON, no upstream contact.
    let response = http.get(format!("http://{slot}/")).send().await.unwrap();
    assert_eq!(response.status(), 401);
    let body: serde_json::Value = response.json().await.unwrap();
    assert_eq!(body["error"], "port_session_required");
    assert!(upstream.seen().is_empty());

    // Bootstrap: binds the slot, 303 to `next`, cookie set.
    let now = now();
    let token = harness.token(port, now, now + 600);
    let response = http
        .get(format!(
            "http://{slot}/__zs/auth?zs_port_token={token}&next=%2Fa%3Fb%3D1"
        ))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 303);
    assert_eq!(response.headers()["location"], "/a?b=1");
    assert_eq!(harness.forwards.slot_port(8444), Some(port));
    let attributes = set_cookie_attributes(&response);
    assert!(attributes.iter().any(|value| value.contains("HttpOnly")));
    assert!(
        attributes
            .iter()
            .any(|value| value.contains("SameSite=Lax"))
    );
    assert!(
        !attributes.iter().any(|value| value.contains("Secure")),
        "the harness runs with secure_cookies = false"
    );
    let cookie = cookie_value(&response).expect("a session cookie");

    // With the cookie: the request reaches the upstream verbatim.
    let response = http
        .get(format!("http://{slot}/a?b=1"))
        .header("cookie", format!("other=1; {COOKIE_NAME}={cookie}"))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 200);
    assert_eq!(response.text().await.unwrap(), "GET /a?b=1");
    let seen = upstream.seen().pop().unwrap();
    assert_eq!(
        seen.host.as_deref(),
        Some(upstream.addr.to_string().as_str())
    );
    assert_eq!(
        seen.forwarded_port.as_deref(),
        Some(port.to_string().as_str())
    );
    assert_eq!(seen.forwarded_proto.as_deref(), Some("http"));
    assert_eq!(
        seen.forwarded_host.as_deref(),
        Some(slot.to_string().as_str())
    );
    assert_eq!(
        seen.cookie.as_deref(),
        Some("other=1"),
        "the proxy's own cookie is stripped from the forwarded request"
    );

    // A forward the control plane removed unbinds the slot; the old cookie stops working.
    harness.forwards.remove(port);
    let response = http
        .get(format!("http://{slot}/"))
        .header("cookie", format!("{COOKIE_NAME}={cookie}"))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 404);
    let body: serde_json::Value = response.json().await.unwrap();
    assert_eq!(body["error"], "slot_unbound");
}

#[tokio::test(flavor = "multi_thread")]
async fn websocket_upgrade_is_tunnelled() {
    let upstream = Upstream::start("127.0.0.1:0").await;
    let harness = Harness::start().await;
    let port = upstream.addr.port();
    harness.private_forward(port);
    let slot = harness.slots[0];
    let now = now();
    let cookie = bootstrap_cookie(&harness, slot, port, now).await;

    let mut request = format!("ws://{slot}/ws").into_client_request().unwrap();
    request
        .headers_mut()
        .insert("cookie", format!("{COOKIE_NAME}={cookie}").parse().unwrap());
    let stream = TcpStream::connect(slot).await.unwrap();
    let (mut socket, response) = tokio_tungstenite::client_async(request, stream)
        .await
        .expect("the upstream requires Connection: upgrade, which the proxy re-inserts");
    assert_eq!(response.status(), StatusCode::SWITCHING_PROTOCOLS);
    for index in 0..3 {
        socket
            .send(Message::Text(format!("frame{index}")))
            .await
            .unwrap();
        let reply = socket.next().await.unwrap().unwrap();
        assert_eq!(reply, Message::Text(format!("echo:frame{index}")));
    }
    socket.close(None).await.unwrap();
}

#[tokio::test(flavor = "multi_thread")]
async fn idle_tunnels_do_not_starve_plain_requests() {
    let upstream = Upstream::start("127.0.0.1:0").await;
    let harness = Harness::start().await;
    let port = upstream.addr.port();
    harness.private_forward(port);
    let slot = harness.slots[0];
    let now = now();
    let cookie = bootstrap_cookie(&harness, slot, port, now).await;

    // More idle tunnels than MAX_INFLIGHT: the request permit is released at the 101 hand-off.
    let mut sockets = Vec::new();
    for _ in 0..(zs_agent::proxy::MAX_INFLIGHT + 4) {
        let mut request = format!("ws://{slot}/ws").into_client_request().unwrap();
        request
            .headers_mut()
            .insert("cookie", format!("{COOKIE_NAME}={cookie}").parse().unwrap());
        let stream = TcpStream::connect(slot).await.unwrap();
        let (socket, _) = tokio_tungstenite::client_async(request, stream)
            .await
            .unwrap();
        sockets.push(socket);
    }
    let response = client()
        .get(format!("http://{slot}/still-served"))
        .header("cookie", format!("{COOKIE_NAME}={cookie}"))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 200);
    assert_eq!(response.text().await.unwrap(), "GET /still-served");
}

#[tokio::test(flavor = "multi_thread")]
async fn v6_only_upstream_is_reached_over_localhost_v6() {
    let upstream = Upstream::start("[::1]:0").await;
    let harness = Harness::start().await;
    let port = upstream.addr.port();
    harness.private_forward(port);
    harness.listening.set(vec![ListeningPort {
        port,
        pid: 1,
        process_name: "test".into(),
        v4: false,
        v6: true,
        loopback_only: true,
    }]);
    let slot = harness.slots[0];
    let now = now();
    let cookie = bootstrap_cookie(&harness, slot, port, now).await;
    let response = client()
        .get(format!("http://{slot}/v6"))
        .header("cookie", format!("{COOKIE_NAME}={cookie}"))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 200);
    assert_eq!(response.text().await.unwrap(), "GET /v6");
}

#[tokio::test(flavor = "multi_thread")]
async fn rejected_tokens_and_stale_cookies() {
    let upstream = Upstream::start("127.0.0.1:0").await;
    let harness = Harness::start().await;
    let port = upstream.addr.port();
    // A second private forward that nothing listens on, so the proxy has to answer 502.
    let other_port = 1u16;
    harness.private_forward(port);
    harness.private_forward(other_port);
    let slot = harness.slots[0];
    let second = harness.slots[1];
    let http = client();
    let now = now();

    // Expired bootstrap token → 401, cookie cleared.
    let expired = harness.token(port, now - 7200, now - 3600);
    let response = http
        .get(format!("http://{slot}/__zs/auth?zs_port_token={expired}"))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 401);
    assert!(
        set_cookie_attributes(&response)
            .iter()
            .any(|value| value.contains("Max-Age=0"))
    );

    // An ES256 JWT is not a `v1.` HMAC token.
    let response = http
        .get(format!(
            "http://{slot}/__zs/auth?zs_port_token=eyJhbGciOiJFUzI1NiJ9.eyJ3cyI6IngifQ.c2ln"
        ))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 401);

    // A token minted for another workspace.
    let foreign = PortTokenCodec::new(SECRET).sign(&PortSession {
        ws: "ws_other".into(),
        port,
        sub: "user_1".into(),
        iat: now,
        exp: now + 600,
        jti: "j-foreign".into(),
    });
    let response = http
        .get(format!("http://{slot}/__zs/auth?zs_port_token={foreign}"))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 401);
    let body: serde_json::Value = response.json().await.unwrap();
    assert_eq!(body["error"], "wrong_workspace");

    // A valid token binds the slot; `next` outside this origin falls back to `/`.
    let token = harness.token(port, now, now + 600);
    let response = http
        .get(format!(
            "http://{slot}/__zs/auth?zs_port_token={token}&next=%2F%2Fevil.example"
        ))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 303);
    assert_eq!(response.headers()["location"], "/");
    assert_eq!(response.headers()["referrer-policy"], "no-referrer");
    let cookie = cookie_value(&response).unwrap();

    // The same token again is a replay: no second cookie.
    let response = http
        .get(format!("http://{slot}/__zs/auth?zs_port_token={token}"))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 401);
    let body: serde_json::Value = response.json().await.unwrap();
    assert_eq!(body["error"], "port_session_invalid");

    // A tab hidden in `next` (browsers strip it before parsing, turning `/<TAB>/evil` into
    // `//evil`) falls back to `/` like the other open-redirect shapes.
    for evil in [
        "%2F%09%2Fevil.example",
        "%2F%0A%2Fevil.example",
        "%2F%5C%5Cevil.example",
    ] {
        let fresh = harness.token(port, now, now + 600);
        let response = http
            .get(format!(
                "http://{slot}/__zs/auth?zs_port_token={fresh}&next={evil}"
            ))
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), 303, "{evil}");
        assert_eq!(response.headers()["location"], "/", "{evil}");
    }
    // A legitimate non-ASCII path is re-encoded for the header.
    let fresh = harness.token(port, now, now + 600);
    let response = http
        .get(format!(
            "http://{slot}/__zs/auth?zs_port_token={fresh}&next=%2Fapp%3Fq%3Dcaf%C3%A9"
        ))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 303);
    assert_eq!(response.headers()["location"], "/app?q=caf%C3%A9");

    // Another port's token on the bound slot is stale.
    let other = harness.token(other_port, now, now + 600);
    let response = http
        .get(format!("http://{slot}/__zs/auth?zs_port_token={other}"))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 401);
    let body: serde_json::Value = response.json().await.unwrap();
    assert_eq!(body["error"], "port_session_stale");

    // A token for the already-bound port on the second, unbound slot must not move the binding
    // (every cookie on the first slot would die); it is refused as stale.
    let moved = harness.token(port, now, now + 600);
    let response = http
        .get(format!("http://{second}/__zs/auth?zs_port_token={moved}"))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 401);
    let body: serde_json::Value = response.json().await.unwrap();
    assert_eq!(body["error"], "port_session_stale");
    assert_eq!(harness.forwards.slot_port(8444), Some(port));
    assert_eq!(harness.forwards.slot_port(8445), None);

    // The other port's token on the second, unbound slot binds it.
    let other = harness.token(other_port, now, now + 600);
    let response = http
        .get(format!("http://{second}/__zs/auth?zs_port_token={other}"))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 303);
    assert_eq!(harness.forwards.slot_port(8445), Some(other_port));

    // A cookie for a port nothing listens on → 502 upstream_unavailable.
    let stale_cookie = cookie_value(&response).unwrap();
    let response = http
        .get(format!("http://{second}/"))
        .header("cookie", format!("{COOKIE_NAME}={stale_cookie}"))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 502);
    let body: serde_json::Value = response.json().await.unwrap();
    assert_eq!(body["error"], "upstream_unavailable");
    assert_eq!(body["port"], other_port);

    // A browser navigation gets HTML instead of JSON, with no link back.
    let response = http
        .get(format!("http://{slot}/"))
        .header("accept", "text/html,*/*")
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 401);
    let body = response.text().await.unwrap();
    assert!(body.contains("<h1>This port is private</h1>"));
    assert!(!body.contains("href"));

    // The cookie works until logout…
    let response = http
        .get(format!("http://{slot}/hello"))
        .header("cookie", format!("{COOKIE_NAME}={cookie}"))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 200);

    // Logging out clears the cookie and revokes it: replaying the old value is refused.
    let response = http
        .get(format!("http://{slot}/__zs/logout"))
        .header("cookie", format!("{COOKIE_NAME}={cookie}"))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 204);
    assert!(
        set_cookie_attributes(&response)
            .iter()
            .any(|value| value.contains("Max-Age=0"))
    );
    let response = http
        .get(format!("http://{slot}/hello"))
        .header("cookie", format!("{COOKIE_NAME}={cookie}"))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 401);
    let body: serde_json::Value = response.json().await.unwrap();
    assert_eq!(body["error"], "port_session_required");
    drop(upstream);
}

/// Runs the `/__zs/auth` bootstrap and returns the session cookie value.
async fn bootstrap_cookie(harness: &Harness, slot: SocketAddr, port: u16, now: u64) -> String {
    let token = harness.token(port, now, now + 600);
    let response = client()
        .get(format!("http://{slot}/__zs/auth?zs_port_token={token}"))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 303);
    cookie_value(&response).unwrap()
}

#[tokio::test(flavor = "multi_thread")]
async fn cookies_do_not_survive_a_new_boot() {
    // The cookie codec is per boot (§3.10): a resume mints a new key, so old cookies are refused.
    let upstream = Upstream::start("127.0.0.1:0").await;
    let harness = Harness::start().await;
    let port = upstream.addr.port();
    harness.private_forward(port);
    let cookie = bootstrap_cookie(&harness, harness.slots[0], port, now()).await;

    let next_boot = Harness::start().await;
    next_boot.private_forward(port);
    next_boot
        .forwards
        .bind_slot(8444, port)
        .expect("the control plane's forward binds the slot");
    let response = client()
        .get(format!("http://{}/", next_boot.slots[0]))
        .header("cookie", format!("{COOKIE_NAME}={cookie}"))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 401);
    let body: HashMap<String, String> = response.json().await.unwrap();
    assert_eq!(body["error"], "port_session_required");
}
