/* Minimal, dependency-free QR Code (Model 2) encoder — byte mode, error
 * correction level M (as mandated by the EPC069-12 GiroCode spec). Self-contained
 * so it runs in the strict-CSP webview with no CDN. Produces a boolean module
 * matrix and an inline SVG.
 *
 * The version/error-correction block tables and alignment-pattern coordinates
 * are extracted verbatim from segno 1.6.6 (see the generator in the repo's test
 * notes); every output is verified end-to-end by rendering to an image and
 * decoding it back (tests/qr.verify.mjs → cv2), so a scanned GiroCode always
 * carries exactly the IBAN/amount we encoded.
 *
 * Not a general QR library: byte mode + level M only. That is all a GiroCode
 * needs and it keeps the surface small.
 */

// --- version / ECC tables (level M), extracted from segno -------------------
export const QR_ECC_M = {
  1: { ec: 10, groups: [[1, 16]] }, 2: { ec: 16, groups: [[1, 28]] }, 3: { ec: 26, groups: [[1, 44]] },
  4: { ec: 18, groups: [[2, 32]] }, 5: { ec: 24, groups: [[2, 43]] }, 6: { ec: 16, groups: [[4, 27]] },
  7: { ec: 18, groups: [[4, 31]] }, 8: { ec: 22, groups: [[2, 38], [2, 39]] }, 9: { ec: 22, groups: [[3, 36], [2, 37]] },
  10: { ec: 26, groups: [[4, 43], [1, 44]] }, 11: { ec: 30, groups: [[1, 50], [4, 51]] }, 12: { ec: 22, groups: [[6, 36], [2, 37]] },
  13: { ec: 22, groups: [[8, 37], [1, 38]] }, 14: { ec: 24, groups: [[4, 40], [5, 41]] }, 15: { ec: 24, groups: [[5, 41], [5, 42]] },
  16: { ec: 28, groups: [[7, 45], [3, 46]] }, 17: { ec: 28, groups: [[10, 46], [1, 47]] }, 18: { ec: 26, groups: [[9, 43], [4, 44]] },
  19: { ec: 26, groups: [[3, 44], [11, 45]] }, 20: { ec: 26, groups: [[3, 41], [13, 42]] }, 21: { ec: 26, groups: [[17, 42]] },
  22: { ec: 28, groups: [[17, 46]] }, 23: { ec: 28, groups: [[4, 47], [14, 48]] }, 24: { ec: 28, groups: [[6, 45], [14, 46]] },
  25: { ec: 28, groups: [[8, 47], [13, 48]] }, 26: { ec: 28, groups: [[19, 46], [4, 47]] }, 27: { ec: 28, groups: [[22, 45], [3, 46]] },
  28: { ec: 28, groups: [[3, 45], [23, 46]] }, 29: { ec: 28, groups: [[21, 45], [7, 46]] }, 30: { ec: 28, groups: [[19, 47], [10, 48]] },
  31: { ec: 28, groups: [[2, 46], [29, 47]] }, 32: { ec: 28, groups: [[10, 46], [23, 47]] }, 33: { ec: 28, groups: [[14, 46], [21, 47]] },
  34: { ec: 28, groups: [[14, 46], [23, 47]] }, 35: { ec: 28, groups: [[12, 47], [26, 48]] }, 36: { ec: 28, groups: [[6, 47], [34, 48]] },
  37: { ec: 28, groups: [[29, 46], [14, 47]] }, 38: { ec: 28, groups: [[13, 46], [32, 47]] }, 39: { ec: 28, groups: [[40, 47], [7, 48]] },
  40: { ec: 28, groups: [[18, 47], [31, 48]] },
};

