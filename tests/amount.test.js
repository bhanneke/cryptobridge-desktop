import test from 'node:test';
import assert from 'node:assert/strict';
import { btcToSats } from '../src/adapters/amount.js';

test('whole and fractional amounts convert exactly', () => {
  assert.equal(btcToSats('1'), 100000000);
  assert.equal(btcToSats('0.1'), 10000000);
  assert.equal(btcToSats('1.5'), 150000000);
  assert.equal(btcToSats('0.00234'), 234000);
  assert.equal(btcToSats('0.00000001'), 1);
  assert.equal(btcToSats('0'), 0);
  assert.equal(btcToSats('.5'), 50000000);
});

/* The reason this module exists. 0.1 * 1e8 is 10000000.000000002 in IEEE 754,
 * and 2.  675 * 1e8 rounds the wrong way. Amounts must be exact. */
test('values that floating point gets wrong are exact here', () => {
  assert.equal(btcToSats('0.1'), 10000000);
  assert.equal(btcToSats('2.675'), 267500000);
  assert.equal(btcToSats('0.07'), 7000000);
  assert.equal(btcToSats('4.35'), 435000000);
  for (const [a, b] of [['0.1', '0.2']]) {
    assert.equal(btcToSats(a) + btcToSats(b), btcToSats('0.3'));
  }
});

test('a German decimal comma is accepted', () => {
  assert.equal(btcToSats('1,5'), 150000000);
  assert.equal(btcToSats('0,00000001'), 1);
});

test('anything finer than a satoshi is refused, not rounded', () => {
  assert.equal(btcToSats('0.123456789'), null);
  assert.equal(btcToSats('0.000000001'), null);
});

test('nonsense is refused rather than coerced to zero', () => {
  for (const v of ['', '  ', '.', 'abc', '1.2.3', '-1', '1e8', '0x10', null, undefined, '1 000']) {
    assert.equal(btcToSats(v), null, `accepted ${JSON.stringify(v)}`);
  }
});

test('a negative amount is not silently turned positive', () => {
  assert.equal(btcToSats('-0.5'), null);
});

test('absurd amounts are refused rather than losing precision', () => {
  // Past 2^53 satoshis, ordinary JS arithmetic stops being exact.
  assert.equal(btcToSats('100000000'), null);
  assert.ok(btcToSats('21000000') > 0, 'the whole supply still fits');
});
