/* Wallet seam.
 *
 * Bisq Easy is non-custodial: it delivers BTC to whatever address the buyer
 * supplies. So the receive address / balance / withdraw concerns live *outside*
 * the trading backend, behind this small interface. The BisqAdapter depends on
 * the interface, never on a concrete wallet.
 *
 * v1 ships `ExternalWallet`: the user brings a receive address from their own
 * wallet (hardware, Sparrow, …). We hold **no keys** — the smallest possible
 * attack surface and the cleanest posture against bright line #1 (no custody).
 * An embedded wallet (bdk in the Rust shell) can implement the same interface
 * later as its own reviewed project.
 *
 * @typedef {Object} Wallet
 * @property {() => Promise<string>} getReceiveAddress  fresh/next receive address
 * @property {() => Promise<{confirmedSats:number|null, pendingSats:number|null, external?:boolean}>} getBalance
 * @property {(address:string, amountSats:number) => Promise<string>} withdraw  → txid
 */

// ---- bech32 / bech32m checksum (BIP173 / BIP350), dependency-free ----------
const CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];

function polymod(values) {
  let chk = 1;
  for (const v of values) {
    const top = chk >>> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) if ((top >>> i) & 1) chk ^= GEN[i];
  }
  return chk >>> 0;
}

function hrpExpand(hrp) {
  const ret = [];
  for (let i = 0; i < hrp.length; i++) ret.push(hrp.charCodeAt(i) >>> 5);
  ret.push(0);
  for (let i = 0; i < hrp.length; i++) ret.push(hrp.charCodeAt(i) & 31);
  return ret;
}

// 5-bit groups → 8-bit bytes (for witness-program length checks).
function convertBits(data, from, to, pad) {
  let acc = 0, bits = 0;
  const ret = [];
  const maxv = (1 << to) - 1;
  for (const value of data) {
    if (value < 0 || value >> from) return null;
    acc = (acc << from) | value;
    bits += from;
    while (bits >= to) { bits -= to; ret.push((acc >> bits) & maxv); }
  }
  if (pad) { if (bits) ret.push((acc << (to - bits)) & maxv); }
  else if (bits >= from || ((acc << (to - bits)) & maxv)) return null;
  return ret;
}

/** Decode a segwit address and verify its bech32/bech32m checksum + witness
 *  program. Returns {hrp, version, program} or null if invalid. */
function decodeSegwit(addr) {
  if (typeof addr !== 'string') return null;
  if (addr.length < 8 || addr.length > 90) return null;
  if (addr.toLowerCase() !== addr && addr.toUpperCase() !== addr) return null; // no mixed case
  const a = addr.toLowerCase();
  const pos = a.lastIndexOf('1');
  if (pos < 1 || pos + 7 > a.length) return null;
  const hrp = a.slice(0, pos);
  const data = [];
  for (const ch of a.slice(pos + 1)) {
    const d = CHARSET.indexOf(ch);
    if (d === -1) return null;
    data.push(d);
  }
  const chk = polymod(hrpExpand(hrp).concat(data));
  const version = data[0];
  const isBech32 = chk === 1;
  const isBech32m = chk === 0x2bc830a3;
  // v0 must use bech32; v1+ must use bech32m (BIP350).
  if (version === 0 && !isBech32) return null;
  if (version >= 1 && !isBech32m) return null;
  if (!isBech32 && !isBech32m) return null;
  if (version > 16) return null;
  const program = convertBits(data.slice(1, data.length - 6), 5, 8, false);
  if (!program || program.length < 2 || program.length > 40) return null;
  if (version === 0 && program.length !== 20 && program.length !== 32) return null;
  return { hrp, version, program };
}

const HRP_BY_NETWORK = { mainnet: 'bc', testnet: 'tb', signet: 'tb', regtest: 'bcrt' };

// --- base58check, for legacy addresses ------------------------------------
//
// SECURITY (audit finding 2): legacy addresses used to get a structural regex
// check only, so a single mistyped character validated happily and the coins
// went somewhere unspendable with no recourse. bech32/bech32m were already
// fully checksummed above; legacy is now too.
//
// That needs SHA-256, and isValidBtcAddress is synchronous while crypto.subtle
// is not, so a compact implementation lives here instead of a dependency (the
// app ships no runtime dependencies by design). Verified against the FIPS-180-4
// vectors and real addresses in tests/security.test.js.

const SHA_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

const rotr = (x, n) => ((x >>> n) | (x << (32 - n))) >>> 0;