export const QR_ALIGN = {
  1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30], 6: [6, 34], 7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46],
  10: [6, 28, 50], 11: [6, 30, 54], 12: [6, 32, 58], 13: [6, 34, 62], 14: [6, 26, 46, 66], 15: [6, 26, 48, 70],
  16: [6, 26, 50, 74], 17: [6, 30, 54, 78], 18: [6, 30, 56, 82], 19: [6, 30, 58, 86], 20: [6, 34, 62, 90],
  21: [6, 28, 50, 72, 94], 22: [6, 26, 50, 74, 98], 23: [6, 30, 54, 78, 102], 24: [6, 28, 54, 80, 106], 25: [6, 32, 58, 84, 110],
  26: [6, 30, 58, 86, 114], 27: [6, 34, 62, 90, 118], 28: [6, 26, 50, 74, 98, 122], 29: [6, 30, 54, 78, 102, 126],
  30: [6, 26, 52, 78, 104, 130], 31: [6, 30, 56, 82, 108, 134], 32: [6, 34, 60, 86, 112, 138], 33: [6, 30, 58, 86, 114, 142],
  34: [6, 34, 62, 90, 118, 146], 35: [6, 30, 54, 78, 102, 126, 150], 36: [6, 24, 50, 76, 102, 128, 154],
  37: [6, 28, 54, 80, 106, 132, 158], 38: [6, 32, 58, 84, 110, 136, 162], 39: [6, 26, 54, 82, 110, 138, 166],
  40: [6, 30, 58, 86, 114, 142, 170],
};

// --- GF(256) arithmetic (primitive polynomial 0x11d) ------------------------
const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
(function initGf() {
  let x = 1;
  for (let i = 0; i < 255; i++) { EXP[i] = x; LOG[x] = i; x <<= 1; if (x & 0x100) x ^= 0x11d; }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
})();
const gfMul = (a, b) => (a === 0 || b === 0) ? 0 : EXP[LOG[a] + LOG[b]];

// Generator polynomial coefficients for the given ECC degree, length `degree`
// (the constant term is at index degree-1; the leading x^degree term, coeff 1,
// is implicit). Canonical form — matches nayuki's QR reference.
function rsGenerator(degree) {
  const result = new Uint8Array(degree);
  result[degree - 1] = 1;                 // start with the monomial 1
  let root = 1;                           // α^0
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < degree; j++) {
      result[j] = gfMul(result[j], root);
      if (j + 1 < degree) result[j] ^= result[j + 1];
    }
    root = gfMul(root, 2);                 // α^(i+1)
  }
  return result;
}

export function rsEncode(data, ecLen) {
  const gen = rsGenerator(ecLen);
  const res = new Uint8Array(ecLen);
  for (const d of data) {
    const factor = d ^ res[0];
    res.copyWithin(0, 1);                  // shift left
    res[ecLen - 1] = 0;
    for (let i = 0; i < ecLen; i++) res[i] ^= gfMul(gen[i], factor);
  }
  return Array.from(res);
}

// --- byte-mode data encoding ------------------------------------------------
const totalDataCodewords = (v) => QR_ECC_M[v].groups.reduce((s, [b, d]) => s + b * d, 0);

function chooseVersion(byteLen, minVersion = 1) {
  for (let v = minVersion; v <= 40; v++) {
    const ccBits = v <= 9 ? 8 : 16;
    const need = 4 + ccBits + byteLen * 8;                 // mode + count + payload
    if (need <= totalDataCodewords(v) * 8) return v;
  }
  throw new Error('QR: data too long for a level-M symbol');
}

export function encodeData(bytes, version) {
  const cap = totalDataCodewords(version) * 8;
  const bits = [];
  const push = (val, len) => { for (let i = len - 1; i >= 0; i--) bits.push((val >> i) & 1); };
  push(0b0100, 4);                                          // byte mode
  push(bytes.length, version <= 9 ? 8 : 16);               // character count
  for (const b of bytes) push(b, 8);
  // Terminator (up to 4 bits) then pad to a byte boundary.
  for (let i = 0; i < 4 && bits.length < cap; i++) bits.push(0);
  while (bits.length % 8 !== 0) bits.push(0);
  // Pad bytes alternate 0xEC / 0x11.
  const pads = [0xEC, 0x11];
  for (let i = 0; bits.length < cap; i++) push(pads[i % 2], 8);
  const codewords = [];
  for (let i = 0; i < bits.length; i += 8) {
    let byte = 0;
    for (let j = 0; j < 8; j++) byte = (byte << 1) | bits[i + j];
    codewords.push(byte);
  }
  return codewords;
}

