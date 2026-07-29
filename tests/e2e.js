/* End-to-end smoke of the real five-step flow: serves src/ on an ephemeral
   port, drives the UI with the system Chrome (playwright-core, no browser
   download), and walks welcome → offer book → amount + receive address →
   review → SEPA payment screen → completion.

   Also guards the deletion: the PSD2 bank picker and the art/yield/swap
   endgame must stay gone, since a yield product is exactly what the plan's
   bright lines forbid. Run with `npm run test:e2e`. */
import http from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const root = join(fileURLToPath(new URL('.', import.meta.url)), '..', 'src');
const shots = join(fileURLToPath(new URL('.', import.meta.url)), 'shots');
await mkdir(shots, { recursive: true });

// The mock backend runs on regtest, so the receive address must be a bcrt1 one.
const RECEIVE_ADDRESS = 'bcrt1qqv9pzxqlyckngw6zf9g9whn9d3eh4qvg0z9lm9';
const MAINNET_ADDRESS = 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4';

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

// --- Step 1: welcome ------------------------------------------------------
await page.goto(APP);
await page.waitForFunction(() =>
  document.querySelector('#backendPill')?.dataset.status === 'connected');
ok(true, 'backend pill reports the mock adapter as connected');
const pillText = await page.textContent('#backendLabel');
ok(pillText.includes('mock') && pillText.includes('regtest'), `pill labels the backend: "${pillText}"`);
ok((await page.textContent('#stepIndicator')).includes('of 5'), 'flow is five steps, not six');

await page.click('[data-step="1"] .btn-primary');

// --- Step 2: the real offer book -----------------------------------------
await page.waitForSelector('#offerList .offer-card', { timeout: 15000 });
const offerCount = await page.$$eval('#offerList .offer-card', (els) => els.length);
ok(offerCount > 1, `offer book renders offers from the adapter (${offerCount})`);

// Cheapest first is what a buyer wants; we rank, we do not broker.
const prices = await page.$$eval('#offerList .offer-price', (els) =>
  els.map((e) => parseFloat(e.textContent.replace(/[^\d,]/g, '').replace(/\./g, '').replace(',', '.'))));
ok(prices.every((p, i) => i === 0 || prices[i - 1] <= p), `offers sorted cheapest first: ${prices[0]} … ${prices.at(-1)}`);

const makerText = await page.textContent('#offerList .offer-card .offer-maker');
ok(makerText.trim().length > 0, `offer shows the maker handle: "${makerText.trim()}"`);

ok(await page.$eval('#chooseOfferBtn', (b) => b.disabled), 'continue is disabled until an offer is picked');
await page.click('#offerList .offer-card');
ok(!(await page.$eval('#chooseOfferBtn', (b) => b.disabled)), 'picking an offer enables continue');
await page.screenshot({ path: join(shots, 'offers.png') });
await page.click('#chooseOfferBtn');

// --- Step 3: amount + your own receive address ----------------------------
await page.waitForSelector('[data-step="3"].active');
const chosen = await page.textContent('#offerChosen');
ok(/€/.test(chosen), 'step 3 recaps the chosen offer');

// Amount below the maker's minimum is refused.
await page.fill('#amountInput', '1');
await page.waitForTimeout(120);
ok(!(await page.$eval('#amountError', (e) => e.classList.contains('hidden'))),
  `amount below the seller's minimum is rejected: "${(await page.textContent('#amountError')).trim()}"`);

await page.fill('#amountInput', '500');
await page.waitForTimeout(120);
ok(await page.$eval('#amountError', (e) => e.classList.contains('hidden')), 'a valid amount clears the error');
ok(await page.$eval('#amountNextBtn', (b) => b.disabled), 'continue still blocked without an address');

// A checksum-valid address for the WRONG chain must be refused — this is the
// dangerous case a naive regex would wave through.
await page.fill('#addrInput', MAINNET_ADDRESS);
await page.waitForTimeout(120);
ok(!(await page.$eval('#addrError', (e) => e.classList.contains('hidden'))),
  `mainnet address rejected on a regtest backend: "${(await page.textContent('#addrError')).trim()}"`);

// A tampered address (valid charset, bad checksum) must also be refused.
await page.fill('#addrInput', RECEIVE_ADDRESS.slice(0, -1) + 'q');
await page.waitForTimeout(120);
ok(!(await page.$eval('#addrError', (e) => e.classList.contains('hidden'))),
  'address with a broken bech32 checksum is rejected');

await page.fill('#addrInput', RECEIVE_ADDRESS);
await page.waitForTimeout(150);
ok(await page.$eval('#addrError', (e) => e.classList.contains('hidden')), 'the correct regtest address validates');
const summary = await page.textContent('#amountSummary');
ok(/BTC/.test(summary), `step 3 previews the conversion: "${summary.trim()}"`);
ok(!(await page.$eval('#amountNextBtn', (b) => b.disabled)), 'continue unlocks once both fields are valid');
await page.screenshot({ path: join(shots, 'amount.png') });
await page.click('#amountNextBtn');

