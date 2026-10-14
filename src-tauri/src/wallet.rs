// Built-in wallet — key generation, storage and address derivation.
//
// Why this exists: the app used to ask the user to paste a receive address
// from some other wallet. That assumes they already have one, which the people
// this app is for do not, and it silently reused a single address across every
// trade — linking them all on-chain in a tool whose whole point is not being
// profiled.
//
// This does NOT make us a custodian. Bright line #1 says keys are generated and
// stored only on the user's device and we can never move funds. That describes
// an on-device wallet; custody means holding someone *else's* keys. Everything
// here runs locally and no key material ever leaves the machine.
//
// Three deliberate security properties, in order of how much they matter:
//
//   1. Key material never enters the webview. The JS side sees addresses and a
//      backed-up flag. The one exception is the recovery phrase during the
//      initial backup ceremony, which is unavoidable (the user has to read it)
//      and is refused once backup is confirmed -- see `reveal_mnemonic`.
//
//   2. We do not roll our own crypto. The recovery phrase lives in the OS
//      keychain (Keychain on macOS, libsecret/kwallet on Linux, Credential
//      Manager on Windows) via the `keyring` crate. Note the honest limit: a
//      generic keychain item is readable by anything running as this user. That
//      is the same exposure as an encrypted file whose key sits in the
//      keychain, with far less of our code standing between the user and their
//      money.
//
//   3. The wallet database holds no secrets. BDK does not persist descriptor
//      secret keys, so `wallet-<network>.sqlite` contains only public
//      descriptors, derivation indexes and (later) chain data. Losing that file
//      costs nothing; losing the recovery phrase costs everything. That split
//      is what the backup ceremony exists to communicate.

use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use bdk_wallet::bitcoin::bip32::Xpriv;
use bdk_wallet::bitcoin::Network;
use bdk_wallet::keys::bip39::{Language, Mnemonic, WordCount};
use bdk_wallet::keys::{GeneratableKey, GeneratedKey};
use bdk_wallet::miniscript::Segwitv0;
use bdk_wallet::{KeychainKind, Wallet};
use serde::Serialize;
use tauri::{AppHandle, Manager, Runtime, State};

/// Keychain service name. Stable across versions -- changing it orphans every
/// existing user's recovery phrase.
const KEYRING_SERVICE: &str = "io.github.bhanneke.cryptobridge";

/// BIP84 native segwit (`bc1q...`). Deliberately not taproot: every wallet and
/// exchange can pay a bech32 address today, and the counterparty paying us is a
/// stranger whose software we do not control. Taproot is the better answer once
/// that stops being a real compatibility risk.
const PURPOSE: u32 = 84;

// --- state ------------------------------------------------------------------

#[derive(Default)]
pub struct WalletState {
    /// An async mutex because the chain-sync task holds it across awaits.
    /// Locks are taken briefly -- once to build the client, then once per
    /// update -- so a sync in progress never blocks handing out an address.
    inner: tokio::sync::Mutex<Option<Loaded>>,
    /// A plain mutex: nothing awaits while this one is held.
    sync: Mutex<SyncShared>,
    control: tokio::sync::Mutex<()>,
    task: tokio::sync::Mutex<Option<tokio::task::JoinHandle<()>>>,
    scripts_changed: tokio::sync::Notify,
    scripts_ready: tokio::sync::Notify,
}

/// What the UI is told about chain sync.
#[derive(Default, Clone, Serialize)]
pub struct SyncStatus {
    pub network: Option<String>,
    /// A sync task is alive.
    pub running: bool,
    /// At least one update has been applied, so the balance means something.
    /// Until then the UI must say "not synced", never "0 BTC" -- a zero reads
    /// as "the money is gone".
    pub synced: bool,
    pub confirmed_sats: u64,
    pub pending_sats: u64,
    /// Set when sync stopped. Most often: Tor is not running.
    pub last_error: Option<String>,
}

#[derive(Default)]
struct SyncShared {
    status: SyncStatus,
    started_for: Option<Network>,
    /// Kyoto's handle for talking to the network. Present only while sync is
    /// running -- which is also the only time we can broadcast, so a send
    /// without sync says so rather than failing obscurely.
    requester: Option<bdk_kyoto::Requester>,
    /// Transactions built and shown to the user, awaiting their confirmation.
    /// Keyed by a token handed back with the preview.
    pending: std::collections::HashMap<String, PendingSend>,
    coverage: Option<(Network, Option<u32>, Option<u32>)>,
}

struct PendingSend {
    psbt: bdk_wallet::bitcoin::Psbt,
    network: Network,
}

struct Loaded {
    /// `PersistedWallet`, not `Wallet`: with a rusqlite backend BDK hands back a
    /// wrapper that knows how to write itself to `conn`. It derefs to `Wallet`,
    /// so everything else reads the same.
    wallet: bdk_wallet::PersistedWallet<bdk_wallet::rusqlite::Connection>,
    conn: bdk_wallet::rusqlite::Connection,
    network: Network,
}

impl WalletState {
    pub fn new() -> Self {
        Self::default()
    }

    fn set_sync<F: FnOnce(&mut SyncStatus)>(&self, network: Network, f: F) {
        if let Ok(mut g) = self.sync.lock() {
            if g.started_for == Some(network) {
                f(&mut g.status);
            }
        }
    }