/** SHA-256 over a byte array. @param {Uint8Array} bytes @returns {Uint8Array} */
export function sha256(bytes) {
  const H = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
    0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  const len = bytes.length;
  const padded = new Uint8Array(((len + 9 + 63) >> 6) << 6);
  padded.set(bytes);
  padded[len] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, Math.floor((len * 8) / 2 ** 32));
  view.setUint32(padded.length - 4, (len * 8) >>> 0);

  const w = new Uint32Array(64);
  for (let off = 0; off < padded.length; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(off + i * 4);
    for (let i = 16; i < 64; i++) {
      const x = w[i - 15], y = w[i - 2];
      const s0 = (rotr(x, 7) ^ rotr(x, 18) ^ (x >>> 3)) >>> 0;
      const s1 = (rotr(y, 17) ^ rotr(y, 19) ^ (y >>> 10)) >>> 0;
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, h] = H;
    for (let i = 0; i < 64; i++) {
      const S1 = (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) >>> 0;
      const t1 = (h + S1 + (((e & f) ^ (~e & g)) >>> 0) + SHA_K[i] + w[i]) >>> 0;
      const S0 = (rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) >>> 0;
      const t2 = (S0 + (((a & b) ^ (a & c) ^ (b & c)) >>> 0)) >>> 0;
      h = g; g = f; f = e; e = (d + t1) >>> 0;
      d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    H[0] = (H[0] + a) >>> 0; H[1] = (H[1] + b) >>> 0;
    H[2] = (H[2] + c) >>> 0; H[3] = (H[3] + d) >>> 0;
    H[4] = (H[4] + e) >>> 0; H[5] = (H[5] + f) >>> 0;
    H[6] = (H[6] + g) >>> 0; H[7] = (H[7] + h) >>> 0;
  }
  const out = new Uint8Array(32);
  const odv = new DataView(out.buffer);
  for (let i = 0; i < 8; i++) odv.setUint32(i * 4, H[i]);
  return out;
}

const B58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

/** Version bytes: [P2PKH, P2SH] per chain. testnet/signet/regtest share them. */
const B58_VERSIONS = {
  mainnet: [0x00, 0x05],
  testnet: [0x6f, 0xc4],
  signet: [0x6f, 0xc4],
  regtest: [0x6f, 0xc4],
};

/** @returns {Uint8Array|null} */
function base58Decode(str) {
  if (typeof str !== 'string' || !str) return null;
  const bytes = [];
  for (const ch of str) {
    const v = B58_ALPHABET.indexOf(ch);
    if (v < 0) return null;                   // '0', 'O', 'I', 'l' and friends
    let carry = v;
    for (let j = 0; j < bytes.length; j++) {
      carry += bytes[j] * 58;
      bytes[j] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) { bytes.push(carry & 0xff); carry >>= 8; }
  }
  for (let i = 0; i < str.length && str[i] === '1'; i++) bytes.push(0);  // leading zero bytes
  bytes.reverse();
  return Uint8Array.from(bytes);
}

/** Decode a base58check address and verify its checksum.
 *  @returns {number|null} the version byte, or null if it does not check out */
function base58CheckVersion(addr) {
  const raw = base58Decode(addr);
  if (!raw || raw.length !== 25) return null;       // 1 version + 20 hash + 4 checksum
  const body = raw.subarray(0, 21);
  const sum = sha256(sha256(body));
  for (let i = 0; i < 4; i++) if (sum[i] !== raw[21 + i]) return null;
  return body[0];
}

/** Legacy (base58check) address, checksum-verified and chain-checked. */
function looksLikeLegacy(addr, network) {
  const version = base58CheckVersion(addr);
  if (version === null) return false;
  if (!network) return Object.values(B58_VERSIONS).some((vs) => vs.includes(version));
  const allowed = B58_VERSIONS[network];
  return !!allowed && allowed.includes(version);
}

/** Validate a Bitcoin receive address. bech32/bech32m addresses get a full
 *  checksum + witness-program check (catches paste typos); legacy addresses
 *  get a structural check. Pass `network` to also enforce the right chain.
 *  @returns {boolean} */
export function isValidBtcAddress(addr, { network } = {}) {
  if (typeof addr !== 'string' || !addr.trim()) return false;
  const a = addr.trim();
  const seg = decodeSegwit(a);
  if (seg) {
    if (network && seg.hrp !== HRP_BY_NETWORK[network]) return false;
    if (!network && !Object.values(HRP_BY_NETWORK).includes(seg.hrp)) return false;
    return true;
  }
  return looksLikeLegacy(a, network);
}

/** External-wallet mode: the user supplies a receive address from a wallet we
 *  never touch. Balance is not ours to know (funds live in the user's wallet),
 *  and there is nothing for us to "withdraw" — the BTC is already theirs. */
export class ExternalWallet {
  /** @param {{address?:string, addressProvider?:()=>Promise<string>|string, network?:string}} opts
   *   Supply either a static `address` or an async `addressProvider` (for
   *   wallets that hand out a fresh address each time). `network` enforces the
   *   chain during validation. */
  constructor({ address, addressProvider, network } = {}) {
    if (!address && !addressProvider) {
      throw new Error('ExternalWallet needs an address or an addressProvider');
    }
    if (address && !isValidBtcAddress(address, { network })) {
      throw new Error(`ExternalWallet: invalid receive address for ${network || 'any'} network: ${address}`);
    }
    this.address = address;
    this.addressProvider = addressProvider;
    this.network = network;
  }

  async getReceiveAddress() {
    const addr = this.addressProvider ? await this.addressProvider() : this.address;
    if (!isValidBtcAddress(addr, { network: this.network })) {
      throw new Error(`ExternalWallet: address failed validation: ${addr}`);
    }
    return addr;
  }

  /** We do not custody funds, so we cannot report a balance. The UI should
   *  render this as "held in your own wallet", not as zero. */
  async getBalance() {
    return { confirmedSats: null, pendingSats: null, external: true };
  }

  async withdraw() {
    throw new Error(
      'withdraw is not available in external-wallet mode — the bitcoin is ' +
      'delivered straight to your own wallet, which already controls it.',
    );
  }
}
