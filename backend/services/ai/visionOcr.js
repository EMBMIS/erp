/**
 * OCR for scanned documents and photos, via a vision model.
 *
 * A photo of a passport, a scanned form, a handwritten note — classical OCR
 * engines choke on these; a modern vision model reads them the way a person
 * does. The ERP already talks to an OpenAI-compatible endpoint, and the vision
 * model (AI_VISION_MODEL, default deepseek-v4-flash-vision-exp) is a model on
 * that same endpoint — so this adds no new key, infrastructure, or native
 * dependency (no canvas, no tesseract binaries).
 *
 * Two jobs:
 *   • ocrImageBuffer — transcribe one image (PNG/JPEG) to text.
 *   • ocrPdfPages — for a PDF's text-less pages, extract the embedded page
 *     images with pdfjs (raw pixels, wrapped to PNG in pure Node) and
 *     transcribe each.
 *
 * Failures never throw into the upload. OCR is best-effort: a page that
 * cannot be read is reported as unread rather than failing the file, and a
 * vision call that errors (model unavailable, outage, rate limit) degrades to
 * the same honest "could not be read" note the pipeline already writes.
 */

const zlib = require('zlib');

// Sourced from config/aiConfig.js rather than re-reading process.env here —
// that's the one place the default already accounts for AI_PROVIDER (a free
// OpenRouter vision model when AI_PROVIDER=openrouter and this is unset,
// deepseek-v4-flash-vision-exp otherwise). Re-deriving it locally silently
// dropped the OpenRouter default the moment this constant was written.
const VISION_MODEL = require('../../config/aiConfig').AI_VISION_MODEL;
/** Bounding OCR cost and upload time on multi-page scans. */
const MAX_OCR_PAGES = Number(process.env.AI_VISION_MAX_PAGES || 8);

// ---------------------------------------------------------------------------
// Image → text
// ---------------------------------------------------------------------------

/** MIME from magic bytes; defaults to PNG because raw pixels are wrapped to PNG. */
function sniffMime(buffer) {
  if (!buffer || buffer.length < 4) return 'image/png';
  const b = buffer;
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
  if (b[0] === 0xff && b[1] === 0xd8) return 'image/jpeg';
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46) return 'image/webp';
  return 'image/png';
}

/**
 * Transcribe one image to text with the vision model.
 * @returns {Promise<string|null>} trimmed text, or null when the image has no
 *          readable text or the vision call failed.
 */
async function ocrImageBuffer(buffer) {
  if (!buffer || !buffer.length) return null;
  const { getAIClient } = require('../../config/aiConfig');
  const modelRouter = require('./modelRouter');
  try {
    const client = getAIClient();
    // withFallback: on OpenRouter, falls through the ranked free vision
    // models if VISION_MODEL is rate-limited or unavailable — see
    // modelRouter.js. A single attempt on any other provider.
    const { value: response } = await modelRouter.withFallback('vision', (model, clientOverride) =>
      (clientOverride || client).chat.completions.create({
        model,
        messages: [{
          role: 'user',
          content: [
            {
              type: 'text',
              text: 'Transcribe ALL text in this image exactly as written — every letter, number, and line break. '
                + 'This is likely a document, form, or ID. Preserve layout order (top to bottom, left to right). '
                + 'If there is no readable text in the image, reply with exactly NO_TEXT.',
            },
            { type: 'image_url', image_url: { url: `data:${sniffMime(buffer)};base64,${buffer.toString('base64')}` } },
          ],
        }],
        max_tokens: 1500,
      }),
    VISION_MODEL);
    const text = String(response.choices?.[0]?.message?.content || '').trim();
    if (!text || /^NO_TEXT$/i.test(text)) return null;
    return text;
  } catch (err) {
    console.error('Vision OCR failed:', err.message);
    return null;
  }
}

// ---------------------------------------------------------------------------
// PDF page images → PNG (no native canvas: pdfjs raw pixels, wrapped with zlib)
// ---------------------------------------------------------------------------

