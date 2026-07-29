/* MockAdapter — in-memory OnrampAdapter used until the BisqAdapter exists.

   It behaves like a tiny P2P backend: a static offer book, a trade state
   machine that walks the same states a real Bisq trade has (with short
   delays so the UI shows the progression), EPC069-12 payment instructions
   for the fiat leg, and a sats-denominated wallet. No network access. */

import { OnrampAdapter, TradeState } from './onramp-adapter.js';
import { epcPayload } from './epc.js';

const RATE_EUR_PER_BTC = 91420.0; // demo constant — a real adapter streams this

const OFFER_BOOK = [
  { id: 'ofr-aurora',  maker: 'aurora_finch',   premiumPct: 1.8, minEur: 100, maxEur: 12000, paymentMethod: 'SEPA',         reputation: 74 },
  { id: 'ofr-basalt',  maker: 'basalt_otter',   premiumPct: 2.4, minEur:  50, maxEur:  6000, paymentMethod: 'SEPA_INSTANT', reputation: 91 },
  { id: 'ofr-cinder',  maker: 'cinder_lark',    premiumPct: 1.2, minEur: 500, maxEur: 20000, paymentMethod: 'SEPA',         reputation: 88 },
  { id: 'ofr-dune',    maker: 'dune_heron',     premiumPct: 3.1, minEur:  25, maxEur:  2500, paymentMethod: 'SEPA_INSTANT', reputation: 65 },
  { id: 'ofr-ember',   maker: 'ember_vole',     premiumPct: 2.0, minEur: 200, maxEur:  9000, paymentMethod: 'SEPA',         reputation: 82 },
  { id: 'ofr-fjord',   maker: 'fjord_magpie',   premiumPct: 1.5, minEur: 300, maxEur: 15000, paymentMethod: 'SEPA',         reputation: 79 },
];

// Demo seller bank details for the fiat leg (clearly fake IBAN).
// `raw` mirrors how a real Bisq Easy seller sends this — free text they typed —
// so the UI exercises the same "show the seller's exact message" path here as
// it does against a real node.
const SELLER = {
  name: 'CryptoBridge Demo Seller',
  iban: 'DE02 1203 0000 0000 2020 51',
  raw: 'CryptoBridge Demo Seller, IBAN DE02 1203 0000 0000 2020 51 (SEPA)',
};

const eurToSats = (eur) => Math.round((eur / RATE_EUR_PER_BTC) * 1e8);

/* The EPC069-12 (GiroCode) payload builder lives in ./epc.js so this mock and
   the BisqAdapter render the identical IBAN + QR from one code path. */

export class MockAdapter extends OnrampAdapter {
  /** @param {{latencyScale?: number}} [opts] latencyScale scales all simulated
   *  delays (1 = demo pacing, small values for tests / reduced motion). */
  constructor({ latencyScale = 1 } = {}) {
    super();
    this.latencyScale = latencyScale;
    this.status = 'connecting';
    this.statusSubs = new Set();
    this.trades = new Map();      // tradeId -> trade
    this.tradeSubs = new Map();   // tradeId -> Set<cb>
    this.wallet = { confirmedSats: 0, pendingSats: 0 };
    this.tradeSeq = 0;
  }

  _delay(ms) {
    return new Promise((res) => setTimeout(res, ms * this.latencyScale));
  }

  _setStatus(status) {
    this.status = status;
    const info = this.getBackendInfo();
    for (const cb of this.statusSubs) cb({ status, backend: info.backend, network: info.network });
  }

  async init() {
    await this._delay(300); // pretend to dial a local daemon
    this._setStatus('connected');
  }

  getBackendInfo() {
    return { backend: 'mock', network: 'regtest', asset: 'BTC', rateEurPerBtc: RATE_EUR_PER_BTC };
  }

  subscribeStatus(cb) {
    this.statusSubs.add(cb);
    const info = this.getBackendInfo();
    cb({ status: this.status, backend: info.backend, network: info.network });
    return () => this.statusSubs.delete(cb);
  }

  async listOffers({ fiat = 'EUR' } = {}) {
    if (fiat !== 'EUR') return [];
    await this._delay(150);
    return OFFER_BOOK.map((o) => ({
      ...o,
      priceEurPerBtc: +(RATE_EUR_PER_BTC * (1 + o.premiumPct / 100)).toFixed(2),
    }));
  }

