/* QR encoder tests (runs in CI under `npm test`, no deps).
 *
 * The encoder was verified during development against the segno reference AND by
 * rendering every output to an image and decoding it with OpenCV (a real QR
 * reader) — see the dev harness. CI can't run OpenCV, so we lock correctness two
 * self-contained ways:
 *   1. A golden known-answer matrix for "HELLO WORLD" (the exact bytes that were
 *      proven to scan), so any regression in encoding/placement/masking trips.
 *   2. A Reed-Solomon validity check: the data+ECC codeword, evaluated at the
 *      generator's roots (α^0..α^9), must yield all-zero syndromes — the same
 *      property a decoder relies on to error-correct. This catches ECC bugs
 *      without needing a full decoder.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { qrMatrix, qrSvg, rsEncode } from '../src/vendor/qr.js';

// GF(256) with QR's primitive polynomial, for an independent syndrome check.
const EXP = new Uint8Array(512), LOG = new Uint8Array(256);
(() => { let x = 1; for (let i = 0; i < 255; i++) { EXP[i] = x; LOG[x] = i; x <<= 1; if (x & 0x100) x ^= 0x11d; } for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255]; })();
const mul = (a, b) => (a === 0 || b === 0) ? 0 : EXP[LOG[a] + LOG[b]];

function syndromes(codeword, nsym) {
  const s = [];
  for (let i = 0; i < nsym; i++) {
    let acc = 0;
    for (const b of codeword) acc = mul(acc, EXP[i]) ^ b;
    s.push(acc);
  }
  return s;
}

test('Reed-Solomon ECC produces a valid codeword (all-zero syndromes)', () => {
  // "HELLO WORLD" byte-mode v1-M data codewords.
  const data = [0x40, 0xB4, 0x84, 0x54, 0xC4, 0xC4, 0xF2, 0x05, 0x74, 0xF5, 0x24, 0xC4, 0x40, 0xEC, 0x11, 0xEC];
  const ecc = rsEncode(data, 10);
  assert.deepEqual(syndromes([...data, ...ecc], 10), new Array(10).fill(0));
});

test('rsEncode is deterministic and matches the verified vector', () => {
  const data = [0x40, 0xB4, 0x84, 0x54, 0xC4, 0xC4, 0xF2, 0x05, 0x74, 0xF5, 0x24, 0xC4, 0x40, 0xEC, 0x11, 0xEC];
  assert.deepEqual(rsEncode(data, 10), [0x0c, 0x4b, 0xcf, 0x9a, 0x89, 0x4f, 0x65, 0x09, 0x97, 0xcc]);
});

test('golden matrix: "HELLO WORLD" at mask 0 (proven to scan)', () => {
  const golden = [
    '111111100110101111111', '100000101100101000001', '101110100000101011101', '101110100011001011101',
    '101110101100101011101', '100000100100101000001', '111111101010101111111', '000000000011100000000',
    '101010100101000010010', '101001000110001100010', '100010111110110111111', '101100011110000010010',
    '101100111000111110100', '000000001111010000110', '111111100011000110111', '100000100111100100001',
    '101110101111001010100', '101110100001001110110', '101110101010101010101', '100000100011000010010',
    '111111101101101100111',
  ];
  const m = qrMatrix('HELLO WORLD', { mask: 0 });
  assert.deepEqual(m.map((r) => r.join('')), golden);
});

test('version scales with data length', () => {
  assert.equal(qrMatrix('HELLO WORLD').length, 21);                 // v1
  assert.equal(qrMatrix('x'.repeat(30)).length, 29);               // v3 (>26 bytes)
  const big = qrMatrix('x'.repeat(120));
  assert.ok(big.length >= 37, `expected >= v5, got ${big.length}`); // long EPC payloads
});

test('qrSvg is self-contained and faithful to the matrix', () => {
  const text = 'BCD\n002\n1\nSCT\n\nAlice\nDE02120300000000202051\nEUR50.00\n\n\n\n';
  const svg = qrSvg(text, { quiet: 4 });
  assert.ok(svg.startsWith('<svg') && svg.includes('</svg>'));
  // CSP-safe: no fetchable references (the xmlns namespace URL is not a fetch).
  assert.ok(!/\b(href|src)\s*=/.test(svg) && !/url\(/.test(svg) && !/<image\b/.test(svg), 'no external references');
  // Parse the rects back and compare to the matrix it renders.
  const dim = Number(svg.match(/viewBox="0 0 (\d+) /)[1]);
  const quiet = 4, n = dim - 2 * quiet;
  const parsed = Array.from({ length: n }, () => new Array(n).fill(0));
  for (const mm of svg.matchAll(/<rect x="(\d+)" y="(\d+)" width="(\d+)" height="1"\/>/g)) {
    const x = +mm[1] - quiet, y = +mm[2] - quiet, w = +mm[3];
    for (let k = 0; k < w; k++) parsed[y][x + k] = 1;
  }
  const m = qrMatrix(text);
  assert.deepEqual(parsed, m);
});
