# BisqAdapter implementation plan (handoff brief)

*Written to hand the BisqAdapter build to a fresh session. Everything here is grounded in the
spike — see [BISQ2_SPIKE_FINDINGS.md](BISQ2_SPIKE_FINDINGS.md) for the proof run and
[research/bisq-api-status-2026-07.md](research/bisq-api-status-2026-07.md) for the source-backed
decision. The skeleton to fill in is [`src/adapters/bisq-adapter.js`](../src/adapters/bisq-adapter.js);
the contract-test stub is [`tests/bisq-adapter.contract.js`](../tests/bisq-adapter.contract.js).*

## Status: IMPLEMENTED & live-verified (2026-07-23)

This brief is now built. `src/adapters/bisq-adapter.js` implements the full buyer side; a live
contract test drove `OFFER_TAKEN → AWAITING_FIAT_PAYMENT → FIAT_SENT → FIAT_RECEIVED →
BTC_RELEASED → COMPLETE` through the adapter against a real local Bisq 2 network. Wallet decision:
**external-wallet mode** (`src/adapters/wallet.js`, `ExternalWallet`) — the user brings a receive
address, we hold no keys. Notes from the build:

- **WS frames are deltas.** Each `TRADE_PROPERTIES` frame carries *one* changed property
  (`tradeState`, or `paymentAccountData`, or `bitcoinPaymentData`, …) keyed by tradeId. The adapter
  **accumulates** them per trade (`tradeProps`). `getPaymentInstructions` reads the seller's
  `paymentAccountData` off this stream — there is no REST call for it.
- **Seller account data is free text** (e.g. `"Alice Spike, IBAN DE.. (SEPA)"`). `epc.js`
  `parseSepaAccountData()` extracts IBAN/holder/BIC and always returns the raw string so the UI can
  show exactly what the seller sent.
- **BTC address is sent event-driven, not blindly.** The buyer's receive address is fixed at
  `takeOffer` time and PATCHed as `BUYER_SEND_BITCOIN_PAYMENT_DATA` only once the WS stream reports
  `TAKER_RECEIVED_TAKE_OFFER_RESPONSE` (the phase where it is legal).
- **BTC receipt is NOT auto-asserted.** `autoConfirmBtcReceipt` defaults to **false**: a trade parks
  at `BTC_RELEASED` until the user verifies the coins in their own wallet and calls
  `confirmBtcReceived()` (a bisq-only method; the mock auto-completes). The contract test flips the
  flag to run unattended. The payment-screen milestone must add that manual confirm step.
- **Address safety.** `wallet.js` fully checksums bech32/bech32m receive addresses (BIP173/350) to
  catch paste typos before real BTC is sent. Legacy base58 originally got a structural check only;
  the security audit replaced that with full base58check (finding 2).
- **Both integration gaps that were open here are now closed.** *Transport*: HTTP/WS are routed
  through the Rust shell over IPC, so `connect-src` stays `'self'`. *Pairing auth*: implemented and
  live-verified against a node with `authorizationRequired=true` — see
  [PAIRING_AUTH.md](PAIRING_AUTH.md).

## Goal

Implement `OnrampAdapter` (the frozen interface in `src/adapters/onramp-adapter.js`) against a
**user-run Bisq 2 node**, so `app.js` can select it in place of `MockAdapter` with **no UI change**.
Our user is always the **buyer** (BTC for EUR via SEPA). The adapter drives the buyer side of a
Bisq Easy trade over REST + WebSocket.

Base surfaces (from the spike): `http://127.0.0.1:8090/api/v1` (REST) and `ws://127.0.0.1:8090/websocket`
(trade-state stream). Port/host must be configurable — production points at the user's own node.

## The one decision that must be made first: the wallet

Bisq Easy is **not** custodial and does **not** give the buyer a wallet — it delivers BTC to
**whatever address the buyer supplies** in `BUYER_SEND_BITCOIN_PAYMENT_DATA`. So three
`OnrampAdapter` methods have **no Bisq backing** and need a wallet component we own:

- `getReceiveAddress()` → a fresh address from our wallet (also sent into the trade)
- `getWalletBalance()` → our wallet's confirmed/pending balance
- `withdraw(address, sats)` → our wallet spends

**Decide before writing `takeOffer`/`confirmFiatSent`, because the buyer must hand a receive
address to the trade.** Options, cheapest first:

1. **External-wallet mode (recommended for v1):** user pastes/derives a receive address from their
   own wallet (hardware, Sparrow, etc.); we never hold keys. Smallest attack surface, cleanest
   regulatory posture (no custody, bright line #1). `getWalletBalance` becomes best-effort (watch
   the address via the Bisq explorer endpoint `GET /explorer/...`, or show "external").
