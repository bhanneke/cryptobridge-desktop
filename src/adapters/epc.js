/* Shared fiat-leg helpers used by every adapter.
 *
 *  - epcPayload(): builds the EPC069-12 "BCD" payload German banking apps scan
 *    as a GiroCode. Kept here (not in one adapter) so the MockAdapter and the
 *    BisqAdapter render the *identical* IBAN + QR from the same code path.
 *  - parseSepaAccountData(): Bisq Easy delivers the seller's bank details as a
 *    free-text string (e.g. "Alice Spike, IBAN DE.. (SEPA)"); this pulls the
 *    IBAN / holder / BIC out of it so we can build the QR ourselves.
 *
 *  None of this moves money — it only *describes* the SEPA transfer the user
 *  makes from their own bank (bright line: no fiat handling). */

/** EPC069-12 (version 002) "BCD" payload. Line order is fixed by the spec:
 *  service tag, version, charset, identification, BIC, receiver name, IBAN,
 *  amount, purpose code, structured reference, unstructured remittance,
 *  beneficiary-to-originator info. */
export function epcPayload({ receiverName, iban, amountEur, reference = '', bic = '' }) {
  return [
    'BCD', '002', '1', 'SCT',
    bic,                                  // BIC — optional since v2
    receiverName || '',
    (iban || '').replace(/\s+/g, ''),
    'EUR' + Number(amountEur).toFixed(2),
    '', '',                               // purpose, structured reference
    reference,
    '',
  ].join('\n');
}

/** Normalise an IBAN: strip spaces, upper-case. */
export function normaliseIban(iban) {
  return (iban || '').replace(/\s+/g, '').toUpperCase();
}

/** Very light IBAN sanity check (country + check digits + length 15..34).
 *  Not a mod-97 checksum — enough to reject obvious garbage before we show it. */
export function looksLikeIban(iban) {
  const s = normaliseIban(iban);
  return /^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(s) && s.length >= 15 && s.length <= 34;
}

/** Pull structured bank details out of Bisq Easy's free-text account data.
 *  The seller types this by hand, so parsing is heuristic: we extract the
 *  IBAN (and optional BIC) with confidence and take the holder name as
 *  best-effort, always returning the raw string so the UI can show exactly
 *  what the seller sent.
 *  @param {string} raw
 *  @returns {{holderName:string, iban:string, bic:string, raw:string, ok:boolean}} */
export function parseSepaAccountData(raw) {
  const text = String(raw ?? '').trim();

  // IBAN: 2 letters, 2 digits, then up to 30 more alphanumerics (allow the
  // spaces sellers usually type, then normalise).
  const ibanMatch = text.match(/\b[A-Z]{2}\d{2}(?:[ ]?[A-Z0-9]){10,30}\b/i);
  const iban = ibanMatch ? normaliseIban(ibanMatch[0]) : '';

  // BIC/SWIFT: 6 letters + 2 alnum (+ optional 3). Guard against matching the
  // IBAN itself by searching the text with the IBAN removed.
  const withoutIban = ibanMatch ? text.replace(ibanMatch[0], ' ') : text;
  const bicMatch = withoutIban.match(/\b[A-Z]{6}[A-Z0-9]{2}(?:[A-Z0-9]{3})?\b/);
  const bic = bicMatch ? bicMatch[0].toUpperCase() : '';

  // Holder name: text before the first comma is the common convention
  // ("Alice Spike, IBAN ..."). Fall back to the raw text with the IBAN / noise
  // tokens stripped.
  let holderName = '';
  const beforeComma = text.split(',')[0]?.trim();
  if (beforeComma && !/iban/i.test(beforeComma) && !looksLikeIban(beforeComma)) {
    holderName = beforeComma;
  } else {
    holderName = withoutIban
      .replace(/\biban\b/gi, '')
      .replace(/\(?\bsepa(?:\s*instant)?\b\)?/gi, '')
      .replace(/\bbic\b/gi, '')
      .replace(bic, '')
      .replace(/[,:;()]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  return { holderName, iban, bic, raw: text, ok: looksLikeIban(iban) };
}
