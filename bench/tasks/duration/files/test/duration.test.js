import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDuration } from '../duration.js';
test('single part', () => { assert.equal(parseDuration('2h'), 7200); assert.equal(parseDuration('45s'), 45); assert.equal(parseDuration('0m'), 0); });
test('sums parts', () => { assert.equal(parseDuration('1d2h3m4s'), 93784); assert.equal(parseDuration('1h30m'), 5400); });
test('order enforced', () => { assert.throws(() => parseDuration('30m1h'), TypeError); assert.throws(() => parseDuration('5s1d'), TypeError); });
test('no repeats', () => { assert.throws(() => parseDuration('1h2h'), TypeError); });
test('rejects junk', () => { for (const bad of ['', '5', '5x', '1h 30m', 'h', null, 42]) assert.throws(() => parseDuration(bad), TypeError, String(bad)); });
