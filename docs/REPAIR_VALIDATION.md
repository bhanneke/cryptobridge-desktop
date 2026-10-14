# September 2026 repair pass

Baseline: `d8bfc02aa682d3e39ca93050b4decd60199b6151`. These repairs address the 16 findings from the September 13 review. They do not constitute approval to use this pre-release application with real funds.

## Changed behavior

| Review finding | Repair | Regression coverage |
|---|---|---|
| 1. Empty initial scan | Recovery includes revealed receive/change scripts plus a 100-address gap before any filter is processed. New address/change derivation restarts the subscriber, which owns a snapshot of the wallet index. | Real Bitcoin Core regtest payment to address zero, initial recovery and confirmed change |
| 2. Missing outgoing accounting | Persist the preview's change index; sign the approved transaction; record and persist it before broadcast. Spent inputs remain unavailable after a failed broadcast or restart. Retry the same pending transaction periodically. | SQLite reload, another spend cannot reuse the input, real peer broadcast and mined change |
| 3. Cross-node credentials | Canonical node endpoint scopes OS keychain entries. Discard legacy unscoped localStorage secrets and require re-pairing. REST and WebSocket endpoints must match. | Rust key scope, JS storage isolation, actual UI node switch |
| 4. Broken trade resume | Save amounts, original address, node properties and local payment/receipt flags. Resume the existing trade directly, keeping released BTC visible until local receipt confirmation. | Fresh adapter restored from storage, payment instructions, visible resume dialog with original address |
| 5. DNS outside Tor | Resolve compact-filter seed hostnames with Tor's SOCKS RESOLVE extension; disable Kyoto DNS/gossip discovery with `whitelist_only`. | Local SOCKS fixture verifies the domain name and Tor RESOLVE command |
| 6. Startup privacy bypass | Apply privacy checks at startup, every socket reconnect and before each take. Unknown mainnet transport blocks connection and new trading until the node is configured for privacy. | Adapter and actual UI mainnet CLEAR-node fixtures |
| 7. Duplicate trade after failure | Obtain a destination before POST. Save a creation intent before sending; keep uncertain outcomes across restart and block further POSTs. Payment-confirmation retries remain attached to the existing trade. | Wallet/storage failures, lost response, simultaneous clicks, payment retry UI |
| 8. Network/sync lifecycle | Network-tagged status/requesters, serialized stop/start, owned runtime teardown for Kyoto peer tasks, captured frontend wallet poller with retries. | Mainnet-to-signet UI switch; repeated regtest node startup/teardown |
| 9. Expired WebSocket auth | Renew before reopening; coalesce concurrent HTTP/WS renewals. | Reconnect uses fresh headers and concurrent callers share renewal |
| 10. Old sequence counters | Reset counters per socket generation and ignore frames from old generations. | Old sequence 25, reconnect, accept sequence 1; reject stale socket frames |
| 11. Interrupted backup | Reload the recovery words when an existing wallet is still unbacked-up. | Actual UI restart fixture with twelve words |
| 12. Invalid payment QR | Bank-detail validation gates QR and confirmation; missing amounts or an address conflict require resolution in Bisq. Corrected details can be refreshed. | Invalid checksum and address conflict tests, correction UI |
| 13. Payment-method mismatch | Offer book accepts the SEPA + MAIN_CHAIN intersection and submits those methods. | Unsupported and mixed-method offers |
| 14. Unverified birthday | Remove immediate `chain_tip()` probing and ignore old birthday files. Existing databases get one full recovery before a scan-v2 marker is written. | Old database checkpoint test, real regtest recovery |
| 15. IPv6 WebSocket | Connect parsed IP literals as `SocketAddr`, avoiding bracketed-host DNS lookup. | Real loopback IPv6 handshake |
| 16. Unbounded upgrade | Deadline covers connection and HTTP Upgrade; timeout drops the socket. | Silent server, timeout and observed socket EOF |

