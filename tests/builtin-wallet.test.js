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

test('balance is unknown, not zero — a zero would read as "the money is gone"', async () => {
  const w = new BuiltinWallet(fakeApi(), 'mainnet');
  const b = await w.getBalance();
  assert.equal(b.confirmedSats, null);
  assert.equal(b.pendingSats, null);
  assert.equal(b.synced, false);
  assert.notEqual(b.confirmedSats, 0);
});

test('withdraw refuses with something the user can actually act on', async () => {
  const w = new BuiltinWallet(fakeApi(), 'mainnet');
  await assert.rejects(() => w.withdraw('bc1qwhatever', 1000), (e) => {
    assert.match(e.message, /not available yet/);
    assert.match(e.message, /recover it with your phrase/, 'must say how to spend it anyway');
    return true;
  });
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
