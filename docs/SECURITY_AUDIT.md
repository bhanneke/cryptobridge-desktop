# Security audit — 2026-07-25

First full adversarial review of CryptoBridge Desktop, deferred until there was
real-money-adjacent code to point at. There now is: the Bisq adapter, the
wallet/address seam, the loopback IPC proxy, and a payment screen that renders
an IBAN into a QR code people scan with their banking app.

**Result: 5 findings, all fixed.** One high (a hostile seller could make the
GiroCode pay a different account than the screen showed), two medium, two low.
Every finding has a regression test in [`tests/security.test.js`](../tests/security.test.js)
that fails against the code as it was.

Scope: `src/adapters/**`, `src/vendor/qr.js`, `src/app.js`, `src/index.html`,
`src-tauri/**`, CI, and the dependency tree. Commit audited: the tip of
`feat/replace-demo-fiction`.

## Threat model

The interesting attacker here is **not** a network eavesdropper. The app has no
server, makes no outbound connection except to a node on `127.0.0.1`, and the
fiat leg never touches it. The attackers that matter are:

| # | Attacker | What they control |
|---|---|---|
| T1 | **A hostile trade peer (the seller)** | Their maker handle, and the free-text "bank details" string Bisq Easy delivers over the WebSocket. This text is parsed into the IBAN, name and QR the user pays against. |
| T2 | **A lying or compromised Bisq node** | Every REST response and every WebSocket frame, including trade states and the offer book. |
| T3 | **A malicious process on loopback** | Can listen on a port the user might point the app at. |
| T4 | **A compromised webview (XSS)** | Would reach whatever the IPC surface exposes. |
| T5 | **The supply chain** | Anything that enters the dependency tree. |

The user's own mistakes (mistyped address, wrong amount) are treated as part of
the threat model, because the outcome — irreversible loss — is identical.

**Non-goals.** This audit does not cover Bisq itself, the user's operating
system or bank, or the pairing/authentication flow, which is not implemented
(`_req` refuses when a pairing code is set, rather than sending unauthenticated
requests blind).

---

## Finding 1 — Hostile seller could forge the GiroCode (HIGH) — fixed

**Where:** `src/adapters/epc.js`, `epcPayload()`

An EPC069-12 payload is twelve newline-delimited fields, and readers key on
**line position**. `epcPayload` interpolated the receiver name without
stripping newlines, and that name comes from `parseSepaAccountData()` — i.e.
from free text the **seller types** (T1).

A seller could therefore inject line breaks and push their own IBAN and amount
into the positions a banking app actually reads, while the app's own screen
kept showing the honestly-parsed IBAN. **The user sees one account and scans a
QR that pays another.** Since the QR is the thing people actually use, and a
SEPA transfer is not reversible, this is the most serious issue found.

Proof, from the regression test — seller sends
`DE0212…202051\nDE99ATTACKER0000000\nEUR9999.00, Alice`:

```
line 5 (name)   "DE02120300000000202051"
line 6 (IBAN)   "DE99ATTACKER0000000"   ← attacker's account
line 7 (amount) "EUR9999.00"            ← attacker's amount
```

The screen, meanwhile, displayed `DE02 1203 0000 0000 2020 51`.

**Fix.** Every text field is sanitised through `epcField()`: line separators
(`\r`, `\n`, U+0085, U+2028, U+2029) collapse to spaces, control characters are
removed, and fields are clamped to the spec's lengths. The payload is now
always exactly twelve lines. The amount is range-checked rather than
`Number()`-coerced into `NaN`. `parseSepaAccountData` also collapses whitespace
in the name on both branches, so the *displayed* name cannot be multi-line
either.

**Residual, accepted:** the seller's text can still appear *within* the name
field — it is their name, and a name cannot redirect a payment. Mitigated by
Finding 1b.

### 1b — the seller's raw text was never shown (contributing) — fixed

`docs/BISQADAPTER_PLAN.md` said to "always show the seller's exact text", and
`getPaymentInstructions` did return `rawAccountData`, but **the UI never
rendered it** — the user only saw our parse. That removed their ability to
notice a seller playing games with the format. The payment screen now discloses
the raw message verbatim (as `textContent`), behind a disclosure control, with
a note that the fields above are our reading of it.

---

## Finding 2 — Legacy addresses were not checksummed (MEDIUM) — fixed

**Where:** `src/adapters/wallet.js`, `looksLikeLegacy()`

