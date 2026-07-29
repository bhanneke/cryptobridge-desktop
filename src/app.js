/* CryptoBridge Desktop — UI layer.
   6-step flow ported from bhanneke/crypto-onramp, now routed through an
   OnrampAdapter: the bridge step runs a real trade lifecycle (offer → fiat
   leg → BTC release) against the pluggable backend. MockAdapter today,
   BisqAdapter next. Steps 2–3 (bank picker, accounts) and the explore
   endgame (art, yield, swap) are demo fiction kept from the prototype. */

import { TradeState } from './adapters/onramp-adapter.js';
import { MockAdapter } from './adapters/mock-adapter.js';
import { BisqAdapter } from './adapters/bisq-adapter.js';
import { ExternalWallet } from './adapters/wallet.js';

// ---------------------------------------------------------------
// Backend adapter — mock by default; opt into a real Bisq 2 node with
//   ?backend=bisq&node=http://127.0.0.1:8090/api/v1&addr=<your BTC address>[&network=regtest]
// External-wallet mode: `addr` is a receive address from your own wallet — we
// hold no keys. NOTE: talking to a node from the Tauri build needs the node's
// origin added to the CSP in src-tauri/tauri.conf.json (or routing via Rust
// IPC); the plain-browser dev server has no CSP, so this works there today.
// The full bisq trade UX (payment screen, manual BTC-receipt confirm) is the
// next milestone — see docs/BISQADAPTER_PLAN.md.
// ---------------------------------------------------------------
const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

function createAdapter() {
  const q = new URLSearchParams(location.search);
  if (q.get('backend') === 'bisq') {
    try {
      const wallet = new ExternalWallet({
        address: q.get('addr') || undefined,
        network: q.get('network') || 'mainnet',
      });
      return new BisqAdapter({
        restBaseUrl: q.get('node') || undefined,
        wsUrl: q.get('ws') || undefined,
        network: q.get('network') || 'mainnet',
        wallet,
      });
    } catch (err) {
      console.error('bisq backend not usable, falling back to mock:', err.message);
    }
  }
  return new MockAdapter({ latencyScale: reducedMotion() ? 0.2 : 1 });
}

const adapter = createAdapter();

// ---------------------------------------------------------------
// State
// ---------------------------------------------------------------
const TOTAL_STEPS = 6;
const state = {
  step: 1,
  selectedBank: null,        // 'ing' | 'dkb' | ...
  selectedBankName: '',
  selectedAccount: null,     // 1 | 2 | 3
  selectedBalance: 0,
  bridgedAmount: 0,          // € value moved in the current bridge round
  bankAmount: 0,             // € value remaining in bank (after slider)
  cryptoBalance: 0,          // cumulative bridged € still spendable (UI mirror
                             // of the adapter wallet; drift is rounding only)
  owned: [],                 // artwork ids purchased
  positions: [],             // { title, apy, sub, amount } yield positions
};

// ---------------------------------------------------------------
// Market data (demo constants — no network)
// ---------------------------------------------------------------
const ETH_EUR = 3214.20;

const ARTWORKS = [
  { id: 'void',     artist: '0xGeometry',  title: 'Abstract Void #042',    floor: 2.4, vol: 142, art: 1, verified: true },
  { id: 'chrome',   artist: 'Studio Meta', title: 'Liquid Chrome Genesis', floor: 1.8, vol: 89,  art: 2 },
  { id: 'monolith', artist: 'Architexture', title: 'Monolith Sector 7',    floor: 4.1, vol: 310, art: 3 },
];