    // Call with control held. Shutdown and join before replacing a network.
    async fn stop_sync(&self) {
        if let Ok(mut g) = self.sync.lock() {
            if let Some(r) = g.requester.take() {
                let _ = r.shutdown();
            }
            g.pending.clear();
            g.coverage = None;
            g.status.running = false;
        }
        self.scripts_ready.notify_waiters();
        if let Some(mut task) = self.task.lock().await.take() {
            if tokio::time::timeout(std::time::Duration::from_secs(5), &mut task)
                .await
                .is_err()
            {
                task.abort();
                let _ = task.await;
            }
        }
    }
}

// --- DTOs crossing the IPC boundary -----------------------------------------

#[derive(Serialize)]
pub struct WalletStatus {
    /// A wallet exists for this network and is loaded.
    pub exists: bool,
    /// The user has confirmed they wrote the recovery phrase down. Until this
    /// is true the app must not let them receive funds they cannot recover.
    pub backed_up: bool,
    pub network: String,
}

#[derive(Serialize)]
pub struct NewAddress {
    pub address: String,
    pub index: u32,
}

// --- helpers ----------------------------------------------------------------

fn parse_network(s: &str) -> Result<Network, String> {
    match s {
        "mainnet" | "bitcoin" => Ok(Network::Bitcoin),
        "testnet" => Ok(Network::Testnet),
        "signet" => Ok(Network::Signet),
        "regtest" => Ok(Network::Regtest),
        other => Err(format!("unknown network: {other}")),
    }
}

/// BIP44 coin type: 0 for mainnet, 1 for every test network.
fn coin_type(network: Network) -> u32 {
    match network {
        Network::Bitcoin => 0,
        _ => 1,
    }
}

fn keyring_entry(network: Network) -> Result<keyring::Entry, String> {
    // One phrase per network, so a regtest wallet can never be confused with a
    // mainnet one holding real money.
    keyring::Entry::new(KEYRING_SERVICE, &format!("recovery-phrase-{network}"))
        .map_err(|e| format!("keychain unavailable: {e}"))
}

fn data_dir<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("no app data dir: {e}"))?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("cannot create {}: {e}", dir.display()))?;
    Ok(dir)
}

fn db_path<R: Runtime>(app: &AppHandle<R>, network: Network) -> Result<PathBuf, String> {
    Ok(data_dir(app)?.join(format!("wallet-{network}.sqlite")))
}

fn backup_marker<R: Runtime>(app: &AppHandle<R>, network: Network) -> Result<PathBuf, String> {
    Ok(data_dir(app)?.join(format!("wallet-{network}.backed-up")))
}

/// Descriptors for a mnemonic. Returned as strings containing the xprv, so they
/// are secret: they are handed straight to BDK and never logged, persisted or
/// sent over IPC.
fn descriptors(mnemonic: &Mnemonic, network: Network) -> Result<(String, String), String> {
    let seed = mnemonic.to_seed("");
    let xprv = Xpriv::new_master(network, &seed).map_err(|e| format!("bad seed: {e}"))?;
    let coin = coin_type(network);
    Ok((
        format!("wpkh({xprv}/{PURPOSE}h/{coin}h/0h/0/*)"),
        format!("wpkh({xprv}/{PURPOSE}h/{coin}h/0h/1/*)"),
    ))
}

fn load_from_mnemonic<R: Runtime>(
    app: &AppHandle<R>,
    mnemonic: &Mnemonic,
    network: Network,
) -> Result<Loaded, String> {
    let (external, internal) = descriptors(mnemonic, network)?;
    let mut conn = bdk_wallet::rusqlite::Connection::open(db_path(app, network)?)
        .map_err(|e| format!("cannot open wallet db: {e}"))?;

    // Load if the db already has this wallet, otherwise create it. Secret keys
    // are not in the db, which is exactly why they have to be supplied here.
    let loaded = Wallet::load()
        .descriptor(KeychainKind::External, Some(external.clone()))
        .descriptor(KeychainKind::Internal, Some(internal.clone()))
        .extract_keys()
        .check_network(network)
        .load_wallet(&mut conn)
        .map_err(|e| format!("cannot load wallet: {e}"))?;

    let wallet = match loaded {
        Some(w) => w,
        None => Wallet::create(external, internal)
            .network(network)
            .create_wallet(&mut conn)
            .map_err(|e| format!("cannot create wallet: {e}"))?,
    };

    Ok(Loaded {
        wallet,
        conn,
        network,
    })
}

// --- commands ---------------------------------------------------------------

/// Load the wallet for `network` if one exists. Safe to call on every startup.
#[tauri::command]
pub async fn wallet_status<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, Arc<WalletState>>,
    network: String,
) -> Result<WalletStatus, String> {
    let net = parse_network(&network)?;
    let _control = state.control.lock().await;
    let switching = state.inner.lock().await.as_ref().map(|l| l.network) != Some(net);
    if switching {
        state.stop_sync().await;
    }
    let backed_up = backup_marker(&app, net)?.exists();

    let mut guard = state.inner.lock().await;
    if guard.as_ref().map(|l| l.network) != Some(net) {
        // Not loaded (or loaded for a different network). Try the keychain.
        match keyring_entry(net)?.get_password() {
            Ok(phrase) => {
                let mnemonic = Mnemonic::parse_in(Language::English, &phrase)
                    .map_err(|e| format!("stored recovery phrase is invalid: {e}"))?;
                *guard = Some(load_from_mnemonic(&app, &mnemonic, net)?);
            }
            Err(keyring::Error::NoEntry) => {
                *guard = None;
                return Ok(WalletStatus {
                    exists: false,
                    backed_up: false,
                    network,
                });
            }
            Err(e) => return Err(format!("keychain read failed: {e}")),
        }
    }

    Ok(WalletStatus {
        exists: guard.is_some(),
        backed_up,
        network,
    })
}

