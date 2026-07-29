/* Adversarial regression tests from the security audit (docs/SECURITY_AUDIT.md).
 *
 * Every test here encodes an attack that worked against an earlier revision of
 * this code. They are written from the attacker's side on purpose: the threat
 * model is a hostile trade peer or a lying Bisq node, not a network
 * eavesdropper, because the fiat leg is executed by the user's own bank app
 * from data those parties supply.
 *
 * If one of these ever fails again, someone's money is at stake — do not
 * "adjust the expectation" to make it pass. */
import test from 'node:test';
import assert from 'node:assert/strict';

import { epcPayload, parseSepaAccountData, looksLikeIban } from '../src/adapters/epc.js';
import { isValidBtcAddress, ExternalWallet } from '../src/adapters/wallet.js';
import { BisqAdapter } from '../src/adapters/bisq-adapter.js';
import { TradeState } from '../src/adapters/onramp-adapter.js';

// EPC069-12 line indices (0-based). A GiroCode reader keys on position, which
// is precisely why an injected newline is dangerous.
const EPC = { SERVICE: 0, VERSION: 1, CHARSET: 2, ID: 3, BIC: 4, NAME: 5, IBAN: 6, AMOUNT: 7 };

const REAL_IBAN = 'DE02120300000000202051';
const ATTACKER_IBAN = 'DE99ATTACKER0000000';

/** A transport that would throw if the adapter tried any I/O — these tests are
 *  pure state-machine tests and must not touch the network. */
const noTransport = {
  request: () => { throw new Error('no I/O expected in this test'); },
  openSocket: () => { throw new Error('no I/O expected in this test'); },
};

// --- Finding 1: EPC field injection --------------------------------------

test('EPC: a newline in the receiver name cannot shift the IBAN or amount lines', () => {
  const payload = epcPayload({
    receiverName: `Mallory\n${ATTACKER_IBAN}\nEUR9999.00`,
    iban: REAL_IBAN,
    amountEur: 500,
  });
  const lines = payload.split('\n');
  assert.equal(lines[EPC.IBAN], REAL_IBAN, 'the IBAN line must still be the real IBAN');
  assert.equal(lines[EPC.AMOUNT], 'EUR500.00', 'the amount line must still be the agreed amount');
});

test('EPC: a hostile seller account-data string cannot forge the GiroCode', () => {
  // The seller types this by hand and Bisq hands it over as free text. Here it
  // is crafted so the *displayed* IBAN is the honest one (it is what the IBAN
  // regex matches first) while the newlines push an attacker IBAN and amount
  // into the positions a banking app actually reads.
  const hostile = `${REAL_IBAN}\n${ATTACKER_IBAN}\nEUR9999.00, Alice`;
  const parsed = parseSepaAccountData(hostile);

  assert.equal(parsed.iban, REAL_IBAN, 'precondition: the screen would show the honest IBAN');

  const payload = epcPayload({
    receiverName: parsed.holderName,
    iban: parsed.iban,
    bic: parsed.bic,
    amountEur: 500,
    reference: '',
  });
  const lines = payload.split('\n');

  // The whole point: what you scan must be what you were shown.
  assert.equal(lines[EPC.IBAN], parsed.iban, 'the QR must encode the IBAN the user was shown');
  assert.equal(lines[EPC.AMOUNT], 'EUR500.00', 'the QR must encode the agreed amount');
  assert.equal(lines.length, 12, 'field count must be fixed, so no line can be displaced');

  // The attacker's text does survive inside the *name* field, and that is fine:
  // the name is the seller's to choose, and a name cannot redirect a payment.
  // What matters is that it stays on one line. The UI additionally shows the
  // seller's raw text so a nonsense name is visible rather than laundered.
  assert.equal(lines[EPC.NAME].split('\n').length, 1, 'the name must occupy exactly one line');
});

