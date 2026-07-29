# Pairing auth (Bisq 2 `authorizationRequired=true`)

Implemented 2026-07-25. Until now the adapter refused to talk to an
authenticated node — `_req` threw rather than send blind requests — so the app
only worked against a node with authorization switched off. That is no longer a
sensible default: `authorizationRequired=true` is what the api-app ships with;
our spike env explicitly disabled it.

Everything below was read out of the bisq2 sources and then **verified against a
live node**, not inferred from documentation.

## The protocol

| Step | Call | Body | Returns |
|---|---|---|---|
| Pair (once) | `POST /api/v1/access/pairing` | `{version, pairingCodeId, clientName}` | `{version, clientId, clientSecret, sessionId, sessionExpiryDate}` |
| Re-session | `POST /api/v1/access/session` | `{clientId, clientSecret}` | `{sessionId, expiresAt}` |
| Revoke | `DELETE /api/v1/access/clients/{clientId}` | — | — |

Both pairing and session are `@AllowUnauthenticated`. Every other call carries:

```
Bisq-Client-Id:  <clientId>
Bisq-Session-Id: <sessionId>
```

`clientSecret` is durable and is what re-issues sessions; `sessionId` is short
lived. Source: `api/src/main/java/bisq/api/rest_api/endpoints/access/AccessApi.java`,
`.../access/filter/Headers.java`, `.../filter/authn/SessionAuthenticationService.java`.

## The pairing code

A node with authorization on generates a pairing code every few minutes (TTL 60
min in the build tested), logs `Pairing QR code created. Code ID: <uuid>`, and —
when `writePairingQrCodeToDisk=true`, the api-app default — writes
`pairing_qr_code.txt` into its data dir. The **first line of that file is the
base64url payload**; the rest is an ASCII-art rendering of the same QR.

The payload is a nested binary structure (big-endian; byte arrays carry an
unsigned 16-bit length prefix), transcribed from `PairingQrCodeEncoder` and
`PairingCodeEncoder`:

```
PairingQrCode := version:u8
                 pairingCode:bytes(u16-len)      // nested, below
                 webSocketUrl:bytes(u16-len)     // UTF-8
                 flags:u8                        // 1 = TLS fingerprint, 2 = Tor auth
                 [tlsFingerprint:bytes(u16-len)]
                 [torClientAuthSecret:bytes(u16-len)]

PairingCode   := version:u8
                 id:bytes(u16-len)               // UTF-8 UUID — this is pairingCodeId
                 expiresAt:i64                   // epoch millis
                 permissionCount:i32
                 permissionId:i32 * count
```

`src/adapters/pairing.js` decodes this and also accepts a bare code id, which is
what a headless setup has. It refuses an expired code, and refuses one that does
not grant `MARKET_PRICE`, `OFFERBOOK` and `TRADES` — better a clear error at
connect time than a 403 halfway through a trade.

The decoder is tested against a **real QR emitted by the Java encoder**
(`tests/pairing.test.js`), not against our own round-trip. That distinction is
deliberate: a self-consistent round-trip is how an encoding bug survived review
in the QR work.

## Two things measured, not assumed

**1. Auth failures come back as 403, not 401.** On a node with
`authorizationRequired=true`, both an absent session *and* an invalid one are
refused with **403** on `/market-price/quotes` — authorization denies the call
before authentication has marked it as anyone. The adapter originally renewed
its session on 401 only, which would have meant **never renewing at all**; the
live test caught it. It now treats 401 and 403 alike, retrying once.

**2. The WebSocket does not enforce authorization.** Also measured on 2.1.11
with `authorizationRequired=true`: an unauthenticated WebSocket handshake is
**accepted**, and subscriptions are answered — a `MARKET_PRICE` subscription
returned live quote data to a client with no credentials at all, while the REST
API refused the same caller with 403.

`TRADE_PROPERTIES` returned an empty list, but the node under test had no
trades, so **this does not establish whether trade data would leak** to an
unauthenticated subscriber. That is the question worth answering before anyone
runs an authenticated node on anything but loopback — and it is worth reporting
upstream to Bisq either way.

We send the session headers on the handshake regardless. That is correct today
and stays correct if Bisq tightens this. The tests deliberately assert *neither*
direction on the node's behaviour: pinning "accepted" would enshrine a bug.

## Why this only works in the desktop app

Bisq authenticates the WebSocket on **handshake headers**, with no query-string
fallback (`WebSocketSessionAuthenticationFilter` reads `request.getHeader(...)`).
Neither a browser's `WebSocket` nor Node's can set those. So an authenticated
node is reachable only through a transport that can — the Rust shell.

`WebTransport.openSocket` therefore rejects up front with an explanation rather
than opening a socket the node will refuse. This is the same architectural line
the IPC transport already drew, and it is why the two pieces fit together.

Header handling in the shell is allowlisted: only `bisq-client-id` and
`bisq-session-id` may be set, values may not contain control characters, and
they are length-capped. The proxy is the app's one hole in the CSP sandbox and
letting the page choose arbitrary headers would widen it for no benefit.

## Using it

```
localStorage['cryptobridge.backend'] = 'bisq'
localStorage['cryptobridge.node']    = 'http://127.0.0.1:8092/api/v1'
localStorage['cryptobridge.pairing'] = '<first line of pairing_qr_code.txt>'
```

The code is spent on first connect and replaced by
`cryptobridge.credentials`. If the node later rejects those (revoked, or a
rebuilt node), the adapter re-pairs when a pairing code is still present,
otherwise it surfaces the error.

**Known limitation:** those credentials sit in `localStorage`, readable by any
script in the webview. The audit found no XSS path today, and the alternative is
re-pairing on every launch — but the right home is the Rust shell, so the
webview never holds the secret at all. That, and a real connect screen instead
of `localStorage` keys, are the follow-ups.

## Reproducing the live test

```bash
# a node with authorization ON (the api-app default), on port 8092
BISQ2_REPO=~/src/bisq2 ./spike/bisq2/launch-env.sh seed
BISQ2_REPO=~/src/bisq2 ./spike/bisq2/launch-auth.sh

CODE_ID=$(head -1 <data-dir>/pairing_qr_code.txt | node -e '...parsePairingInput...')
BISQ_AUTH_API_URL=http://127.0.0.1:8092/api/v1 BISQ_PAIRING_CODE_ID=$CODE_ID \
  cargo test --manifest-path src-tauri/Cargo.toml -- --nocapture live_auth
```

The test proves, in order: a credential-less call is refused; a bogus session is
refused; pairing issues `clientId`/`clientSecret`/`sessionId`; the same REST call
then succeeds; and an authenticated WebSocket subscription is answered.