/// Generate a new wallet. Refuses if one already exists for this network --
/// overwriting a recovery phrase is how people lose coins, so it is never
/// something a stray call can do.
#[tauri::command]
pub async fn wallet_create<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, Arc<WalletState>>,
    network: String,
) -> Result<WalletStatus, String> {
    let net = parse_network(&network)?;
    let _control = state.control.lock().await;
    let entry = keyring_entry(net)?;

    match entry.get_password() {
        Ok(_) => return Err("a wallet already exists for this network".into()),
        Err(keyring::Error::NoEntry) => {}
        Err(e) => return Err(format!("keychain read failed: {e}")),
    }

    let generated: GeneratedKey<_, Segwitv0> =
        Mnemonic::generate((WordCount::Words12, Language::English))
            .map_err(|_| "could not generate a recovery phrase".to_string())?;
    let mnemonic: Mnemonic = generated.into_key();

    entry
        .set_password(&mnemonic.to_string())
        .map_err(|e| format!("could not save the recovery phrase: {e}"))?;

    state.stop_sync().await;
    let loaded = load_from_mnemonic(&app, &mnemonic, net)?;
    let mut guard = state.inner.lock().await;
    *guard = Some(loaded);

    Ok(WalletStatus {
        exists: true,
        backed_up: false,
        network,
    })
}

/// The recovery phrase, for the one-time backup ceremony.
///
/// Refused once backup is confirmed. That is not security theatre against an
/// attacker -- anything running as this user can read the keychain directly --
/// it is there so the phrase has exactly one moment where it crosses into the
/// webview, instead of being a button that re-exposes it forever.
#[tauri::command]
pub fn wallet_reveal_mnemonic<R: Runtime>(
    app: AppHandle<R>,
    network: String,
) -> Result<Vec<String>, String> {
    let net = parse_network(&network)?;
    if backup_marker(&app, net)?.exists() {
        return Err(
            "the recovery phrase has already been backed up and cannot be shown again".into(),
        );
    }
    let phrase = keyring_entry(net)?
        .get_password()
        .map_err(|e| format!("no recovery phrase stored: {e}"))?;
    Ok(phrase.split_whitespace().map(str::to_string).collect())
}

/// Confirm the user really wrote the phrase down, by typing it back.
#[tauri::command]
pub fn wallet_confirm_backup<R: Runtime>(
    app: AppHandle<R>,
    network: String,
    words: Vec<String>,
) -> Result<(), String> {
    let net = parse_network(&network)?;
    let stored = keyring_entry(net)?
        .get_password()
        .map_err(|e| format!("no recovery phrase stored: {e}"))?;

    let given = words
        .iter()
        .map(|w| w.trim().to_lowercase())
        .collect::<Vec<_>>()
        .join(" ");
    if given != stored.trim().to_lowercase() {
        return Err("that is not the recovery phrase -- check the words and try again".into());
    }

    std::fs::write(backup_marker(&app, net)?, b"1")
        .map_err(|e| format!("could not record the backup: {e}"))?;
    Ok(())
}

/// A fresh receive address. Called once per trade, so every trade lands on a
/// different address and they cannot be linked on-chain.
#[tauri::command]
pub async fn wallet_next_address<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, Arc<WalletState>>,
    network: String,
) -> Result<NewAddress, String> {
    let _control = state.control.lock().await;
    let net = parse_network(&network)?;

    // Receiving into a wallet the user cannot recover is the one failure that
    // is not recoverable afterwards. Refuse until the phrase is written down.
    if !backup_marker(&app, net)?.exists() {
        return Err("back up your recovery phrase before receiving bitcoin".into());
    }

    let mut guard = state.inner.lock().await;
    let loaded = guard
        .as_mut()
        .filter(|l| l.network == net)
        .ok_or("no wallet loaded for this network")?;

    let info = loaded.wallet.reveal_next_address(KeychainKind::External);
    loaded
        .wallet
        .persist(&mut loaded.conn)
        .map_err(|e| format!("could not save the new address index: {e}"))?;

    let indices = revealed_indices(&loaded.wallet);
    drop(guard);
    ensure_script_coverage(&state, net, indices).await?;
    Ok(NewAddress {
        address: info.address.to_string(),
        index: info.index,
    })
}

// --- chain sync over Tor ----------------------------------------------------
//
// Compact block filters (BIP157/158) via Kyoto: the node downloads filters and
// matches our scripts locally, so no server is ever told which addresses are
// ours. That is the whole reason for choosing this over an Esplora or Electrum
// backend, which would have to be handed the address set.
//
// Tor is not optional and there is no clearnet fallback. If the SOCKS proxy is
// not there, sync fails and says so. Quietly syncing in the clear would
// announce every address we care about to whichever peers we connected to --
// the precise leak compact block filters exist to prevent.

