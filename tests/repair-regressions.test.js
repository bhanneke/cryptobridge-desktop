import test from 'node:test';
import assert from 'node:assert/strict';
import { BisqAdapter, WS_SUB_ID } from '../src/adapters/bisq-adapter.js';
import { TradeState } from '../src/adapters/onramp-adapter.js';
import { credentialStore, tradeStore } from '../src/adapters/storage.js';

const node = 'http://127.0.0.1:8090/api/v1';
const memory = () => {
  const m = new Map();
  return { getItem: k => m.get(k) ?? null, setItem: (k, v) => m.set(k, v), removeItem: k => m.delete(k) };
};
const address = 'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu';
const wallet = { getReceiveAddress: async () => address };
const snapshot = state => JSON.stringify({ type: 'SubscriptionResponse', requestId: WS_SUB_ID,
  payload: [{ t: { tradeState: state, paymentAccountData: 'Alice, IBAN DE02120300000000202051 (SEPA)', bitcoinPaymentData: address } }] });
function buyer(opts = {}) {
  const a = new BisqAdapter({ wallet, ...opts });
  a.checkPrivacy = async () => ({ level: 'ok' });
  a.offerCache.set('o', { minEur: 1, maxEur: 1000, priceEurPerBtc: 100000 });
  a._maybeSendBtcAddress = () => {};
  return a;
}

test('a failed wallet operation makes no trade and remains safe to retry', async () => {
  let posts = 0;
  const a = buyer({ wallet: { getReceiveAddress: async () => { throw Error('disk full'); } } });
  a._req = async () => { posts++; return { data: { tradeId: 't' } }; };
  for (let i = 0; i < 2; i++) await assert.rejects(a.takeOffer('o', { fiatAmountEur: 100 }), /disk full/);
  assert.equal(posts, 0);
});

test('trade amount and original address survive a fresh adapter and node snapshot', async () => {
  const store = tradeStore(node, 'mainnet', memory());
  const a = buyer({ tradeStore: store });
  a._req = async () => ({ data: { tradeId: 't' } });
  await a.takeOffer('o', { fiatAmountEur: 100 });
  const b = buyer({ tradeStore: store, wallet: { getReceiveAddress: () => { throw Error('must not derive on resume'); } } });
  b._restore();
  b._onWsFrame(snapshot('BUYER_RECEIVED_ACCOUNT_DATA'));
  const [t] = await b.listOpenTrades();
  assert.equal(t.fiatAmountEur, 100);
  assert.equal(t.btcAmountSats, 100000);
  assert.equal(t.receiveAddress, address);
  const p = await b.getPaymentInstructions('t');
  assert.equal(p.amountEur, 100);
  assert.equal(p.epcQrPayload.split('\n')[7], 'EUR100.00');
});

test('older trades with no saved amount stay visible and cannot produce a payment QR', async () => {
  const a = buyer();
  a._onWsFrame(snapshot('BUYER_RECEIVED_ACCOUNT_DATA'));
  const p = await a.getPaymentInstructions('t');
  assert.match(p.verificationError, /amount is missing/);
  assert.equal(p.epcQrPayload, null);
  assert.equal((await a.listOpenTrades()).length, 1);
});

test('a node-completed trade remains resumable until receipt is confirmed locally', async () => {
  const a = buyer();
  a._onWsFrame(snapshot('BTC_CONFIRMED'));
  assert.equal((await a.listOpenTrades())[0].state, TradeState.BTC_RELEASED);
});

test('uncertain POST is persisted before sending and prevents another POST after restart', async () => {
  const store = tradeStore(node, 'mainnet', memory());
  let posts = 0;
  const a = buyer({ tradeStore: store });
  a._req = async () => {
    assert.equal(store.load().intent.receiveAddress, address);
    posts++;
    throw Error('response lost after creation');
  };
  await assert.rejects(a.takeOffer('o', { fiatAmountEur: 100 }), /uncertain/);
  const b = buyer({ tradeStore: store });
  b._req = a._req;
  await assert.rejects(b.takeOffer('o', { fiatAmountEur: 100 }), /unresolved/);
  assert.equal(posts, 1);
});

test('storage failure blocks creation and concurrent clicks cannot post twice', async () => {
  const a = buyer({ tradeStore: { load: () => ({ trades: [] }), save: () => { throw Error('quota'); } } });
  a._req = () => { throw Error('must not POST'); };
  await assert.rejects(a.takeOffer('o', { fiatAmountEur: 100 }), /quota/);
  const b = buyer();
  let done;
  b._req = () => new Promise(r => { done = r; });
  const pending = b.takeOffer('o', { fiatAmountEur: 100 });
  await assert.rejects(b.takeOffer('o', { fiatAmountEur: 100 }), /unresolved/);
  done({ data: { tradeId: 't' } });
  await pending;
});

test('IBAN checksum failure and a changed receive address disable payment QR generation', async () => {
  const a = buyer();
  a.trades.set('t', { id: 't', fiatAmountEur: 100, receiveAddress: address });
  a._applyTradeDelta('t', { paymentAccountData: 'Alice, IBAN DE03120300000000202051 (SEPA)' });
  assert.equal((await a.getPaymentInstructions('t')).epcQrPayload, null);
  a._applyTradeDelta('t', { paymentAccountData: 'Alice, IBAN DE02120300000000202051 (SEPA)', bitcoinPaymentData: 'different-address' });
  assert.match((await a.getPaymentInstructions('t')).verificationError, /different receive address/);
});

