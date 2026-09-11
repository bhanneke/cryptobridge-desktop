// Supervising the Bisq node.
//
// The app is a front end for a Bisq node, and until now it expected the user
// to have started one from a terminal. That is why exactly one person could
// use it. This starts and stops the node for them.
//
// Scope, stated plainly: this supervises an installation that is already on
// the machine. Shipping one is a separate job -- Bisq's api-app is ~91 MB of
// jars driven by a shell script and needs a JDK, and chain sync needs a tor
// daemon. Until those are bundled, the honest behaviour is to find what is
// there, start it properly, and say exactly what is missing when something is
// not.
//
// SECURITY: the webview cannot name the binary to run.
//
// A command that took a path from JS and executed it would be remote code
// execution wearing a helpful hat -- the webview renders remote-ish content
// (a seller's account text, offer data) and the whole point of the proxy
// module is that it is never trusted. So the path is discovered from a fixed
// list of locations plus one environment variable read from the process we
// are already running in. JS can ask us to start "the node"; it cannot say
// which file that is.

use std::net::{SocketAddr, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Manager, State};

/// Where Tor's SOCKS port is expected. Matches the proxy module and Kyoto.
const TOR_SOCKS: &str = "127.0.0.1:9050";

/// The loopback port we ask the node to serve its API on.
const API_PORT: u16 = 8090;

#[derive(Default)]
pub struct NodeState {
    child: Mutex<Option<Child>>,
}

impl NodeState {
    pub fn new() -> Self {
        Self::default()
    }
}

#[derive(Serialize)]
pub struct NodeStatus {
    /// A Bisq api-app was found on this machine.
    pub installed: bool,
    /// A Java runtime was found to run it with.
    pub java: bool,
    /// Something is listening on Tor's SOCKS port.
    pub tor: bool,
    /// We started a node and it is still alive.
    pub running: bool,
    pub pid: Option<u32>,
    /// Where the API will be once it is up.
    pub api_url: String,
    /// What the user should do next, in their words. Empty when nothing is
    /// wrong.
    pub detail: String,
}

// --- discovery --------------------------------------------------------------

/// Candidate locations for Bisq's api-app launcher, most specific first.
///
/// CRYPTOBRIDGE_BISQ_APP is read from our own environment, not from the
/// webview: it is for developers running from a checkout, and setting it
/// requires access the webview does not have.
fn find_node_binary() -> Option<PathBuf> {
    if let Ok(p) = std::env::var("CRYPTOBRIDGE_BISQ_APP") {
        let p = PathBuf::from(p);
        if is_node_binary(&p) {
            return Some(p);
        }
    }
    let home = std::env::var("HOME").unwrap_or_default();
    let candidates = [
        // A future bundled sidecar lands beside the executable.
        std::env::current_exe()
            .ok()
            .and_then(|e| e.parent().map(|d| d.join("api-app"))),
        Some(PathBuf::from("/Applications/Bisq2.app/Contents/MacOS/api-app")),
        Some(PathBuf::from(format!("{home}/.local/share/bisq2/bin/api-app"))),
        Some(PathBuf::from("/usr/local/bin/api-app")),
        Some(PathBuf::from("/opt/bisq2/bin/api-app")),
    ];
    candidates.into_iter().flatten().find(|p| is_node_binary(p))
}

/// Only ever a file named api-app. Narrow on purpose: this is the one place
/// the app decides what to execute.
fn is_node_binary(p: &Path) -> bool {
    p.file_name()
        .and_then(|n| n.to_str())
        .is_some_and(|n| n == "api-app" || n == "api-app.bat")
        && p.is_file()
}

/// A Java runtime to run it with. Bisq's launcher honours JAVA_HOME.
fn find_java_home() -> Option<PathBuf> {
    if let Ok(p) = std::env::var("JAVA_HOME") {
        let p = PathBuf::from(p);
        if p.join("bin").join("java").is_file() {
            return Some(p);
        }
    }
    if let Ok(p) = std::env::var("CRYPTOBRIDGE_JAVA_HOME") {
        let p = PathBuf::from(p);
        if p.join("bin").join("java").is_file() {
            return Some(p);
        }
    }
    None
}

