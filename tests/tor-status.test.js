/* Tests for the node's trade-traffic transport check.
 *
 * The thing being protected here is narrow and worth stating: a user who sends
 * a SEPA transfer to a stranger should know whether that stranger can see
 * their IP address. The node knows; nothing asked it until now. */
import test from 'node:test';
import assert from 'node:assert/strict';

import { transportMap, classifyTransport, privacyVerdict, TRANSPORT } from '../src/adapters/tor-status.js';

/** Shaped like a real UserProfileDto: a record-wrapped map. */
function profile(map) {
  return { networkId: { addressByTransportTypeMap: { map }, pubKey: { id: 'x' } } };
}
const TOR_ONLY = profile({ TOR: { host: 'abcdef123456.onion', port: 1000 } });
const CLEAR_ONLY = profile({ CLEAR: { host: '91.2.3.4', port: 2000 } });
const BOTH = profile({
  TOR: { host: 'abcdef123456.onion', port: 1000 },
  CLEAR: { host: '91.2.3.4', port: 2000 },
});

test('reads the transport map from a real DTO shape', () => {
  assert.deepEqual(Object.keys(transportMap(TOR_ONLY)), ['TOR']);
  assert.equal(transportMap(TOR_ONLY).TOR.host, 'abcdef123456.onion');
});

test('tolerates the map being flattened rather than record-wrapped', () => {
  const flat = { networkId: { addressByTransportTypeMap: { TOR: { host: 'x.onion', port: 1 } } } };
  assert.deepEqual(Object.keys(transportMap(flat)), ['TOR']);
});

test('a missing or malformed profile yields nothing rather than throwing', () => {
  for (const bad of [null, undefined, {}, { networkId: null }, { networkId: { addressByTransportTypeMap: 7 } }]) {
    assert.deepEqual(transportMap(bad), {});
  }
});

test('unknown transport keys are ignored, not trusted', () => {
  const odd = profile({ TOR: { host: 'x.onion', port: 1 }, CARRIER_PIGEON: { host: 'h', port: 2 } });
  assert.deepEqual(Object.keys(transportMap(odd)), ['TOR']);
});

test('classify reports what is actually advertised', () => {
  const c = classifyTransport(BOTH);
  assert.equal(c.tor, true);
  assert.equal(c.clearnet, true);
  assert.equal(c.onion, 'abcdef123456.onion');
  assert.deepEqual(c.transports, ['CLEAR', 'TOR']);
});

// ---- the verdicts ---------------------------------------------------------

test('Tor only on mainnet is the clean case', () => {
  const v = privacyVerdict(TOR_ONLY, 'mainnet');
  assert.equal(v.level, 'ok');
  assert.match(v.detail, /abcdef123456\.onion/);
});

test('clearnet on mainnet blocks — real money to a stranger who can see your IP', () => {
  const v = privacyVerdict(CLEAR_ONLY, 'mainnet');
  assert.equal(v.level, 'block');
  assert.match(v.detail, /see your IP address/);
  assert.match(v.detail, /supportedTransportTypes/, 'must say how to fix it');
});

/* The important subtlety: advertising Tor does NOT make a clearnet address
 * safe. A peer who can see the clearnet address can reach the user directly. */
test('Tor plus clearnet still blocks, because the clear address is reachable', () => {
  const v = privacyVerdict(BOTH, 'mainnet');
  assert.equal(v.level, 'block');
  assert.match(v.headline, /as well as Tor/);
});

test('on test networks the same finding warns instead of blocking', () => {
  for (const net of ['regtest', 'testnet', 'signet']) {
    assert.equal(privacyVerdict(CLEAR_ONLY, net).level, 'warn', net);
    assert.equal(privacyVerdict(BOTH, net).level, 'warn', net);
  }
  // ...but a good node is still reported as good.
  assert.equal(privacyVerdict(TOR_ONLY, 'regtest').level, 'ok');
});

test('"bitcoin" is treated as mainnet, since Bisq and BDK spell it differently', () => {
  assert.equal(privacyVerdict(CLEAR_ONLY, 'bitcoin').level, 'block');
});

test('an unreadable mainnet profile blocks trading', () => {
  const v = privacyVerdict(null, 'mainnet');
  assert.equal(v.level, 'block');
  assert.match(v.detail, /Treat it as visible/);
});

test('I2P-only is not silently called Tor', () => {
  const v = privacyVerdict(profile({ I2P: { host: 'x.i2p', port: 1 } }), 'mainnet');
  assert.equal(v.level, 'warn');
  assert.match(v.headline, /I2P/);
  assert.doesNotMatch(v.headline, /goes over Tor/);
});

test('every verdict carries a headline and a detail the UI can show', () => {
  for (const p of [TOR_ONLY, CLEAR_ONLY, BOTH, null]) {
    for (const net of ['mainnet', 'regtest']) {
      const v = privacyVerdict(p, net);
      assert.ok(['ok', 'warn', 'block'].includes(v.level));
      assert.ok(v.headline.length > 0 && v.detail.length > 0);
    }
  }
});

test('TRANSPORT is frozen so a typo cannot silently add a transport', () => {
  assert.throws(() => { 'use strict'; TRANSPORT.NEW = 'x'; });
});
