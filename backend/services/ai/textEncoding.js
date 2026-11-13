/**
 * Decode a text file's bytes without assuming UTF-8.
 *
 * A CSV or text file exported from Excel/Windows — routine for a European
 * contact list, ledger export, or notes file — is often Windows-1250/1252,
 * not UTF-8. Naive `buffer.toString('utf8')` does not fail on that: every
 * invalid byte sequence is silently replaced with U+FFFD, so "Revizní"
 * becomes "Revizn�" and the file still "reads", just wrong — mangled text
 * an LLM then either can't recognise (a name it should have extracted) or,
 * worse, copies verbatim into the database. Decoding strictly first, and
 * only falling back once that genuinely fails, catches the mismatch instead
 * of shipping mojibake to whoever reviews the result.
 */
const iconv = require('iconv-lite');

function decodeText(buffer) {
  if (buffer.length >= 3 && buffer[0] === 0xEF && buffer[1] === 0xBB && buffer[2] === 0xBF) {
    return buffer.slice(3).toString('utf8');
  }
  if (buffer.length >= 2 && buffer[0] === 0xFF && buffer[1] === 0xFE) {
    return buffer.slice(2).toString('utf16le');
  }
  if (buffer.length >= 2 && buffer[0] === 0xFE && buffer[1] === 0xFF) {
    return Buffer.from(buffer.slice(2)).swap16().toString('utf16le');
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    // Windows-1250 (Central/Eastern Europe — Czech, Polish, Hungarian...) is
    // the common non-UTF-8 case here and, being a single-byte encoding,
    // decodes every byte to something rather than failing a second time.
    return iconv.decode(buffer, 'win1250');
  }
}

module.exports = { decodeText };
