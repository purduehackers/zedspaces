//! git credential helper (brief §3.13; BUILD-SPEC §6.2).
//!
//! Registered in the image as `git config --system credential.helper '!zs-agent credential'` with
//! `credential.useHttpPath true`, so `path` reaches the helper and the control plane can scope the
//! installation token to the workspace repository (403 `repo_not_allowed` → fall through).
//! Every process that runs git inside the workspace inherits `ZS_CONTROL_SECRET_FILE` (a path);
//! processes without it fall through to askpass.
//!
//! The helper **never caches**: `store` and `erase` are no-ops, nothing is written to disk, and
//! every `get` asks the supervisor's loopback API (`POST /git-token`, which forwards to
//! `POST {ZS_CONTROL_URL}/sandboxes/{name}/git-token`) for a fresh installation token. The token
//! lives only in the response it prints on stdout, so a snapshot never contains one
//! (BUILD-SPEC §10.4: "GitHub tokens are never written to disk").
//!
//! **Limitation (BUILD-SPEC §10.4 holds for this helper only).** git hands every accepted
//! credential to the `store` operation of *all* configured helpers, so a user-level
//! `credential.helper = store` (common in dotfiles) persists the one-hour `ghs_` token to
//! `~/.git-credentials` inside the snapshotted `$HOME`; `password_expiry_utc` is honoured by
//! `credential-cache` but not by `credential-store`. The dotfiles step warns when the resulting
//! global config lists a storing helper (`bootstrap::warn_about_storing_credential_helpers`);
//! the platform does not override the user's helper list.

use std::io::{BufRead, Write};
use std::path::Path;
use std::time::Duration;

use anyhow::anyhow;
use secrecy::{ExposeSecret as _, SecretString};

use crate::control_plane::{ExpiresAt, GitTokenRequest};

/// Route on the supervisor's loopback API that mints the token (brief §3.12).
pub const GIT_TOKEN_PATH: &str = "/git-token";
/// The only host the helper answers for; anything else falls through to askpass.
pub const SUPPORTED_HOST: &str = "github.com";
/// The only protocol the helper answers for.
pub const SUPPORTED_PROTOCOL: &str = "https";
/// Budget for the loopback round trip (brief §3.13).
pub const REQUEST_TIMEOUT: Duration = Duration::from_secs(5);

/// The `key=value` lines git sends on stdin.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct CredentialRequest {
    /// `protocol=`.
    pub protocol: Option<String>,
    /// `host=`.
    pub host: Option<String>,
    /// `path=` (with `credential.useHttpPath`).
    pub path: Option<String>,
    /// `username=`.
    pub username: Option<String>,
}

impl CredentialRequest {
    /// `true` when this request is for GitHub over https (or with no protocol given), the only
    /// case the control plane can answer; everything else falls through to the next helper.
    pub fn is_supported(&self) -> bool {
        self.host.as_deref() == Some(SUPPORTED_HOST)
            && matches!(self.protocol.as_deref(), Some(SUPPORTED_PROTOCOL) | None)
    }
}

/// Reads `key=value` lines until EOF or a blank line; unknown keys (`wwwauth[]`, `capability[]`)
/// are ignored.
pub fn parse_request<R: BufRead>(input: R) -> std::io::Result<CredentialRequest> {
    let mut request = CredentialRequest::default();
    for line in input.lines() {
        let line = line?;
        if line.is_empty() {
            break;
        }
        let Some((key, value)) = line.split_once('=') else {
            continue;
        };
        let value = Some(value.to_string());
        match key {
            "protocol" => request.protocol = value,
            "host" => request.host = value,
            "path" => request.path = value,
            "username" => request.username = value,
            _ => {}
        }
    }
    Ok(request)
}

/// `username=<u>\npassword=<p>\n[password_expiry_utc=<unix secs>\n]`.
pub fn format_response(username: &str, password: &str, expires_at_unix: Option<u64>) -> String {
    let mut out = format!("username={username}\npassword={password}\n");
    if let Some(expiry) = expires_at_unix {
        out.push_str(&format!("password_expiry_utc={expiry}\n"));
    }
    out
}

/// Normalises either `expiresAt` wire form to unix seconds; an unparsable string yields `None`,
/// which simply omits `password_expiry_utc` (git then caches nothing based on expiry).
pub fn expires_at_seconds(expires_at: &ExpiresAt) -> Option<u64> {
    match expires_at {
        ExpiresAt::UnixSeconds(seconds) => Some(*seconds),
        ExpiresAt::Iso(text) => parse_rfc3339_utc(text),
    }
}

/// Accepts JS `toISOString()` output only (`YYYY-MM-DDTHH:MM:SS[.fff]Z`) → unix seconds;
/// anything else → `None` (expiry omitted). Used for the `ExpiresAt::Iso` tolerance path.
pub fn parse_rfc3339_utc(s: &str) -> Option<u64> {
    let s = s.trim().strip_suffix('Z')?;
    let (date, time) = s.split_once('T')?;
    let mut date_parts = date.split('-');
    let year: i64 = date_parts.next()?.parse().ok()?;
    let month: u32 = date_parts.next()?.parse().ok()?;
    let day: u32 = date_parts.next()?.parse().ok()?;
    if date_parts.next().is_some() || !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return None;
    }
    let time = time.split('.').next()?;
    let mut time_parts = time.split(':');
    let hour: u64 = time_parts.next()?.parse().ok()?;
    let minute: u64 = time_parts.next()?.parse().ok()?;
    let second: u64 = time_parts.next()?.parse().ok()?;
    if time_parts.next().is_some() || hour > 23 || minute > 59 || second > 59 {
        return None;
    }
    let days = days_from_civil(year, month, day);
    if days < 0 {
        return None;
    }
    Some(days as u64 * 86_400 + hour * 3_600 + minute * 60 + second)
}

