/* BisqAdapter — OnrampAdapter over a user-run Bisq 2 node (REST + WebSocket).
 *
 * Our user is always the BUYER (BTC for EUR via SEPA); this drives the buyer
 * side of a Bisq Easy trade. Everything here is grounded in the spike — see
 * docs/BISQ2_SPIKE_FINDINGS.md for the proof run and docs/BISQADAPTER_PLAN.md
 * for the design. It never holds fiat and, in external-wallet mode, never holds
 * keys.
 *
 * Runtime: uses global fetch + WebSocket (present in the Tauri webview and in
 * Node ≥ 18/22), so the same file backs the app and the contract test.
 *
 * Trust/verification model to keep honest:
 *  - BTC delivery is to a buyer-supplied address (wallet seam), non-custodial.
 *  - "BTC received" is NOT auto-asserted by default: `autoConfirmBtcReceipt` is
 *    false, so a trade parks at BTC_RELEASED until the user verifies the coins
 *    in their own wallet and calls confirmBtcReceived(). The contract test flips
 *    the flag to drive an unattended trade to COMPLETE.
 */

import { OnrampAdapter, TradeState } from './onramp-adapter.js';
import { epcPayload, parseSepaAccountData } from './epc.js';

/** Bisq `tradeState` (compound names — match by substring) → our TradeState.
 *  Verified against the buyer-side sequence captured in the spike. */
export const BISQ_STATE_MAP = [
  ['BUYER_RECEIVED_BTC_SENT_CONFIRMATION',            TradeState.BTC_RELEASED],
  ['BUYER_RECEIVED_SELLERS_FIAT_RECEIPT_CONFIRMATION', TradeState.FIAT_RECEIVED],
  ['BUYER_SENT_FIAT_SENT_CONFIRMATION',               TradeState.FIAT_SENT],
  ['BUYER_RECEIVED_ACCOUNT_DATA',                     TradeState.AWAITING_FIAT_PAYMENT],
  ['BTC_CONFIRMED',                                   TradeState.COMPLETE],
  ['TAKER_SENT_TAKE_OFFER_REQUEST',                   TradeState.OFFER_TAKEN],
  ['INIT',                                            TradeState.OFFER_TAKEN],
];

/** Map a raw Bisq trade-state string to our enum. Order in BISQ_STATE_MAP
 *  matters: most-advanced states are listed first so the first substring hit
 *  wins. Cancel/reject/mediation-failure states map to FAILED. */
