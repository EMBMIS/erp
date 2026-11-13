#!/usr/bin/env node
/**
 * Machine-translate the gaps in the locale catalogues.
 *
 * ===========================================================================
 * WHAT THIS IS AND IS NOT
 * ===========================================================================
 *
 * This fills MISSING keys. It never touches a key that already has a value, so
 * a hand-corrected translation cannot be silently overwritten by a later run,
 * and re-running after adding English strings only costs the new ones.
 *
 * It is a drafting tool, not a shipping decision. Machine translation of ERP
 * vocabulary fails in the most dangerous way available: fluently. "Credit" in
 * an accounting UI is the right-hand side of a journal entry, not a bank card
 * or a compliment; "Post" means commit to the ledger, not publish; "Draft"
 * is a document state, not a current of air. A translator that gets those
 * wrong produces a screen that reads perfectly and means something else — the
 * same failure mode as a hardcoded exchange rate. So:
 *
 *   • The glossary below pins the terms that actually carry money meaning.
 *   • Every key this tool writes is recorded in machine-translated.json, which
 *     is a review queue. Nothing here should reach a paying customer in a
 *     given language until a speaker of that language has read the queue.
 *
 * ===========================================================================
 * AZERBAIJANI IS DELIBERATELY EXCLUDED
 * ===========================================================================
 *
 * Not an oversight. Machine translation into Azerbaijani reliably produces
 * Turkish-inflected or Russian-calqued wording that reads as foreign to a
 * native speaker, and the ERP vocabulary is exactly where it goes wrong. az is
 * maintained by hand. Pass --include-az to override, and then read every line.
 *
 *   node scripts/i18n-translate.cjs                 # all locales except az
 *   node scripts/i18n-translate.cjs --locale ja-JP  # one locale
 *   node scripts/i18n-translate.cjs --dry-run       # report gaps, call nothing
 */

const fs = require('fs');
const path = require('path');

require('dotenv').config({ path: path.join(__dirname, '..', '..', 'backend', '.env') });

const LOCALES_DIR = path.join(__dirname, '..', 'src', 'i18n', 'locales');
const QUEUE_FILE = path.join(__dirname, '..', 'src', 'i18n', 'machine-translated.json');

const LANGUAGE_NAMES = {
  'ar-SA': 'Arabic', 'az-AZ': 'Azerbaijani', 'bn-BD': 'Bengali', 'de-DE': 'German',
  'es-ES': 'Spanish', 'fa-IR': 'Persian (Farsi)', 'fr-FR': 'French', 'hi-IN': 'Hindi',
  'id-ID': 'Indonesian', 'it-IT': 'Italian', 'ja-JP': 'Japanese', 'ko-KR': 'Korean',
  'nl-NL': 'Dutch', 'pl-PL': 'Polish', 'pt-BR': 'Portuguese (Brazil)', 'ru-RU': 'Russian',
  'tr-TR': 'Turkish', 'uk-UA': 'Ukrainian', 'ur-PK': 'Urdu', 'vi-VN': 'Vietnamese',
  'zh-CN': 'Chinese (Simplified)',
};

const GLOSSARY = `
Translate these with the ESTABLISHED ACCOUNTING/ERP term in the target
language, not the everyday word:

  Debit / Credit    the two sides of a double-entry journal line
  Post / Posted     commit a journal entry to the ledger (never "publish")
  Entry             a journal/accounting entry
  Balance           an account balance
  Trial balance     the standard accounting report
  Chart of accounts the account master list
  Draft             an unapproved document state
  Item              a material/product master record
  Order             a purchase or sales document
  Goods receipt     inbound goods against a purchase order
  Aging             the receivables/payables age analysis report
  Period close      the month/year-end accounting close
  Fixed assets      capitalised assets subject to depreciation
  Depreciation      the accounting write-down of a fixed asset
  Cost centre       a controlling object
  Requisition       an internal request to purchase
`.trim();

function flatten(obj, prefix = '', out = {}) {
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) flatten(v, key, out);
    else out[key] = v;
  }
  return out;
}

function setDeep(obj, dotted, value) {
  const parts = dotted.split('.');
  let node = obj;
  for (const p of parts.slice(0, -1)) {
    if (!node[p] || typeof node[p] !== 'object') node[p] = {};
    node = node[p];
  }
  node[parts[parts.length - 1]] = value;
}

const PLACEHOLDER = /\{(\w+)\}/g;
const placeholdersOf = (s) => (String(s).match(PLACEHOLDER) || []).sort().join(',');

// A key ending in a CLDR plural category belongs to a plural group. Those are
// translated as a unit, because the target language may need a different set of
// categories than English does.
const PLURAL_CATEGORY = /\.(zero|one|two|few|many|other)$/;

