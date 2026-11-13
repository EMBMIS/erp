/**
 * decodeText — bytes that are not UTF-8 do not become mojibake.
 *
 * The bug this guards against: a Windows-1250 CSV (routine for a Czech/
 * Polish/Hungarian export) decoded with `buffer.toString('utf8')` does not
 * throw — every invalid byte quietly becomes U+FFFD, so "Revizní" reads as
 * "Revizn�" and stays wrong all the way through analysis and review.
 */

const test = require('node:test');
const assert = require('node:assert');
const iconv = require('iconv-lite');

const { decodeText } = require('../services/ai/textEncoding');

test('decodeText: plain ASCII/UTF-8 text round-trips unchanged', () => {
  const text = 'Aqua Global, info@aquaglobal.cz, Water Treatment';
  assert.strictEqual(decodeText(Buffer.from(text, 'utf8')), text);
});

test('decodeText: genuine UTF-8 accented text round-trips unchanged', () => {
  const text = 'café, naïve, Zürich';
  assert.strictEqual(decodeText(Buffer.from(text, 'utf8')), text);
});

test('decodeText: a UTF-8 BOM is stripped', () => {
  const bom = Buffer.from([0xEF, 0xBB, 0xBF]);
  const buf = Buffer.concat([bom, Buffer.from('hello', 'utf8')]);
  assert.strictEqual(decodeText(buf), 'hello');
});

test('decodeText: Windows-1250 (Czech) bytes decode correctly instead of turning into replacement characters', () => {
  const text = 'Revizní činnost, Jaroslav Kulatý servis chlazení, POTRUBNÍ SYSTÉMY';
  const buf = iconv.encode(text, 'win1250');
  assert.strictEqual(decodeText(buf), text);
});

test('decodeText: a UTF-16LE BOM is honoured', () => {
  const buf = Buffer.concat([Buffer.from([0xFF, 0xFE]), Buffer.from('hi', 'utf16le')]);
  assert.strictEqual(decodeText(buf), 'hi');
});
