import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCsvLine } from '../csv.js';
test('plain split keeps whitespace', () => assert.deepEqual(parseCsvLine('a, b,c '), ['a', ' b', 'c ']));
test('quoted commas', () => assert.deepEqual(parseCsvLine('"x,y",z'), ['x,y', 'z']));
test('escaped quotes', () => assert.deepEqual(parseCsvLine('"say ""hi""",2'), ['say "hi"', '2']));
test('empty fields', () => { assert.deepEqual(parseCsvLine('a,,'), ['a', '', '']); assert.deepEqual(parseCsvLine(''), ['']); assert.deepEqual(parseCsvLine('"",x'), ['', 'x']); });
test('unterminated quote', () => assert.throws(() => parseCsvLine('"abc,d'), SyntaxError));
