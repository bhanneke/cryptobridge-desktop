/* Pure unit tests for the BisqAdapter's decision logic — no Bisq node needed,
 * so these run in CI under `npm test`. The live end-to-end replay against a real
 * node lives in bisq-adapter.contract.js (gated on BISQ_API_URL). */
import test from 'node:test';
import assert from 'node:assert/strict';

import { mapBisqState, BISQ_STATE_MAP, BisqAdapter } from '../src/adapters/bisq-adapter.js';
import { TradeState } from '../src/adapters/onramp-adapter.js';
import { isValidBtcAddress, ExternalWallet } from '../src/adapters/wallet.js';
import { epcPayload, parseSepaAccountData, looksLikeIban, normaliseIban } from '../src/adapters/epc.js';

// ---- state mapping (the exact sequence captured in the spike) --------------
test('Bisq tradeState maps to our TradeState across the real sequence', () => {
  const seq = [
    ['INIT', TradeState.OFFER_TAKEN],
    ['TAKER_SENT_TAKE_OFFER_REQUEST', TradeState.OFFER_TAKEN],
    ['TAKER_RECEIVED_TAKE_OFFER_RESPONSE__BUYER_DID_NOT_SENT_BTC_ADDRESS__BUYER_RECEIVED_ACCOUNT_DATA', TradeState.AWAITING_FIAT_PAYMENT],
    ['TAKER_RECEIVED_TAKE_OFFER_RESPONSE__BUYER_SENT_BTC_ADDRESS__BUYER_RECEIVED_ACCOUNT_DATA', TradeState.AWAITING_FIAT_PAYMENT],
    ['BUYER_SENT_FIAT_SENT_CONFIRMATION', TradeState.FIAT_SENT],
    ['BUYER_RECEIVED_SELLERS_FIAT_RECEIPT_CONFIRMATION', TradeState.FIAT_RECEIVED],
    ['BUYER_RECEIVED_BTC_SENT_CONFIRMATION', TradeState.BTC_RELEASED],
    ['BTC_CONFIRMED', TradeState.COMPLETE],
  ];
  for (const [raw, want] of seq) assert.equal(mapBisqState(raw), want, raw);
});

test('cancel/reject/failed states map to FAILED; unknowns map to null', () => {
  assert.equal(mapBisqState('BISQ_EASY_TRADE_CANCELLED'), TradeState.FAILED);
  assert.equal(mapBisqState('REJECTED_BY_PEER'), TradeState.FAILED);
  assert.equal(mapBisqState('MEDIATION_FAILED'), TradeState.FAILED);
  assert.equal(mapBisqState('SOME_UNKNOWN_INTERMEDIATE'), null);
  assert.ok(BISQ_STATE_MAP.length >= 6);
});

test('a DID_NOT_RECEIVED_ACCOUNT_DATA state must NOT read as awaiting payment', () => {
  // The safety property, unchanged: the map matches BUYER_RECEIVED_ACCOUNT_DATA
  // by substring, and the negated form ("DID_NOT_RECEIVED") must not trip it.
  // Telling someone to pay before the seller has sent bank details would be
  // the worst possible misread.
  const early = 'TAKER_RECEIVED_TAKE_OFFER_RESPONSE__BUYER_DID_NOT_SENT_BTC_ADDRESS__BUYER_DID_NOT_RECEIVED_ACCOUNT_DATA';
  assert.notEqual(mapBisqState(early), TradeState.AWAITING_FIAT_PAYMENT);

  // What changed: this used to return null, on the reasoning that ignoring a
  // transitional state leaves the live subscription at the last state it
  // emitted -- which is true, and was fine while the subscription was the
  // only consumer. Trade resume reads the same map with no "last state" to
  // fall back on, so null meant a trade the user may have paid for simply did
  // not appear. The state is now mapped to what it actually means: the
  // contract exists and we are waiting on the seller.
  assert.equal(mapBisqState(early), TradeState.OFFER_TAKEN);
});

