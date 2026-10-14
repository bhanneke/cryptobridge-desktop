/* Offers come from the seller's client, which can be modified. These are the
 * offers a malicious seller could publish, kept as permanent regressions. All
 * seven reached the UI before this check existed. */
import test from 'node:test';
import assert from 'node:assert/strict';

import { offerRejection, clampDeviation, DEFAULT_MAX_DEVIATION } from '../src/adapters/offer-checks.js';
import { BisqAdapter } from '../src/adapters/bisq-adapter.js';
import { ExternalWallet } from '../src/adapters/wallet.js';

const ctx = { rate: 60000, maxDeviation: 0.05 };
const good = { priceEurPerBtc: 60000, minEur: 250, maxEur: 250 };

test('an ordinary market-price offer is shown', () => {
  assert.equal(offerRejection(good, ctx), null);
});

test('prices that are not positive real numbers are hidden', () => {
  for (const price of [-60000, 0, NaN, Infinity, -Infinity, null, undefined, '60000']) {
    assert.ok(offerRejection({ ...good, priceEurPerBtc: price }, ctx), `showed price ${String(price)}`);
  }
});

test('amounts that are not positive real numbers are hidden', () => {
  for (const bad of [{ minEur: -250, maxEur: -250 }, { minEur: 0, maxEur: 250 }, { minEur: 250, maxEur: NaN }]) {
    assert.ok(offerRejection({ ...good, ...bad }, ctx), `showed ${JSON.stringify(bad)}`);
  }
});

test('a minimum above the maximum is hidden', () => {
  assert.match(offerRejection({ ...good, minEur: 900, maxEur: 0.01 }, ctx), /above the maximum/);
});

/* The realistic attack: a "99% discount" made our app say €250 buys
 * 0.4167 BTC, a hundred times the real amount, and sort it first. */
test('a bait price far below market is hidden', () => {
  assert.match(offerRejection({ ...good, priceEurPerBtc: 600 }, ctx), /below market/);
});

test('the below-market limit is the node owner\'s own setting', () => {
  const fourPctBelow = { ...good, priceEurPerBtc: 57600 };   // -4%
  assert.equal(offerRejection(fourPctBelow, { rate: 60000, maxDeviation: 0.05 }), null, 'inside 5%');
  assert.ok(offerRejection(fourPctBelow, { rate: 60000, maxDeviation: 0.03 }), 'outside 3%');
});

test('premiums above market are shown, however large', () => {
  // Sellers charge them for no-KYC trades and the buyer sees the percentage.
  assert.equal(offerRejection({ ...good, priceEurPerBtc: 69000 }, ctx), null);   // +15%
});

test('without a market rate the deviation cannot be judged, but sanity checks still apply', () => {
  assert.equal(offerRejection(good, { rate: null, maxDeviation: 0.05 }), null);
  assert.ok(offerRejection({ ...good, priceEurPerBtc: -1 }, { rate: null, maxDeviation: 0.05 }));
});

test('a deviation setting outside Bisq\'s 1%-10% range falls back to the default, never wider', () => {
  for (const v of [0, 0.5, 1, -0.05, NaN, null, undefined, 'abc']) {
    assert.equal(clampDeviation(v), DEFAULT_MAX_DEVIATION, `accepted ${String(v)}`);
  }
  assert.equal(clampDeviation(0.08), 0.08);
  assert.equal(clampDeviation(0.01), 0.01);
  assert.equal(clampDeviation(0.10), 0.10);
});

// ---- end to end through the adapter ---------------------------------------

function adapterWith(offers) {
  const a = new BisqAdapter({ wallet: new ExternalWallet({ address: 'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu', network: 'mainnet' }) });
  a.rate = 60000;
  a.maxTradePriceDeviation = 0.05;
  a._req = async () => ({ data: offers });
  return a;
}
const pm = { quoteSidePaymentMethodSpecs: [{ paymentMethod: 'SEPA' }], baseSidePaymentMethodSpecs: [{ paymentMethod: 'MAIN_CHAIN' }] };
const offer = (id, priceSpec, amountSpec = { type: 'QuoteSideFixedAmountSpec', amount: 2500000 }) => ({
  bisqEasyOffer: { id, direction: 'SELL', priceSpec, amountSpec, ...pm },
  userProfile: { nickName: id }, reputationScore: { totalScore: 0, fiveSystemScore: 0 },
});

test('of the seven crafted offers, only the honest one reaches the UI', async () => {
  const out = await adapterWith([
    offer('honest', { type: 'MarketPriceSpec' }),
    offer('negative-fix', { type: 'FixPriceSpec', priceQuote: { value: -600000000 } }),
    offer('zero-fix', { type: 'FixPriceSpec', priceQuote: { value: 0 } }),
    offer('float-minus-99', { type: 'FloatPriceSpec', percentage: -0.99 }),
    offer('float-nan', { type: 'FloatPriceSpec', percentage: 'abc' }),
    offer('neg-amount', { type: 'MarketPriceSpec' }, { type: 'QuoteSideFixedAmountSpec', amount: -2500000 }),
    offer('min>max', { type: 'MarketPriceSpec' }, { type: 'RangeAmountSpec', minAmount: 9000000, maxAmount: 100 }),
  ]).listOffers({ fiat: 'EUR' });
  assert.deepEqual(out.map((o) => o.maker), ['honest']);
});
