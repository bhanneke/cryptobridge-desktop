/* Live contract test: drive a real Bisq Easy trade through the BisqAdapter.
 *
 * Pure logic (state mapping, address validation, SEPA parsing, pricing) is
 * covered in bisq-adapter.test.js and runs in CI. THIS file needs a running
 * Bisq 2 network and is therefore gated on BISQ_API_URL — it is a no-op
 * otherwise, so it never breaks CI without a node.
 *
 * Bring up the spike environment (seed + seller :8090 + buyer :8091) from
 * spike/bisq2/ (see spike/bisq2/README.md), then:
 *
 *   BISQ_API_URL=http://127.0.0.1:8091/api/v1 \
 *   BISQ_WS_URL=ws://127.0.0.1:8091/websocket \
 *   BISQ_SELLER_URL=http://127.0.0.1:8090/api/v1 \
 *   node tests/bisq-adapter.contract.js
 *
 * The buyer half runs entirely through the adapter; the seller half is driven
 * over raw REST (same calls the spike proved) to provide a counterpart. We
 * assert the adapter emits the mapped TradeState sequence end to end:
 *   OFFER_TAKEN → AWAITING_FIAT_PAYMENT → FIAT_SENT → FIAT_RECEIVED
 *   → BTC_RELEASED → COMPLETE
 */

import assert from 'node:assert/strict';
import { BisqAdapter } from '../src/adapters/bisq-adapter.js';
import { ExternalWallet } from '../src/adapters/wallet.js';
import { TradeState } from '../src/adapters/onramp-adapter.js';

const BUYER = process.env.BISQ_API_URL;
const BUYER_WS = process.env.BISQ_WS_URL || (BUYER && BUYER.replace(/^http/, 'ws').replace(/\/api\/v1$/, '/websocket'));
const SELLER = process.env.BISQ_SELLER_URL || 'http://127.0.0.1:8090/api/v1';

// A valid regtest receive address (real bech32 checksum) for external-wallet mode.
const BUYER_ADDRESS = 'bcrt1qqv9pzxqlyckngw6zf9g9whn9d3eh4qvg0z9lm9';
const EUR = 50;                    // €50 buy
const EUR_LONG = EUR * 1e4;

