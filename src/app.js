/* CryptoBridge Desktop — UI layer.

   Five steps, and every one of them is real: pick an offer from the network's
   own book, set the amount and the wallet address the coins go to, review,
   pay the seller by SEPA, done. All of it runs through the OnrampAdapter —
   MockAdapter by default, BisqAdapter against a user-run Bisq 2 node.

   The prototype's demo fiction is gone rather than flag-gated: the PSD2 bank
   picker, the invented account balances, and the art / yield / swap endgame.
   A yield product with a risk slider and an APY projection is precisely what
   the implementation plan's bright lines rule out (no yield, no advice), and
   code that never ships cannot contradict them. The full demo still lives in
   bhanneke/crypto-onramp if you want to show someone the vision.

   One rule worth keeping when editing this file: offer text (maker handles,
   payment-method names) arrives from a P2P network and is attacker-controlled.
   It goes into the DOM as textContent, never as innerHTML. */

import { TradeState } from './adapters/onramp-adapter.js';
import { MockAdapter } from './adapters/mock-adapter.js';
import { BisqAdapter } from './adapters/bisq-adapter.js';
import { ExternalWallet, isValidBtcAddress } from './adapters/wallet.js';
import { qrSvg } from './vendor/qr.js';

// ---------------------------------------------------------------
// State
// ---------------------------------------------------------------
const TOTAL_STEPS = 5;
const state = {
  step: 1,
  offers: [],            // last offer book fetched from the adapter
  selectedOffer: null,   // the offer the user picked (step 2)
  amountEur: 0,          // what they will send by SEPA (step 3)
  receiveAddress: '',    // their own BTC address, checksum-validated (step 3)
  trade: null,           // the live trade, once taken (step 4)
};

// ---------------------------------------------------------------
// Backend adapter — mock by default; opt into a real Bisq 2 node with
//   ?backend=bisq&node=http://127.0.0.1:8090/api/v1[&network=regtest]
// or the same keys in localStorage as `cryptobridge.<key>`.
//
// External-wallet mode: the receive address comes from the user, typed in
// step 3, and is handed to the wallet through an addressProvider — we hold no
// keys and never generate an address of our own. Inside the packaged app the
// node is reached over Tauri IPC (see adapters/transport.js), so the CSP stays
// connect-src 'self'.
// ---------------------------------------------------------------
const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/* Query params drive backend selection in browser dev; the packaged app has no
 * query string, so the same keys are also read from localStorage. The mock
 * stays the default in both — a real backend is never selected implicitly. */
function setting(q, key) {
  const fromQuery = q.get(key);
  if (fromQuery) return fromQuery;
  try {
    return localStorage.getItem(`cryptobridge.${key}`) || null;
  } catch {
    return null; // storage can be denied; not a reason to fail startup
  }
}

function createAdapter() {
  const q = new URLSearchParams(location.search);
  if (setting(q, 'backend') === 'bisq') {
    try {
      const network = setting(q, 'network') || 'mainnet';
      // The wallet asks the UI for the address at the moment it needs one, so
      // what the user typed in step 3 is what the seller is told to pay.
      const wallet = new ExternalWallet({
        addressProvider: () => state.receiveAddress,
        network,
      });
      // Authenticated nodes (authorizationRequired=true): paste the pairing QR
      // payload once as `cryptobridge.pairing`. It is spent immediately and
      // replaced by the credentials the node issues.
      //
      // Those credentials live in localStorage for now, which is honest but not
      // ideal — they are readable by any script that runs in this webview. The
      // audit found no XSS path today, and the alternative is re-pairing on
      // every launch; moving them into the Rust shell (so the webview never
      // holds the secret at all) is the follow-up. See docs/PAIRING_AUTH.md.
      let credentials = null;
      try {
        const stored = localStorage.getItem('cryptobridge.credentials');
        if (stored) credentials = JSON.parse(stored);
      } catch { /* absent or unreadable — pair again */ }

      return new BisqAdapter({
        restBaseUrl: setting(q, 'node') || undefined,
        wsUrl: setting(q, 'ws') || undefined,
        network,
        wallet,
        pairingCode: setting(q, 'pairing') || undefined,
        credentials,
        onCredentials: (c) => {
          try {
            localStorage.setItem('cryptobridge.credentials', JSON.stringify(c));
            localStorage.removeItem('cryptobridge.pairing');   // single-use, now spent
          } catch { /* storage denied: this session stays paired, the next re-pairs */ }
        },
      });
    } catch (err) {
      console.error('bisq backend not usable, falling back to mock:', err.message);
    }
  }
  return new MockAdapter({ latencyScale: reducedMotion() ? 0.2 : 1 });
}