// ---------------------------------------------------------------
// Bank catalogue (inline SVG wordmarks — copyright-safe stylings)
// ---------------------------------------------------------------
const BANKS = [
  { id: 'ing',     name: 'ING',
    svg: `<svg viewBox="0 0 120 36" xmlns="http://www.w3.org/2000/svg"><rect width="120" height="36" rx="6" fill="#FF6200"/><text x="60" y="24" text-anchor="middle" font-family="Inter, sans-serif" font-size="18" font-weight="700" fill="#fff" letter-spacing="2">ING</text></svg>` },
  { id: 'dkb',     name: 'DKB',
    svg: `<svg viewBox="0 0 120 36" xmlns="http://www.w3.org/2000/svg"><text x="60" y="25" text-anchor="middle" font-family="Inter, sans-serif" font-size="22" font-weight="700" fill="#14A2D1" letter-spacing="1">DKB</text></svg>` },
  { id: 'consors', name: 'Consorsbank',
    svg: `<svg viewBox="0 0 120 36" xmlns="http://www.w3.org/2000/svg"><circle cx="14" cy="18" r="7" fill="none" stroke="#1B4DA8" stroke-width="3"/><text x="28" y="23" font-family="Inter, sans-serif" font-size="13" font-weight="600" fill="#1B4DA8">consors</text></svg>` },
  { id: 'tr',      name: 'Trade Republic',
    svg: `<svg viewBox="0 0 120 36" xmlns="http://www.w3.org/2000/svg"><path d="M18 22 Q 40 4, 60 15 T 102 11" stroke="#0B1220" stroke-width="2.5" fill="none" stroke-linecap="round"/><text x="60" y="31" text-anchor="middle" font-family="Inter, sans-serif" font-size="8" font-weight="600" fill="#0B1220" letter-spacing="1.5">TRADE REPUBLIC</text></svg>` },
  { id: 'n26',     name: 'N26',
    svg: `<svg viewBox="0 0 120 36" xmlns="http://www.w3.org/2000/svg"><text x="60" y="25" text-anchor="middle" font-family="Inter, sans-serif" font-size="20" font-weight="700" fill="#0B1220" letter-spacing="1">N26</text></svg>` },
  { id: 'sparkasse', name: 'Sparkasse',
    svg: `<svg viewBox="0 0 120 36" xmlns="http://www.w3.org/2000/svg"><rect x="6" y="10" width="20" height="16" rx="2" fill="#E2001A"/><path d="M10 14 Q 16 10, 22 14 Q 16 22, 22 22 Q 16 22, 10 22 Q 16 18, 10 14 Z" fill="#fff"/><text x="32" y="23" font-family="Inter, sans-serif" font-size="12" font-weight="700" fill="#E2001A">Sparkasse</text></svg>` },
  { id: 'deutsche', name: 'Deutsche Bank',
    svg: `<svg viewBox="0 0 120 36" xmlns="http://www.w3.org/2000/svg"><rect x="8" y="10" width="16" height="16" fill="none" stroke="#0018A8" stroke-width="2.5"/><line x1="10" y1="23" x2="22" y2="13" stroke="#0018A8" stroke-width="2.5"/><text x="30" y="23" font-family="Inter, sans-serif" font-size="11" font-weight="600" fill="#0018A8">Deutsche Bank</text></svg>` },
  { id: 'commerzbank', name: 'Commerzbank',
    svg: `<svg viewBox="0 0 120 36" xmlns="http://www.w3.org/2000/svg"><path d="M10 12 L20 12 L15 20 Z" fill="#FFCC33"/><text x="26" y="23" font-family="Inter, sans-serif" font-size="12" font-weight="700" fill="#002F5F">Commerzbank</text></svg>` },
  { id: 'comdirect', name: 'comdirect',
    svg: `<svg viewBox="0 0 120 36" xmlns="http://www.w3.org/2000/svg"><circle cx="16" cy="18" r="6" fill="#FFF04D"/><text x="28" y="23" font-family="Inter, sans-serif" font-size="14" font-weight="600" fill="#0B1220">comdirect</text></svg>` },
];

// ---------------------------------------------------------------
// Formatting helpers (German locale)
// ---------------------------------------------------------------
const fmtEUR = (n) => '€ ' + n.toLocaleString('de-DE', {
  minimumFractionDigits: 2, maximumFractionDigits: 2
});
const fmtETH = (n) => n.toLocaleString('en-US', { maximumFractionDigits: 2 }) + ' ETH';
const fmtBTC = (sats) => (sats / 1e8).toLocaleString('en-US', {
  minimumFractionDigits: 5, maximumFractionDigits: 5
}) + ' BTC';
const eurToSats = (eur) => Math.round((eur / adapter.getBackendInfo().rateEurPerBtc) * 1e8);

// ---------------------------------------------------------------
// DOM helpers
// ---------------------------------------------------------------
const $  = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

// ---------------------------------------------------------------
// Backend status pill (header)
// ---------------------------------------------------------------
function bindBackendStatus() {
  adapter.subscribeStatus(({ status, backend, network }) => {
    const pill = $('#backendPill');
    pill.dataset.status = status;
    $('#backendLabel').textContent =
      status === 'connected' ? `${backend} · ${network}` :
      status === 'connecting' ? 'connecting…' : 'backend offline';
  });
  adapter.init().catch((err) => console.error('backend init failed', err));
}

// ---------------------------------------------------------------
// Step navigation
// ---------------------------------------------------------------
function setStep(n) {
  state.step = Math.max(1, Math.min(TOTAL_STEPS, n));
  $$('.step').forEach(el => el.classList.toggle('active', Number(el.dataset.step) === state.step));
  $('#stepIndicator').textContent = `Step ${state.step} of ${TOTAL_STEPS}`;
  $('#progressBar').style.width = `${(state.step / TOTAL_STEPS) * 100}%`;
  $('#backBtn').classList.toggle('hidden', state.step === 1);
  try { history.replaceState(null, '', `#step=${state.step}`); } catch (_) { /* file:// in some browsers */ }
  window.scrollTo({ top: 0, behavior: 'smooth' });

  // Per-step setup
  if (state.step === 3) renderBankNameLabel();
  if (state.step === 4) initBridgeStep();
  if (state.step === 5) renderPortfolio();
  if (state.step === 6) { setExploreTab('assets'); renderExploreState(); }
}
const next = () => setStep(state.step + 1);
const prev = () => setStep(state.step - 1);

// ---------------------------------------------------------------
// Step 2 — Bank grid (demo fiction: a real desktop client has no bank step;
// the fiat leg is a SEPA transfer from the user's own banking app)
// ---------------------------------------------------------------
function renderBankGrid() {
  const grid = $('#bankGrid');
  grid.innerHTML = BANKS.map(b => `
    <button class="bank-tile" data-bank="${b.id}" aria-label="${b.name}">
      ${b.svg}
    </button>
  `).join('');

  grid.addEventListener('click', (e) => {
    const tile = e.target.closest('.bank-tile');
    if (!tile) return;
    const id = tile.dataset.bank;
    const bank = BANKS.find(b => b.id === id);
    state.selectedBank = id;
    state.selectedBankName = bank.name;
    $$('.bank-tile', grid).forEach(t => t.classList.toggle('selected', t === tile));
    const btn = $('#connectBankBtn');
    btn.disabled = false;
    btn.classList.remove('is-disabled');
  });
}

