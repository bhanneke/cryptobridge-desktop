/* Bisq 2 pairing codes.
 *
 * A node with `authorizationRequired=true` prints a pairing QR (and logs the
 * code id). The user scans or pastes it; we exchange it once for durable
 * credentials and a short-lived session:
 *
 *   POST /access/pairing  {version, pairingCodeId, clientName}
 *                      -> {version, clientId, clientSecret, sessionId, sessionExpiryDate}
 *   POST /access/session  {clientId, clientSecret}
 *                      -> {sessionId, expiresAt}
 *
 * and every authenticated request then carries `Bisq-Client-Id` and
 * `Bisq-Session-Id`.
 *
 * The wire format below is transcribed from the bisq2 sources rather than
 * guessed — see docs/PAIRING_AUTH.md for the exact classes and field order.
 * All integers are big-endian; byte arrays carry an unsigned 16-bit length
 * prefix; the whole blob is base64url.
 *
 *   PairingQrCode := version:u8
 *                    pairingCode:bytes(u16-len)   // nested, see below
 *                    webSocketUrl:bytes(u16-len)  // UTF-8
 *                    flags:u8                     // 1=TLS fingerprint, 2=Tor auth
 *                    [tlsFingerprint:bytes(u16-len)]
 *                    [torClientAuthSecret:bytes(u16-len)]
 *
 *   PairingCode   := version:u8
 *                    id:bytes(u16-len)            // UTF-8 UUID
 *                    expiresAt:i64                // epoch millis
 *                    permissionCount:i32
 *                    permissionId:i32 * count
 */

export const PAIRING_QR_VERSION = 1;
export const PAIRING_CODE_VERSION = 1;
const FLAG_TLS_FINGERPRINT = 1;
const FLAG_TOR_CLIENT_AUTH = 1 << 1;

/** Permission ids as of bisq2 2.1.11 — unknown ids are surfaced numerically
 *  rather than dropped, so a newer node does not silently lose meaning. */
export const PERMISSIONS = {
  0: 'TRADE_CHAT_CHANNELS', 1: 'EXPLORER', 2: 'MARKET_PRICE', 3: 'OFFERBOOK',
  4: 'PAYMENT_ACCOUNTS', 5: 'REPUTATION', 6: 'SETTINGS', 7: 'TRADES',
  8: 'USER_IDENTITIES', 9: 'USER_PROFILES', 10: 'MOBILE_DEVICES',
};

/** Everything the buyer flow touches. Checked after pairing so a too-narrow
 *  code fails loudly here instead of as a 403 halfway through a trade. */
export const REQUIRED_PERMISSIONS = ['MARKET_PRICE', 'OFFERBOOK', 'TRADES'];

function base64urlToBytes(text) {
  const norm = String(text).trim().replace(/-/g, '+').replace(/_/g, '/');
  const padded = norm + '='.repeat((4 - (norm.length % 4)) % 4);
  let binary;
  try {
    binary = atob(padded);
  } catch {
    throw new Error('pairing code is not valid base64url');
  }
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/** Bounds-checked big-endian reader; a truncated code must fail cleanly. */
class Reader {
  constructor(bytes) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.bytes = bytes;
    this.pos = 0;
  }
  _need(n) {
    if (this.pos + n > this.bytes.length) throw new Error('pairing code is truncated');
  }
  u8() { this._need(1); return this.view.getUint8(this.pos++); }
  i32() { this._need(4); const v = this.view.getInt32(this.pos); this.pos += 4; return v; }
  i64() { this._need(8); const v = this.view.getBigInt64(this.pos); this.pos += 8; return Number(v); }
  bytes_() {
    this._need(2);
    const len = this.view.getUint16(this.pos);
    this.pos += 2;
    this._need(len);
    const out = this.bytes.subarray(this.pos, this.pos + len);
    this.pos += len;
    return out;
  }
  utf8() { return new TextDecoder().decode(this.bytes_()); }
  get done() { return this.pos >= this.bytes.length; }
}

/** Decode the inner pairing code. @returns {{version:number,id:string,expiresAt:number,permissions:string[]}} */
export function decodePairingCode(bytes) {
  const r = new Reader(bytes);
  const version = r.u8();
  if (version !== PAIRING_CODE_VERSION) {
    throw new Error(`unsupported pairing code version ${version} (expected ${PAIRING_CODE_VERSION})`);
  }
  const id = r.utf8();
  const expiresAt = r.i64();
  const count = r.i32();
  if (count < 0 || count > 64) throw new Error(`implausible permission count ${count}`);
  const permissions = [];
  for (let i = 0; i < count; i++) {
    const pid = r.i32();
    permissions.push(PERMISSIONS[pid] ?? `UNKNOWN_${pid}`);
  }
  return { version, id, expiresAt, permissions };
}

/** Decode a full pairing QR payload (what the user scans or pastes). */
export function decodePairingQr(text) {
  const r = new Reader(base64urlToBytes(text));
  const version = r.u8();
  if (version !== PAIRING_QR_VERSION) {
    throw new Error(`unsupported pairing QR version ${version} (expected ${PAIRING_QR_VERSION})`);
  }
  const pairingCode = decodePairingCode(r.bytes_());
  const webSocketUrl = r.utf8();
  const flags = r.u8();
  const tlsFingerprint = (flags & FLAG_TLS_FINGERPRINT) ? r.utf8() : null;
  const torClientAuthSecret = (flags & FLAG_TOR_CLIENT_AUTH) ? r.utf8() : null;
  return { version, pairingCode, webSocketUrl, tlsFingerprint, torClientAuthSecret };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Accept whatever the user actually has in hand:
 *  - a full pairing QR payload (base64url) — also yields the node's WebSocket URL
 *  - a bare pairing code id (the UUID the node logs), for headless setups
 *
 * @returns {{pairingCodeId:string, webSocketUrl:string|null, expiresAt:number|null,
 *            permissions:string[]|null, tlsFingerprint:string|null, torClientAuthSecret:string|null}}
 */
export function parsePairingInput(text) {
  const raw = String(text ?? '').trim();
  if (!raw) throw new Error('no pairing code supplied');

  if (UUID_RE.test(raw)) {
    return {
      pairingCodeId: raw, webSocketUrl: null, expiresAt: null,
      permissions: null, tlsFingerprint: null, torClientAuthSecret: null,
    };
  }

  const qr = decodePairingQr(raw);
  return {
    pairingCodeId: qr.pairingCode.id,
    webSocketUrl: qr.webSocketUrl,
    expiresAt: qr.pairingCode.expiresAt,
    permissions: qr.pairingCode.permissions,
    tlsFingerprint: qr.tlsFingerprint,
    torClientAuthSecret: qr.torClientAuthSecret,
  };
}

/** Pairing codes carry a short TTL (~5 min). `now` is injectable for tests. */
export function isPairingExpired(parsed, now = Date.now()) {
  return parsed?.expiresAt != null && parsed.expiresAt <= now;
}

/** Which of the permissions the buyer flow needs are missing. */
export function missingPermissions(parsed) {
  if (!parsed?.permissions) return [];   // bare id: the node decides, we cannot check
  return REQUIRED_PERMISSIONS.filter((p) => !parsed.permissions.includes(p));
}
