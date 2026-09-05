//! Port bootstrap tokens and proxy session cookies (brief §3.10, §4.5; D8).
//!
//! Two token kinds, **one format**: `v1.<b64url(json payload)>.<b64url(HMAC-SHA256(key, "v1." +
//! b64url(payload)))>` with unpadded base64url, payload `{"ws","port","sub","iat","exp","jti"}`
//! serialised in that field order (b9 `signPortSession`, byte-for-byte).
//!
//! * **Bootstrap token** (`zs_port_token`): minted by the control plane's `/open` route under
//!   `manifest.portSessionSecret`, TTL 1 h; verified by the proxy with the same key.
//! * **Session cookie** (`zs_port_session`): minted by the proxy after a successful bootstrap under
//!   a per-boot random key that lives only in memory; invalid after every resume.

use base64::Engine as _;
use base64::engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD};
use hmac::{Hmac, Mac as _};
use rand::RngCore as _;
use sha2::Sha256;
use subtle::ConstantTimeEq as _;

use crate::ports::is_infra_port;

/// Cookie name (D8).
pub const COOKIE_NAME: &str = "zs_port_session";
/// Query parameter carrying the bootstrap token (D8).
pub const BOOTSTRAP_PARAM: &str = "zs_port_token";
/// Token format prefix.
pub const TOKEN_PREFIX: &str = "v1";
/// Proxy cookie lifetime.
pub const COOKIE_TTL_SECS: u64 = 8 * 3600;
/// b9 `PORT_SESSION_TTL_SECS`; a longer-lived bootstrap token is rejected as `Expired`.
pub const BOOTSTRAP_MAX_AGE_SECS: u64 = 3600;

type HmacSha256 = Hmac<Sha256>;

/// Token payload; field order is the wire order.
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct PortSession {
    /// Workspace id.
    pub ws: String,
    /// Target port.
    pub port: u16,
    /// Subject (user id, or the proxy's own marker for cookies).
    pub sub: String,
    /// Issued at, unix seconds.
    pub iat: u64,
    /// Expires at, unix seconds.
    pub exp: u64,
    /// Unique id.
    pub jti: String,
}

/// Why a token was refused.
#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum AuthError {
    /// Not three dot-separated parts, bad prefix, bad base64 or bad JSON.
    #[error("malformed token")]
    Malformed,
    /// MAC mismatch.
    #[error("bad signature")]
    BadSignature,
    /// `exp` passed, or `exp - iat` exceeds the allowed age.
    #[error("expired")]
    Expired,
    /// `ws` differs from this sandbox's workspace id.
    #[error("wrong workspace")]
    WrongWorkspace,
    /// Port 0 or an infrastructure port.
    #[error("port not allowed")]
    BadPort,
    /// The token's port does not match the slot's binding (proxy-level check).
    #[error("token port does not match this slot")]
    WrongSlot,
}

/// HMAC-SHA256 signer/verifier over one 32-byte key.
pub struct PortTokenCodec {
    key: [u8; 32],
}

impl PortTokenCodec {
    /// Bootstrap: `manifest.port_session_key()`; cookies: [`PortTokenCodec::random`].
    pub fn new(key: [u8; 32]) -> Self {
        Self { key }
    }

    /// A fresh random key (rand 0.9 `rng().fill_bytes`); one per proxy start.
    pub fn random() -> Self {
        let mut key = [0u8; 32];
        rand::rng().fill_bytes(&mut key);
        Self { key }
    }

    /// `v1.<b64url(json payload)>.<b64url(HMAC-SHA256(key, "v1." + b64url(payload)))>`.
    pub fn sign(&self, session: &PortSession) -> String {
        let payload = serde_json::to_vec(session).expect("PortSession serialises");
        let signing_input = format!("{TOKEN_PREFIX}.{}", URL_SAFE_NO_PAD.encode(payload));
        let signature = URL_SAFE_NO_PAD.encode(self.mac(signing_input.as_bytes()));
        format!("{signing_input}.{signature}")
    }

