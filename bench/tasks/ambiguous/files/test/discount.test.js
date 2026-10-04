import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyDiscount } from '../discount.js';
test('loyal pays less', () => assert.equal(applyDiscount(50, { loyal: true }), 45));
test('large order discount', () => assert.equal(applyDiscount(200, { loyal: false }), 190));
test('discounts do not stack: the bigger one wins', () => assert.equal(applyDiscount(200, { loyal: true }), 180));
