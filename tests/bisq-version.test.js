import test from 'node:test';
import assert from 'node:assert/strict';
import { compareVersions, isSupportedBisqVersion, MIN_BISQ_VERSION } from '../src/adapters/bisq-version.js';

test('versions compare numerically, not as text', () => {
  assert.equal(compareVersions('2.1.13', '2.1.9'), 1);    // "13" < "9" as text
  assert.equal(compareVersions('2.1.12', '2.1.12'), 0);
  assert.equal(compareVersions('2.1.11', '2.1.12'), -1);
  assert.equal(compareVersions('2.2', '2.1.99'), 1);
  assert.equal(compareVersions('2.1', '2.1.0'), 0);
});

test('2.1.12 is the minimum: the release that made updating mandatory to trade', () => {
  assert.equal(MIN_BISQ_VERSION, '2.1.12');
  assert.equal(isSupportedBisqVersion('2.1.12'), true);
  assert.equal(isSupportedBisqVersion('2.1.13'), true);
  assert.equal(isSupportedBisqVersion('2.2.0'), true);
  assert.equal(isSupportedBisqVersion('2.1.11'), false);
  assert.equal(isSupportedBisqVersion('2.1.9'), false);
});

test('a development build counts as its base version', () => {
  assert.equal(isSupportedBisqVersion('2.1.12-SNAPSHOT'), true);
  assert.equal(isSupportedBisqVersion('2.1.11-SNAPSHOT'), false);
});

test('a node that cannot say what it is does not get the benefit of the doubt', () => {
  for (const v of ['', null, undefined, 'unknown', 'v', '   ']) {
    assert.equal(isSupportedBisqVersion(v), false, `accepted ${JSON.stringify(v)}`);
  }
});
