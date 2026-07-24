//! Guarded loopback transport for the Bisq 2 API.
//!
//! The webview must never open a socket itself: the app's CSP keeps
//! `connect-src` at `'self'`, so every byte the BisqAdapter exchanges with a
//! Bisq node comes through here, over Tauri IPC.
//!
//! That makes this module a deliberate hole in the sandbox, so it is drawn as
//! small as it can be while still carrying a Bisq session. Layered, so no
//! single check is load-bearing:
//!
//! 1. **No TLS is compiled in.** `reqwest` and `tokio-tungstenite` are built
//!    with `default-features = false`; there is no TLS backend in the binary.
//!    Even a total failure of the checks below cannot produce an `https://`
//!    request — the code to speak it does not exist.
//! 2. **`http:`/`ws:` only.** Anything else is refused by scheme.
//! 3. **Literal loopback IPs only.** Hostnames are refused *including*
//!    `localhost`, so this proxy never performs name resolution and DNS
//!    rebinding can never walk it off the machine.
//! 4. **Path allowlist.** HTTP is confined to `/api/v1/…` and the WebSocket to
//!    exactly `/websocket`. Pointed at some other loopback service, the worst
//!    it can utter is a Bisq-shaped request.
//! 5. **No redirects, no environment proxy.** A 3xx is returned to the caller
//!    verbatim rather than followed, so a redirect cannot relay off-loopback,
//!    and `HTTP_PROXY=` in the environment cannot capture the traffic.
//! 6. **Bounded.** Method allowlist, request/response/frame size caps, a
//!    connect+read timeout, and a ceiling on concurrent sockets.
//!
//! Residual risk, stated plainly: any port on the loopback interface is
//! reachable, because a user may legitimately run their node anywhere. The
//! path allowlist is what keeps that from being interesting.

use std::net::IpAddr;
use std::time::Duration;

use futures_util::StreamExt;
use url::{Host, Url};

pub const MAX_REQUEST_BODY: usize = 64 * 1024;
pub const MAX_RESPONSE_BODY: usize = 8 * 1024 * 1024;
pub const MAX_WS_FRAME: usize = 1024 * 1024;
pub const MAX_SOCKETS: usize = 4;
pub const HTTP_TIMEOUT: Duration = Duration::from_secs(30);

/// Bisq 2's REST prefix. Everything the adapter calls lives under it.
pub const API_PREFIX: &str = "/api/v1/";
/// Bisq 2's single WebSocket endpoint.
pub const WS_PATH: &str = "/websocket";

const ALLOWED_METHODS: [&str; 5] = ["GET", "POST", "PUT", "PATCH", "DELETE"];

/// Which allowlist a URL is checked against.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Http,
    Ws,
}

impl Kind {
    fn scheme(self) -> &'static str {
        match self {
            Kind::Http => "http",
            Kind::Ws => "ws",
        }
    }
}

/// True only for addresses that are loopback on this machine.
///
/// IPv4-mapped IPv6 (`::ffff:127.0.0.1`) is unwrapped first so it is judged on
/// the address it actually denotes — mapping a *public* address does not
/// launder it into loopback.
fn is_loopback_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => v4.is_loopback(),
        IpAddr::V6(v6) => match v6.to_ipv4_mapped() {
            Some(v4) => v4.is_loopback(),
            None => v6.is_loopback(),
        },
    }
}

/// Normalise and allowlist an HTTP method.
pub fn check_method(method: &str) -> Result<String, String> {
    let up = method.trim().to_ascii_uppercase();
    if ALLOWED_METHODS.contains(&up.as_str()) {
        Ok(up)
    } else {
        Err(format!(
            "method {method:?} is not allowed (permitted: {})",
            ALLOWED_METHODS.join(", ")
        ))
    }
}

