/* Bisq 2 trade spike: full Bisq Easy BTC/EUR SEPA trade over the REST API.
   Two headless api-app nodes (seller :8090 with devModeReputationScore,
   buyer :8091) on a local clearnet seed. Run: node spike-trade.js
   Evidence (every request/response + WS frames) → spike-evidence.json */

import { writeFile } from 'node:fs/promises';

const SELLER = 'http://127.0.0.1:8090/api/v1';
const BUYER  = 'http://127.0.0.1:8091/api/v1';
const BUYER_WS = 'ws://127.0.0.1:8091/websocket';

const EUR_AMOUNT = 500_000;          // €50.00 — fiat longs use precision 4
const evidence = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const ok = (cond, msg) => {
  console.log((cond ? 'PASS: ' : 'FAIL: ') + msg);
  if (!cond) failures++;
};

async function api(base, method, path, body) {
  const res = await fetch(base + path, {
    method,
    headers: body !== undefined ? { 'content-type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data; try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  evidence.push({ node: base.includes('8090') ? 'seller' : 'buyer', method, path, request: body ?? null, status: res.status, response: data });
  return { status: res.status, data };
}

// ---- 0. WebSocket: subscribe to buyer's TRADES + TRADE_PROPERTIES ----------
const wsFrames = [];
function openWs() {
  return new Promise((resolve) => {
    const ws = new WebSocket(BUYER_WS);
    ws.onopen = () => {
      // "type" must be the server-side class simple name (dispatch convention)
      ws.send(JSON.stringify({ type: 'SubscriptionRequest', requestId: 'sub-trades', topic: 'TRADES', parameter: null }));
      ws.send(JSON.stringify({ type: 'SubscriptionRequest', requestId: 'sub-props', topic: 'TRADE_PROPERTIES', parameter: null }));
      resolve(ws);
    };
    ws.onmessage = (e) => { if (wsFrames.length < 300) wsFrames.push(String(e.data)); };
    ws.onerror = (e) => { console.log('WS error', e?.message ?? ''); resolve(null); };
  });
}

// ---- 1. Identities ---------------------------------------------------------
async function ensureIdentity(base, nickName) {
  const ids = await api(base, 'GET', '/user-identities/ids');
  if (Array.isArray(ids.data) && ids.data.length > 0) return ids.data[0];
  const km = await api(base, 'GET', '/user-identities/key-material');
  const created = await api(base, 'POST', '/user-identities', {
    nickName, terms: '', statement: '', keyMaterialResponse: km.data,
  });
  return created.data?.userProfile?.id ?? created.data?.userProfile?.nym ?? null;
}

const ws = await openWs();
const sellerId = await ensureIdentity(SELLER, 'spike_seller');
const buyerId  = await ensureIdentity(BUYER, 'spike_buyer');
ok(!!sellerId, `seller identity: ${sellerId}`);
ok(!!buyerId,  `buyer identity: ${buyerId}`);

// ---- 2. Seller SEPA payment account ---------------------------------------
// NB: POST /payment-accounts takes CreatePaymentAccountDto directly — the
// AddFiatAccountRequest wrapper class in the repo is NOT the request body.
const acct = await api(SELLER, 'POST', '/payment-accounts', {
  accountName: 'Spike SEPA',
  paymentRail: 'SEPA',
  accountPayload: {
    selectedCountryCode: 'DE',
    acceptedCountryCodes: ['DE', 'AT', 'FR', 'NL', 'ES', 'IT'],
    holderName: 'Alice Spike',
    iban: 'DE02120300000000202051',
    bic: 'BYLADEM1001',
  },
});
ok(acct.status < 300, `seller SEPA account created (HTTP ${acct.status})`);

// ---- 3. Seller creates a SELL BTC for EUR offer at market price ------------
const offer = await api(SELLER, 'POST', '/offerbook/offers', {
  direction: 'SELL',
  market: { baseCurrencyCode: 'BTC', quoteCurrencyCode: 'EUR', baseCurrencyName: 'Bitcoin', quoteCurrencyName: 'Euro' },
  bitcoinPaymentMethods: ['MAIN_CHAIN'],
  fiatPaymentMethods: ['SEPA'],
  amountSpec: { type: 'QuoteSideFixedAmountSpec', amount: EUR_AMOUNT },
  priceSpec: { type: 'MarketPriceSpec' },
  supportedLanguageCodes: ['en'],
});
const offerId = offer.data?.offerId;
ok(!!offerId, `seller offer created: ${offerId} (HTTP ${offer.status})`);
if (!offerId) { await bail(); }

// ---- 4. Buyer sees the offer via P2P gossip --------------------------------
let seen = null;
for (let i = 0; i < 40 && !seen; i++) {
  const list = await api(BUYER, 'GET', '/offerbook/markets/EUR/offers');
  seen = (Array.isArray(list.data) ? list.data : []).find((o) =>
    JSON.stringify(o).includes(offerId));
  if (!seen) await sleep(2000);
}
ok(!!seen, 'buyer sees the offer in its EUR offerbook');
if (!seen) { await bail(); }

// ---- 5. Buyer takes the offer ----------------------------------------------
const quotes = await api(BUYER, 'GET', '/market-price/quotes');
const eurQuote = quotes.data?.quotes?.EUR?.value;
ok(!!eurQuote, `EUR market price available: ${eurQuote}`);
const baseSideAmount = Math.round((EUR_AMOUNT / eurQuote) * 1e8); // sats

const take = await api(BUYER, 'POST', '/trades', {
  offerId,
  baseSideAmount,
  quoteSideAmount: EUR_AMOUNT,
  bitcoinPaymentMethod: 'MAIN_CHAIN',
  fiatPaymentMethod: 'SEPA',
});
const tradeId = take.data?.tradeId;
ok(!!tradeId, `buyer took offer, trade id: ${tradeId} (HTTP ${take.status})`);
if (!tradeId) { await bail(); }

// ---- 6. Walk the trade state machine on both sides -------------------------
// PATCH is retried because each event is only legal in its phase and the
// peer's message must propagate between phases.
async function tradeEvent(base, who, type, data = null, tries = 25) {
  for (let i = 0; i < tries; i++) {
    const res = await api(base, 'PATCH', `/trades/${encodeURIComponent(tradeId)}/event`,
      { tradeEventType: type, data });
    if (res.status < 300) { ok(true, `${who}: ${type} accepted (HTTP ${res.status})`); return true; }
    await sleep(2000);
  }
  ok(false, `${who}: ${type} never accepted after ${tries} attempts`);
  return false;
}

await sleep(4000); // let the trade contract reach the seller node
await tradeEvent(SELLER, 'seller', 'SELLER_SENDS_PAYMENT_ACCOUNT',
  'Alice Spike, IBAN DE02 1203 0000 0000 2020 51 (SEPA)');
await tradeEvent(BUYER, 'buyer', 'BUYER_SEND_BITCOIN_PAYMENT_DATA',
  'bcrt1qspikebuyerdestinationaddress000000000');
await tradeEvent(BUYER, 'buyer', 'BUYER_CONFIRM_FIAT_SENT');
await tradeEvent(SELLER, 'seller', 'SELLER_CONFIRM_FIAT_RECEIPT');
await tradeEvent(SELLER, 'seller', 'SELLER_CONFIRM_BTC_SENT',
  'f00dbabe00000000000000000000000000000000000000000000000000000000');
await tradeEvent(BUYER, 'buyer', 'BTC_CONFIRMED');
await tradeEvent(BUYER, 'buyer', 'CLOSE_TRADE');
await tradeEvent(SELLER, 'seller', 'CLOSE_TRADE');

await sleep(3000); // collect trailing WS frames
await bail();

async function bail() {
  try { ws?.close(); } catch {}
  const tradeFrames = wsFrames.filter((f) => tradeId && f.includes(tradeId));
  evidence.push({ wsFrameCount: wsFrames.length, tradeRelatedFrames: tradeFrames.slice(0, 40) });
  await writeFile(new URL('./spike-evidence.json', import.meta.url),
    JSON.stringify(evidence, null, 2));
  console.log(`\nWS frames: ${wsFrames.length} total, ${tradeFrames.length} trade-related`);
  console.log(failures === 0 ? '\nSPIKE TRADE COMPLETE — all steps accepted.'
                             : `\n${failures} failure(s) — see spike-evidence.json`);
  process.exit(failures === 0 ? 0 : 1);
}
