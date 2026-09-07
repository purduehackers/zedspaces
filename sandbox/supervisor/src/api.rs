//! Health listener and loopback supervisor API (brief §3.12, §4.4; D21).
//!
//! Two listeners, one router. **8448** (`0.0.0.0`, declared to Vercel) serves `GET /health` with
//! the minimal D21 body and authenticated `/debug` WebSocket; **8450** (`127.0.0.1`, never declared) serves the server-facing and
//! helper-facing routes plus the full `/health` detail. Both listeners come up **before** the
//! manifest is fetched (§3.16 step 1) so the control plane's probe sees `booting`/`manifest`.
//!
//! Routes on the `Local` listener (bearer = the control secret, constant-time compare):
//! `POST /ports`, `DELETE /ports/{port}`, `POST /extensions`, `POST /git-token`,
//! `POST /lifecycle`, `GET /health`. Everything else 404; wrong method 405.

use std::convert::Infallible;
use std::net::SocketAddr;
use std::sync::{Arc, OnceLock};
use std::time::Duration;

use anyhow::anyhow;
use bytes::Bytes;
use http_body_util::{BodyExt as _, Limited};
use hyper::server::conn::http1;
use hyper::service::service_fn;
use hyper::{Method, Request, Response, StatusCode};
use hyper_util::rt::{TokioIo, TokioTimer};
use secrecy::{ExposeSecret as _, SecretString};
use subtle::ConstantTimeEq as _;
use tokio::net::TcpListener;
use tokio_util::sync::CancellationToken;

use crate::control_plane::{
    ControlPlane, ControlPlaneError, ExpiresAt, ForwardRequest, GitTokenRequest,
};
use crate::manifest::{Forward, Visibility};
use crate::ports::{ListeningState, is_infra_port};
use crate::proxy::{BoxBody, full_body, json_response};
use crate::server::{LifecycleBody, ServerControl};
use crate::state::{AgentState, ForwardsState, HealthStatus};

/// Ceiling on a request body to the loopback API (b4 uses the same 64 KiB limit inbound).
pub const MAX_BODY_BYTES: usize = 64 * 1024;
/// hyper `header_read_timeout` for both listeners; requires the Tokio timer to be installed.
pub const HEADER_TIMEOUT: Duration = Duration::from_secs(30);

/// Everything the router needs; shared by both listeners.
pub struct ApiDeps {
    /// Capability-authenticated debug adapter sessions on the service listener.
    pub debugger: Arc<crate::debugger::DebugService>,
    /// Health state.
    pub state: Arc<AgentState>,
    /// Control-plane client for `/ports`, `/extensions`, `/git-token`.
    pub control: ControlPlane,
    /// Forward list.
    pub forwards: ForwardsState,
    /// Listening ports.
    pub listening: ListeningState,
    /// Bearer expected on the `Local` routes.
    pub control_secret: SecretString,
    /// Set once the server spec exists.
    pub server: OnceLock<ServerControl>,
}

impl ApiDeps {
    /// Republishes the port table to the server after a forward changed, so the client sees the
    /// new forward without waiting for the watcher's next tick (§3.12).
    async fn republish_ports(&self) {
        let Some(server) = self.server.get() else {
            return;
        };
        let ports = self.listening.current();
        if let Err(error) = server.post_ports(&ports, &self.forwards.current()).await {
            tracing::debug!(error = %error, "could not republish ports after a forward change");
        }
    }
}

/// Which listener a request arrived on.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Listener {
    /// `0.0.0.0:8448`, health and authenticated debugger sockets.
    Health,
    /// `127.0.0.1:8450`, the supervisor API.
    Local,
}

/// Binds both listeners and serves until `shutdown`; the peer `SocketAddr` from `accept()` is
/// threaded into [`route`]. [`bind`] + [`serve_bound`], for callers that do not need to tell a
/// bind failure apart from the serving loop.
pub async fn run(
    health_listen: SocketAddr,
    local_listen: SocketAddr,
    deps: Arc<ApiDeps>,
    shutdown: CancellationToken,
) -> anyhow::Result<()> {
    let (health, local) = bind(health_listen, local_listen).await?;
    serve_bound(health, local, deps, shutdown).await;
    Ok(())
}