if (!BUYER) {
  console.log('SKIP: live contract test (set BISQ_API_URL to run against spike/bisq2/)');
  process.exit(0);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- seller side: raw REST (the counterpart the adapter trades against) -----
async function sellerApi(method, path, body) {
  const res = await fetch(SELLER + path, {
    method,
    headers: body !== undefined ? { 'content-type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data; try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { status: res.status, data };
}

async function ensureSellerIdentity() {
  const ids = await sellerApi('GET', '/user-identities/ids');
  if (Array.isArray(ids.data) && ids.data.length) return ids.data[0];
  const km = await sellerApi('GET', '/user-identities/key-material');
  await sellerApi('POST', '/user-identities', { nickName: 'contract_seller', terms: '', statement: '', keyMaterialResponse: km.data });
}

async function sellerCreateOffer() {
  await sellerApi('POST', '/payment-accounts', {
    accountName: 'Contract SEPA', paymentRail: 'SEPA',
    accountPayload: { selectedCountryCode: 'DE', acceptedCountryCodes: ['DE', 'AT', 'FR', 'NL'], holderName: 'Alice Contract', iban: 'DE02120300000000202051', bic: 'BYLADEM1001' },
  });
  const offer = await sellerApi('POST', '/offerbook/offers', {
    direction: 'SELL',
    market: { baseCurrencyCode: 'BTC', quoteCurrencyCode: 'EUR', baseCurrencyName: 'Bitcoin', quoteCurrencyName: 'Euro' },
    bitcoinPaymentMethods: ['MAIN_CHAIN'], fiatPaymentMethods: ['SEPA'],
    amountSpec: { type: 'QuoteSideFixedAmountSpec', amount: EUR_LONG },
    priceSpec: { type: 'MarketPriceSpec' }, supportedLanguageCodes: ['en'],
  });
  return offer.data?.offerId;
}

async function sellerEvent(tradeId, type, data = null, tries = 25) {
  for (let i = 0; i < tries; i++) {
    const res = await sellerApi('PATCH', `/trades/${encodeURIComponent(tradeId)}/event`, { tradeEventType: type, data });
    if (res.status < 300) return true;
    await sleep(2000);
  }
  throw new Error(`seller ${type} never accepted`);
}

// --- the test ---------------------------------------------------------------
async function run() {
  console.log('Bringing up seller counterpart…');
  await ensureSellerIdentity();
  const offerId = await sellerCreateOffer();
  assert.ok(offerId, 'seller created an offer');
  console.log('  seller offer:', offerId);

  const wallet = new ExternalWallet({ address: BUYER_ADDRESS, network: 'regtest' });
  const adapter = new BisqAdapter({
    restBaseUrl: BUYER, wsUrl: BUYER_WS, wallet, network: 'regtest',
    nickName: 'contract_buyer', autoConfirmBtcReceipt: true,   // drive to COMPLETE unattended
  });
  await adapter.init();
  console.log('  buyer adapter connected, rate €/BTC:', adapter.getBackendInfo().rateEurPerBtc);

  // Wait for the offer to gossip to the buyer, then take it via the adapter.
  let offer = null;
  for (let i = 0; i < 40 && !offer; i++) {
    const offers = await adapter.listOffers({ fiat: 'EUR', direction: 'buy' });
    offer = offers.find((o) => o.id === offerId);
    if (!offer) await sleep(2000);
  }
  assert.ok(offer, 'buyer sees the seller offer through the adapter');
  console.log('  buyer sees offer at €/BTC:', offer.priceEurPerBtc);

  const seen = [];
  const trade = await adapter.takeOffer(offerId, { fiatAmountEur: EUR });
  adapter.subscribeTrade(trade.id, (state) => { if (seen[seen.length - 1] !== state) seen.push(state); });
  console.log('  took offer, tradeId:', trade.id);

  // Seller delivers SEPA account data (buyer receives it → AWAITING_FIAT_PAYMENT).
  await sleep(4000);
  await sellerEvent(trade.id, 'SELLER_SENDS_PAYMENT_ACCOUNT', 'Alice Contract, IBAN DE02 1203 0000 0000 2020 51 (SEPA)');

  // Wait until the adapter reports AWAITING_FIAT_PAYMENT, then read instructions
  // and confirm the SEPA transfer as the buyer would.
  for (let i = 0; i < 30 && !seen.includes(TradeState.AWAITING_FIAT_PAYMENT); i++) await sleep(1000);
  assert.ok(seen.includes(TradeState.AWAITING_FIAT_PAYMENT), 'reached AWAITING_FIAT_PAYMENT');

  const instr = await adapter.getPaymentInstructions(trade.id);
  assert.equal(instr.iban, 'DE02120300000000202051', 'parsed IBAN from seller account data');
  assert.match(instr.epcQrPayload, /^BCD\n002\n1\nSCT/, 'built an EPC069-12 QR payload');
  console.log('  payment instructions parsed:', instr.receiverName, instr.iban);

  await adapter.confirmFiatSent(trade.id);

  // Seller confirms receipt + BTC sent; adapter auto-confirms receipt → COMPLETE.
  await sellerEvent(trade.id, 'SELLER_CONFIRM_FIAT_RECEIPT');
  await sellerEvent(trade.id, 'SELLER_CONFIRM_BTC_SENT', 'f00dbabe' + '0'.repeat(56));

  for (let i = 0; i < 40 && !seen.includes(TradeState.COMPLETE); i++) await sleep(1000);
  await adapter.close();

  console.log('  observed states:', seen.join(' → '));
  const expected = [
    TradeState.OFFER_TAKEN, TradeState.AWAITING_FIAT_PAYMENT, TradeState.FIAT_SENT,
    TradeState.FIAT_RECEIVED, TradeState.BTC_RELEASED, TradeState.COMPLETE,
  ];
  for (const s of expected) assert.ok(seen.includes(s), `missing state ${s}`);
  // Order must be monotonic (no regressions).
  const idx = expected.map((s) => seen.indexOf(s));
  for (let i = 1; i < idx.length; i++) assert.ok(idx[i] > idx[i - 1], `state ${expected[i]} out of order`);

  console.log('\nCONTRACT TEST PASSED — full buyer-side trade through the adapter.');
  process.exit(0);
}

run().catch((e) => { console.error('\nCONTRACT TEST FAILED:', e.message); process.exit(1); });
