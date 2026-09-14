/* BisqAdapter — OnrampAdapter over a user-run Bisq 2 node (REST + WebSocket).
 *
 * Our user is always the BUYER (BTC for EUR via SEPA); this drives the buyer
 * side of a Bisq Easy trade. Everything here is grounded in the spike — see
 * docs/BISQ2_SPIKE_FINDINGS.md for the proof run and docs/BISQADAPTER_PLAN.md
 * for the design. It never holds fiat and, in external-wallet mode, never holds
 * keys.
 *
 * Runtime: all I/O goes through a Transport (see transport.js). In a browser or
 * in Node ≥ 18 that is global fetch + WebSocket; inside the packaged app it is
 * Tauri IPC to the Rust shell, because the CSP holds `connect-src` at 'self'
 * and the webview may not open a socket to 127.0.0.1 itself. Same file backs
 * the app, the browser dev server and the contract test.
 *
 * Trust/verification model to keep honest:
 *  - BTC delivery is to a buyer-supplied address (wallet seam), non-custodial.
 *  - "BTC received" is NOT auto-asserted by default: `autoConfirmBtcReceipt` is
 *    false, so a trade parks at BTC_RELEASED until the user verifies the coins
 *    in their own wallet and calls confirmBtcReceived(). The contract test flips
 *    the flag to drive an unattended trade to COMPLETE.
 */

import { nodeKey } from './storage.js';
import { privacyVerdict } from './tor-status.js';
import { OnrampAdapter, TradeState } from './onramp-adapter.js';
import { epcPayload, parseSepaAccountData } from './epc.js';
import { pickTransport } from './transport.js';
import {
  parsePairingInput, isPairingExpired, missingPermissions, PAIRING_CODE_VERSION,
} from './pairing.js';

/** Bisq `tradeState` (compound names — match by substring) → our TradeState.
 *  Verified against the buyer-side sequence captured in the spike. */
/** requestId of our TRADE_PROPERTIES subscription. The node echoes it on the
 *  SubscriptionResponse that carries the initial snapshot, which is how we
 *  tell that frame apart from an unrelated response. */
export const WS_SUB_ID = 'sub-props';

/** The WebSocket that belongs to a given REST base URL.
 *
 * These must point at the same node. They did not: wsUrl defaulted to
 * ws://127.0.0.1:8090/websocket no matter what restBaseUrl said, so a node on
 * any other port got its REST from the right place and its event stream from
 * whatever happened to be listening on 8090. Nothing failed loudly -- the
 * adapter connected, and then reported another node's trades as yours.
 *
 * It stayed hidden because every caller that used a non-default port also
 * passed wsUrl explicitly (the contract test derives its own). The connect
 * screen is what makes it reachable: it asks for one address, as it should. */
export function wsUrlForRestBase(restBaseUrl) {
  const base = String(restBaseUrl ?? '');
  const stripped = base.replace(/\/api\/v1\/?$/, '');
  return `${stripped.replace(/^http/, 'ws')}/websocket`;
}

export const BISQ_STATE_MAP = [
  ['BUYER_RECEIVED_BTC_SENT_CONFIRMATION',            TradeState.BTC_RELEASED],
  ['BUYER_RECEIVED_SELLERS_FIAT_RECEIPT_CONFIRMATION', TradeState.FIAT_RECEIVED],
  ['BUYER_SENT_FIAT_SENT_CONFIRMATION',               TradeState.FIAT_SENT],
  ['BUYER_RECEIVED_ACCOUNT_DATA',                     TradeState.AWAITING_FIAT_PAYMENT],
  ['BTC_CONFIRMED',                                   TradeState.COMPLETE],
  // Measured from a live node: after taking an offer the buyer sits in
  // TAKER_RECEIVED_TAKE_OFFER_RESPONSE__BUYER_SENT_BTC_ADDRESS__BUYER_DID_NOT_RECEIVED_ACCOUNT_DATA
  // -- contract agreed, address sent, still waiting on the seller's bank
  // details. That is OFFER_TAKEN. Note it contains the substring
  // "RECEIVED_ACCOUNT_DATA" inside "DID_NOT_RECEIVED_ACCOUNT_DATA", which is
  // why the AWAITING_FIAT_PAYMENT needle is the full
  // "BUYER_RECEIVED_ACCOUNT_DATA" and is tested before this one.
  ['TAKER_RECEIVED_TAKE_OFFER_RESPONSE',              TradeState.OFFER_TAKEN],
  ['TAKER_SENT_TAKE_OFFER_REQUEST',                   TradeState.OFFER_TAKEN],
  ['INIT',                                            TradeState.OFFER_TAKEN],
];

