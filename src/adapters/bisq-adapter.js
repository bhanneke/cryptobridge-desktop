/* BisqAdapter — OnrampAdapter over a user-run Bisq 2 node (REST + WebSocket).
 *
 * SCAFFOLD ONLY. Every method throws until implemented. The frozen decisions
 * from the spike are filled in (base URLs, request shapes, the state map, the
 * WS subscription discriminator); the request/response/error logic and the
 * wallet seam are the implementation work. Follow docs/BISQADAPTER_PLAN.md
 * step by step; the proof that each call works is in
 * docs/BISQ2_SPIKE_FINDINGS.md and the runnable spike/ scripts.
 *
 * Our user is always the BUYER (BTC for EUR via SEPA). This adapter drives the
 * buyer side of a Bisq Easy trade. It never holds fiat and (in external-wallet
 * mode) never holds keys — see the wallet decision in the plan. */

import { OnrampAdapter, TradeState } from './onramp-adapter.js';

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

/**
 * @param {Object} opts
 * @param {string} [opts.restBaseUrl='http://127.0.0.1:8090/api/v1']
 * @param {string} [opts.wsUrl='ws://127.0.0.1:8090/websocket']
 * @param {Object} opts.wallet  Wallet seam: { getReceiveAddress(): Promise<string>,
 *                              getBalance(): Promise<{confirmedSats,pendingSats}>,
 *                              withdraw(addr, sats): Promise<string> }.
 *                              In external-wallet mode this is user-supplied.
 * @param {string} [opts.pairingCode]  Present → authenticated/remote node mode.
 */
export class BisqAdapter extends OnrampAdapter {
  constructor({ restBaseUrl = 'http://127.0.0.1:8090/api/v1',
                wsUrl = 'ws://127.0.0.1:8090/websocket',
                wallet,
                pairingCode } = {}) {
    super();
    this.rest = restBaseUrl;
    this.wsUrl = wsUrl;
    this.wallet = wallet;
    this.pairingCode = pairingCode;
    this.ws = null;
    this.statusSubs = new Set();
    this.tradeSubs = new Map();   // tradeId -> Set<cb>
    this.status = 'connecting';
  }

  // --- helper (implement first) ------------------------------------------
  /** @returns {Promise<{status:number, data:any}>} */
  async _req(method, path, body) {
    // TODO: fetch(this.rest + path, {method, headers, body}); parse; on
    // pairingCode set, attach session credentials (see plan → auth).
    throw new Error('BisqAdapter._req not implemented');
  }

  async init() {
    // TODO: REST reachability probe (GET /market-price/quotes), ensure a buyer
    // identity exists (GET /user-identities/ids → create if empty), open the
    // WebSocket and subscribe to TRADE_PROPERTIES + TRADES, set status.
    throw new Error('BisqAdapter.init not implemented');
  }

  getBackendInfo() {
    // TODO: { backend:'bisq', network:'mainnet'|'regtest', asset:'BTC',
    //         rateEurPerBtc: <from GET /market-price/quotes .quotes.EUR.value / 1e4> }
    throw new Error('BisqAdapter.getBackendInfo not implemented');
  }

  subscribeStatus(cb) {
    // TODO: register cb, fire immediately with current status, return unsub.
    throw new Error('BisqAdapter.subscribeStatus not implemented');
  }

  async listOffers({ fiat = 'EUR' } = {}) {
    // TODO: GET /offerbook/markets/${fiat}/offers; keep SELL-BTC offers;
    // map to our Offer shape (priceEurPerBtc, min/max EUR, maker, reputation).
    throw new Error('BisqAdapter.listOffers not implemented');
  }

  async takeOffer(offerId, { fiatAmountEur }) {
    // TODO: baseSideAmount = round(fiatAmountEur / rate * 1e8) sats;
    // quoteSideAmount = fiatAmountEur * 1e4; POST /trades → tradeId.
    // Then immediately PATCH BUYER_SEND_BITCOIN_PAYMENT_DATA with
    // await this.wallet.getReceiveAddress(). Return our Trade shape.
    throw new Error('BisqAdapter.takeOffer not implemented');
  }

  subscribeTrade(tradeId, cb) {
    // TODO: register cb under tradeId; the WS TRADE_PROPERTIES handler parses
    // the JSON-string payload, dedupes by sequenceNumber, calls
    // mapBisqState(), and fires cb(state, trade) on change (skip null maps).
    throw new Error('BisqAdapter.subscribeTrade not implemented');
  }

  async getPaymentInstructions(tradeId) {
    // TODO: read the seller's account data delivered with
    // SELLER_SENDS_PAYMENT_ACCOUNT (trade account-data field / trade chat);
    // parse IBAN + holder; build EPC069-12 payload via the shared helper
    // lifted from MockAdapter.epcPayload().
    throw new Error('BisqAdapter.getPaymentInstructions not implemented');
  }

  async confirmFiatSent(tradeId) {
    // TODO: PATCH /trades/{tradeId}/event BUYER_CONFIRM_FIAT_SENT.
    // BTC_CONFIRMED + CLOSE_TRADE follow once the stream reports release.
    throw new Error('BisqAdapter.confirmFiatSent not implemented');
  }

  async getWalletBalance() {
    // TODO: delegate to this.wallet.getBalance(); Bisq does not hold buyer funds.
    throw new Error('BisqAdapter.getWalletBalance not implemented');
  }

  async getReceiveAddress() {
    // TODO: delegate to this.wallet.getReceiveAddress().
    throw new Error('BisqAdapter.getReceiveAddress not implemented');
  }

  async withdraw(address, amountSats) {
    // TODO: delegate to this.wallet.withdraw(address, amountSats).
    throw new Error('BisqAdapter.withdraw not implemented');
  }

  async close() {
    // TODO: unsubscribe all, close WebSocket, clear subs.
    throw new Error('BisqAdapter.close not implemented');
  }
}
