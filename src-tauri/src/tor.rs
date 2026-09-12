// Supervising Tor.
//
// The wallet cannot report a balance without it. Chain sync goes through a
// SOCKS proxy on 127.0.0.1:9050 and there is deliberately no clearnet
// fallback, because falling back would announce every address we care about
// to whichever peers we reached -- the exact leak compact block filters exist
// to prevent. So "no Tor" currently means "no balance", and until now the app
// could only report that, not fix it.
//
// The same rule as the node supervisor applies and for the same reason: the
// webview cannot name the binary to run. Discovery only, from a fixed list.
//
// We never start a second Tor. If something already answers on the SOCKS
// port -- a system daemon, Tor Browser, the user's own setup -- that is the
// one we use. Starting another would fight it for the port and leave the user
// with two.

use std::net::{SocketAddr, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Manager, Runtime, State};

/// Where chain sync and the onion proxy both expect to find it.
pub const SOCKS_ADDR: &str = "127.0.0.1:9050";

#[derive(Default)]
pub struct TorState {
    child: Mutex<Option<Child>>,
}

impl TorState {
    pub fn new() -> Self {
        Self::default()
    }
}

#[derive(Serialize)]
pub struct TorStatus {
    /// A tor binary was found that we could start.
    pub installed: bool,
    /// Something is answering on the SOCKS port -- ours or somebody else's.
    pub socks_ready: bool,
    /// We started it, as opposed to finding it already running.
    pub ours: bool,
    pub pid: Option<u32>,
    /// What to do next, in the user's words. Empty when nothing is wrong.
    pub detail: String,
}

pub fn socks_is_up() -> bool {
    SOCKS_ADDR
        .parse::<SocketAddr>()
        .ok()
        .and_then(|a| TcpStream::connect_timeout(&a, Duration::from_millis(400)).ok())
        .is_some()
}

/// Only ever a file called `tor`. This is the one place we decide what to run.
fn is_tor_binary(p: &Path) -> bool {
    p.file_name()
        .and_then(|n| n.to_str())
        .is_some_and(|n| n == "tor" || n == "tor.exe")
        && p.is_file()
}

fn find_tor<R: Runtime>(app: &AppHandle<R>) -> Option<PathBuf> {
    // A bundled tor wins: it is the build we tested against.
    if let Ok(res) = app.path().resource_dir() {
        // The bundler keeps the staging directory's name, so a file staged
        // at src-tauri/resources/tor/tor arrives at
        // <resource_dir>/resources/tor/tor -- not <resource_dir>/tor/tor.
        // Checked against a real build; the shorter path finds nothing.
        for candidate in [
            res.join("resources").join("tor").join("tor"),
            res.join("tor").join("tor"),
        ] {
            if is_tor_binary(&candidate) {
                return Some(candidate);
            }
        }
    }
    if let Ok(p) = std::env::var("CRYPTOBRIDGE_TOR") {
        let p = PathBuf::from(p);
        if is_tor_binary(&p) {
            return Some(p);
        }
    }
    [
        "/opt/homebrew/bin/tor",
        "/usr/local/bin/tor",
        "/usr/bin/tor",
        "/usr/sbin/tor",
    ]
    .into_iter()
    .map(PathBuf::from)
    .find(|p| is_tor_binary(p))
}

fn tor_data_dir<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("no app data dir: {e}"))?
        .join("tor");
    std::fs::create_dir_all(&dir).map_err(|e| format!("cannot create {}: {e}", dir.display()))?;
    // Tor refuses to start if its data directory is group- or world-readable.
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700));
    }
    Ok(dir)
}

#[tauri::command]
pub fn tor_status<R: Runtime>(app: AppHandle<R>, state: State<'_, TorState>) -> TorStatus {
    let installed = find_tor(&app).is_some();
    let socks_ready = socks_is_up();

    let mut ours = false;
    let mut pid = None;
    if let Ok(mut guard) = state.child.lock() {
        if let Some(child) = guard.as_mut() {
            match child.try_wait() {
                Ok(None) => {
                    ours = true;
                    pid = Some(child.id());
                }
                _ => *guard = None,
            }
        }
    }

    let detail = if socks_ready {
        String::new()
    } else if installed {
        "Tor is installed but not running. Without it your wallet balance cannot be checked.".into()
    } else {
        format!("Tor is not installed. Your wallet balance is read from the Bitcoin network over Tor, so without it there is no balance. Expected a SOCKS proxy at {SOCKS_ADDR}.")
    };

    TorStatus {
        installed,
        socks_ready,
        ours,
        pid,
        detail,
    }
}