bech32/bech32m addresses got a full checksum, but legacy base58 addresses got a
**regex only** — the comment said as much ("no base58check sha256d, to stay
sync + dependency-free"). So a one-character typo in a legacy address validated
happily and the coins went somewhere unspendable. The whole point of validating
a receive address is catching exactly that (T-user).

```
1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa   real
1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNb   one char changed — used to validate
```

**Fix.** Full base58check: decode, double-SHA-256, verify the 4-byte checksum,
and check the version byte against the selected chain (`0x00`/`0x05` mainnet,
`0x6f`/`0xc4` test-family). This needs synchronous SHA-256 — `crypto.subtle` is
async and `isValidBtcAddress` is not — so a compact implementation lives in
`wallet.js` rather than adding a runtime dependency (the app ships zero).

That implementation is verified against the FIPS-180-4 vectors **and
differentially against `node:crypto` for every input length 0–200**, which
covers the block-boundary and padding edges where hand-rolled SHA-256 usually
breaks.

---

## Finding 3 — A node could force "trade complete" (MEDIUM) — fixed

**Where:** `src/adapters/bisq-adapter.js`, `_applyTradeDelta()`

The adapter's stated safety property is that it never auto-asserts receipt of
bitcoin: `autoConfirmBtcReceipt` defaults to `false` so a trade parks at
`BTC_RELEASED` until the user confirms the coins arrived. **The implementation
did not enforce it.** Any `tradeState` containing `BTC_CONFIRMED` mapped
straight to `COMPLETE`, so a lying node or hostile peer (T1/T2) could skip the
protocol and assert the end state directly. The UI would show "Trade complete"
— immediately after the user had sent their euros.

**Fix.** `COMPLETE` is withheld and downgraded to `BTC_RELEASED` unless the user
has actually confirmed (`btcReceiptSent`) or `autoConfirmBtcReceipt` is on (the
tests/demo path). Since the node may already have sent its final state and will
not necessarily repeat it, `confirmBtcReceived()` now emits `COMPLETE` itself
once its events land — otherwise the honest flow would hang forever. It also
rolls back `btcReceiptSent` if those events fail, so the user can retry.

---

## Finding 4 — IBAN check had no checksum (LOW) — fixed

**Where:** `src/adapters/epc.js`, `looksLikeIban()`

Structure and length only, no mod-97. The IBAN is hand-typed by the seller and
ends up in a QR, so a transposed digit would sail through into a payment.
Now validates the ISO 7064 mod-97-10 checksum. (The demo IBAN already
satisfies it — checked before tightening, so nothing downstream broke.)

---

## Finding 5 — The socket cap bounded nothing (LOW) — fixed

**Where:** `src-tauri/src/lib.rs`, `bisq_ws_open()`

`MAX_SOCKETS` was enforced by checking the registry's length *before* the
WebSocket handshake and inserting *after* it. Concurrent calls therefore all
passed the check inside that window, so the cap did not actually bound
anything — a compromised webview (T4) could open sockets without limit.

**Fix.** The slot is reserved atomically (`fetch_update` on an `AtomicUsize`)
before the handshake and released on every exit path, including handshake
failure and socket close.

---

## Reviewed and found sound

Recording these so a future reader knows they were examined, not skipped.

- **No XSS path today.** Every `innerHTML` site in `app.js` is a static
  template or an app-owned constant. Data from the network — maker handles,
  payment methods, IBANs, the seller's raw text — is set via `textContent` or
  `dataset`. `renderRows()` is text-only by construction.
- **`qrSvg` does not interpolate the QR payload into markup** — only the module
  matrix becomes `<rect>`s. The caller-supplied label and colours *were*
  interpolated into attributes; they are literals today, but they are now
  escaped so a future caller cannot turn that into an injection.
- **The QR amount is not node-controlled.** `trade.fiatAmountEur` is the value
  the user typed, not an echo from the node, so a node cannot make the QR and
  the screen disagree on the amount. (Suspected, then disproved by reading
  `takeOffer`.)
- **Loopback proxy allowlist** (`src-tauri/src/proxy.rs`): no TLS backend is
  compiled in, hostnames including `localhost` are refused so no DNS resolution
  can walk it off-machine, paths are confined to `/api/v1/…` and `/websocket`,
  redirects are not followed, and the environment proxy is disabled. CI fails
  the build if a TLS crate enters the tree. Unchanged by this audit apart from
  Finding 5.
- **Cross-trade contamination:** WebSocket deltas are keyed by trade id and only
  dispatched to that trade's subscribers; a node cannot drive a trade the user
  is not in.
- **Supply chain:** zero runtime dependencies (`dependencies: {}`), `npm audit`
  clean, and the Rust tree carries no TLS stack by construction.
- **`confirmFiatSent` is state-guarded** — it refuses unless the trade is in
  `AWAITING_FIAT_PAYMENT`.

## Open items (not fixed here)

1. **`withGlobalTauri: true` widens the IPC surface.** It exposes all of
   `window.__TAURI__`, so an XSS would reach every command permitted by
   `core:default`, not just the four `bisq_*` ones. The blast radius excludes
   filesystem and shell (those are plugins, not enabled), but least privilege
   would mean narrowing the capability to roughly `core:event:default` plus
   what the window genuinely needs. **Deliberately not changed:** validating a
   narrowed capability set needs a GUI session, and shipping an untested
   narrowing risks breaking the app in a way CI cannot catch. Do it alongside
   the first real packaged-app test pass.
2. **Unbounded `tradeProps` growth.** A hostile node can stream deltas for
   arbitrary trade ids and grow the map without limit. Memory-only, needs a
   node already trusted enough to talk to; worth an LRU bound eventually.
3. **Pairing auth remains unimplemented** — so the app only talks to an
   unauthenticated loopback node. This is a *missing feature*, not a hole, and
   the adapter refuses rather than sending blind requests. Re-audit the auth
   path when it lands.
4. **No mod-97 country-length table.** `looksLikeIban` checks the checksum but
   not that the length matches the IBAN's country. Low value: the checksum
   already catches the realistic typo cases.

## Re-running the evidence

```bash
npm test                                          # includes tests/security.test.js
cargo test --manifest-path src-tauri/Cargo.toml   # proxy allowlist + live transport
npm run test:e2e                                  # full flow, incl. the raw-text disclosure
```
