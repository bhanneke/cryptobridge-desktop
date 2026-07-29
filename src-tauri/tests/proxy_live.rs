//! Live-transport tests for the loopback proxy.
//!
//! The allowlist itself is unit-tested inside `src/proxy.rs`. These tests do
//! the other half: stand up real servers on 127.0.0.1 and prove the proxy
//! actually carries an HTTP request and a WebSocket session, that a 3xx is
//! handed back rather than followed, and that the guards fire on the real call
//! path rather than only in the checker.

use cryptobridge_desktop_lib::proxy;
use futures_util::{SinkExt, StreamExt};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

/// Read one whole HTTP request (headers plus any declared body).
async fn read_request(sock: &mut TcpStream) -> String {
    let mut buf = Vec::new();
    let mut tmp = [0u8; 4096];
    loop {
        let n = sock.read(&mut tmp).await.unwrap();
        if n == 0 {
            break;
        }
        buf.extend_from_slice(&tmp[..n]);
        let text = String::from_utf8_lossy(&buf).to_string();
        if let Some(end) = text.find("\r\n\r\n") {
            let len = text[..end]
                .lines()
                .find_map(|l| {
                    let (k, v) = l.split_once(':')?;
                    k.eq_ignore_ascii_case("content-length")
                        .then(|| v.trim().parse::<usize>().ok())?
                })
                .unwrap_or(0);
            if buf.len() >= end + 4 + len {
                break;
            }
        }
    }
    String::from_utf8_lossy(&buf).to_string()
}

/// Serve one canned HTTP response; hand back whatever the client sent.
async fn serve_once(response: &'static str) -> (u16, tokio::task::JoinHandle<String>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let handle = tokio::spawn(async move {
        let (mut sock, _) = listener.accept().await.unwrap();
        let request = read_request(&mut sock).await;
        sock.write_all(response.as_bytes()).await.unwrap();
        sock.flush().await.unwrap();
        request
    });
    (port, handle)
}

