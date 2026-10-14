/* Deciding whether an offer from the network is safe to show.
 *
 * Every number in an offer comes from the seller's client, and a seller can
 * run a modified one. Bisq's May 2026 incident was exactly this class of bug:
 * a client accepted a peer-supplied fee without rejecting negative values.
 *
 * Bisq Easy has no escrow, and Bisq's only price-deviation check runs on the
 * maker's side (BisqEasyTakeOfferRequestHandler: "I am maker"), so it protects
 * a seller from a buyer and never a buyer from a seller. Our app is always the
 * buyer. An offer far below market is therefore the classic bait: the buyer
 * sends euros by SEPA, which cannot be reversed, and the bitcoin never comes.
 *
 * The below-market limit is the node owner's own Bisq setting,
 * maxTradePriceDeviation (Bisq: default 5%, user-adjustable 1%-10%), so this
 * never invents a threshold. Premiums above market are not limited: they are
 * shown with their percentage, sellers routinely charge them for no-KYC
 * trades, and capping them would hide most real offers. */

export const DEFAULT_MAX_DEVIATION = 0.05;
export const MIN_DEVIATION = 0.01;
export const MAX_DEVIATION = 0.10;

/** Bisq accepts 1%-10% for this setting. A node reporting anything else, or
 *  nothing, gets Bisq's default rather than a wider window. */
export function clampDeviation(value) {
  const v = Number(value);
  if (!Number.isFinite(v) || v < MIN_DEVIATION || v > MAX_DEVIATION) return DEFAULT_MAX_DEVIATION;
  return v;
}

const positive = (n) => typeof n === 'number' && Number.isFinite(n) && n > 0;

/**
 * @param {{priceEurPerBtc:number, minEur:number, maxEur:number}} offer
 * @param {{rate:number|null, maxDeviation:number}} ctx
 * @returns {string|null} why the offer is hidden, or null to show it
 */
export function offerRejection(offer, { rate, maxDeviation } = {}) {
  const { priceEurPerBtc: price, minEur, maxEur } = offer ?? {};
  if (!positive(price)) return 'price is not a positive number';
  if (!positive(minEur) || !positive(maxEur)) return 'amount is not a positive number';
  if (minEur > maxEur) return 'minimum amount is above the maximum';
  if (positive(rate)) {
    const limit = clampDeviation(maxDeviation);
    const deviation = price / rate - 1;
    if (deviation < -limit) {
      return `priced ${(-deviation * 100).toFixed(1)}% below market, beyond the ${(limit * 100).toFixed(0)}% limit`;
    }
  }
  return null;
}
