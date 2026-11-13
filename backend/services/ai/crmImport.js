/**
 * CRM import — read a document, get contacts.
 *
 * HOW THIS ACTUALLY WORKS, AND WHY THERE IS NO PARSER
 * ===========================================================================
 * The first version of this file was a CSV parser, a delimiter sniffer, a
 * column mapper and a mode detector — about four hundred lines of machinery
 * for turning a file into a grid, plus a model call to name the columns.
 *
 * It is all gone, because it was solving a problem that no longer exists.
 *
 * What ChatGPT and Claude do when you attach a document is not clever. They
 * convert it to text and put that text in the context window. The model reads
 * all of it. There is no embedding step, no vector index, no chunk retrieval —
 * those belong to RAG, which exists for corpora too large to fit in context,
 * and a retriever's job is to DROP everything below a similarity floor. That is
 * right for answering a question over ten thousand documents and exactly wrong
 * for importing one file, where a row silently skipped is a contact lost.
 *
 * So: text in, contacts out. A CSV is text. A PDF is text once extracted. An
 * email is text. The model reads the whole thing and returns the people in it,
 * and it understands a name split oddly across two columns, a job title buried
 * in a notes field, and "met their head of procurement on Tuesday" — none of
 * which a column mapper could ever reach.
 *
 * WHAT REPLACES THE GUARANTEES THE PARSER GAVE
 * ===========================================================================
 * A parser cannot invent a row and cannot skip one. A model can do both, so
 * three things carry that weight instead, and none of them is a disclaimer:
 *
 *   Source quoting  Every contact carries the span of text it came from,
 *                   copied not paraphrased, and the review screen shows it.
 *                   A row whose quote is not found in the file is flagged.
 *                   This is the only verification that scales past ten rows.
 *
 *   Full coverage   Files too large for one call are cut into overlapping
 *                   windows and EVERY window is read, in order. Sequential,
 *                   not retrieved — so there is no similarity threshold that
 *                   could quietly drop somebody.
 *
 *   The gate        Nothing is written until a person approves it. Same as
 *                   customerPoIntake.js, and here it is doing more work.
 *
 * PICTURES
 * ===========================================================================
 * A photograph of a business card, a screenshot of an attendee list, a scanned
 * PDF — these are the most natural way anyone actually captures a contact, and
 * they have no text in them at all. So they go to the model as images, which is
 * what ChatGPT and Claude do with an attached picture: no OCR pass, the model
 * looks at the pixels.
 *
 * A scanned PDF is the same problem wearing a document's clothes. When text
 * extraction comes back empty the pages are rasterised and sent as images,
 * rather than telling somebody to go and find an OCR tool.
 */

const {
  getAIClient, AI_MODEL_RESOLVED, AI_PROVIDER, isAIEnabled,
} = require('../../config/aiConfig');
const { pool } = require('../../config/database');
const { decodeText } = require('./textEncoding');

/** Characters per window. Comfortably inside any current model's context, and
 *  small enough that the model attends to the end of it as well as the start. */
const WINDOW = 18000;
/** Carried between windows so a person split across the boundary is seen whole. */
const OVERLAP = 1200;
/** Above this a file is a data migration, not an import. */
const MAX_PEOPLE = 500;
const MAX_CHARS = 400000;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/* --------------------------------------------------------------- the prompt */

const PROMPT = `You read people out of a document and return them as CRM contacts.

The document may be a spreadsheet export, a PDF, an email thread, meeting notes, a signature block, an attendee list, or anything else. Do not assume a shape. Read it, work out who the people are, and return ONLY a JSON object:

{
  "people": [
    {
      "first_name": "", "last_name": "", "email": "", "phone": "",
      "job_title": "", "company_name": "", "notes": "",
      "source": "the shortest span of the ORIGINAL text this person came from, copied exactly",
      "confidence": 0-100
    }
  ],
  "notes": "one sentence for the person reviewing this, or an empty string"
}

READ FOR MEANING, NOT FOR POSITION
- If the document has columns, use them — but do not stop at them. A job title sitting inside a notes column belongs in job_title. A cell holding "Jane Smith (Head of Procurement, Acme)" is three fields, not one.
- Names arrive in every arrangement: "Smith, Jane", "Jane Smith", "J. Smith", "van den Berg, Pieter". Put the given name in first_name and the family name in last_name whichever way round the document wrote them.
- A title, a company or a phone number is often in the surrounding sentence rather than beside the name. Read the sentence.
- "n/a", "-", "none", "unknown", "TBC" and empty quotes all mean the field is empty. Never write those through as values.
- Phone numbers keep their formatting. Do not normalise them.

RULES THAT MATTER MORE THAN COVERAGE
- Never invent a field. If the document does not give an email, leave it empty. An empty field costs the reviewer nothing; a plausible invented one gets written into the customer database and is never questioned again.
- "source" must be text that genuinely appears in the input, copied not paraphrased. It is what the reviewer checks the row against, so a paraphrase removes their only means of checking.
- Only people. Not companies on their own, not products, not "Dear Sir", not the author of a form letter, not names in a legal boilerplate footer.
- The same person mentioned several times is ONE entry. Merge what each mention adds.
- confidence is per person: how sure you are this is a real contact AND that the fields belong to them rather than to a neighbour.
- No people in the document is a valid answer. Return an empty list rather than reaching.`;

