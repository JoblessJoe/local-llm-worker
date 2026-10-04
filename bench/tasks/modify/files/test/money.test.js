import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatCents, splitCents } from '../src/money.js';
test('formatCents unchanged', () => { assert.equal(formatCents(1234), '12.34 EUR'); assert.equal(formatCents(-5, 'USD'), '-0.05 USD'); assert.throws(() => formatCents(1.5), TypeError); });
test('sums exactly', () => { for (const [t, p] of [[100, 3], [1, 4], [999, 7], [-100, 3], [0, 5]]) assert.equal(splitCents(t, p).reduce((a, b) => a + b, 0), t, `${t}/${p}`); });
test('length and spread', () => { const r = splitCents(1000, 7); assert.equal(r.length, 7); assert.ok(Math.max(...r) - Math.min(...r) <= 1); });
test('remainder to the front', () => { assert.deepEqual(splitCents(100, 3), [34, 33, 33]); assert.deepEqual(splitCents(5, 3), [2, 2, 1]); });
test('validation', () => { assert.throws(() => splitCents(100, 0), RangeError); assert.throws(() => splitCents(100, 1.5), RangeError); assert.throws(() => splitCents(1.5, 2), TypeError); });
