//! Control-plane HTTP client (brief §3.5, §4.2; b9 §4.2). The only module that holds
//! `ZS_SANDBOX_TOKEN`.
//!
//! One `reqwest::Client` (rustls with the `ring` provider, **native roots** so the sandbox's proxy
//! CA in `SSL_CERT_FILE` is honoured; 10 s connect / 30 s request timeouts;
//! `User-Agent: zs-agent/<build>`). Every call carries `Authorization: Bearer <ZS_SANDBOX_TOKEN>`,
//! `X-ZS-Build: <build>` and, when `bypass_secret` is set, `x-vercel-protection-bypass` (D18).
//! A second, header-less client (`plain`) fetches the presigned restore tarball: its URL points at
//! Blob storage and the sandbox bearer must never reach a third-party host.
//!
//! Retry policy (§3.5): jittered backoff `250 ms · 2ⁿ`, max 5 tries, only on 5xx / connect /
//! timeouts; 429 honours `Retry-After`. A 401 anywhere flips health to `degraded`; a 410 stops the
//! activity loop; the agent keeps the server running in both cases.

use std::collections::BTreeMap;
use std::sync::Arc;
use std::time::Duration;

use futures_core::Stream;
use secrecy::{ExposeSecret as _, SecretString};

use crate::config::Config;
use crate::logs::LogBatch;
use crate::manifest::{Forward, Manifest, Visibility};
use crate::state::{HealthStatus, Phase};

/// TCP connect timeout for every control-plane call.
pub const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
/// Whole-request timeout for every control-plane call (the tarball stream is exempt).
pub const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
/// Maximum attempts per call (5xx / connect / timeout only).
pub const MAX_TRIES: u32 = 5;
/// Attempts for a log batch: the next flush carries the entries anyway (§3.6).
pub const LOG_TRIES: u32 = 2;
/// Attempts for an activity ping: the next tick is at most `intervalSecs` away (§3.15).
pub const ACTIVITY_TRIES: u32 = 2;
/// Base of the jittered exponential backoff between attempts.
pub const BACKOFF_BASE: Duration = Duration::from_millis(250);
/// Ceiling on an honoured `Retry-After` (a longer one is clamped, never slept through).
pub const MAX_RETRY_AFTER: Duration = Duration::from_secs(30);
/// Header carrying the image build id on every call.
pub const BUILD_HEADER: &str = "x-zs-build";
/// Header carrying `ZS_BYPASS_SECRET` on preview deployments (D18).
pub const BYPASS_HEADER: &str = "x-vercel-protection-bypass";
/// Cap on an error body kept in [`ControlPlaneError::Status`]: it is logged and relayed, and an
/// uncapped one would become an oversized log entry.
pub const MAX_ERROR_BODY_BYTES: usize = 4 * 1024;
/// Redirects the header-less tarball client follows (Vercel Blob presigned GETs answer directly;
/// a hop or two is tolerated, each re-checked against [`check_tarball_url`]).
pub const MAX_TARBALL_REDIRECTS: usize = 3;

/// Cheap-to-clone client over the sandbox-facing routes.
#[derive(Clone)]
pub struct ControlPlane {
    http: reqwest::Client,
    plain: reqwest::Client,
    config: Arc<Config>,
}