// Split data codewords into blocks, compute ECC, interleave (final codeword seq).
function buildCodewords(dataCodewords, version) {
  const { ec, groups } = QR_ECC_M[version];
  const blocks = [];
  let pos = 0;
  for (const [numBlocks, dataPerBlock] of groups) {
    for (let b = 0; b < numBlocks; b++) {
      const data = dataCodewords.slice(pos, pos + dataPerBlock);
      pos += dataPerBlock;
      blocks.push({ data, ecc: rsEncode(data, ec) });
    }
  }
  const maxData = Math.max(...blocks.map((b) => b.data.length));
  const out = [];
  for (let i = 0; i < maxData; i++) for (const blk of blocks) if (i < blk.data.length) out.push(blk.data[i]);
  for (let i = 0; i < ec; i++) for (const blk of blocks) out.push(blk.ecc[i]);
  return out;
}

// --- matrix construction ----------------------------------------------------
function newMatrix(size) {
  const m = [];
  for (let i = 0; i < size; i++) m.push(new Array(size).fill(null)); // null = unset
  return m;
}

function placeFinder(m, r, c) {
  for (let dr = -1; dr <= 7; dr++) for (let dc = -1; dc <= 7; dc++) {
    const rr = r + dr, cc = c + dc;
    if (rr < 0 || cc < 0 || rr >= m.length || cc >= m.length) continue;
    const inRing = dr >= 0 && dr <= 6 && dc >= 0 && dc <= 6;
    const dark = inRing && ((dr === 0 || dr === 6 || dc === 0 || dc === 6) || (dr >= 2 && dr <= 4 && dc >= 2 && dc <= 4));
    m[rr][cc] = dark ? 1 : 0;
  }
}

function reserveFormat(m) {
  const n = m.length;
  const set = (r, c) => { m[r][c] = 2; };                        // 2 = reserved (function area)
  // Copy 1 around the top-left finder (skips the timing line at row/col 6).
  for (let i = 0; i <= 5; i++) { set(8, i); set(i, 8); }
  set(8, 7); set(8, 8); set(7, 8);
  // Copy 2: vertical (7 cells, rows n-1..n-7) + dark module + horizontal (8 cells, cols n-8..n-1).
  for (let i = 0; i < 7; i++) set(n - 1 - i, 8);                 // rows n-1 .. n-7
  for (let i = 0; i < 8; i++) set(8, n - 8 + i);                 // cols n-8 .. n-1
  m[n - 8][8] = 1;                                              // always-dark module
}

function placeAlignment(m, version) {
  const centers = QR_ALIGN[version];
  for (const r of centers) for (const c of centers) {
    // Skip the three finder corners.
    if ((r === 6 && c === 6) || (r === 6 && c === m.length - 7) || (r === m.length - 7 && c === 6)) continue;
    for (let dr = -2; dr <= 2; dr++) for (let dc = -2; dc <= 2; dc++) {
      const ring = Math.max(Math.abs(dr), Math.abs(dc));
      m[r + dr][c + dc] = (ring === 1) ? 0 : 1;
    }
  }
}

function placeTiming(m) {
  const n = m.length;
  for (let i = 8; i < n - 8; i++) {
    const bit = (i % 2 === 0) ? 1 : 0;
    if (m[6][i] === null) m[6][i] = bit;
    if (m[i][6] === null) m[i][6] = bit;
  }
}

function reserveVersion(m, version) {
  if (version < 7) return;
  const n = m.length;
  for (let i = 0; i < 6; i++) for (let j = 0; j < 3; j++) {
    m[i][n - 11 + j] = 2;
    m[n - 11 + j][i] = 2;
  }
}

function buildFunctionMatrix(version) {
  const n = 17 + 4 * version;
  const m = newMatrix(n);
  placeFinder(m, 0, 0);
  placeFinder(m, 0, n - 7);
  placeFinder(m, n - 7, 0);
  reserveFormat(m);
  reserveVersion(m, version);
  placeAlignment(m, version);
  placeTiming(m);
  return m;
}

