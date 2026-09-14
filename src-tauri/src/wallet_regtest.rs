//! Public fixture seed only. Never reads or writes the OS keychain.
use super::*;
use bdk_wallet::bitcoin::{
    absolute, hashes::Hash, transaction, BlockHash, FeeRate, OutPoint, Transaction, TxIn, TxOut,
    Txid,
};
use bdk_wallet::chain::{BlockId, CheckPoint, ConfirmationBlockTime};

fn fixture(conn: bdk_wallet::rusqlite::Connection) -> Loaded {
    let key = Xpriv::new_master(Network::Regtest, &[42; 32]).unwrap();
    let (ext, int) = (format!("wpkh({key}/0/*)"), format!("wpkh({key}/1/*)"));
    let mut conn = conn;
    let wallet = Wallet::load()
        .descriptor(KeychainKind::External, Some(ext.clone()))
        .descriptor(KeychainKind::Internal, Some(int.clone()))
        .extract_keys()
        .check_network(Network::Regtest)
        .load_wallet(&mut conn)
        .unwrap()
        .unwrap_or_else(|| {
            Wallet::create(ext, int)
                .network(Network::Regtest)
                .create_wallet(&mut conn)
                .unwrap()
        });
    Loaded {
        wallet,
        conn,
        network: Network::Regtest,
    }
}

fn funded() -> Loaded {
    let mut loaded = fixture(bdk_wallet::rusqlite::Connection::open_in_memory().unwrap());
    let funding = Transaction {
        version: transaction::Version::TWO,
        lock_time: absolute::LockTime::ZERO,
        input: vec![TxIn {
            previous_output: OutPoint {
                txid: Txid::all_zeros(),
                vout: 1,
            },
            ..Default::default()
        }],
        output: vec![TxOut {
            value: Amount::from_sat(100_000),
            script_pubkey: loaded
                .wallet
                .reveal_next_address(KeychainKind::External)
                .script_pubkey(),
        }],
    };
    let id = funding.compute_txid();
    let tip = BlockId {
        height: 100,
        hash: BlockHash::all_zeros(),
    };
    let mut update = bdk_wallet::Update {
        chain: Some(
            CheckPoint::from_block_ids([loaded.wallet.latest_checkpoint().block_id(), tip])
                .unwrap(),
        ),
        ..Default::default()
    };
    update.tx_update.txs.push(Arc::new(funding));
    update.tx_update.anchors.insert((
        ConfirmationBlockTime {
            block_id: tip,
            confirmation_time: 1,
        },
        id,
    ));
    loaded.wallet.apply_update(update).unwrap();
    loaded.wallet.persist(&mut loaded.conn).unwrap();
    loaded
}

#[test]
fn outgoing_inputs_and_change_survive_database_reload_without_broadcast() {
    let mut loaded = funded();
    // A destination outside this wallet.
    let destination = Address::from_script(
        &bdk_wallet::bitcoin::ScriptBuf::new_p2pkh(&bdk_wallet::bitcoin::PubkeyHash::all_zeros()),
        Network::Regtest,
    )
    .unwrap();
    let mut psbt = build_send(
        &mut loaded,
        destination.script_pubkey(),
        50_000,
        FeeRate::from_sat_per_vb(2).unwrap(),
    )
    .unwrap();
    let change = loaded
        .wallet
        .derivation_index(KeychainKind::Internal)
        .unwrap();
    loaded = fixture(loaded.conn);
    assert_eq!(
        loaded.wallet.derivation_index(KeychainKind::Internal),
        Some(change),
        "preview must persist its change index"
    );
    loaded
        .wallet
        .sign(&mut psbt, SignOptions::default())
        .unwrap();
    let tx = psbt.extract_tx().unwrap();
    let spent = tx.input[0].previous_output;
    let id = tx.compute_txid();
    record_outgoing(&mut loaded, tx).unwrap();
    loaded = fixture(loaded.conn);
    assert!(
        loaded.wallet.get_tx(id).is_some(),
        "even a failed broadcast must be recoverable"
    );
    assert!(!loaded.wallet.list_unspent().any(|u| u.outpoint == spent));
    assert_eq!(loaded.wallet.balance().confirmed.to_sat(), 0);
    assert!(loaded.wallet.balance().trusted_pending.to_sat() < 50_000);
    let next = build_send(
        &mut loaded,
        destination.script_pubkey(),
        20_000,
        FeeRate::from_sat_per_vb(2).unwrap(),
    )
    .unwrap();
    assert!(next
        .unsigned_tx
        .input
        .iter()
        .all(|i| i.previous_output != spent));
    assert!(
        loaded
            .wallet
            .derivation_index(KeychainKind::Internal)
            .unwrap()
            > change
    );
}

