//! End-to-end tests for the supervisor's two listeners (brief §6.2 `api.rs`; D21).
//!
//! A fake control plane serves the §4.2 sandbox routes in process (including a `null` forward URL,
//! a `409 slots_exhausted`, and a `403 repo_not_allowed` for a foreign repository path) and a fake
//! server records what lands on its `/control/*` listener, so the routes are exercised over real
//! sockets without either real peer.

use std::collections::BTreeMap;
use std::convert::Infallible;
use std::net::SocketAddr;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use http_body_util::{BodyExt as _, Full};
use hyper::body::Bytes;
use hyper::service::service_fn;
use hyper::{Request, Response, StatusCode};
use hyper_util::rt::TokioIo;
use secrecy::SecretString;
use tokio::net::TcpListener;
use tokio_util::sync::CancellationToken;

use zs_agent::api::{ApiDeps, Listener};
use zs_agent::config::Config;
use zs_agent::control_plane::ControlPlane;
use zs_agent::ports::{ListeningPort, ListeningState};
use zs_agent::server::ServerControl;
use zs_agent::state::{AgentState, ForwardsState, HealthStatus, Phase};

const SECRET: &str = "0123456789abcdef0123456789abcdef";
const SANDBOX: &str = "sb-test";

/// Requests recorded by one of the fakes: `(path, body)`.
type Recorded = Arc<Mutex<Vec<(String, serde_json::Value)>>>;

fn json(status: StatusCode, value: serde_json::Value) -> Response<Full<Bytes>> {
    let mut response = Response::new(Full::new(Bytes::from(
        serde_json::to_vec(&value).expect("serialises"),
    )));
    *response.status_mut() = status;
    response
        .headers_mut()
        .insert("content-type", "application/json".parse().unwrap());
    response
}

fn empty(status: StatusCode) -> Response<Full<Bytes>> {
    let mut response = Response::new(Full::new(Bytes::new()));
    *response.status_mut() = status;
    response
}

/// Serves `handler` on an ephemeral loopback port until the test ends.
async fn spawn_http<H, F>(handler: H) -> SocketAddr
where
    H: Fn(http::request::Parts, Bytes) -> F + Clone + Send + Sync + 'static,
    F: Future<Output = Response<Full<Bytes>>> + Send + 'static,
{
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
    let addr = listener.local_addr().expect("addr");
    tokio::spawn(async move {
        loop {
            let Ok((stream, _)) = listener.accept().await else {
                break;
            };
            let handler = handler.clone();
            tokio::spawn(async move {
                let service = service_fn(move |req: Request<hyper::body::Incoming>| {
                    let handler = handler.clone();
                    async move {
                        let (parts, body) = req.into_parts();
                        let bytes = body
                            .collect()
                            .await
                            .map(|collected| collected.to_bytes())
                            .unwrap_or_default();
                        Ok::<_, Infallible>(handler(parts, bytes).await)
                    }
                });
                let _ = hyper::server::conn::http1::Builder::new()
                    .serve_connection(TokioIo::new(stream), service)
                    .await;
            });
        }
    });
    addr
}

/// The §4.2 sandbox-facing routes, enough of them for the API tests.
async fn spawn_control_plane(recorded: Recorded) -> SocketAddr {
    spawn_http(move |parts, body| {
        let recorded = recorded.clone();
        async move {
            let path = parts.uri.path().to_string();
            let parsed: serde_json::Value =
                serde_json::from_slice(&body).unwrap_or(serde_json::Value::Null);
            recorded
                .lock()
                .unwrap()
                .push((path.clone(), parsed.clone()));
            let suffix = path
                .strip_prefix(&format!("/api/sandboxes/{SANDBOX}/"))
                .unwrap_or_default()
                .to_string();
            match (parts.method.as_str(), suffix.as_str()) {
                ("POST", "ports") => match parsed["port"].as_u64() {
                    Some(3000) => json(
                        StatusCode::OK,
                        serde_json::json!({
                            "url": "https://zs.example.com/api/workspaces/ws_test/ports/3000/open",
                            "visibility": "private",
                            "slot": 8444,
                        }),
                    ),
                    Some(4000) => json(
                        StatusCode::OK,
                        serde_json::json!({ "url": null, "visibility": "public" }),
                    ),
                    _ => json(
                        StatusCode::CONFLICT,
                        serde_json::json!({ "error": "slots_exhausted" }),
                    ),
                },
                ("DELETE", "ports/3000") => empty(StatusCode::NO_CONTENT),
                ("POST", "extensions") => empty(StatusCode::NO_CONTENT),
                ("POST", "git-token") => {
                    if parsed["path"].as_str() == Some("acme/api.git") {
                        json(
                            StatusCode::OK,
                            serde_json::json!({
                                "username": "x-access-token",
                                "token": "ghs_testtoken",
                                "expiresAt": 1_756_803_600u64,
                            }),
                        )
                    } else {
                        json(
                            StatusCode::FORBIDDEN,
                            serde_json::json!({ "error": "repo_not_allowed" }),
                        )
                    }
                }
                _ => json(
                    StatusCode::NOT_FOUND,
                    serde_json::json!({ "error": "not_found" }),
                ),
            }
        }
    })
    .await
}

