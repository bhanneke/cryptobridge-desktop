# Bisq 2 trade spike — findings

*Spike executed 2026-07-19 on macOS (Apple Silicon), bisq2 `main` (post v2.1.11), JDK 21 (Temurin 21.0.11).*
*Verdict up front: **build the BisqAdapter against Bisq 2's REST + WebSocket API.** The full Bisq Easy
BTC/EUR SEPA trade lifecycle works over the API today, headless, with no bitcoind and no Tor in the dev loop.*

## What was proven

A complete two-party Bisq Easy trade was executed purely over the API against a local clearnet
network (1 seed node + 2 headless `api-app` nodes, no GUI):

1. **Identity bootstrap** — `GET /user-identities/key-material` → `POST /user-identities` on both nodes.
2. **SEPA payment account** created on the seller (`POST /payment-accounts`, HTTP 201).
3. **Offer created** by the seller — SELL BTC/EUR, €50 fixed quote amount, market price spec (HTTP 201).
4. **P2P gossip** — the buyer node saw the offer in `GET /offerbook/markets/EUR/offers` within seconds.
5. **Offer taken** by the buyer (`POST /trades`, HTTP 201 → `tradeId`).
6. **All eight protocol events accepted** in order, on the correct sides, via
   `PATCH /trades/{tradeId}/event`: `SELLER_SENDS_PAYMENT_ACCOUNT` → `BUYER_SEND_BITCOIN_PAYMENT_DATA`
   → `BUYER_CONFIRM_FIAT_SENT` → `SELLER_CONFIRM_FIAT_RECEIPT` → `SELLER_CONFIRM_BTC_SENT`
   → `BTC_CONFIRMED` → `CLOSE_TRADE` (both sides). All HTTP 204.
7. **Trade-state streaming** — a WebSocket subscription (`TRADE_PROPERTIES` topic) on the buyer
   delivered the full state progression:

   ```
   INIT
   TAKER_SENT_TAKE_OFFER_REQUEST
   TAKER_RECEIVED_TAKE_OFFER_RESPONSE__BUYER_DID_NOT_SENT_BTC_ADDRESS__BUYER_DID_NOT_RECEIVED_ACCOUNT_DATA
   TAKER_RECEIVED_TAKE_OFFER_RESPONSE__BUYER_DID_NOT_SENT_BTC_ADDRESS__BUYER_RECEIVED_ACCOUNT_DATA
   TAKER_RECEIVED_TAKE_OFFER_RESPONSE__BUYER_SENT_BTC_ADDRESS__BUYER_RECEIVED_ACCOUNT_DATA
   BUYER_SENT_FIAT_SENT_CONFIRMATION
   BUYER_RECEIVED_SELLERS_FIAT_RECEIPT_CONFIRMATION
   BUYER_RECEIVED_BTC_SENT_CONFIRMATION
   BTC_CONFIRMED
   ```

Reproduction: [`spike/bisq2/`](../spike/bisq2) (environment launcher + trade script). Raw
request/response evidence: [`spike/bisq2/evidence/spike-evidence.json`](../spike/bisq2/evidence/spike-evidence.json)
(key material redacted). Background research with sources:
[`research/bisq-api-status-2026-07.md`](research/bisq-api-status-2026-07.md).

## Environment recipe (the whole thing)

```bash
# JDK 21 + bisq2 checkout; build the two headless apps (~3 min):
./gradlew :apps:seed-node-app:installDist :apps:api-app:installDist
# three processes (see spike/bisq2/launch-env.sh):
launch-env.sh seed     # clearnet seed on 127.0.0.1:18000
launch-env.sh seller   # api-app, REST 8090, devModeReputationScore=120000
launch-env.sh buyer    # api-app, REST 8091
node spike-trade.js    # the whole trade, ~40 s
```

No bitcoind (Bisq Easy never touches the chain in-app — BTC settlement is external, driven by
trade events). No Tor (clearnet transport for dev; production uses Tor by default). Market prices
come from public providers even in the local net, so `MarketPriceSpec` offers price correctly.

## API gotchas (paid for, so the adapter doesn't have to)