/// Days since 1970-01-01 for a proleptic Gregorian date (Howard Hinnant's algorithm).
fn days_from_civil(year: i64, month: u32, day: u32) -> i64 {
    let year = if month <= 2 { year - 1 } else { year };
    let era = if year >= 0 { year } else { year - 399 } / 400;
    let year_of_era = (year - era * 400) as u64;
    let month_index = (month + 9) % 12;
    let day_of_year = (153 * month_index as u64 + 2) / 5 + day as u64 - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    era * 146_097 + day_of_era as i64 - 719_468
}

/// Reads the control secret from `ZS_CONTROL_SECRET_FILE` (D18), else `$HOME/.zs/run/control.secret`;
/// `None` when absent/unreadable.
pub fn read_control_secret_file(path: Option<&Path>, home: &Path) -> Option<SecretString> {
    let path = path
        .map(Path::to_path_buf)
        .unwrap_or_else(|| home.join(".zs").join("run").join("control.secret"));
    let contents = std::fs::read_to_string(path).ok()?;
    let trimmed = contents.trim_end_matches(['\r', '\n']);
    (!trimmed.is_empty()).then(|| SecretString::from(trimmed.to_string()))
}

/// `zs-agent credential <get|store|erase>` against stdin/stdout.
///
/// `store`/`erase` print nothing and exit 0 (the helper caches nothing, so there is nothing to
/// store or forget). `get` parses stdin; if `host != github.com`, `protocol` ∉ {https, none}, or
/// no control secret file is readable, it prints nothing and exits 0, so git falls through to the
/// next helper / askpass (`AskPassRequest`, BUILD-SPEC §5.7). Otherwise it POSTs
/// `{supervisor_url}/git-token` with the bearer and prints [`format_response`]; 403/404 from the
/// supervisor (`repo_not_allowed` / `host_unsupported`) also fall through. A network failure
/// prints one line on stderr and exits 1.
pub async fn main(
    operation: &str,
    supervisor_url: &str,
    control_secret: Option<SecretString>,
) -> anyhow::Result<i32> {
    let stdin = std::io::stdin();
    let mut stdout = std::io::stdout();
    let code = run(
        operation,
        supervisor_url,
        control_secret,
        stdin.lock(),
        &mut stdout,
    )
    .await?;
    stdout.flush()?;
    Ok(code)
}

/// [`main`] with the streams injected, so tests can drive it without a terminal.
pub async fn run<R: BufRead, W: Write>(
    operation: &str,
    supervisor_url: &str,
    control_secret: Option<SecretString>,
    input: R,
    out: &mut W,
) -> anyhow::Result<i32> {
    match operation {
        // Nothing is cached, so there is nothing to store or erase.
        "store" | "erase" => return Ok(0),
        "get" => {}
        other => return Err(anyhow!("unknown credential operation {other:?}")),
    }
    let request = parse_request(input)?;
    if !request.is_supported() {
        return Ok(0);
    }
    let Some(secret) = control_secret else {
        return Ok(0);
    };

    let client = reqwest::Client::builder()
        .timeout(REQUEST_TIMEOUT)
        .no_proxy()
        .build()?;
    let url = format!("{}{GIT_TOKEN_PATH}", supervisor_url.trim_end_matches('/'));
    let body = GitTokenRequest {
        host: SUPPORTED_HOST,
        protocol: SUPPORTED_PROTOCOL,
        path: request.path.as_deref(),
    };
    let response = match client
        .post(&url)
        .bearer_auth(secret.expose_secret())
        .json(&body)
        .send()
        .await
    {
        Ok(response) => response,
        Err(error) => {
            eprintln!("zs-agent credential: {url} unreachable: {error}");
            return Ok(1);
        }
    };
    let status = response.status();
    // 404 `host_unsupported` / 403 `repo_not_allowed`: git falls through to the next helper.
    if status.as_u16() == 403 || status.as_u16() == 404 {
        return Ok(0);
    }
    if !status.is_success() {
        eprintln!("zs-agent credential: git-token returned HTTP {status}");
        return Ok(1);
    }
    let token: GitTokenReply = match response.json().await {
        Ok(token) => token,
        Err(error) => {
            eprintln!("zs-agent credential: malformed git-token response: {error}");
            return Ok(1);
        }
    };
    // Public-only control planes deliberately return no credentials. Emit nothing
    // so Git can use anonymous HTTPS instead of an empty Basic-auth header.
    if token.token.expose_secret().is_empty() {
        return Ok(0);
    }
    out.write_all(
        format_response(
            &token.username,
            token.token.expose_secret(),
            token.expires_at.as_ref().and_then(expires_at_seconds),
        )
        .as_bytes(),
    )?;
    Ok(0)
}

/// The supervisor's `/git-token` reply: `GitTokenResponse` passed through with `expiresAt`
/// normalised to unix seconds (brief §3.12). A missing or `null` `expiresAt` – what the supervisor
/// sends when the control plane's timestamp could not be parsed – simply omits
/// `password_expiry_utc`, so git treats the credential as non-expiring for this invocation.
#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct GitTokenReply {
    username: String,
    token: SecretString,
    #[serde(default)]
    expires_at: Option<ExpiresAt>,
}