const adapter = createAdapter();
let adapterReady = null;

// ---------------------------------------------------------------
// Formatting helpers (German locale for money, plain for BTC)
// ---------------------------------------------------------------
const fmtEUR = (n) => '€ ' + n.toLocaleString('de-DE', {
  minimumFractionDigits: 2, maximumFractionDigits: 2
});
const fmtBTC = (btc) => btc.toLocaleString('en-US', {
  minimumFractionDigits: 8, maximumFractionDigits: 8
}) + ' BTC';
const satsToBtc = (sats) => sats / 1e8;
const fmtPremium = (pct) =>
  typeof pct === 'number' && Number.isFinite(pct)
    ? `${pct > 0 ? '+' : ''}${pct.toFixed(1)}%`
    : '—';

/** Accepts both 1.234,56 (de) and 1234.56 (en); the last separator wins. */
function parseAmount(raw) {
  const s = String(raw ?? '').trim().replace(/\s/g, '');
  if (!s) return NaN;
  const lastComma = s.lastIndexOf(',');
  const lastDot = s.lastIndexOf('.');
  const normalised = lastComma > lastDot
    ? s.replace(/\./g, '').replace(',', '.')
    : s.replace(/,/g, '');
  return /^\d*\.?\d*$/.test(normalised) ? Number(normalised) : NaN;
}

// ---------------------------------------------------------------
// DOM helpers
// ---------------------------------------------------------------
const $  = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

/** Render a <dl> of label/value rows. Values are set as text, never markup —
 *  several of them are strings the trading network gave us. */
function renderRows(el, rows) {
  el.replaceChildren();
  for (const { label, value, mono } of rows) {
    const dt = document.createElement('dt');
    dt.textContent = label;
    const dd = document.createElement('dd');
    dd.textContent = value;
    if (mono) dd.classList.add('font-mono', 'break-all');
    el.append(dt, dd);
  }
}

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
  adapterReady = adapter.init();
  adapterReady.catch((err) => console.error('backend init failed', err));
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
  if (state.step === 2) loadOffers();
  if (state.step === 3) initAmountStep();
  if (state.step === 4) initReviewStep();
  if (state.step === 5) renderCompletion();
}
const next = () => setStep(state.step + 1);
const prev = () => setStep(state.step - 1);

// ---------------------------------------------------------------
// Step 2 — Offer book (real: adapter.listOffers)
// ---------------------------------------------------------------
function showOfferPane(which, message) {
  const list = $('#offerList');
  $('#offerLoading').classList.toggle('hidden', which !== 'loading');
  $('#offerLoading').classList.toggle('flex', which === 'loading');
  list.classList.toggle('hidden', which !== 'list');
  list.classList.toggle('flex', which === 'list');
  $('#offerEmpty').classList.toggle('hidden', which !== 'empty');
  $('#offerEmpty').classList.toggle('flex', which === 'empty');
  $('#offerError').classList.toggle('hidden', which !== 'error');
  $('#offerError').classList.toggle('flex', which === 'error');
  if (message) $('#offerErrorMsg').textContent = message;
}

