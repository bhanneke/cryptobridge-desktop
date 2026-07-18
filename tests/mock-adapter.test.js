/* Unit tests for the MockAdapter — runs with `npm test` (node:test, no deps). */
import test from 'node:test';
import assert from 'node:assert/strict';
import { MockAdapter } from '../src/adapters/mock-adapter.js';
import { TradeState } from '../src/adapters/onramp-adapter.js';

const fastAdapter = async () => {
  const a = new MockAdapter({ latencyScale: 0.01 });
  await a.init();
  return a;
};

test('init connects and reports backend info', async () => {
  const a = await fastAdapter();
  const info = a.getBackendInfo();
  assert.equal(info.backend, 'mock');
  assert.equal(info.network, 'regtest');
  assert.equal(info.asset, 'BTC');
  assert.ok(info.rateEurPerBtc > 0);

  let last;
  const unsub = a.subscribeStatus((s) => { last = s; });
  assert.equal(last.status, 'connected'); // fires immediately with current status
  unsub();
});

test('offer book is EUR-only and priced above the indicative rate', async () => {
  const a = await fastAdapter();
  const offers = await a.listOffers({ fiat: 'EUR', direction: 'buy' });
  assert.ok(offers.length >= 3);
  const rate = a.getBackendInfo().rateEurPerBtc;
  for (const o of offers) {
    assert.ok(o.priceEurPerBtc > rate, `${o.id} must include a premium`);
    assert.ok(o.minEur < o.maxEur);
    assert.match(o.paymentMethod, /^SEPA/);
  }
  assert.deepEqual(await a.listOffers({ fiat: 'USD' }), []);
});

test('full trade lifecycle walks every state and credits the wallet', async () => {
  const a = await fastAdapter();
  const [offer] = await a.listOffers({ fiat: 'EUR' });
  const trade = await a.takeOffer(offer.id, { fiatAmountEur: 500 });
  assert.equal(trade.state, TradeState.OFFER_TAKEN);
  assert.ok(trade.btcAmountSats > 0);

  const states = [];
  await new Promise((resolve) => {
    a.subscribeTrade(trade.id, (s) => {
      states.push(s);
      if (s === TradeState.AWAITING_FIAT_PAYMENT) a.confirmFiatSent(trade.id);
      if (s === TradeState.COMPLETE) resolve();
    });
  });
  assert.deepEqual(states, [
    TradeState.OFFER_TAKEN,           // immediate replay of current state
    TradeState.AWAITING_FIAT_PAYMENT,
    TradeState.FIAT_SENT,
    TradeState.FIAT_RECEIVED,
    TradeState.BTC_RELEASED,
    TradeState.COMPLETE,
  ]);

  const bal = await a.getWalletBalance();
  assert.equal(bal.confirmedSats, trade.btcAmountSats);
  // Valued at the indicative rate, the estimate sits just under the 500 €
  // paid — the difference is the maker's premium.
  assert.ok(bal.fiatEstimateEur > 400 && bal.fiatEstimateEur < 500, String(bal.fiatEstimateEur));
});

test('payment instructions carry a well-formed EPC069-12 payload', async () => {
  const a = await fastAdapter();
  const [offer] = await a.listOffers({ fiat: 'EUR' });
  const trade = await a.takeOffer(offer.id, { fiatAmountEur: 123.45 });
  const p = await a.getPaymentInstructions(trade.id);

  assert.ok(p.iban.length > 15);
  assert.ok(p.reference.includes(trade.id.toUpperCase()));
  const lines = p.epcQrPayload.split('\n');
  assert.deepEqual(lines.slice(0, 4), ['BCD', '002', '1', 'SCT']);
  assert.equal(lines[6], p.iban.replace(/\s+/g, ''));
  assert.equal(lines[7], 'EUR123.45');
  assert.equal(lines[10], p.reference);
});

test('confirmFiatSent is rejected outside AWAITING_FIAT_PAYMENT', async () => {
  const a = await fastAdapter();
  const [offer] = await a.listOffers({ fiat: 'EUR' });
  const trade = await a.takeOffer(offer.id, { fiatAmountEur: 200 });
  // state is OFFER_TAKEN right now — paying already must fail
  await assert.rejects(() => a.confirmFiatSent(trade.id), /cannot confirm fiat sent/);
});

test('withdraw debits the wallet and rejects overdrafts', async () => {
  const a = await fastAdapter();
  a.seedWallet(1000);
  const before = await a.getWalletBalance();
  assert.ok(before.confirmedSats > 0);

  const txid = await a.withdraw('bcrt1qsomewhere', 50_000);
  assert.match(txid, /^mocktx-/);
  const after = await a.getWalletBalance();
  assert.equal(after.confirmedSats, before.confirmedSats - 50_000);

  await assert.rejects(() => a.withdraw('bcrt1qsomewhere', 10 ** 12), /insufficient/);
});
