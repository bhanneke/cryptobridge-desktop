// Regression tests of the real UI with simulated native services. Uses an isolated Chrome profile and
// entirely simulated Tauri commands; no native wallet or real node is used.
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';

const root = resolve('src');
const expose = '\nglobalThis.__review = {state, get adapter(){return adapter}, refreshWallet, startWalletSync, rebuildBackend, onResume, presentPayment, get ready(){return adapterReady}};';
const server = http.createServer(async (req, res) => {
  try {
    const path = new URL(req.url, 'http://fixture').pathname;
    const file = resolve(root, '.' + (path === '/' ? '/index.html' : path));
    if (!file.startsWith(root + '/')) throw Error('path');
    let body = await readFile(file);
    if (path === '/app.js') body = Buffer.concat([body, Buffer.from(expose)]);
    const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2' };
    res.writeHead(200, { 'content-type': mime[extname(file)] || 'application/octet-stream' });
    res.end(body);
  } catch { res.writeHead(404).end(); }
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ channel: 'chrome' });
let count = 0;
try {
  async function fixture(opts = {}) {
    const page = await browser.newPage();
    await page.addInitScript((opts) => {
      const logs = globalThis.__calls = [];
      const listeners = [];
      let socket = 0;
      const syncing = new Set();
      localStorage.setItem('cryptobridge.backend', opts.backend || 'bisq');
      localStorage.setItem('cryptobridge.node', 'http://127.0.0.1:8090/api/v1');
      localStorage.setItem('cryptobridge.network', 'mainnet');
      if (opts.credentials) localStorage.setItem('cryptobridge.credentials', JSON.stringify({ clientId: 'fixture-A', clientSecret: 'secret-fixture-A' }));
      globalThis.__TAURI__ = {
        event: { listen: async (_event, cb) => { listeners.push(cb); return () => {}; } },
        core: { invoke: async (cmd, args = {}) => {
          logs.push({ cmd, args });
          if (cmd === 'bisq_http') {
            const p = new URL(args.url).pathname;
            const data = p.endsWith('/access/session') ? { sessionId: 'fixture-session' }
              : p.endsWith('/market-price/quotes') ? { quotes: { EUR: { value: 1000000000 } } }
              : p.endsWith('/user-identities/ids') ? ['fixture-identity']
              : p.endsWith('/settings/version') ? { version: 'fixture' }
              : p.endsWith('/user-identities/selected/user-profile') ? { networkId: { addressByTransportTypeMap: { map: { [opts.clear ? 'CLEAR' : 'TOR']: { host: 'fixture' } } } } }
              : p.endsWith('/offers') ? [] : {};
            return { status: 200, body: JSON.stringify(data) };
          }
          if (cmd === 'bisq_credentials_load') return opts.credentials && args.node.includes(':8090/') ? { clientId: 'fixture-A', clientSecret: 'secret-fixture-A' } : null;
          if (cmd === 'bisq_ws_open') return ++socket;
          if (cmd === 'bisq_ws_send') {
            const msg = JSON.parse(args.text);
            if (msg.requestId === 'sub-props') setTimeout(() => {
              const payload = opts.resume ? [{ existing: {
                tradeState: 'BUYER_RECEIVED_BTC_SENT_CONFIRMATION', bitcoinPaymentData: 'original-trade-address'
              } }] : [];
              listeners.forEach(cb => cb({ payload: { id: args.id, kind: 'message', data: JSON.stringify({
                type: 'SubscriptionResponse', requestId: 'sub-props', payload
              }) } }));
            }, 1);
            return;
          }
          if (cmd === 'wallet_status') return { exists: true, backed_up: opts.backedUp !== false, network: args.network };
          if (cmd === 'wallet_reveal_mnemonic') return Array(12).fill('fixture');
          if (cmd === 'wallet_next_address') return { address: 'newly-derived-wrong-address', index: 1 };
          if (cmd === 'wallet_start_sync') { syncing.add(args.network); return { running: true, synced: false }; }
          if (cmd === 'wallet_sync_status') return { network: args.network, running: syncing.has(args.network), synced: false };
          if (cmd === 'node_status') return { installed: false, java: false, running: false };
        } }
      };
    }, opts);
    await page.goto(base);
    await page.waitForFunction(clear => globalThis.__review && document.querySelector('#backendPill').dataset.status === (clear ? 'error' : 'connected'), !!opts.clear);
    return page;
  }

  {
    const page = await fixture({ credentials: true });
    const r = await page.evaluate(async () => {
      await __review.ready;
      const privacyChecksOnStartup = __calls.filter(c => c.args.url?.endsWith('/user-identities/selected/user-profile')).length;
      localStorage.setItem('cryptobridge.node', 'http://127.0.0.1:8091/api/v1');
      await __review.rebuildBackend(); await __review.ready;
      const leak = __calls.find(c => c.args.url === 'http://127.0.0.1:8091/api/v1/access/session');
      return { privacyChecksOnStartup, leak: !!leak };
    });
    assert.ok(r.privacyChecksOnStartup > 0);
    assert.equal(r.leak, false);
    console.log('PASS: saved-node startup checks privacy'); count++;
    console.log('PASS: node A credentials never reach node B'); count++;
    await page.close();
  }
  {
    const page = await fixture({ backend: 'mock', backedUp: false });
    await page.click('[data-step="1"] .btn-primary');
    await page.click('#offerList .offer-card');
    await page.click('#chooseOfferBtn');
    await page.waitForSelector('#walletBackupWrap', { state: 'visible' });
    const r = await page.evaluate(() => ({ words: document.querySelector('#walletWords').children.length,
      revealCalls: __calls.filter(c => c.cmd === 'wallet_reveal_mnemonic').length }));
    assert.equal(r.words, 12); assert.equal(r.revealCalls, 1);
    console.log('PASS: interrupted backup resumes with the recovery words'); count++;
    await page.close();
  }
  {
    const page = await fixture();
    const r = await page.evaluate(async () => {
      await __review.refreshWallet();
      await new Promise(r => setTimeout(r, 20));
      localStorage.setItem('cryptobridge.network', 'signet');
      await __review.rebuildBackend(); await __review.ready; await __review.refreshWallet();
      await new Promise(r => setTimeout(r, 20));
      return __calls.filter(c => c.cmd === 'wallet_start_sync').map(c => c.args.network);
    });
    assert.deepEqual(r, ['mainnet', 'signet']);
    console.log('PASS: switching network starts the matching wallet sync'); count++;
    await page.close();
  }
  {
    const page = await fixture({ resume: true });
    await page.waitForSelector('#resumeBanner', { state: 'visible' });
    await page.click('#resumeBtn');
    await page.waitForFunction(() => document.querySelector('#payAddr').textContent === 'original-trade-address');
    const r = await page.evaluate(() => ({ visible: document.querySelector('#paymentOverlay').classList.contains('show'),
      address: document.querySelector('#payAddr').textContent, step: document.querySelector('.step.active').dataset.step }));
    assert.equal(r.visible, true); assert.equal(r.address, 'original-trade-address'); assert.equal(r.step, '4');
    assert.equal(await page.evaluate(() => __calls.filter(c => c.cmd === 'wallet_next_address').length), 0);
    console.log('PASS: resumed released trade shows its original address in a visible dialog'); count++;
    await page.close();
  }
  {
    const page = await fixture({ clear: true });
    await page.waitForSelector('#connectOverlay.show');
    assert.match(await page.textContent('#connectResult'), /open internet/);
    assert.equal(await page.evaluate(() => __calls.filter(c => c.cmd === 'bisq_ws_open').length), 0);
    console.log('PASS: saved mainnet CLEAR node is blocked on startup'); count++;
    await page.close();
  }
  {
    const page = await fixture();
    await page.evaluate(() => {
      __review.adapter.confirmFiatSent = async id => {
        __calls.push({ cmd: 'confirm-payment-fixture', args: { id } });
        if (__calls.filter(c => c.cmd === 'confirm-payment-fixture').length === 1) throw Error('connection dropped');
      };
      __review.presentPayment('paid-trade', { amountEur: 100, receiverName: 'Fixture', iban: 'DE02120300000000202051', epcQrPayload: null }, 100);
    });
    await page.click('#payConfirmSent');
    await page.waitForFunction(() => document.querySelector('#payError').textContent.includes('pending'));
    assert.equal(await page.isEnabled('#payConfirmSent'), true);
    await page.click('#payConfirmSent');
    await page.waitForSelector('#payPhaseWait', { state: 'visible' });
    const ids = await page.evaluate(() => __calls.filter(c => c.cmd === 'confirm-payment-fixture').map(c => c.args.id));
    assert.deepEqual(ids, ['paid-trade', 'paid-trade']);
    assert.equal(await page.evaluate(() => __calls.filter(c => c.args.method === 'POST' && c.args.url?.endsWith('/trades')).length), 0);
    console.log('PASS: failed payment confirmation retries the same trade'); count++;
    await page.close();
  }
  {
    const page = await fixture();
    await page.evaluate(() => {
      __review.adapter.getPaymentInstructions = async () => ({ amountEur: 100, receiverName: 'Fixture', iban: 'DE02120300000000202051', epcQrPayload: null });
      __review.presentPayment('t', { amountEur: 100, verificationError: 'Invalid IBAN', rawAccountData: 'invalid fixture', epcQrPayload: null }, 100);
    });
    assert.equal(await page.isEnabled('#payConfirmSent'), false);
    assert.equal(await page.locator('#payQr svg').count(), 0);
    await page.click('#payRefreshDetails');
    assert.equal(await page.isEnabled('#payConfirmSent'), true);
    assert.equal(await page.textContent('#payError'), '');
    console.log('PASS: invalid bank details block payment until corrected'); count++;
    await page.close();
  }
  console.log(`${count} UI regression cases passed`);
} finally {
  await browser.close();
  await new Promise(r => server.close(r));
}