/* ---------------------------------------------------------------- windowing */

/**
 * Cut long text into overlapping windows, on line boundaries.
 *
 * Sequential and exhaustive, which is the whole point: every window is read.
 * A vector index would be the wrong instrument here — its job is to return the
 * best few chunks and discard the rest, and discarding is precisely the failure
 * this has to avoid.
 *
 * Splitting on newlines rather than at a character count keeps a row of a
 * spreadsheet intact, and the overlap means a person straddling a boundary is
 * seen whole by at least one window.
 */
function windows(text) {
  if (text.length <= WINDOW) return [text];

  const out = [];
  let at = 0;
  while (at < text.length) {
    let end = Math.min(at + WINDOW, text.length);
    if (end < text.length) {
      const br = text.lastIndexOf('\n', end);
      if (br > at + WINDOW / 2) end = br + 1;
    }
    out.push(text.slice(at, end));
    if (end >= text.length) break;
    at = Math.max(end - OVERLAP, at + 1);
  }
  return out;
}

/* ------------------------------------------------------------------ images */

const IMAGE_TYPES = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' };
/** Pages rasterised from a scanned PDF. Beyond this it is a scanning job. */
const MAX_PAGES = 12;

/**
 * Turn a picture into the content block the model reads.
 *
 * OpenAI-compatible shape, which covers the OpenAI provider and every service
 * that speaks its API — DeepSeek among them. The Anthropic path is a different
 * shape and anthropicAdapter.js currently states that user content is always a
 * string, so vision is refused there rather than silently sending something
 * that will be dropped on the way through.
 */
function imageBlock(dataUrl) {
  return { type: 'image_url', image_url: { url: dataUrl, detail: 'high' } };
}

function visionAvailable() {
  return AI_PROVIDER !== 'anthropic';
}

/**
 * Rasterise a PDF that has no text in it.
 *
 * A scan is a picture of a document. Refusing it and asking for OCR pushes the
 * work onto the person holding the only copy, when the model can already read
 * a page it can see.
 */
async function pdfToImages(buffer) {
  const { PDFParse } = require('pdf-parse');
  const parser = new PDFParse({ data: new Uint8Array(buffer) });
  try {
    const info = await parser.getInfo();
    const total = Math.min(info?.total || info?.numPages || 1, MAX_PAGES);
    const pages = Array.from({ length: total }, (_, i) => i + 1);
    const shot = await parser.getScreenshot({ pages, scale: 2 });
    return (shot?.pages || []).map((p) => p.dataUrl).filter(Boolean);
  } finally {
    await parser.destroy();
  }
}

/**
 * Read people out of pictures.
 *
 * One call per image rather than all of them at once: a model given twelve
 * pages tends to summarise, and a page whose contacts were summarised away is
 * a page of contacts lost. Same merging as the text path.
 */