/// Failure of one control-plane call after retries.
#[derive(Debug, thiserror::Error)]
pub enum ControlPlaneError {
    /// A non-2xx answer other than 401/410; `code` is the JSON `error` code when present.
    #[error("control plane returned {status}: {body}")]
    Status {
        status: u16,
        code: Option<String>,
        body: String,
    },
    /// The sandbox token was rejected.
    #[error("sandbox token rejected (401)")]
    Unauthorized,
    /// The sandbox was retired by the control plane.
    #[error("sandbox retired (410)")]
    Retired,
    /// Connect / TLS / timeout / body errors from reqwest.
    #[error(transparent)]
    Transport(#[from] reqwest::Error),
    /// A 2xx answer whose body did not parse.
    #[error("invalid response: {0}")]
    Decode(String),
}

/// `POST …/git-token` body (b9 §4.2): `host` must be `github.com` (404 `host_unsupported`), `path`
/// must name the workspace's repository when present (403 `repo_not_allowed`).
#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitTokenRequest<'a> {
    /// Git host, e.g. `github.com`.
    pub host: &'a str,
    /// Git protocol, always `https` here.
    pub protocol: &'a str,
    /// Repository path as git passes it with `credential.useHttpPath`, e.g. `acme/api.git`.
    pub path: Option<&'a str>,
}

/// `POST …/git-token` response.
#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitTokenResponse {
    /// `x-access-token` for GitHub App installation tokens.
    pub username: String,
    /// The token; exposed only by the credential helper.
    pub token: SecretString,
    /// Expiry: b9 emits unix seconds; an RFC 3339 string is tolerated.
    pub expires_at: ExpiresAt,
}

/// `expiresAt` in either wire form.
#[derive(Debug, serde::Deserialize)]
#[serde(untagged)]
pub enum ExpiresAt {
    /// Unix seconds.
    UnixSeconds(u64),
    /// RFC 3339 (`toISOString()` output); parsed by `credential::parse_rfc3339_utc`.
    Iso(String),
}

/// `POST …/ports` body.
#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ForwardRequest<'a> {
    /// Target port.
    pub port: u16,
    /// Requested visibility.
    pub visibility: Visibility,
    /// Optional label.
    pub label: Option<&'a str>,
}

/// `POST …/ports` response; `slot` per D8/D21 for private forwards.
#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ForwardResponse {
    /// Public URL or `/open` link; `null` while the route is not yet registered.
    pub url: Option<String>,
    /// Granted visibility.
    pub visibility: Visibility,
    /// Allocated proxy slot (private forwards).
    #[serde(default)]
    pub slot: Option<u16>,
}

/// b9 `activityReport` (zod; missing required keys → 400, unknown keys stripped) plus D13's
/// `busy`/`phase` and D18's `cpuBusyPct`.
#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivityReport<'a> {
    /// `/health.last_input_at`, or `now` while busy / not ready (§3.15).
    pub last_input_at: Option<u64>,
    /// `/health.session_active`.
    pub session_active: bool,
    /// `/health.session.session_id` (the JWT `sid`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sid: Option<&'a str>,
    /// Seconds since the server process started.
    pub server_uptime_secs: u64,
    /// Seconds since the agent started.
    pub agent_uptime_secs: u64,
    /// Supervisor health status.
    pub status: HealthStatus,
    /// `/proc/stat` busy percentage since the previous ping; `None` on the first ping only.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cpu_busy_pct: Option<f32>,
    /// A lifecycle command or the warm-up is running (D13).
    pub busy: bool,
    /// Boot phase (D13).
    pub phase: Phase,
    /// Listening ports (extension; b9 may ignore).
    pub listening: Vec<ListeningPortWire>,
}

/// One listening port in the activity report.
#[derive(Debug, serde::Serialize)]
pub struct ListeningPortWire {
    /// Port number.
    pub port: u16,
    /// Owning pid.
    pub pid: u32,
    /// `/proc/<pid>/comm`.
    pub process: String,
    /// Bound to loopback only (unreachable through a public forward); an extension field the
    /// control plane's schema strips when it does not know it.
    #[serde(rename = "loopbackOnly")]
    pub loopback_only: bool,
}