use crate::proxy::TOR_SOCKS;
use bdk_kyoto::bip157::Socks5Proxy;
use bdk_kyoto::builder::{Builder as KyotoBuilder, BuilderExt};
use bdk_kyoto::ScanType;

// Include every revealed receive/change address before the first filter. The
// extra gap covers unused addresses too. Restart from a conservative checkpoint
// whenever the app reveals another address: Kyoto owns a snapshot of the index.
const SCAN_LOOKAHEAD: u32 = 100;

fn scan_type(wallet: &Wallet, repaired: bool) -> ScanType {
    let checkpoint = if repaired {
        let cp = wallet
            .latest_checkpoint()
            .iter()
            .nth(7)
            .unwrap_or_else(|| wallet.latest_checkpoint().iter().last().unwrap());
        bdk_kyoto::HashCheckpoint::new(cp.height(), cp.hash())
    } else {
        // Older releases may have skipped filters. Do one full recovery even
        // if their DB claims to be synced. Never trust an unverified birthday.
        bdk_kyoto::HashCheckpoint::from_genesis(wallet.network())
    };
    ScanType::Recovery {
        used_script_index: SCAN_LOOKAHEAD,
        checkpoint,
    }
}

/// Resolve seed names inside Tor. whitelist_only is mandatory even with peers:
/// Kyoto otherwise falls back to the OS resolver when the peer list runs out.
async fn tor_peers(network: Network) -> Result<Vec<bdk_kyoto::TrustedPeer>, String> {
    let seeds: &[&str] =
        match network {
            Network::Bitcoin => &[
                "seed.bitcoin.sipa.be",
                "seed.bitcoin.sprovoost.nl",
                "dnsseed.emzy.de",
                "seed.bitcoin.wiz.biz",
            ],
            Network::Testnet => &[
                "testnet-seed.bitcoin.jonasschnelli.ch",
                "seed.testnet.bitcoin.sprovoost.nl",
            ],
            Network::Signet => &[
                "seed.signet.bitcoin.sprovoost.nl",
                "seed.signet.achownodes.xyz",
            ],
            Network::Regtest => return Err(
                "regtest sync requires CRYPTOBRIDGE_REGTEST_PEER (an IP:port reached through Tor)"
                    .into(),
            ),
            _ => return Err("unsupported Bitcoin network".into()),
        };
    let proxy: std::net::SocketAddr = TOR_SOCKS.parse().map_err(|_| "invalid Tor proxy address")?;
    let results =
        futures_util::future::join_all(seeds.iter().map(|seed| resolve_tor_seed(proxy, seed)))
            .await;
    let ips: std::collections::HashSet<_> = results.into_iter().filter_map(Result::ok).collect();
    if ips.is_empty() {
        return Err(format!(
            "could not discover Bitcoin peers through Tor at {TOR_SOCKS}"
        ));
    }
    Ok(ips
        .into_iter()
        .map(bdk_kyoto::TrustedPeer::from_ip)
        .collect())
}

async fn resolve_tor_seed(
    proxy: std::net::SocketAddr,
    seed: &str,
) -> Result<std::net::IpAddr, String> {
    let result = tokio::time::timeout(
        std::time::Duration::from_secs(30),
        tokio_socks::tcp::Socks5Stream::tor_resolve(proxy, (format!("x49.{seed}"), 0)),
    )
    .await
    .map_err(|_| "Tor name resolution timed out")?
    .map_err(|e| e.to_string())?;
    match result {
        tokio_socks::TargetAddr::Ip(addr) => Ok(addr.ip()),
        _ => Err("Tor did not return a peer IP".into()),
    }
}

#[tauri::command]
pub async fn wallet_start_sync<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, Arc<WalletState>>,
    network: String,
) -> Result<SyncStatus, String> {
    let net = parse_network(&network)?;
    let _control = state.control.lock().await;
    {
        let g = state.sync.lock().map_err(|_| "sync lock poisoned")?;
        if g.started_for == Some(net) && g.status.running {
            return Ok(g.status.clone());
        }
    }
    if state.inner.lock().await.as_ref().map(|l| l.network) != Some(net) {
        return Err("no wallet loaded for this network".into());
    }
    state.stop_sync().await;
    {
        let mut g = state.sync.lock().map_err(|_| "sync lock poisoned")?;
        g.started_for = Some(net);
        g.status = SyncStatus {
            network: Some(network),
            running: true,
            ..Default::default()
        };
    }
    let shared = Arc::clone(&state);
    *state.task.lock().await = Some(tokio::spawn(async move {
        let result = sync_loop(Arc::clone(&shared), app, net).await;
        if let Ok(mut g) = shared.sync.lock() {
            if g.started_for == Some(net) {
                if let Some(r) = g.requester.take() {
                    let _ = r.shutdown();
                }
                g.status.running = false;
                if let Err(e) = result {
                    g.status.last_error = Some(e);
                }
            }
        }
        shared.scripts_ready.notify_waiters();
    }));
    let g = state.sync.lock().map_err(|_| "sync lock poisoned")?;
    Ok(g.status.clone())
}