/**
 * The plural categories a language actually uses, straight from Intl.
 *
 * This is why a naive "fill every English key" pass is wrong. English
 * distinguishes one/other, so `rowCount.one` exists in en.json — but Japanese,
 * Chinese, Korean, Vietnamese and Indonesian have exactly one form, and
 * Intl.PluralRules will never select `one` for them. Writing a `one` variant
 * for those languages produces a string the runtime can never reach, and
 * implies a grammatical distinction the language does not make. Conversely
 * Russian needs `few` and `many`, which English has no key for at all.
 *
 * So the unit of work is the plural GROUP, and the categories are the target
 * language's, not English's.
 */
const categoriesFor = (locale) => {
  const rules = new Intl.PluralRules(locale);
  return new Set([0, 1, 2, 3, 5, 11, 21, 100, 1.5].map((n) => rules.select(n)));
};

// Which provider to talk to. Set TRANSLATION_PROVIDER=anthropic|openai to pin
// it. Otherwise Anthropic is tried first when a key exists and, if that key is
// rejected, the OpenAI-compatible endpoint is used instead — a stale key in
// .env should not silently produce 21 failed locales, which is exactly what
// happened the first time this ran.
let providerOverride = process.env.TRANSLATION_PROVIDER || null;

async function callModel(system, user) {
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  if (anthropicKey && providerOverride !== 'openai') {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': anthropicKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: process.env.TRANSLATION_MODEL || 'claude-sonnet-5',
        max_tokens: 8000,
        system,
        messages: [{ role: 'user', content: user }],
      }),
    });
    if (res.status === 401 || res.status === 403) {
      console.warn(`\n  ANTHROPIC_API_KEY rejected (${res.status}) — falling back to the OpenAI-compatible endpoint.`);
      providerOverride = 'openai';
      return callModel(system, user);
    }
    if (!res.ok) throw new Error(`Anthropic ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const body = await res.json();
    return body.content.map((b) => b.text || '').join('');
  }

  const base = process.env.OPENAI_BASE_URL;
  const key = process.env.OPENAI_API_KEY;
  if (!base || !key) throw new Error('No ANTHROPIC_API_KEY, and no OPENAI_BASE_URL/OPENAI_API_KEY to fall back to.');
  const res = await fetch(`${base.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model: process.env.TRANSLATION_MODEL || process.env.AI_MODEL || 'deepseek-chat',
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      temperature: 0,
    }),
  });
  if (!res.ok) {
    const detail = (await res.text()).slice(0, 300);
    // 401/403 (bad key) and 402 (no credit) will not fix themselves between
    // batches. Without this the tool cheerfully makes 692 doomed calls per
    // locale, twenty times over, and reports "FAILED" 13,840 times instead of
    // once — which is how the first full run was spent.
    if ([401, 402, 403].includes(res.status)) {
      const fatal = new Error(`Model ${res.status}: ${detail}`);
      fatal.fatal = true;
      throw fatal;
    }
    throw new Error(`Model ${res.status}: ${detail}`);
  }
  const body = await res.json();
  return body.choices[0].message.content;
}

function extractJson(text) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = fenced ? fenced[1] : text;
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end === -1) throw new Error('no JSON object in model reply');
  return JSON.parse(raw.slice(start, end + 1));
}

async function translateBatch(localeCode, entries) {
  const language = LANGUAGE_NAMES[localeCode] || localeCode;
  const system = [
    `You are translating the user interface of an enterprise resource planning (ERP) system into ${language}.`,
    '',
    'Rules:',
    '1. Reply with a single JSON object mapping each key to its translation. No prose, no code fence.',
    '2. Translate every key you are given. Do not add, drop or rename keys.',
    '3. Preserve {placeholders} exactly — same spelling, same braces. They are substituted at runtime.',
    '4. These are UI labels: keep them as short as the English, use sentence case, no trailing period unless the English has one.',
    '5. Use the terminology a professional accountant or warehouse manager in that language actually uses at work.',
    '',
    GLOSSARY,
  ].join('\n');

  const user = `Translate these UI strings into ${language}:\n\n${JSON.stringify(entries, null, 2)}`;
  const out = extractJson(await callModel(system, user));

  // Reject anything that came back structurally wrong rather than writing a
  // half-batch. A dropped key would silently fall back to English forever; a
  // mangled placeholder would render "{count}" as literal text to the user.
  const problems = [];
  for (const key of Object.keys(entries)) {
    if (!(key in out)) { problems.push(`${key}: missing from reply`); continue; }
    if (typeof out[key] !== 'string') { problems.push(`${key}: not a string`); continue; }
    if (placeholdersOf(entries[key]) !== placeholdersOf(out[key])) {
      problems.push(`${key}: placeholders changed (${placeholdersOf(entries[key])} -> ${placeholdersOf(out[key])})`);
    }
  }
  for (const key of Object.keys(out)) {
    if (!(key in entries)) problems.push(`${key}: invented key`);
  }
  if (problems.length) throw new Error(`batch rejected:\n    ${problems.join('\n    ')}`);
  return out;
}