test('EPC: control characters are stripped from every field', () => {
  const payload = epcPayload({
    receiverName: 'A\r\nB C',
    iban: `${REAL_IBAN}`,
    bic: 'BIC\nX',
    amountEur: 10,
    reference: 'ref\nerence',
  });
  const lines = payload.split('\n');
  assert.equal(lines.length, 12, 'an EPC payload has exactly 12 lines');
  assert.equal(lines[EPC.IBAN], REAL_IBAN);
  assert.equal(lines[EPC.AMOUNT], 'EUR10.00');
});

// --- Finding 2: legacy addresses were not checksummed ---------------------

test('address: a one-character typo in a legacy address is rejected', () => {
  const genesis = '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa';
  assert.ok(isValidBtcAddress(genesis, { network: 'mainnet' }), 'precondition: the real address validates');

  // Same length, same alphabet, one character different — structurally
  // indistinguishable, but the base58check checksum does not match. Sending
  // here loses the coins with no recourse.
  const typo = '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNb';
  assert.ok(!isValidBtcAddress(typo, { network: 'mainnet' }), 'a corrupted legacy address must not validate');
});

test('address: valid legacy P2PKH and P2SH still validate on the right chain', () => {
  assert.ok(isValidBtcAddress('1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa', { network: 'mainnet' }));
  assert.ok(isValidBtcAddress('3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy', { network: 'mainnet' }));
  // ...and are refused on the wrong chain.
  assert.ok(!isValidBtcAddress('1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa', { network: 'testnet' }));
});

// --- Finding 3: COMPLETE could be forced without the user confirming ------

test('trade: a node cannot jump to COMPLETE without the user confirming receipt', () => {
  const wallet = new ExternalWallet({
    address: 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4',
    network: 'mainnet',
  });
  const adapter = new BisqAdapter({
    wallet, network: 'mainnet', autoConfirmBtcReceipt: false, transport: noTransport,
  });

  const seen = [];
  adapter.subscribeTrade('t1', (s) => seen.push(s));

  // A hostile peer/node skips the whole protocol and asserts the end state.
  adapter._applyTradeDelta('t1', { tradeState: 'BUYER_BTC_CONFIRMED' });

  assert.ok(
    !seen.includes(TradeState.COMPLETE),
    'COMPLETE must not be reachable while the user has not confirmed the bitcoin arrived',
  );
});

test('trade: COMPLETE is delivered once the user has actually confirmed', () => {
  const wallet = new ExternalWallet({
    address: 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4',
    network: 'mainnet',
  });
  const adapter = new BisqAdapter({
    wallet, network: 'mainnet', autoConfirmBtcReceipt: false, transport: noTransport,
  });
  const seen = [];
  adapter.subscribeTrade('t1', (s) => seen.push(s));

  // The user pressed "I received the bitcoin" — recorded by confirmBtcReceived.
  adapter.btcReceiptSent.add('t1');
  adapter._applyTradeDelta('t1', { tradeState: 'BUYER_BTC_CONFIRMED' });

  assert.ok(seen.includes(TradeState.COMPLETE), 'the honest path must still reach COMPLETE');
});

test('trade: autoConfirmBtcReceipt (tests/demo) still reaches COMPLETE', () => {
  const wallet = new ExternalWallet({
    address: 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4',
    network: 'mainnet',
  });
  const adapter = new BisqAdapter({
    wallet, network: 'mainnet', autoConfirmBtcReceipt: true, transport: noTransport,
  });
  const seen = [];
  adapter.subscribeTrade('t1', (s) => seen.push(s));
  adapter._applyTradeDelta('t1', { tradeState: 'BUYER_BTC_CONFIRMED' });
  assert.ok(seen.includes(TradeState.COMPLETE));
});

// --- Finding 4: IBAN check was structural only ----------------------------

test('IBAN: the mod-97 checksum rejects a transposed digit', () => {
  assert.ok(looksLikeIban(REAL_IBAN), 'precondition: the real IBAN passes');
  // Swap two digits — same country, same length, same shape.
  const swapped = 'DE02120300000000202015';
  assert.ok(!looksLikeIban(swapped), 'a transposed IBAN must fail the checksum');
});