/** Build one offer card. Every network-supplied string goes in as text. */
function offerCardEl(offer) {
  const btn = document.createElement('button');
  btn.className = 'offer-card';
  btn.dataset.offer = offer.id;
  btn.setAttribute('role', 'radio');
  btn.setAttribute('aria-checked', 'false');
  btn.innerHTML = `
    <span class="offer-body">
      <span class="offer-top">
        <span class="offer-maker"></span>
        <span class="offer-rep"></span>
      </span>
      <span class="offer-price tabular-nums"></span>
      <span class="offer-meta tabular-nums"></span>
    </span>
    <span class="offer-side">
      <span class="offer-premium tabular-nums"></span>
      <span class="offer-premium-cap">vs. market</span>
    </span>`;

  $('.offer-maker', btn).textContent = offer.maker || 'unknown seller';
  $('.offer-price', btn).textContent = `${fmtEUR(offer.priceEurPerBtc)} / BTC`;
  $('.offer-meta', btn).textContent =
    `${fmtEUR(offer.minEur)} – ${fmtEUR(offer.maxEur)} · ${offer.paymentMethod || 'SEPA'}`;
  $('.offer-premium', btn).textContent = fmtPremium(offer.premiumPct);

  const rep = $('.offer-rep', btn);
  if (offer.reputation != null) rep.textContent = `reputation ${offer.reputation}`;
  else rep.remove();

  return btn;
}

function selectOffer(offer, card) {
  state.selectedOffer = offer;
  $$('.offer-card').forEach((c) => {
    const on = c === card;
    c.classList.toggle('selected', on);
    c.setAttribute('aria-checked', String(on));
  });
  const btn = $('#chooseOfferBtn');
  btn.disabled = false;
  btn.classList.remove('is-disabled');
}

let offersLoading = false;
async function loadOffers({ force = false } = {}) {
  if (offersLoading) return;
  if (!force && state.offers.length) return;   // already have a book
  offersLoading = true;
  showOfferPane('loading');
  try {
    await adapterReady;
    const offers = await adapter.listOffers({ fiat: 'EUR', direction: 'buy' });
    // Cheapest first — the ordering a buyer actually wants. We rank what the
    // network returned; we do not filter, match or broker it.
    state.offers = [...offers].sort((a, b) => a.priceEurPerBtc - b.priceEurPerBtc);

    const list = $('#offerList');
    list.replaceChildren();
    for (const offer of state.offers) {
      const card = offerCardEl(offer);
      card.addEventListener('click', () => selectOffer(offer, card));
      list.append(card);
    }
    showOfferPane(state.offers.length ? 'list' : 'empty');

    // Keep a previous selection if it is still on the book.
    if (state.selectedOffer) {
      const still = state.offers.find((o) => o.id === state.selectedOffer.id);
      const card = still && $(`.offer-card[data-offer="${CSS.escape(still.id)}"]`);
      if (card) selectOffer(still, card);
      else state.selectedOffer = null;
    }
    if (!state.selectedOffer) {
      const btn = $('#chooseOfferBtn');
      btn.disabled = true;
      btn.classList.add('is-disabled');
    }
  } catch (err) {
    console.error('could not load offers', err);
    showOfferPane('error', err?.message || String(err));
  } finally {
    offersLoading = false;
  }
}

// ---------------------------------------------------------------
// Step 3 — Amount & destination
// ---------------------------------------------------------------
function initAmountStep() {
  const offer = state.selectedOffer;
  if (!offer) { setStep(2); return; }

  renderRows($('#offerChosen'), [
    { label: 'Seller', value: offer.maker || 'unknown seller' },
    { label: 'Price', value: `${fmtEUR(offer.priceEurPerBtc)} / BTC` },
    { label: 'Accepts', value: `${fmtEUR(offer.minEur)} – ${fmtEUR(offer.maxEur)}` },
  ]);
  $('#amountHint').textContent =
    `This seller accepts between ${fmtEUR(offer.minEur)} and ${fmtEUR(offer.maxEur)}.`;
  validateAmountStep();
}

function amountProblem() {
  const offer = state.selectedOffer;
  const raw = $('#amountInput').value;
  if (!String(raw).trim()) return { silent: true, msg: 'Enter an amount.' };
  const v = parseAmount(raw);
  if (!Number.isFinite(v) || v <= 0) return { msg: 'Enter an amount like 250 or 250,00.' };
  if (v < offer.minEur) return { msg: `This seller's minimum is ${fmtEUR(offer.minEur)}.` };
  if (v > offer.maxEur) return { msg: `This seller's maximum is ${fmtEUR(offer.maxEur)}.` };
  return null;
}