2. **Embedded wallet (bdk via the Rust shell):** we generate/track keys in `src-tauri` and expose
   address/balance/withdraw over IPC. Better UX, but now we hold keys — this is the single most
   security-sensitive component in the whole product and pulls the eventual audit forward.

Whichever is chosen, keep it behind a small `Wallet` interface so the adapter depends on the
interface, not the implementation. **Recommend shipping v1 with external-wallet mode** and treating
the embedded wallet as its own later project with its own review.

## REST call reference (verified in the spike)

| Purpose | Call | Notes |
|---|---|---|
| List buyer identities | `GET /user-identities/ids` | empty array on a fresh node |
| Key material | `GET /user-identities/key-material` | feed verbatim into create |
| Create identity | `POST /user-identities` `{nickName, terms:"", statement:"", keyMaterialResponse}` | one-time |
| Market rate | `GET /market-price/quotes` | `quotes.EUR.value` = EUR/BTC × 10⁴ |
| List offers | `GET /offerbook/markets/EUR/offers` | filter to SELL BTC (we buy) |
| Take offer | `POST /trades` `{offerId, baseSideAmount, quoteSideAmount, bitcoinPaymentMethod:"MAIN_CHAIN", fiatPaymentMethod:"SEPA"}` → `{tradeId}` | `baseSideAmount` = sats, `quoteSideAmount` = eur×10⁴ |
| Trade event | `PATCH /trades/{tradeId}/event` `{tradeEventType, data}` | 204 on accept; retry per phase |

Buyer-side events we send: `BUYER_SEND_BITCOIN_PAYMENT_DATA` (data = receive address),
`BUYER_CONFIRM_FIAT_SENT`, `BTC_CONFIRMED`, `CLOSE_TRADE`. The seller sends
`SELLER_SENDS_PAYMENT_ACCOUNT` / `SELLER_CONFIRM_FIAT_RECEIPT` / `SELLER_CONFIRM_BTC_SENT` — we
only observe those via the stream.