function placeData(m, codewords) {
  const n = m.length;
  const bits = [];
  for (const cw of codewords) for (let i = 7; i >= 0; i--) bits.push((cw >> i) & 1);
  let idx = 0;
  let upward = true;
  for (let col = n - 1; col > 0; col -= 2) {
    if (col === 6) col = 5;                                   // skip the vertical timing column
    for (let i = 0; i < n; i++) {
      const row = upward ? n - 1 - i : i;
      for (let c = 0; c < 2; c++) {
        const cc = col - c;
        if (m[row][cc] === null) {
          m[row][cc] = idx < bits.length ? bits[idx] : 0;
          idx++;
        }
      }
    }
    upward = !upward;
  }
}

const MASKS = [
  (r, c) => (r + c) % 2 === 0,
  (r) => r % 2 === 0,
  (r, c) => c % 3 === 0,
  (r, c) => (r + c) % 3 === 0,
  (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
  (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
  (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
  (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
];

const isFunction = (v) => v === 2 || v === 3;                 // reserved or always-dark marker
// We mark data cells as 0/1 and function cells as 2 (reserved) / 1-from-finders.
// To distinguish, we track a separate function map.

function applyMask(matrix, funcMap, maskIndex) {
  const n = matrix.length;
  const out = matrix.map((row) => row.slice());
  const fn = MASKS[maskIndex];
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) {
    if (!funcMap[r][c] && fn(r, c)) out[r][c] ^= 1;
  }
  return out;
}

// BCH-encoded 15-bit format information (level M = 0b00).
function formatBits(maskIndex) {
  const data = (0b00 << 3) | maskIndex;                      // ecLevel(M=00) + mask
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ (((rem >> 9) & 1) ? 0x537 : 0);
  const bits = ((data << 10) | rem) ^ 0x5412;
  return bits & 0x7fff;
}

function placeFormat(matrix, maskIndex) {
  const n = matrix.length;
  const bits = formatBits(maskIndex);
  const f = (i) => (bits >> (14 - i)) & 1;   // f(0) = MSB (b14), placed first at (8,0)
  // Copy 1 around the top-left finder.
  for (let i = 0; i <= 5; i++) matrix[8][i] = f(i);
  matrix[8][7] = f(6); matrix[8][8] = f(7); matrix[7][8] = f(8);
  for (let i = 9; i <= 14; i++) matrix[14 - i][8] = f(i);       // (5,8)=f(9) .. (0,8)=f(14)
  // Copy 2: vertical f(0..6) up the right of the bottom-left finder, then
  // horizontal f(7..14) left of the top-right finder, then the dark module.
  for (let i = 0; i <= 6; i++) matrix[n - 1 - i][8] = f(i);      // rows n-1..n-7
  for (let i = 0; i <= 7; i++) matrix[8][n - 8 + i] = f(7 + i);  // cols n-8..n-1
  matrix[n - 8][8] = 1;                                          // dark module
}

// BCH-encoded 18-bit version information (v >= 7).
function placeVersion(matrix, version) {
  if (version < 7) return;
  let rem = version;
  for (let i = 0; i < 12; i++) rem = (rem << 1) ^ (((rem >> 11) & 1) ? 0x1f25 : 0);
  const bits = (version << 12) | rem;
  const n = matrix.length;
  for (let i = 0; i < 18; i++) {
    const bit = (bits >> i) & 1;
    const r = Math.floor(i / 3), c = i % 3;
    matrix[r][n - 11 + c] = bit;
    matrix[n - 11 + c][r] = bit;
  }
}

// --- penalty scoring (choose the best mask) ---------------------------------
function penalty(m) {
  const n = m.length;
  let score = 0;
  // Rule 1: runs of 5+ same-colour modules in rows and columns.
  for (let r = 0; r < n; r++) {
    let runC = 1, runR = 1;
    for (let c = 1; c < n; c++) {
      if (m[r][c] === m[r][c - 1]) { runC++; if (runC === 5) score += 3; else if (runC > 5) score++; } else runC = 1;
      if (m[c][r] === m[c - 1][r]) { runR++; if (runR === 5) score += 3; else if (runR > 5) score++; } else runR = 1;
    }
  }
  // Rule 2: 2x2 blocks of the same colour.
  for (let r = 0; r < n - 1; r++) for (let c = 0; c < n - 1; c++) {
    const v = m[r][c];
    if (v === m[r][c + 1] && v === m[r + 1][c] && v === m[r + 1][c + 1]) score += 3;
  }
  // Rule 3: finder-like pattern 1:1:3:1:1 with 4 light either side.
  const pat1 = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0];
  const pat2 = [0, 0, 0, 0, 1, 0, 1, 1, 1, 0, 1];
  for (let r = 0; r < n; r++) for (let c = 0; c <= n - 11; c++) {
    let a = true, b = true;
    for (let k = 0; k < 11; k++) { if (m[r][c + k] !== pat1[k]) a = false; if (m[r][c + k] !== pat2[k]) b = false; }
    if (a || b) score += 40;
    let a2 = true, b2 = true;
    for (let k = 0; k < 11; k++) { if (m[c + k][r] !== pat1[k]) a2 = false; if (m[c + k][r] !== pat2[k]) b2 = false; }
    if (a2 || b2) score += 40;
  }
  // Rule 4: deviation of dark-module ratio from 50%.
  let dark = 0;
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) dark += m[r][c];
  const pct = (dark * 100) / (n * n);
  score += Math.floor(Math.abs(pct - 50) / 5) * 10;
  return score;
}

// --- public API -------------------------------------------------------------
/** Encode `text` (UTF-8) as a QR level-M matrix. Returns a 2D array of 0/1.
 *  @param {string} text
 *  @param {{minVersion?:number, mask?:number}} [opts]
 *  @returns {number[][]} */
export function qrMatrix(text, { minVersion = 1, mask } = {}) {
  const bytes = Array.from(new TextEncoder().encode(text));
  const version = chooseVersion(bytes.length, minVersion);
  const dataCodewords = encodeData(bytes, version);
  const codewords = buildCodewords(dataCodewords, version);

  const funcMatrix = buildFunctionMatrix(version);
  const funcMap = funcMatrix.map((row) => row.map((v) => v !== null));

  // Fill reserved (2) placeholders with 0 before data placement so they read as
  // set-but-empty; data placement only writes into null cells.
  const base = funcMatrix.map((row) => row.map((v) => (v === 2 ? 0 : v)));
  placeData(base, codewords);

  let best = null, bestScore = Infinity;
  const candidates = (mask === undefined) ? [0, 1, 2, 3, 4, 5, 6, 7] : [mask];
  for (const mi of candidates) {
    const masked = applyMask(base, funcMap, mi);
    placeFormat(masked, mi);
    placeVersion(masked, version);
    const s = penalty(masked);
    if (s < bestScore) { bestScore = s; best = masked; }
  }
  return best;
}

/** Render a QR matrix as a crisp, self-contained SVG string.
 *  @param {string} text
 *  @param {{quiet?:number, size?:number, dark?:string, light?:string, title?:string}} [opts] */
export function qrSvg(text, { quiet = 4, size = 232, dark = '#0b0b0f', light = '#ffffff', title = 'GiroCode' } = {}) {
  const m = qrMatrix(text);
  const n = m.length;
  const dim = n + quiet * 2;
  let rects = '';
  for (let r = 0; r < n; r++) {
    let c = 0;
    while (c < n) {
      if (m[r][c]) {
        let w = 1;
        while (c + w < n && m[r][c + w]) w++;
        rects += `<rect x="${c + quiet}" y="${r + quiet}" width="${w}" height="1"/>`;
        c += w;
      } else c++;
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${dim} ${dim}" role="img" aria-label="${title}" shape-rendering="crispEdges"><rect width="${dim}" height="${dim}" fill="${light}"/><g fill="${dark}">${rects}</g></svg>`;
}
