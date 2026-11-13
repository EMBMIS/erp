# Translation task — EMBMIS ERP user interface (complete set)

Copy everything below the line into the worker's first message.

---

## Your task

You are translating the user interface of **EMBMIS ERP**, an enterprise resource
planning system used by accountants, warehouse staff, buyers and salespeople.

Repository: `frontend/`. Working folder: `frontend/i18n-export/`.

**5,438 English strings** in 13 files, in two groups:

| Files | Count | What they are |
|---|---|---|
| `part-1-of-8.json` … `part-8-of-8.json` | 3,531 | Already wired to `t()` in the code. Translating these makes them appear immediately. |
| `remaining-1-of-5.json` … `remaining-5-of-5.json` | 1,907 | Still hardcoded in the source. Translate them the same way; a separate task wires them up. |

Every file is flat `key → English`:

```json
{
  "ui.inventoryItems": "Inventory Items",
  "ui2.saveAsDraft": "Save as Draft"
}
```

Translate all 5,438 into each of these **21 languages**:

`ar-SA` Arabic (RTL) · `az-AZ` Azerbaijani · `bn-BD` Bengali · `de-DE` German ·
`es-ES` Spanish · `fa-IR` Persian (RTL) · `fr-FR` French · `hi-IN` Hindi ·
`id-ID` Indonesian · `it-IT` Italian · `ja-JP` Japanese · `ko-KR` Korean ·
`nl-NL` Dutch · `pl-PL` Polish · `pt-BR` Portuguese (Brazil) · `ru-RU` Russian ·
`tr-TR` Turkish · `uk-UA` Ukrainian · `ur-PK` Urdu (RTL) · `vi-VN` Vietnamese ·
`zh-CN` Chinese (Simplified)

## Output layout

```
frontend/i18n-export/done/<locale>/<same-filename>.json
```

e.g. `frontend/i18n-export/done/ja-JP/part-1-of-8.json`. Same file names, same
keys, same order.

## Hard rules

1. **Translate the values. Never touch the keys.** A translated key silently
   breaks the lookup and the app falls back to English forever with nothing to
   notice.
2. **Preserve `{placeholders}` byte-for-byte** — `{count}`, `{name}`. They are
   substituted at runtime; changing one shows the user a literal `{count}`.
3. **These are UI labels, not prose.** Keep them about as short as the English —
   they sit in buttons, table headers and narrow columns. Sentence case. No
   trailing period unless the English has one.
4. **Watch for near-duplicates and keep them consistent.** The source contains
   both `"Saving…"` and `"Saving..."`, both `"Creating…"` and `"Creating..."`.
   Translate the words identically; keep the punctuation as it appears.
5. **Never leave a value in English.** Brand names (`EMBMIS ERP`), units (`kg`)
   and currency codes (`USD`) staying as-is is fine and expected. Passing a
   sentence through unchanged because it was hard is not.

## Terminology — the part that matters

Machine translation of ERP vocabulary fails *fluently*: the result reads
perfectly and means something else. Use the established term a professional in
that language uses at work, not the everyday word.

| English | It means | Not |
|---|---|---|
| **Debit** / **Credit** | the two sides of a double-entry journal line | a bank card / praise |
| **Post**, **Posted** | commit a journal entry to the ledger | publish, mail |
| **Entry** | a journal / accounting entry | entrance |
| **Balance** | an account balance | equilibrium |
| **Draft** | an unapproved document state | a sketch, a current of air |
| **Item** | a material or product master record | an object |
| **Order** | a purchase or sales document | a command, a sequence |
| **Goods receipt** | inbound goods booked against a purchase order | a till receipt |
| **Aging** | the receivables/payables age analysis report | growing old |
| **Close** (period) | the month/year-end accounting close | shutting |
| **Trial balance** | the standard accounting report | a test |
| **Requisition** | an internal request to purchase | a seizure |
| **Cost centre** | a controlling object | a building |
| **Fixed assets** | capitalised assets subject to depreciation | unmovable things |

Match the register of what already ships:

* `de` → **Bestellungen**, **Teilweise erhalten**
* `ja` → **発注書**, **一部受入**
* `ru` → **Заказы на закупку**, **Частично получено**
* `zh` → **采购订单**, **部分收货**

### Azerbaijani needs extra care

`az-AZ` is the one language where general-purpose translation reliably produces
Turkish-inflected or Russian-calqued wording, and the ERP vocabulary is exactly
where it goes wrong. Write it as an Azerbaijani speaker would for other
Azerbaijani speakers, flag anything uncertain, and have a native speaker review
before release.

## Loading your work back

From `frontend/`, per language:

```bash
node scripts/i18n-import.cjs ja-JP i18n-export/done/ja-JP
```

The importer validates before writing. It rejects the whole batch and prints
exactly what is wrong if a key does not exist in `en.json`, a `{placeholder}`
set changed, or a value is empty. It also reports values identical to the
English, and never overwrites an existing translation.

Note: the `ui2.*` keys from the `remaining-*` files are not in `en.json` yet.
Import those only after the wiring task has added them, or the importer will
correctly refuse them. Translate them now regardless — the text is final.

## When you are done

```bash
node scripts/i18n-coverage.cjs --keys   # per-locale completeness
node scripts/i18n-missing.cjs           # keys the app calls but nothing defines
npm run build:check                     # build + bundle budget
```

Plural forms are judged against each language's own CLDR categories — Japanese
needs only one form, Russian needs `one`/`few`/`many`. **Do not invent plural
variants a language does not use.**

## Scale, so you can plan

5,438 strings × 21 languages ≈ **114,000 translations**. Work one language
end-to-end before starting the next, and get a second opinion on the accounting
terms in the first language you finish — a systematic terminology error is far
cheaper to catch once than to fix twenty times.
