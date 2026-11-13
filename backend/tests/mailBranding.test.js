// Branded email body rendering.
//
// The bug this suite exists for shipped to real recipients: every branded
// plain-text email arrived with the characters `<br>` printed in the middle of
// its sentences —
//
//     Hi Mr. Sehnoutek, <br> <br>I was looking at BOCO's custom extrusion…
//
// The cause was one expression whose two halves ran in the wrong order:
//
//     p.replace(/\n/g, '<br>').replace(/</g, '&lt;')
//
// Break tags inserted, then escaped — so the escape pass consumed the very
// tags the line before had produced. (`>` was never escaped, which is why the
// output read as `<br>` rather than `&lt;br&gt;`.)
//
// It is a two-token mistake that no type checker catches and that looks
// perfectly reasonable in review, which is exactly why the ordering deserves a
// test of its own rather than only being exercised through render().
//
// Run on its own:  node --test tests/mailBranding.test.js

const assert = require('node:assert/strict');
const { test } = require('node:test');

const { textToHtml } = require('../services/mailBrandingService');

test('a newline becomes a real line break, not the visible characters', () => {
  const html = textToHtml('Line one\nLine two');
  assert.match(html, /Line one<br>Line two/);
  // The regression, stated directly: the output must not contain an escaped
  // break tag in any of the forms the old ordering could produce.
  assert.doesNotMatch(html, /&lt;br/);
});

test('a blank line starts a new paragraph', () => {
  const html = textToHtml('First para\n\nSecond para');
  const paragraphs = html.match(/<p /g) || [];
  assert.equal(paragraphs.length, 2);
  assert.match(html, /First para<\/p>/);
  assert.match(html, /Second para<\/p>/);
});

test('<br> markup written into a plain-text body is honoured as a break', () => {
  // Verbatim from the message that exposed this — a model wrote the tags into
  // a text body, which is routine, and no one has ever meant them literally.
  const body = "Hi Mr. Sehnoutek, <br> <br>I was looking at BOCO's projects.<br><br>Best,<br>Truong";
  const html = textToHtml(body);

  assert.doesNotMatch(html, /&lt;br/, 'break tags must not survive as visible text');
  assert.match(html, /Hi Mr\. Sehnoutek, <br>/);
  assert.match(html, /Best,<br>Truong/);
  // <br><br> is a paragraph boundary once normalised, same as a blank line.
  assert.ok((html.match(/<p /g) || []).length >= 2, 'double breaks should split paragraphs');
});

test('every <br> spelling is recognised', () => {
  for (const variant of ['<br>', '<br/>', '<br />', '<BR>', '<Br />']) {
    const html = textToHtml(`a${variant}b`);
    assert.match(html, /a<br>b/, `${variant} was not normalised`);
    assert.doesNotMatch(html, /&lt;/, `${variant} left escaped markup behind`);
  }
});

test('everything other than <br> is still escaped', () => {
  // The <br> normalisation is a hole cut for exactly one tag. Anything else in
  // a plain-text body is text, and must reach the recipient as text.
  const html = textToHtml('hello <script>alert(1)</script> world');
  assert.match(html, /&lt;script&gt;/);
  assert.doesNotMatch(html, /<script>/, 'a text body must never inject live markup');
});

test('ampersands and quotes are escaped, and escaped once', () => {
  const html = textToHtml('Tom & Jerry said "hi"');
  assert.match(html, /Tom &amp; Jerry said &quot;hi&quot;/);
  // & is escaped before < and >, so the entities this produces are not then
  // re-escaped into &amp;lt; — the classic double-escape.
  assert.doesNotMatch(html, /&amp;(lt|gt|quot|amp);/);
});

test('empty and whitespace-only input produce no empty paragraphs', () => {
  assert.equal(textToHtml(''), '');
  assert.equal(textToHtml(null), '');
  assert.equal(textToHtml(undefined), '');
  assert.equal(textToHtml('\n\n   \n\n'), '');
  // Trailing blank lines are common in composed mail and used to emit an
  // empty <p>, which shows up as a stray gap above the footer.
  assert.equal((textToHtml('Body text\n\n\n').match(/<p /g) || []).length, 1);
});
