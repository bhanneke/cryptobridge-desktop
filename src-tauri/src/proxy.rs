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
/// Tor adds three hops and a rendezvous; the loopback timeout would fail a
/// perfectly healthy circuit.
pub const TOR_TIMEOUT: Duration = Duration::from_secs(90);

/// Bisq 2's REST prefix. Everything the adapter calls lives under it.
pub const API_PREFIX: &str = "/api/v1/";
/// Bisq 2's single WebSocket endpoint.
pub const WS_PATH: &str = "/websocket";

const ALLOWED_METHODS: [&str; 5] = ["GET", "POST", "PUT", "PATCH", "DELETE"];

/// The only request headers the webview may set. Bisq authenticates with
/// exactly these two; allowing arbitrary headers would widen the app's single
/// hole in the CSP sandbox for no benefit.
pub const ALLOWED_HEADERS: [&str; 2] = ["bisq-client-id", "bisq-session-id"];

/// Max length of a header value we will forward.
pub const MAX_HEADER_VALUE: usize = 512;

/// Validate caller-supplied headers, returning them lower-cased.
pub fn check_headers(
    headers: Option<&std::collections::HashMap<String, String>>,
) -> Result<Vec<(String, String)>, String> {
    let mut out = Vec::new();
    let Some(map) = headers else { return Ok(out) };
    for (name, value) in map {
        let lower = name.trim().to_ascii_lowercase();
        if !ALLOWED_HEADERS.contains(&lower.as_str()) {
            return Err(format!(
                "header {name:?} is not allowed (permitted: {})",
                ALLOWED_HEADERS.join(", ")
            ));
        }
        // Control characters in a value are how header injection works.
        if value.is_empty()
            || value.len() > MAX_HEADER_VALUE
            || value.bytes().any(|b| b < 0x20 || b == 0x7f)
        {
            return Err(format!("header {name:?} has an invalid value"));
        }
        out.push((lower, value.clone()));
    }
    Ok(out)
}

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
/// Where a checked URL points. Two classes, and no third is representable.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Destination {
    /// A literal loopback IP. Reached directly; never leaves the machine.
    Loopback,
    /// A v3 onion service. Reached only through the local Tor SOCKS5 port.
    Onion,
}

/// Where Tor listens for SOCKS5. The Tor Browser bundle uses 9150; a system
/// tor daemon uses 9050. We target the daemon.
pub const TOR_SOCKS: &str = "127.0.0.1:9050";

/// v3 onion addresses are exactly 56 base32 characters (a-z, 2-7) plus
/// ".onion". Nothing else is accepted -- in particular v2 addresses (16
/// characters) are refused: they were deprecated and their cryptography is
/// not worth carrying.
///
/// Why an onion destination does not weaken this proxy: a v3 address *is* the
/// service's public key, so the connection is end-to-end encrypted and
/// authenticated by the address itself. Plaintext HTTP over it is not a
/// downgrade, which is why Bisq offers its API that way with no TLS. And
/// `.onion` is not resolvable through DNS, so the property that mattered in
/// the audit -- this proxy never performs a name lookup that could be pointed
/// off-machine -- survives intact. Tor resolves it internally, over a
/// connection to loopback.
fn check_onion_host(name: &str) -> Result<(), String> {
    let label = name
        .strip_suffix(".onion")
        .ok_or_else(|| format!("host {name:?} is not an onion address"))?;
    if label.len() != 56 {
        return Err(format!(
            "onion address {name:?} is not a v3 address (expected 56 characters before \".onion\", got {})",
            label.len()
        ));
    }
    if !label
        .bytes()
        .all(|b| b.is_ascii_lowercase() || (b'2'..=b'7').contains(&b))
    {
        return Err(format!(
            "onion address {name:?} contains characters outside base32 (a-z, 2-7)"
        ));
    }
    Ok(())
}

pub fn check_url(raw: &str, kind: Kind) -> Result<(Url, Destination), String> {
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
    let destination = match host {
        Host::Ipv4(v4) => {
            let ip = IpAddr::V4(v4);
            if !is_loopback_ip(ip) {
                return Err(format!(
                    "host {ip} is not loopback — this proxy only reaches 127.0.0.0/8 and ::1"
                ));
            }
            Destination::Loopback
        }
        Host::Ipv6(v6) => {
            let ip = IpAddr::V6(v6);
            if !is_loopback_ip(ip) {
                return Err(format!(
                    "host {ip} is not loopback — this proxy only reaches 127.0.0.0/8 and ::1"
                ));
            }
            Destination::Loopback
        }
        // The only name ever accepted, and only in this exact shape. Ordinary
        // hostnames (including "localhost") stay refused, so this proxy still
        // never performs a DNS lookup.
        Host::Domain(name) => {
            check_onion_host(name).map_err(|e| {
                format!(
                    "{e}. This proxy reaches a literal loopback IP (use 127.0.0.1) or a v3 onion service, and nothing else"
                )
            })?;
            Destination::Onion
        }
    };

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

    Ok((url, destination))
}