    /// Splits on `.`, requires prefix `v1`, recomputes the MAC and compares with
    /// `subtle::ConstantTimeEq` **before** decoding the payload, then checks `exp > now`,
    /// `exp - iat <= max_age`, `ws == workspace_id`, port ∈ 1..=65535 ∖ INFRA_PORTS.
    pub fn verify(
        &self,
        token: &str,
        workspace_id: &str,
        now: u64,
        max_age: u64,
    ) -> Result<PortSession, AuthError> {
        let mut parts = token.splitn(3, '.');
        let (Some(prefix), Some(payload_b64), Some(signature_b64)) =
            (parts.next(), parts.next(), parts.next())
        else {
            return Err(AuthError::Malformed);
        };
        if prefix != TOKEN_PREFIX || payload_b64.is_empty() || signature_b64.is_empty() {
            return Err(AuthError::Malformed);
        }
        let signature = URL_SAFE_NO_PAD
            .decode(signature_b64)
            .map_err(|_| AuthError::Malformed)?;
        let expected = self.mac(format!("{prefix}.{payload_b64}").as_bytes());
        if !bool::from(expected.as_slice().ct_eq(signature.as_slice())) {
            return Err(AuthError::BadSignature);
        }
        let payload = URL_SAFE_NO_PAD
            .decode(payload_b64)
            .map_err(|_| AuthError::Malformed)?;
        let session: PortSession =
            serde_json::from_slice(&payload).map_err(|_| AuthError::Malformed)?;
        if session.exp <= now || session.exp < session.iat || session.exp - session.iat > max_age {
            return Err(AuthError::Expired);
        }
        if session.ws != workspace_id {
            return Err(AuthError::WrongWorkspace);
        }
        if session.port == 0 || is_infra_port(session.port) {
            return Err(AuthError::BadPort);
        }
        Ok(session)
    }

    fn mac(&self, input: &[u8]) -> [u8; 32] {
        let mut mac = HmacSha256::new_from_slice(&self.key).expect("HMAC accepts any key length");
        mac.update(input);
        mac.finalize().into_bytes().into()
    }
}

/// Finds `zs_port_session` in a `Cookie:` header value (`a=b; c=d`), ignoring others.
pub fn cookie_from_header(header: &str) -> Option<&str> {
    header
        .split(';')
        .map(str::trim)
        .find_map(|pair| {
            pair.strip_prefix(COOKIE_NAME)
                .and_then(|rest| rest.strip_prefix('='))
        })
        .filter(|value| !value.is_empty())
}

/// `Set-Cookie` value: `zs_port_session=<t>; Path=/; HttpOnly; SameSite=Lax; Max-Age=<max_age>[; Secure]`.
pub fn set_cookie_header(token: &str, max_age: u64, secure: bool) -> String {
    let mut header =
        format!("{COOKIE_NAME}={token}; Path=/; HttpOnly; SameSite=Lax; Max-Age={max_age}");
    if secure {
        header.push_str("; Secure");
    }
    header
}

/// `Set-Cookie` value clearing the cookie (`Max-Age=0`).
pub fn clear_cookie_header(secure: bool) -> String {
    set_cookie_header("", 0, secure)
}

/// `next` (already percent-decoded) must be a same-origin path: it starts with a single `/`
/// (not `//` or `/\`) and carries no ASCII control character, whitespace or backslash anywhere –
/// browsers strip tabs and newlines before parsing a `Location`, so `/<TAB>/evil.example` would
/// become the scheme-relative `//evil.example`, and treat `\` as `/`. Anything else → `/`. The
/// accepted value is returned percent-encoded for the header ([`encode_location`]).
pub fn safe_next(next: Option<&str>) -> String {
    match next {
        Some(value) if is_same_origin_path(value) => encode_location(value),
        _ => "/".to_string(),
    }
}

fn is_same_origin_path(value: &str) -> bool {
    value.starts_with('/')
        && !value.starts_with("//")
        && !value.starts_with("/\\")
        && !value
            .chars()
            .any(|c| c.is_ascii_control() || c.is_whitespace() || c == '\\')
}

