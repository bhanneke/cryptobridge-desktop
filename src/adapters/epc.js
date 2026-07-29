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

/** Sanitise one EPC field.
 *
 *  SECURITY (audit finding 1): EPC fields are newline-delimited and readers key
 *  on *line position*, so a newline inside a field silently rewrites the
 *  payment. The receiver name is derived from free text the seller types, so a
 *  hostile seller could push their own IBAN and amount into the lines a banking
 *  app reads — the user would see the honest IBAN on screen and scan a QR that
 *  pays someone else. Strip anything that can move a line boundary, and clamp
 *  to the spec's field lengths. */
function epcField(value, max) {
  return String(value ?? '')
    .replace(/[\r\n\u0085\u2028\u2029]+/g, ' ')  // every flavour of line break
    .replace(/[\u0000-\u001F\u007F]/g, '')            // remaining control characters
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

/** EPC069-12 (version 002) "BCD" payload. Line order is fixed by the spec:
 *  service tag, version, charset, identification, BIC, receiver name, IBAN,
 *  amount, purpose code, structured reference, unstructured remittance,
 *  beneficiary-to-originator info.
 *
 *  Always exactly 12 lines — see `epcField` for why that is a security
 *  property and not just tidiness. */
export function epcPayload({ receiverName, iban, amountEur, reference = '', bic = '' }) {
  const amount = Number(amountEur);
  if (!Number.isFinite(amount) || amount < 0 || amount > 999999999.99) {
    throw new Error(`epcPayload: amountEur out of range: ${amountEur}`);
  }
  return [
    'BCD', '002', '1', 'SCT',
    epcField(bic, 11),                    // BIC — optional since v2
    epcField(receiverName, 70),
    epcField(iban, 34).replace(/\s+/g, '').toUpperCase(),
    'EUR' + amount.toFixed(2),
    '', '',                               // purpose, structured reference
    epcField(reference, 140),
    '',
  ].join('\n');
}

/** Normalise an IBAN: strip spaces, upper-case. */
export function normaliseIban(iban) {
  return (iban || '').replace(/\s+/g, '').toUpperCase();
}

/** ISO 7064 mod-97-10 remainder for an already-normalised IBAN. Valid == 1. */
function ibanMod97(s) {
  const rearranged = s.slice(4) + s.slice(0, 4);
  let rem = 0;
  for (const ch of rearranged) {
    // Letters expand to their two-digit A=10 … Z=35 value.
    const digits = ch >= '0' && ch <= '9' ? ch : String(ch.charCodeAt(0) - 55);
    for (const d of digits) rem = (rem * 10 + Number(d)) % 97;
  }
  return rem;
}

/** IBAN check: structure, length, and the mod-97 checksum.
 *
 *  SECURITY (audit finding 4): this used to be structural only. The IBAN is
 *  typed by hand by the seller and ends up in a QR the user scans, so the
 *  checksum is what catches a transposed digit before someone's euros go to a
 *  non-existent or unintended account. */
export function looksLikeIban(iban) {
  const s = normaliseIban(iban);
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(s)) return false;
  if (s.length < 15 || s.length > 34) return false;
  return ibanMod97(s) === 1;
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
  // Whitespace is collapsed on both branches: the name is rendered in the UI
  // and fed to epcPayload, and a seller-supplied newline has no business in
  // either (see the epcField note — it is sanitised there too, belt and braces).
  let holderName = '';
  const beforeComma = text.split(',')[0]?.replace(/\s+/g, ' ').trim();
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
