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

/** Structural-only check for legacy base58 addresses (no base58check sha256d,
 *  to stay sync + dependency-free). Modern wallets default to bech32, which we
 *  fully checksum above; this only keeps legacy addresses usable. */
function looksLikeLegacy(addr, network) {
  if (!/^[123mn2][1-9A-HJ-NP-Za-km-z]{24,38}$/.test(addr)) return false;
  if (network === 'mainnet') return /^[13]/.test(addr);
  if (network === 'testnet' || network === 'regtest' || network === 'signet') return /^[mn2]/.test(addr);
  return true; // unknown network: accept structurally
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