#[tauri::command]
pub fn wallet_sync_status(
    state: State<'_, Arc<WalletState>>,
    network: String,
) -> Result<SyncStatus, String> {
    let net = parse_network(&network)?;
    let g = state.sync.lock().map_err(|_| "sync lock poisoned")?;
    Ok(if g.started_for == Some(net) {
        g.status.clone()
    } else {
        SyncStatus {
            network: Some(network),
            ..Default::default()
        }
    })
}

async fn sync_loop<R: Runtime>(
    state: Arc<WalletState>,
    app: AppHandle<R>,
    network: Network,
) -> Result<(), String> {
    let peers = if network == Network::Regtest {
        let addr: std::net::SocketAddr = std::env::var("CRYPTOBRIDGE_REGTEST_PEER")
            .map_err(|_| "set CRYPTOBRIDGE_REGTEST_PEER to an IP:port for the test node")?
            .parse()
            .map_err(|_| "CRYPTOBRIDGE_REGTEST_PEER must be a literal IP:port")?;
        vec![addr.into()]
    } else {
        tor_peers(network).await?
    };
    let dir = data_dir(&app)?.join(format!("chain-{network}"));
    std::fs::create_dir_all(&dir).map_err(|e| format!("cannot create chain directory: {e}"))?;
    let repaired_marker = data_dir(&app)?.join(format!("wallet-{network}.scan-v2"));
    loop {
        let (client, mut subscriber) = {
            let g = state.inner.lock().await;
            let loaded = g
                .as_ref()
                .filter(|l| l.network == network)
                .ok_or("wallet network changed")?;
            let light = KyotoBuilder::new(network)
                .socks5_proxy(Socks5Proxy::local())
                .whitelist_only()
                .add_peers(peers.clone())
                .data_dir(&dir)
                .build_with_wallet(
                    &loaded.wallet,
                    scan_type(&loaded.wallet, repaired_marker.exists()),
                )
                .map_err(|e| format!("could not build the chain client: {e}"))?;
            let (client, _, subscriber) = light.subscribe();
            let (external, internal) = revealed_indices(&loaded.wallet);
            state
                .sync
                .lock()
                .map_err(|_| "sync lock poisoned")?
                .coverage = Some((network, external, internal));
            state.scripts_ready.notify_waiters();
            (client, subscriber)
        };
        let (active, node) = client.managed_start();
        let (cancel_node, mut node_task) = spawn_owned_node(node);
        let requester = active.requester();
        state
            .sync
            .lock()
            .map_err(|_| "sync lock poisoned")?
            .requester = Some(requester.clone());
        // Running the node in this future means cancellation cannot orphan it.
        let updates = async {
            loop {
                let update = subscriber
                    .update()
                    .await
                    .map_err(|e| format!("chain sync stopped: {e}"))?;
                let mut g = state.inner.lock().await;
                let loaded = g
                    .as_mut()
                    .filter(|l| l.network == network)
                    .ok_or("wallet network changed")?;
                loaded
                    .wallet
                    .apply_update(update)
                    .map_err(|e| format!("could not apply chain update: {e}"))?;
                loaded
                    .wallet
                    .persist(&mut loaded.conn)
                    .map_err(|e| format!("could not save chain data: {e}"))?;
                std::fs::write(&repaired_marker, b"1")
                    .map_err(|e| format!("could not save scan status: {e}"))?;
                update_balance(&state, loaded);
            }
            #[allow(unreachable_code)]
            Ok::<(), String>(())
        };
        let rebroadcast = async {
            let mut interval = tokio::time::interval(std::time::Duration::from_secs(60));
            loop {
                interval.tick().await;
                let txs = {
                    let mut g = state.inner.lock().await;
                    let loaded = g
                        .as_mut()
                        .filter(|l| l.network == network)
                        .ok_or("wallet network changed")?;
                    // A previous persist may have failed after updating BDK in
                    // memory. Never broadcast that transaction until it is durable.
                    loaded
                        .wallet
                        .persist(&mut loaded.conn)
                        .map_err(|e| format!("could not save pending sends: {e}"))?;
                    loaded
                        .wallet
                        .transactions()
                        .filter(|t| {
                            !t.chain_position.is_confirmed()
                                && loaded.wallet.sent_and_received(&t.tx_node.tx).0.to_sat() > 0
                        })
                        .map(|t| t.tx_node.tx.as_ref().clone())
                        .collect::<Vec<_>>()
                };
                for tx in txs {
                    // Retrying the same signed transaction cannot create another payment.
                    let _ = tokio::time::timeout(
                        std::time::Duration::from_secs(30),
                        requester.submit_package(tx),
                    )
                    .await;
                }
            }
            #[allow(unreachable_code)]
            Ok::<(), String>(())
        };
        let result = tokio::select! {
            result = &mut node_task => Some(Err(format!("Bitcoin node stopped: {result:?}"))),
            result = updates => Some(result),
            result = rebroadcast => Some(result),
            _ = state.scripts_changed.notified() => None,
        };
        let _ = requester.shutdown();
        drop(cancel_node);
        // Await the runtime teardown before building a replacement.
        if !node_task.is_finished() {
            let _ = node_task.await;
        }
        if let Some(result) = result {
            return result;
        }
    }
}