// --- Step 4: review, then take the offer ----------------------------------
await page.waitForSelector('[data-step="4"].active');
const review = await page.textContent('#reviewRows');
ok(review.includes(RECEIVE_ADDRESS), 'review shows the address the coins will go to');
ok(/€/.test(await page.textContent('#bankAmount')), 'review shows what you pay');
ok(/BTC/.test(await page.textContent('#cryptoAmount')), 'review shows what you receive');
await page.screenshot({ path: join(shots, 'review.png') });
await page.click('#confirmBridgeBtn');

// --- Payment screen (the fiat leg) ----------------------------------------
await page.waitForSelector('#paymentOverlay.show', { timeout: 15000 });
ok(true, 'payment screen appears at the fiat leg');
ok(!!(await page.$('#payQr svg')), 'GiroCode QR is rendered (self-contained SVG)');
const ibanTxt = await page.textContent('#payIban');
ok(/\d{4}/.test(ibanTxt), `payment screen shows the seller IBAN: "${ibanTxt.trim()}"`);
const payAmt = await page.textContent('#payAmount');
ok(payAmt.includes('500'), `payment screen shows the amount we chose: "${payAmt.trim()}"`);
// The seller's bank details are free text they typed; showing the source is
// what lets a user notice one who is playing games with it.
const payRaw = await page.textContent('#payRaw');
ok(payRaw.includes('DE02'), `payment screen discloses the seller's raw message: "${payRaw.trim()}"`);
await page.screenshot({ path: join(shots, 'payment.png') });
await page.click('#payConfirmSent');
ok(true, 'user confirms the SEPA transfer sent');

// --- Step 5: completion ---------------------------------------------------
await page.waitForSelector('#bridgeSuccess.show', { timeout: 15000 });
ok(true, 'trade completes and the success overlay appears');
await page.waitForSelector('[data-step="5"].active', { timeout: 15000 });
ok(true, 'flow advances to the completion summary (step 5)');

const btcBought = await page.textContent('#portfolioSats');
ok(/BTC/.test(btcBought), `completion shows the bitcoin bought: "${btcBought.trim()}"`);
const dest = await page.textContent('#destinationRows');
ok(dest.includes(RECEIVE_ADDRESS), 'completion shows the destination address');
const network = await page.textContent('#networkLabel');
ok(network.includes('mock') && network.includes('regtest'), `completion backend row from adapter: "${network}"`);
await page.screenshot({ path: join(shots, 'completion.png') });

// --- The demo fiction must stay deleted -----------------------------------
const html = await page.content();
const banned = [
  'Earn yield', 'APY', 'Swap tokens', 'Discover assets', 'PSD2',
  'Connect via PSD2', 'risk slider', 'Abstract Void', 'Liquid Chrome', 'Monolith Sector',
];
const found = banned.filter((s) => html.includes(s));
ok(found.length === 0, `no yield/art/swap/bank fiction left in the DOM${found.length ? ' — found: ' + found.join(', ') : ''}`);

const deadIds = await page.evaluate(() => ['artModal', 'investModal', 'bankGrid', 'holdingsSection', 'bridgeSlider']
  .filter((id) => document.getElementById(id)));
ok(deadIds.length === 0, `demo-only elements removed${deadIds.length ? ' — still present: ' + deadIds.join(', ') : ''}`);

// --- Start another trade returns to the book, keeping the address ---------
await page.click('#newTradeBtn');
await page.waitForSelector('[data-step="2"].active');
ok(true, '"start another trade" returns to the offer book');
ok(await page.$eval('#addrInput', (i) => i.value) === RECEIVE_ADDRESS,
  'the receive address is kept — retyping it is the risky part');

// --- Deep links still work, and never invent a destination ----------------
// #step=N seeds prerequisites on the mock only; step 5 needs a real trade, so
// it lands on review rather than fabricating a completed one.
const deep = await browser.newPage({ viewport: { width: 1280, height: 900 } });
deep.on('pageerror', (e) => { console.error('PAGE ERROR (deep link):', e.message); failures++; });
await deep.goto(APP + '#step=4');
await deep.waitForSelector('[data-step="4"].active', { timeout: 15000 });
ok(true, 'deep link #step=4 lands on review with prerequisites seeded');
ok((await deep.textContent('#reviewRows')).includes('bcrt1'),
  'deep-linked review has a regtest address matching the mock backend');

await deep.goto(APP + '#step=5');
await deep.waitForSelector('.step.active', { timeout: 15000 });
const landed = await deep.$eval('.step.active', (el) => el.dataset.step);
ok(landed === '4', `#step=5 stops at review (${landed}) instead of faking a completed trade`);
await deep.close();

await browser.close();
server.close();

if (failures > 0) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log('\nAll e2e checks passed.');