async function readImages(images) {
  const client = getAIClient();
  const merged = new Map();
  const notes = [];
  let truncated = false;

  for (const dataUrl of images) {
    const response = await client.chat.completions.create({
      model: AI_MODEL_RESOLVED,
      messages: [
        { role: 'system', content: PROMPT },
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: 'Read every person visible in this image. For "source", quote the text you '
                + 'can actually see next to them — a name plate, a signature block, a row of a '
                + 'table — so a reviewer can find it on the page.',
            },
            imageBlock(dataUrl),
          ],
        },
      ],
      temperature: 0.1,
      max_tokens: 6000,
      response_format: { type: 'json_object' },
    });

    const parsed = JSON.parse(response.choices?.[0]?.message?.content || '{}');
    if (typeof parsed.notes === 'string' && parsed.notes.trim()) notes.push(parsed.notes.trim());

    for (const raw of Array.isArray(parsed.people) ? parsed.people : []) {
      // No source text to check a quote against on an image, so grounding is
      // skipped here rather than flagging every row. The picture is the
      // evidence, and the reviewer has it.
      const person = cleanPerson(raw, null, merged.size);
      if (!person.first_name && !person.last_name && !person.email) continue;

      const key = identity(person);
      const seen = merged.get(key);
      if (!seen) { merged.set(key, person); continue; }
      for (const f of ['email', 'phone', 'job_title', 'company_name', 'notes', 'source']) {
        if (!seen[f] && person[f]) seen[f] = person[f];
      }
      seen.confidence = Math.max(seen.confidence, person.confidence);
    }

    if (merged.size >= MAX_PEOPLE) { truncated = true; break; }
  }

  return {
    people: [...merged.values()].map((p, i) => ({ ...p, line: i + 1 })),
    notes: [...new Set(notes)].join(' '),
    truncated,
  };
}

/* --------------------------------------------------------------- extraction */

function cleanPerson(p, text, index) {
  const str = (v) => String(v ?? '').trim();
  const blank = new Set(['n/a', 'na', '-', '--', 'none', 'null', 'unknown', 'tbc', 'tbd', '?']);
  const field = (v) => {
    const s = str(v);
    return blank.has(s.toLowerCase()) ? '' : s;
  };

  const readFirst = field(p.first_name);
  const readLast = field(p.last_name);
  const email = field(p.email);
  const companyName = field(p.company_name);
  const problems = [];

  // A row with an email, a company, a phone number — real information — but
  // no person's name should still be reviewable and importable, not rejected
  // outright: "no name" used to flag the whole row invalid, which silently
  // dropped every row of a supplier/company list (name-less by nature, one
  // email or phone per organisation) from an import that had nothing else
  // wrong with it. contacts.first_name is NOT NULL regardless, so something
  // has to go there — the company this row is actually about is a real name
  // for the lead, not a placeholder, so it takes priority; "Not specified"
  // is the last resort, when the row does not even give a company.
  const first = readFirst || readLast ? readFirst : (companyName || 'Not specified');
  const last = readLast;
  if (email && !EMAIL_RE.test(email)) problems.push(`"${email}" is not a valid email address.`);

  // The quote has to be text that is actually in the document. A model that
  // paraphrases here has taken away the reviewer's only means of checking the
  // row, so it is flagged rather than quietly trusted.
  //
  // Skipped when there is no source text — an image has none, and flagging
  // every row read from a photograph would make the warning meaningless.
  const source = field(p.source);
  if (text && source && !text.includes(source.slice(0, 40))) {
    problems.push('The quoted wording is not in the file — check this row against the original.');
  }

  return {
    line: index + 1,
    first_name: first,
    last_name: last,
    email: EMAIL_RE.test(email) ? email.toLowerCase() : '',
    phone: field(p.phone),
    job_title: field(p.job_title),
    company_name: companyName,
    notes: field(p.notes),
    source,
    confidence: Number(p.confidence) || 0,
    problems,
  };
}

/** The key a person is identified by, for merging across overlapping windows. */
const identity = (p) => (p.email
  ? `e:${p.email}`
  : `n:${p.first_name.toLowerCase()}|${p.last_name.toLowerCase()}`);

async function readPeople(text) {
  const client = getAIClient();
  const parts = windows(text);
  const merged = new Map();
  const notes = [];
  let truncated = false;

  for (const part of parts) {
    const response = await client.chat.completions.create({
      model: AI_MODEL_RESOLVED,
      messages: [
        { role: 'system', content: PROMPT },
        { role: 'user', content: part },
      ],
      temperature: 0.1,
      max_tokens: 8000,
      response_format: { type: 'json_object' },
    });

    const parsed = JSON.parse(response.choices?.[0]?.message?.content || '{}');
    if (typeof parsed.notes === 'string' && parsed.notes.trim()) notes.push(parsed.notes.trim());

    for (const raw of Array.isArray(parsed.people) ? parsed.people : []) {
      const person = cleanPerson(raw, text, merged.size);
      if (!person.first_name && !person.last_name && !person.email) continue;

      const key = identity(person);
      const seen = merged.get(key);
      if (!seen) {
        merged.set(key, person);
        continue;
      }
      // The overlap means one person can be read twice. Keep the fuller
      // reading rather than the first — a window that caught their job title
      // knows more than one that only caught their name.
      for (const f of ['email', 'phone', 'job_title', 'company_name', 'notes', 'source']) {
        if (!seen[f] && person[f]) seen[f] = person[f];
      }
      seen.confidence = Math.max(seen.confidence, person.confidence);
      seen.problems = person.problems.length < seen.problems.length ? person.problems : seen.problems;
    }

    // Stop reading, but remember that we did. Returning the first 500 of 900
    // as if they were the whole file is the exact failure this module exists to
    // avoid — the reviewer approves what looks complete and never learns that
    // 400 people were dropped.
    if (merged.size >= MAX_PEOPLE) {
      truncated = true;
      break;
    }
  }

  // Renumber after merging so the review list reads 1..n.
  const people = [...merged.values()].map((p, i) => ({ ...p, line: i + 1 }));

  return { people, notes: [...new Set(notes)].join(' '), truncated };
}

