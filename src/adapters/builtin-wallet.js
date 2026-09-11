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

  /** We do not read the chain yet, so we genuinely do not know the balance.
   *  Reporting null is the honest answer; the UI must render it as "held in
   *  your wallet", never as zero — a zero would read as "the money is gone". */
  async getBalance() {
    return { confirmedSats: null, pendingSats: null, external: false, synced: false };
  }

  async withdraw() {
    throw new Error(
      'Sending is not available yet. Your bitcoin is in your wallet and you ' +
      'control it — to spend it now, recover it with your phrase in any ' +
      'bitcoin wallet.',
    );
  }
}