fn tor_is_up() -> bool {
    TOR_SOCKS
        .parse::<SocketAddr>()
        .ok()
        .and_then(|a| TcpStream::connect_timeout(&a, Duration::from_millis(400)).ok())
        .is_some()
}

fn node_data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("no app data dir: {e}"))?
        .join("bisq-node");
    std::fs::create_dir_all(&dir).map_err(|e| format!("cannot create {}: {e}", dir.display()))?;
    Ok(dir)
}

// --- commands ---------------------------------------------------------------

#[tauri::command]
pub fn node_status(state: State<'_, NodeState>) -> NodeStatus {
    let binary = find_node_binary();
    let java = find_java_home();
    let tor = tor_is_up();

    // reap: a child that exited should not still read as running
    let mut running = false;
    let mut pid = None;
    if let Ok(mut guard) = state.child.lock() {
        if let Some(child) = guard.as_mut() {
            match child.try_wait() {
                Ok(None) => {
                    running = true;
                    pid = Some(child.id());
                }
                _ => *guard = None,
            }
        }
    }

    let detail = if running {
        String::new()
    } else if binary.is_none() {
        "No Bisq node found on this computer. Install Bisq 2, or start one yourself and connect to it.".into()
    } else if java.is_none() {
        "Bisq is installed but no Java runtime was found to run it with. Set JAVA_HOME.".into()
    } else if !tor {
        format!("Tor is not running. The node can start without it, but your wallet balance cannot be checked and trade peers would see your IP. Expected a SOCKS proxy at {TOR_SOCKS}.")
    } else {
        String::new()
    };

    NodeStatus {
        installed: binary.is_some(),
        java: java.is_some(),
        tor,
        running,
        pid,
        api_url: format!("http://127.0.0.1:{API_PORT}/api/v1"),
        detail,
    }
}

/// Start a node. Idempotent: if ours is already running, this reports it
/// rather than starting a second one.
///
/// `clearnet` exists for local development against a throwaway network. It
/// defaults to false, and the app's own transport check still refuses a
/// clearnet node on mainnet, so this cannot be used to quietly trade without
/// Tor.
#[tauri::command]
pub fn node_start(
    app: AppHandle,
    state: State<'_, NodeState>,
    clearnet: Option<bool>,
) -> Result<NodeStatus, String> {
    // Check-and-reap in its own scope so the guard is gone before we borrow
    // `state` again for the status.
    let already_running = {
        let mut guard = state.child.lock().map_err(|_| "node lock poisoned")?;
        match guard.as_mut().map(|c| c.try_wait()) {
            Some(Ok(None)) => true,
            Some(_) => {
                *guard = None;
                false
            }
            None => false,
        }
    };
    if already_running {
        return Ok(node_status(state));
    }

    let binary = find_node_binary()
        .ok_or("No Bisq node found on this computer. Install Bisq 2, or start one yourself and connect to it.")?;
    let java_home = find_java_home()
        .ok_or("No Java runtime found to run Bisq with. Set JAVA_HOME.")?;

    let data_dir = node_data_dir(&app)?;
    let log_path = data_dir.join("node.log");
    let log = std::fs::File::create(&log_path)
        .map_err(|e| format!("cannot write {}: {e}", log_path.display()))?;
    let log_err = log
        .try_clone()
        .map_err(|e| format!("cannot open the node log twice: {e}"))?;

    // Tor unless explicitly told otherwise. This is the setting that decides
    // whether trade peers can see the user's IP address.
    let transport = if clearnet.unwrap_or(false) { "CLEAR" } else { "TOR" };
    let java_opts = format!(
        "-Dapplication.network.supportedTransportTypes.0={transport} \
         -Dapplication.api.accessTransportType=CLEAR \
         -Dapplication.api.server.restEnabled=true \
         -Dapplication.api.server.websocketEnabled=true \
         -Dapplication.api.server.bind.host=127.0.0.1 \
         -Dapplication.api.server.bind.port={API_PORT}"
    );

    let child = Command::new(&binary)
        .env("JAVA_HOME", &java_home)
        .env("JAVA_OPTS", java_opts)
        .arg("--app-name=cryptobridge")
        .arg(format!("--data-dir={}", data_dir.display()))
        .stdout(Stdio::from(log))
        .stderr(Stdio::from(log_err))
        .stdin(Stdio::null())
        .spawn()
        .map_err(|e| format!("could not start the Bisq node: {e}"))?;

    *state.child.lock().map_err(|_| "node lock poisoned")? = Some(child);
    Ok(node_status(state))
}

