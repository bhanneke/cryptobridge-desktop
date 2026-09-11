/* Turning typed amounts into satoshis.
 *
 * Its own module so it can be tested. Floating point is merely annoying in
 * most software; here the result is how much of someone's money leaves their
 * wallet, so the fraction is padded and parsed as an integer rather than
 * multiplied by 1e8. (0.1 * 1e8 is 10000000.000000002 in IEEE 754.) */

/** Satoshis per bitcoin. */
export const SATS_PER_BTC = 100000000n;

/**
 * @param {string|number} text  a BTC amount; "1,5" is accepted as "1.5"
 * @returns {number|null} satoshis, or null if it is not a usable amount
 */
export function btcToSats(text) {
  const t = String(text ?? '').trim().replace(',', '.');
  if (t === '' || t === '.') return null;
  if (!/^\d*(\.\d*)?$/.test(t)) return null;
  const [whole, frac = ''] = t.split('.');
  // Finer than a satoshi is not an amount, it is a typo.
  if (frac.length > 8) return null;
  const sats = BigInt(whole || '0') * SATS_PER_BTC + BigInt((frac + '00000000').slice(0, 8));
  // Beyond this, arithmetic in the rest of the app stops being exact.
  return sats <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(sats) : null;
}