export function mapBisqState(raw) {
  if (/CANCEL|REJECT|FAILED/.test(raw)) return TradeState.FAILED;
  for (const [needle, state] of BISQ_STATE_MAP) {
    if (raw.includes(needle)) return state;
  }
  return null; // unknown/intermediate — caller should ignore, not emit
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class BisqAdapter extends OnrampAdapter {
  /**
   * @param {Object} opts
   * @param {string} [opts.restBaseUrl='http://127.0.0.1:8090/api/v1']
   * @param {string} [opts.wsUrl='ws://127.0.0.1:8090/websocket']
   * @param {import('./wallet.js').Wallet} opts.wallet  wallet seam (required)
   * @param {string} [opts.network='mainnet']  chain the node runs on (display + address checks)
   * @param {string} [opts.nickName='cryptobridge']  identity nickname if one must be created
   * @param {boolean} [opts.autoConfirmBtcReceipt=false]  auto-send BTC_CONFIRMED+CLOSE_TRADE on release (tests/demo only)
   * @param {string} [opts.pairingCode]  present → authenticated remote-node mode (see auth note; not yet implemented)
   */
  constructor({
    restBaseUrl = 'http://127.0.0.1:8090/api/v1',
    wsUrl = 'ws://127.0.0.1:8090/websocket',
    wallet,
    network = 'mainnet',
    nickName = 'cryptobridge',
    autoConfirmBtcReceipt = false,
    pairingCode,
  } = {}) {
    super();
    if (!wallet) throw new Error('BisqAdapter requires a wallet (see src/adapters/wallet.js)');
    this.rest = restBaseUrl.replace(/\/$/, '');
    this.wsUrl = wsUrl;
    this.wallet = wallet;
    this.network = network;
    this.nickName = nickName;
    this.autoConfirmBtcReceipt = autoConfirmBtcReceipt;
    this.pairingCode = pairingCode;

    this.ws = null;
    this.closing = false;
    this.status = 'connecting';
    this.statusSubs = new Set();
    this.tradeSubs = new Map();      // tradeId -> Set<cb>
    this.tradeProps = new Map();     // tradeId -> merged {tradeState, paymentAccountData, ...}
    this.lastEmitted = new Map();    // tradeId -> last mapped TradeState emitted
    this.trades = new Map();         // tradeId -> our Trade shape (fiat/base amounts, offer)
    this.pendingBtcAddress = new Map(); // tradeId -> address to send once phase allows
    this.btcAddressSent = new Set();
    this.btcReceiptSent = new Set();
    this.offerCache = new Map();     // offerId -> { priceEurPerBtc, ... }
    this.lastSeq = new Map();        // topic -> highest sequenceNumber processed
    this.rate = null;                // EUR per BTC
    this.identityId = null;
    this.reconnectAttempts = 0;
  }

  // --- REST helper -----------------------------------------------------------
  /** @returns {Promise<{status:number, data:any}>} throws on HTTP >= 300 */
  async _req(method, path, body) {
    if (this.pairingCode) {
      // Production talks to the user's own node behind Bisq's pairing flow
      // (QR / 5-min code → clientId/secret/session). The spike ran on an
      // unauthenticated loopback node, so this path is unverified; refuse
      // rather than send blind, unauthenticated-looking requests.
      throw new Error('BisqAdapter: authenticated (pairing) mode is not implemented yet — run against a loopback dev node without authorizationRequired');
    }
    const headers = {};
    if (body !== undefined) headers['content-type'] = 'application/json';
    let res;
    try {
      res = await fetch(this.rest + path, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    } catch (e) {
      throw new Error(`Bisq node unreachable at ${this.rest} (${method} ${path}): ${e.message}`);
    }
    const text = await res.text();
    let data;
    try { data = text ? JSON.parse(text) : null; } catch { data = text; }
    if (res.status >= 300) {
      const detail = typeof data === 'string' ? data : JSON.stringify(data);
      const err = new Error(`Bisq API ${method} ${path} → HTTP ${res.status}: ${detail}`);
      err.status = res.status;
      err.data = data;
      throw err;
    }
    return { status: res.status, data };
  }

  /** PATCH a trade event, retrying while the peer's message propagates between
   *  protocol phases (each event is only legal in its phase). */
  async _tradeEvent(tradeId, tradeEventType, data = null, { tries = 25, gapMs = 2000 } = {}) {
    let lastErr;
    for (let i = 0; i < tries; i++) {
      try {
        await this._req('PATCH', `/trades/${encodeURIComponent(tradeId)}/event`, { tradeEventType, data });
        return true;
      } catch (e) {
        lastErr = e;
        if (this.closing) break;
        await sleep(gapMs);
      }
    }
    throw new Error(`Bisq trade event ${tradeEventType} never accepted for ${tradeId}: ${lastErr?.message ?? 'unknown'}`);
  }

  // --- lifecycle -------------------------------------------------------------
  async init() {
    this._setStatus('connecting');
    // Reachability + market rate in one call.
    await this._refreshRate();
    // Ensure a buyer identity exists (buyers need no reputation).
    const ids = await this._req('GET', '/user-identities/ids');
    if (Array.isArray(ids.data) && ids.data.length > 0) {
      this.identityId = ids.data[0];
    } else {
      const km = await this._req('GET', '/user-identities/key-material');
      const created = await this._req('POST', '/user-identities', {
        nickName: this.nickName, terms: '', statement: '', keyMaterialResponse: km.data,
      });
      this.identityId = created.data?.userProfile?.id ?? created.data?.userProfile?.nym ?? null;
    }
    await this._openWs();
  }

  async _refreshRate() {
    const q = await this._req('GET', '/market-price/quotes');
    const v = q.data?.quotes?.EUR?.value;
    if (v) this.rate = v / 1e4;   // quote value is EUR/BTC × 10^4
    return this.rate;
  }

  getBackendInfo() {
    return { backend: 'bisq', network: this.network, asset: 'BTC', rateEurPerBtc: this.rate };
  }

  _setStatus(status) {
    this.status = status;
    const info = this.getBackendInfo();
    for (const cb of this.statusSubs) {
      try { cb({ status, backend: info.backend, network: info.network }); } catch { /* subscriber error */ }
    }
  }

  subscribeStatus(cb) {
    this.statusSubs.add(cb);
    const info = this.getBackendInfo();
    cb({ status: this.status, backend: info.backend, network: info.network });
    return () => this.statusSubs.delete(cb);
  }

  // --- offers ----------------------------------------------------------------
  async listOffers({ fiat = 'EUR' } = {}) {
    if (fiat !== 'EUR') return [];
    const res = await this._req('GET', `/offerbook/markets/${encodeURIComponent(fiat)}/offers`);
    const raw = Array.isArray(res.data) ? res.data : [];
    const out = [];
    for (const wrapper of raw) {
      const o = wrapper.bisqEasyOffer ?? wrapper;
      if (o?.direction !== 'SELL') continue;             // we BUY BTC → take SELL offers
      const priced = this._priceOffer(o);
      if (priced.priceEurPerBtc == null) continue;       // can't price it safely → hide it
      const { minEur, maxEur } = this._amountRange(o);
      const paymentMethod = o.quoteSidePaymentMethodSpecs?.[0]?.paymentMethod ?? 'SEPA';
      const offer = {
        id: o.id,
        maker: wrapper.userProfile?.nickName ?? 'unknown',
        priceEurPerBtc: priced.priceEurPerBtc,
        premiumPct: priced.premiumPct,
        minEur, maxEur,
        paymentMethod,
        reputation: o.offerOptions?.find((x) => x.type === 'ReputationOption')?.requiredTotalReputationScore ?? null,
      };
      this.offerCache.set(o.id, offer);
      out.push(offer);
    }
    return out;
  }

  /** Effective EUR/BTC price for an offer from its priceSpec + the market rate.
   *  Returns {priceEurPerBtc|null, premiumPct|null}. Null price = we won't take it. */
  _priceOffer(o) {
    const spec = o.priceSpec ?? {};
    const type = spec.type ?? '';
    const rate = this.rate;
    if (/MarketPriceSpec/i.test(type)) {
      return { priceEurPerBtc: rate, premiumPct: 0 };
    }
    if (/FloatPriceSpec/i.test(type)) {
      const pct = Number(spec.percentage ?? 0);           // fraction, e.g. 0.02 = +2%
      if (rate == null) return { priceEurPerBtc: null, premiumPct: null };
      return { priceEurPerBtc: +(rate * (1 + pct)).toFixed(2), premiumPct: +(pct * 100).toFixed(2) };
    }
    if (/FixPriceSpec/i.test(type)) {
      // Fixed price quote in EUR × 10^4 (best-effort — the spike used market specs).
      const v = spec.priceQuote?.value ?? spec.value;
      if (v == null) return { priceEurPerBtc: null, premiumPct: null };
      const price = Number(v) / 1e4;
      return { priceEurPerBtc: price, premiumPct: rate ? +(((price / rate) - 1) * 100).toFixed(2) : null };
    }
    return { priceEurPerBtc: null, premiumPct: null };
  }

  /** [minEur, maxEur] from the offer's amountSpec (fixed or range). */
  _amountRange(o) {
    const a = o.amountSpec ?? {};
    if (/RangeAmountSpec/i.test(a.type ?? '')) {
      return { minEur: (a.minAmount ?? 0) / 1e4, maxEur: (a.maxAmount ?? 0) / 1e4 };
    }
    const eur = (a.amount ?? 0) / 1e4;                     // QuoteSideFixedAmountSpec
    return { minEur: eur, maxEur: eur };
  }

  // --- taking a trade --------------------------------------------------------
  async takeOffer(offerId, { fiatAmountEur }) {
    if (!(fiatAmountEur > 0)) throw new Error('fiatAmountEur must be > 0');
    let offer = this.offerCache.get(offerId);
    if (!offer) { await this.listOffers({ fiat: 'EUR' }); offer = this.offerCache.get(offerId); }
    if (!offer) throw new Error(`unknown offer: ${offerId}`);
    if (fiatAmountEur < offer.minEur || fiatAmountEur > offer.maxEur) {
      throw new Error(`amount €${fiatAmountEur} outside offer range €${offer.minEur}–€${offer.maxEur}`);
    }

    const quoteSideAmount = Math.round(fiatAmountEur * 1e4);            // EUR × 10^4
    const baseSideAmount = Math.round((fiatAmountEur / offer.priceEurPerBtc) * 1e8); // sats
    const res = await this._req('POST', '/trades', {
      offerId,
      baseSideAmount,
      quoteSideAmount,
      bitcoinPaymentMethod: 'MAIN_CHAIN',
      fiatPaymentMethod: 'SEPA',
    });
    const tradeId = res.data?.tradeId;
    if (!tradeId) throw new Error(`POST /trades returned no tradeId: ${JSON.stringify(res.data)}`);

    const trade = {
      id: tradeId, offerId, state: TradeState.OFFER_TAKEN,
      fiatAmountEur, btcAmountSats: baseSideAmount,
    };
    this.trades.set(tradeId, trade);

    // Fetch the receive address now (fixes which address the coins go to) and
    // send it as soon as the take-offer response arrives (the WS handler fires
    // the actual PATCH once the phase allows).
    const address = await this.wallet.getReceiveAddress();
    this.pendingBtcAddress.set(tradeId, address);
    // If the response already arrived (fast local node), try immediately.
    this._maybeSendBtcAddress(tradeId);
    return { ...trade };
  }

  // --- trade state stream ----------------------------------------------------
  subscribeTrade(tradeId, cb) {
    if (!this.tradeSubs.has(tradeId)) this.tradeSubs.set(tradeId, new Set());
    this.tradeSubs.get(tradeId).add(cb);
    const known = this.lastEmitted.get(tradeId);
    if (known) cb(known, this._tradeSnapshot(tradeId));
    return () => this.tradeSubs.get(tradeId)?.delete(cb);
  }

  _tradeSnapshot(tradeId) {
    const t = this.trades.get(tradeId) ?? { id: tradeId };
    return { ...t, state: this.lastEmitted.get(tradeId) ?? t.state };
  }

  _emitTrade(tradeId, state) {
    const prev = this.lastEmitted.get(tradeId);
    if (state == null || state === prev) return;
    this.lastEmitted.set(tradeId, state);
    const t = this.trades.get(tradeId);
    if (t) t.state = state;
    for (const cb of this.tradeSubs.get(tradeId) ?? []) {
      try { cb(state, this._tradeSnapshot(tradeId)); } catch { /* subscriber error */ }
    }
  }

  // --- payment instructions --------------------------------------------------
  async getPaymentInstructions(tradeId) {
    const props = this.tradeProps.get(tradeId);
    const trade = this.trades.get(tradeId);
    if (!trade) throw new Error(`unknown trade: ${tradeId}`);
    if (!props?.paymentAccountData) {
      throw new Error(`seller account data not received yet for ${tradeId} (wait for AWAITING_FIAT_PAYMENT)`);
    }
    const parsed = parseSepaAccountData(props.paymentAccountData);
    // Bisq Easy discourages payment references (they can flag the transfer); the
    // seller matches by amount/timing. Leave the reference empty by default.
    const reference = '';
    return {
      receiverName: parsed.holderName,
      iban: parsed.iban,
      bic: parsed.bic,
      reference,
      amountEur: trade.fiatAmountEur,
      rawAccountData: parsed.raw,          // always show the seller's exact text
      epcQrPayload: epcPayload({
        receiverName: parsed.holderName, iban: parsed.iban, bic: parsed.bic,
        amountEur: trade.fiatAmountEur, reference,
      }),
    };
  }

  async confirmFiatSent(tradeId) {
    const state = this.lastEmitted.get(tradeId);
    if (state !== TradeState.AWAITING_FIAT_PAYMENT) {
      throw new Error(`cannot confirm fiat sent from state ${state ?? 'unknown'}`);
    }
    await this._tradeEvent(tradeId, 'BUYER_CONFIRM_FIAT_SENT');
  }

  /** User confirms they see the BTC in their own wallet → close the Bisq trade.
   *  Not part of OnrampAdapter (the mock auto-completes); bisq needs an explicit
   *  step because we don't run a chain watcher in external-wallet mode. */
  async confirmBtcReceived(tradeId) {
    if (this.btcReceiptSent.has(tradeId)) return;
    this.btcReceiptSent.add(tradeId);
    await this._tradeEvent(tradeId, 'BTC_CONFIRMED');
    await this._tradeEvent(tradeId, 'CLOSE_TRADE');
  }

  // --- wallet (delegated to the seam) ---------------------------------------
  async getWalletBalance() {
    const b = await this.wallet.getBalance();
    const fiatEstimateEur = (b.confirmedSats != null && this.rate)
      ? +((b.confirmedSats / 1e8) * this.rate).toFixed(2)
      : null;
    return { confirmedSats: b.confirmedSats, pendingSats: b.pendingSats, fiatEstimateEur, external: b.external };
  }

  async getReceiveAddress() { return this.wallet.getReceiveAddress(); }

  async withdraw(address, amountSats) { return this.wallet.withdraw(address, amountSats); }

  // --- WebSocket -------------------------------------------------------------
  _openWs() {
    return new Promise((resolve) => {
      let settled = false;
      let ws;
      try { ws = new WebSocket(this.wsUrl); }
      catch { this._setStatus('error'); resolve(); return; }
      this.ws = ws;
      ws.onopen = () => {
        this.reconnectAttempts = 0;
        // The "type" discriminator is REQUIRED — without it the server silently
        // drops the subscription ("No service found").
        ws.send(JSON.stringify({ type: 'SubscriptionRequest', requestId: 'sub-trades', topic: 'TRADES', parameter: null }));
        ws.send(JSON.stringify({ type: 'SubscriptionRequest', requestId: 'sub-props', topic: 'TRADE_PROPERTIES', parameter: null }));
        this._setStatus('connected');
        if (!settled) { settled = true; resolve(); }
      };
      ws.onmessage = (e) => this._onWsFrame(String(e.data));
      ws.onerror = () => { this._setStatus('error'); if (!settled) { settled = true; resolve(); } };
      ws.onclose = () => {
        this.ws = null;
        if (this.closing) return;
        this._setStatus('connecting');
        this._scheduleReconnect();
      };
    });
  }

  _scheduleReconnect() {
    if (this.closing) return;
    const delay = Math.min(30000, 1000 * 2 ** this.reconnectAttempts++);
    setTimeout(() => { if (!this.closing && !this.ws) this._openWs(); }, delay);
  }

  _onWsFrame(raw) {
    let frame;
    try { frame = JSON.parse(raw); } catch { return; }
    if (frame.topic !== 'TRADE_PROPERTIES') return;   // TRADES handled implicitly via props
    // Dedupe replays by sequenceNumber (monotonic per topic within a session).
    const seq = frame.sequenceNumber;
    if (typeof seq === 'number') {
      const last = this.lastSeq.get(frame.topic);
      if (last != null && seq <= last) return;
      this.lastSeq.set(frame.topic, seq);
    }
    let payload;
    try { payload = typeof frame.payload === 'string' ? JSON.parse(frame.payload) : frame.payload; }
    catch { return; }
    const entries = Array.isArray(payload) ? payload : [payload];
    for (const entry of entries) {
      if (!entry || typeof entry !== 'object') continue;
      for (const [tradeId, delta] of Object.entries(entry)) {
        if (!delta || typeof delta !== 'object') continue;
        this._applyTradeDelta(tradeId, delta);
      }
    }
  }

  /** Merge a delta into the accumulated per-trade properties and react. */
  _applyTradeDelta(tradeId, delta) {
    const props = this.tradeProps.get(tradeId) ?? {};
    Object.assign(props, delta);                       // frames are deltas → accumulate
    this.tradeProps.set(tradeId, props);

    if (delta.tradeState) {
      const mapped = mapBisqState(delta.tradeState);
      // Buyer can send the BTC address once the take-offer response has arrived.
      if (/TAKER_RECEIVED_TAKE_OFFER_RESPONSE/.test(delta.tradeState)) {
        this._maybeSendBtcAddress(tradeId);
      }
      if (mapped) this._emitTrade(tradeId, mapped);
      if (mapped === TradeState.BTC_RELEASED && this.autoConfirmBtcReceipt) {
        this.confirmBtcReceived(tradeId).catch(() => { /* surfaced via state stream */ });
      }
    }
  }

  _maybeSendBtcAddress(tradeId) {
    if (this.btcAddressSent.has(tradeId)) return;
    const address = this.pendingBtcAddress.get(tradeId);
    if (!address) return;
    this.btcAddressSent.add(tradeId);
    this._tradeEvent(tradeId, 'BUYER_SEND_BITCOIN_PAYMENT_DATA', address)
      .catch((e) => { this.btcAddressSent.delete(tradeId); console.error('send BTC address failed', e.message); });
  }

  async close() {
    this.closing = true;
    try { this.ws?.close(); } catch { /* already closing */ }
    this.ws = null;
    this.statusSubs.clear();
    this.tradeSubs.clear();
  }
}