/// `POST …/activity` response (D29 timestamp form): the supervisor derives the `idle_stop_in` /
/// `session_cap_in` notices locally (§3.15).
#[derive(Clone, Debug, PartialEq, Eq, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivityDirective {
    /// Unix ms; `null` for prebuilds.
    pub idle_stop_at: Option<u64>,
    /// Unix ms.
    pub session_cap_at: Option<u64>,
    /// `true` once the control plane is stopping the workspace (backstop for a lost SIGTERM).
    #[serde(default)]
    pub stop: bool,
    /// Authoritative forward list; replaces the local list when present.
    #[serde(default)]
    pub forwards: Option<Vec<Forward>>,
    /// Control-plane clock (unix ms) so countdowns need not trust the sandbox clock (D29).
    #[serde(default)]
    pub server_time: Option<u64>,
}

/// `POST …/client-errors` body.
#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClientErrorReport<'a> {
    /// Image build id.
    pub build: &'a str,
    /// `"server_crash"` or `"boot"`.
    pub kind: &'static str,
    /// ≤ 4 KiB.
    pub message: String,
    /// ≤ 64 KiB: the crash tail.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stack: Option<String>,
    /// Timing marks.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub marks: Option<BTreeMap<String, u64>>,
}

/// `POST …/extensions` body (D18/D19 relay).
#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstalledExtensions<'a> {
    /// Installed extension ids.
    pub installed: &'a [String],
}

impl ControlPlane {
    /// Builds both clients from the configuration.
    pub fn new(config: Arc<Config>) -> anyhow::Result<Self> {
        let user_agent = format!("zs-agent/{}", config.build_id);
        let http = reqwest::Client::builder()
            .user_agent(&user_agent)
            .connect_timeout(CONNECT_TIMEOUT)
            .timeout(REQUEST_TIMEOUT)
            .build()?;
        // The tarball client streams for up to `RESTORE_TIMEOUT`, so it has no whole-request
        // timeout; a stalled stream is caught by the read timeout instead. Redirects are
        // re-checked hop by hop: never to `http://`, never to loopback/link-local/private hosts
        // (the sandbox's own listeners, the cloud metadata address).
        let insecure = config.insecure_cookies;
        let plain = reqwest::Client::builder()
            .user_agent(&user_agent)
            .connect_timeout(CONNECT_TIMEOUT)
            .read_timeout(REQUEST_TIMEOUT)
            .redirect(reqwest::redirect::Policy::custom(move |attempt| {
                if attempt.previous().len() >= MAX_TARBALL_REDIRECTS {
                    return attempt.error("too many redirects");
                }
                match check_tarball_url(attempt.url().as_str(), insecure) {
                    Ok(()) => attempt.follow(),
                    Err(error) => attempt.error(error.to_string()),
                }
            }))
            .build()?;
        Ok(Self {
            http,
            plain,
            config,
        })
    }

    /// The configuration this client was built from.
    pub fn config(&self) -> &Arc<Config> {
        &self.config
    }

    /// `GET {api}/sandboxes/{name}/manifest`.
    pub async fn manifest(&self) -> Result<Manifest, ControlPlaneError> {
        let bytes = self
            .call(MAX_TRIES, || self.request(reqwest::Method::GET, "manifest"))
            .await?;
        Manifest::parse(&bytes).map_err(|error| ControlPlaneError::Decode(error.to_string()))
    }

    /// `POST {api}/sandboxes/{name}/git-token`. A `404 host_unsupported` / `403 repo_not_allowed`
    /// surfaces as [`ControlPlaneError::Status`] so the helper can fall through (§3.13).
    pub async fn git_token(
        &self,
        req: GitTokenRequest<'_>,
    ) -> Result<GitTokenResponse, ControlPlaneError> {
        let bytes = self
            .call(MAX_TRIES, || {
                self.request(reqwest::Method::POST, "git-token").json(&req)
            })
            .await?;
        decode(&bytes)
    }

    /// `POST {api}/sandboxes/{name}/ports`; a 4xx (no free slot, bad port) surfaces as
    /// `Status { code }` and is relayed to the server as-is (§3.12).
    pub async fn forward(
        &self,
        req: ForwardRequest<'_>,
    ) -> Result<ForwardResponse, ControlPlaneError> {
        let bytes = self
            .call(MAX_TRIES, || {
                self.request(reqwest::Method::POST, "ports").json(&req)
            })
            .await?;
        decode(&bytes)
    }