| Gotcha | Detail |
|---|---|
| `POST /payment-accounts` body | Takes `CreatePaymentAccountDto` **directly** (`{accountName, paymentRail: "SEPA", accountPayload: {...}}`). The `AddFiatAccountRequest` wrapper class in the repo is *not* the request body — sending it yields HTTP 500 "Payment rail must not be empty". |
| WS subscription dispatch | Messages **must** carry `"type": "SubscriptionRequest"` (server matches the Java class simple name). `{requestId, topic, parameter}` alone is silently rejected ("No service found"). |
| WS frames | Arrive as `{type: "WebSocketEvent", topic, subscriberId, payload, modificationType, sequenceNumber}` where `payload` is a **JSON-encoded string** — double parse required. |
| Trade state reads | REST has **no GET /trades** — trade state is WebSocket-only (`TRADES`, `TRADE_PROPERTIES` topics). The adapter's trade-state stream must be WS-backed. |
| Fiat amounts | Longs with precision 4 (€50.00 → `500000`). BTC side in sats. EUR/BTC quote value = price × 10⁴. |
| Event pacing | Each `PATCH /trades/{id}/event` is only legal in its protocol phase, and peer messages must propagate between phases — retry with backoff (the spike used 2 s intervals; everything settled within one or two retries). |
| Offer creation gate | Sellers need reputation ≥ 1200 (200 per USD of trade amount). Local dev: `-Dapplication.devMode=true -Dapplication.devModeReputationScore=…`. **Production consequence: our users are buyers (no reputation needed), which is exactly the right side of the market.** |
| Auth | Spike disabled `authorizationRequired` on loopback. Production: pairing-code flow (QR, 5-min TTL) issuing client credentials + sessions — same model the Bisq mobile apps use; the Tauri app should implement it against a user-run node. |
| API youth | `api/usage.md` documents only a few GET endpoints; the real surface lives in the endpoint classes. Expect to read source. |

## Mapping to our `OnrampAdapter`

| OnrampAdapter method | Bisq 2 API |
|---|---|
| `init()` | Bootstrap api-app / connect + pairing handshake |
| `getBackendInfo()` | Static + `GET /settings`, `GET /market-price/quotes` (rate) |
| `subscribeStatus(cb)` | WS connection state + bootstrap events |
| `listOffers({fiat})` | `GET /offerbook/markets/{ccy}/offers` (or WS `OFFERS` topic) |
| `takeOffer(offerId, {fiatAmountEur})` | `POST /trades` (compute `baseSideAmount` from quote) |
| `subscribeTrade(tradeId, cb)` | WS `TRADE_PROPERTIES`, filter by tradeId, map states to our `TradeState` enum |
| `getPaymentInstructions(tradeId)` | Seller's `SELLER_SENDS_PAYMENT_ACCOUNT` data (arrives in trade/chat) → parse into IBAN + build EPC QR ourselves |
| `confirmFiatSent(tradeId)` | `PATCH /trades/{id}/event` `BUYER_CONFIRM_FIAT_SENT` (+ `BUYER_SEND_BITCOIN_PAYMENT_DATA` beforehand) |
| `getWalletBalance()` / `getReceiveAddress()` / `withdraw()` | **Not Bisq's job in Bisq Easy** — BTC lands at whatever address the buyer supplies. The desktop app needs its own wallet component (or external wallet integration) to provide the receive address and track balance. This is the biggest architectural takeaway. |

State mapping for `subscribeTrade`: `TAKER_SENT_TAKE_OFFER_REQUEST` → `OFFER_TAKEN`;
`…BUYER_RECEIVED_ACCOUNT_DATA` → `AWAITING_FIAT_PAYMENT`; `BUYER_SENT_FIAT_SENT_CONFIRMATION` →
`FIAT_SENT`; `BUYER_RECEIVED_SELLERS_FIAT_RECEIPT_CONFIRMATION` → `FIAT_RECEIVED`;
`BUYER_RECEIVED_BTC_SENT_CONFIRMATION` → `BTC_RELEASED`; `BTC_CONFIRMED` → `COMPLETE`.

## Risks and open questions

- **Trade cap**: Bisq Easy is limited to ~$600/trade (reputation-based). Fine for onboarding-sized
  buys; larger amounts wait for Bisq MuSig (targeted 2026, not shipped — verified June 2026).
- **Security model**: Bisq Easy is *not* multisig-enforced; buyer protection rests on seller
  reputation and mediation (`POST /trades/{id}/mediation` exists). The UI must present this honestly.
- **Wallet gap**: as above — receive address + balance need a wallet component outside Bisq.
- **Mainnet transport**: production nodes run over Tor; bundling/supervising that is the Tauri
  shell's job (as planned), not a blocker for adapter development against a local node.
- **API stability**: young surface, sparse docs; pin the bisq2 version we develop against and
  add contract tests around the endpoints we use.

## Next steps (BisqAdapter, in order)

1. `src/adapters/bisq-adapter.js` implementing `OnrampAdapter` against `http://127.0.0.1:8090/api/v1`
   + `ws://…/websocket`, using the mapping table above; feature-flag adapter selection in `app.js`.
2. Contract tests mirroring `tests/mock-adapter.test.js` against the spike environment (CI can
   build bisq2 headless apps with JDK 21 — no bitcoind/Tor needed).
3. Payment screen: parse seller account data → render IBAN + EPC QR (reuse MockAdapter's EPC069-12
   builder) instead of the demo's instant-pay shortcut.
4. Pairing auth flow (production posture), then Tor + node supervision in the Rust shell.