/// A stand-in for `zed-remote-server serve`: records `/control/*` and answers `/health`.
async fn spawn_fake_server(recorded: Recorded) -> SocketAddr {
    spawn_http(move |parts, body| {
        let recorded = recorded.clone();
        async move {
            let path = parts.uri.path().to_string();
            if path == "/health" {
                return json(
                    StatusCode::OK,
                    serde_json::json!({
                        "build": "c3cf80c-42",
                        "version": "c3cf80c-42+test",
                        "uptime_secs": 12,
                        "session_active": true,
                        "last_input_at": 1_756_800_123_456u64,
                        "session": { "session_id": "ses_1" },
                    }),
                );
            }
            if parts
                .headers
                .get("authorization")
                .and_then(|value| value.to_str().ok())
                != Some(format!("Bearer {SECRET}").as_str())
            {
                return json(
                    StatusCode::UNAUTHORIZED,
                    serde_json::json!({ "error": "unauthorized" }),
                );
            }
            let parsed: serde_json::Value =
                serde_json::from_slice(&body).unwrap_or(serde_json::Value::Null);
            recorded.lock().unwrap().push((path, parsed));
            empty(StatusCode::NO_CONTENT)
        }
    })
    .await
}

struct Harness {
    health: SocketAddr,
    local: SocketAddr,
    state: Arc<AgentState>,
    forwards: ForwardsState,
    control_plane: Recorded,
    server: Recorded,
    client: reqwest::Client,
    shutdown: CancellationToken,
}

impl Harness {
    async fn start() -> Self {
        let control_plane: Recorded = Arc::new(Mutex::new(Vec::new()));
        let server: Recorded = Arc::new(Mutex::new(Vec::new()));
        let cp_addr = spawn_control_plane(control_plane.clone()).await;
        let server_addr = spawn_fake_server(server.clone()).await;

        let env = BTreeMap::from([
            ("ZS_CONTROL_URL", format!("http://{cp_addr}/api")),
            ("ZS_SANDBOX_TOKEN", "zsb_test".to_string()),
            ("ZS_SANDBOX_NAME", SANDBOX.to_string()),
            ("ZS_WORKSPACE_ID", "ws_test".to_string()),
            ("HOME", "/tmp".to_string()),
        ]);
        let config =
            Arc::new(Config::from_lookup(|key| env.get(key).cloned()).expect("config from env"));
        let control = ControlPlane::new(config).expect("control plane client");
        let state = AgentState::new("c3cf80c-42".to_string(), Some("iad1".to_string()));
        let forwards = ForwardsState::new();
        let listening = ListeningState::default();
        listening.set(vec![ListeningPort {
            port: 3000,
            pid: 42,
            process_name: "node".to_string(),
            v4: true,
            v6: false,
            loopback_only: false,
        }]);
        let server_control = ServerControl::new(
            server_addr,
            server_addr,
            SecretString::from(SECRET.to_string()),
        )
        .expect("server control client");
        let deps = Arc::new(ApiDeps {
            state: state.clone(),
            control,
            forwards: forwards.clone(),
            listening,
            control_secret: SecretString::from(SECRET.to_string()),
            server: OnceLock::new(),
        });
        let _ = deps.server.set(server_control);

        // Reserve two ephemeral ports, then let `api::run` bind them.
        let health = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let local = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let health_addr = health.local_addr().unwrap();
        let local_addr = local.local_addr().unwrap();
        drop(health);
        drop(local);

        let shutdown = CancellationToken::new();
        {
            let deps = deps.clone();
            let shutdown = shutdown.clone();
            tokio::spawn(async move {
                zs_agent::api::run(health_addr, local_addr, deps, shutdown)
                    .await
                    .expect("listeners");
            });
        }
        let client = reqwest::Client::builder().no_proxy().build().unwrap();
        let harness = Self {
            health: health_addr,
            local: local_addr,
            state,
            forwards,
            control_plane,
            server,
            client,
            shutdown,
        };
        harness.wait_for_listeners().await;
        harness
    }