    /// `DELETE {api}/sandboxes/{name}/ports/{port}` → 204.
    pub async fn unforward(&self, port: u16) -> Result<(), ControlPlaneError> {
        let suffix = format!("ports/{port}");
        self.call(MAX_TRIES, || self.request(reqwest::Method::DELETE, &suffix))
            .await?;
        Ok(())
    }

    /// `POST {api}/sandboxes/{name}/activity` → [`ActivityDirective`].
    pub async fn activity(
        &self,
        report: &ActivityReport<'_>,
    ) -> Result<ActivityDirective, ControlPlaneError> {
        let bytes = self
            .call(ACTIVITY_TRIES, || {
                self.request(reqwest::Method::POST, "activity").json(report)
            })
            .await?;
        decode(&bytes)
    }

    /// `POST {api}/sandboxes/{name}/logs`, JSON, any 2xx ok, ≤ 2 tries; 413 → the caller halves
    /// the batch.
    pub async fn logs(&self, batch: &LogBatch<'_>) -> Result<(), ControlPlaneError> {
        self.call(LOG_TRIES, || {
            self.request(reqwest::Method::POST, "logs").json(batch)
        })
        .await?;
        Ok(())
    }

    /// `POST {api}/sandboxes/{name}/client-errors` → 202.
    pub async fn client_error(
        &self,
        report: &ClientErrorReport<'_>,
    ) -> Result<(), ControlPlaneError> {
        self.call(LOG_TRIES, || {
            self.request(reqwest::Method::POST, "client-errors")
                .json(report)
        })
        .await?;
        Ok(())
    }

    /// `POST {api}/sandboxes/{name}/extensions {"installed": [...]}` → 204 (D18/D19 relay).
    pub async fn report_extensions(&self, ids: &[String]) -> Result<(), ControlPlaneError> {
        let body = InstalledExtensions { installed: ids };
        self.call(MAX_TRIES, || {
            self.request(reqwest::Method::POST, "extensions")
                .json(&body)
        })
        .await?;
        Ok(())
    }

    /// `GET <presigned url>` with the `plain` client (no `Authorization`, no bypass header),
    /// streamed via reqwest `bytes_stream()`.
    pub async fn restore_tarball(
        &self,
        url: &str,
    ) -> Result<impl Stream<Item = reqwest::Result<bytes::Bytes>>, ControlPlaneError> {
        check_tarball_url(url, self.config.insecure_cookies)
            .map_err(|error| ControlPlaneError::Decode(error.to_string()))?;
        let response = self.plain.get(url).send().await?;
        let status = response.status();
        if !status.is_success() {
            let body = response.text().await.unwrap_or_default();
            return Err(ControlPlaneError::Status {
                status: status.as_u16(),
                code: None,
                body: cap_body(body),
            });
        }
        Ok(response.bytes_stream())
    }

