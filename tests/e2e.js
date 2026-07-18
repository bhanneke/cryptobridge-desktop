/* End-to-end smoke of the full mock flow: serves src/ on an ephemeral port,
   drives the UI with the system Chrome (playwright-core, no browser download),
   and walks bridge → portfolio → art purchase → yield position.
   Run with `npm run test:e2e`. */
import http from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const root = join(fileURLToPath(new URL('.', import.meta.url)), '..', 'src');
const shots = join(fileURLToPath(new URL('.', import.meta.url)), 'shots');
await mkdir(shots, { recursive: true });

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.woff2': 'font/woff2', '.svg': 'image/svg+xml', '.png': 'image/png',
};

const server = http.createServer(async (req, res) => {
  try {
    const path = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname));
    const file = join(root, path === '/' ? 'index.html' : path);
    if (!file.startsWith(root)) throw new Error('traversal');
    const body = await readFile(file);
    res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404).end('not found');
  }
});
await new Promise((res) => server.listen(0, '127.0.0.1', res));
const APP = `http://127.0.0.1:${server.address().port}/index.html`;

let failures = 0;
const ok = (cond, msg) => {
  if (cond) { console.log('PASS: ' + msg); }
  else { console.error('FAIL: ' + msg); failures++; }
};

const browser = await chromium.launch({ channel: 'chrome' });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
page.on('pageerror', (e) => { console.error('PAGE ERROR:', e.message); failures++; });

// --- Bridge (step 4 deep link) ------------------------------------------
await page.goto(APP + '#step=4');
await page.waitForFunction(() =>
  document.querySelector('#backendPill')?.dataset.status === 'connected');
ok(true, 'backend pill reports the mock adapter as connected');
const pillText = await page.textContent('#backendLabel');
ok(pillText.includes('mock') && pillText.includes('regtest'), `pill labels the backend: "${pillText}"`);

await page.$eval('#bridgeSlider', (el) => {
  el.value = 70;
  el.dispatchEvent(new Event('input', { bubbles: true }));
});
await page.waitForTimeout(200);
await page.click('#confirmBridgeBtn');

// Trade lifecycle runs (~2 s at demo pacing), then the overlay pops.
await page.waitForSelector('#bridgeSuccess.show', { timeout: 15000 });
ok(true, 'trade completes and the success overlay appears');
await page.waitForFunction(
  () => document.querySelector('#stepIndicator').textContent.includes('5'),
  { timeout: 15000 });
ok(true, 'flow advances to the portfolio (step 5)');

const sats = await page.textContent('#portfolioSats');
ok(/BTC/.test(sats), `portfolio shows the adapter wallet in BTC: "${sats.trim()}"`);
const network = await page.textContent('#networkLabel');
ok(network.includes('mock') && network.includes('regtest'), `portfolio backend row from adapter: "${network}"`);
ok(await page.$eval('#holdingsSection', (el) => el.classList.contains('hidden')),
  'holdings hidden before any purchase');
await page.screenshot({ path: join(shots, 'portfolio.png') });

// --- Explore: art purchase ----------------------------------------------
await page.click('[data-explore="assets"]');
await page.waitForTimeout(600);
const balanceTxt = await page.textContent('#walletBalance');
ok(balanceTxt !== '€ 0,00', 'wallet pill shows bridged balance: ' + balanceTxt);

// Monolith (4.1 ETH ≈ €13,178) is never affordable at 70% of a savings roll
await page.click('[data-buy="monolith"]');
await page.waitForTimeout(500);
ok(!!(await page.$('#bridgeMoreBtn')), 'insufficient-funds state offers "Bridge more euros"');
await page.click('#artModal .modal-close');
await page.waitForTimeout(400);

// Chrome (1.8 ETH ≈ €5,786) is always affordable — buy it
await page.click('[data-buy="chrome"]');
await page.waitForTimeout(500);
await page.click('#artBuyBtn');
await page.waitForTimeout(1600);
await page.click('#artModal [data-close]');
await page.waitForTimeout(500);
ok(!!(await page.$('.owned-badge')), 'owned badge appears on the bought artwork');
const afterBuy = await page.textContent('#walletBalance');
ok(afterBuy !== balanceTxt, `balance deducted: ${balanceTxt} -> ${afterBuy}`);

// --- Explore: yield position --------------------------------------------
await page.click('.tab-btn[data-tab="savings"]');
await page.waitForTimeout(400);
await page.$eval('#riskSlider', (el) => {
  el.value = 4;
  el.dispatchEvent(new Event('input', { bubbles: true }));
});
await page.click('#investBtn');
await page.waitForTimeout(500);
await page.click('.amount-chip[data-pct="50"]');
await page.waitForTimeout(300);
await page.click('#investConfirm');
await page.waitForTimeout(600);
await page.click('#investModal [data-close]');
await page.waitForTimeout(400);
ok(!!(await page.$('#yieldPositionsList .funding-row')), 'yield position row appears');

// --- Back to portfolio: holdings tie it together -------------------------
await page.click('#backBtn');
await page.waitForTimeout(700);
const holdings = await page.$$('#holdingsList .funding-row');
ok(holdings.length === 2, `portfolio "Your assets" lists art + position (${holdings.length} rows)`);
const satsAfter = await page.textContent('#portfolioSats');
ok(satsAfter !== sats, `wallet sats reflect the spends: "${sats.trim()}" -> "${satsAfter.trim()}"`);
await page.screenshot({ path: join(shots, 'portfolio-with-holdings.png') });

await browser.close();
server.close();

if (failures > 0) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log('\nAll e2e checks passed.');