/// The single gate every proxied URL passes through.
pub fn check_url(raw: &str, kind: Kind) -> Result<Url, String> {
    let url = Url::parse(raw).map_err(|e| format!("unparseable URL {raw:?}: {e}"))?;

    if url.scheme() != kind.scheme() {
        return Err(format!(
            "scheme {:?} is not allowed (expected {:?}) — this proxy speaks plaintext loopback only and has no TLS backend compiled in",
            url.scheme(),
            kind.scheme()
        ));
    }

    // `http://127.0.0.1@evil.example/` parses with host `evil.example`; the
    // host check below already catches it, but credentials have no business
    // here regardless.
    if !url.username().is_empty() || url.password().is_some() {
        return Err("credentials embedded in the URL are not allowed".into());
    }

    let host = url.host().ok_or("URL has no host")?;
    let ip: IpAddr = match host {
        Host::Ipv4(v4) => IpAddr::V4(v4),
        Host::Ipv6(v6) => IpAddr::V6(v6),
        Host::Domain(name) => {
            return Err(format!(
                "host {name:?} is not a literal loopback IP — use 127.0.0.1. Hostnames (including \"localhost\") are refused so that this proxy never resolves a name and DNS can never point it off-machine"
            ));
        }
    };
    if !is_loopback_ip(ip) {
        return Err(format!(
            "host {ip} is not loopback — this proxy only reaches 127.0.0.0/8 and ::1"
        ));
    }

    // `Url::parse` already resolves `..` segments, so a traversal shows up as a
    // path that simply fails the prefix test. Percent-encoded dots survive
    // parsing though, and would be decoded by the upstream server, so refuse
    // both spellings rather than reason about what Bisq does with them.
    let path = url.path();
    let lowered = path.to_ascii_lowercase();
    if path.contains("..") || lowered.contains("%2e") {
        return Err(format!("path {path:?} contains dot segments"));
    }

    let path_ok = match kind {
        Kind::Http => path.starts_with(API_PREFIX),
        Kind::Ws => path == WS_PATH,
    };
    if !path_ok {
        let expected = match kind {
            Kind::Http => format!("{API_PREFIX}…"),
            Kind::Ws => WS_PATH.to_string(),
        };
        return Err(format!(
            "path {path:?} is outside the allowlist (expected {expected})"
        ));
    }

    Ok(url)
}

/// The HTTP client the commands share.
///
/// `no_proxy` matters: without it `HTTP_PROXY` in the environment could route
/// what we believe is loopback traffic through someone else's server.
pub fn build_client() -> reqwest::Client {
    reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(HTTP_TIMEOUT)
        .no_proxy()
        .build()
        .expect("building a plaintext reqwest client cannot fail")
}

/// What the webview gets back. Response headers are deliberately dropped: the
/// adapter only ever reads status and body, so nothing else crosses the seam.
#[derive(Debug, serde::Serialize)]
pub struct HttpResponse {
    pub status: u16,
    pub body: String,
}

pub async fn http_request(
    client: &reqwest::Client,
    method: &str,
    raw_url: &str,
    body: Option<String>,
) -> Result<HttpResponse, String> {
    let method = check_method(method)?;
    let url = check_url(raw_url, Kind::Http)?;

    if let Some(b) = &body {
        if b.len() > MAX_REQUEST_BODY {
            return Err(format!(
                "request body of {} bytes exceeds the {MAX_REQUEST_BODY} byte cap",
                b.len()
            ));
        }
    }

    let verb = reqwest::Method::from_bytes(method.as_bytes())
        .map_err(|e| format!("bad method {method:?}: {e}"))?;
    let mut req = client.request(verb, url.clone());
    if let Some(b) = body {
        req = req.header("content-type", "application/json").body(b);
    }

    let res = req
        .send()
        .await
        .map_err(|e| format!("Bisq node unreachable at {url} ({method}): {e}"))?;
    let status = res.status().as_u16();

    // Stream so an oversized body is abandoned rather than buffered whole.
    let mut buf: Vec<u8> = Vec::new();
    let mut stream = res.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| format!("error reading response body: {e}"))?;
        if buf.len() + chunk.len() > MAX_RESPONSE_BODY {
            return Err(format!(
                "response body exceeds the {MAX_RESPONSE_BODY} byte cap"
            ));
        }
        buf.extend_from_slice(&chunk);
    }

    Ok(HttpResponse {
        status,
        body: String::from_utf8_lossy(&buf).into_owned(),
    })
}

/// The one WebSocket type this app ever holds. `MaybeTlsStream` is
/// tokio-tungstenite's return type; with no TLS features enabled its only
/// inhabitable variant is the plaintext one.
pub type BisqWs = tokio_tungstenite::WebSocketStream<
    tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
>;

