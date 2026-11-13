# Strings to translate

3531 strings, split into 8 files of up to 500.

## How to use

For EACH target language, translate every file in this folder and save the
result somewhere per-language, e.g.:

    i18n-export/done/ko-KR/part-1-of-8.json

Rules that matter:

  * Translate the VALUES only. Never change, translate or reorder the KEYS.
  * Keep {placeholders} exactly as they appear — {count}, {name}. They are
    substituted at runtime; changing one shows the user a literal "{count}".
  * These are UI labels. Keep them about as short as the English, sentence
    case, and use the terminology an accountant or warehouse manager in that
    language actually uses at work. "Credit" is the right-hand side of a
    journal entry, "Post" means commit to the ledger, "Draft" is a document
    state.

## Loading them back

    node scripts/i18n-import.cjs ko-KR i18n-export/done/ko-KR

The importer re-checks every key and placeholder and refuses a file that does
not match, so a bad paste cannot quietly corrupt a catalogue. It only fills
blanks — anything already translated is left alone.

## Languages still needing these

  ar   3512 missing
  az   3509 missing
  bn   3511 missing
  de   3512 missing
  es   3512 missing
  fa   3511 missing
  fr   3515 missing
  hi   3511 missing
  id   3515 missing
  it   3513 missing
  ja   3511 missing
  ko   3511 missing
  nl   3518 missing
  pl   3513 missing
  pt   3513 missing
  ru   3508 missing
  tr   3509 missing
  uk   3512 missing
  ur   3511 missing
  vi   3512 missing
  zh   3508 missing