function bindBankSearch() {
  const input = $('#bankSearch');
  if (!input) return;
  input.addEventListener('input', () => {
    const q = input.value.trim().toLowerCase();
    let visible = 0;
    $$('.bank-tile').forEach(tile => {
      const bank = BANKS.find(b => b.id === tile.dataset.bank);
      const hit = !q || bank.name.toLowerCase().includes(q);
      tile.classList.toggle('hidden', !hit);
      if (hit) visible++;
    });
    const empty = $('#bankEmpty');
    empty.classList.toggle('hidden', visible > 0);
    empty.classList.toggle('flex', visible === 0);
  });
}

function renderBankNameLabel() {
  $('#bankNameLabel').textContent = state.selectedBankName || 'your bank';
}

// ---------------------------------------------------------------
// Step 3 — Account balances (randomized on load)
// ---------------------------------------------------------------
const accountBalances = (() => {
  const base = { 1: 2547.35, 2: 15832.42, 3: 8721.90 };
  const r = {};
  for (const k of Object.keys(base)) {
    const variation = (Math.random() - 0.5) * 0.2;
    r[k] = parseFloat((base[k] * (1 + variation)).toFixed(2));
  }
  return r;
})();

function renderAccountBalances() {
  $$('[data-balance]').forEach(el => {
    const id = el.dataset.balance;
    el.textContent = fmtEUR(accountBalances[id]);
  });
}

function bindAccountSelection() {
  $$('.account-card').forEach(card => {
    card.addEventListener('click', () => {
      const id = Number(card.dataset.account);
      state.selectedAccount = id;
      state.selectedBalance = accountBalances[id];
      next();
    });
  });
}

// ---------------------------------------------------------------
// Step 4 — Bridge interaction + particle animation
// ---------------------------------------------------------------
let particleAnim = null;
let lastSliderPct = 0;
let bridgeDirection = 1;   // 1 = bank→crypto (top→bottom), -1 = reverse

function initBridgeStep() {
  const slider = $('#bridgeSlider');
  slider.value = 0;
  lastSliderPct = 0;
  bridgeDirection = 1;
  updateBridge(0);

  slider.removeEventListener('input', onBridgeSliderInput);
  slider.addEventListener('input', onBridgeSliderInput);

  startParticleAnimation();
}

function onBridgeSliderInput(e) {
  updateBridge(Number(e.target.value));
}

function updateBridge(pct) {
  if (pct > lastSliderPct)      bridgeDirection =  1;
  else if (pct < lastSliderPct) bridgeDirection = -1;
  lastSliderPct = pct;

  const ratio = pct / 100;
  const crypto = state.selectedBalance * ratio;
  const bank   = state.selectedBalance - crypto;

  state.bridgedAmount = crypto;
  state.bankAmount    = bank;

  $('#bankAmount').textContent   = fmtEUR(bank);
  $('#cryptoAmount').textContent = fmtEUR(crypto);
  $('#bankFill').style.width   = `${100 - pct}%`;
  $('#cryptoFill').style.width = `${pct}%`;
  $('#sliderFill').style.width = `${pct}%`;
  $('#sliderThumb').style.left  = `${pct}%`;
  $('#bridgeAmountText').textContent = fmtEUR(crypto);

  const confirm = $('#confirmBridgeBtn');
  if (pct > 0) {
    confirm.disabled = false; confirm.classList.remove('is-disabled');
  } else {
    confirm.disabled = true; confirm.classList.add('is-disabled');
  }

  if (particleAnim) {
    particleAnim.setIntensity(ratio);
    particleAnim.setDirection(bridgeDirection);
  }
}

