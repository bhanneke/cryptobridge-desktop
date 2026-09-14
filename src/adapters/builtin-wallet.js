/* BuiltinWallet — the wallet the app creates for you, over Tauri IPC.
 *
 * Implements the same three methods as ExternalWallet (getReceiveAddress,
 * getBalance, withdraw), so BisqAdapter cannot tell them apart, plus the
 * onboarding calls the first-run screens need.
 *
 * Nothing secret lives here. Every key operation happens in the Rust shell
 * (src-tauri/src/wallet.rs); this file only ever sees addresses, a boolean and
 * — during the one-time backup ceremony — the recovery phrase, which it holds
 * in a local variable for exactly as long as it takes to display and must
 * never persist.
 *
 * Only available in the packaged app: there is no browser fallback, because
 * generating keys in a webview and keeping them in localStorage is precisely
 * the design this replaces. In the browser build the app keeps asking for an
 * address, which is safe if unfriendly. */

export class BuiltinWallet {
  /**
   * @param {{invoke: Function}} api  the Tauri bridge from tauriApi()
   * @param {string} network          'mainnet' | 'testnet' | 'signet' | 'regtest'
   */
  constructor(api, network) {
    if (!api || typeof api.invoke !== 'function') {
      throw new Error('BuiltinWallet needs the Tauri IPC bridge');
    }
    if (!network) throw new Error('BuiltinWallet needs a network');
    this.invoke = api.invoke;
    this.network = network;
  }

  /** Is this build able to host a built-in wallet at all? */
  static isAvailable(api) {
    return !!api && typeof api.invoke === 'function';
  }

  // --- onboarding ----------------------------------------------------------

  /** @returns {Promise<{exists:boolean, backedUp:boolean, network:string}>} */
  async status() {
    const s = await this.invoke('wallet_status', { network: this.network });
    return { exists: !!s.exists, backedUp: !!s.backed_up, network: s.network };
  }

  /** Create a wallet. Fails if one already exists — we never silently replace
   *  a recovery phrase, because that is how people lose coins. */
  async create() {
    const s = await this.invoke('wallet_create', { network: this.network });
    return { exists: !!s.exists, backedUp: !!s.backed_up, network: s.network };
  }

  /** The twelve words, for the backup ceremony. The shell refuses once backup
   *  is confirmed, so this can only ever succeed before that point.
   *  @returns {Promise<string[]>} */
  async revealRecoveryPhrase() {
    return this.invoke('wallet_reveal_mnemonic', { network: this.network });
  }

  /** Prove the user wrote the phrase down by typing it back. Until this
   *  succeeds, getReceiveAddress() refuses. */
  async confirmBackup(words) {
    if (!Array.isArray(words) || words.length === 0) {
      throw new Error('Enter your recovery phrase to confirm the backup.');
    }
    await this.invoke('wallet_confirm_backup', { network: this.network, words });
  }

  // --- the ExternalWallet-compatible surface -------------------------------

  /** A fresh address, derived one further along the chain each time, so no two
   *  trades share one and they cannot be linked on-chain. */
  async getReceiveAddress() {
    const { address } = await this.invoke('wallet_next_address', { network: this.network });
    if (!address) throw new Error('the wallet returned no address');
    return address;
  }

  /** Start syncing the chain in the background. Idempotent. Always over Tor:
   *  the shell has no clearnet fallback, so if Tor is not running this
   *  reports an error rather than quietly leaking our addresses to peers. */
  async startSync() {
    return this.invoke('wallet_start_sync', { network: this.network });
  }

  async syncStatus() {
    return this.invoke('wallet_sync_status', { network: this.network });
  }

  /** The balance, and whether it means anything yet.
   *
   *  Until the first update lands, confirmedSats is null, NOT zero. A zero
   *  reads to someone who just sent money as "it is gone"; null lets the UI
   *  say "not synced yet", which is what is actually true. */
  async getBalance() {
    let s;
    try {
      s = await this.syncStatus();
    } catch {
      return { confirmedSats: null, pendingSats: null, external: false, synced: false, syncing: false };
    }
    return {
      confirmedSats: s?.synced ? (s.confirmed_sats ?? 0) : null,
      pendingSats: s?.synced ? (s.pending_sats ?? 0) : null,
      external: false,
      synced: !!s?.synced,
      syncing: !!s?.running,
      error: s?.last_error ?? null,
    };
  }

  // --- spending ------------------------------------------------------------
  //
  // Two steps, always. previewSend builds the exact transaction and keeps it
  // in the shell; confirmSend signs and broadcasts that same one. Rebuilding
  // at confirm time could pick different inputs and a different fee than the
  // one the user agreed to, and this is money that does not come back.

  /** Lowest fee rate our peers will relay, in sat/vB. A light client cannot
   *  honestly predict confirmation times, so this is a floor, not advice. */
  async feeFloor() {
    return this.invoke('wallet_fee_floor', { network: this.network });
  }

  /** Build a transaction and report what it would cost. Signs nothing. */
  async previewSend(address, amountSats, feeRateSatVb) {
    return this.invoke('wallet_send_preview', {
      network: this.network,
      address: String(address ?? '').trim(),
      amountSats,
      feeRateSatVb,
    });
  }

  /** Sign and broadcast the previewed transaction. The token is single-use,
   *  so a double-click cannot pay twice. @returns {Promise<string>} txid */
  async confirmSend(token) {
    if (!token) throw new Error('Nothing to send — build the transaction first.');
    return this.invoke('wallet_send_confirm', { token });
  }

  /** Interface method, kept for completeness. The UI must not use this: it
   *  sends without showing anyone a fee. Use previewSend/confirmSend. */
  async withdraw(address, amountSats, { feeRateSatVb } = {}) {
    if (!feeRateSatVb) throw new Error('withdraw needs an explicit fee rate');
    const preview = await this.previewSend(address, amountSats, feeRateSatVb);
    return this.confirmSend(preview.token);
  }
}