/// Percent-encodes a decoded path-and-query for a `Location` header: RFC 3986 unreserved and
/// sub-delimiter characters plus `: @ / ? #` pass through, everything else (including `%`, so a
/// decoded `%25` round-trips, and every non-ASCII byte) is `%XX`-encoded. The result is visible
/// ASCII only, so it is always a valid header value.
pub fn encode_location(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for byte in value.bytes() {
        let keep = byte.is_ascii_alphanumeric()
            || matches!(
                byte,
                b'-' | b'.'
                    | b'_'
                    | b'~'
                    | b'!'
                    | b'$'
                    | b'&'
                    | b'\''
                    | b'('
                    | b')'
                    | b'*'
                    | b'+'
                    | b','
                    | b';'
                    | b'='
                    | b':'
                    | b'@'
                    | b'/'
                    | b'?'
                    | b'#'
            );
        if keep {
            out.push(byte as char);
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

/// Standard base64, padded (b9 `newPortSessionSecret`); exactly 32 bytes.
pub fn decode_secret(b64: &str) -> Result<[u8; 32], AuthError> {
    let bytes = STANDARD
        .decode(b64.trim())
        .map_err(|_| AuthError::Malformed)?;
    bytes.try_into().map_err(|_| AuthError::Malformed)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn session(now: u64) -> PortSession {
        PortSession {
            ws: "ws_1".to_string(),
            port: 3000,
            sub: "user_1".to_string(),
            iat: now,
            exp: now + 600,
            jti: "j1".to_string(),
        }
    }

    #[test]
    fn sign_verify_roundtrip() {
        let codec = PortTokenCodec::new([7u8; 32]);
        let now = 1_756_800_000;
        let token = codec.sign(&session(now));
        assert!(token.starts_with("v1."));
        assert_eq!(
            codec.verify(&token, "ws_1", now + 1, BOOTSTRAP_MAX_AGE_SECS),
            Ok(session(now))
        );
        assert_eq!(
            codec.verify(&token, "ws_2", now + 1, 3600),
            Err(AuthError::WrongWorkspace)
        );
        assert_eq!(
            codec.verify(&token, "ws_1", now + 601, 3600),
            Err(AuthError::Expired)
        );
        assert_eq!(
            codec.verify(&token, "ws_1", now + 1, 10),
            Err(AuthError::Expired)
        );
        let other = PortTokenCodec::new([8u8; 32]);
        assert_eq!(
            other.verify(&token, "ws_1", now + 1, 3600),
            Err(AuthError::BadSignature)
        );
        let mut tampered = token.clone();
        tampered.replace_range(3..4, if &token[3..4] == "A" { "B" } else { "A" });
        assert_eq!(
            codec.verify(&tampered, "ws_1", now + 1, 3600),
            Err(AuthError::BadSignature)
        );
        assert_eq!(
            codec.verify("v1.abc", "ws_1", now, 3600),
            Err(AuthError::Malformed)
        );
        let mut infra = session(now);
        infra.port = 8448;
        let token = codec.sign(&infra);
        assert_eq!(
            codec.verify(&token, "ws_1", now + 1, 3600),
            Err(AuthError::BadPort)
        );
    }

    /// `docs/contracts/fixtures/port-token.vector.json`, the vector b9's
    /// `port_session_matches_b8_vector` pins too.
    const VECTOR: &str = include_str!("../../../docs/contracts/fixtures/port-token.vector.json");

    #[test]
    fn port_token_vector() {
        let vector: serde_json::Value = serde_json::from_str(VECTOR).unwrap();
        let secret = decode_secret(vector["secretB64"].as_str().unwrap()).unwrap();
        let payload: PortSession = serde_json::from_value(vector["payload"].clone()).unwrap();
        let expected = vector["token"].as_str().unwrap();
        let codec = PortTokenCodec::new(secret);
        assert_eq!(
            codec.sign(&payload),
            expected,
            "the pinned token must reproduce byte for byte"
        );
        // It verifies under the same key (any `now` inside its lifetime).
        assert_eq!(
            codec.verify(
                expected,
                &payload.ws,
                payload.iat + 1,
                BOOTSTRAP_MAX_AGE_SECS
            ),
            Ok(payload.clone())
        );
        // The middle part is the compact payload in wire order.
        let middle = expected.split('.').nth(1).unwrap();
        let decoded = URL_SAFE_NO_PAD.decode(middle).unwrap();
        assert_eq!(
            String::from_utf8(decoded).unwrap(),
            serde_json::to_string(&payload).unwrap()
        );
    }

    #[test]
    fn bootstrap_rejects() {
        let codec = PortTokenCodec::new([7u8; 32]);
        let now = 1_756_800_000;
        // Port 0 and every infra port are refused after the MAC checks out.
        for port in [0u16, 8443, 8446, 8450, 8451] {
            let mut bad = session(now);
            bad.port = port;
            let token = codec.sign(&bad);
            assert_eq!(
                codec.verify(&token, "ws_1", now + 1, 3600),
                Err(AuthError::BadPort),
                "port {port}"
            );
        }
        // A lifetime beyond `max_age` is refused even before it expires.
        let mut long = session(now);
        long.exp = now + 7200;
        let token = codec.sign(&long);
        assert_eq!(
            codec.verify(&token, "ws_1", now + 1, 3600),
            Err(AuthError::Expired)
        );
        // Wrong prefix, missing parts, bad base64.
        let good = codec.sign(&session(now));
        let v0 = format!("v0.{}", &good[3..]);
        assert_eq!(
            codec.verify(&v0, "ws_1", now + 1, 3600),
            Err(AuthError::Malformed)
        );
        assert_eq!(
            codec.verify("v1", "ws_1", now, 3600),
            Err(AuthError::Malformed)
        );
        assert_eq!(
            codec.verify("v1..", "ws_1", now, 3600),
            Err(AuthError::Malformed)
        );
        assert_eq!(
            codec.verify("v1.%%%.%%%", "ws_1", now, 3600),
            Err(AuthError::Malformed)
        );
        // A valid MAC over a payload that is not JSON is `Malformed`, not `BadSignature`.
        let payload_b64 = URL_SAFE_NO_PAD.encode(b"not json");
        let signing_input = format!("{TOKEN_PREFIX}.{payload_b64}");
        let signature = URL_SAFE_NO_PAD.encode(codec.mac(signing_input.as_bytes()));
        assert_eq!(
            codec.verify(&format!("{signing_input}.{signature}"), "ws_1", now, 3600),
            Err(AuthError::Malformed)
        );
    }

    #[test]
    fn decode_secret_shapes() {
        assert!(decode_secret(&STANDARD.encode([9u8; 32])).is_ok());
        assert!(decode_secret(&format!("{}\n", STANDARD.encode([9u8; 32]))).is_ok());
        assert_eq!(
            decode_secret(&STANDARD.encode([9u8; 31])),
            Err(AuthError::Malformed)
        );
        assert_eq!(
            decode_secret(&STANDARD.encode([9u8; 33])),
            Err(AuthError::Malformed)
        );
        let unpadded = STANDARD.encode([9u8; 32]).trim_end_matches('=').to_string();
        assert_eq!(decode_secret(&unpadded), Err(AuthError::Malformed));
        let url_safe = base64::engine::general_purpose::URL_SAFE.encode([0xfbu8; 32]);
        assert_eq!(decode_secret(&url_safe), Err(AuthError::Malformed));
    }

    #[test]
    fn cookie_header_parsing() {
        assert_eq!(cookie_from_header("a=1; zs_port_session=T; b=2"), Some("T"));
        assert_eq!(cookie_from_header("zs_port_session=T"), Some("T"));
        assert_eq!(cookie_from_header("a=1"), None);
        assert_eq!(cookie_from_header("zs_port_session_x=T"), None);
        assert_eq!(cookie_from_header("zs_port_session="), None);
    }

    #[test]
    fn payload_field_order_is_wire_order() {
        let json = serde_json::to_string(&session(1)).unwrap();
        assert_eq!(
            json,
            r#"{"ws":"ws_1","port":3000,"sub":"user_1","iat":1,"exp":601,"jti":"j1"}"#
        );
    }

    #[test]
    fn cookie_helpers() {
        assert_eq!(
            cookie_from_header("a=b; zs_port_session=v1.x.y; c=d"),
            Some("v1.x.y")
        );
        assert_eq!(cookie_from_header("a=b"), None);
        assert_eq!(
            set_cookie_header("t", 5, true),
            "zs_port_session=t; Path=/; HttpOnly; SameSite=Lax; Max-Age=5; Secure"
        );
        assert!(clear_cookie_header(false).contains("Max-Age=0"));
        assert_eq!(safe_next(Some("/a?b=1")), "/a?b=1");
        assert_eq!(safe_next(Some("//evil")), "/");
        assert_eq!(safe_next(Some("/\\evil")), "/");
        assert_eq!(safe_next(Some("http://x")), "/");
        assert_eq!(safe_next(None), "/");
    }

    #[test]
    fn next_rejects_browser_stripped_characters() {
        // Decoded forms of `/%09/evil`, `/%0a/evil`, `/%0d%0a/evil`, `/%5c%5cevil`,
        // `/%2f%09%2fevil`, `/%00/evil` and a stray backslash further in.
        for open_redirect in [
            "/\t/evil.example",
            "/\n/evil.example",
            "/\r\n/evil.example",
            "/\\\\evil.example",
            "/ /\t/evil.example",
            "/\u{0}/evil.example",
            "/a/\\evil.example",
            "/ /evil",
            "/\u{7f}x",
        ] {
            assert_eq!(safe_next(Some(open_redirect)), "/", "{open_redirect:?}");
        }
        // Legitimate paths pass and come back header-safe.
        assert_eq!(safe_next(Some("/a/b?c=1&d=2#frag")), "/a/b?c=1&d=2#frag");
        assert_eq!(safe_next(Some("/caf\u{e9}")), "/caf%C3%A9");
        assert_eq!(safe_next(Some("/x%25")), "/x%2525");
        assert_eq!(safe_next(Some("/q?a=<b>")), "/q?a=%3Cb%3E");
        assert_eq!(
            encode_location("/plain-._~!$&'()*+,;=:@/?#"),
            "/plain-._~!$&'()*+,;=:@/?#"
        );
        assert!(safe_next(Some("/caf\u{e9}")).is_ascii());
        assert_eq!(
            decode_secret(&STANDARD.encode([1u8; 32])).unwrap(),
            [1u8; 32]
        );
        assert_eq!(decode_secret("AAAA"), Err(AuthError::Malformed));
    }
}