/// Binds the `8448` health listener and the `127.0.0.1:8450` API listener. Split from
/// [`serve_bound`] so `start` can fail the boot (exit 2) when either address is taken instead
/// of running blind with a silent health port.
pub async fn bind(
    health_listen: SocketAddr,
    local_listen: SocketAddr,
) -> anyhow::Result<(TcpListener, TcpListener)> {
    let health = TcpListener::bind(health_listen)
        .await
        .map_err(|error| anyhow!("bind {health_listen}: {error}"))?;
    let local = TcpListener::bind(local_listen)
        .await
        .map_err(|error| anyhow!("bind {local_listen}: {error}"))?;
    tracing::info!(
        health = %health.local_addr().map(|a| a.to_string()).unwrap_or_default(),
        local = %local.local_addr().map(|a| a.to_string()).unwrap_or_default(),
        "supervisor listeners up"
    );
    Ok((health, local))
}

/// Serves two already-bound listeners until `shutdown`.
pub async fn serve_bound(
    health: TcpListener,
    local: TcpListener,
    deps: Arc<ApiDeps>,
    shutdown: CancellationToken,
) {
    let health_task = tokio::spawn(serve(
        health,
        Listener::Health,
        deps.clone(),
        shutdown.clone(),
    ));
    let local_task = tokio::spawn(serve(local, Listener::Local, deps, shutdown));
    let _ = tokio::join!(health_task, local_task);
}

/// Accept loop for one listener; every connection is served on its own task and dropped when
/// `shutdown` fires.
async fn serve(
    listener: TcpListener,
    kind: Listener,
    deps: Arc<ApiDeps>,
    shutdown: CancellationToken,
) {
    loop {
        let accepted = tokio::select! {
            accepted = listener.accept() => accepted,
            _ = shutdown.cancelled() => break,
        };
        let (stream, peer) = match accepted {
            Ok(accepted) => accepted,
            Err(error) => {
                tracing::debug!(error = %error, "accept failed");
                continue;
            }
        };
        let deps = deps.clone();
        let connection_shutdown = shutdown.clone();
        tokio::spawn(async move {
            let service = service_fn(move |req| {
                let deps = deps.clone();
                async move { route(deps, kind, peer, req).await }
            });
            let connection = http1::Builder::new()
                .timer(TokioTimer::new())
                .header_read_timeout(HEADER_TIMEOUT)
                .serve_connection(TokioIo::new(stream), service)
                .with_upgrades();
            tokio::select! {
                result = connection => {
                    if let Err(error) = result {
                        tracing::debug!(error = %error, "api connection closed");
                    }
                }
                _ = connection_shutdown.cancelled() => {}
            }
        });
    }
}

