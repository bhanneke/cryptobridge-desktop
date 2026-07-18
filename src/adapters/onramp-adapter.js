/* OnrampAdapter — the seam between the CryptoBridge UI and any P2P trading
   backend.

   The UI only ever talks to this interface. The MockAdapter implements it with
   an in-memory demo backend; the planned BisqAdapter will implement it against
   a local Bisq daemon over localhost gRPC (see docs/IMPLEMENTATION_PLAN.md in
   bhanneke/crypto-onramp). Nothing in this interface may require a server of
   ours, custody of funds, or handling of the fiat leg — the fiat payment is
   always a SEPA transfer the user makes from their own bank, described by
   getPaymentInstructions(). */

/** Lifecycle of a P2P trade. Mirrors the states a Bisq trade actually has:
 *  the buyer takes an offer, pays the seller by SEPA from their own bank,
 *  the seller confirms receipt, and the bitcoin is released to the buyer's
 *  self-custodied wallet. */
export const TradeState = Object.freeze({
  OFFER_TAKEN:           'OFFER_TAKEN',            // trade contract created with the peer
  AWAITING_FIAT_PAYMENT: 'AWAITING_FIAT_PAYMENT',  // show IBAN + EPC QR; user pays from their bank
  FIAT_SENT:             'FIAT_SENT',              // user marked the SEPA transfer as sent
  FIAT_RECEIVED:         'FIAT_RECEIVED',          // seller confirmed the money arrived
  BTC_RELEASED:          'BTC_RELEASED',           // bitcoin released to the buyer's wallet
  COMPLETE:              'COMPLETE',               // trade closed
  FAILED:                'FAILED',                 // trade failed or was cancelled
});

/**
 * @typedef {Object} BackendInfo
 * @property {string} backend        Backend name, e.g. 'mock' | 'bisq'
 * @property {string} network        'regtest' | 'testnet' | 'mainnet'
 * @property {string} asset          Asset ticker the wallet holds, e.g. 'BTC'
 * @property {number} rateEurPerBtc  Indicative EUR/BTC rate for display only
 *
 * @typedef {Object} Offer
 * @property {string} id
 * @property {string} maker          Pseudonymous maker handle
 * @property {number} priceEurPerBtc Offer price (includes the maker's premium)
 * @property {number} premiumPct     Premium over the indicative market rate
 * @property {number} minEur         Minimum fiat amount the maker accepts
 * @property {number} maxEur         Maximum fiat amount the maker accepts
 * @property {string} paymentMethod  'SEPA' | 'SEPA_INSTANT'
 * @property {number} reputation     Maker reputation score (backend-specific scale)
 *
 * @typedef {Object} Trade
 * @property {string} id
 * @property {string} offerId
 * @property {string} state          One of TradeState
 * @property {number} fiatAmountEur
 * @property {number} btcAmountSats
 *
 * @typedef {Object} PaymentInstructions
 * @property {string} receiverName   Seller's account holder name (as bank-verifiable)
 * @property {string} iban           Seller's IBAN — the user pays this from their own bank
 * @property {string} reference      Transfer reference that ties the payment to the trade
 * @property {number} amountEur
 * @property {string} epcQrPayload   EPC069-12 "BCD" payload for a GiroCode QR
 *
 * @typedef {Object} WalletBalance
 * @property {number} confirmedSats
 * @property {number} pendingSats
 * @property {number} fiatEstimateEur  confirmedSats valued at the indicative rate
 */

/** Abstract base class. Implementations override every method. */
export class OnrampAdapter {
  /** Connect to the backend. Resolves when usable. @returns {Promise<void>} */
  async init() { throw new Error('OnrampAdapter.init not implemented'); }

  /** Synchronous snapshot of what we are connected to. @returns {BackendInfo} */
  getBackendInfo() { throw new Error('OnrampAdapter.getBackendInfo not implemented'); }

  /** Subscribe to connection status. cb({status, backend, network}) fires
   *  immediately with the current status and on every change; status is
   *  'connecting' | 'connected' | 'error'. @returns {() => void} unsubscribe */
  subscribeStatus(cb) { throw new Error('OnrampAdapter.subscribeStatus not implemented'); }

  /** List open offers matching the query. @param {{fiat: string, direction: 'buy'|'sell'}} query
   *  @returns {Promise<Offer[]>} */
  async listOffers(query) { throw new Error('OnrampAdapter.listOffers not implemented'); }

  /** Take an offer for a fiat amount within [minEur, maxEur].
   *  @returns {Promise<Trade>} the created trade, in state OFFER_TAKEN */
  async takeOffer(offerId, { fiatAmountEur }) { throw new Error('OnrampAdapter.takeOffer not implemented'); }

  /** Subscribe to a trade's state changes. cb(state, trade) fires immediately
   *  with the current state and on every transition. @returns {() => void} unsubscribe */
  subscribeTrade(tradeId, cb) { throw new Error('OnrampAdapter.subscribeTrade not implemented'); }

  /** How the user must pay the fiat leg — from their own bank account.
   *  @returns {Promise<PaymentInstructions>} */
  async getPaymentInstructions(tradeId) { throw new Error('OnrampAdapter.getPaymentInstructions not implemented'); }

  /** User declares "I have sent the SEPA transfer". @returns {Promise<void>} */
  async confirmFiatSent(tradeId) { throw new Error('OnrampAdapter.confirmFiatSent not implemented'); }

  /** Self-custodied wallet balance. @returns {Promise<WalletBalance>} */
  async getWalletBalance() { throw new Error('OnrampAdapter.getWalletBalance not implemented'); }

  /** Fresh receive address of the user's wallet. @returns {Promise<string>} */
  async getReceiveAddress() { throw new Error('OnrampAdapter.getReceiveAddress not implemented'); }

  /** Send sats out of the user's wallet. @returns {Promise<string>} txid */
  async withdraw(address, amountSats) { throw new Error('OnrampAdapter.withdraw not implemented'); }

  /** Disconnect and release resources. @returns {Promise<void>} */
  async close() { throw new Error('OnrampAdapter.close not implemented'); }
}