#[tokio::test]
async fn carries_a_real_http_request_and_response() {
    let body = r#"{"ok":true,"quote":57201.62}"#;
    let response: &'static str = Box::leak(
        format!(
            "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{}",
            body.len(),
            body
        )
        .into_boxed_str(),
    );
    let (port, server) = serve_once(response).await;

    let client = proxy::build_client();
    let res = proxy::http_request(
        &client,
        "POST",
        &format!("http://127.0.0.1:{port}/api/v1/trades"),
        Some(r#"{"offerId":"x"}"#.to_string()),
    )
    .await
    .expect("request should succeed");

    assert_eq!(res.status, 200);
    assert_eq!(res.body, body);

    let seen = server.await.unwrap();
    assert!(seen.starts_with("POST /api/v1/trades HTTP/1.1"), "{seen}");
    assert!(seen.to_lowercase().contains("content-type: application/json"), "{seen}");
    assert!(seen.ends_with(r#"{"offerId":"x"}"#), "{seen}");
}

#[tokio::test]
async fn hands_back_error_statuses_instead_of_throwing() {
    // The adapter turns >= 300 into an Error itself and wants the status and
    // body to do it, so the proxy must not swallow them.
    let (port, _server) =
        serve_once("HTTP/1.1 404 Not Found\r\ncontent-length: 9\r\nconnection: close\r\n\r\nno trade!")
            .await;

    let client = proxy::build_client();
    let res = proxy::http_request(
        &client,
        "GET",
        &format!("http://127.0.0.1:{port}/api/v1/trades/nope"),
        None,
    )
    .await
    .expect("a 404 is a response, not a transport failure");

    assert_eq!(res.status, 404);
    assert_eq!(res.body, "no trade!");
}

#[tokio::test]
async fn does_not_follow_redirects_off_loopback() {
    // Following this would take the proxy straight off the machine, which is
    // exactly what the allowlist exists to prevent — so the 302 comes back raw.
    let (port, _server) = serve_once(
        "HTTP/1.1 302 Found\r\nlocation: http://evil.example/steal\r\ncontent-length: 0\r\nconnection: close\r\n\r\n",
    )
    .await;

    let client = proxy::build_client();
    let res = proxy::http_request(
        &client,
        "GET",
        &format!("http://127.0.0.1:{port}/api/v1/market-price/quotes"),
        None,
    )
    .await
    .expect("the redirect should be returned, not followed");

    assert_eq!(res.status, 302, "redirect must not be followed");
    assert!(res.body.is_empty());
}

#[tokio::test]
async fn guards_fire_on_the_real_call_path() {
    let client = proxy::build_client();

    // A hostname that genuinely resolves to loopback is still refused, and the
    // error has to tell the user what to type instead.
    let err = proxy::http_request(&client, "GET", "http://localhost:8090/api/v1/trades", None)
        .await
        .expect_err("hostnames are refused");
    assert!(err.contains("127.0.0.1"), "unhelpful error: {err}");

    for (method, url) in [
        ("GET", "https://127.0.0.1:8090/api/v1/trades"),
        ("GET", "http://169.254.169.254/api/v1/meta"),
        ("GET", "http://127.0.0.1:8090/admin"),
        ("CONNECT", "http://127.0.0.1:8090/api/v1/trades"),
    ] {
        assert!(
            proxy::http_request(&client, method, url, None).await.is_err(),
            "{method} {url} should have been refused"
        );
    }
}

#[tokio::test]
async fn carries_a_websocket_session() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();

    // Server: greet, then echo one frame back — enough to prove both directions.
    let server = tokio::spawn(async move {
        let (sock, _) = listener.accept().await.unwrap();
        let mut ws = tokio_tungstenite::accept_async(sock).await.unwrap();
        ws.send(tokio_tungstenite::tungstenite::Message::Text("hello".into()))
            .await
            .unwrap();
        let got = ws.next().await.unwrap().unwrap();
        ws.send(tokio_tungstenite::tungstenite::Message::Text(
            format!("echo:{}", got.into_text().unwrap()).into(),
        ))
        .await
        .unwrap();
    });

    let mut ws = proxy::ws_connect(&format!("ws://127.0.0.1:{port}/websocket"))
        .await
        .expect("websocket should connect");

    let greeting = ws.next().await.unwrap().unwrap();
    assert_eq!(greeting.into_text().unwrap().as_str(), "hello");

    let subscribe = r#"{"type":"SubscriptionRequest","topic":"TRADE_PROPERTIES"}"#;
    ws.send(tokio_tungstenite::tungstenite::Message::Text(subscribe.into()))
        .await
        .unwrap();

    let echoed = ws.next().await.unwrap().unwrap();
    assert_eq!(echoed.into_text().unwrap().as_str(), format!("echo:{subscribe}"));

    server.await.unwrap();
}

/// Drives the proxy against a *real* Bisq 2 node, the way the shell will.
/// Skipped unless a node is pointed at, mirroring tests/bisq-adapter.contract.js:
///
///   BISQ_API_URL=http://127.0.0.1:8090/api/v1 cargo test -- --nocapture live_bisq
#[tokio::test]
async fn live_bisq_node_speaks_through_the_proxy() {
    let Ok(base) = std::env::var("BISQ_API_URL") else {
        eprintln!("skipping live_bisq: set BISQ_API_URL to run this against a node");
        return;
    };
    let base = base.trim_end_matches('/').to_string();

    let client = proxy::build_client();
    let res = proxy::http_request(&client, "GET", &format!("{base}/market-price/quotes"), None)
        .await
        .expect("the node should answer through the proxy");
    assert_eq!(res.status, 200, "body: {}", res.body);
    assert!(
        res.body.contains("BTC/EUR") || res.body.contains("quotes"),
        "unexpected quote payload: {}",
        res.body
    );

    // Same origin, WebSocket endpoint: ws://host:port/websocket
    let origin = base
        .strip_prefix("http://")
        .expect("BISQ_API_URL should be plaintext loopback")
        .split('/')
        .next()
        .unwrap();
    let mut ws = proxy::ws_connect(&format!("ws://{origin}/websocket"))
        .await
        .expect("the node's WebSocket should accept the proxy");

    // The "type" discriminator is required or the server silently drops it.
    ws.send(tokio_tungstenite::tungstenite::Message::Text(
        r#"{"type":"SubscriptionRequest","requestId":"rust-probe","topic":"TRADE_PROPERTIES","parameter":null}"#.into(),
    ))
    .await
    .unwrap();

    let frame = tokio::time::timeout(std::time::Duration::from_secs(15), ws.next())
        .await
        .expect("the node should answer the subscription within 15s")
        .expect("stream ended")
        .expect("frame error");
    let text = frame.into_text().unwrap();
    assert!(
        text.contains("TRADE_PROPERTIES") || text.contains("SubscriptionResponse"),
        "unexpected first frame: {text}"
    );
    eprintln!("live_bisq: proxied REST + WebSocket against {base} OK");
}

#[tokio::test]
async fn websocket_path_is_allowlisted_too() {
    assert!(proxy::ws_connect("ws://127.0.0.1:8090/api/v1/trades")
        .await
        .is_err());
    assert!(proxy::ws_connect("wss://127.0.0.1:8090/websocket").await.is_err());
    assert!(proxy::ws_connect("ws://evil.example/websocket").await.is_err());
}