/// The HTTP client the commands share.
///
/// `no_proxy` matters: without it `HTTP_PROXY` in the environment could route
/// what we believe is loopback traffic through someone else's server.
/// The two clients, one per destination class. Kept apart deliberately: the
/// loopback client has `no_proxy()` so no environment variable can capture
/// traffic we believe stays on the machine, and the onion client has exactly
/// one proxy, Tor, and can reach nothing else.
pub struct Clients {
    loopback: reqwest::Client,
    /// `None` when the SOCKS proxy could not be configured; onion requests
    /// then fail with an explanation instead of silently falling back to a
    /// direct connection, which would leak the request onto the clearnet.
    onion: Option<reqwest::Client>,
}

impl Clients {
    pub fn new() -> Self {
        Self {
            loopback: build_client(),
            onion: build_onion_client(),
        }
    }

    pub fn for_destination(&self, dest: Destination) -> Result<&reqwest::Client, String> {
        match dest {
            Destination::Loopback => Ok(&self.loopback),
            Destination::Onion => self.onion.as_ref().ok_or_else(|| {
                format!("cannot reach an onion service: no Tor SOCKS proxy at {TOR_SOCKS}")
            }),
        }
    }
}

impl Default for Clients {
    fn default() -> Self {
        Self::new()
    }
}

