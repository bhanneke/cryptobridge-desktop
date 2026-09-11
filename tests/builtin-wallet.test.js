/* Unit tests for BuiltinWallet — the JS side of the built-in wallet. The key
 * material and all the real cryptography live in Rust (src-tauri/src/wallet.rs,
 * tested there against the published BIP84 vectors); what matters here is that
 * this layer passes the right arguments, keeps nothing secret, and fails in
 * ways a user can act on. */
import test from 'node:test';
import assert from 'node:assert/strict';

import { BuiltinWallet } from '../src/adapters/builtin-wallet.js';

/** A fake IPC bridge that records every call. */
function fakeApi(responses = {}) {
  const calls = [];
  return {
    calls,
    invoke: async (cmd, args) => {
      calls.push({ cmd, args });
      const r = responses[cmd];
      if (typeof r === 'function') return r(args);
      if (r instanceof Error) throw r;
      return r;
    },
  };
}

test('refuses to construct without the Tauri bridge', () => {
  assert.throws(() => new BuiltinWallet(null, 'mainnet'), /IPC bridge/);
  assert.throws(() => new BuiltinWallet({}, 'mainnet'), /IPC bridge/);
  assert.throws(() => new BuiltinWallet(fakeApi(), ''), /network/);
});

test('isAvailable only when there is a bridge to talk to', () => {
  assert.equal(BuiltinWallet.isAvailable(fakeApi()), true);
  assert.equal(BuiltinWallet.isAvailable(null), false);
  assert.equal(BuiltinWallet.isAvailable({}), false);
});

test('status maps the shell snake_case into the UI shape', async () => {
  const api = fakeApi({
    wallet_status: { exists: true, backed_up: false, network: 'regtest' },
  });
  const w = new BuiltinWallet(api, 'regtest');
  assert.deepEqual(await w.status(), { exists: true, backedUp: false, network: 'regtest' });
  assert.deepEqual(api.calls[0], { cmd: 'wallet_status', args: { network: 'regtest' } });
});

test('every call carries the network, so a regtest wallet can never be taken for mainnet', async () => {
  const api = fakeApi({
    wallet_status: { exists: true, backed_up: true, network: 'regtest' },
    wallet_create: { exists: true, backed_up: false, network: 'regtest' },
    wallet_reveal_mnemonic: ['abandon'],
    wallet_confirm_backup: null,
    wallet_next_address: { address: 'bcrt1qexample', index: 0 },
  });
  const w = new BuiltinWallet(api, 'regtest');
  await w.status();
  await w.create();
  await w.revealRecoveryPhrase();
  await w.confirmBackup(['abandon']);
  await w.getReceiveAddress();
  assert.equal(api.calls.length, 5);
  for (const c of api.calls) {
    assert.equal(c.args.network, 'regtest', `${c.cmd} lost the network`);
  }
});

test('getReceiveAddress returns the address and asks for a new one each time', async () => {
  let i = 0;
  const api = fakeApi({ wallet_next_address: () => ({ address: `bc1qaddr${i}`, index: i++ }) });
  const w = new BuiltinWallet(api, 'mainnet');
  const a = await w.getReceiveAddress();
  const b = await w.getReceiveAddress();
  assert.equal(a, 'bc1qaddr0');
  assert.equal(b, 'bc1qaddr1');
  assert.notEqual(a, b, 'addresses must not repeat between trades');
});

test('an empty address from the shell is an error, not an empty string', async () => {
  const w = new BuiltinWallet(fakeApi({ wallet_next_address: { address: '', index: 0 } }), 'mainnet');
  await assert.rejects(() => w.getReceiveAddress(), /no address/);
});

test('the shell refusing to hand out an address is surfaced, not swallowed', async () => {
  const w = new BuiltinWallet(
    fakeApi({ wallet_next_address: new Error('back up your recovery phrase before receiving bitcoin') }),
    'mainnet',
  );
  await assert.rejects(() => w.getReceiveAddress(), /back up your recovery phrase/);
});

test('before the first sync update, balance is unknown rather than zero', async () => {
  // The distinction that matters: someone who just bought bitcoin reads a
  // displayed "0" as the money being gone.
  const w = new BuiltinWallet(fakeApi({ wallet_sync_status: { running: true, synced: false } }), 'mainnet');
  const b = await w.getBalance();
  assert.equal(b.confirmedSats, null);
  assert.equal(b.pendingSats, null);
  assert.equal(b.synced, false);
  assert.equal(b.syncing, true);
  assert.notEqual(b.confirmedSats, 0);
});

test('once synced, the real figures come through', async () => {
  const w = new BuiltinWallet(
    fakeApi({ wallet_sync_status: { running: true, synced: true, confirmed_sats: 234000, pending_sats: 1000 } }),
    'mainnet',
  );
  const b = await w.getBalance();
  assert.equal(b.confirmedSats, 234000);
  assert.equal(b.pendingSats, 1000);
  assert.equal(b.synced, true);
});