/// Routes one request. Generic over the body so tests can call it with a plain in-memory body;
/// the listeners always hand it hyper's `Incoming`.
pub async fn route<B>(
    deps: Arc<ApiDeps>,
    listener: Listener,
    peer: SocketAddr,
    req: Request<B>,
) -> Result<Response<BoxBody>, Infallible>
where
    B: hyper::body::Body,
    B::Error: std::error::Error + Send + Sync + 'static,
{
    let path = req.uri().path();
    if listener == Listener::Local && !peer.ip().is_loopback() {
        return Ok(json_response(
            StatusCode::FORBIDDEN,
            serde_json::json!({ "error": "forbidden" }),
        ));
    }
    if path == "/health" {
        if req.method() != Method::GET {
            return Ok(json_response(
                StatusCode::METHOD_NOT_ALLOWED,
                serde_json::json!({ "error": "method_not_allowed" }),
            ));
        }
        return Ok(health_response(&deps, listener, peer));
    }
    if listener == Listener::Health {
        if path == "/debug" {
            return Ok(deps
                .debugger
                .upgrade(req)
                .map(|body| body.map_err(|never| match never {}).boxed()));
        }
        return Ok(json_response(
            StatusCode::NOT_FOUND,
            serde_json::json!({ "error": "not_found" }),
        ));
    }
    if !authorized(&deps, &req) {
        return Ok(json_response(
            StatusCode::UNAUTHORIZED,
            serde_json::json!({ "error": "unauthorized" }),
        ));
    }
    let method = req.method().clone();
    let path = path.to_string();
    let body = match read_body(req).await {
        Ok(body) => body,
        Err(response) => return Ok(response),
    };
    let response = match (&method, path.as_str()) {
        (&Method::POST, "/ports") => forward_port(&deps, &body).await,
        (&Method::POST, "/extensions") => relay_extensions(&deps, &body).await,
        (&Method::POST, "/git-token") => git_token(&deps, &body).await,
        (&Method::POST, "/lifecycle") => lifecycle(&deps, &body).await,
        (&Method::DELETE, path) if path.starts_with("/ports/") => {
            unforward_port(&deps, path.trim_start_matches("/ports/")).await
        }
        (_, "/ports" | "/extensions" | "/git-token" | "/lifecycle") => json_response(
            StatusCode::METHOD_NOT_ALLOWED,
            serde_json::json!({ "error": "method_not_allowed" }),
        ),
        (_, path) if path.starts_with("/ports/") => json_response(
            StatusCode::METHOD_NOT_ALLOWED,
            serde_json::json!({ "error": "method_not_allowed" }),
        ),
        _ => json_response(
            StatusCode::NOT_FOUND,
            serde_json::json!({ "error": "not_found" }),
        ),
    };
    Ok(response)
}

