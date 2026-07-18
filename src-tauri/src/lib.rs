// CryptoBridge Desktop — Tauri shell.
//
// Deliberately thin: the UI is plain HTML/CSS/JS served from ../src, and all
// trading logic lives behind the JS OnrampAdapter. When the BisqAdapter
// arrives, this crate grows exactly two responsibilities: supervising the
// local Bisq daemon as a sidecar process, and proxying its localhost gRPC
// API to the webview. Until then there are no custom commands at all.

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