/// A client that can *only* speak through Tor.
///
/// `socks5h` rather than `socks5`: the `h` makes Tor resolve the destination.
/// With plain `socks5` reqwest would try to resolve `.onion` locally, which
/// fails — and in the general case would be the exact DNS leak this avoids.
fn build_onion_client() -> Option<reqwest::Client> {
    let proxy = reqwest::Proxy::all(format!("socks5h://{TOR_SOCKS}")).ok()?;
    reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(TOR_TIMEOUT)
        .proxy(proxy)
        .build()
        .ok()
}

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
    clients: &Clients,
    method: &str,
    raw_url: &str,
    body: Option<String>,
    headers: Option<&std::collections::HashMap<String, String>>,
) -> Result<HttpResponse, String> {
    let method = check_method(method)?;
    let (url, dest) = check_url(raw_url, Kind::Http)?;
    let client = clients.for_destination(dest)?;
    let extra = check_headers(headers)?;

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
    for (name, value) in &extra {
        req = req.header(name.as_str(), value.as_str());
    }
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

/// Anything we can run a WebSocket over: a direct loopback TCP stream, or a
/// SOCKS5 stream through Tor. Boxed so both destinations produce one type.
pub trait WsIo: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + Send {}
impl<T: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + Send> WsIo for T {}

/// The one WebSocket type this app ever holds.
///
/// We now open the TCP connection ourselves rather than letting
/// tokio-tungstenite do it, which also removes its name resolution from the
/// picture: by this point the destination has already been checked, and the
/// socket goes exactly where the check said it would.
pub type BisqWs = tokio_tungstenite::WebSocketStream<Box<dyn WsIo>>;

/// Check, then connect. Kept next to the checks so no caller can skip them.
///
/// `headers` carries Bisq's session authentication: the node authenticates the
/// WebSocket on handshake headers with no query-string fallback, which is why
/// an authenticated node is only reachable through this shell and not from a
/// browser's WebSocket.
pub async fn ws_connect(
    raw_url: &str,
    headers: Option<&std::collections::HashMap<String, String>>,
) -> Result<BisqWs, String> {
    let (_, dest) = check_url(raw_url, Kind::Ws)?;
    let deadline = if dest == Destination::Onion {
        TOR_TIMEOUT
    } else {
        HTTP_TIMEOUT
    };
    ws_connect_with_timeout(raw_url, headers, deadline).await
}

async fn ws_connect_with_timeout(
    raw_url: &str,
    headers: Option<&std::collections::HashMap<String, String>>,
    deadline: std::time::Duration,
) -> Result<BisqWs, String> {
    tokio::time::timeout(deadline, ws_connect_inner(raw_url, headers))
        .await
        .map_err(|_| "Bisq WebSocket connection/handshake timed out".to_string())?
}

async fn ws_connect_inner(
    raw_url: &str,
    headers: Option<&std::collections::HashMap<String, String>>,
) -> Result<BisqWs, String> {
    use tokio_tungstenite::tungstenite::client::IntoClientRequest;
    use tokio_tungstenite::tungstenite::http::{HeaderName, HeaderValue};

    let (target, dest) = check_url(raw_url, Kind::Ws)?;
    let extra = check_headers(headers)?;

    let mut request = target
        .as_str()
        .into_client_request()
        .map_err(|e| format!("could not build the WebSocket request: {e}"))?;
    {
        let map = request.headers_mut();
        for (name, value) in &extra {
            let n = HeaderName::from_bytes(name.as_bytes())
                .map_err(|e| format!("bad header name {name:?}: {e}"))?;
            let v = HeaderValue::from_str(value)
                .map_err(|e| format!("bad value for header {name:?}: {e}"))?;
            map.insert(n, v);
        }
    }

    let mut cfg = tokio_tungstenite::tungstenite::protocol::WebSocketConfig::default();
    cfg.max_message_size = Some(MAX_WS_FRAME);
    cfg.max_frame_size = Some(MAX_WS_FRAME);

    // Open the socket ourselves so it goes exactly where the check said. The
    // onion branch must never fall back to a direct connection: that would
    // put a request we promised to send over Tor onto the clearnet.
    let host = target
        .host_str()
        .ok_or("WebSocket URL has no host")?
        .to_string();
    let port = target
        .port_or_known_default()
        .ok_or("WebSocket URL has no port")?;

    let io: Box<dyn WsIo> = match dest {
        Destination::Loopback => {
            let tcp = tokio::time::timeout(
                HTTP_TIMEOUT,
                tokio::net::TcpStream::connect(std::net::SocketAddr::new(
                    match target.host() {
                        Some(url::Host::Ipv4(ip)) => ip.into(),
                        Some(url::Host::Ipv6(ip)) => ip.into(),
                        _ => return Err("loopback URL must contain a literal IP".into()),
                    },
                    port,
                )),
            )
            .await
            .map_err(|_| format!("Bisq WebSocket timed out connecting to {target}"))?
            .map_err(|e| format!("Bisq WebSocket unreachable at {target}: {e}"))?;
            Box::new(tcp)
        }
        Destination::Onion => {
            let socks = tokio::time::timeout(
                TOR_TIMEOUT,
                tokio_socks::tcp::Socks5Stream::connect(TOR_SOCKS, (host.as_str(), port)),
            )
            .await
            .map_err(|_| format!("timed out building a Tor circuit to {target}"))?
            .map_err(|e| {
                format!("could not reach {target} through Tor at {TOR_SOCKS}: {e}. Is tor running?")
            })?;
            Box::new(socks)
        }
    };

    let (stream, _resp) = tokio_tungstenite::client_async_with_config(request, io, Some(cfg))
        .await
        .map_err(|e| format!("Bisq WebSocket handshake failed at {target}: {e}"))?;
    Ok(stream)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn websocket_upgrade_has_a_deadline_and_releases_the_socket() {
        use tokio::io::AsyncReadExt;
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let peer = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut request = [0; 2048];
            assert!(socket.read(&mut request).await.unwrap() > 0);
            // Deliberately never answer the HTTP Upgrade.
            assert_eq!(socket.read(&mut request).await.unwrap(), 0);
        });
        let err = ws_connect_with_timeout(
            &format!("ws://127.0.0.1:{port}/websocket"),
            None,
            std::time::Duration::from_millis(100),
        )
        .await
        .err()
        .expect("handshake must time out");
        assert!(err.contains("timed out"));
        tokio::time::timeout(std::time::Duration::from_secs(1), peer)
            .await
            .unwrap()
            .unwrap();
    }

    #[tokio::test]
    async fn websocket_connects_to_literal_ipv6_without_dns() {
        let listener = tokio::net::TcpListener::bind("[::1]:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let peer = tokio::spawn(async move {
            let (socket, _) = listener.accept().await.unwrap();
            tokio_tungstenite::accept_async(socket).await.unwrap()
        });
        let _socket = ws_connect(&format!("ws://[::1]:{port}/websocket"), None)
            .await
            .unwrap();
        let _peer = peer.await.unwrap();
    }

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
        assert_eq!(u.0.query(), Some("x=1"));
        assert_eq!(u.1, Destination::Loopback);
    }

    // ---- onion destination ------------------------------------------------

    /// A real v3 address shape: 56 base32 characters.
    const ONION: &str = "abcdefghijklmnopqrstuvwxyz234567abcdefghijklmnopqrstuvwx";

    #[test]
    fn v3_onion_addresses_are_accepted_and_marked_as_such() {
        let (_, dest) = check_url(
            &format!("http://{ONION}.onion:8090/api/v1/trades"),
            Kind::Http,
        )
        .unwrap();
        assert_eq!(dest, Destination::Onion);
        let (_, dest) = check_url(&format!("ws://{ONION}.onion:8090/websocket"), Kind::Ws).unwrap();
        assert_eq!(dest, Destination::Onion);
    }

    /// The whole point of allowing one name shape is that it is *one* shape.
    /// If ordinary hostnames slipped through here, the proxy would be
    /// performing DNS again and could be pointed anywhere.
    #[test]
    fn allowing_onion_did_not_reopen_hostnames() {
        for host in [
            "localhost",
            "evil.example",
            "bisq.local",
            "notanonion.onion.evil.example",
            "example.com.onion.co",
        ] {
            let u = format!("http://{host}:8090/api/v1/trades");
            assert!(
                check_url(&u, Kind::Http).is_err(),
                "hostname accepted: {host}"
            );
        }
    }

    #[test]
    fn v2_onion_addresses_are_refused() {
        // 16 characters: the deprecated v2 format.
        let err = check_url(
            "http://abcdefghijklmnop.onion:8090/api/v1/trades",
            Kind::Http,
        )
        .unwrap_err();
        assert!(err.contains("v3"), "unexpected error: {err}");
    }

    #[test]
    fn onion_labels_outside_base32_are_refused() {
        // 56 characters, but '1', '8', '9' and '0' are not in base32.
        let bad = "abcdefghijklmnopqrstuvwxyz234567abcdefghijklmnopqrstuv10";
        assert_eq!(bad.len(), 56);
        let err = check_url(
            &format!("http://{bad}.onion:8090/api/v1/trades"),
            Kind::Http,
        )
        .unwrap_err();
        assert!(err.contains("base32"), "unexpected error: {err}");
    }

    #[test]
    fn onion_destinations_still_obey_every_other_rule() {
        // Path allowlist.
        assert!(check_url(&format!("http://{ONION}.onion:8090/admin"), Kind::Http).is_err());
        // Scheme.
        assert!(check_url(&format!("https://{ONION}.onion:8090/api/v1/x"), Kind::Http).is_err());
        // Embedded credentials.
        assert!(check_url(
            &format!("http://u:p@{ONION}.onion:8090/api/v1/x"),
            Kind::Http
        )
        .is_err());
        // Dot segments.
        assert!(check_url(
            &format!("http://{ONION}.onion:8090/api/v1/%2e%2e/admin"),
            Kind::Http
        )
        .is_err());
    }

    /// An onion request must never be answered by the direct client: that
    /// would put traffic we promised to send over Tor onto the clearnet.
    #[test]
    fn onion_requests_never_fall_back_to_the_direct_client() {
        let clients = Clients {
            loopback: build_client(),
            onion: None, // as if Tor could not be configured
        };
        let err = clients.for_destination(Destination::Onion).unwrap_err();
        assert!(err.contains("Tor"), "unexpected error: {err}");
        assert!(clients.for_destination(Destination::Loopback).is_ok());
    }

    #[test]
    fn header_allowlist() {
        use std::collections::HashMap;

        // Nothing supplied is fine — an open node needs no headers.
        assert!(check_headers(None).unwrap().is_empty());

        let mut ok = HashMap::new();
        ok.insert("Bisq-Client-Id".to_string(), "abc".to_string());
        ok.insert("Bisq-Session-Id".to_string(), "def".to_string());
        let out = check_headers(Some(&ok)).unwrap();
        assert_eq!(out.len(), 2);
        // Normalised to lower case so the allowlist cannot be case-dodged.
        assert!(out
            .iter()
            .all(|(k, _)| k.chars().all(|c| !c.is_uppercase())));

        // Anything outside the allowlist is refused — the webview does not get
        // to choose arbitrary headers just because it can reach this proxy.
        for bad in [
            "Authorization",
            "Cookie",
            "Host",
            "X-Forwarded-For",
            "content-length",
        ] {
            let mut m = HashMap::new();
            m.insert(bad.to_string(), "x".to_string());
            assert!(check_headers(Some(&m)).is_err(), "{bad} should be refused");
        }
    }

    #[test]
    fn header_values_cannot_carry_control_characters() {
        use std::collections::HashMap;
        // CR/LF in a header value is how header injection works.
        for bad in [
            "a\r\nX-Evil: 1",
            "a\nb",
            "a\0b",
            "",
            &"x".repeat(MAX_HEADER_VALUE + 1),
        ] {
            let mut m = HashMap::new();
            m.insert("Bisq-Session-Id".to_string(), bad.to_string());
            assert!(
                check_headers(Some(&m)).is_err(),
                "{bad:?} should be refused"
            );
        }
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

#[cfg(test)]
mod connect_screen_tests {
    use super::*;

    /// The connect screen probes these two before anything is configured. If
    /// the allowlist ever stops accepting them, the packaged app silently
    /// loses its only way to reach a real node.
    #[test]
    fn the_connect_screen_probe_paths_are_allowed() {
        for p in [
            "http://127.0.0.1:8090/api/v1/settings/version",
            "http://127.0.0.1:8090/api/v1/explorer/selected",
        ] {
            assert!(check_url(p, Kind::Http).is_ok(), "probe path rejected: {p}");
        }
    }
}