    /// Sends `make()` up to `tries` times and returns the 2xx body.
    ///
    /// Only connect/timeout failures and 5xx answers are retried (§3.5); a `429` waits out its
    /// `Retry-After` (capped at [`MAX_RETRY_AFTER`]) and counts as one try. Every other non-2xx is
    /// returned to the caller through [`classify`] on the first attempt, so a `403 repo_not_allowed`
    /// or a `409 slots_exhausted` is never retried.
    async fn call(
        &self,
        tries: u32,
        make: impl Fn() -> reqwest::RequestBuilder,
    ) -> Result<bytes::Bytes, ControlPlaneError> {
        let tries = tries.max(1);
        let mut attempt = 0;
        loop {
            attempt += 1;
            let last = attempt >= tries;
            match make().send().await {
                Ok(response) => {
                    let status = response.status();
                    if status.is_success() {
                        return Ok(response.bytes().await?);
                    }
                    let retry_after = retry_after(response.headers());
                    let body = response.text().await.unwrap_or_default();
                    let retriable = status.is_server_error()
                        || status == reqwest::StatusCode::TOO_MANY_REQUESTS;
                    if !retriable || last {
                        return Err(classify(status.as_u16(), body));
                    }
                    let pause = retry_after.unwrap_or_else(|| backoff(attempt));
                    tracing::warn!(
                        status = status.as_u16(),
                        attempt,
                        pause_ms = pause.as_millis() as u64,
                        "control plane call failed; retrying"
                    );
                    tokio::time::sleep(pause).await;
                }
                Err(error) => {
                    if last || !is_retriable(&error) {
                        return Err(ControlPlaneError::Transport(error));
                    }
                    let pause = backoff(attempt);
                    tracing::warn!(
                        error = %error,
                        attempt,
                        pause_ms = pause.as_millis() as u64,
                        "control plane transport error; retrying"
                    );
                    tokio::time::sleep(pause).await;
                }
            }
        }
    }

    /// A request to `{api}/sandboxes/{name}/{suffix}` carrying the bearer, the build header and,
    /// when configured, the bypass header.
    fn request(&self, method: reqwest::Method, suffix: &str) -> reqwest::RequestBuilder {
        let mut builder = self
            .http
            .request(method, self.config.sandbox_api_url(suffix))
            .bearer_auth(self.config.sandbox_token.expose_secret())
            .header(BUILD_HEADER, &self.config.build_id);
        if let Some(bypass) = &self.config.bypass_secret {
            builder = builder.header(BYPASS_HEADER, bypass.expose_secret());
        }
        builder
    }
}

/// Maps a non-2xx status and body to a [`ControlPlaneError`]; the body is capped at
/// [`MAX_ERROR_BODY_BYTES`] (the error code is parsed from the full text first).
pub fn classify(status: u16, body: String) -> ControlPlaneError {
    match status {
        401 => ControlPlaneError::Unauthorized,
        410 => ControlPlaneError::Retired,
        _ => ControlPlaneError::Status {
            status,
            code: parse_error_code(&body),
            body: cap_body(body),
        },
    }
}

/// Truncates an error body to [`MAX_ERROR_BODY_BYTES`] on a char boundary.
fn cap_body(body: String) -> String {
    crate::logs::truncate_with_marker(std::borrow::Cow::Owned(body), MAX_ERROR_BODY_BYTES)
}

/// The rule for `manifest.restore.tarballUrl` and every redirect the tarball client follows:
/// an absolute `https://` URL (or `http://` when `insecure` – the local docker test's mock),
/// no userinfo, and – unless `insecure` – a host that is neither an IP literal in a
/// loopback/link-local/private/unspecified range nor a local-only name (`localhost`, `*.local`,
/// `*.internal`, a bare label). The sandbox must never stream `http://169.254.169.254/…` or
/// its own `127.0.0.1:8451/control/…` into `tar` on a manifest's say-so.
pub fn check_tarball_url(url: &str, insecure: bool) -> anyhow::Result<()> {
    use anyhow::{anyhow, bail};
    let parsed =
        reqwest::Url::parse(url).map_err(|error| anyhow!("restore.tarballUrl: {error}"))?;
    match parsed.scheme() {
        "https" => {}
        "http" if insecure => {}
        other => bail!("restore.tarballUrl must be https:// (got {other}://)"),
    }
    if !parsed.username().is_empty() || parsed.password().is_some() {
        bail!("restore.tarballUrl must not carry credentials");
    }
    let Some(host) = parsed.host_str() else {
        bail!("restore.tarballUrl has no host");
    };
    if insecure {
        return Ok(());
    }
    let bare = host.trim_start_matches('[').trim_end_matches(']');
    if let Ok(ip) = bare.parse::<std::net::IpAddr>() {
        if !is_public_ip(ip) {
            bail!("restore.tarballUrl host {host} is not a public address");
        }
    } else if !is_public_domain(bare) {
        bail!("restore.tarballUrl host {host} is not a public name");
    }
    Ok(())
}

