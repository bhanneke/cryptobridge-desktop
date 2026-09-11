/* Is the node's trade traffic actually going over Tor?
 *
 * Three different network legs get confused under the word "Tor", so to be
 * precise about which one this module is about:
 *
 *   1. This app -> the Bisq node. Loopback, 127.0.0.1. Never leaves the
 *      machine, so Tor is meaningless here and the shell's proxy refuses
 *      anything that is not a literal loopback IP anyway.
 *   2. The Bisq node -> trade peers. THIS is where the user's IP is exposed
 *      to the stranger they are sending money to. It is the node's transport,
 *      configured in Bisq, not something this app performs.
 *   3. The wallet -> the Bitcoin network. Does not exist yet (no chain sync).
 *
 * We cannot make the node use Tor -- that is `network.supportedTransportTypes`
 * in the node's own config. What we can do is refuse to pretend we don't know.
 * Every UserProfileDto carries networkId.addressByTransportTypeMap, a map
 * keyed by TOR / I2P / CLEAR, so the node tells us its own transport on data
 * we already fetch. A clearnet node is then a visible, blocking condition
 * instead of a silent default. */

export const TRANSPORT = Object.freeze({ TOR: 'TOR', I2P: 'I2P', CLEAR: 'CLEAR' });

/** Pull the transport->address map out of a profile, tolerating the wrapped
 *  record shape ({map: {...}}) and a flattened one. */
export function transportMap(profile) {
  const byType = profile?.networkId?.addressByTransportTypeMap;
  if (!byType || typeof byType !== 'object') return {};
  const inner = byType.map && typeof byType.map === 'object' ? byType.map : byType;
  const out = {};
  for (const [k, v] of Object.entries(inner)) {
    const key = String(k).toUpperCase();
    if (key === TRANSPORT.TOR || key === TRANSPORT.I2P || key === TRANSPORT.CLEAR) out[key] = v;
  }
  return out;
}

/**
 * @returns {{transports: string[], tor: boolean, i2p: boolean, clearnet: boolean,
 *            onion: string|null, known: boolean}}
 */
export function classifyTransport(profile) {
  const map = transportMap(profile);
  const transports = Object.keys(map).sort();
  const torAddr = map[TRANSPORT.TOR];
  return {
    transports,
    tor: Object.prototype.hasOwnProperty.call(map, TRANSPORT.TOR),
    i2p: Object.prototype.hasOwnProperty.call(map, TRANSPORT.I2P),
    clearnet: Object.prototype.hasOwnProperty.call(map, TRANSPORT.CLEAR),
    onion: typeof torAddr?.host === 'string' ? torAddr.host : null,
    known: transports.length > 0,
  };
}

/**
 * Turn the classification into something the UI can act on.
 *
 * Advertising a CLEAR address is the risk, even alongside TOR: a peer that
 * can see it can reach the user directly, and then the user's IP is attached
 * to a trade. So TOR-only is the only clean answer.
 *
 * Blocking is reserved for mainnet. On the test networks there is no real
 * money and no real counterparty, and making regtest unusable would only
 * teach people to click past the warning that matters.
 *
 * @param {object|null} profile   a UserProfileDto, or null if we could not read one
 * @param {string} network        'mainnet' | 'testnet' | 'signet' | 'regtest'
 * @returns {{level:'ok'|'warn'|'block', headline:string, detail:string, transports:string[]}}
 */
export function privacyVerdict(profile, network) {
  const c = classifyTransport(profile);
  const mainnet = network === 'mainnet' || network === 'bitcoin';

  if (!c.known) {
    return {
      level: 'warn',
      headline: 'Could not confirm how your node reaches the network',
      detail:
        'The node did not report its transport, so we cannot tell whether your ' +
        'IP address is visible to the people you trade with. Treat it as visible.',
      transports: [],
    };
  }

  if (c.clearnet) {
    const detail =
      'This node reaches trade peers over the open internet, so the stranger you ' +
      'send euros to can see your IP address — and so can anyone watching it. ' +
      'Turn Tor on in your Bisq node by setting network.supportedTransportTypes=["TOR"] ' +
      'in its config, then restart it and reconnect.';
    return {
      level: mainnet ? 'block' : 'warn',
      headline: c.tor
        ? 'Your node is reachable over the open internet as well as Tor'
        : 'Your node is on the open internet, not Tor',
      detail,
      transports: c.transports,
    };
  }

  if (c.tor) {
    return {
      level: 'ok',
      headline: 'Trade traffic goes over Tor',
      detail: c.onion
        ? `Your node is reachable only as ${c.onion}. Trade peers never see your IP address.`
        : 'Your node is reachable only over Tor. Trade peers never see your IP address.',
      transports: c.transports,
    };
  }

  // I2P only: private, but not what we verify or advise on.
  return {
    level: 'warn',
    headline: `Your node uses ${c.transports.join(' and ')}, not Tor`,
    detail:
      'That is not the open internet, so your IP is not plainly exposed, but this ' +
      'app has not been tested against it.',
    transports: c.transports,
  };
}
