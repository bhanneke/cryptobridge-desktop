//! The contract between the webview and the shell.
//!
//! Every command here is reachable only over IPC, and the JS side names its
//! arguments in camelCase while Rust declares them in snake_case. Tauri
//! bridges that, but nothing in the unit tests proves it does for *these*
//! commands with *these* names. A mismatch does not fail to compile and does
//! not fail any test -- it fails at runtime, in front of a user, on the screen
//! where they are sending money.
//!
//! So these tests invoke each command with the exact payload `builtin-wallet.js`
//! sends and assert the failure is never a deserialization failure. Business
//! errors ("no wallet loaded for this network") are fine and expected: they
//! prove the arguments arrived and the command ran.

use std::sync::Arc;

use cryptobridge_desktop_lib::{credentials, node, wallet};
use tauri::ipc::{CallbackFn, InvokeBody};
use tauri::test::{mock_builder, mock_context, noop_assets, INVOKE_KEY};
use tauri::webview::InvokeRequest;
use tauri::{WebviewUrl, WebviewWindowBuilder};

fn app() -> tauri::App<tauri::test::MockRuntime> {
    mock_builder()
        .manage(Arc::new(wallet::WalletState::new()))
        .manage(node::NodeState::new())
        .invoke_handler(tauri::generate_handler![
            credentials::bisq_credentials_load,
            credentials::bisq_credentials_save,
            wallet::wallet_status,
            wallet::wallet_create,
            wallet::wallet_reveal_mnemonic,
            wallet::wallet_confirm_backup,
            wallet::wallet_next_address,
            wallet::wallet_sync_status,
            wallet::wallet_fee_floor,
            wallet::wallet_send_preview,
            wallet::wallet_send_confirm,
            node::node_status,
            node::node_start,
            node::node_stop,
        ])
        .build(mock_context(noop_assets()))
        .expect("failed to build the mock app")
}

fn call(cmd: &str, args: serde_json::Value) -> Result<serde_json::Value, String> {
    let app = app();
    let webview = WebviewWindowBuilder::new(&app, "main", WebviewUrl::default())
        .build()
        .expect("failed to build the webview");

    let res = tauri::test::get_ipc_response(
        &webview,
        InvokeRequest {
            cmd: cmd.into(),
            callback: CallbackFn(0),
            error: CallbackFn(1),
            url: "tauri://localhost".parse().unwrap(),
            body: InvokeBody::Json(args),
            headers: Default::default(),
            invoke_key: INVOKE_KEY.to_string(),
        },
    );
    match res {
        Ok(b) => Ok(b
            .deserialize::<serde_json::Value>()
            .unwrap_or(serde_json::Value::Null)),
        Err(v) => Err(v.to_string()),
    }
}

/// The failures that mean the wiring is broken, as opposed to the command
/// having run and disagreed with us.
fn assert_wired(cmd: &str, args: serde_json::Value) {
    match call(cmd, args) {
        Ok(_) => {}
        Err(e) => {
            let lower = e.to_lowercase();
            for bad in [
                "invalid args",
                "missing required key",
                "command not found",
                "not allowed",
                "invalid request",
            ] {
                assert!(
                    !lower.contains(bad),
                    "`{cmd}` is not wired correctly: {e}\n\
                     (this is an IPC contract failure, not a business error)"
                );
            }
        }
    }
}

#[test]
fn every_wallet_command_accepts_what_the_ui_sends() {
    // Exactly the payloads builtin-wallet.js builds.
    assert_wired("wallet_status", serde_json::json!({ "network": "signet" }));
    assert_wired(
        "wallet_reveal_mnemonic",
        serde_json::json!({ "network": "signet" }),
    );
    assert_wired(
        "wallet_confirm_backup",
        serde_json::json!({ "network": "signet", "words": ["abandon", "about"] }),
    );
    assert_wired(
        "wallet_next_address",
        serde_json::json!({ "network": "signet" }),
    );
    assert_wired(
        "wallet_sync_status",
        serde_json::json!({ "network": "signet" }),
    );
    assert_wired(
        "wallet_fee_floor",
        serde_json::json!({ "network": "signet" }),
    );
}

/// The send commands are the ones with multi-word argument names, so they are
/// where a camelCase/snake_case mismatch would actually bite -- and they are
/// the commands that move money.
#[test]
fn the_send_commands_accept_the_ui_argument_names() {
    assert_wired(
        "wallet_send_preview",
        serde_json::json!({
            "network": "signet",
            "address": "tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx",
            "amountSats": 50000,
            "feeRateSatVb": 4
        }),
    );
    assert_wired(
        "wallet_send_confirm",
        serde_json::json!({ "token": "nope" }),
    );
}

#[test]
fn the_node_commands_are_wired() {
    assert_wired("node_status", serde_json::json!({}));
    assert_wired("node_stop", serde_json::json!({}));
    // Deliberately not node_start: it would spawn a real process.
}

/// A command we never registered must not be reachable. If this ever passes
/// silently, the handler list is not the allowlist it appears to be.
#[test]
fn an_unregistered_command_is_refused() {
    let err = call("wallet_delete_everything", serde_json::json!({}))
        .expect_err("an unknown command should not succeed");
    assert!(
        err.to_lowercase().contains("not found") || err.to_lowercase().contains("not allowed"),
        "unexpected error for an unknown command: {err}"
    );
}

#[test]
fn credential_commands_accept_the_ui_payload_without_touching_the_keychain() {
    // Reject the endpoint before keychain access, but after IPC deserialization.
    assert_wired(
        "bisq_credentials_load",
        serde_json::json!({ "node": "http://example.com/api/v1" }),
    );
    assert_wired(
        "bisq_credentials_save",
        serde_json::json!({ "node": "http://example.com/api/v1", "credentials": { "clientId": "fixture", "clientSecret": "fixture" } }),
    );
}