/// Stop the node we started. Never touches a node we did not start -- someone
/// running their own should not have it killed by opening this app.
#[tauri::command]
pub fn node_stop(state: State<'_, NodeState>) -> Result<NodeStatus, String> {
    {
        let mut guard = state.child.lock().map_err(|_| "node lock poisoned")?;
        if let Some(mut child) = guard.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
    Ok(node_status(state))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Discovery has to actually find a real installation, not just compile.
    /// Run against the Bisq build in the spike tree when it is present.
    #[test]
    fn discovery_finds_a_real_bisq_install_when_pointed_at_one() {
        let real = std::path::Path::new(
            "/Users/hanneke/.claude/jobs/80147ee9/tmp/bisq-spike/bisq2/apps/api-app/build/install/api-app/bin/api-app",
        );
        let jdk = std::path::Path::new("/Users/hanneke/.claude/jobs/80147ee9/tmp/bisq-spike/toolchain/jdk-21.0.11+10/Contents/Home");
        if !real.is_file() || !jdk.is_dir() {
            eprintln!("skipping: no Bisq build in the spike tree");
            return;
        }
        std::env::set_var("CRYPTOBRIDGE_BISQ_APP", real);
        std::env::set_var("CRYPTOBRIDGE_JAVA_HOME", jdk);
        assert_eq!(find_node_binary().as_deref(), Some(real), "did not find the real api-app");
        assert_eq!(find_java_home().as_deref(), Some(jdk), "did not find the real JDK");

        // And a bogus override must not be accepted just because it is set.
        std::env::set_var("CRYPTOBRIDGE_BISQ_APP", "/bin/sh");
        assert_ne!(
            find_node_binary().as_deref(),
            Some(std::path::Path::new("/bin/sh")),
            "an override pointing at a shell was accepted"
        );
        std::env::remove_var("CRYPTOBRIDGE_BISQ_APP");
        std::env::remove_var("CRYPTOBRIDGE_JAVA_HOME");
    }

    /// The one place this app decides what to execute. If it ever accepts a
    /// name other than the Bisq launcher, a path from anywhere becomes a way
    /// to run anything.
    #[test]
    fn only_a_file_called_api_app_is_ever_executable() {
        let dir = std::env::temp_dir().join(format!("cb-node-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();

        let good = dir.join("api-app");
        std::fs::write(&good, b"#!/bin/sh\n").unwrap();
        assert!(is_node_binary(&good));

        for name in ["sh", "bash", "api-app-evil", "notapi-app", "api_app", "java"] {
            let p = dir.join(name);
            std::fs::write(&p, b"#!/bin/sh\n").unwrap();
            assert!(!is_node_binary(&p), "would have executed {name}");
        }

        // A directory named api-app is not a program.
        let as_dir = dir.join("nested").join("api-app");
        std::fs::create_dir_all(&as_dir).unwrap();
        assert!(!is_node_binary(&as_dir));

        // Something that does not exist is never runnable.
        assert!(!is_node_binary(&dir.join("missing").join("api-app")));

        let _ = std::fs::remove_dir_all(&dir);
    }
}
