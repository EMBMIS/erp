const fs = require('fs');
const path = require('path');

const EXPORT_DIR = path.join(__dirname, '..', 'i18n-export');

const PH = /\{(\w+)\}/g;
const phOf = (s) => (String(s).match(PH) || []).sort().join(',');

function validateLocale(locale) {
  const doneDir = path.join(EXPORT_DIR, 'done', locale);
  if (!fs.existsSync(doneDir)) {
    return { ok: false, errors: [`Directory ${doneDir} does not exist`] };
  }

  const errors = [];
  let totalKeys = 0;

  const partFiles = fs.readdirSync(EXPORT_DIR).filter(f => f.startswith ? f.startswith('part-') && f.endswith('.json') : f.startsWith('part-') && f.endsWith('.json'));

  for (const fileName of partFiles) {
    const origPath = path.join(EXPORT_DIR, fileName);
    const transPath = path.join(doneDir, fileName);

    if (!fs.existsSync(transPath)) {
      errors.push(`Missing file: ${fileName}`);
      continue;
    }

    const orig = JSON.parse(fs.readFileSync(origPath, 'utf8'));
    let trans;
    try {
      trans = JSON.parse(fs.readFileSync(transPath, 'utf8'));
    } catch (e) {
      errors.push(`${fileName}: Invalid JSON - ${e.message}`);
      continue;
    }

    const origKeys = Object.keys(orig);
    const transKeys = Object.keys(trans);

    if (origKeys.length !== transKeys.length) {
      errors.push(`${fileName}: Key count mismatch (orig ${origKeys.length} vs trans ${transKeys.length})`);
    }

    for (let k = 0; k < origKeys.length; k++) {
      const key = origKeys[k];
      if (!Object.prototype.hasOwnProperty.call(trans, key)) {
        errors.push(`${fileName}: Missing key "${key}"`);
        continue;
      }

      const origVal = orig[key];
      const transVal = trans[key];

      if (typeof transVal !== 'string' || !transVal.trim()) {
        errors.push(`${fileName}: Empty value for key "${key}"`);
      }

      if (phOf(origVal) !== phOf(transVal)) {
        errors.push(`${fileName}: Placeholder mismatch on "${key}": expected [${phOf(origVal)}] got [${phOf(transVal)}]`);
      }

      totalKeys++;
    }
  }

  return { ok: errors.length === 0, totalKeys, errors };
}

if (require.main === module) {
  const locale = process.argv[2];
  if (!locale) {
    console.log('Usage: node validate-export.cjs <locale>');
    process.exit(1);
  }

  const res = validateLocale(locale);
  if (res.ok) {
    console.log(`✓ ${locale}: All files valid! Total keys verified: ${res.totalKeys}`);
  } else {
    console.error(`✗ ${locale}: Found ${res.errors.length} error(s):`);
    res.errors.slice(0, 20).forEach((e) => console.error(`  - ${e}`));
    if (res.errors.length > 20) console.error(`  ... and ${res.errors.length - 20} more`);
    process.exit(1);
  }
}

module.exports = { validateLocale };