**Gotchas the skeleton already encodes** (don't rediscover them):
- `POST /payment-accounts` (if ever needed on the buyer side) takes the DTO **directly**, not the
  `AddFiatAccountRequest` wrapper. We likely don't create a payment account as buyer — SEPA sender
  details are the user's own bank; confirm during implementation.
- **No REST `GET /trades`.** Trade state is WebSocket-only. `subscribeTrade` must be WS-backed.
- Fiat amounts are longs at precision 4 (€50.00 → `500000`); BTC side in sats.

## WebSocket

Connect `ws://host/websocket`. Subscribe by sending
`{"type":"SubscriptionRequest","requestId":"<id>","topic":"TRADE_PROPERTIES","parameter":null}` —
the `"type"` discriminator is **required** or the server silently drops it. Also `TRADES` for the
trade list. Frames arrive as
`{type:"WebSocketEvent", topic, subscriberId, payload, modificationType, sequenceNumber}` where
`payload` is a **JSON-encoded string** (double-parse). Filter `TRADE_PROPERTIES` payload entries by
`tradeId` and read `tradeState`.

## State mapping (Bisq `tradeState` → our `TradeState`)

Encoded as `BISQ_STATE_MAP` in the skeleton. From the observed buyer-side sequence:

| Bisq tradeState (contains) | our TradeState |
|---|---|
| `INIT`, `TAKER_SENT_TAKE_OFFER_REQUEST` | `OFFER_TAKEN` |
| `...BUYER_RECEIVED_ACCOUNT_DATA...` | `AWAITING_FIAT_PAYMENT` (buyer now has the seller's SEPA details) |
| `BUYER_SENT_FIAT_SENT_CONFIRMATION` | `FIAT_SENT` |
| `BUYER_RECEIVED_SELLERS_FIAT_RECEIPT_CONFIRMATION` | `FIAT_RECEIVED` |
| `BUYER_RECEIVED_BTC_SENT_CONFIRMATION` | `BTC_RELEASED` |
| `BTC_CONFIRMED` | `COMPLETE` |
| any `*CANCEL*` / `*REJECT*` / mediation-failed | `FAILED` |

Match by substring (Bisq's state names are compound). When `AWAITING_FIAT_PAYMENT` is first
reached, that is also when the seller's account data is available for `getPaymentInstructions`.

## getPaymentInstructions

The seller's SEPA details arrive with `SELLER_SENDS_PAYMENT_ACCOUNT` (in the trade's account-data
field / trade chat). Parse out IBAN + holder name, then **build the EPC069-12 (GiroCode) payload
ourselves** — reuse `MockAdapter`'s `epcPayload()` (lift it into a shared helper). This keeps the
IBAN + QR generation identical across adapters.

## Ordered steps

1. **Wallet decision** (above). Add a `Wallet` seam; stub external-wallet mode.
2. Fill `init` / `subscribeStatus` — REST reachability + WS connect; expose backend info from
   `getBackendInfo` (`GET /market-price/quotes` for the rate).
3. `listOffers` → `GET /offerbook/markets/EUR/offers`, map to our `Offer` shape, keep SELL offers.
4. `takeOffer` → compute `baseSideAmount` from the EUR quote, `POST /trades`; immediately send
   `BUYER_SEND_BITCOIN_PAYMENT_DATA` with the wallet receive address.
5. `subscribeTrade` → WS `TRADE_PROPERTIES`, dedupe by `sequenceNumber`, map states, emit our enum.
6. `getPaymentInstructions` → parse seller account data + build EPC QR.
7. `confirmFiatSent` → `PATCH ... BUYER_CONFIRM_FIAT_SENT`; auto-advance `BTC_CONFIRMED` +
   `CLOSE_TRADE` when the stream reports release (or leave `BTC_CONFIRMED` to a real chain check).
8. Wallet methods via the chosen mode.
9. `close` → unsubscribe, close WS.
10. Wire adapter selection in `app.js` behind a flag (`?backend=bisq` / env), default `mock`.

## Testing

- Keep `tests/mock-adapter.test.js` green (regression guard on the interface).
- `tests/bisq-adapter.contract.js` (stub provided) runs **only** when `BISQ_API_URL` is set,
  against the spike environment (`spike/bisq2/`). It should replay the buyer half of the spike
  trade through the adapter and assert the mapped `TradeState` sequence. CI can build the bisq2
  headless apps with JDK 21 (no bitcoind/Tor) — see `spike/bisq2/README.md`.

## Transport: how the adapter actually reaches the node (2026-07-24)

The adapter no longer calls `fetch`/`WebSocket` itself — it goes through a transport seam
(`src/adapters/transport.js`), because inside the packaged app it *cannot*: the CSP holds
`connect-src` at `'self'`, so a webview socket to `127.0.0.1:8090` is blocked outright. This was
a hard blocker; before it, the Bisq backend only worked when `src/` was served in a browser.

Two implementations behind one interface — `request()` and `openSocket()`:

- **WebTransport** — `fetch` + `WebSocket`. Browser dev server, the Node contract test.
- **TauriTransport** — `invoke('bisq_http' | 'bisq_ws_open' | 'bisq_ws_send' | 'bisq_ws_close')`
  plus a single `bisq-ws` event stream carrying every frame tagged with its socket id.

The CSP was **not** widened; the shell owns the socket instead. All policy lives in
`src-tauri/src/proxy.rs` (audit there, not in the JS): plaintext `http:`/`ws:` only, **literal
loopback IPs only** — hostnames including `localhost` are refused so the proxy never resolves a
name and DNS rebinding cannot walk it off-machine — paths confined to `/api/v1/…` and
`/websocket`, no redirect following, no environment proxy, method allowlist, size caps, socket
cap. Crucially there is **no TLS backend compiled in** (`default-features = false`), so the proxy
cannot open an HTTPS connection at all; CI greps the dependency tree and fails if one appears.

Residual risk, stated rather than hidden: any *port* on loopback is reachable, since a user may
run their node anywhere. The path allowlist is what keeps that uninteresting.

Verified: 8 allowlist unit tests + 6 live-transport tests (real servers on 127.0.0.1, including
proof a 302 is returned rather than followed), 16 JS transport tests including the
frame-before-id race, and both a live `live_bisq` proxy probe and the full buyer-side contract
trade against a real Bisq node. Not yet exercised: the literal Tauri IPC bridge in a running
window — that needs a GUI session plus a node, and is Tauri's own code either side of the seam.

## Auth / production posture (not needed for local dev, required before release)

**Done (2026-07-25).** The adapter pairs, holds credentials, renews sessions, and authenticates
both REST and the WebSocket handshake. Full protocol, wire format and the two behaviours that had
to be measured against a live node rather than assumed: [PAIRING_AUTH.md](PAIRING_AUTH.md).

## Bright-line check (keep true throughout)

No custody (external-wallet mode, or keys only ever on the user's machine) · no fiat handling (SEPA
is user↔seller, we only display instructions) · no order intermediation (offers are the Bisq
network's) · no volume fee · no yield/advice in the real path · open source · user-run node only.