// Kyoto 0.17 spawns peer tasks without joining them on Node::shutdown.
// Dropping this sender cancels the node; runtime teardown aborts its children.
fn spawn_owned_node(
    node: bdk_kyoto::Node,
) -> (
    tokio::sync::oneshot::Sender<()>,
    tokio::task::JoinHandle<Result<(), String>>,
) {
    let (cancel_node, stopped) = tokio::sync::oneshot::channel::<()>();
    let task = tokio::task::spawn_blocking(move || {
        let runtime = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(1)
            .enable_all()
            .build()
            .map_err(|e| e.to_string())?;
        runtime.block_on(async {
            tokio::select! {
                result = node.run() => result.map_err(|e| e.to_string()),
                _ = stopped => Ok(()),
            }
        })
    });
    (cancel_node, task)
}

fn revealed_indices(wallet: &Wallet) -> (Option<u32>, Option<u32>) {
    (
        wallet.derivation_index(KeychainKind::External),
        wallet.derivation_index(KeychainKind::Internal),
    )
}

// Do not expose a new receive/change address while an active subscriber still
// holds an older index. Otherwise it could save a tip past the first payment
// before its restart notification is processed. On timeout, no address/PSBT is
// handed to the caller, so it cannot initiate that payment through this app.
async fn ensure_script_coverage(
    state: &WalletState,
    network: Network,
    required: (Option<u32>, Option<u32>),
) -> Result<(), String> {
    state.scripts_changed.notify_one();
    let wait = async {
        loop {
            let changed = state.scripts_ready.notified();
            tokio::pin!(changed);
            changed.as_mut().enable();
            {
                let g = state.sync.lock().map_err(|_| "sync lock poisoned")?;
                if g.started_for != Some(network) || !g.status.running {
                    return Ok(());
                }
                if let Some((net, external, internal)) = g.coverage {
                    if net == network && external >= required.0 && internal >= required.1 {
                        return Ok(());
                    }
                }
            }
            changed.await;
        }
    };
    tokio::time::timeout(std::time::Duration::from_secs(40), wait)
        .await
        .map_err(|_| {
            "wallet is updating its address coverage; retry after sync reconnects".to_string()
        })?
}

fn update_balance(state: &WalletState, loaded: &Loaded) {
    let balance = loaded.wallet.balance();
    state.set_sync(loaded.network, |st| {
        st.synced = true;
        st.confirmed_sats = balance.confirmed.to_sat();
        st.pending_sats = balance.trusted_pending.to_sat() + balance.untrusted_pending.to_sat();
        st.last_error = None;
    });
}

// Persist BEFORE broadcast. An uncertain network result must never make the
// inputs spendable again. BDK restores this pending transaction after restart.
fn record_outgoing(
    loaded: &mut Loaded,
    tx: bdk_wallet::bitcoin::Transaction,
) -> Result<(), String> {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|e| format!("system clock unavailable: {e}"))?
        .as_secs();
    loaded.wallet.apply_unconfirmed_txs([(tx, now)]);
    loaded
        .wallet
        .persist(&mut loaded.conn)
        .map_err(|e| format!("could not save outgoing transaction: {e}"))?;
    Ok(())
}

// --- spending ---------------------------------------------------------------
//
// Two steps on purpose. `wallet_send_preview` builds and keeps the exact
// transaction; `wallet_send_confirm` signs and broadcasts that same one. A
// single call that rebuilt at confirm time could select different UTXOs and
// charge a different fee than the one the user agreed to. For irreversible
// money the thing you approved has to be the thing that is signed.

use bdk_wallet::bitcoin::{Address, Amount, FeeRate as BdkFeeRate};
use bdk_wallet::SignOptions;

#[derive(Serialize)]
pub struct SendPreview {
    /// Hand back to wallet_send_confirm to actually send this.
    pub token: String,
    pub address: String,
    pub amount_sats: u64,
    pub fee_sats: u64,
    pub total_sats: u64,
}

/// The lowest fee rate our peers will relay, in sat/vB. A light client cannot
/// estimate confirmation times honestly, so this is a floor, not advice.
#[tauri::command]
pub async fn wallet_fee_floor(
    state: State<'_, Arc<WalletState>>,
    network: String,
) -> Result<u64, String> {
    let net = parse_network(&network)?;
    let requester = {
        let g = state.sync.lock().map_err(|_| "sync lock poisoned")?;
        if g.started_for != Some(net) {
            return Err("wallet network is not connected".into());
        }
        g.requester.clone()
    };
    let requester = requester.ok_or("not connected to the Bitcoin network yet")?;
    let rate = requester
        .broadcast_min_feerate()
        .await
        .map_err(|e| format!("could not ask the network for a fee floor: {e}"))?;
    Ok(rate.to_sat_per_vb_ceil())
}