/// `Authorization: Bearer <control secret>`, compared in constant time.
fn authorized<B>(deps: &ApiDeps, req: &Request<B>) -> bool {
    let Some(header) = req
        .headers()
        .get(hyper::header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
    else {
        return false;
    };
    let Some(presented) = header
        .strip_prefix("Bearer ")
        .or_else(|| header.strip_prefix("bearer "))
    else {
        return false;
    };
    let expected = deps.control_secret.expose_secret().as_bytes();
    let presented = presented.trim().as_bytes();
    presented.len() == expected.len() && presented.ct_eq(expected).into()
}

/// Reads a request body, refusing anything over [`MAX_BODY_BYTES`].
async fn read_body<B>(req: Request<B>) -> Result<Bytes, Response<BoxBody>>
where
    B: hyper::body::Body,
    B::Error: std::error::Error + Send + Sync + 'static,
{
    let limited = Limited::new(req.into_body(), MAX_BODY_BYTES);
    match limited.collect().await {
        Ok(collected) => Ok(collected.to_bytes()),
        Err(_) => Err(json_response(
            StatusCode::PAYLOAD_TOO_LARGE,
            serde_json::json!({ "error": "body_too_large" }),
        )),
    }
}

/// `POST /ports` (b4 `ForwardPort`): allocate through the control plane, remember the forward and
/// republish the table to the server.
async fn forward_port(deps: &ApiDeps, body: &[u8]) -> Response<BoxBody> {
    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct ForwardBody {
        port: u16,
        visibility: Visibility,
        #[serde(default)]
        label: Option<String>,
    }
    let request: ForwardBody = match serde_json::from_slice(body) {
        Ok(request) => request,
        Err(error) => return bad_request(&error.to_string()),
    };
    if request.port == 0 || is_infra_port(request.port) {
        return json_response(
            StatusCode::BAD_REQUEST,
            serde_json::json!({ "error": "port_not_allowed", "port": request.port }),
        );
    }
    let response = deps
        .control
        .forward(ForwardRequest {
            port: request.port,
            visibility: request.visibility,
            label: request.label.as_deref(),
        })
        .await;
    match response {
        Ok(forward) => {
            deps.forwards.insert(Forward {
                port: request.port,
                visibility: forward.visibility,
                label: request.label,
                url: forward.url.clone(),
                slot: forward.slot,
            });
            deps.republish_ports().await;
            json_response(
                StatusCode::OK,
                serde_json::json!({ "url": forward.url, "visibility": forward.visibility }),
            )
        }
        Err(error) => control_plane_error(error, Relay::Conflict),
    }
}

/// `DELETE /ports/{port}`.
async fn unforward_port(deps: &ApiDeps, raw_port: &str) -> Response<BoxBody> {
    let Ok(port) = raw_port.parse::<u16>() else {
        return bad_request("port must be a number");
    };
    match deps.control.unforward(port).await {
        Ok(()) => {
            deps.forwards.remove(port);
            deps.republish_ports().await;
            empty_response(StatusCode::NO_CONTENT)
        }
        Err(error) => control_plane_error(error, Relay::Conflict),
    }
}

/// `POST /extensions` – the D18/D19 installed-extensions relay. Best effort: a control-plane
/// failure still answers 204, because the server reports again on the next change.
async fn relay_extensions(deps: &ApiDeps, body: &[u8]) -> Response<BoxBody> {
    #[derive(serde::Deserialize)]
    struct InstalledBody {
        #[serde(default)]
        installed: Vec<String>,
    }
    let request: InstalledBody = match serde_json::from_slice(body) {
        Ok(request) => request,
        Err(error) => return bad_request(&error.to_string()),
    };
    if let Err(error) = deps.control.report_extensions(&request.installed).await {
        tracing::warn!(error = %error, "could not relay the installed extensions");
    } else {
        tracing::info!(
            count = request.installed.len(),
            "relayed installed extensions"
        );
    }
    empty_response(StatusCode::NO_CONTENT)
}

/// `POST /git-token` – the credential helper's path to the control plane; the response is passed
/// through verbatim with `expiresAt` normalised to unix seconds.
async fn git_token(deps: &ApiDeps, body: &[u8]) -> Response<BoxBody> {
    #[derive(serde::Deserialize)]
    struct TokenBody {
        host: String,
        #[serde(default)]
        protocol: Option<String>,
        #[serde(default)]
        path: Option<String>,
    }
    let request: TokenBody = match serde_json::from_slice(body) {
        Ok(request) => request,
        Err(error) => return bad_request(&error.to_string()),
    };
    let response = deps
        .control
        .git_token(GitTokenRequest {
            host: &request.host,
            protocol: request.protocol.as_deref().unwrap_or("https"),
            path: request.path.as_deref(),
        })
        .await;
    match response {
        Ok(token) => json_response(
            StatusCode::OK,
            serde_json::json!({
                "username": token.username,
                "token": token.token.expose_secret(),
                "expiresAt": expires_at_seconds(&token.expires_at),
            }),
        ),
        Err(error) => control_plane_error(error, Relay::AsIs),
    }
}

/// `POST /lifecycle` – forwards a notice to the server's control listener (tests and operators).
async fn lifecycle(deps: &ApiDeps, body: &[u8]) -> Response<BoxBody> {
    #[derive(serde::Deserialize)]
    #[serde(tag = "kind", rename_all = "snake_case")]
    enum Notice {
        IdleStopIn { seconds: u32 },
        SessionCapIn { seconds: u32 },
        Stopping,
        Resumed,
    }
    let notice: Notice = match serde_json::from_slice(body) {
        Ok(notice) => notice,
        Err(error) => return bad_request(&error.to_string()),
    };
    let body = match notice {
        Notice::IdleStopIn { seconds } => LifecycleBody::IdleStopIn { seconds },
        Notice::SessionCapIn { seconds } => LifecycleBody::SessionCapIn { seconds },
        Notice::Stopping => LifecycleBody::Stopping,
        Notice::Resumed => LifecycleBody::Resumed,
    };
    let Some(server) = deps.server.get() else {
        return json_response(
            StatusCode::SERVICE_UNAVAILABLE,
            serde_json::json!({ "error": "server_not_started" }),
        );
    };
    match server.post_lifecycle(&body).await {
        Ok(()) => empty_response(StatusCode::NO_CONTENT),
        Err(error) => json_response(
            StatusCode::BAD_GATEWAY,
            serde_json::json!({ "error": "server_unavailable", "detail": error.to_string() }),
        ),
    }
}

/// `expiresAt` in either wire form as unix seconds (`None` when an ISO string cannot be parsed).
fn expires_at_seconds(expires_at: &ExpiresAt) -> Option<u64> {
    match expires_at {
        ExpiresAt::UnixSeconds(seconds) => Some(*seconds),
        ExpiresAt::Iso(text) => crate::credential::parse_rfc3339_utc(text),
    }
}

/// How a control-plane 4xx is surfaced to the caller of a local route.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Relay {
    /// `/ports`: every 4xx (no free slot, port refused) becomes `409 {"error": <code>}`, the one
    /// status b4 surfaces as the `ForwardPort` error (§3.12; CONTRACTS §7.7).
    Conflict,
    /// `/git-token`: `403 repo_not_allowed` / `404 host_unsupported` pass through so the
    /// credential helper can fall through (§3.13).
    AsIs,
}