#[test]
fn old_databases_require_a_full_scan_even_if_their_checkpoint_claims_progress() {
    let loaded = funded();
    match scan_type(&loaded.wallet, false) {
        ScanType::Recovery {
            checkpoint,
            used_script_index,
        } => {
            assert_eq!(checkpoint.height, 0);
            assert!(used_script_index > 0);
        }
        _ => panic!("old scan coverage must not be trusted"),
    }
}

#[tokio::test]
async fn a_new_address_is_not_released_until_the_active_scan_covers_it() {
    let state = WalletState::new();
    {
        let mut g = state.sync.lock().unwrap();
        g.started_for = Some(Network::Regtest);
        g.status.running = true;
        g.coverage = Some((Network::Regtest, Some(0), None));
    }
    let wait = ensure_script_coverage(&state, Network::Regtest, (Some(101), Some(1)));
    tokio::pin!(wait);
    assert!(
        tokio::time::timeout(std::time::Duration::from_millis(20), &mut wait)
            .await
            .is_err()
    );
    state.sync.lock().unwrap().coverage = Some((Network::Regtest, Some(101), Some(1)));
    state.scripts_ready.notify_waiters();
    tokio::time::timeout(std::time::Duration::from_secs(1), wait)
        .await
        .unwrap()
        .unwrap();
}

#[tokio::test]
async fn seed_lookup_uses_tors_resolve_command_and_passes_the_hostname_to_the_proxy() {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let proxy = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        let mut greeting = [0; 3];
        socket.read_exact(&mut greeting).await.unwrap();
        assert_eq!(greeting, [5, 1, 0]);
        socket.write_all(&[5, 0]).await.unwrap();
        let mut header = [0; 5];
        socket.read_exact(&mut header).await.unwrap();
        assert_eq!(
            &header[..4],
            &[5, 0xf0, 0, 3],
            "must use Tor RESOLVE, with a domain-name target"
        );
        let mut name = vec![0; header[4] as usize];
        socket.read_exact(&mut name).await.unwrap();
        assert_eq!(name, b"x49.seed.example.invalid");
        let mut port = [0; 2];
        socket.read_exact(&mut port).await.unwrap();
        socket
            .write_all(&[5, 0, 0, 1, 203, 0, 113, 42, 0, 0])
            .await
            .unwrap();
    });
    // .invalid cannot be resolved by DNS; the only answer comes from this proxy.
    assert_eq!(
        resolve_tor_seed(proxy, "seed.example.invalid")
            .await
            .unwrap()
            .to_string(),
        "203.0.113.42"
    );
    server.await.unwrap();
}