/// Build a transaction and show what it would cost. Signs nothing, sends
/// nothing.
#[tauri::command]
pub async fn wallet_send_preview(
    state: State<'_, Arc<WalletState>>,
    network: String,
    address: String,
    amount_sats: u64,
    fee_rate_sat_vb: u64,
) -> Result<SendPreview, String> {
    let _control = state.control.lock().await;
    let net = parse_network(&network)?;

    // Parse and network-check the destination before anything else. A valid
    // address for the wrong chain is the mistake that silently burns money.
    let parsed = address
        .trim()
        .parse::<Address<_>>()
        .map_err(|e| format!("that is not a bitcoin address: {e}"))?
        .require_network(net)
        .map_err(|_| format!("that address is not valid on {network}"))?;

    if amount_sats == 0 {
        return Err("enter an amount to send".into());
    }
    {
        let g = state.sync.lock().map_err(|_| "sync lock poisoned")?;
        if g.started_for != Some(net) || !g.status.synced {
            return Err("wait for wallet recovery to finish before sending".into());
        }
    }
    let fee_rate =
        BdkFeeRate::from_sat_per_vb(fee_rate_sat_vb).ok_or("that fee rate is not usable")?;

    let mut guard = state.inner.lock().await;
    let loaded = guard
        .as_mut()
        .filter(|l| l.network == net)
        .ok_or("no wallet loaded for this network")?;

    let psbt = build_send(loaded, parsed.script_pubkey(), amount_sats, fee_rate)?;
    let fee = psbt
        .fee()
        .map_err(|e| format!("could not work out the fee: {e}"))?
        .to_sat();
    let indices = revealed_indices(&loaded.wallet);
    drop(guard);
    ensure_script_coverage(&state, net, indices).await?;

    // A token rather than an index: it is handed to the webview, and a
    // guessable handle to "sign this" is not something to leave lying around.
    let token = {
        use bdk_wallet::bitcoin::hashes::{sha256, Hash};
        let nonce: [u8; 16] = rand_bytes();
        sha256::Hash::hash(&nonce).to_string()
    };

    {
        let mut g = state.sync.lock().map_err(|_| "sync lock poisoned")?;
        // One pending send at a time: a queue of half-approved transactions is
        // a way to send the wrong one.
        g.pending.clear();
        g.pending
            .insert(token.clone(), PendingSend { psbt, network: net });
    }

    Ok(SendPreview {
        token,
        address: parsed.to_string(),
        amount_sats,
        fee_sats: fee,
        total_sats: amount_sats.saturating_add(fee),
    })
}

fn build_send(
    loaded: &mut Loaded,
    destination: bdk_wallet::bitcoin::ScriptBuf,
    amount_sats: u64,
    fee_rate: BdkFeeRate,
) -> Result<bdk_wallet::bitcoin::Psbt, String> {
    let mut builder = loaded.wallet.build_tx();
    builder
        .add_recipient(destination, Amount::from_sat(amount_sats))
        .fee_rate(fee_rate);
    let psbt = builder
        .finish()
        .map_err(|e| format!("could not build the transaction: {e}"))?;
    loaded
        .wallet
        .persist(&mut loaded.conn)
        .map_err(|e| format!("could not save change address: {e}"))?;
    Ok(psbt)
}

/// Sign and broadcast the transaction the user was shown.
#[tauri::command]
pub async fn wallet_send_confirm(
    state: State<'_, Arc<WalletState>>,
    token: String,
) -> Result<String, String> {
    // Take it out: a token is single-use, so a double-click cannot pay twice.
    let pending = {
        let mut g = state.sync.lock().map_err(|_| "sync lock poisoned")?;
        g.pending.remove(&token)
    };
    let mut pending = pending.ok_or("that transaction has expired — build it again")?;

    let requester = {
        let g = state.sync.lock().map_err(|_| "sync lock poisoned")?;
        if g.started_for != Some(pending.network) {
            return Err("wallet network is not connected".into());
        }
        g.requester.clone()
    };
    let requester = requester
        .ok_or("not connected to the Bitcoin network — cannot broadcast (is tor running?)")?;

    let tx = {
        let mut guard = state.inner.lock().await;
        let loaded = guard
            .as_mut()
            .filter(|l| l.network == pending.network)
            .ok_or("no wallet loaded for this network")?;

        let available: std::collections::HashSet<_> =
            loaded.wallet.list_unspent().map(|o| o.outpoint).collect();
        if pending
            .psbt
            .unsigned_tx
            .input
            .iter()
            .any(|i| !available.contains(&i.previous_output))
        {
            return Err(
                "transaction inputs are no longer available; review a new transaction".into(),
            );
        }
        let finished = loaded
            .wallet
            .sign(&mut pending.psbt, SignOptions::default())
            .map_err(|e| format!("could not sign: {e}"))?;
        if !finished {
            return Err("the transaction could not be fully signed".into());
        }
        let tx = pending
            .psbt
            .clone()
            .extract_tx()
            .map_err(|e| format!("could not finalise the transaction: {e}"))?;
        record_outgoing(loaded, tx.clone())?;
        update_balance(&state, loaded);
        tx
    };

    let txid = tx.compute_txid();
    match tokio::time::timeout(std::time::Duration::from_secs(30), requester.submit_package(tx)).await {
        Ok(Ok(_)) => {},
        _ => return Err(format!("Transaction {txid} is saved, but broadcast is unconfirmed. It will be retried when connected. Do not create a replacement payment.")),
    }
    Ok(txid.to_string())
}