// ---- Bitcoin address validation (bech32/bech32m checksum) ------------------
test('valid bech32/bech32m addresses pass, tampered ones fail', () => {
  // Canonical BIP173/350 test vectors.
  assert.ok(isValidBtcAddress('bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4', { network: 'mainnet' }));
  assert.ok(isValidBtcAddress('BC1QW508D6QEJXTDG4Y5R3ZARVARY0C5XW7KV8F3T4', { network: 'mainnet' })); // all-caps ok
  assert.ok(isValidBtcAddress('bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqzk5jj0', { network: 'mainnet' })); // taproot bech32m
  assert.ok(isValidBtcAddress('bcrt1qspikebuyerdestinationaddress000000000') === false); // spike placeholder is NOT valid
  // Single-char typo breaks the checksum.
  assert.equal(isValidBtcAddress('bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t5', { network: 'mainnet' }), false);
  // Wrong network is rejected.
  assert.equal(isValidBtcAddress('bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4', { network: 'regtest' }), false);
  assert.equal(isValidBtcAddress('', {}), false);
  assert.equal(isValidBtcAddress(null, {}), false);
});

test('ExternalWallet refuses a bad address at construction and getReceiveAddress returns a good one', async () => {
  assert.throws(() => new ExternalWallet({ address: 'not-an-address', network: 'mainnet' }), /invalid receive address/);
  const w = new ExternalWallet({ address: 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4', network: 'mainnet' });
  assert.equal(await w.getReceiveAddress(), 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4');
  const bal = await w.getBalance();
  assert.equal(bal.external, true);
  assert.equal(bal.confirmedSats, null);
  await assert.rejects(() => w.withdraw('bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4', 1000), /not available in external-wallet mode/);
});

// ---- SEPA free-text parsing (what Bisq Easy delivers) ----------------------
test('parses the seller free-text account data captured in the spike', () => {
  const p = parseSepaAccountData('Alice Spike, IBAN DE02 1203 0000 0000 2020 51 (SEPA)');
  assert.equal(p.iban, 'DE02120300000000202051');
  assert.equal(p.holderName, 'Alice Spike');
  assert.equal(p.ok, true);
  assert.equal(p.raw, 'Alice Spike, IBAN DE02 1203 0000 0000 2020 51 (SEPA)');
});

test('extracts BIC when present and still finds the IBAN', () => {
  const p = parseSepaAccountData('Bob Müller — IBAN NL91ABNA0417164300, BIC ABNANL2A');
  assert.equal(p.iban, 'NL91ABNA0417164300');
  assert.equal(p.bic, 'ABNANL2A');
  assert.ok(p.holderName.includes('Bob'));
});

test('IBAN sanity check accepts real formats and rejects junk', () => {
  assert.ok(looksLikeIban('DE02 1203 0000 0000 2020 51'));
  assert.ok(looksLikeIban('NL91ABNA0417164300'));
  assert.equal(looksLikeIban('DE02'), false);
  assert.equal(looksLikeIban('hello world'), false);
  assert.equal(normaliseIban('de02 1203'), 'DE021203');
});

// ---- EPC069-12 payload shape (shared with the mock) ------------------------
test('EPC payload has the fixed BIP-defined line order', () => {
  const payload = epcPayload({ receiverName: 'Alice Spike', iban: 'DE02120300000000202051', amountEur: 50, reference: '' });
  const lines = payload.split('\n');
  assert.deepEqual(lines.slice(0, 4), ['BCD', '002', '1', 'SCT']);
  assert.equal(lines[5], 'Alice Spike');
  assert.equal(lines[6], 'DE02120300000000202051');
  assert.equal(lines[7], 'EUR50.00');
});

// ---- adapter guardrails that don't need a node ----------------------------
test('BisqAdapter requires a wallet', () => {
  assert.throws(() => new BisqAdapter({}), /requires a wallet/);
});

test('a malformed pairing code fails clearly instead of connecting unauthenticated', async () => {
  // Pairing is implemented now (see docs/PAIRING_AUTH.md); what must never
  // happen is silently carrying on without credentials.
  const wallet = new ExternalWallet({ address: 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4', network: 'mainnet' });
  const a = new BisqAdapter({ wallet, pairingCode: 'ABC-123' });
  await assert.rejects(() => a.init(), /pairing|base64url|version/i);
});

test('no session means no auth headers — we never send half-credentials', () => {
  const wallet = new ExternalWallet({ address: 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4', network: 'mainnet' });
  const open = new BisqAdapter({ wallet });
  assert.equal(open._authHeaders(), undefined, 'an open node gets no headers');

  const paired = new BisqAdapter({ wallet, credentials: { clientId: 'cid', clientSecret: 's' } });
  assert.equal(paired._authHeaders(), undefined, 'credentials without a session are not enough');

  paired.sessionId = 'sid';
  assert.deepEqual(paired._authHeaders(), {
    'Bisq-Client-Id': 'cid',
    'Bisq-Session-Id': 'sid',
  });
});

test('listOffers returns [] for non-EUR fiat without touching the network', async () => {
  const wallet = new ExternalWallet({ address: 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4', network: 'mainnet' });
  const a = new BisqAdapter({ wallet });
  assert.deepEqual(await a.listOffers({ fiat: 'USD' }), []);
});

test('offer pricing: market/float/fix specs and amount ranges', () => {
  const wallet = new ExternalWallet({ address: 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4', network: 'mainnet' });
  const a = new BisqAdapter({ wallet });
  a.rate = 50000;
  assert.deepEqual(a._priceOffer({ priceSpec: { type: 'MarketPriceSpec' } }), { priceEurPerBtc: 50000, premiumPct: 0 });
  assert.deepEqual(a._priceOffer({ priceSpec: { type: 'FloatPriceSpec', percentage: 0.02 } }), { priceEurPerBtc: 51000, premiumPct: 2 });
  assert.equal(a._priceOffer({ priceSpec: { type: 'FixPriceSpec', value: 550000000 } }).priceEurPerBtc, 55000);
  assert.equal(a._priceOffer({ priceSpec: { type: 'WeirdUnknownSpec' } }).priceEurPerBtc, null);
  assert.deepEqual(a._amountRange({ amountSpec: { type: 'QuoteSideFixedAmountSpec', amount: 500000 } }), { minEur: 50, maxEur: 50 });
  assert.deepEqual(a._amountRange({ amountSpec: { type: 'RangeAmountSpec', minAmount: 250000, maxAmount: 2000000 } }), { minEur: 25, maxEur: 200 });
});

// The pattern app.js relies on since the receive address moved into the UI:
// the wallet asks for the address at the moment it needs one, so whatever the
// user typed in step 3 is what the seller is told to pay. A bug here sends
// someone's coins to the wrong address, so it gets its own test.
test('ExternalWallet addressProvider reads live UI state and re-validates every time', async () => {
  const ui = { receiveAddress: '' };
  const w = new ExternalWallet({ addressProvider: () => ui.receiveAddress, network: 'mainnet' });

  // Nothing typed yet: refuse rather than hand out a blank destination.
  await assert.rejects(() => w.getReceiveAddress(), /failed validation/);

  ui.receiveAddress = 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4';
  assert.equal(await w.getReceiveAddress(), ui.receiveAddress);

  // The provider is consulted on every call, so a later edit is picked up.
  ui.receiveAddress = 'bc1qrp33g0q5c5txsp9arysrx4k6zdkfs4nce4xj0gdcccefvpysxf3qccfmv3';
  assert.equal(await w.getReceiveAddress(), ui.receiveAddress);

  // And a wrong-chain address cannot sneak in on a later edit either.
  ui.receiveAddress = 'bcrt1qqv9pzxqlyckngw6zf9g9whn9d3eh4qvg0z9lm9';
  await assert.rejects(() => w.getReceiveAddress(), /failed validation/);
});

// ---- trade resume ---------------------------------------------------------

import { wsUrlForRestBase, isTerminalBisqState, WS_SUB_ID } from '../src/adapters/bisq-adapter.js';

/* These two URLs must address the same node. They did not: wsUrl had a fixed
 * default of port 8090 whatever restBaseUrl said, so a node on another port
 * served REST from itself and events from whatever was on 8090 -- and the
 * adapter reported that other node's trades as yours, without erroring. */
test('the WebSocket URL is derived from the REST base, not fixed', () => {
  assert.equal(wsUrlForRestBase('http://127.0.0.1:8091/api/v1'), 'ws://127.0.0.1:8091/websocket');
  assert.equal(wsUrlForRestBase('http://127.0.0.1:8090/api/v1/'), 'ws://127.0.0.1:8090/websocket');
  assert.equal(wsUrlForRestBase('http://127.0.0.1:9999/api/v1'), 'ws://127.0.0.1:9999/websocket');
});

test('a BisqAdapter built with only a REST base points both at the same node', () => {
  const a = new BisqAdapter({
    restBaseUrl: 'http://127.0.0.1:8091/api/v1',
    wallet: new ExternalWallet({ address: 'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu', network: 'mainnet' }),
  });
  assert.equal(a.wsUrl, 'ws://127.0.0.1:8091/websocket');
  assert.ok(a.wsUrl.includes('8091'), 'the event stream must follow the REST base');
});

test('the state a live node reports right after taking an offer is mapped', () => {
  // Captured verbatim from Bisq 2.1.11. It mapped to null, which made the
  // trade disappear from the resume list entirely.
  const raw = 'TAKER_RECEIVED_TAKE_OFFER_RESPONSE__BUYER_SENT_BTC_ADDRESS__BUYER_DID_NOT_RECEIVED_ACCOUNT_DATA';
  assert.equal(mapBisqState(raw), TradeState.OFFER_TAKEN);
  // And it must NOT be read as "the buyer has the account data": the needle
  // RECEIVED_ACCOUNT_DATA appears inside DID_NOT_RECEIVED_ACCOUNT_DATA.
  assert.notEqual(mapBisqState(raw), TradeState.AWAITING_FIAT_PAYMENT);
});

test('isTerminalBisqState covers finished and abandoned trades only', () => {
  for (const t of ['BTC_CONFIRMED', 'PEER_CANCELLED', 'REJECTED', 'FAILED_AT_PEER']) {
    assert.equal(isTerminalBisqState(t), true, t);
  }
  for (const t of ['TAKER_RECEIVED_TAKE_OFFER_RESPONSE__BUYER_SENT_BTC_ADDRESS',
                   'BUYER_SENT_FIAT_SENT_CONFIRMATION', 'INIT', '', null]) {
    assert.equal(isTerminalBisqState(t), false, String(t));
  }
});

/** An adapter with a pre-populated snapshot and no network. */
function adapterWithTrades(props) {
  const a = new BisqAdapter({
    wallet: new ExternalWallet({ address: 'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu', network: 'mainnet' }),
  });
  a.tradeSnapshotSeen = true;
  for (const [id, p] of Object.entries(props)) a.tradeProps.set(id, p);
  return a;
}

test('listOpenTrades retains released trades until local receipt is confirmed', async () => {
  const a = adapterWithTrades({
    done:  { tradeState: 'BTC_CONFIRMED', paymentAccountData: 'x' },
    gone:  { tradeState: 'PEER_CANCELLED' },
    live:  { tradeState: 'BUYER_SENT_FIAT_SENT_CONFIRMATION',
             paymentAccountData: 'Alice, IBAN DE02…', bitcoinPaymentData: 'bcrt1qabc' },
  });
  const open = await a.listOpenTrades();
  assert.deepEqual(open.map(t => [t.id, t.state]), [['done', TradeState.BTC_RELEASED], ['live', TradeState.FIAT_SENT]]);
  assert.equal(open[1].sellerDetails, 'Alice, IBAN DE02…');
  assert.equal(open[1].receiveAddress, 'bcrt1qabc');
  a.btcReceiptSent.add('done');
  assert.deepEqual((await a.listOpenTrades()).map(t => t.id), ['live']);
});

/* The failure that matters most here. Bisq's state strings are compound and
 * there are more of them than we map. Dropping a trade we cannot label would
 * hide a trade the user may already have paid for. */
test('a trade whose state we cannot map is still listed, not silently dropped', async () => {
  const a = adapterWithTrades({
    weird: { tradeState: 'SOME_STATE_NOBODY_HAS_SEEN_YET', paymentAccountData: 'Alice' },
  });
  const open = await a.listOpenTrades();
  assert.equal(open.length, 1, 'an unmappable trade must never vanish');
  assert.equal(open[0].state, null, 'and must not be given an invented state');
  assert.equal(open[0].rawState, 'SOME_STATE_NOBODY_HAS_SEEN_YET');
});

test('a trade with no state at all is skipped', async () => {
  const a = adapterWithTrades({ empty: { paymentAccountData: 'Alice' } });
  assert.equal((await a.listOpenTrades()).length, 0);
});

test('the subscription id is the one the snapshot is matched against', () => {
  assert.equal(WS_SUB_ID, 'sub-props');
});