test('a paid transfer remains marked as paid after a failed confirmation and restart', async () => {
  const store = tradeStore(node, 'mainnet', memory());
  const a = buyer({ tradeStore: store });
  a._restore();
  a.trades.set('t', { id: 't', fiatAmountEur: 100, receiveAddress: address });
  a._onWsFrame(snapshot('BUYER_RECEIVED_ACCOUNT_DATA'));
  a._tradeEvent = async () => { throw Error('disconnected'); };
  await assert.rejects(a.confirmFiatSent('t'), /disconnected/);
  const b = buyer({ tradeStore: store }); b._restore();
  b._onWsFrame(snapshot('BUYER_RECEIVED_ACCOUNT_DATA'));
  const instructions = await b.getPaymentInstructions('t');
  assert.equal(instructions.paymentSent, true);
  assert.equal(instructions.epcQrPayload, null, 'must not invite a second bank payment');
});

test('unsupported payment methods are excluded and the supported intersection is submitted', async () => {
  const a = buyer(); a.rate = 100000;
  let submitted;
  const offer = (id, fiat, btc) => ({ id, direction: 'SELL', priceSpec: { type: 'MarketPriceSpec' },
    amountSpec: { type: 'QuoteSideFixedAmountSpec', amount: 1000000 },
    quoteSidePaymentMethodSpecs: fiat.map(paymentMethod => ({ paymentMethod })),
    baseSidePaymentMethodSpecs: btc.map(paymentMethod => ({ paymentMethod })) });
  a._req = async (method, _path, body) => method === 'GET' ? { data: [
    offer('bad', ['REVOLUT'], ['LIGHTNING']), offer('good', ['REVOLUT', 'SEPA'], ['LIGHTNING', 'MAIN_CHAIN'])] }
    : (submitted = body, { data: { tradeId: 't' } });
  assert.deepEqual((await a.listOffers()).map(o => o.id), ['good']);
  await a.takeOffer('good', { fiatAmountEur: 100 });
  assert.equal(submitted.fiatPaymentMethod, 'SEPA');
  assert.equal(submitted.bitcoinPaymentMethod, 'MAIN_CHAIN');
});

test('socket generations renew authentication, reset sequences and ignore old frames', async () => {
  const handlers = []; let renewals = 0;
  const a = buyer({ credentials: { clientId: 'fixture', clientSecret: 'fixture' }, transport: {
    openSocket: async (_url, h) => { handlers.push(h); return { send() {}, close() {} }; },
  } });
  a._renewSession = async () => { a.sessionId = `session-${++renewals}`; };
  const event = (sequenceNumber, tradeState) => JSON.stringify({ topic: 'TRADE_PROPERTIES', sequenceNumber, payload: { t: { tradeState } } });
  await a._openWs();
  handlers[0].onMessage(event(25, 'BUYER_SENT_FIAT_SENT_CONFIRMATION'));
  await a._openWs();
  handlers[1].onMessage(snapshot('BUYER_SENT_FIAT_SENT_CONFIRMATION'));
  handlers[1].onMessage(event(1, 'BUYER_RECEIVED_SELLERS_FIAT_RECEIPT_CONFIRMATION'));
  handlers[0].onMessage(event(99, 'FAILED'));
  assert.equal(a.lastEmitted.get('t'), TradeState.FIAT_RECEIVED);
  assert.equal(renewals, 2);
  assert.equal(handlers[1].headers['Bisq-Session-Id'], 'session-2');
  await a.close();
});

test('session renewal coalesces simultaneous callers', async () => {
  const a = buyer({ credentials: { clientId: 'c', clientSecret: 's' } });
  let calls = 0;
  a._req = async () => { calls++; await new Promise(r => setTimeout(r, 5)); return { data: { sessionId: 'new' } }; };
  await Promise.all([a._renewSession(), a._renewSession(), a._renewSession()]);
  assert.equal(calls, 1);
});

test('mainnet privacy gate runs on startup and before purchase', async () => {
  let posts = 0;
  const a = new BisqAdapter({ wallet });
  a.getPrivacyStatus = async () => ({ level: 'block', headline: 'CLEAR', detail: 'Use Tor' });
  a._req = async (method, path) => {
    if (method === 'POST') posts++;
    return { data: path.endsWith('/ids') ? ['fixture'] : {} };
  };
  await assert.rejects(a.init(), /CLEAR/);
  a.offerCache.set('o', { minEur: 1, maxEur: 1000, priceEurPerBtc: 100000 });
  await assert.rejects(a.takeOffer('o', { fiatAmountEur: 100 }), /CLEAR/);
  assert.equal(posts, 0);
});

test('legacy secrets are discarded; keychain operations and trade history are node-scoped', async () => {
  const storage = memory(); storage.setItem('cryptobridge.credentials', 'old-secret');
  const calls = [];
  const vault = credentialStore({ invoke: async (cmd, args) => { calls.push({ cmd, args }); return null; } }, storage);
  assert.equal(storage.getItem('cryptobridge.credentials'), null);
  await vault.save(node + '/', { clientId: 'a', clientSecret: 'fixture' });
  await vault.load('http://127.0.0.1:8091/api/v1');
  assert.equal(calls[0].args.node, node);
  assert.equal(calls[1].args.node, 'http://127.0.0.1:8091/api/v1');
  tradeStore(node, 'mainnet', storage).save({ trades: [{ id: 'only-A' }], intent: null });
  assert.deepEqual(tradeStore(node, 'signet', storage).load().trades, []);
  assert.deepEqual(tradeStore('http://127.0.0.1:8091/api/v1', 'mainnet', storage).load().trades, []);
  assert.throws(() => new BisqAdapter({ wallet, wsUrl: 'ws://127.0.0.1:8091/websocket' }), /same Bisq node/);
});
