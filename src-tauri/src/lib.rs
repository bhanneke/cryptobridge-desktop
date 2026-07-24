// CryptoBridge Desktop — Tauri shell.
//
// The UI is plain HTML/CSS/JS served from ../src and all trading logic lives
// behind the JS OnrampAdapter. The shell owns exactly one thing: the socket to
// the user's local Bisq node.
//
// It has to, because the webview must not have one. The app's CSP keeps
// `connect-src` at `'self'`, so the BisqAdapter cannot `fetch()` or open a
// `WebSocket` to 127.0.0.1 itself; it calls the four commands below over IPC
// instead. Every one of them funnels into `proxy`, which is where the
// allowlisting lives and where anyone auditing this should start.
//
// Still outstanding: supervising the Bisq daemon as a sidecar process, and
// Bisq's pairing flow for nodes with authorizationRequired=true.

pub mod proxy;

use std::collections::HashMap;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Mutex;

use futures_util::{SinkExt, StreamExt};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::Message;

/// Every WebSocket frame reaches the webview as this one event, tagged with the
/// socket id the `bisq_ws_open` call returned.
pub const WS_EVENT: &str = "bisq-ws";

enum SockCmd {
    Send(String),
    Close,
}

/// Shell-owned network state. The webview holds only opaque socket ids.
pub struct Net {
    client: reqwest::Client,
    sockets: Mutex<HashMap<u32, mpsc::UnboundedSender<SockCmd>>>,
    next_id: AtomicU32,
}

impl Net {
    pub fn new() -> Self {
        Self {
            client: proxy::build_client(),
            sockets: Mutex::new(HashMap::new()),
            next_id: AtomicU32::new(1),
        }
    }
}

impl Default for Net {
    fn default() -> Self {
        Self::new()
    }
}

#[derive(Clone, Serialize)]
struct WsEvent {
    id: u32,
    kind: &'static str,
    data: Option<String>,
}

fn emit_ws(app: &AppHandle, id: u32, kind: &'static str, data: Option<String>) {
    // A closed window is the normal way this fails; nothing to do about it.
    let _ = app.emit(WS_EVENT, WsEvent { id, kind, data });
}

// --- Commands ---------------------------------------------------------------

#[tauri::command]
async fn bisq_http(
    state: State<'_, Net>,
    method: String,
    url: String,
    body: Option<String>,
) -> Result<proxy::HttpResponse, String> {
    proxy::http_request(&state.client, &method, &url, body).await
}

/// Opens a WebSocket and returns its id. Resolving *after* the handshake means
/// the caller cannot miss frames: nothing is emitted before it has the id.
#[tauri::command]
async fn bisq_ws_open(app: AppHandle, state: State<'_, Net>, url: String) -> Result<u32, String> {
    {
        let socks = state.sockets.lock().map_err(|_| "socket registry poisoned")?;
        if socks.len() >= proxy::MAX_SOCKETS {
            return Err(format!("too many open sockets ({} max)", proxy::MAX_SOCKETS));
        }
    }

    let stream = proxy::ws_connect(&url).await?;

    let id = state.next_id.fetch_add(1, Ordering::Relaxed);
    let (tx, rx) = mpsc::unbounded_channel();
    state
        .sockets
        .lock()
        .map_err(|_| "socket registry poisoned")?
        .insert(id, tx);

    tauri::async_runtime::spawn(pump(app, id, stream, rx));
    Ok(id)
}

#[tauri::command]
async fn bisq_ws_send(state: State<'_, Net>, id: u32, text: String) -> Result<(), String> {
    if text.len() > proxy::MAX_WS_FRAME {
        return Err(format!(
            "frame of {} bytes exceeds the {} byte cap",
            text.len(),
            proxy::MAX_WS_FRAME
        ));
    }
    let tx = {
        let socks = state.sockets.lock().map_err(|_| "socket registry poisoned")?;
        socks.get(&id).cloned()
    };
    tx.ok_or_else(|| format!("socket {id} is not open"))?
        .send(SockCmd::Send(text))
        .map_err(|_| format!("socket {id} is closing"))
}

#[tauri::command]
async fn bisq_ws_close(state: State<'_, Net>, id: u32) -> Result<(), String> {
    let tx = {
        let socks = state.sockets.lock().map_err(|_| "socket registry poisoned")?;
        socks.get(&id).cloned()
    };
    // Closing an already-closed socket is not an error worth surfacing.
    if let Some(tx) = tx {
        let _ = tx.send(SockCmd::Close);
    }
    Ok(())
}

/// Bridges one WebSocket to the webview until either end hangs up.
async fn pump(app: AppHandle, id: u32, stream: proxy::BisqWs, mut rx: mpsc::UnboundedReceiver<SockCmd>) {
    let (mut write, mut read) = stream.split();

    loop {
        tokio::select! {
            incoming = read.next() => match incoming {
                Some(Ok(Message::Text(t))) => emit_ws(&app, id, "message", Some(t.to_string())),
                // Bisq speaks JSON text; ping/pong are answered by tungstenite.
                Some(Ok(Message::Binary(_) | Message::Ping(_) | Message::Pong(_) | Message::Frame(_))) => {}
                Some(Ok(Message::Close(_))) | None => break,
                Some(Err(e)) => {
                    emit_ws(&app, id, "error", Some(e.to_string()));
                    break;
                }
            },
            cmd = rx.recv() => match cmd {
                Some(SockCmd::Send(t)) => {
                    if let Err(e) = write.send(Message::Text(t.into())).await {
                        emit_ws(&app, id, "error", Some(e.to_string()));
                        break;
                    }
                }
                // `None` means the registry entry was dropped — treat as close.
                Some(SockCmd::Close) | None => {
                    let _ = write.close().await;
                    break;
                }
            },
        }
    }

    if let Some(net) = app.try_state::<Net>() {
        if let Ok(mut socks) = net.sockets.lock() {
            socks.remove(&id);
        }
    }
    emit_ws(&app, id, "close", None);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(Net::new())
        .invoke_handler(tauri::generate_handler![
            bisq_http,
            bisq_ws_open,
            bisq_ws_send,
            bisq_ws_close
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