/* ------------------------------------------------------------ duplicates */

/**
 * Match the batch against contacts that already exist, and against itself.
 *
 * Two queries rather than two per row. Exact on email, then trigram similarity
 * on the name — because the second record is always slightly different, and
 * "Jane Smyth" against "Jane Smith" is exactly the case an equality check
 * cannot see. pg_trgm is what duplicateDetection.js uses for suppliers and
 * customers for the same reason; this is the contact-shaped version of it.
 */
async function findDuplicates(rows) {
  const emails = [...new Set(rows.map((r) => r.email).filter(Boolean))];
  const names = [...new Set(
    rows.filter((r) => r.last_name || r.first_name)
      .map((r) => `${r.first_name} ${r.last_name}`.trim().toLowerCase()),
  )];

  const byEmail = new Map();
  const nameHits = [];

  if (emails.length) {
    const { rows: hits } = await pool.query(
      `SELECT id, first_name, last_name, email FROM contacts
        WHERE deleted_at IS NULL AND LOWER(email) = ANY($1::text[])`,
      [emails],
    );
    for (const h of hits) byEmail.set((h.email || '').toLowerCase(), h);
  }

  if (names.length) {
    try {
      const { rows: hits } = await pool.query(
        `SELECT DISTINCT ON (n.needle) n.needle, c.id, c.first_name, c.last_name, c.email,
                similarity(LOWER(c.first_name || ' ' || COALESCE(c.last_name, '')), n.needle) AS score
           FROM unnest($1::text[]) AS n(needle)
           JOIN contacts c
             ON c.deleted_at IS NULL
            AND LOWER(c.first_name || ' ' || COALESCE(c.last_name, '')) % n.needle
          ORDER BY n.needle, score DESC`,
        [names],
      );
      nameHits.push(...hits);
    } catch {
      // pg_trgm may not be installed on every deployment. Fall back to exact
      // matching rather than failing the import — a missed near-duplicate is a
      // reviewable row, a thrown error is a dead screen.
      const { rows: hits } = await pool.query(
        `SELECT LOWER(first_name || ' ' || COALESCE(last_name, '')) AS needle,
                id, first_name, last_name, email, 1.0 AS score
           FROM contacts
          WHERE deleted_at IS NULL
            AND LOWER(first_name || ' ' || COALESCE(last_name, '')) = ANY($1::text[])`,
        [names],
      );
      nameHits.push(...hits);
    }
  }

  const byName = new Map(nameHits.map((h) => [h.needle, h]));
  const seenInFile = new Map();

  return rows.map((r) => {
    if (r.problems.length) return { ...r, status: 'invalid', existing: null };

    const key = identity(r);
    if (seenInFile.has(key)) {
      return {
        ...r,
        status: 'duplicate',
        existing: null,
        problems: [`Also read at row ${seenInFile.get(key)} of this file.`],
      };
    }
    seenInFile.set(key, r.line);

    const existing = (r.email && byEmail.get(r.email))
      || byName.get(`${r.first_name} ${r.last_name}`.trim().toLowerCase())
      || null;

    return existing
      ? { ...r, status: 'duplicate', existing, match: existing.score ? Number(existing.score) : 1 }
      : { ...r, status: 'new', existing: null };
  });
}

/* ------------------------------------------------------------------ public */