/// Globally routable, as far as the address alone can tell (DNS answers are not re-checked).
fn is_public_ip(ip: std::net::IpAddr) -> bool {
    match ip {
        std::net::IpAddr::V4(v4) => {
            !(v4.is_loopback()
                || v4.is_link_local()
                || v4.is_private()
                || v4.is_unspecified()
                || v4.is_broadcast()
                || v4.is_documentation()
                // Carrier-grade NAT (100.64.0.0/10) and the benchmarking range are local too.
                || (v4.octets()[0] == 100 && (64..=127).contains(&v4.octets()[1])))
        }
        std::net::IpAddr::V6(v6) => {
            if let Some(mapped) = v6.to_ipv4_mapped() {
                return is_public_ip(std::net::IpAddr::V4(mapped));
            }
            !(v6.is_loopback()
                || v6.is_unspecified()
                || v6.is_unique_local()
                || v6.is_unicast_link_local())
        }
    }
}

/// A name that resolves somewhere public: has a dot, is not `localhost` and not under
/// `.localhost`, `.local`, `.internal` or `.home.arpa`.
fn is_public_domain(name: &str) -> bool {
    let name = name.trim_end_matches('.').to_ascii_lowercase();
    if name.is_empty() || !name.contains('.') || name == "localhost" {
        return false;
    }
    !(name.ends_with(".localhost")
        || name.ends_with(".local")
        || name.ends_with(".internal")
        || name.ends_with(".home.arpa"))
}

/// Extracts the error code from a control-plane error body: b9 emits
/// `{ "error": { "code", "message" } }`; a string-valued `{ "error": "code" }` is accepted too.
pub fn parse_error_code(body: &str) -> Option<String> {
    let value: serde_json::Value = serde_json::from_str(body).ok()?;
    match value.get("error")? {
        serde_json::Value::String(code) => Some(code.clone()),
        serde_json::Value::Object(map) => map.get("code")?.as_str().map(str::to_string),
        _ => None,
    }
}

/// Decodes a 2xx body, turning a serde failure into [`ControlPlaneError::Decode`].
fn decode<T: serde::de::DeserializeOwned>(bytes: &[u8]) -> Result<T, ControlPlaneError> {
    serde_json::from_slice(bytes).map_err(|error| ControlPlaneError::Decode(error.to_string()))
}

/// Jittered exponential backoff for attempt `n` (1-based): `250 ms · 2ⁿ⁻¹` ± 25 %, i.e. a
/// uniform pick from `[base − base/4, base + base/4]` (the jitter range is `base/2` wide,
/// exclusive at the top so the upper bound is never exceeded).
pub fn backoff(attempt: u32) -> Duration {
    let base = BACKOFF_BASE.as_millis() as u64 * (1u64 << (attempt.saturating_sub(1)).min(6));
    let jitter = rand::random::<u32>() as u64 % (base / 2).max(1);
    Duration::from_millis(base.saturating_sub(base / 4) + jitter)
}

/// `Retry-After` in delta-seconds, capped at [`MAX_RETRY_AFTER`]; HTTP-date forms are ignored.
fn retry_after(headers: &reqwest::header::HeaderMap) -> Option<Duration> {
    let value = headers.get(reqwest::header::RETRY_AFTER)?.to_str().ok()?;
    let seconds: u64 = value.trim().parse().ok()?;
    Some(Duration::from_secs(seconds).min(MAX_RETRY_AFTER))
}

/// Connect, timeout and body errors are worth another attempt; a request that could not even be
/// built is not.
fn is_retriable(error: &reqwest::Error) -> bool {
    error.is_timeout() || error.is_connect() || error.is_request() || error.is_body()
}