## User-visible migration

- Pair each previously paired node again. Old credentials cannot be safely assigned to a node automatically.
- The first repaired wallet scan starts at genesis, including for wallets an older release reported as synchronized. It may take substantial time on mainnet. Sending waits for this recovery to finish. Later scans use a recent saved checkpoint.
- New trades retain their original amounts and receive addresses. Older trades created before this repair may lack the amount because the node's property snapshot does not provide it. They remain visible, but payment must be verified/completed in Bisq rather than generating a guessed QR.
- A lost trade-creation response cannot safely be retried: the API has no demonstrated idempotency key. Check the node in Bisq and explicitly mark that request resolved before starting another purchase.
- A transaction saved before an uncertain broadcast is pending, not proof of settlement. The wallet retries its exact signed bytes. There is no automatic conflicting replacement or input release on a timeout.

## Run the checks

```sh
npm ci
npm test
npm run test:e2e
npm run test:recovery-ui
cargo test --locked --manifest-path src-tauri/Cargo.toml
cargo clippy --locked --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
```

The real chain test requires a Bitcoin Core distribution. Download and verify it using the [official Bitcoin Core instructions](https://bitcoincore.org/en/download/), then run:

```sh
BITCOIN_BIN_DIR=/absolute/path/to/bitcoin-31.1/bin \
  cargo test --locked --manifest-path src-tauri/Cargo.toml \
  real_regtest_receive_send_restart_and_rescan -- --ignored --nocapture
```

This test creates a disposable loopback-only regtest node and a fixture wallet database. It mines test coins, receives 100,000 sats, signs/saves a 50,000-sat send, reloads the database before broadcast, broadcasts through Kyoto's peer connection, mines confirmation, and checks the remaining change. The subprocess is killed and waited on even on assertion failure. No keychain wallet or real funds are used. CI runs this test explicitly; the default Cargo test run labels it ignored rather than silently treating it as verified.

## Local verification on September 14, 2026

- 141 JavaScript tests passed.
- 38 complete mock-flow browser checks and 8 recovery/privacy UI cases passed in isolated Chrome profiles.
- Cargo completed 32 unit tests, 5 IPC tests and 8 transport test functions. Two transport functions require live Bisq environment variables and did not run their live-node bodies; the node-discovery unit test is also environment-dependent.
- The separate Bitcoin Core 31.1 regtest passed, including peer broadcast and 49,719 sats of confirmed change after a 50,000-sat send from 100,000 sats (281-sat transaction fee).
- Clippy with warnings denied and the normal dependency-tree no-TLS check passed.
- A macOS debug `.app` bundle built successfully. This verifies compilation/bundling, not a full native keychain/Bisq/Tor user journey.

## Validation limits and release work

The JavaScript, mocked Tauri UI, Rust IPC/proxy, SQLite wallet and real local Bitcoin regtest checks cover different parts of the system. A mock UI test does not prove OS keychain behavior, and a local SOCKS fixture does not prove production Tor circuit behavior. The live Bisq contract tests still require configured test nodes and must not be counted as live verification when their environment variables are absent.

Before a mainnet release, validate the packaged application with test Bisq nodes, a real Tor daemon, interrupted network access and OS keychain persistence on the supported operating systems. Review Tor/Bisq/JRE bundling separately: the existing Tor packaging PR #11 was outside these runtime repairs and was not merged here. Restore/import UX, transaction-specific chain receipt verification, and recovery of a permanently rejected pending send are still release considerations. The wallet's current recovery strategy favors complete coverage over initial-sync speed.

Credentials are encrypted at rest by the OS keychain but are loaded into adapter memory for authentication. A compromised webview could use IPC to read them or request wallet operations. Recovery phrases cross into the UI only during the unconfirmed backup ceremony. Trade records include bank details and are localStorage data; they are not encrypted by this change. Absence of a TLS library is a dependency constraint, not evidence that exfiltration is impossible.