// Run explicitly with BITCOIN_BIN_DIR pointing at a verified Bitcoin Core
// release. It launches only a disposable, loopback-only regtest node.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires Bitcoin Core binaries; see docs/REPAIR_VALIDATION.md"]
async fn real_regtest_receive_send_restart_and_rescan() {
    use std::process::{Child, Command, Stdio};
    use std::time::Duration;
    struct Core {
        process: Child,
        dir: PathBuf,
        bin: PathBuf,
        port: u16,
    }
    impl Drop for Core {
        fn drop(&mut self) {
            let _ = self.process.kill();
            let _ = self.process.wait();
        }
    }
    impl Core {
        fn rpc(&self, args: &[&str]) -> serde_json::Value {
            let output = Command::new(self.bin.join("bitcoin-cli"))
                .arg("-regtest")
                .arg(format!("-datadir={}", self.dir.display()))
                .arg("-rpcwait")
                .arg("-rpcwaittimeout=20")
                .arg(format!("-rpcport={}", self.port))
                .args(args)
                .output()
                .unwrap();
            assert!(
                output.status.success(),
                "RPC failed: {}",
                String::from_utf8_lossy(&output.stderr)
            );
            let text = String::from_utf8(output.stdout).unwrap();
            serde_json::from_str(&text)
                .unwrap_or_else(|_| serde_json::Value::String(text.trim().into()))
        }
    }
    fn port() -> u16 {
        std::net::TcpListener::bind("127.0.0.1:0")
            .unwrap()
            .local_addr()
            .unwrap()
            .port()
    }
    let bin = PathBuf::from(std::env::var("BITCOIN_BIN_DIR").expect("set BITCOIN_BIN_DIR"));
    let dir = std::env::temp_dir().join(format!(
        "cryptobridge-regtest-{}-{}",
        std::process::id(),
        rand_bytes()[0]
    ));
    std::fs::create_dir_all(&dir).unwrap();
    let p2p = port();
    let rpc = port();
    let process = Command::new(bin.join("bitcoind"))
        .arg("-regtest")
        .arg(format!("-datadir={}", dir.display()))
        .arg("-server=1")
        .arg(format!("-bind=127.0.0.1:{p2p}"))
        .arg(format!("-rpcport={rpc}"))
        .args([
            "-listenonion=0",
            "-connect=0",
            "-dnsseed=0",
            "-discover=0",
            "-blockfilterindex=1",
            "-peerblockfilters=1",
            "-fallbackfee=0.0001",
            "-printtoconsole=0",
        ])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let core = Core {
        process,
        dir: dir.clone(),
        bin,
        port: rpc,
    };
    core.rpc(&["createwallet", "fixture"]);
    let mining = core.rpc(&["getnewaddress"]).as_str().unwrap().to_owned();
    core.rpc(&["generatetoaddress", "101", &mining]);
    let db = dir.join("wallet.sqlite");
    let mut loaded = fixture(bdk_wallet::rusqlite::Connection::open(&db).unwrap());
    let receive = loaded
        .wallet
        .reveal_next_address(KeychainKind::External)
        .address
        .to_string();
    loaded.wallet.persist(&mut loaded.conn).unwrap();
    core.rpc(&["sendtoaddress", &receive, "0.001"]);
    core.rpc(&["generatetoaddress", "1", &mining]);
    // Compact filter index catches up asynchronously.
    for _ in 0..100 {
        if core.rpc(&["getindexinfo"])["basic block filter index"]["synced"] == true {
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    async fn sync(loaded: &mut Loaded, dir: &std::path::Path, p2p: u16) {
        let light = KyotoBuilder::new(Network::Regtest)
            .whitelist_only()
            .add_peer(std::net::SocketAddr::from(([127, 0, 0, 1], p2p)))
            .data_dir(dir.join("chain"))
            .build_with_wallet(&loaded.wallet, scan_type(&loaded.wallet, false))
            .unwrap();
        let (client, _, mut subscriber) = light.subscribe();
        let (client, node) = client.managed_start();
        let (cancel, task) = spawn_owned_node(node);
        let update = tokio::time::timeout(Duration::from_secs(45), subscriber.update())
            .await
            .expect("scan timed out")
            .unwrap();
        loaded.wallet.apply_update(update).unwrap();
        loaded.wallet.persist(&mut loaded.conn).unwrap();
        let _ = client.requester().shutdown();
        drop(cancel);
        task.await.unwrap().unwrap();
    }
    sync(&mut loaded, &dir, p2p).await;
    assert_eq!(
        loaded.wallet.balance().confirmed.to_sat(),
        100_000,
        "payment to the first address must be found on initial sync"
    );
    let destination = core
        .rpc(&["getnewaddress"])
        .as_str()
        .unwrap()
        .parse::<Address<_>>()
        .unwrap()
        .require_network(Network::Regtest)
        .unwrap();
    let mut psbt = build_send(
        &mut loaded,
        destination.script_pubkey(),
        50_000,
        FeeRate::from_sat_per_vb(2).unwrap(),
    )
    .unwrap();
    loaded
        .wallet
        .sign(&mut psbt, SignOptions::default())
        .unwrap();
    let tx = psbt.extract_tx().unwrap();
    let id = tx.compute_txid();
    record_outgoing(&mut loaded, tx.clone()).unwrap();
    // Crash/restart between saving and broadcast: inputs must remain spent.
    loaded = fixture(loaded.conn);
    assert!(!loaded
        .wallet
        .list_unspent()
        .any(|u| u.outpoint == tx.input[0].previous_output));
    let (node, client) = KyotoBuilder::new(Network::Regtest)
        .whitelist_only()
        .add_peer(std::net::SocketAddr::from(([127, 0, 0, 1], p2p)))
        .data_dir(dir.join("broadcast"))
        .build();
    let (cancel, task) = spawn_owned_node(node);
    tokio::time::timeout(Duration::from_secs(30), client.requester.submit_package(tx))
        .await
        .expect("broadcast timed out")
        .unwrap();
    for _ in 0..100 {
        if core
            .rpc(&["getrawmempool"])
            .as_array()
            .unwrap()
            .iter()
            .any(|t| t.as_str() == Some(&id.to_string()))
        {
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    assert!(
        core.rpc(&["getrawmempool"])
            .as_array()
            .unwrap()
            .iter()
            .any(|t| t.as_str() == Some(&id.to_string())),
        "peer must accept the signed transaction"
    );
    let _ = client.requester.shutdown();
    drop(cancel);
    task.await.unwrap().unwrap();
    core.rpc(&["generatetoaddress", "1", &mining]);
    sync(&mut loaded, &dir, p2p).await;
    let balance = loaded.wallet.balance().confirmed.to_sat();
    assert!(
        balance > 49_000 && balance < 50_000,
        "confirmed change must be found"
    );
    assert_eq!(loaded.wallet.balance().trusted_pending.to_sat(), 0);
    println!(
        "regtest: received 100000 sats, sent 50000, recovered confirmed change {balance}; db {}",
        db.display()
    );
}
