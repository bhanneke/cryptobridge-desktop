import { normaliseNodeUrl } from './node-probe.js';

export function nodeKey(url) {
  const result = normaliseNodeUrl(url);
  if (result.error) throw new Error(result.error);
  return result.url;
}

// Old credentials have no trustworthy node association. Re-pair once instead
// of guessing which endpoint should receive their secret.
export function credentialStore(api, storage = globalThis.localStorage) {
  try { storage?.removeItem('cryptobridge.credentials'); } catch { /* unavailable */ }
  const memory = new Map();
  return {
    async load(node) {
      node = nodeKey(node);
      return api ? api.invoke('bisq_credentials_load', { node }) : memory.get(node) ?? null;
    },
    async save(node, credentials) {
      node = nodeKey(node);
      if (api) await api.invoke('bisq_credentials_save', { node, credentials });
      else memory.set(node, credentials);
    },
  };
}

// Persist synchronously before POST /trades. If storage is denied/full/corrupt,
// starting another trade is unsafe. Session IDs and private keys never go here.
export function tradeStore(node, network, storage = globalThis.localStorage) {
  const key = `cryptobridge.trades.v1:${network}:${nodeKey(node)}`;
  return {
    load() {
      const text = storage.getItem(key);
      if (!text) return { trades: [], intent: null };
      const value = JSON.parse(text);
      if (!Array.isArray(value.trades)) throw new Error('Saved trade history is unreadable. Open this node in Bisq to recover it.');
      return value;
    },
    save(value) { storage.setItem(key, JSON.stringify(value)); },
  };
}