async function main() {
  const argv = process.argv.slice(2);
  const dryRun = argv.includes('--dry-run');
  const includeAz = argv.includes('--include-az');
  const only = argv.includes('--locale') ? argv[argv.indexOf('--locale') + 1] : null;
  const batchSize = Number(process.env.I18N_BATCH || 40);

  const en = JSON.parse(fs.readFileSync(path.join(LOCALES_DIR, 'en.json'), 'utf8'));
  const enFlat = flatten(en);

  const queue = fs.existsSync(QUEUE_FILE) ? JSON.parse(fs.readFileSync(QUEUE_FILE, 'utf8')) : {};

  const files = fs.readdirSync(LOCALES_DIR).filter((f) => f.endsWith('.json') && f !== 'en.json');

  for (const file of files) {
    const short = file.replace('.json', '');
    const code = Object.keys(LANGUAGE_NAMES).find((c) => c.startsWith(`${short}-`)) || short;

    if (only && code !== only && short !== only) continue;
    if (short === 'az' && !includeAz) {
      console.log(`az     skipped — maintained by hand (--include-az to override)`);
      continue;
    }

    const target = JSON.parse(fs.readFileSync(path.join(LOCALES_DIR, file), 'utf8'));
    const targetFlat = flatten(target);
    const cats = categoriesFor(code);

    const missing = Object.keys(enFlat).filter((k) => {
      if (targetFlat[k] !== undefined) return false;
      const plural = k.match(PLURAL_CATEGORY);
      // Skip a plural form this language has no grammatical use for.
      return !plural || cats.has(plural[1]);
    });

    if (!missing.length) { console.log(`${short.padEnd(6)} complete`); continue; }
    if (dryRun) { console.log(`${short.padEnd(6)} ${missing.length} missing`); continue; }

    // Keep plural siblings in the same batch so the model sees the whole group.
    const groups = new Map();
    for (const k of missing) {
      const g = PLURAL_CATEGORY.test(k) ? k.replace(PLURAL_CATEGORY, '') : k;
      if (!groups.has(g)) groups.set(g, []);
      groups.get(g).push(k);
    }

    const batches = [];
    let current = [];
    for (const keys of groups.values()) {
      if (current.length + keys.length > batchSize && current.length) { batches.push(current); current = []; }
      current.push(...keys);
    }
    if (current.length) batches.push(current);

    // Flush after EVERY batch, not once per locale. A full catalogue is
    // thousands of keys across twenty languages — hours of calls — and a run
    // that dies two hours in must not throw away everything it had already
    // paid for. Because the tool only ever fills gaps, re-running simply
    // resumes from whatever is already on disk.
    let written = 0;
    let failed = 0;
    for (const [i, keys] of batches.entries()) {
      const entries = Object.fromEntries(keys.map((k) => [k, enFlat[k]]));
      process.stdout.write(`${short.padEnd(6)} batch ${String(i + 1).padStart(3)}/${batches.length} (${keys.length})… `);
      try {
        const result = await translateBatch(code, entries);
        for (const [k, v] of Object.entries(result)) setDeep(target, k, v);
        queue[short] = [...new Set([...(queue[short] || []), ...keys])];
        written += keys.length;
        fs.writeFileSync(path.join(LOCALES_DIR, file), JSON.stringify(target, null, 2) + '\n', 'utf8');
        fs.writeFileSync(QUEUE_FILE, JSON.stringify(queue, null, 2) + '\n', 'utf8');
        console.log('ok');
      } catch (err) {
        failed += 1;
        console.log(`FAILED — ${err.message.split('\n')[0]}`);
        if (err.fatal) {
          console.error(
            `\nStopping: the provider rejected the request in a way that retrying cannot fix.\n` +
            `Everything translated so far is already on disk — fix the credential or top up the\n` +
            `account, then re-run this command and it will resume from where it stopped.\n`
          );
          process.exit(1);
        }
      }
    }
    console.log(`${short.padEnd(6)} done: ${written} keys written${failed ? `, ${failed} batch(es) failed — re-run to retry` : ''}`);
  }

  if (!dryRun) {
    const pending = Object.entries(queue).reduce((n, [, ks]) => n + ks.length, 0);
    console.log(`\n${pending} machine-translated strings awaiting human review — see src/i18n/machine-translated.json`);
  }
}

main().catch((e) => { console.error(e.message); process.exit(1); });