function addressProblem() {
  const raw = $('#addrInput').value.trim();
  const network = adapter.getBackendInfo().network;
  if (!raw) return { silent: true, msg: 'Enter your receive address.' };
  if (!isValidBtcAddress(raw, { network })) {
    // The checksum catches typos; the network check catches the much nastier
    // case of a valid address for the wrong chain.
    return { msg: `That is not a valid bitcoin address for the ${network} network.` };
  }
  return null;
}

function validateAmountStep() {
  const offer = state.selectedOffer;
  if (!offer) return;

  const aProb = amountProblem();
  const amountErr = $('#amountError');
  amountErr.textContent = aProb && !aProb.silent ? aProb.msg : '';
  amountErr.classList.toggle('hidden', !(aProb && !aProb.silent));
  $('#amountInput').classList.toggle('field-invalid', !!(aProb && !aProb.silent));

  const dProb = addressProblem();
  const addrErr = $('#addrError');
  addrErr.textContent = dProb && !dProb.silent ? dProb.msg : '';
  addrErr.classList.toggle('hidden', !(dProb && !dProb.silent));
  $('#addrInput').classList.toggle('field-invalid', !!(dProb && !dProb.silent));
  $('#addrInput').classList.toggle('field-valid', !dProb);

  const ok = !aProb && !dProb;
  if (ok) {
    state.amountEur = parseAmount($('#amountInput').value);
    state.receiveAddress = $('#addrInput').value.trim();
    const btc = state.amountEur / offer.priceEurPerBtc;
    $('#amountSummary').textContent = `${fmtEUR(state.amountEur)} → ≈ ${fmtBTC(btc)}`;
  } else {
    $('#amountSummary').innerHTML = '&nbsp;';
  }

  const btn = $('#amountNextBtn');
  btn.disabled = !ok;
  btn.classList.toggle('is-disabled', !ok);
}

function bindAmountStep() {
  $('#amountInput').addEventListener('input', validateAmountStep);
  $('#addrInput').addEventListener('input', validateAmountStep);
}

// ---------------------------------------------------------------
// Step 4 — Review, then take the offer
// ---------------------------------------------------------------
let particleAnim = null;

function initReviewStep() {
  const offer = state.selectedOffer;
  if (!offer || !state.amountEur) { setStep(offer ? 3 : 2); return; }

  const btc = state.amountEur / offer.priceEurPerBtc;
  $('#bankAmount').textContent = fmtEUR(state.amountEur);
  $('#cryptoAmount').textContent = `≈ ${fmtBTC(btc)}`;
  $('#bankFill').style.width = '100%';
  $('#cryptoFill').style.width = '100%';

  renderRows($('#reviewRows'), [
    { label: 'Seller', value: offer.maker || 'unknown seller' },
    { label: 'Price', value: `${fmtEUR(offer.priceEurPerBtc)} / BTC (${fmtPremium(offer.premiumPct)} vs. market)` },
    { label: 'You send', value: `${fmtEUR(state.amountEur)} by ${offer.paymentMethod || 'SEPA'} transfer` },
    { label: 'You receive', value: `≈ ${fmtBTC(btc)}` },
    { label: 'To your address', value: state.receiveAddress, mono: true },
  ]);

  const btn = $('#confirmBridgeBtn');
  btn.disabled = false;
  btn.classList.remove('is-disabled');
  btn.innerHTML = CONFIRM_LABEL;

  startParticleAnimation();
  particleAnim?.setIntensity(reducedMotion() ? 0 : 0.22);
  particleAnim?.setDirection(1);
}

