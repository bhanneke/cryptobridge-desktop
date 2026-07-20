/* Contract test for BisqAdapter against a live Bisq 2 spike environment.
 *
 * SKELETON. Runs only when BISQ_API_URL is set (otherwise it is a no-op so it
 * never breaks CI without a node). Bring up the environment from spike/bisq2/
 * (seed + seller + buyer api-apps), then:
 *
 *   BISQ_API_URL=http://127.0.0.1:8091/api/v1 \
 *   BISQ_WS_URL=ws://127.0.0.1:8091/websocket \
 *   node tests/bisq-adapter.contract.js
 *
 * It should replay the BUYER half of the spike trade through the adapter and
 * assert the mapped TradeState sequence:
 *   OFFER_TAKEN → AWAITING_FIAT_PAYMENT → FIAT_SENT → FIAT_RECEIVED
 *   → BTC_RELEASED → COMPLETE
 * (A counterpart SELL offer must exist — reuse spike/bisq2/spike-trade.js to
 *  create the seller offer, or drive the seller side here.) */

import { mapBisqState, BISQ_STATE_MAP } from '../src/adapters/bisq-adapter.js';
import { TradeState } from '../src/adapters/onramp-adapter.js';
import assert from 'node:assert/strict';

const API = process.env.BISQ_API_URL;

// --- Pure mapping checks run everywhere (no node needed) --------------------
function testStateMapping() {
  assert.equal(mapBisqState('TAKER_SENT_TAKE_OFFER_REQUEST'), TradeState.OFFER_TAKEN);
  assert.equal(
    mapBisqState('TAKER_RECEIVED_TAKE_OFFER_RESPONSE__BUYER_SENT_BTC_ADDRESS__BUYER_RECEIVED_ACCOUNT_DATA'),
    TradeState.AWAITING_FIAT_PAYMENT);
  assert.equal(mapBisqState('BUYER_SENT_FIAT_SENT_CONFIRMATION'), TradeState.FIAT_SENT);
  assert.equal(mapBisqState('BUYER_RECEIVED_SELLERS_FIAT_RECEIPT_CONFIRMATION'), TradeState.FIAT_RECEIVED);
  assert.equal(mapBisqState('BUYER_RECEIVED_BTC_SENT_CONFIRMATION'), TradeState.BTC_RELEASED);
  assert.equal(mapBisqState('BTC_CONFIRMED'), TradeState.COMPLETE);
  assert.equal(mapBisqState('BISQ_EASY_TRADE_CANCELLED'), TradeState.FAILED);
  assert.equal(mapBisqState('SOME_UNKNOWN_INTERMEDIATE'), null);
  assert.ok(BISQ_STATE_MAP.length >= 6);
  console.log('PASS: Bisq→TradeState mapping');
}

testStateMapping();

if (!API) {
  console.log('SKIP: live contract test (set BISQ_API_URL to run against spike/bisq2/)');
  process.exit(0);
}

// --- Live trade replay (implement alongside the adapter) --------------------
// TODO once BisqAdapter is implemented:
//   const wallet = makeStubWallet();            // external-wallet mode
//   const adapter = new BisqAdapter({ restBaseUrl: API, wsUrl: process.env.BISQ_WS_URL, wallet });
//   await adapter.init();
//   const [offer] = await adapter.listOffers({ fiat: 'EUR', direction: 'buy' });
//   const trade = await adapter.takeOffer(offer.id, { fiatAmountEur: 50 });
//   const seen = [];
//   adapter.subscribeTrade(trade.id, (s) => seen.push(s));
//   ... drive seller side (spike script) + adapter.confirmFiatSent ...
//   assert.deepEqual(dedupe(seen), [
//     TradeState.OFFER_TAKEN, TradeState.AWAITING_FIAT_PAYMENT, TradeState.FIAT_SENT,
//     TradeState.FIAT_RECEIVED, TradeState.BTC_RELEASED, TradeState.COMPLETE,
//   ]);
//   await adapter.close();
console.log('TODO: live trade replay not yet implemented (adapter is a scaffold)');