test('a synced wallet that really holds nothing reports zero, not unknown', async () => {
  const w = new BuiltinWallet(fakeApi({ wallet_sync_status: { running: true, synced: true } }), 'mainnet');
  const b = await w.getBalance();
  assert.equal(b.confirmedSats, 0, 'synced-and-empty is a fact, not an unknown');
  assert.equal(b.synced, true);
});

test('a shell that cannot answer degrades to unknown instead of throwing', async () => {
  const w = new BuiltinWallet(fakeApi({ wallet_sync_status: new Error('no such command') }), 'mainnet');
  const b = await w.getBalance();
  assert.equal(b.confirmedSats, null);
  assert.equal(b.synced, false);
});

test('sync errors reach the UI so it can say why there is no balance', async () => {
  const w = new BuiltinWallet(
    fakeApi({ wallet_sync_status: { running: false, synced: false, last_error: 'Is tor running?' } }),
    'mainnet',
  );
  assert.match((await w.getBalance()).error, /tor/);
});

// ---- spending -------------------------------------------------------------

test('previewSend builds but never sends', async () => {
  const api = fakeApi({ wallet_send_preview: { token: 'tok1', address: 'bc1qdest', amount_sats: 50000, fee_sats: 320, total_sats: 50320 } });
  const w = new BuiltinWallet(api, 'mainnet');
  const p = await w.previewSend('  bc1qdest  ', 50000, 4);
  assert.equal(p.total_sats, 50320);
  assert.equal(api.calls.length, 1);
  assert.equal(api.calls[0].cmd, 'wallet_send_preview', 'preview must not broadcast');
  assert.equal(api.calls[0].args.address, 'bc1qdest', 'address is trimmed');
  assert.equal(api.calls[0].args.feeRateSatVb, 4);
});

test('confirmSend sends the previewed transaction by token', async () => {
  const api = fakeApi({ wallet_send_confirm: 'abc123txid' });
  const w = new BuiltinWallet(api, 'mainnet');
  assert.equal(await w.confirmSend('tok1'), 'abc123txid');
  assert.deepEqual(api.calls[0], { cmd: 'wallet_send_confirm', args: { token: 'tok1' } });
});

test('confirmSend with no token refuses before reaching the shell', async () => {
  const api = fakeApi();
  const w = new BuiltinWallet(api, 'mainnet');
  await assert.rejects(() => w.confirmSend(''), /build the transaction first/);
  await assert.rejects(() => w.confirmSend(undefined), /build the transaction first/);
  assert.equal(api.calls.length, 0);
});

test('a spent token is refused by the shell, so a double-click cannot pay twice', async () => {
  const w = new BuiltinWallet(fakeApi({ wallet_send_confirm: new Error('that transaction has expired — build it again') }), 'mainnet');
  await assert.rejects(() => w.confirmSend('used'), /expired/);
});

test('withdraw refuses without an explicit fee rate rather than guessing one', async () => {
  const api = fakeApi();
  const w = new BuiltinWallet(api, 'mainnet');
  await assert.rejects(() => w.withdraw('bc1qdest', 1000), /explicit fee rate/);
  assert.equal(api.calls.length, 0, 'must not build anything');
});

test('a send that the network rejects surfaces the reason', async () => {
  const w = new BuiltinWallet(
    fakeApi({ wallet_send_confirm: new Error('not connected to the Bitcoin network — cannot broadcast (is tor running?)') }),
    'mainnet',
  );
  await assert.rejects(() => w.confirmSend('tok'), /is tor running/);
});

test('confirmBackup rejects an empty phrase before bothering the shell', async () => {
  const api = fakeApi({ wallet_confirm_backup: null });
  const w = new BuiltinWallet(api, 'mainnet');
  await assert.rejects(() => w.confirmBackup([]), /recovery phrase/);
  await assert.rejects(() => w.confirmBackup('not an array'), /recovery phrase/);
  assert.equal(api.calls.length, 0, 'should not have called the shell');
});

test('a wrong phrase surfaces the shell error verbatim', async () => {
  const w = new BuiltinWallet(
    fakeApi({ wallet_confirm_backup: new Error('that is not the recovery phrase -- check the words and try again') }),
    'mainnet',
  );
  await assert.rejects(() => w.confirmBackup(['wrong', 'words']), /not the recovery phrase/);
});

test('the wallet object never retains the recovery phrase', async () => {
  const phrase = ['abandon', 'abandon', 'about'];
  const w = new BuiltinWallet(fakeApi({ wallet_reveal_mnemonic: phrase }), 'mainnet');
  const got = await w.revealRecoveryPhrase();
  assert.deepEqual(got, phrase);
  // Nothing on the instance may hold the words after the call returns.
  const dump = JSON.stringify(w, (k, v) => (typeof v === 'function' ? undefined : v));
  for (const word of phrase) {
    assert.ok(!dump.includes(word), `the phrase leaked onto the instance: ${dump}`);
  }
});