/** Everything we can turn into text. */
async function toText(buffer, fileName) {
  const name = String(fileName || '').toLowerCase();
  const ext = name.split('.').pop();

  if (IMAGE_TYPES[ext]) {
    if (!visionAvailable()) {
      return {
        ok: false,
        error: 'Images cannot be read on this installation — the Anthropic adapter passes user '
          + 'content through as a string. Switch AI_PROVIDER to an OpenAI-compatible service, '
          + 'or upload a text file.',
      };
    }
    return {
      ok: true,
      images: [`data:${IMAGE_TYPES[ext]};base64,${buffer.toString('base64')}`],
    };
  }

  if (/\.(xlsx|xls|numbers|ods)$/.test(name)) {
    return {
      ok: false,
      error: 'Spreadsheet files are not supported yet — their contents are compressed XML rather '
        + 'than text. Export the sheet as CSV and upload that.',
    };
  }

  if (name.endsWith('.pdf')) {
    try {
      const { PDFParse } = require('pdf-parse');
      const parser = new PDFParse({ data: new Uint8Array(buffer) });
      let text = '';
      try {
        text = (await parser.getText()).text || '';
      } finally {
        await parser.destroy();
      }

      // pdf-parse writes its own "-- 1 of 3 --" separator between pages, so a
      // scan with no text at all still comes back non-empty. Testing
      // text.trim() therefore sends every scanned document down the text path,
      // where it finds nothing and reports that the file has no people in it —
      // which is true of the extracted string and useless to the person who
      // can plainly see a page of contacts.
      const real = text.replace(/^\s*--\s*\d+\s+of\s+\d+\s*--\s*$/gm, '').trim();
      if (real) return { ok: true, text };

      // No text means a scan: a picture of a document. Read the pages as
      // pictures rather than sending somebody off to find an OCR tool.
      if (!visionAvailable()) {
        return {
          ok: false,
          error: 'This PDF holds no text — it is a scan. Reading it needs an image-capable '
            + 'model, and the Anthropic adapter cannot carry images yet.',
        };
      }
      const images = await pdfToImages(buffer);
      if (!images.length) {
        return { ok: false, error: 'This PDF holds no text and its pages could not be rendered.' };
      }
      return { ok: true, images, scanned: true };
    } catch (err) {
      return { ok: false, error: `This PDF could not be read: ${err.message}` };
    }
  }

  return { ok: true, text: decodeText(buffer) };
}

/**
 * Read a file and propose the contacts in it. Writes nothing.
 */
async function analyse(buffer, fileName) {
  if (!isAIEnabled()) {
    return {
      ok: false,
      error: 'AI is not configured on this installation, so documents cannot be read. '
        + 'Contacts can still be created individually.',
    };
  }

  const extracted = await toText(buffer, fileName);
  if (!extracted.ok) return extracted;

  // ---- pictures ------------------------------------------------------------
  if (extracted.images) {
    let seen;
    try {
      seen = await readImages(extracted.images);
    } catch (err) {
      console.error('CRM import vision error:', err.message);
      return { ok: false, error: `The image could not be read: ${err.message}` };
    }
    if (seen.truncated) {
      return {
        ok: false,
        error: `This file holds more than ${MAX_PEOPLE} people. Split it and run it again.`,
      };
    }
    if (!seen.people.length) {
      return {
        ok: false,
        error: 'No people could be read from this image. A photograph of a card or a list '
          + 'works; a blurred or very small one may not.',
      };
    }
    const picked = await findDuplicates(seen.people);
    return {
      ok: true,
      source: extracted.scanned ? 'scanned pdf' : 'image',
      file: {
        name: fileName,
        chars: 0,
        windows: extracted.images.length,
        pages: extracted.images.length,
      },
      confidence: Math.min(...picked.map((r) => r.confidence || 0)),
      notes: seen.notes,
      summary: {
        total: picked.length,
        new: picked.filter((r) => r.status === 'new').length,
        duplicate: picked.filter((r) => r.status === 'duplicate').length,
        invalid: picked.filter((r) => r.status === 'invalid').length,
      },
      rows: picked,
    };
  }

  // ---- text ----------------------------------------------------------------
  const text = extracted.text;
  if (!text.trim()) {
    return { ok: false, error: 'No text could be read from this file.' };
  }
  if (text.length > MAX_CHARS) {
    return {
      ok: false,
      error: `This file is ${Math.round(text.length / 1000)}k characters. The import reads up to `
        + `${MAX_CHARS / 1000}k at a time — split it, or talk to us about a migration.`,
    };
  }

  let read;
  try {
    read = await readPeople(text);
  } catch (err) {
    console.error('CRM import read error:', err.message);
    return { ok: false, error: `The document could not be read: ${err.message}` };
  }

  if (read.truncated) {
    return {
      ok: false,
      error: `This file holds more than ${MAX_PEOPLE} people. The import reads up to that many `
        + 'at a time, and importing part of a file without saying so is how half a contact '
        + 'database goes missing — split it and run it again.',
    };
  }

  if (!read.people.length) {
    return {
      ok: false,
      error: 'No people could be found in this file. It reads contact lists, emails, notes and '
        + 'PDFs — but there has to be somebody in it.',
    };
  }

  const rows = await findDuplicates(read.people);

  return {
    ok: true,
    source: 'text',
    file: { name: fileName, chars: text.length, windows: windows(text).length },
    // The weakest row, not the average. One row read badly is one wrong
    // contact, and an average is precisely what hides it.
    confidence: Math.min(...rows.map((r) => r.confidence || 0)),
    notes: read.notes,
    summary: {
      total: rows.length,
      new: rows.filter((r) => r.status === 'new').length,
      duplicate: rows.filter((r) => r.status === 'duplicate').length,
      invalid: rows.filter((r) => r.status === 'invalid').length,
    },
    rows,
  };
}