    async fn wait_for_listeners(&self) {
        for _ in 0..100 {
            if self
                .client
                .get(format!("http://{}/health", self.health))
                .send()
                .await
                .is_ok()
            {
                return;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        panic!("the supervisor listeners never came up");
    }

    fn local_url(&self, path: &str) -> String {
        format!("http://{}{path}", self.local)
    }

    fn recorded(store: &Recorded, path: &str) -> Vec<serde_json::Value> {
        store
            .lock()
            .unwrap()
            .iter()
            .filter(|(recorded, _)| recorded.ends_with(path))
            .map(|(_, body)| body.clone())
            .collect()
    }
}

impl Drop for Harness {
    fn drop(&mut self) {
        self.shutdown.cancel();
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn health_reports_the_boot_phases_on_both_listeners() {
    let harness = Harness::start().await;

    // Booting answers 503 with the full body, so the control plane's probe can read the phase.
    let response = harness
        .client
        .get(format!("http://{}/health", harness.local))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
    let body: serde_json::Value = response.json().await.unwrap();
    assert_eq!(body["status"], "booting");
    assert_eq!(body["phase"], "manifest");
    assert_eq!(body["build"], "c3cf80c-42");
    assert_eq!(body["region"], "iad1");

    harness.state.set_error("manifest: boom");
    harness.state.set_status(HealthStatus::Degraded);
    harness.state.set_phase(Phase::Ready);
    let body: serde_json::Value = harness
        .client
        .get(harness.local_url("/health"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(body["status"], "degraded");
    assert_eq!(body["lastError"], "manifest: boom");
    assert!(body["forwards"].is_array(), "loopback peers see forwards");
    assert_eq!(body["listening"][0], 3000);

    // The public listener carries the D21 minimal body and nothing else.
    let response = harness
        .client
        .get(format!("http://{}/health", harness.health))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let body: serde_json::Value = response.json().await.unwrap();
    assert_eq!(body["ok"], true);
    assert_eq!(body["phase"], "ready");
    assert_eq!(body["build"], "c3cf80c-42");
    assert!(body.get("forwards").is_none());
    assert!(body.get("lastError").is_none());

    // The public listener serves nothing else.
    let response = harness
        .client
        .post(format!("http://{}/ports", harness.health))
        .bearer_auth(SECRET)
        .json(&serde_json::json!({ "port": 3000, "visibility": "private" }))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::NOT_FOUND);
}

#[tokio::test(flavor = "multi_thread")]
async fn ports_routes_talk_to_the_control_plane_and_the_server() {
    let harness = Harness::start().await;

    // Without the control secret the loopback API refuses everything.
    let response = harness
        .client
        .post(harness.local_url("/ports"))
        .json(&serde_json::json!({ "port": 3000, "visibility": "private" }))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);

    // A private forward comes back with its D21 slot and is republished to the server.
    let response = harness
        .client
        .post(harness.local_url("/ports"))
        .bearer_auth(SECRET)
        .json(&serde_json::json!({ "port": 3000, "visibility": "private", "label": "web" }))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let body: serde_json::Value = response.json().await.unwrap();
    assert!(body["url"].as_str().unwrap().ends_with("/ports/3000/open"));
    assert_eq!(harness.forwards.slot_port(8444), Some(3000));
    let published = Harness::recorded(&harness.server, "/control/ports");
    let last = published
        .last()
        .expect("the server was told about the port");
    assert_eq!(last["forwards"][0]["port"], 3000);
    assert_eq!(last["forwards"][0]["visibility"], "private");
    assert_eq!(last["ports"][0]["process_name"], "node");

    // A `null` URL is passed through as JSON null and as `""` to the server (b4's wire shape).
    let body: serde_json::Value = harness
        .client
        .post(harness.local_url("/ports"))
        .bearer_auth(SECRET)
        .json(&serde_json::json!({ "port": 4000, "visibility": "public" }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert!(body["url"].is_null());
    let published = Harness::recorded(&harness.server, "/control/ports");
    let last = published.last().unwrap();
    let public = last["forwards"]
        .as_array()
        .unwrap()
        .iter()
        .find(|forward| forward["port"] == 4000)
        .unwrap();
    assert_eq!(public["url"], "");

    // The control plane's 409 is relayed verbatim so b4 can surface it on `ForwardPort`.
    let response = harness
        .client
        .post(harness.local_url("/ports"))
        .bearer_auth(SECRET)
        .json(&serde_json::json!({ "port": 5000, "visibility": "private" }))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::CONFLICT);
    let body: serde_json::Value = response.json().await.unwrap();
    assert_eq!(body["error"], "slots_exhausted");

    // Infra ports are refused without troubling the control plane.
    let response = harness
        .client
        .post(harness.local_url("/ports"))
        .bearer_auth(SECRET)
        .json(&serde_json::json!({ "port": 8443, "visibility": "public" }))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);

    // Removing the forward unbinds its slot.
    let response = harness
        .client
        .delete(harness.local_url("/ports/3000"))
        .bearer_auth(SECRET)
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::NO_CONTENT);
    assert_eq!(harness.forwards.slot_port(8444), None);
    assert!(
        harness
            .forwards
            .current()
            .iter()
            .all(|forward| forward.port != 3000)
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn extensions_relay_and_git_token_passthrough() {
    let harness = Harness::start().await;

    let response = harness
        .client
        .post(harness.local_url("/extensions"))
        .bearer_auth(SECRET)
        .json(&serde_json::json!({ "installed": ["toml", "html"] }))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::NO_CONTENT);
    let relayed = Harness::recorded(&harness.control_plane, "/extensions");
    assert_eq!(relayed.last().unwrap()["installed"][1], "html");

    let response = harness
        .client
        .post(harness.local_url("/git-token"))
        .bearer_auth(SECRET)
        .json(&serde_json::json!({
            "host": "github.com",
            "protocol": "https",
            "path": "acme/api.git",
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let body: serde_json::Value = response.json().await.unwrap();
    assert_eq!(body["username"], "x-access-token");
    assert_eq!(body["token"], "ghs_testtoken");
    assert_eq!(body["expiresAt"], 1_756_803_600u64);

    // A foreign repository path is relayed as the control plane's 403 so the helper falls through.
    let response = harness
        .client
        .post(harness.local_url("/git-token"))
        .bearer_auth(SECRET)
        .json(&serde_json::json!({
            "host": "github.com",
            "protocol": "https",
            "path": "other/repo.git",
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::FORBIDDEN);
    let body: serde_json::Value = response.json().await.unwrap();
    assert_eq!(body["error"], "repo_not_allowed");

    // Without the bearer the helper route is closed too.
    let response = harness
        .client
        .post(harness.local_url("/git-token"))
        .json(&serde_json::json!({ "host": "github.com" }))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
}

#[tokio::test(flavor = "multi_thread")]
async fn lifecycle_and_unknown_routes() {
    let harness = Harness::start().await;

    let response = harness
        .client
        .post(harness.local_url("/lifecycle"))
        .bearer_auth(SECRET)
        .json(&serde_json::json!({ "kind": "idle_stop_in", "seconds": 300 }))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::NO_CONTENT);
    let notices = Harness::recorded(&harness.server, "/control/lifecycle");
    assert_eq!(notices.last().unwrap()["kind"], "idle_stop_in");
    assert_eq!(notices.last().unwrap()["seconds"], 300);

    let response = harness
        .client
        .get(harness.local_url("/nope"))
        .bearer_auth(SECRET)
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::NOT_FOUND);

    let response = harness
        .client
        .get(harness.local_url("/ports"))
        .bearer_auth(SECRET)
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::METHOD_NOT_ALLOWED);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_non_loopback_peer_never_reaches_the_local_routes() {
    // `route` is the unit under test here: the bind address already makes this unreachable, but the
    // check is defence in depth (§3.12).
    let harness = Harness::start().await;
    let deps = Arc::new(ApiDeps {
        state: harness.state.clone(),
        control: ControlPlane::new(Arc::new(
            Config::from_lookup(|key| {
                BTreeMap::from([
                    ("ZS_CONTROL_URL", "http://127.0.0.1:1/api"),
                    ("ZS_SANDBOX_TOKEN", "zsb_test"),
                    ("ZS_SANDBOX_NAME", SANDBOX),
                    ("ZS_WORKSPACE_ID", "ws_test"),
                    ("HOME", "/tmp"),
                ])
                .get(key)
                .map(|value| value.to_string())
            })
            .unwrap(),
        ))
        .unwrap(),
        forwards: harness.forwards.clone(),
        listening: ListeningState::default(),
        control_secret: SecretString::from(SECRET.to_string()),
        server: OnceLock::new(),
    });
    let request = Request::builder()
        .method("POST")
        .uri("/ports")
        .header("authorization", format!("Bearer {SECRET}"))
        .body(Full::new(Bytes::new()))
        .unwrap();
    let response = zs_agent::api::route(
        deps,
        Listener::Local,
        "10.0.0.1:4242".parse().unwrap(),
        request,
    )
    .await
    .unwrap();
    assert_eq!(response.status(), StatusCode::FORBIDDEN);
}