  async takeOffer(offerId, { fiatAmountEur }) {
    const offer = OFFER_BOOK.find((o) => o.id === offerId);
    if (!offer) throw new Error(`unknown offer: ${offerId}`);
    if (!(fiatAmountEur > 0)) throw new Error('fiatAmountEur must be > 0');
    await this._delay(250);

    const id = `trade-${++this.tradeSeq}`;
    const price = RATE_EUR_PER_BTC * (1 + offer.premiumPct / 100);
    const trade = {
      id,
      offerId,
      state: TradeState.OFFER_TAKEN,
      fiatAmountEur,
      btcAmountSats: Math.round((fiatAmountEur / price) * 1e8),
      reference: `CB-${id.toUpperCase()}`,
    };
    this.trades.set(id, trade);
    // The peer's side comes alive shortly after: contract signed, now pay.
    setTimeout(() => this._transition(id, TradeState.AWAITING_FIAT_PAYMENT), 350 * this.latencyScale);
    return { ...trade };
  }

  _transition(tradeId, state) {
    const trade = this.trades.get(tradeId);
    if (!trade || trade.state === TradeState.COMPLETE || trade.state === TradeState.FAILED) return;
    trade.state = state;
    if (state === TradeState.BTC_RELEASED) {
      this.wallet.confirmedSats += trade.btcAmountSats;
    }
    for (const cb of this.tradeSubs.get(tradeId) ?? []) cb(state, { ...trade });
  }

  subscribeTrade(tradeId, cb) {
    if (!this.tradeSubs.has(tradeId)) this.tradeSubs.set(tradeId, new Set());
    this.tradeSubs.get(tradeId).add(cb);
    const trade = this.trades.get(tradeId);
    if (trade) cb(trade.state, { ...trade });
    return () => this.tradeSubs.get(tradeId)?.delete(cb);
  }

  async getPaymentInstructions(tradeId) {
    const trade = this.trades.get(tradeId);
    if (!trade) throw new Error(`unknown trade: ${tradeId}`);
    const p = {
      receiverName: SELLER.name,
      iban: SELLER.iban,
      reference: trade.reference,
      amountEur: trade.fiatAmountEur,
    };
    return { ...p, rawAccountData: SELLER.raw, epcQrPayload: epcPayload({ ...p, amountEur: p.amountEur }) };
  }

  async confirmFiatSent(tradeId) {
    const trade = this.trades.get(tradeId);
    if (!trade) throw new Error(`unknown trade: ${tradeId}`);
    if (trade.state !== TradeState.AWAITING_FIAT_PAYMENT) {
      throw new Error(`cannot confirm fiat sent from state ${trade.state}`);
    }
    this._transition(tradeId, TradeState.FIAT_SENT);
    // Simulated peer: sees the SEPA credit, confirms, releases the bitcoin.
    const s = this.latencyScale;
    setTimeout(() => this._transition(tradeId, TradeState.FIAT_RECEIVED), 500 * s);
    setTimeout(() => this._transition(tradeId, TradeState.BTC_RELEASED), 850 * s);
    setTimeout(() => this._transition(tradeId, TradeState.COMPLETE), 1100 * s);
  }

  async getWalletBalance() {
    return {
      confirmedSats: this.wallet.confirmedSats,
      pendingSats: this.wallet.pendingSats,
      fiatEstimateEur: +((this.wallet.confirmedSats / 1e8) * RATE_EUR_PER_BTC).toFixed(2),
    };
  }

  async getReceiveAddress() {
    return 'bcrt1qdemo000000000000000000000000000000000';
  }

  async withdraw(address, amountSats) {
    if (!(amountSats > 0)) throw new Error('amountSats must be > 0');
    if (amountSats > this.wallet.confirmedSats) throw new Error('insufficient funds');
    await this._delay(200);
    this.wallet.confirmedSats -= amountSats;
    return 'mocktx-' + amountSats.toString(16);
  }

  async close() {
    this.statusSubs.clear();
    this.tradeSubs.clear();
  }

  /* Demo-only helper (not part of OnrampAdapter): pre-credit the wallet so
     deep links like #step=5 can seed a plausible state. */
  seedWallet(fiatEur) {
    this.wallet.confirmedSats += eurToSats(fiatEur);
  }
}
