# Bisq 1 vs Bisq 2 API status — research notes

*Compiled 2026-07-18/19 from primary sources (repos, release pages, bisq.wiki, bisq.network blog).
Basis for the decision recorded in [BISQ2_SPIKE_FINDINGS.md](../BISQ2_SPIKE_FINDINGS.md).
Claims that could not be verified are flagged at the end.*

## Bisq 1 (bisq-network/bisq) — daemon + gRPC API

- **Actively maintained.** Latest release v1.10.3 (2026-07-06); 2026 cadence: v1.10.0 (May 16),
  v1.10.1 (May 29), v1.10.2 (Jun 19), v1.10.3 (Jul 6). API under active development (June 2026
  commits added long-running API e2e trade tests and a `GetWalletSyncStatus` gRPC; May 2026
  refactored gRPC stubs into a `:proto-grpc` module).
- **No more prebuilt daemon/cli binaries.** v1.9.21 still shipped `bisq-daemon`/`bisq-cli` zips;
  v1.10.x releases ship only desktop installers (incl. `Bisq-aarch64-*.dmg`). Daemon/cli must be
  built from source.
- **JDK 21 required** (root `Makefile`; `gradle.properties`: `releaseBuild.javaVersion=21.0.6`,
  Gradle 8.9). The apitest guide's "JDK 11–16" prerequisite is stale.
- **Local regtest docs:** `docs/dev-setup.md` (bitcoind regtest + seednode + arbitration +
  Alice/Bob), root `Makefile` localnet targets, and `apitest/docs/api-beta-test-guide.md` — the
  one-command harness: `./bisq-apitest --apiPassword=xyz
  --supportingApps=bitcoind,seednode,arbdaemon,alicedaemon,bobdaemon --shutdownAfterTests=false`
  (Alice gRPC :9998, Bob :9999).
- **Full SEPA BTC/EUR trade via API: yes** — `createpaymentacct` (JSON form incl. SEPA),
  `createoffer`, `takeoffer`, `confirmpaymentstarted`, `confirmpaymentreceived`, `closetrade`,
  `withdrawfunds`. Reference: https://bisq-network.github.io/slate/
- **Constraints:** never run daemon + desktop on the same data dir; BTC buyer must pre-fund a
  security deposit (min ~15% / 0.001 BTC floor) + taker fee — onboarding friction for our user.
  Post-incident caps: v1.10.0 limited trades to 0.125 BTC, v1.10.1 raised to 0.25 BTC.
- **Not sunset.** Official June 2026 blog (post May-1-2026 security incident, victims reimbursed
  11.59104 BTC): Bisq 1 "expected to remain the primary home for BSQ markets and DAO governance";
  after MuSig ships, traders are expected to migrate to Bisq 2.

## Bisq 2 (bisq-network/bisq2) — Bisq Easy

- **Latest release v2.1.11 (2026-05-24).** JDK 21. 2026 cadence: v2.1.9 (Feb), v2.1.10 (Mar,
  QR pairing for Bisq Connect + trade history), v2.1.11 (May, hardening).
- **Programmatic API: real and read-write.** Unified REST + WebSocket (+ WS-REST bridge) in the
  `api` module (Grizzly/Jersey; gRPC stubbed out for the future). Verified endpoints:
  - `POST/DELETE /offerbook/offers`, `GET /offerbook/markets`, `GET /offerbook/markets/{ccy}/offers`
  - `POST /trades`, `PATCH /trades/{tradeId}/event` (full Bisq Easy event enum), `POST /trades/{id}/mediation`
  - `POST /payment-accounts` incl. SEPA/SEPA-Instant payloads
  - user identities, settings, market prices, reputation, trade chat; WS topics: MARKET_PRICE,
    OFFERS, TRADES, TRADE_PROPERTIES, TRADE_CHAT_MESSAGES, …
  - Auth: pairing-code flow (QR, 5-min TTL) → clientId/clientSecret/session — the Bisq Connect model.
  - Defaults: port 8090, `restEnabled=false` (flip via config/system property), WS enabled, Tor
    transport by default (CLEAR selectable), Swagger UI available. `api/usage.md` is stale vs code.
- **Headless:** `apps/api-app` (`./gradlew :apps:api-app:installDist`). Dev setup:
  `scripts/local-3node.sh` (seed + desktop + api-app, clearnet, REST on 8090). `devMode` +
  `devModeReputationScore` fake reputation for local sellers (verified in spike).
- **Bisq Easy protocol:** buyer needs no BTC upfront; seller reputation-based. Limits (verified in
  `BisqEasyTradeAmountLimits.java`): min $6, max $600-equivalent, 200 reputation score per USD,
  1,200 minimum to create sell offers; sellers typically price ~10–15% premium (bisq.wiki).
- **MuSig (multisig successor): not shipped.** Module exists, "inactive"; June 2026 blog: highest
  strategic priority, "hopeful … during 2026" (delayed by the May incident). Taproot-based,
  4 on-chain txs → 1.
- **Mobile:** launched 2026-04-11 — Bisq Easy Mobile (Android full node) and Bisq Connect (thin
  client ↔ trusted Bisq 2 node over the same WS/HTTP API; iOS on TestFlight). Active tags:
  `connect_0.7.0` (2026-07-18), `anode_0.9.0` (2026-07-11). The mobile apps exercise exactly the
  API surface our adapter will use.

## Spike-friction comparison (macOS, Apple Silicon)

| | Bisq 1 | Bisq 2 |
|---|---|---|
| Toolchain | JDK 21 + bitcoind + source build | JDK 21 only |
| Regtest infra | bitcoind + seed + arb + 2 daemons (`bisq-apitest` harness) | seed + headless api-app(s), one script |
| Buyer prerequisites | BTC security deposit + fees upfront | none (reputation is seller-side) |
| API | gRPC, mature, well-documented | REST/WS, younger, under-documented, mobile-proven |
| Strategic direction | maintenance; DAO/BSQ home | where MuSig lands; active product focus |

**Decision: Bisq 2 first; Bisq 1 gRPC as phase-2 fallback for multisig/&gt;$600 trades.**
Confirmed empirically — see BISQ2_SPIKE_FINDINGS.md.

## Explicitly unverified

Reason Bisq 1 dropped daemon/cli release binaries; Bisq 1 volume trend (only fee-revenue proxy:
12.59 BTC total May 2025–Apr 2026); post-incident security-deposit percentages (wiki page predates
incident); Bisq Connect iOS App Store status beyond TestFlight.

## Primary sources

github.com/bisq-network/bisq (releases, Makefile, gradle.properties, docs/dev-setup.md,
docs/api-overview.md, apitest/docs/api-beta-test-guide.md) · bisq-network.github.io/slate ·
github.com/bisq-network/bisq2 (releases, api module, TradeRestApi.java, OfferbookRestApi.java,
BisqEasyTradeAmountLimits.java, api_app.conf, scripts/local-3node.sh, docs/dev/build.md) ·
bisq.wiki (Bisq_Easy, Security_deposit) · bisq.network/blog (security-incident status June 2026,
mobile launch April 2026) · github.com/bisq-network/bisq-mobile.