/// 16 random bytes from the OS.
fn rand_bytes() -> [u8; 16] {
    use bdk_wallet::bitcoin::key::rand::RngCore;
    let mut b = [0u8; 16];
    bdk_wallet::bitcoin::key::rand::thread_rng().fill_bytes(&mut b);
    b
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The official BIP84 test mnemonic.
    const TEST_MNEMONIC: &str = "abandon abandon abandon abandon abandon abandon \
                                 abandon abandon abandon abandon abandon about";

    fn wallet_for(phrase: &str, network: Network) -> Wallet {
        let mnemonic = Mnemonic::parse_in(Language::English, phrase).unwrap();
        let (ext, int) = descriptors(&mnemonic, network).unwrap();
        Wallet::create(ext, int)
            .network(network)
            .create_wallet_no_persist()
            .unwrap()
    }

    /// The test that matters most in this file.
    ///
    /// If the derivation path is wrong, everything still *works* -- the wallet
    /// hands out valid addresses and receives coins -- but the recovery phrase
    /// will not find those coins in Sparrow, Blue Wallet or anything else,
    /// because they look at m/84'/0'/0'. The user would be told to write down
    /// twelve words that cannot recover their money. Nothing in normal use
    /// would reveal it. So we check against the published spec vectors, not
    /// against ourselves.
    #[test]
    fn matches_bip84_published_vectors() {
        let mut w = wallet_for(TEST_MNEMONIC, Network::Bitcoin);

        assert_eq!(
            w.reveal_next_address(KeychainKind::External)
                .address
                .to_string(),
            "bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu",
            "m/84'/0'/0'/0/0 does not match BIP84"
        );
        assert_eq!(
            w.reveal_next_address(KeychainKind::External)
                .address
                .to_string(),
            "bc1qnjg0jd8228aq7egyzacy8cys3knf9xvrerkf9g",
            "m/84'/0'/0'/0/1 does not match BIP84"
        );
        assert_eq!(
            w.reveal_next_address(KeychainKind::Internal)
                .address
                .to_string(),
            "bc1q8c6fshw2dlwun7ekn9qwf37cu2rn755upcp6el",
            "m/84'/0'/0'/1/0 (change) does not match BIP84"
        );
    }

    /// Every trade must land somewhere new, or they are trivially linked
    /// on-chain -- the exact flaw the built-in wallet exists to remove.
    #[test]
    fn each_revealed_address_is_fresh() {
        let mut w = wallet_for(TEST_MNEMONIC, Network::Bitcoin);
        let mut seen = std::collections::HashSet::new();
        for _ in 0..25 {
            let a = w
                .reveal_next_address(KeychainKind::External)
                .address
                .to_string();
            assert!(seen.insert(a), "an address was handed out twice");
        }
    }

    /// Receive and change keychains must never collide.
    #[test]
    fn receive_and_change_are_separate_chains() {
        let mut w = wallet_for(TEST_MNEMONIC, Network::Bitcoin);
        let recv = w
            .reveal_next_address(KeychainKind::External)
            .address
            .to_string();
        let change = w
            .reveal_next_address(KeychainKind::Internal)
            .address
            .to_string();
        assert_ne!(recv, change);
    }

    /// Test networks use coin type 1. Sharing coin type 0 would mean a regtest
    /// wallet and a mainnet wallet derive the same keys.
    #[test]
    fn test_networks_use_a_different_coin_type() {
        assert_eq!(coin_type(Network::Bitcoin), 0);
        for n in [Network::Testnet, Network::Signet, Network::Regtest] {
            assert_eq!(coin_type(n), 1, "{n} should use coin type 1");
        }
        let (main_ext, _) = descriptors(
            &Mnemonic::parse_in(Language::English, TEST_MNEMONIC).unwrap(),
            Network::Bitcoin,
        )
        .unwrap();
        let (test_ext, _) = descriptors(
            &Mnemonic::parse_in(Language::English, TEST_MNEMONIC).unwrap(),
            Network::Testnet,
        )
        .unwrap();
        assert_ne!(main_ext, test_ext);
    }

    #[test]
    fn network_names_parse_and_bad_ones_are_refused() {
        assert_eq!(parse_network("mainnet").unwrap(), Network::Bitcoin);
        assert_eq!(parse_network("bitcoin").unwrap(), Network::Bitcoin);
        assert_eq!(parse_network("regtest").unwrap(), Network::Regtest);
        assert!(parse_network("").is_err());
        assert!(parse_network("Mainnet").is_err());
        assert!(parse_network("dogecoin").is_err());
    }

    /// Descriptors carry the xprv, so they must never be logged or returned
    /// over IPC. This pins the shape so a refactor cannot quietly emit an xpub
    /// wallet (which could not sign) or leak the secret somewhere new.
    #[test]
    fn descriptors_are_bip84_and_contain_the_secret_key() {
        let mnemonic = Mnemonic::parse_in(Language::English, TEST_MNEMONIC).unwrap();
        let (ext, int) = descriptors(&mnemonic, Network::Bitcoin).unwrap();
        for d in [&ext, &int] {
            assert!(d.starts_with("wpkh("), "not native segwit: {d}");
            assert!(d.contains("xprv"), "descriptor lost its secret key");
            assert!(d.contains("/84h/0h/0h/"), "wrong derivation path: {d}");
        }
        assert!(ext.ends_with("/0/*)"));
        assert!(int.ends_with("/1/*)"));
    }
}

#[cfg(test)]
#[path = "wallet_regtest.rs"]
mod regtest_tests;
