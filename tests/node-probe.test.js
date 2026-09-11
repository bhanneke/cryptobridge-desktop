/* Tests for the connect screen's node probe. The point of this module is that
 * it tells the user which of three different things went wrong, so most of
 * these check that the distinction survives. */
import test from 'node:test';
import assert from 'node:assert/strict';

import { normaliseNodeUrl, networkFromExplorer, probeNode } from '../src/adapters/node-probe.js';

function transportFor(responses) {
  const calls = [];
  return {
    calls,
    request: async (method, url) => {
      calls.push({ method, url });
      for (const [frag, r] of Object.entries(responses)) {
        if (url.includes(frag)) {
          if (r instanceof Error) throw r;
          return r;
        }
      }
      throw new Error(`unexpected request: ${url}`);
    },
  };
}

// ---- normaliseNodeUrl: be forgiving about what people type ----------------

test('accepts the address with or without scheme and api path', () => {
  const want = 'http://127.0.0.1:8090/api/v1';
  for (const input of [
    '127.0.0.1:8090',
    'http://127.0.0.1:8090',
    'http://127.0.0.1:8090/',
    'http://127.0.0.1:8090/api/v1',
    'http://127.0.0.1:8090/api/v1/',
    '  http://127.0.0.1:8090  ',
  ]) {
    assert.equal(normaliseNodeUrl(input).url, want, `failed for ${JSON.stringify(input)}`);
  }
});

test('an empty address asks for one instead of throwing', () => {
  assert.match(normaliseNodeUrl('').error, /Enter the address/);
  assert.match(normaliseNodeUrl(null).error, /Enter the address/);
});

test('https is refused, because the shell has no TLS backend at all', () => {
  assert.match(normaliseNodeUrl('https://127.0.0.1:8090').error, /Only http/);
});

test('credentials in the URL are refused rather than silently forwarded', () => {
  assert.match(normaliseNodeUrl('http://user:pw@127.0.0.1:8090').error, /username and password/);
});

test('a non-default port survives normalisation', () => {
  assert.equal(normaliseNodeUrl('127.0.0.1:9999').url, 'http://127.0.0.1:9999/api/v1');
  assert.equal(normaliseNodeUrl('[::1]:8090').url, 'http://[::1]:8090/api/v1');
});

/* The Rust proxy accepts literal loopback IPs only and refuses hostnames,
 * localhost included, so that it never resolves names. Client-side validation
 * has to refuse exactly the same set, or the user is told "nothing answered"
 * by a layer they cannot see. */
test('hostnames are refused the way the proxy refuses them', () => {
  assert.match(normaliseNodeUrl('localhost:8090').error, /Use 127\.0\.0\.1 instead of localhost/);
  assert.match(normaliseNodeUrl('my-server.local:8090').error, /must be on this computer/);
  assert.match(normaliseNodeUrl('192.168.1.10:8090').error, /must be on this computer/);
  assert.match(normaliseNodeUrl('8.8.8.8:8090').error, /must be on this computer/);
});

test('the whole 127/8 block is loopback, and 127 lookalikes are not', () => {
  assert.ok(normaliseNodeUrl('127.0.0.1:1').url);
  assert.ok(normaliseNodeUrl('127.1.2.3:1').url);
  assert.match(normaliseNodeUrl('128.0.0.1:1').error, /must be on this computer/);
  // Refused by URL parsing before our check even runs -- either way it is
  // refused, which is what matters.
  assert.ok(normaliseNodeUrl('1270.0.0.1:1').error, '127-lookalike must not be accepted');
});

// ---- networkFromExplorer: advisory guess ---------------------------------

test('guesses the network from the block explorer the node uses', () => {
  assert.equal(networkFromExplorer('https://mempool.space'), 'mainnet');
  assert.equal(networkFromExplorer('https://mempool.space/testnet'), 'testnet');
  assert.equal(networkFromExplorer('https://mempool.space/signet/api'), 'signet');
  assert.equal(networkFromExplorer('http://localhost:3002/regtest'), 'regtest');
  assert.equal(networkFromExplorer(''), null);
  assert.equal(networkFromExplorer(null), null);
});

// ---- probeNode: the three failures a user can act on ---------------------

test('a reachable node reports its version', async () => {
  const t = transportFor({
    '/settings/version': { status: 200, body: JSON.stringify({ version: '2.1.9' }) },
    '/explorer/selected': { status: 200, body: JSON.stringify({ provider: 'https://mempool.space' }) },
  });
  const r = await probeNode(t, 'http://127.0.0.1:8090/api/v1');
  assert.equal(r.ok, true);
  assert.equal(r.version, '2.1.9');
  assert.equal(r.networkHint, 'mainnet');
});

test('nothing listening is reported as unreachable, not as a bad node', async () => {
  const t = transportFor({ '/settings/version': new Error('connection refused') });
  const r = await probeNode(t, 'http://127.0.0.1:8090/api/v1');
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'unreachable');
  assert.match(r.message, /Nothing answered/);
});

test('403 means the node wants a pairing code — the single most confusing case', async () => {
  for (const status of [401, 403]) {
    const t = transportFor({ '/settings/version': { status, body: '' } });
    const r = await probeNode(t, 'http://127.0.0.1:8090/api/v1');
    assert.equal(r.ok, false, `status ${status}`);
    assert.equal(r.reason, 'needs-pairing', `status ${status} should mean pairing`);
    assert.match(r.message, /pairing code/);
  }
});

test('a web server that is not Bisq is called out as such', async () => {
  const t = transportFor({ '/settings/version': { status: 404, body: 'Not Found' } });
  const r = await probeNode(t, 'http://127.0.0.1:8090/api/v1');
  assert.equal(r.reason, 'not-bisq');
  assert.match(r.message, /not a Bisq node/);
});

test('a 200 that is not JSON is not mistaken for a node', async () => {
  const t = transportFor({ '/settings/version': { status: 200, body: '<html>hello</html>' } });
  const r = await probeNode(t, 'http://127.0.0.1:8090/api/v1');
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'not-bisq');
});

test('the probe never writes — only GETs, and only read-only paths', async () => {
  const t = transportFor({
    '/settings/version': { status: 200, body: JSON.stringify({ version: '2.1.9' }) },
    '/explorer/selected': { status: 200, body: JSON.stringify({ provider: 'x' }) },
  });
  await probeNode(t, 'http://127.0.0.1:8090/api/v1');
  for (const c of t.calls) {
    assert.equal(c.method, 'GET', `probe must not ${c.method}`);
  }
  // Specifically: it must never touch the endpoint that creates an identity.
  assert.ok(!t.calls.some((c) => c.url.includes('user-identities')),
    'the probe must not create a user identity on the node');
});

test('a broken explorer endpoint does not fail an otherwise good connection', async () => {
  const t = transportFor({
    '/settings/version': { status: 200, body: JSON.stringify({ version: '2.1.9' }) },
    '/explorer/selected': new Error('boom'),
  });
  const r = await probeNode(t, 'http://127.0.0.1:8090/api/v1');
  assert.equal(r.ok, true);
  assert.equal(r.explorer, null);
  assert.equal(r.networkHint, null);
});
