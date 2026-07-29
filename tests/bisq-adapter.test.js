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
  // The map matches BUYER_RECEIVED_ACCOUNT_DATA by substring; the negated form
  // ("DID_NOT_RECEIVED") must not trip it. It is a transitional state we ignore
  // (null) — the trade correctly stays at whatever was last emitted (OFFER_TAKEN).
  const early = 'TAKER_RECEIVED_TAKE_OFFER_RESPONSE__BUYER_DID_NOT_SENT_BTC_ADDRESS__BUYER_DID_NOT_RECEIVED_ACCOUNT_DATA';
  assert.equal(mapBisqState(early), null);
  assert.notEqual(mapBisqState(early), TradeState.AWAITING_FIAT_PAYMENT);
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

test('authenticated (pairing) mode is refused until implemented', async () => {
  const wallet = new ExternalWallet({ address: 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4', network: 'mainnet' });
  const a = new BisqAdapter({ wallet, pairingCode: 'ABC-123' });
  await assert.rejects(() => a.init(), /pairing.*not implemented/i);
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
