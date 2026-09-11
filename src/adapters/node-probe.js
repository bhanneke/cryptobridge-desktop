/* Reading a Bisq node without changing it.
 *
 * The connect screen needs to answer "is there a node there, and can I talk to
 * it" before the user commits. BisqAdapter.init() cannot be used for that: it
 * authenticates, fetches the market rate, opens a WebSocket and — the part
 * that rules it out — creates a user identity on the node if none exists.
 * A connection *test* must not leave anything behind.
 *
 * So this does the smallest read that proves the point: GET /settings/version.
 * It distinguishes the three failures a user can actually act on — nothing
 * listening, something listening that isn't Bisq, and a Bisq node that wants
 * a pairing code — because "could not connect" is useless advice. */

/** Bisq answers 403 for both an absent and an expired session: authorization
 *  denies the call before authentication ever marks the caller. Measured
 *  against a real node; see bisq-adapter.js. */
const AUTH_FAILURE = new Set([401, 403]);

/** Literal loopback only: 127.0.0.0/8 or [::1]. Mirrors the Rust proxy. */
export function isLoopbackLiteral(hostname) {
  const h = String(hostname ?? '').replace(/^\[|\]$/g, '');
  if (h === '::1' || h === '0:0:0:0:0:0:0:1') return true;
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (!m) return false;
  const parts = m.slice(1).map(Number);
  if (parts.some((n) => n > 255)) return false;
  return parts[0] === 127;
}

/**
 * Make what the user typed into a URL we can call.
 * Accepts `127.0.0.1:8090`, `http://127.0.0.1:8090`, with or without `/api/v1`.
 * @returns {{url: string} | {error: string}}
 */
export function normaliseNodeUrl(raw) {
  let text = String(raw ?? '').trim();
  if (!text) return { error: 'Enter the address of your Bisq node.' };

  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) text = `http://${text}`;

  let u;
  try {
    u = new URL(text);
  } catch {
    return { error: `"${raw}" is not a valid address.` };
  }

  if (u.protocol !== 'http:') {
    // The shell's proxy only speaks plaintext to loopback, by design: with no
    // TLS backend compiled in it cannot be turned into an exfiltration path.
    return { error: 'Only http:// addresses on this computer are allowed.' };
  }
  if (u.username || u.password) {
    return { error: 'Remove the username and password from the address.' };
  }
  /* The shell's proxy accepts literal loopback IPs only -- it refuses
   * hostnames, `localhost` included, so that it never performs name
   * resolution and DNS rebinding cannot walk it off the machine
   * (src-tauri/src/proxy.rs). Reject the same things here, or the user gets a
   * confusing failure from a layer they cannot see. */
  if (!isLoopbackLiteral(u.hostname)) {
    return {
      error: u.hostname === 'localhost'
        ? 'Use 127.0.0.1 instead of localhost — the app connects only to literal loopback addresses.'
        : `The node must be on this computer. Use 127.0.0.1, not "${u.hostname}".`,
    };
  }

  // Trailing slashes and a missing /api/v1 are the two things everyone gets
  // wrong; neither is worth an error message.
  let path = u.pathname.replace(/\/+$/, '');
  if (!path.endsWith('/api/v1')) path = `${path}/api/v1`.replace(/\/{2,}/g, '/');

  return { url: `${u.protocol}//${u.host}${path}` };
}

/** Guess the network from the node's chosen block explorer. Advisory only —
 *  it is a heuristic about someone else's configuration, so it warns and never
 *  decides. */
export function networkFromExplorer(explorerUrl) {
  const s = String(explorerUrl ?? '').toLowerCase();
  if (!s) return null;
  if (s.includes('regtest')) return 'regtest';
  if (s.includes('signet')) return 'signet';
  if (s.includes('testnet') || s.includes('/testnet4')) return 'testnet';
  return 'mainnet';
}

/**
 * @param {{request: Function}} transport
 * @param {string} restBaseUrl  already normalised
 * @param {{headers?: object}} opts
 * @returns {Promise<{ok:true, version:string|null, explorer:string|null, networkHint:string|null}
 *                 | {ok:false, reason:string, message:string}>}
 */
export async function probeNode(transport, restBaseUrl, { headers } = {}) {
  let res;
  try {
    res = await transport.request('GET', `${restBaseUrl}/settings/version`, undefined, headers);
  } catch (e) {
    return {
      ok: false,
      reason: 'unreachable',
      message:
        'Nothing answered at that address. Check the Bisq node is running, ' +
        'and that the address and port are right.',
    };
  }

  if (AUTH_FAILURE.has(res.status)) {
    return {
      ok: false,
      reason: 'needs-pairing',
      message: 'This node is password-protected. Paste its pairing code below.',
    };
  }
  if (res.status !== 200) {
    return {
      ok: false,
      reason: 'not-bisq',
      message: `Something answered, but not a Bisq node (HTTP ${res.status}).`,
    };
  }

  let version = null;
  try {
    const parsed = JSON.parse(res.body);
    version = parsed?.version ?? parsed?.data?.version ?? null;
  } catch {
    return {
      ok: false,
      reason: 'not-bisq',
      message: 'Something answered, but it did not look like a Bisq node.',
    };
  }

  // Advisory only: a failure here must never fail the connection.
  let explorer = null;
  try {
    const r = await transport.request('GET', `${restBaseUrl}/explorer/selected`, undefined, headers);
    if (r.status === 200) explorer = JSON.parse(r.body)?.provider ?? null;
  } catch { /* the node is fine; we just learn less about it */ }

  return { ok: true, version, explorer, networkHint: networkFromExplorer(explorer) };
}