/// Maps a control-plane failure onto the status the server (or the helper) should see: a 4xx is
/// relayed per [`Relay`] with its error code, everything else becomes
/// `502 control_plane_unavailable`.
fn control_plane_error(error: ControlPlaneError, relay: Relay) -> Response<BoxBody> {
    match error {
        ControlPlaneError::Status { status, code, body } if (400..500).contains(&status) => {
            let code = code.unwrap_or_else(|| "control_plane_error".to_string());
            let status = match relay {
                Relay::Conflict => StatusCode::CONFLICT,
                Relay::AsIs => {
                    StatusCode::from_u16(status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR)
                }
            };
            tracing::warn!(
                status = status.as_u16(),
                code,
                body,
                "control plane refused"
            );
            json_response(status, serde_json::json!({ "error": code }))
        }
        other => {
            tracing::warn!(error = %other, "control plane unavailable");
            json_response(
                StatusCode::BAD_GATEWAY,
                serde_json::json!({ "error": "control_plane_unavailable" }),
            )
        }
    }
}

fn bad_request(detail: &str) -> Response<BoxBody> {
    json_response(
        StatusCode::BAD_REQUEST,
        serde_json::json!({ "error": "bad_request", "detail": detail }),
    )
}

/// A body-less response (`204`).
fn empty_response(status: StatusCode) -> Response<BoxBody> {
    let mut response = Response::new(full_body(Bytes::new()));
    *response.status_mut() = status;
    response
}

/// `GET /health`: the D21 minimal body on the `Health` listener; the full report on `Local`
/// (`forwards` only for loopback peers). HTTP 200 for `ready|degraded`, 503 for
/// `booting|stopping`, same body either way.
pub fn health_response(deps: &ApiDeps, listener: Listener, peer: SocketAddr) -> Response<BoxBody> {
    let status = match deps.state.status() {
        HealthStatus::Ready | HealthStatus::Degraded => StatusCode::OK,
        HealthStatus::Booting | HealthStatus::Stopping => StatusCode::SERVICE_UNAVAILABLE,
    };
    let body = match listener {
        Listener::Health => serde_json::to_value(deps.state.minimal()),
        Listener::Local => {
            let forwards = deps.forwards.current();
            let listening: Vec<u16> = deps.listening.current().iter().map(|p| p.port).collect();
            serde_json::to_value(deps.state.snapshot(
                peer.ip().is_loopback(),
                &forwards,
                &listening,
            ))
        }
    };
    json_response(
        status,
        body.unwrap_or_else(|_| serde_json::json!({ "error": "encode" })),
    )
}
