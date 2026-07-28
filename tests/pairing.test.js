/* Pairing-code tests.
 *
 * The golden vector below is a real pairing QR emitted by bisq2 2.1.11 running
 * with authorizationRequired=true (captured from pairing_qr_code.txt in the
 * node's data dir). That matters: a round-trip against our own encoder would
 * only prove we agree with ourselves, which is exactly how an encoding bug
 * survived review in the QR work. This vector was produced by the Java side. */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  decodePairingQr, parsePairingInput, isPairingExpired, missingPermissions,
  PERMISSIONS, REQUIRED_PERMISSIONS,
} from '../src/adapters/pairing.js';

/** Real artifact: node logged "Code ID: c3a6951a-0763-4616-8af3-8165f85d2106
 *  (expires at: 2026-07-25T02:09:52.190437Z)". */
const GOLDEN_QR =
  'AQBfAQAkYzNhNjk1MWEtMDc2My00NjE2LThhZjMtODE2NWY4NWQyMTA2AAABn5cJOj4AAAAL'
  + 'AAAAAAAAAAEAAAACAAAAAwAAAAQAAAAFAAAABgAAAAcAAAAIAAAACQAAAAoAE3dzOi8vMTI3LjAuMC4xOjgwOTIA';

const GOLDEN_ID = 'c3a6951a-0763-4616-8af3-8165f85d2106';

test('decodes a real Bisq pairing QR', () => {
  const qr = decodePairingQr(GOLDEN_QR);
  assert.equal(qr.version, 1);
  assert.equal(qr.pairingCode.id, GOLDEN_ID, 'id must match the id the node logged');
  assert.equal(
    new Date(qr.pairingCode.expiresAt).toISOString(),
    '2026-07-25T02:09:52.190Z',
    'expiry must match the node log',
  );
  assert.equal(qr.webSocketUrl, 'ws://127.0.0.1:8092');
  assert.equal(qr.tlsFingerprint, null);
  assert.equal(qr.torClientAuthSecret, null);
});

test('decodes every granted permission by name', () => {
  const { pairingCode } = decodePairingQr(GOLDEN_QR);
  assert.equal(pairingCode.permissions.length, 11, 'the node granted all 11');
  // Names, not ids — a wrong table would show up here.
  assert.deepEqual(pairingCode.permissions, Object.values(PERMISSIONS));
  for (const needed of REQUIRED_PERMISSIONS) {
    assert.ok(pairingCode.permissions.includes(needed), `${needed} should be granted`);
  }
});

test('parsePairingInput yields the node URL as well as the code id', () => {
  const parsed = parsePairingInput(GOLDEN_QR);
  assert.equal(parsed.pairingCodeId, GOLDEN_ID);
  assert.equal(parsed.webSocketUrl, 'ws://127.0.0.1:8092');
  assert.deepEqual(missingPermissions(parsed), []);
});

test('a bare code id is accepted for headless setups', () => {
  const parsed = parsePairingInput(`  ${GOLDEN_ID}  `);
  assert.equal(parsed.pairingCodeId, GOLDEN_ID);
  assert.equal(parsed.webSocketUrl, null, 'a bare id carries no URL');
  assert.equal(parsed.permissions, null);
  // Nothing to check against, so nothing is reported missing.
  assert.deepEqual(missingPermissions(parsed), []);
});

test('expiry is honoured', () => {
  const parsed = parsePairingInput(GOLDEN_QR);
  assert.ok(isPairingExpired(parsed, parsed.expiresAt + 1), 'past the expiry it is expired');
  assert.ok(!isPairingExpired(parsed, parsed.expiresAt - 1), 'before it, it is not');
});

test('a code lacking the permissions we need is reported, not silently used', () => {
  // Same structure, but only MARKET_PRICE (id 2) granted.
  const parsed = {
    pairingCodeId: GOLDEN_ID,
    permissions: ['MARKET_PRICE'],
  };
  assert.deepEqual(missingPermissions(parsed).sort(), ['OFFERBOOK', 'TRADES']);
});

test('malformed input fails cleanly rather than yielding a wrong code', () => {
  assert.throws(() => parsePairingInput(''), /no pairing code/);
  assert.throws(() => parsePairingInput('!!!not base64!!!'), /base64url|truncated|version/);
  // Truncated mid-structure.
  assert.throws(() => decodePairingQr(GOLDEN_QR.slice(0, 20)), /truncated|version/);
  // Version byte bumped to 2.
  const bytes = Buffer.from(GOLDEN_QR, 'base64');
  bytes[0] = 2;
  assert.throws(() => decodePairingQr(bytes.toString('base64url')), /unsupported pairing QR version 2/);
});

test('an unknown permission id is surfaced, not dropped', () => {
  // Rewrite the first permission id (0 → 99) so a newer node's unknown
  // permission does not silently vanish from what we show the user.
  const bytes = Buffer.from(GOLDEN_QR, 'base64');
  const marker = bytes.indexOf(Buffer.from([0, 0, 0, 11]));  // permission count
  assert.ok(marker > 0, 'found the permission count in the golden vector');
  bytes.writeInt32BE(99, marker + 4);                        // first permission id
  const qr = decodePairingQr(bytes.toString('base64url'));
  assert.ok(qr.pairingCode.permissions.includes('UNKNOWN_99'));
});