// Standard PNG CRC-32, so the hand-built chunks are valid PNGs.
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Encode raw RGB(A)/grayscale pixels into a PNG. colorType: 6 RGBA, 2 RGB, 0 gray. */
function pixelsToPng(width, height, bytes, colorType) {
  const bpp = colorType === 6 ? 4 : colorType === 2 ? 3 : 1;
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = colorType;
  const stride = width * bpp;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    bytes.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  return Buffer.concat([
    PNG_SIG,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

// pdfjs ImageKind constants (values are stable across pdfjs versions).
const KIND_GRAY_1BPP = 1;
const KIND_RGB = 2;
const KIND_RGBA = 3;

/** Turn an extracted pdfjs image object into a PNG/JPEG buffer the vision model accepts. */
function toReadableImage({ width, height, kind, bytes }) {
  if (!bytes || !width || !height) return null;
  const jpeg = bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8;
  const png = bytes.length > 8 && bytes[0] === 0x89 && bytes[1] === 0x50;
  if (jpeg || png) return bytes;
  if (kind === KIND_RGBA && bytes.length === width * height * 4) return pixelsToPng(width, height, bytes, 6);
  if (kind === KIND_RGB && bytes.length === width * height * 3) return pixelsToPng(width, height, bytes, 2);
  if (kind === KIND_GRAY_1BPP) {
    // 1 bit per pixel, packed MSB-first. Expand to grayscale (8-bit) so the
    // vision model sees a normal image rather than raw bilevel data.
    const gray = Buffer.alloc(width * height);
    for (let i = 0; i < width * height; i++) {
      const byte = bytes[i >> 3];
      gray[i] = (byte >> (7 - (i & 7))) & 1 ? 0 : 255;
    }
    return pixelsToPng(width, height, gray, 0);
  }
  return null;
}

let _pdfjsPromise = null;
function pdfjs() {
  if (!_pdfjsPromise) {
    // ESM-only build; Node 20 loads it via dynamic import. Resolved once and
    // cached for the life of the process.
    _pdfjsPromise = import('pdfjs-dist/legacy/build/pdf.mjs').catch((err) => {
      _pdfjsPromise = null;
      throw err;
    });
  }
  return _pdfjsPromise;
}

/**
 * Extract the page images from a PDF for the given page numbers. Returns the
 * largest usable image per page (a scan is a full-page image; logos and icons
 * are filtered out by size). Raw pixel data is wrapped into PNG in-process.
 */
async function extractPageImages(pdfBuffer, pageNumbers) {
  let doc = null;
  try {
    const pdfjsMod = await pdfjs();
    doc = await pdfjsMod.getDocument({ data: new Uint8Array(pdfBuffer) }).promise;
    const out = [];
    for (const pageNumber of pageNumbers) {
      let page = null;
      try {
        page = await doc.getPage(pageNumber);
        const ops = await page.getOperatorList();
        let best = null;
        for (let i = 0; i < ops.fnArray.length; i++) {
          if (ops.fnArray[i] !== pdfjsMod.OPS.paintImageXObject && ops.fnArray[i] !== pdfjsMod.OPS.paintInlineImageXObject) continue;
          const name = ops.argsArray[i][0];
          const img = await new Promise((res, rej) => page.objs.get(name, (d) => (d ? res(d) : rej(new Error('missing image object'))))).catch(() => null);
          if (!img || !img.data) continue;
          const width = img.width || 0;
          const height = img.height || 0;
          if (width < 160 || height < 160) continue; // logos/icons are not the scan
          const bytes = Buffer.from(img.data);
          const size = width * height;
          if (!best || size > best.size) best = { width, height, kind: img.kind, bytes, size };
        }
        if (best) {
          const buffer = toReadableImage(best);
          if (buffer) out.push({ pageNumber, buffer });
        }
      } catch (err) {
        console.error(`Vision OCR: page ${pageNumber} image extraction failed:`, err.message);
      } finally {
        if (page && typeof page.cleanup === 'function') page.cleanup();
      }
    }
    return out;
  } finally {
    if (doc && typeof doc.destroy === 'function') await doc.destroy();
  }
}

// ---------------------------------------------------------------------------
// PDF text-less pages → appended OCR text
// ---------------------------------------------------------------------------

/**
 * OCR a PDF's text-less pages and produce the extra text + a closing note.
 *
 * @param {{pdfBuffer: Buffer, text: string, totalPages: number,
 *          textLessPages: number[], textPages: number}} input
 * @returns {{text: string, note: string}} `text` has "[OCR of page N:]"
 *          blocks appended; `note` explains anything still unread.
 */
async function appendPdfOcr({ pdfBuffer, text, totalPages, textLessPages, textPages }) {
  const pages = [...textLessPages].sort((a, b) => a - b);
  if (!pages.length) return { text, note: '' };

  const targets = pages.slice(0, MAX_OCR_PAGES);
  const skipped = pages.slice(MAX_OCR_PAGES);
  const extracted = await extractPageImages(pdfBuffer, targets);
  const byPage = new Map(extracted.map((e) => [e.pageNumber, e.buffer]));

  const blocks = [];
  const unread = [];
  for (const pageNumber of targets) {
    const buffer = byPage.get(pageNumber);
    if (!buffer) { unread.push(pageNumber); continue; }
    const pageText = await ocrImageBuffer(buffer);
    if (pageText) blocks.push(`[OCR of page ${pageNumber}:]\n${pageText}`);
    else unread.push(pageNumber);
  }

  const appended = blocks.length ? `\n\n${blocks.join('\n\n')}` : '';
  const reasons = [];
  if (unread.length) reasons.push(`no readable text on page${unread.length > 1 ? 's' : ''} ${unread.join(', ')}`);
  if (skipped.length) reasons.push(`${skipped.length} page${skipped.length > 1 ? 's' : ''} not processed (OCR page limit)`);

  let note = '';
  if (reasons.length) {
    if (!blocks.length) {
      note = `\n\n[Note: this PDF has ${totalPages} page${totalPages === 1 ? '' : 's'}, but text was found only on ${textPages}. `
        + `OCR was attempted on the rest and ${reasons.join('; ')}.`
        + `${blocks.length ? '' : ' The scanned pages could not be transcribed.'}]`;
    } else {
      note = `\n\n[Note: ${reasons.join('; ')}.]`;
    }
  }
  return { text: text + appended, note };
}

module.exports = { ocrImageBuffer, appendPdfOcr, extractPageImages, sniffMime, VISION_MODEL, MAX_OCR_PAGES };