/// Check, then connect. Kept next to the checks so no caller can skip them.
pub async fn ws_connect(raw_url: &str) -> Result<BisqWs, String> {
    let target = check_url(raw_url, Kind::Ws)?;

    let mut cfg = tokio_tungstenite::tungstenite::protocol::WebSocketConfig::default();
    cfg.max_message_size = Some(MAX_WS_FRAME);
    cfg.max_frame_size = Some(MAX_WS_FRAME);

    let (stream, _resp) =
        tokio_tungstenite::connect_async_with_config(target.as_str(), Some(cfg), false)
            .await
            .map_err(|e| format!("Bisq WebSocket unreachable at {target}: {e}"))?;
    Ok(stream)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn http_ok(u: &str) -> bool {
        check_url(u, Kind::Http).is_ok()
    }
    fn ws_ok(u: &str) -> bool {
        check_url(u, Kind::Ws).is_ok()
    }

    #[test]
    fn accepts_the_real_bisq_endpoints() {
        assert!(http_ok("http://127.0.0.1:8090/api/v1/market-price/quotes"));
        assert!(http_ok("http://127.0.0.1:8091/api/v1/trades"));
        assert!(http_ok("http://[::1]:8090/api/v1/trades"));
        // 127.0.0.0/8 is loopback in full, not just .0.1
        assert!(http_ok("http://127.7.7.7:8090/api/v1/trades"));
        // IPv4-mapped IPv6 loopback denotes loopback
        assert!(http_ok("http://[::ffff:127.0.0.1]:8090/api/v1/trades"));
        assert!(ws_ok("ws://127.0.0.1:8090/websocket"));
    }

    #[test]
    fn refuses_non_loopback_hosts() {
        assert!(!http_ok("http://evil.example/api/v1/trades"));
        assert!(!http_ok("http://8.8.8.8/api/v1/trades"));
        // Link-local metadata service, the classic SSRF target
        assert!(!http_ok("http://169.254.169.254/api/v1/trades"));
        assert!(!http_ok("http://[::ffff:169.254.169.254]/api/v1/trades"));
        // Private ranges are still off-machine
        assert!(!http_ok("http://192.168.1.5:8090/api/v1/trades"));
        assert!(!http_ok("http://10.0.0.1:8090/api/v1/trades"));
        assert!(!http_ok("http://0.0.0.0:8090/api/v1/trades"));
    }

    #[test]
    fn refuses_hostnames_even_when_they_mean_loopback() {
        // The DNS-rebinding guard: no name is ever resolved, so "localhost"
        // goes too. The error must tell the user what to type instead.
        let err = check_url("http://localhost:8090/api/v1/trades", Kind::Http).unwrap_err();
        assert!(err.contains("127.0.0.1"), "unhelpful error: {err}");
        assert!(!http_ok("http://localhost.evil.example/api/v1/trades"));
    }

    #[test]
    fn refuses_credential_and_host_confusion() {
        assert!(!http_ok("http://127.0.0.1@evil.example/api/v1/trades"));
        assert!(!http_ok("http://user:pw@127.0.0.1:8090/api/v1/trades"));
        assert!(!http_ok("http://evil.example#127.0.0.1/api/v1/trades"));
        assert!(!http_ok("http://evil.example/api/v1/x?h=127.0.0.1"));
    }

    #[test]
    fn refuses_other_schemes() {
        // No TLS is compiled in; refusing https here makes that explicit
        // rather than leaving it to a runtime connection failure.
        assert!(!http_ok("https://127.0.0.1:8090/api/v1/trades"));
        assert!(!ws_ok("wss://127.0.0.1:8090/websocket"));
        assert!(!http_ok("file:///etc/passwd"));
        assert!(!http_ok("data:text/plain,hi"));
        // Scheme and kind must agree in both directions
        assert!(!http_ok("ws://127.0.0.1:8090/api/v1/trades"));
        assert!(!ws_ok("http://127.0.0.1:8090/websocket"));
    }

    #[test]
    fn enforces_the_path_allowlist() {
        assert!(!http_ok("http://127.0.0.1:8090/admin"));
        assert!(!http_ok("http://127.0.0.1:8090/"));
        assert!(!http_ok("http://127.0.0.1:8090/api/v2/trades"));
        // A neighbouring loopback service is reachable but can only be
        // addressed under /api/v1/, which is the point of the allowlist.
        assert!(!http_ok("http://127.0.0.1:5432/api/../admin"));
        // Traversal, resolved by the parser then caught by the prefix
        assert!(!http_ok("http://127.0.0.1:8090/api/v1/../../admin"));
        // Percent-encoded traversal, which the parser leaves intact
        assert!(!http_ok("http://127.0.0.1:8090/api/v1/%2e%2e/admin"));
        assert!(!http_ok("http://127.0.0.1:8090/api/v1/%2E%2E/admin"));
        // The WebSocket path is exact, not a prefix
        assert!(!ws_ok("ws://127.0.0.1:8090/websocket/../api"));
        assert!(!ws_ok("ws://127.0.0.1:8090/websocketx"));
    }

    #[test]
    fn query_strings_survive_the_path_check() {
        let u = check_url(
            "http://127.0.0.1:8090/api/v1/offerbook/markets/EUR/offers?x=1",
            Kind::Http,
        )
        .unwrap();
        assert_eq!(u.query(), Some("x=1"));
    }

    #[test]
    fn method_allowlist() {
        assert_eq!(check_method("get").unwrap(), "GET");
        assert_eq!(check_method("PATCH").unwrap(), "PATCH");
        for bad in ["CONNECT", "TRACE", "OPTIONS", "", "GET /x HTTP/1.1"] {
            assert!(check_method(bad).is_err(), "{bad:?} should be refused");
        }
    }
}