/// Start Tor, unless something is already listening on the SOCKS port.
#[tauri::command]
pub fn tor_start<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, TorState>,
) -> Result<TorStatus, String> {
    // Somebody else's Tor is still Tor. Never fight for the port.
    if socks_is_up() {
        return Ok(tor_status(app, state));
    }
    {
        let mut guard = state.child.lock().map_err(|_| "tor lock poisoned")?;
        if let Some(child) = guard.as_mut() {
            if matches!(child.try_wait(), Ok(None)) {
                drop(guard);
                return Ok(tor_status(app, state));
            }
            *guard = None;
        }
    }

    let binary = find_tor(&app).ok_or(
        "No Tor found on this computer. Install Tor, or start it yourself before checking your balance.",
    )?;
    let data_dir = tor_data_dir(&app)?;
    let log_path = data_dir.join("tor.log");
    let log = std::fs::File::create(&log_path)
        .map_err(|e| format!("cannot write {}: {e}", log_path.display()))?;
    let log_err = log
        .try_clone()
        .map_err(|e| format!("cannot open the tor log twice: {e}"))?;

    // A deliberately boring Tor: a SOCKS port on loopback and nothing else.
    // No control port, no relay, no onion service of our own -- every one of
    // those would be another way in.
    let child = Command::new(&binary)
        .arg("--SocksPort")
        .arg("9050")
        .arg("--DataDirectory")
        .arg(&data_dir)
        .arg("--ClientOnly")
        .arg("1")
        .arg("--AvoidDiskWrites")
        .arg("1")
        .stdout(Stdio::from(log))
        .stderr(Stdio::from(log_err))
        .stdin(Stdio::null())
        .spawn()
        .map_err(|e| format!("could not start Tor: {e}"))?;

    *state.child.lock().map_err(|_| "tor lock poisoned")? = Some(child);

    // Bootstrapping a circuit takes a few seconds; wait a little so the UI can
    // say something true rather than "not running" a moment after starting it.
    let deadline = Instant::now() + Duration::from_secs(20);
    while Instant::now() < deadline && !socks_is_up() {
        std::thread::sleep(Duration::from_millis(250));
    }
    Ok(tor_status(app, state))
}

/// Stop only a Tor we started. A user's own daemon is not ours to kill.
#[tauri::command]
pub fn tor_stop<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, TorState>,
) -> Result<TorStatus, String> {
    {
        let mut guard = state.child.lock().map_err(|_| "tor lock poisoned")?;
        if let Some(mut child) = guard.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
    Ok(tor_status(app, state))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The one place this module decides what to execute.
    #[test]
    fn only_a_file_called_tor_is_ever_executable() {
        let dir = std::env::temp_dir().join(format!("cb-tor-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();

        let good = dir.join("tor");
        std::fs::write(&good, b"#!/bin/sh\n").unwrap();
        assert!(is_tor_binary(&good));

        for name in ["sh", "bash", "torify", "tor-evil", "nottor", "Tor"] {
            let p = dir.join(name);
            std::fs::write(&p, b"#!/bin/sh\n").unwrap();
            assert!(!is_tor_binary(&p), "would have executed {name}");
        }

        let as_dir = dir.join("nested").join("tor");
        std::fs::create_dir_all(&as_dir).unwrap();
        assert!(!is_tor_binary(&as_dir), "a directory is not a program");
        assert!(!is_tor_binary(&dir.join("missing").join("tor")));

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// An override has to point at something real and correctly named.
    #[test]
    fn a_bogus_override_is_ignored() {
        let app = tauri::test::mock_app();
        std::env::set_var("CRYPTOBRIDGE_TOR", "/bin/sh");
        assert_ne!(
            find_tor(app.handle()).as_deref(),
            Some(Path::new("/bin/sh")),
            "an override pointing at a shell was accepted"
        );
        std::env::remove_var("CRYPTOBRIDGE_TOR");
    }
}
