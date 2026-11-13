#!/usr/bin/env node
/**
 * CLI for the legacy generated-application migration.
 *
 * The work is in services/platform/legacyMigration.js — this is the thin part
 * that decides whether to do it and prints what happened. Default is a DRY RUN
 * that changes nothing; `--apply` is the deliberate step.
 *
 *   node scripts/migrate-legacy-apps.js            # report only
 *   node scripts/migrate-legacy-apps.js --apply    # do it
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });

const { pool } = require('../config/database');
const { migrateLegacyApplications } = require('../services/platform/legacyMigration');

const APPLY = process.argv.includes('--apply');

async function main() {
  const report = await migrateLegacyApplications({
    apply: APPLY,
    log: (line) => console.log(line),
  });

  if (!report.legacyPresent) {
    console.log('No legacy `apps`/`app_entities` registry on this database — nothing to migrate.');
    console.log('(That is the normal case: this database was built after the application platform.)');
    return;
  }
  if (!report.applications.length) {
    console.log('The legacy registry exists but holds no applications.');
    return;
  }

  console.log('');
  if (APPLY) {
    console.log('Done. The legacy tables are UNTOUCHED — check the copies, then drop them deliberately.');
  } else {
    console.log('Nothing was changed. Re-run with --apply to migrate.');
  }
}

main()
  .then(() => pool.end())
  .then(() => process.exit(0))
  .catch(async (error) => {
    console.error('\nMigration failed:', error.message);
    console.error(error.stack);
    await pool.end().catch(() => {});
    process.exit(1);
  });
