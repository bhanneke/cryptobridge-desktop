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
use tauri::{AppHandle, Manager, State};

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
}

/// What the UI is told about chain sync.
#[derive(Default, Clone, Serialize)]
pub struct SyncStatus {
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

    fn set_sync<F: FnOnce(&mut SyncStatus)>(&self, f: F) {
        if let Ok(mut g) = self.sync.lock() {
            f(&mut g.status);
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

fn data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("no app data dir: {e}"))?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("cannot create {}: {e}", dir.display()))?;
    Ok(dir)
}

fn db_path(app: &AppHandle, network: Network) -> Result<PathBuf, String> {
    Ok(data_dir(app)?.join(format!("wallet-{network}.sqlite")))
}

fn backup_marker(app: &AppHandle, network: Network) -> Result<PathBuf, String> {
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

fn load_from_mnemonic(
    app: &AppHandle,
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
pub async fn wallet_status(
    app: AppHandle,
    state: State<'_, Arc<WalletState>>,
    network: String,
) -> Result<WalletStatus, String> {
    let net = parse_network(&network)?;
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
pub async fn wallet_create(
    app: AppHandle,
    state: State<'_, Arc<WalletState>>,
    network: String,
) -> Result<WalletStatus, String> {
    let net = parse_network(&network)?;
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
pub fn wallet_reveal_mnemonic(
    app: AppHandle,
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
pub fn wallet_confirm_backup(
    app: AppHandle,
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
pub async fn wallet_next_address(
    app: AppHandle,
    state: State<'_, Arc<WalletState>>,
    network: String,
) -> Result<NewAddress, String> {
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

use bdk_kyoto::bip157::Socks5Proxy;
use bdk_kyoto::builder::{Builder as KyotoBuilder, BuilderExt};
use bdk_kyoto::ScanType;
use crate::proxy::TOR_SOCKS;

/// Begin syncing in the background. Idempotent: calling it twice for the same
/// network does not start a second node.
#[tauri::command]
pub async fn wallet_start_sync(
    state: State<'_, Arc<WalletState>>,
    network: String,
) -> Result<SyncStatus, String> {
    let net = parse_network(&network)?;
    let shared: Arc<WalletState> = Arc::clone(&state);

    {
        let mut g = shared.sync.lock().map_err(|_| "sync lock poisoned")?;
        if g.started_for == Some(net) && g.status.running {
            return Ok(g.status.clone());
        }
        g.started_for = Some(net);
        g.status = SyncStatus {
            running: true,
            ..Default::default()
        };
    }

    let task_state = Arc::clone(&shared);
    tauri::async_runtime::spawn(async move {
        if let Err(e) = sync_loop(Arc::clone(&task_state), net).await {
            task_state.set_sync(|s| {
                s.running = false;
                s.last_error = Some(e);
            });
        } else {
            task_state.set_sync(|s| s.running = false);
        }
    });

    let g = shared.sync.lock().map_err(|_| "sync lock poisoned")?;
    Ok(g.status.clone())
}

/// The balance, and whether it means anything yet.
#[tauri::command]
pub fn wallet_sync_status(state: State<'_, Arc<WalletState>>) -> Result<SyncStatus, String> {
    let g = state.sync.lock().map_err(|_| "sync lock poisoned")?;
    Ok(g.status.clone())
}

async fn sync_loop(state: Arc<WalletState>, network: Network) -> Result<(), String> {
    // Build the client while holding the wallet briefly, then let go: the loop
    // below must not keep the wallet locked while waiting on the network, or
    // asking for a receive address would block until the next block.
    let (client, mut subscriber) = {
        let mut g = state.inner.lock().await;
        let loaded = g
            .as_mut()
            .filter(|l| l.network == network)
            .ok_or("no wallet loaded for this network")?;

        let light = KyotoBuilder::new(network)
            .socks5_proxy(Socks5Proxy::local())
            .build_with_wallet(&loaded.wallet, ScanType::Sync)
            .map_err(|e| format!("could not build the chain client: {e}"))?;
        let (client, _requester, subscriber) = light.subscribe();
        (client, subscriber)
    };

    client.start();

    loop {
        let update = subscriber
            .update()
            .await
            .map_err(|e| format!("chain sync stopped: {e}. Is tor running on {TOR_SOCKS}?"))?;

        let mut g = state.inner.lock().await;
        let Some(loaded) = g.as_mut().filter(|l| l.network == network) else {
            return Ok(()); // the wallet went away (network switched); stop quietly
        };
        loaded
            .wallet
            .apply_update(update)
            .map_err(|e| format!("could not apply a chain update: {e}"))?;
        loaded
            .wallet
            .persist(&mut loaded.conn)
            .map_err(|e| format!("could not save chain data: {e}"))?;

        let balance = loaded.wallet.balance();
        drop(g);

        state.set_sync(|st| {
            st.synced = true;
            st.confirmed_sats = balance.confirmed.to_sat();
            st.pending_sats =
                balance.trusted_pending.to_sat() + balance.untrusted_pending.to_sat();
            st.last_error = None;
        });
    }
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
            w.reveal_next_address(KeychainKind::External).address.to_string(),
            "bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu",
            "m/84'/0'/0'/0/0 does not match BIP84"
        );
        assert_eq!(
            w.reveal_next_address(KeychainKind::External).address.to_string(),
            "bc1qnjg0jd8228aq7egyzacy8cys3knf9xvrerkf9g",
            "m/84'/0'/0'/0/1 does not match BIP84"
        );
        assert_eq!(
            w.reveal_next_address(KeychainKind::Internal).address.to_string(),
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
            let a = w.reveal_next_address(KeychainKind::External).address.to_string();
            assert!(seen.insert(a), "an address was handed out twice");
        }
    }

    /// Receive and change keychains must never collide.
    #[test]
    fn receive_and_change_are_separate_chains() {
        let mut w = wallet_for(TEST_MNEMONIC, Network::Bitcoin);
        let recv = w.reveal_next_address(KeychainKind::External).address.to_string();
        let change = w.reveal_next_address(KeychainKind::Internal).address.to_string();
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