// ----- Canvas particle animation: vertical glowing river -----
// Fiat (top) → bitcoin (bottom). Idles gently while you review and runs at
// full intensity while the trade is in flight.
// Color is spatial: indigo at top, violet in middle, mint at bottom.
function startParticleAnimation() {
  if (particleAnim) particleAnim.stop();
  const canvas = $('#bridgeCanvas');
  const ctx    = canvas.getContext('2d');
  const host   = canvas.parentElement;
  const dpr    = Math.min(window.devicePixelRatio || 1, 2);

  let w = 0, h = 0;
  let particles = [];
  let intensity = 0;
  let direction = 1;       // 1 = top→bottom (fiat→bitcoin), -1 = reverse
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

    // 2) Spawn — rate scales with intensity
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
// Taking the offer — a full trade through the OnrampAdapter.
// The trade pauses at AWAITING_FIAT_PAYMENT to show the seller's IBAN and an
// EPC069-12 GiroCode, and waits for the user's actual bank transfer.
// ---------------------------------------------------------------
const TRADE_LABELS = {
  [TradeState.OFFER_TAKEN]:           'Offer taken…',
  [TradeState.AWAITING_FIAT_PAYMENT]: 'Awaiting your SEPA payment…',
  [TradeState.FIAT_SENT]:             'Waiting for the seller…',
  [TradeState.FIAT_RECEIVED]:         'Payment confirmed…',
  [TradeState.BTC_RELEASED]:          'Releasing bitcoin…',
};
const CONFIRM_LABEL = 'Take this offer <span class="material-symbols-outlined text-[18px]">arrow_forward</span>';

// --- Payment screen (the fiat leg) --------------------------------------
const formatIban = (iban) => (iban || '').replace(/\s+/g, '').replace(/(.{4})/g, '$1 ').trim();

function paymentPhase(name, waitMsg) {
  $('#payPhasePay').hidden     = name !== 'pay';
  $('#payPhaseWait').hidden    = name !== 'wait';
  $('#payPhaseReceive').hidden = name !== 'receive';
  if (name === 'wait' && waitMsg) $('#payWaitMsg').textContent = waitMsg;
}
function showPayment() {
  const o = $('#paymentOverlay');
  o.classList.add('show');
  o.setAttribute('aria-hidden', 'false');
}
function hidePayment() {
  const o = $('#paymentOverlay');
  o.classList.remove('show');
  o.setAttribute('aria-hidden', 'true');
}

/** Show the IBAN + GiroCode and resolve once the user confirms they paid
 *  (which marks the SEPA transfer sent on the backend). */
function presentPayment(tradeId, instr, amountEur) {
  $('#payAmount').textContent = fmtEUR(amountEur);
  $('#payName').textContent   = instr.receiverName || '—';
  $('#payIban').textContent   = formatIban(instr.iban);
  const bicRow = $('#payBicRow');
  if (instr.bic) { $('#payBic').textContent = instr.bic; bicRow.hidden = false; } else bicRow.hidden = true;
  const refRow = $('#payRefRow');
  if (instr.reference) { $('#payRef').textContent = instr.reference; refRow.hidden = false; } else refRow.hidden = true;
  // The seller's raw text, verbatim and as text (never markup). The fields
  // above are our parse of it; showing the source is what lets a user notice a
  // seller who is playing games with it. See docs/SECURITY_AUDIT.md finding 1.
  const rawWrap = $('#payRawWrap');
  if (instr.rawAccountData) {
    $('#payRaw').textContent = instr.rawAccountData;
    rawWrap.hidden = false;
  } else {
    rawWrap.hidden = true;
  }

  // GiroCode from the adapter's EPC069-12 payload — verified self-contained SVG.
  $('#payQr').innerHTML = instr.epcQrPayload ? qrSvg(instr.epcQrPayload, { size: 220 }) : '';

  paymentPhase('pay');
  showPayment();

  return new Promise((resolve, reject) => {
    const btn = $('#payConfirmSent');
    const onClick = async () => {
      btn.removeEventListener('click', onClick);
      btn.disabled = true;
      btn.innerHTML = '<span class="spinner"></span> Confirming…';
      try {
        await adapter.confirmFiatSent(tradeId);
        paymentPhase('wait', 'Waiting for the seller to confirm receipt…');
        resolve();
      } catch (e) {
        reject(e);
      } finally {
        btn.disabled = false;
        btn.textContent = "I've sent the SEPA transfer";
      }
    };
    btn.addEventListener('click', onClick);
  });
}

/** For non-custodial backends the trade parks after release until the user
 *  confirms the bitcoin arrived in their own wallet. */
async function presentReceive(tradeId) {
  const addr = state.receiveAddress || await adapter.getReceiveAddress().catch(() => null);
  if (addr) $('#payAddr').textContent = addr;
  paymentPhase('receive');
  return new Promise((resolve, reject) => {
    const btn = $('#payConfirmReceived');
    const onClick = async () => {
      btn.removeEventListener('click', onClick);
      btn.disabled = true;
      btn.innerHTML = '<span class="spinner"></span> Confirming…';
      try {
        await adapter.confirmBtcReceived(tradeId);
        resolve();
      } catch (e) {
        reject(e);
      } finally {
        btn.disabled = false;
        btn.textContent = 'I received the bitcoin';
      }
    };
    btn.addEventListener('click', onClick);
  });
}

async function runTrade() {
  const offer = state.selectedOffer;
  const fiatAmountEur = state.amountEur;
  const trade = await adapter.takeOffer(offer.id, { fiatAmountEur });
  state.trade = trade;

  const btn = $('#confirmBridgeBtn');
  let shownPayment = false;
  await new Promise((resolve, reject) => {
    const unsub = adapter.subscribeTrade(trade.id, async (tradeState, updated) => {
      if (updated) state.trade = updated;
      if (TRADE_LABELS[tradeState]) {
        btn.innerHTML = `<span class="spinner"></span> ${TRADE_LABELS[tradeState]}`;
      }
      try {
        // Pause at the fiat leg: show the real IBAN + GiroCode and wait for the
        // user to make the SEPA transfer from their own bank.
        if (tradeState === TradeState.AWAITING_FIAT_PAYMENT && !shownPayment) {
          shownPayment = true;
          const instr = await adapter.getPaymentInstructions(trade.id);
          await presentPayment(trade.id, instr, fiatAmountEur);
        }
        if (tradeState === TradeState.FIAT_RECEIVED) {
          paymentPhase('wait', 'Seller confirmed the payment — releasing your bitcoin…');
        }
        if (tradeState === TradeState.BTC_RELEASED) {
          // Non-custodial backends (BisqAdapter) don't auto-assert receipt.
          if (typeof adapter.confirmBtcReceived === 'function' && adapter.autoConfirmBtcReceipt !== true) {
            await presentReceive(trade.id);
          } else {
            paymentPhase('wait', 'Finalising the trade…');
          }
        }
        if (tradeState === TradeState.COMPLETE) { hidePayment(); unsub(); resolve(); }
        if (tradeState === TradeState.FAILED)   { hidePayment(); unsub(); reject(new Error('trade failed')); }
      } catch (e) {
        hidePayment(); unsub(); reject(e);
      }
    });
  });
}

function bindTakeOffer() {
  const btn = $('#confirmBridgeBtn');
  btn.addEventListener('click', async () => {
    if (!state.selectedOffer || state.amountEur <= 0 || btn.dataset.busy) return;
    btn.dataset.busy = '1';
    btn.classList.add('is-disabled');
    btn.innerHTML = '<span class="spinner"></span> Taking the offer…';
    particleAnim?.setIntensity(reducedMotion() ? 0 : 1);

    let failed = null;
    try {
      await runTrade();
    } catch (err) {
      failed = err;
      console.error('trade failed', err);
    }

    particleAnim?.setIntensity(reducedMotion() ? 0 : 0.22);
    delete btn.dataset.busy;
    btn.classList.remove('is-disabled');
    btn.innerHTML = CONFIRM_LABEL;

    if (failed) {
      // A real backend can fail here; say so instead of pretending it worked.
      const rows = $('#reviewRows');
      renderRows(rows, [{ label: 'Trade failed', value: failed.message || String(failed) }]);
      return;
    }

    const overlay = $('#bridgeSuccess');
    const boughtSats = state.trade?.btcAmountSats;
    $('#successAmount').textContent = boughtSats != null
      ? fmtBTC(satsToBtc(boughtSats))
      : fmtBTC(state.amountEur / state.selectedOffer.priceEurPerBtc);
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
// Step 5 — Completion summary
//
// Deliberately not a "portfolio": we do not custody the coins and cannot see
// the user's balance, so this reports what the trade did and stops there.
// ---------------------------------------------------------------
function renderCompletion() {
  const info = adapter.getBackendInfo();
  $('#assetLabel').textContent   = info.asset;
  $('#networkLabel').textContent = `${info.backend} · ${info.network}`;

  const trade = state.trade;
  const offer = state.selectedOffer;
  const btc = trade?.btcAmountSats != null
    ? satsToBtc(trade.btcAmountSats)
    : (offer && state.amountEur ? state.amountEur / offer.priceEurPerBtc : 0);

  $('#portfolioSats').textContent  = `≈ ${fmtBTC(btc)}`;
  $('#portfolioAmount').textContent = `for ${fmtEUR(trade?.fiatAmountEur ?? state.amountEur)}`;

  const rows = [
    { label: 'To your address', value: state.receiveAddress || '—', mono: true },
  ];
  if (offer) {
    rows.push({ label: 'Seller', value: offer.maker || 'unknown seller' });
    rows.push({ label: 'Price', value: `${fmtEUR(offer.priceEurPerBtc)} / BTC` });
  }
  if (trade?.id) rows.push({ label: 'Trade', value: trade.id, mono: true });
  renderRows($('#destinationRows'), rows);
}

function bindNewTrade() {
  $('#newTradeBtn').addEventListener('click', () => {
    state.selectedOffer = null;
    state.amountEur = 0;
    state.trade = null;
    state.offers = [];
    $('#amountInput').value = '';
    // The receive address is deliberately kept: it is the user's own wallet
    // and retyping it is the risky part, not the reusing.
    setStep(2);
  });
}

// ---------------------------------------------------------------
// Deep links — #step=N jumps into the flow.
// Prerequisites are seeded only on the mock backend; against a real one we
// stop at the last step whose inputs actually exist, because inventing an
// offer or a receive address would be exactly the fiction we just removed.
// ---------------------------------------------------------------
const MOCK_DEMO_ADDRESS = {
  regtest: 'bcrt1qqv9pzxqlyckngw6zf9g9whn9d3eh4qvg0z9lm9',
  testnet: 'tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx',
  signet:  'tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx',
  mainnet: 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4',
};

async function applyDeepLink() {
  const m = location.hash.match(/step=(\d)/);
  if (!m) return false;
  const target = Math.max(1, Math.min(TOTAL_STEPS, Number(m[1])));
  if (target <= 2) { setStep(target); return true; }

  const info = adapter.getBackendInfo();
  const isMock = info.backend === 'mock';
  if (!isMock) { setStep(2); return true; }

  await loadOffers({ force: true });
  if (!state.offers.length) { setStep(2); return true; }
  state.selectedOffer = state.offers[0];
  const card = $(`.offer-card[data-offer="${CSS.escape(state.selectedOffer.id)}"]`);
  if (card) selectOffer(state.selectedOffer, card);

  if (target >= 4) {
    state.amountEur = Math.min(Math.max(500, state.selectedOffer.minEur), state.selectedOffer.maxEur);
    state.receiveAddress = MOCK_DEMO_ADDRESS[info.network] || MOCK_DEMO_ADDRESS.regtest;
    $('#amountInput').value = String(state.amountEur);
    $('#addrInput').value = state.receiveAddress;
  }
  setStep(target >= 5 ? 4 : target);   // step 5 needs a real trade; land on review
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

document.addEventListener('DOMContentLoaded', async () => {
  bindBackendStatus();
  bindGlobalActions();
  bindAmountStep();
  bindTakeOffer();
  bindNewTrade();
  if (!(await applyDeepLink())) setStep(1);
});