/**
 * Write the contacts a person approved.
 *
 * Takes the reviewed rows from the client rather than re-reading the file, so
 * records are created from what somebody confirmed rather than from what was
 * extracted. An edit in the review table is a real edit; a row deselected there
 * is genuinely not written.
 */
async function commit(rows, userId, { link_company = true } = {}) {
  if (!Array.isArray(rows) || !rows.length) throw new Error('No rows were submitted.');

  const created = [];
  const failed = [];

  // One transaction. A partial import is the worst outcome, because nobody can
  // tell which half of the file made it in.
  //
  // The INSERT is written here rather than through Contacts.create, and that is
  // not duplication for its own sake — the model uses the shared pool, so it
  // would take a DIFFERENT connection and its writes would sit outside this
  // transaction entirely. A rollback would then leave every contact in place
  // while reporting that nothing was imported.
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    for (const row of rows) {
      try {
        // contacts.first_name is NOT NULL, but a document can legitimately give
        // only a surname. Promote it rather than failing the import over it.
        const first = (row.first_name || '').trim() || (row.last_name || '').trim();
        const last = (row.first_name || '').trim() ? (row.last_name || '').trim() : '';
        if (!first) throw new Error('A contact needs at least one name.');

        let customerId = row.customer_id || null;
        if (!customerId && link_company && row.company_name) {
          // Attach to an existing customer when the name matches. Never create
          // one — a customer is a commercial record with its own terms,
          // currency and credit limit, and inventing one is not this import's
          // business.
          const { rows: hit } = await client.query(
            `SELECT id FROM customers
              WHERE deleted_at IS NULL AND LOWER(customer_name) = LOWER($1) LIMIT 1`,
            [row.company_name],
          );
          if (hit.length) customerId = hit[0].id;
        }

        // An unmatched company is kept on the contact rather than dropped. It is
        // the most useful field in one of these files, and losing it silently is
        // how an import becomes a re-import.
        const notes = [
          row.notes,
          !customerId && row.company_name ? `Company: ${row.company_name}` : '',
        ].filter(Boolean).join('\n') || null;

        const { rows: [contact] } = await client.query(
          `INSERT INTO contacts
             (first_name, last_name, email, phone, job_title, customer_id, owner_id, notes, created_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
           RETURNING id`,
          [
            first, last || null, row.email || null, row.phone || null,
            row.job_title || null, customerId, row.owner_id || userId, notes, userId,
          ],
        );

        created.push({ line: row.line, id: contact.id });
      } catch (err) {
        failed.push({ line: row.line, error: err.message });
      }
    }

    if (failed.length) {
      await client.query('ROLLBACK');
      return {
        ok: false,
        created: [],
        failed,
        message: `Nothing was imported. ${failed.length} row(s) could not be created, and a `
          + 'half-finished import is worse than none — fix these and run it again.',
      };
    }

    await client.query('COMMIT');
    return { ok: true, created, failed: [] };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

module.exports = {
  analyse, commit, readPeople, readImages, findDuplicates, windows, cleanPerson,
  identity, toText, pdfToImages, visionAvailable,
  IMAGE_TYPES, MAX_PEOPLE, MAX_CHARS, MAX_PAGES, WINDOW,
};