// ----- Canvas particle animation: vertical glowing river -----
// Bank (top) → Crypto (bottom) by default. Reverses when slider moves back.
// Color is spatial: indigo at top, violet in middle, mint at bottom — so
// the visual identity of each end is preserved regardless of flow direction.
function startParticleAnimation() {
  if (particleAnim) particleAnim.stop();
  const canvas = $('#bridgeCanvas');
  const ctx    = canvas.getContext('2d');
  const host   = canvas.parentElement;
  const dpr    = Math.min(window.devicePixelRatio || 1, 2);

  let w = 0, h = 0;
  let particles = [];
  let intensity = 0;
  let direction = 1;       // 1 = top→bottom (bank→crypto), -1 = reverse
  let rafId = null;
  let spawnAcc = 0;
  let prevTs = 0;

  function resize() {
    const r = host.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return;
    w = r.width;  h = r.height;
    canvas.width  = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    canvas.style.width  = w + 'px';
    canvas.style.height = h + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function spawn() {
    const dir = direction;
    particles.push({
      dir,
      x0: 12 + Math.random() * Math.max(24, w - 24),  // wobble axis
      y:  dir === 1 ? -20 : h + 20,                   // spawn at entry edge
      vy: 0.9 + Math.random() * 1.4,
      amp: 5 + Math.random() * 14,
      freq: 0.008 + Math.random() * 0.014,
      phase: Math.random() * Math.PI * 2,
      size: 1.3 + Math.random() * 2.0,
    });
  }

  // Color along the bridge (top → bottom):
  // indigo (#6366F1) → violet (#8B5CF6) → mint (#34D399)
  function colorAt(t, a) {
    let r, g, b;
    if (t < 0.5) {
      const k = t * 2;
      r = 99  + (139 - 99 ) * k;
      g = 102 + ( 92 - 102) * k;
      b = 241 + (246 - 241) * k;
    } else {
      const k = (t - 0.5) * 2;
      r = 139 + ( 52 - 139) * k;
      g =  92 + (211 -  92) * k;
      b = 246 + (153 - 246) * k;
    }
    return `rgba(${r|0},${g|0},${b|0},${a})`;
  }

  function tick(ts) {
    if (!w || !h) { resize(); rafId = requestAnimationFrame(tick); return; }
    const dt = prevTs ? Math.min(50, ts - prevTs) : 16;
    prevTs = ts;

    // 1) Aggressive trail decay — keeps the river crisp instead of bloating.
    ctx.globalCompositeOperation = 'destination-out';
    ctx.fillStyle = 'rgba(0,0,0,0.45)';
    ctx.fillRect(0, 0, w, h);

    // 2) Spawn — rate scales with slider intensity
    if (intensity > 0) {
      spawnAcc += dt * intensity * 0.28;
      while (spawnAcc > 1) { spawn(); spawnAcc -= 1; }
    } else {
      spawnAcc = 0;
    }

    // 3) Additive draw
    ctx.globalCompositeOperation = 'lighter';
    const speed = 0.55 + intensity * 0.85;

    for (let i = particles.length - 1; i >= 0; i--) {
      const p = particles[i];
      p.y += p.vy * p.dir * speed * (dt / 16.67);

      // Travel progress: 0 at entry edge, 1 at exit edge (for fade-in/out).
      const travel = p.dir === 1
        ? Math.max(0, Math.min(1, p.y / h))
        : Math.max(0, Math.min(1, 1 - p.y / h));
      const edge = Math.sin(travel * Math.PI);

      // Spatial color: always indigo at top, mint at bottom.
      const yProg = Math.max(0, Math.min(1, p.y / h));

      const x = p.x0 + Math.sin(p.y * p.freq + p.phase) * p.amp;

      // halo
      ctx.fillStyle = colorAt(yProg, 0.035 * edge);
      ctx.beginPath();
      ctx.arc(x, p.y, p.size * 5, 0, Math.PI * 2);
      ctx.fill();
      // mid glow
      ctx.fillStyle = colorAt(yProg, 0.14 * edge);
      ctx.beginPath();
      ctx.arc(x, p.y, p.size * 2.2, 0, Math.PI * 2);
      ctx.fill();
      // core
      ctx.fillStyle = colorAt(yProg, 0.90 * edge);
      ctx.beginPath();
      ctx.arc(x, p.y, p.size, 0, Math.PI * 2);
      ctx.fill();

      // Cull when past exit edge
      if (p.dir === 1 ? p.y > h + 30 : p.y < -30) particles.splice(i, 1);
    }

    ctx.globalCompositeOperation = 'source-over';
    rafId = requestAnimationFrame(tick);
  }

  resize();
  const ro = new ResizeObserver(resize);
  ro.observe(host);
  setTimeout(resize, 50);
  setTimeout(resize, 250);

  rafId = requestAnimationFrame(tick);

  particleAnim = {
    setIntensity: (v) => { intensity = v; },
    setDirection: (d) => { direction = (d < 0) ? -1 : 1; },
    stop: () => {
      if (rafId) cancelAnimationFrame(rafId);
      ro.disconnect();
      particles = [];
      try { ctx.clearRect(0, 0, canvas.width, canvas.height); } catch (_) {}
    }
  };
}

// ---------------------------------------------------------------
// Bridge confirmation — a full trade through the OnrampAdapter.
// The button narrates the trade states while the mock peer acts; a real
// client pauses at AWAITING_FIAT_PAYMENT to show the IBAN + EPC QR from
// getPaymentInstructions() and waits for the user's actual bank transfer.
// ---------------------------------------------------------------
const TRADE_LABELS = {
  [TradeState.OFFER_TAKEN]:           'Offer taken…',
  [TradeState.AWAITING_FIAT_PAYMENT]: 'Sending SEPA payment…',
  [TradeState.FIAT_SENT]:             'Waiting for the seller…',
  [TradeState.FIAT_RECEIVED]:         'Payment confirmed…',
  [TradeState.BTC_RELEASED]:          'Releasing bitcoin…',
};
const CONFIRM_LABEL = 'Confirm bridge <span class="material-symbols-outlined text-[18px]">arrow_forward</span>';

async function runBridgeTrade(fiatAmountEur) {
  const offers = await adapter.listOffers({ fiat: 'EUR', direction: 'buy' });
  const offer = offers
    .filter(o => fiatAmountEur >= o.minEur && fiatAmountEur <= o.maxEur)
    .sort((a, b) => a.priceEurPerBtc - b.priceEurPerBtc)[0] || offers[0];
  const trade = await adapter.takeOffer(offer.id, { fiatAmountEur });

  const btn = $('#confirmBridgeBtn');
  await new Promise((resolve, reject) => {
    const unsub = adapter.subscribeTrade(trade.id, (tradeState) => {
      if (TRADE_LABELS[tradeState]) {
        btn.innerHTML = `<span class="spinner"></span> ${TRADE_LABELS[tradeState]}`;
      }
      if (tradeState === TradeState.AWAITING_FIAT_PAYMENT) {
        // Demo shortcut: pay the fiat leg instantly instead of showing
        // the payment screen. The instructions endpoint stays exercised.
        adapter.getPaymentInstructions(trade.id)
          .then(() => adapter.confirmFiatSent(trade.id))
          .catch(reject);
      }
      if (tradeState === TradeState.COMPLETE) { unsub(); resolve(); }
      if (tradeState === TradeState.FAILED)   { unsub(); reject(new Error('trade failed')); }
    });
  });
}

function bindBridgeConfirm() {
  const btn = $('#confirmBridgeBtn');
  btn.addEventListener('click', async () => {
    if (state.bridgedAmount <= 0 || btn.dataset.busy) return;
    btn.dataset.busy = '1';
    btn.classList.add('is-disabled');
    btn.innerHTML = '<span class="spinner"></span> Fetching offers…';

    try {
      await runBridgeTrade(state.bridgedAmount);
    } catch (err) {
      // Mock backend never fails; a real adapter surfaces this in the UI.
      console.error('bridge trade failed', err);
    }

    state.cryptoBalance += state.bridgedAmount;   // accumulate across bridge rounds
    state.selectedBalance = state.bankAmount;     // remaining bank money is the new pot
    delete btn.dataset.busy;
    btn.innerHTML = CONFIRM_LABEL;

    const overlay = $('#bridgeSuccess');
    $('#successAmount').textContent = fmtEUR(state.bridgedAmount);
    overlay.classList.add('show');
    overlay.setAttribute('aria-hidden', 'false');
    setTimeout(() => {
      overlay.classList.remove('show');
      overlay.setAttribute('aria-hidden', 'true');
      next();
    }, reducedMotion() ? 500 : 1400);
  });
}

// ---------------------------------------------------------------
// Step 5 — Portfolio
// ---------------------------------------------------------------
function animateAmount(el, target, duration = 700) {
  if (reducedMotion() || target <= 0) { el.textContent = fmtEUR(target); return; }
  const t0 = performance.now();
  const frame = (t) => {
    const k = Math.min(1, (t - t0) / duration);
    const ease = 1 - Math.pow(1 - k, 3);
    el.textContent = fmtEUR(target * ease);
    if (k < 1) requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

async function renderWalletFacts() {
  const info = adapter.getBackendInfo();
  $('#assetLabel').textContent   = info.asset;
  $('#networkLabel').textContent = `${info.backend} · ${info.network}`;
  const bal = await adapter.getWalletBalance();
  $('#portfolioSats').textContent = bal.confirmedSats > 0
    ? `≈ ${fmtBTC(bal.confirmedSats)} in your self-custodied wallet`
    : 'Nothing bridged yet';
}

function renderPortfolio() {
  animateAmount($('#portfolioAmount'), state.cryptoBalance);
  renderWalletFacts();
  renderHoldings();

  const accountTypes = { 1: 'Checking', 2: 'Savings', 3: 'Investment' };
  const ibans = {
    1: 'DE89 1001 1001 1234 5678 90',
    2: 'DE89 1001 1001 9876 5432 10',
    3: 'DE89 1001 1001 2468 1357 90',
  };

  const container = $('#connectedAccounts');
  container.innerHTML = [1, 2, 3].map(id => {
    const isBridged = id === state.selectedAccount;
    const balance = isBridged ? state.bankAmount : accountBalances[id];
    return `
      <div class="funding-row ${isBridged ? 'is-bridged' : ''}">
        ${isBridged ? `
          <div class="ribbon">
            <span class="material-symbols-outlined text-[12px]">done</span>
            Used for bridge
          </div>` : ''}
        <div class="icon-tile">
          <span class="material-symbols-outlined">account_balance</span>
        </div>
        <div class="flex flex-col">
          <span class="font-semibold">${state.selectedBankName || 'CryptoBridge'} · ${accountTypes[id]}</span>
          <span class="text-[13px] text-ink2 font-mono">${ibans[id].slice(-9)}</span>
        </div>
        <div class="ml-auto text-right">
          <div class="text-[13px] text-ink2">Balance</div>
          <div class="font-semibold tabular-nums">${fmtEUR(balance)}</div>
        </div>
      </div>
    `;
  }).join('');
}

function bindExploreShortcuts() {
  $$('.explore-card').forEach(btn => {
    btn.addEventListener('click', () => {
      const target = btn.dataset.explore; // assets|savings|swap
      setStep(6);
      setExploreTab(target);
    });
  });
}

// ---------------------------------------------------------------
// Step 6 — Explore tabs + risk slider
// ---------------------------------------------------------------
function setExploreTab(tab) {
  $$('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  $$('.tab-panel').forEach(p => p.classList.toggle('hidden', p.dataset.tabPanel !== tab));
  if (tab === 'savings') {
    // Random count for flavor (47 default in markup)
    $('#savingsCount').textContent = String(20 + Math.floor(Math.random() * 50));
  }
}

function bindTabs() {
  $$('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => setExploreTab(btn.dataset.tab));
  });
}

const YIELDS = {
  1: { title: 'Stable Yield Pool',         apy: '1.5%', sub: 'Low risk · Flex withdrawal',  fill: 10  },
  2: { title: 'Conservative Yield Fund',   apy: '2.8%', sub: 'Low risk · 7d lock',          fill: 30  },
  3: { title: 'Balanced Yield Strategy',   apy: '4.2%', sub: 'Medium risk · 30d lock',      fill: 50  },
  4: { title: 'Growth Yield Portfolio',    apy: '6.5%', sub: 'Higher risk · 60d lock',      fill: 75  },
  5: { title: 'High Yield Opportunity',    apy: '9.8%', sub: 'High risk · 90d lock',        fill: 100 },
};
const RISK_LABELS = ['', 'Conservative (Level 1)', 'Cautious (Level 2)', 'Balanced (Level 3)', 'Growth (Level 4)', 'Aggressive (Level 5)'];

let currentRisk = 3;

function bindRiskSlider() {
  const slider = $('#riskSlider');
  if (!slider) return;
  slider.addEventListener('input', (e) => {
    const v = Number(e.target.value);
    currentRisk = v;
    const y = YIELDS[v];
    $('#productTitle').textContent = y.title;
    $('#productSub').textContent   = y.sub;
    $('#productApy').textContent   = y.apy;
    $('#riskFill').style.width = `${y.fill}%`;
    $('#riskLabel').textContent = RISK_LABELS[v];
  });
}

// ---------------------------------------------------------------
// Modals (shared open/close)
// ---------------------------------------------------------------
function openModal(el)  { el.classList.add('show');    el.setAttribute('aria-hidden', 'false'); }
function closeModal(el) { el.classList.remove('show'); el.setAttribute('aria-hidden', 'true');  }

function bindModals() {
  $$('.modal').forEach(modal => {
    modal.addEventListener('click', (e) => {
      if (e.target === modal || e.target.closest('[data-close]')) closeModal(modal);
    });
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') $$('.modal.show').forEach(closeModal);
  });
}

// ---------------------------------------------------------------
// Explore — wallet pill, art marketplace, yield positions.
// Purchases stay demo fiction, but the spend is mirrored to the adapter
// wallet via withdraw() so the sats balance on the portfolio stays honest.
// ---------------------------------------------------------------
function mirrorSpendToWallet(eur, memo) {
  adapter.withdraw(`demo:${memo}`, eurToSats(eur)).catch(() => { /* demo only */ });
}

function updateWalletPill() {
  $('#walletBalance').textContent = fmtEUR(state.cryptoBalance);
}

function renderExploreState() {
  updateWalletPill();
  renderArtGrid();
  renderYieldPositions();
}

function renderArtGrid() {
  const grid = $('#artGrid');
  grid.innerHTML = ARTWORKS.map(a => {
    const owned = state.owned.includes(a.id);
    return `
      <article class="nft-card">
        <div class="nft-thumb relative" data-art="${a.art}">
          ${owned ? '<span class="owned-badge"><span class="material-symbols-outlined text-[13px]">check</span>Owned</span>' : ''}
        </div>
        <div class="p-4 flex flex-col gap-2">
          <div class="flex justify-between items-start">
            <span class="text-[12px] text-ink2">${a.artist}</span>
            ${a.verified ? '<span class="material-symbols-outlined text-indigo text-[16px]">verified</span>' : ''}
          </div>
          <h3 class="font-semibold truncate">${a.title}</h3>
          <div class="pt-2 border-t border-line flex justify-between items-end">
            <div>
              <div class="text-[10px] uppercase tracking-wider text-ink2">Floor</div>
              <div class="font-semibold tabular-nums">${fmtETH(a.floor)}</div>
            </div>
            <span class="text-[12px] text-ink2 tabular-nums">Vol: ${a.vol} ETH</span>
          </div>
          <button class="btn-secondary w-full mt-1 ${owned ? 'is-owned' : ''}" data-buy="${a.id}" ${owned ? 'disabled' : ''}>
            ${owned ? 'In your portfolio' : `Buy · ${fmtEUR(a.floor * ETH_EUR)}`}
          </button>
        </div>
      </article>`;
  }).join('');

  $$('[data-buy]', grid).forEach(btn => {
    btn.addEventListener('click', () => openArtModal(btn.dataset.buy));
  });
}

function openArtModal(id) {
  const a = ARTWORKS.find(x => x.id === id);
  const priceEur = a.floor * ETH_EUR;
  const affordable = state.cryptoBalance >= priceEur;
  const body = $('#artModalBody');

  body.innerHTML = `
    <div class="nft-thumb modal-thumb" data-art="${a.art}"></div>
    <div class="flex justify-between items-start mt-4">
      <div>
        <div class="text-[12px] text-ink2">${a.artist}</div>
        <h3 class="text-[20px] font-semibold tracking-[-0.01em]">${a.title}</h3>
      </div>
      ${a.verified ? '<span class="material-symbols-outlined text-indigo">verified</span>' : ''}
    </div>
    <div class="flex justify-between items-center mt-4 py-3 border-y border-line text-[14px]">
      <span class="text-ink2">Price</span>
      <span class="font-semibold tabular-nums">${fmtETH(a.floor)} · ${fmtEUR(priceEur)}</span>
    </div>
    <div class="flex justify-between items-center py-3 border-b border-line text-[14px]">
      <span class="text-ink2">Your bridged balance</span>
      <span class="font-semibold tabular-nums ${affordable ? 'text-ink' : 'text-red-500'}">${fmtEUR(state.cryptoBalance)}</span>
    </div>
    ${affordable ? `
      <button id="artBuyBtn" class="btn-primary w-full mt-5">
        Buy for ${fmtETH(a.floor)}
        <span class="material-symbols-outlined text-[18px]">arrow_forward</span>
      </button>
      <p class="text-[12px] text-muted text-center mt-2">Network fee ~€0.42 · Instant transfer to your wallet</p>
    ` : `
      <div class="insufficient-note mt-5">
        <span class="material-symbols-outlined text-[18px]">error</span>
        You need ${fmtEUR(priceEur - state.cryptoBalance)} more to collect this piece.
      </div>
      <button id="bridgeMoreBtn" class="btn-primary w-full mt-3">
        Bridge more euros
        <span class="material-symbols-outlined text-[18px]">arrow_forward</span>
      </button>
    `}`;

  const modal = $('#artModal');
  openModal(modal);

  const buyBtn = $('#artBuyBtn');
  if (buyBtn) buyBtn.addEventListener('click', () => {
    buyBtn.classList.add('is-disabled');
    buyBtn.innerHTML = '<span class="spinner"></span> Confirming purchase…';
    setTimeout(() => {
      state.cryptoBalance -= priceEur;
      state.owned.push(a.id);
      mirrorSpendToWallet(priceEur, `art-${a.id}`);
      body.innerHTML = `
        <div class="flex flex-col items-center text-center py-6">
          <div class="success-check"><span class="material-symbols-outlined text-[40px]">check</span></div>
          <p class="text-[18px] font-semibold mt-5">It's yours</p>
          <p class="text-[14px] text-ink2 mt-1"><strong>${a.title}</strong> is now in your portfolio.</p>
          <p class="text-[13px] text-muted mt-3 tabular-nums">New balance: ${fmtEUR(state.cryptoBalance)}</p>
          <button class="btn-primary w-full mt-6" data-close>Done</button>
        </div>`;
      renderExploreState();
    }, reducedMotion() ? 300 : 1100);
  });

  const moreBtn = $('#bridgeMoreBtn');
  if (moreBtn) moreBtn.addEventListener('click', () => {
    closeModal(modal);
    setStep(4);
  });
}

// ----- Yield investing -----
function openInvestModal() {
  const y = YIELDS[currentRisk];
  const body = $('#investModalBody');
  const max = state.cryptoBalance;

  body.innerHTML = `
    <div class="flex items-center gap-3">
      <div class="h-11 w-11 rounded-xl2 bg-bg border border-line grid place-items-center">
        <span class="material-symbols-outlined text-[20px]">savings</span>
      </div>
      <div>
        <h3 class="text-[18px] font-semibold tracking-[-0.01em]">${y.title}</h3>
        <span class="text-[13px] text-ink2">${y.sub} · <strong class="text-mint">${y.apy} APY</strong></span>
      </div>
    </div>
    <div class="mt-5">
      <div class="flex justify-between items-center mb-1.5">
        <label for="investAmount" class="text-[12px] text-ink2">Amount to invest</label>
        <span class="text-[12px] text-muted tabular-nums">Available: ${fmtEUR(max)}</span>
      </div>
      <input id="investAmount" type="text" inputmode="decimal" placeholder="0.00"
        class="w-full h-12 px-4 bg-bg border border-line rounded-xl2 text-[18px] font-semibold tabular-nums focus:outline-none focus:border-indigo focus:shadow-ring transition" />
      <div class="flex gap-2 mt-2.5">
        ${[25, 50, 75, 100].map(p => `<button class="amount-chip" data-pct="${p}">${p === 100 ? 'Max' : p + '%'}</button>`).join('')}
      </div>
    </div>
    <div class="flex justify-between items-center mt-5 py-3 border-y border-line text-[14px]">
      <span class="text-ink2">Projected earnings (1y)</span>
      <span id="investProj" class="font-semibold text-mint tabular-nums">€ 0,00</span>
    </div>
    <button id="investConfirm" class="btn-primary w-full mt-5 is-disabled" disabled>Invest</button>
    <p class="text-[12px] text-muted text-center mt-2">Withdraw anytime after the lock period · Demo, no real yield</p>`;

  const modal = $('#investModal');
  openModal(modal);

  const input = $('#investAmount');
  const confirm = $('#investConfirm');
  const apyRate = parseFloat(y.apy) / 100;
  let amount = 0;

  const refresh = () => {
    let s = String(input.value).trim();
    if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.'); // German format
    const v = parseFloat(s);
    amount = Number.isFinite(v) && v > 0 ? Math.min(v, max) : 0;
    $('#investProj').textContent = fmtEUR(amount * apyRate);
    confirm.disabled = amount <= 0;
    confirm.classList.toggle('is-disabled', amount <= 0);
    confirm.textContent = amount > 0 ? `Invest ${fmtEUR(amount)}` : 'Invest';
  };
  input.addEventListener('input', refresh);

  $$('.amount-chip', body).forEach(chip => {
    chip.addEventListener('click', () => {
      $$('.amount-chip', body).forEach(c => c.classList.toggle('active', c === chip));
      input.value = (max * Number(chip.dataset.pct) / 100).toFixed(2).replace('.', ',');
      refresh();
    });
  });

  confirm.addEventListener('click', () => {
    if (amount <= 0) return;
    state.cryptoBalance -= amount;
    state.positions.push({ title: y.title, apy: y.apy, sub: y.sub, amount });
    mirrorSpendToWallet(amount, 'yield');
    body.innerHTML = `
      <div class="flex flex-col items-center text-center py-6">
        <div class="success-check"><span class="material-symbols-outlined text-[40px]">check</span></div>
        <p class="text-[18px] font-semibold mt-5">Position opened</p>
        <p class="text-[14px] text-ink2 mt-1"><strong class="tabular-nums">${fmtEUR(amount)}</strong> is earning <strong class="text-mint">${y.apy} APY</strong> in ${y.title}.</p>
        <p class="text-[13px] text-muted mt-3 tabular-nums">New balance: ${fmtEUR(state.cryptoBalance)}</p>
        <button class="btn-primary w-full mt-6" data-close>Done</button>
      </div>`;
    renderExploreState();
  });
}

function renderYieldPositions() {
  const wrap = $('#yieldPositions');
  const has = state.positions.length > 0;
  wrap.classList.toggle('hidden', !has);
  wrap.classList.toggle('flex', has);
  if (!has) return;
  $('#yieldPositionsList').innerHTML = state.positions.map(p => `
    <div class="funding-row">
      <div class="icon-tile"><span class="material-symbols-outlined">savings</span></div>
      <div class="flex flex-col">
        <span class="font-semibold">${p.title}</span>
        <span class="text-[13px] text-ink2">${p.sub}</span>
      </div>
      <div class="ml-auto text-right">
        <div class="font-semibold tabular-nums">${fmtEUR(p.amount)}</div>
        <div class="text-[13px] text-mint tabular-nums">${p.apy} APY</div>
      </div>
    </div>`).join('');
}

// ----- Portfolio holdings (step 5) -----
function renderHoldings() {
  const section = $('#holdingsSection');
  const art = state.owned.map(id => ARTWORKS.find(a => a.id === id));
  const has = art.length > 0 || state.positions.length > 0;
  section.classList.toggle('hidden', !has);
  section.classList.toggle('flex', has);
  if (!has) return;

  $('#holdingsList').innerHTML = [
    ...art.map(a => `
      <div class="funding-row">
        <div class="nft-thumb holding-thumb" data-art="${a.art}"></div>
        <div class="flex flex-col">
          <span class="font-semibold">${a.title}</span>
          <span class="text-[13px] text-ink2">${a.artist} · Digital art</span>
        </div>
        <div class="ml-auto text-right">
          <div class="font-semibold tabular-nums">${fmtETH(a.floor)}</div>
          <div class="text-[13px] text-ink2 tabular-nums">${fmtEUR(a.floor * ETH_EUR)}</div>
        </div>
      </div>`),
    ...state.positions.map(p => `
      <div class="funding-row">
        <div class="icon-tile"><span class="material-symbols-outlined">savings</span></div>
        <div class="flex flex-col">
          <span class="font-semibold">${p.title}</span>
          <span class="text-[13px] text-ink2">Yield position</span>
        </div>
        <div class="ml-auto text-right">
          <div class="font-semibold tabular-nums">${fmtEUR(p.amount)}</div>
          <div class="text-[13px] text-mint tabular-nums">${p.apy} APY</div>
        </div>
      </div>`),
  ].join('');
}

// ---------------------------------------------------------------
// Swap calculator (demo rate, no network)
// ---------------------------------------------------------------
const SWAP = { eurPerEth: ETH_EUR, fee: 0.0012 }; // ETH → USDC, USDC pegged 1:1 EUR for the demo

function bindSwap() {
  const pay = $('#swapPay');
  if (!pay) return;
  const update = () => {
    const v = parseFloat(String(pay.value).replace(',', '.'));
    const eth = Number.isFinite(v) && v > 0 ? v : 0;
    const eur = eth * SWAP.eurPerEth;
    const out = eur * (1 - SWAP.fee);
    $('#swapPayEur').textContent = fmtEUR(eur);
    $('#swapReceive').value = out.toFixed(2);
    $('#swapReceiveEur').textContent = `${fmtEUR(out)} (−${(SWAP.fee * 100).toFixed(2)}%)`;
  };
  pay.addEventListener('input', update);
  update();
}

// ---------------------------------------------------------------
// Deep links — #step=N jumps into the flow with seeded demo state
// ---------------------------------------------------------------
function applyDeepLink() {
  const m = location.hash.match(/step=(\d)/);
  if (!m) return false;
  const target = Math.max(1, Math.min(TOTAL_STEPS, Number(m[1])));
  if (target >= 3 && !state.selectedBank) {
    state.selectedBank = 'ing';
    state.selectedBankName = 'ING';
  }
  if (target >= 4 && !state.selectedAccount) {
    state.selectedAccount = 2;
    state.selectedBalance = accountBalances[2];
  }
  if (target >= 5 && state.bridgedAmount === 0) {
    state.bridgedAmount = state.selectedBalance * 0.4;
    state.bankAmount = state.selectedBalance * 0.6;
    state.cryptoBalance = state.bridgedAmount;
    state.selectedBalance = state.bankAmount;
    adapter.seedWallet?.(state.cryptoBalance);  // mock-only helper; keeps the sats view consistent
  }
  setStep(target);
  if (target === 4) {
    $('#bridgeSlider').value = 40;
    updateBridge(40);
  }
  return true;
}

// ---------------------------------------------------------------
// Wire up
// ---------------------------------------------------------------
function bindGlobalActions() {
  document.body.addEventListener('click', (e) => {
    const a = e.target.closest('[data-action]');
    if (!a) return;
    if (a.disabled || a.classList.contains('is-disabled')) return;
    if (a.dataset.action === 'next') next();
  });
  $('#backBtn').addEventListener('click', prev);
}

document.addEventListener('DOMContentLoaded', () => {
  bindBackendStatus();
  renderBankGrid();
  bindBankSearch();
  renderAccountBalances();
  bindAccountSelection();
  bindGlobalActions();
  bindBridgeConfirm();
  bindTabs();
  bindRiskSlider();
  bindSwap();
  bindExploreShortcuts();
  bindModals();
  $('#investBtn').addEventListener('click', openInvestModal);
  if (!applyDeepLink()) setStep(1);
});