/** Terminal from our side: nothing left for the user to do. Deliberately a
 *  separate, narrow test rather than "did mapBisqState return COMPLETE" --
 *  see listOpenTrades for why the difference matters. */
export function isTerminalBisqState(raw) {
  return /BTC_CONFIRMED|CANCEL|REJECT|FAILED/.test(String(raw ?? ''));
}

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

/** Statuses that may mean "your session is no longer good". See the note in
 *  _req: a real node answers 403 for both an absent and an expired session. */
const AUTH_FAILURE_STATUS = new Set([401, 403]);

export class BisqAdapter extends OnrampAdapter {
  /**
   * @param {Object} opts
   * @param {string} [opts.restBaseUrl='http://127.0.0.1:8090/api/v1']
   * @param {string} [opts.wsUrl]  defaults to the WebSocket of restBaseUrl
   * @param {import('./wallet.js').Wallet} opts.wallet  wallet seam (required)
   * @param {string} [opts.network='mainnet']  chain the node runs on (display + address checks)
   * @param {string} [opts.nickName='cryptobridge']  identity nickname if one must be created
   * @param {boolean} [opts.autoConfirmBtcReceipt=false]  auto-send BTC_CONFIRMED+CLOSE_TRADE on release (tests/demo only)
   * @param {string} [opts.pairingCode]  a Bisq pairing QR payload or code id — required the
   *        first time you connect to a node with authorizationRequired=true
   * @param {{clientId:string, clientSecret:string}} [opts.credentials]  previously paired
   *        credentials, so a returning user does not have to pair again
   * @param {string} [opts.clientName='CryptoBridge Desktop']  shown in the node's client list
   * @param {(c:{clientId:string,clientSecret:string})=>any} [opts.onCredentials]  called once
   *        after pairing so the host can persist them; this class never stores them itself
   * @param {import('./transport.js').WebTransport} [opts.transport]  I/O seam; defaults to
   *        Tauri IPC inside the app and fetch/WebSocket elsewhere (see transport.js)
   */
  constructor({
    restBaseUrl = 'http://127.0.0.1:8090/api/v1',
    // Derived from restBaseUrl, not a fixed default: the two must address the
    // same node. See wsUrlForRestBase.
    wsUrl = wsUrlForRestBase(restBaseUrl),
    wallet,
    network = 'mainnet',
    nickName = 'cryptobridge',
    autoConfirmBtcReceipt = false,
    pairingCode,
    credentials,
    clientName = 'CryptoBridge Desktop',
    onCredentials,
    transport,
    credentialStore,
    tradeStore,
  } = {}) {
    super();
    if (!wallet) throw new Error('BisqAdapter requires a wallet (see src/adapters/wallet.js)');
    this.rest = nodeKey(restBaseUrl);
    this.wsUrl = new URL(wsUrl).href;
    if (this.wsUrl !== wsUrlForRestBase(this.rest)) throw new Error('The WebSocket must belong to the same Bisq node as the REST endpoint.');
    this.credentialStore = credentialStore;
    this.tradeStore = tradeStore;
    this.intent = null;
    this.restored = false;
    this.takeInFlight = false;
    this.socketGeneration = 0;
    this.renewing = null;
    this.transport = transport ?? pickTransport();
    this.wallet = wallet;
    this.network = network;
    this.nickName = nickName;
    this.autoConfirmBtcReceipt = autoConfirmBtcReceipt;
    this.pairingCode = pairingCode;
    this.clientName = clientName;
    this.onCredentials = onCredentials;
    this.credentials = credentials ?? null;   // {clientId, clientSecret} — durable
    this.sessionId = null;                    // short-lived, never persisted
    this.sessionExpiry = null;

    this.ws = null;
    this.closing = false;
    this.status = 'connecting';
    this.statusSubs = new Set();
    this.tradeSubs = new Map();      // tradeId -> Set<cb>
    this.tradeProps = new Map();     // tradeId -> merged {tradeState, paymentAccountData, ...}
    this.tradeSnapshotSeen = false;  // has the node sent its initial trade snapshot yet?
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
  /** Headers that authenticate a request, or undefined on an open node. */
  _authHeaders() {
    if (!this.credentials?.clientId || !this.sessionId) return undefined;
    return {
      'Bisq-Client-Id': this.credentials.clientId,
      'Bisq-Session-Id': this.sessionId,
    };
  }

  /** @returns {Promise<{status:number, data:any}>} throws on HTTP >= 300 */
  async _req(method, path, body, { retryOnAuthFailure = true } = {}) {
    const send = () => this.transport.request(
      method,
      this.rest + path,
      body !== undefined ? JSON.stringify(body) : undefined,
      this._authHeaders(),
    );

    let res;
    try {
      res = await send();
      // Sessions are deliberately short-lived. Renew once and retry rather than
      // failing a call — and possibly a trade — on an expiry we can just fix.
      //
      // Both 401 and 403 count. Measured against a real node with
      // authorizationRequired=true, an expired *and* an absent session both come
      // back as 403, because authorization denies the call before authentication
      // has marked it as anyone. Retrying only on 401 would mean never renewing
      // at all. A genuine permission denial costs one wasted renewal, once.
      if (AUTH_FAILURE_STATUS.has(res.status) && retryOnAuthFailure && this.credentials) {
        await this._renewSession();
        res = await send();
      }
    } catch (e) {
      throw new Error(`Bisq node unreachable at ${this.rest} (${method} ${path}): ${e.message}`);
    }
    const text = res.body;
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

  // --- pairing / session -----------------------------------------------------

  /** Exchange a pairing code for durable credentials plus a session.
   *
   *  The code is single-use and short-lived; the node regenerates one every few
   *  minutes. `clientSecret` is what actually grants access from then on, so it
   *  is handed to `onCredentials` for the host to store — this class keeps it
   *  in memory only and never writes it anywhere.
   *
   *  @returns {Promise<{clientId:string, permissions:string[]|null, webSocketUrl:string|null}>} */
  async pair() {
    if (!this.pairingCode) throw new Error('BisqAdapter.pair(): no pairing code supplied');
    const parsed = parsePairingInput(this.pairingCode);

    if (isPairingExpired(parsed)) {
      throw new Error('pairing code has expired — read a fresh one from your node and try again');
    }
    // Fail here rather than as a 403 halfway through a trade.
    const missing = missingPermissions(parsed);
    if (missing.length) {
      throw new Error(`this pairing code does not grant ${missing.join(', ')} — pair again from a node that allows them`);
    }

    const res = await this._req('POST', '/access/pairing', {
      version: PAIRING_CODE_VERSION,
      pairingCodeId: parsed.pairingCodeId,
      clientName: this.clientName,
    }, { retryOnAuthFailure: false });

    const d = res.data ?? {};
    if (!d.clientId || !d.clientSecret || !d.sessionId) {
      throw new Error('pairing response missing credentials');
    }
    this.credentials = { clientId: d.clientId, clientSecret: d.clientSecret };
    this.sessionId = d.sessionId;
    this.sessionExpiry = d.sessionExpiryDate ?? null;
    // The code is now spent; drop it so a reconnect cannot try to reuse it.
    this.pairingCode = null;

    await this.credentialStore?.save(this.rest, this.credentials);
    await this.onCredentials?.(this.credentials);

    return {
      clientId: d.clientId,
      permissions: parsed.permissions,
      webSocketUrl: parsed.webSocketUrl,
    };
  }

  /** Trade the durable credentials for a fresh short-lived session. */
  async _renewSession() {
    if (!this.renewing) this.renewing = this._renewSessionOnce().finally(() => { this.renewing = null; });
    return this.renewing;
  }

  async _renewSessionOnce() {
    if (!this.credentials) throw new Error('no credentials to renew a session with — pair first');
    const res = await this._req('POST', '/access/session', {
      clientId: this.credentials.clientId,
      clientSecret: this.credentials.clientSecret,
    }, { retryOnAuthFailure: false });
    const d = res.data ?? {};
    if (!d.sessionId) throw new Error(`session renewal returned no sessionId: ${JSON.stringify(d)}`);
    this.sessionId = d.sessionId;
    this.sessionExpiry = d.expiresAt ?? null;
  }

  /** Prefer stored credentials; fall back to the pairing code if they are
   *  stale (revoked node-side, or a rebuilt node). */
  async _authenticate() {
    if (this.credentials) {
      try {
        await this._renewSession();
        return;
      } catch (e) {
        if (!this.pairingCode) throw e;
        console.warn('stored Bisq credentials rejected, re-pairing:', e.message);
        this.credentials = null;
      }
    }
    if (this.pairingCode) await this.pair();
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
    this._restore();
    if (this.credentialStore) this.credentials = await this.credentialStore.load(this.rest);
    // Authenticate first if this node wants it: every call below, and the
    // WebSocket handshake, need the session headers.
    if (this.pairingCode || this.credentials) await this._authenticate();
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
    await this.checkPrivacy();
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

  /** How this node reaches trade peers -- over Tor, or over the open internet
   *  where the counterparty can see the user's IP. The node reports it on the
   *  profile we already have an identity for; nothing here changes the node.
   *  Never throws: a privacy check that fails closed would block trading on
   *  its own bug, so an unreadable answer becomes the "could not confirm"
   *  verdict, which warns. */
  async getPrivacyStatus() {
    let profile = null;
    try {
      const res = await this._req('GET', '/user-identities/selected/user-profile');
      profile = res?.data ?? null;
    } catch (e) {
      console.error('could not read the node transport:', e.message);
    }
    return privacyVerdict(profile, this.network);
  }

  async checkPrivacy() {
    const verdict = await this.getPrivacyStatus();
    this.privacy = verdict;
    if (verdict.level === 'block') {
      this._setStatus('error');
      throw new Error(`${verdict.headline}. ${verdict.detail}`);
    }
    return verdict;
  }

  _restore() {
    if (this.restored) return;
    const saved = this.tradeStore?.load();
    if (saved) {
      this.intent = saved.intent ?? null;
      for (const trade of saved.trades) {
        this.trades.set(trade.id, trade);
        if (trade.state) this.lastEmitted.set(trade.id, trade.state);
        if (trade.props) this.tradeProps.set(trade.id, trade.props);
        if (trade.receiveAddress) this.pendingBtcAddress.set(trade.id, trade.receiveAddress);
        if (trade.receiptConfirmed) this.btcReceiptSent.add(trade.id);
      }
    }
    this.restored = true;
  }

  _persist() {
    this.tradeStore?.save({ trades: [...this.trades.values()], intent: this.intent });
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
      if (!o?.quoteSidePaymentMethodSpecs?.some(s => s.paymentMethod === 'SEPA')
          || !o?.baseSidePaymentMethodSpecs?.some(s => s.paymentMethod === 'MAIN_CHAIN')) continue;
      if (o?.direction !== 'SELL') continue;             // we BUY BTC → take SELL offers
      const priced = this._priceOffer(o);
      if (priced.priceEurPerBtc == null) continue;       // can't price it safely → hide it
      const { minEur, maxEur } = this._amountRange(o);
      const paymentMethod = 'SEPA';
      const offer = {
        id: o.id,
        maker: wrapper.userProfile?.nickName ?? 'unknown',
        priceEurPerBtc: priced.priceEurPerBtc,
        premiumPct: priced.premiumPct,
        minEur, maxEur,
        paymentMethod,
        // The maker's actual reputation, from the offer payload's own
        // reputationScore. This used to read requiredTotalReputationScore out
        // of the offer's ReputationOption, which Bisq deprecated in 2.1.1
        // ("Not used anymore since 2.1.1" in offer.proto) and no longer
        // populates -- so the number the offer book showed was decorative.
        // That matters more than it sounds: with mediation out of v1, this is
        // the only thing standing between the user and a seller who keeps
        // their euros.
        reputation: wrapper.reputationScore?.totalScore ?? null,
        /** 0-5, as Bisq's own UI presents it. */
        reputationStars: wrapper.reputationScore?.fiveSystemScore ?? null,
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
  async takeOffer(offerId, args) {
    this._restore();
    if (this.storageError) throw this.storageError;
    if (this.takeInFlight || this.intent) throw new Error('A trade request is still unresolved. Reconnect and check the existing trade in Bisq before starting another.');
    this.takeInFlight = true;
    try { return await this._takeOffer(offerId, args); }
    finally { this.takeInFlight = false; }
  }

  async _takeOffer(offerId, { fiatAmountEur }) {
    if (!(fiatAmountEur > 0)) throw new Error('fiatAmountEur must be > 0');
    let offer = this.offerCache.get(offerId);
    if (!offer) { await this.listOffers({ fiat: 'EUR' }); offer = this.offerCache.get(offerId); }
    if (!offer) throw new Error(`unknown offer: ${offerId}`);
    if (fiatAmountEur < offer.minEur || fiatAmountEur > offer.maxEur) {
      throw new Error(`amount €${fiatAmountEur} outside offer range €${offer.minEur}–€${offer.maxEur}`);
    }

    const address = await this.wallet.getReceiveAddress();
    await this.checkPrivacy();
    if (this.closing) throw new Error('The node changed before this trade was created.');
    const quoteSideAmount = Math.round(fiatAmountEur * 1e4);            // EUR × 10^4
    const baseSideAmount = Math.round((fiatAmountEur / offer.priceEurPerBtc) * 1e8); // sats
    this.intent = { offerId, fiatAmountEur, btcAmountSats: baseSideAmount, receiveAddress: address, createdAt: Date.now() };
    try { this._persist(); } catch (e) { this.intent = null; throw e; }
    let res;
    try { res = await this._req('POST', '/trades', {
      offerId,
      baseSideAmount,
      quoteSideAmount,
      bitcoinPaymentMethod: 'MAIN_CHAIN',
      fiatPaymentMethod: 'SEPA',
    }, { retryOnAuthFailure: false }); } catch (e) {
      // A timeout, 5xx or lost response may follow a successful creation.
      // Never retry this POST automatically or clear its durable intent.
      throw new Error(`Trade outcome is uncertain. Check this node in Bisq before starting another purchase. ${e.message}`);
    }
    const tradeId = res.data?.tradeId;
    if (!tradeId) throw new Error(`POST /trades returned no tradeId: ${JSON.stringify(res.data)}`);

    const trade = {
      id: tradeId, offerId, state: TradeState.OFFER_TAKEN,
      fiatAmountEur, btcAmountSats: baseSideAmount, receiveAddress: address,
    };
    this.trades.set(tradeId, trade);
    this.intent = null;
    try { this._persist(); } catch (e) {
      this.intent = { ...trade, tradeId };
      throw new Error(`Trade ${tradeId} exists, but could not be saved. Resume this trade in Bisq; do not take another offer. ${e.message}`);
    }

    // Fetch the receive address now (fixes which address the coins go to) and
    // send it as soon as the take-offer response arrives (the WS handler fires
    // the actual PATCH once the phase allows).
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
    try { this._persist(); } catch (e) { this.storageError = e; this._setStatus('error'); }
    for (const cb of this.tradeSubs.get(tradeId) ?? []) {
      try { cb(state, this._tradeSnapshot(tradeId)); } catch { /* subscriber error */ }
    }
  }

  // --- payment instructions --------------------------------------------------
  async getPaymentInstructions(tradeId) {
    const props = this.tradeProps.get(tradeId);
    const trade = this.trades.get(tradeId);
    if (!trade) throw new Error(`Trade ${tradeId} has no saved details. Open it in Bisq to verify the amount.`);
    if (!props?.paymentAccountData) {
      throw new Error(`seller account data not received yet for ${tradeId} (wait for AWAITING_FIAT_PAYMENT)`);
    }
    const parsed = parseSepaAccountData(props.paymentAccountData);
    // Bisq Easy discourages payment references (they can flag the transfer); the
    // seller matches by amount/timing. Leave the reference empty by default.
    const reference = '';
    const paymentSent = !!trade.fiatPaymentSent;
    const validAmount = Number.isFinite(trade.fiatAmountEur) && trade.fiatAmountEur > 0;
    const verificationError = !parsed.ok ? 'The seller’s bank details failed validation. Ask the seller to correct them in Bisq before paying.'
      : !validAmount ? 'The amount is missing from this older trade. Verify and complete the payment in Bisq.'
      : trade.addressConflict ? 'The node reports a different receive address. Resolve this trade in Bisq before paying.' : null;
    return {
      verificationError,
      paymentSent,
      receiverName: parsed.holderName,
      iban: parsed.iban,
      bic: parsed.bic,
      reference,
      amountEur: trade.fiatAmountEur,
      rawAccountData: parsed.raw,          // always show the seller's exact text
      epcQrPayload: verificationError || paymentSent ? null : epcPayload({
        receiverName: parsed.holderName, iban: parsed.iban, bic: parsed.bic,
        amountEur: trade.fiatAmountEur, reference,
      }),
    };
  }

  async confirmFiatSent(tradeId) {
    const state = this.lastEmitted.get(tradeId);
    if ([TradeState.FIAT_SENT, TradeState.FIAT_RECEIVED, TradeState.BTC_RELEASED, TradeState.COMPLETE].includes(state)) return;
    if (state !== TradeState.AWAITING_FIAT_PAYMENT) {
      throw new Error(`cannot confirm fiat sent from state ${state ?? 'unknown'}`);
    }
    const trade = this.trades.get(tradeId);
    if (trade) { trade.fiatPaymentSent = true; this._persist(); }
    await this._tradeEvent(tradeId, 'BUYER_CONFIRM_FIAT_SENT');
  }

  /** User confirms they see the BTC in their own wallet → close the Bisq trade.
   *  Not part of OnrampAdapter (the mock auto-completes); bisq needs an explicit
   *  step because we don't run a chain watcher in external-wallet mode. */
  /** The user attests that the bitcoin arrived in their own wallet. In
   *  external-wallet mode this is the authoritative signal — we cannot see the
   *  chain — so it is also what unlocks COMPLETE (see the note in
   *  _applyTradeDelta). Emitting here matters: the node may already have sent
   *  its final state, which we held back, and it will not necessarily repeat
   *  it, which would otherwise leave the UI waiting forever. */
  async confirmBtcReceived(tradeId) {
    if (this.btcReceiptSent.has(tradeId)) return;
    this.btcReceiptSent.add(tradeId);
    const trade = this.trades.get(tradeId);
    try {
      if (!/BTC_CONFIRMED/.test(this.tradeProps.get(tradeId)?.tradeState ?? '')) await this._tradeEvent(tradeId, 'BTC_CONFIRMED');
      await this._tradeEvent(tradeId, 'CLOSE_TRADE');
      if (trade) trade.receiptConfirmed = true;
      this._persist();
      this._emitTrade(tradeId, TradeState.COMPLETE);
    } catch (e) {
      this.btcReceiptSent.delete(tradeId);
      if (trade) trade.receiptConfirmed = false;
      throw e;
    }
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
  /** Resolves once subscribed, or after scheduling a retry — never rejects, so
   *  init() stays usable against a node that is not up yet. */
  async _openWs() {
    if (this.wsOpening || this.closing) return;
    this.wsOpening = true;
    const generation = ++this.socketGeneration;
    const current = () => generation === this.socketGeneration && !this.closing;
    let closed = false;
    this.lastSeq.clear();
    this.tradeSnapshotSeen = false;
    try {
      // Renewal is shared with HTTP callers; an idle trade gets a fresh
      // session even when no REST request happens after the socket closes.
      if (this.credentials) await this._renewSession();
      await this.checkPrivacy();
      const sock = await this.transport.openSocket(this.wsUrl, {
        headers: this._authHeaders(),
        onMessage: raw => { if (current()) this._onWsFrame(raw); },
        onError: () => { if (current()) this._setStatus('error'); },
        onClose: () => {
          closed = true;
          if (!current()) return;
          this.ws = null;
          this._setStatus('connecting');
          this._scheduleReconnect();
        },
      });
      if (!current() || closed) { sock.close(); return; }
      this.ws = sock;
      this.reconnectAttempts = 0;
      sock.send(JSON.stringify({ type: 'SubscriptionRequest', requestId: 'sub-trades', topic: 'TRADES', parameter: null }));
      sock.send(JSON.stringify({ type: 'SubscriptionRequest', requestId: WS_SUB_ID, topic: 'TRADE_PROPERTIES', parameter: null }));
      this._setStatus('connected');
    } catch {
      if (current()) { this._setStatus('error'); this._scheduleReconnect(); }
    } finally { this.wsOpening = false; }
  }

  _scheduleReconnect() {
    if (this.closing) return;
    const delay = Math.min(30000, 1000 * 2 ** this.reconnectAttempts++);
    // `wsOpening` guards the window where a handshake is in flight but `ws` is
    // not yet set, which would otherwise let a retry open a second socket.
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => {
      if (!this.closing && !this.ws && !this.wsOpening) this._openWs();
    }, delay);
  }

  _onWsFrame(raw) {
    let frame;
    try { frame = JSON.parse(raw); } catch { return; }
    /* Two frame shapes carry trade properties, and we used to handle only one.
     *
     * The node answers a SubscriptionRequest with a SubscriptionResponse whose
     * payload is a snapshot of EVERY trade it knows about -- measured against
     * a live 2.1.11 node: `{type:"SubscriptionResponse", requestId:"sub-props",
     * payload:"[{tradeId:{...}}, ...]"}`, with no `topic` field at all.
     * Subsequent changes arrive as topic-tagged events.
     *
     * Testing `frame.topic !== 'TRADE_PROPERTIES'` therefore dropped the
     * snapshot on the floor, which is precisely the data needed to find your
     * way back into a trade you already paid for. Match the response by the
     * requestId we sent, and events by topic. */
    const isSnapshot = frame.type === 'SubscriptionResponse' && frame.requestId === WS_SUB_ID;
    if (!isSnapshot && frame.topic !== 'TRADE_PROPERTIES') return;
    if (isSnapshot && frame.errorMessage) {
      console.error('trade subscription failed:', frame.errorMessage);
      this.tradeSnapshotSeen = true;   // it is not coming; do not make callers wait
      return;
    }
    if (isSnapshot) this.tradeSnapshotSeen = true;
    // Dedupe replays by sequenceNumber (monotonic per topic within a session).
    // The snapshot has none and must never be deduped against the event
    // stream -- it is the baseline the events are deltas against.
    const seq = frame.sequenceNumber;
    if (!isSnapshot && typeof seq === 'number') {
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

  /** Trades the node still considers live.
   *
   *  Everything here comes from the snapshot the node sends when we subscribe
   *  -- there is no REST endpoint to ask: the API has no GET /trades at all
   *  (it answers 500), only POST to take one and PATCH to advance it. So this
   *  is empty until the WebSocket is up, which is why it is async and waits
   *  for the subscription rather than reading a possibly-empty map.
   *
   *  The snapshot carries tradeState, the seller's account text and the
   *  bitcoin address, but no amounts -- so a resumed trade can show what to
   *  do next and who to pay, and the UI must not promise a figure it does not
   *  have. */
  async listOpenTrades() {
    await this._waitForTradeSnapshot();
    this._restore();
    const out = [];
    for (const id of new Set([...this.tradeProps.keys(), ...this.trades.keys()])) {
      const props = this.tradeProps.get(id) ?? {};
      const trade = this.trades.get(id) ?? {};
      const raw = props.tradeState;
      if (!raw && !trade.id) continue;
      let state = this.lastEmitted.get(id) ?? (raw ? mapBisqState(raw) : trade.state);
      if (state === TradeState.COMPLETE && !this.autoConfirmBtcReceipt && !this.btcReceiptSent.has(id)) state = TradeState.BTC_RELEASED;
      if (state === TradeState.COMPLETE || state === TradeState.FAILED) continue;
      out.push({ ...trade, id, state, rawState: raw, sellerDetails: props.paymentAccountData ?? null,
        receiveAddress: trade.receiveAddress ?? props.bitcoinPaymentData ?? null });
    }
    return out;
  }

  /** Resolve once the subscription snapshot has arrived (or we give up). The
   *  snapshot is a single frame right after the handshake, so this is a short
   *  wait, not a poll of an indefinite stream. */
  async _waitForTradeSnapshot(timeoutMs = 5000) {
    if (this.tradeSnapshotSeen) return;
    const started = Date.now();
    while (!this.tradeSnapshotSeen && Date.now() - started < timeoutMs) {
      await sleep(50);
    }
  }

  /** Merge a delta into the accumulated per-trade properties and react. */
  _applyTradeDelta(tradeId, delta) {
    const props = this.tradeProps.get(tradeId) ?? {};
    Object.assign(props, delta);                       // frames are deltas → accumulate
    this.tradeProps.set(tradeId, props);
    let trade = this.trades.get(tradeId);
    if (!trade) { trade = { id: tradeId }; this.trades.set(tradeId, trade); }
    trade.props = props;
    if (props.bitcoinPaymentData) {
      trade.addressConflict = !!(trade.receiveAddress && trade.receiveAddress !== props.bitcoinPaymentData);
      if (!trade.receiveAddress) trade.receiveAddress = props.bitcoinPaymentData;
      if (!trade.addressConflict) this.btcAddressSent.add(tradeId);
    }
    try { this._persist(); } catch (e) { this.storageError = e; this._setStatus('error'); }

    if (delta.tradeState) {
      const mapped = mapBisqState(delta.tradeState);
      // Buyer can send the BTC address once the take-offer response has arrived.
      if (/TAKER_RECEIVED_TAKE_OFFER_RESPONSE/.test(delta.tradeState)) {
        this._maybeSendBtcAddress(tradeId);
      }
      // SECURITY (audit finding 3): COMPLETE asserts "the bitcoin arrived", and
      // in external-wallet mode only the user can know that — we cannot see
      // their wallet. A hostile peer or a lying node can put any tradeState on
      // the wire, including one that maps straight to COMPLETE, which would
      // make the UI declare success right after the user sent their euros.
      // Hold the trade at BTC_RELEASED until confirmBtcReceived() has run.
      let effective = mapped;
      if (effective === TradeState.COMPLETE
          && !this.autoConfirmBtcReceipt
          && !this.btcReceiptSent.has(tradeId)) {
        effective = TradeState.BTC_RELEASED;
      }
      if (effective) this._emitTrade(tradeId, effective);
      if (effective === TradeState.BTC_RELEASED && this.autoConfirmBtcReceipt) {
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
    ++this.socketGeneration;
    clearTimeout(this.reconnectTimer);
    try { this.ws?.close(); } catch { /* already closing */ }
    this.ws = null;
    this.statusSubs.clear();
    this.tradeSubs.clear();
  }
}
