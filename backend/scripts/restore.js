/**
 * Database restore script — DESTRUCTIVE, overwrites data in DATABASE_URL.
 *
 * Usage:
 *   node backend/scripts/restore.js ./backups/backup-2026-08-06-1200.sql.gz --confirm
 *
 * The --confirm flag is required and deliberately not inferred from context
 * (e.g. "no other flags" or "running non-interactively") — a restore this
 * script runs replaces live data, and the one thing worse than asking twice
 * is a script that quietly assumed yes.
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { spawn } = require('child_process');
const logger = require('../config/logger');

function restoreDatabase(backupPath) {
  return new Promise((resolve, reject) => {
    if (!process.env.DATABASE_URL) {
      return reject(new Error('DATABASE_URL is not set'));
    }

    const psql = spawn('psql', [process.env.DATABASE_URL], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stderr = '';
    psql.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    psql.stdout.on('data', () => {}); // discard psql's normal output noise

    psql.on('error', (err) => reject(new Error(`Failed to start psql: ${err.message}`)));

    const input = fs.createReadStream(backupPath);
    const gunzip = zlib.createGunzip();
    input.pipe(gunzip).pipe(psql.stdin);

    input.on('error', (err) => reject(new Error(`Failed to read backup file: ${err.message}`)));
    gunzip.on('error', (err) => reject(new Error(`Failed to decompress backup file: ${err.message}`)));

    psql.on('close', (code) => {
      if (code !== 0) {
        return reject(new Error(`psql exited with code ${code}: ${stderr.trim()}`));
      }
      resolve();
    });
  });
}

async function main() {
  const args = process.argv.slice(2);
  const confirmed = args.includes('--confirm');
  const backupPath = args.find((a) => a !== '--confirm');

  if (!backupPath) {
    console.error('Usage: node backend/scripts/restore.js <path-to-backup.sql.gz> --confirm');
    process.exit(1);
  }

  if (!fs.existsSync(backupPath)) {
    console.error(`FATAL: backup file not found: ${backupPath}`);
    process.exit(1);
  }

  if (!confirmed) {
    console.error(
      `Refusing to restore without --confirm. This will OVERWRITE the database at DATABASE_URL with ${path.basename(backupPath)}.\n` +
      `Re-run as: node backend/scripts/restore.js ${backupPath} --confirm`
    );
    process.exit(1);
  }

  const startedAt = Date.now();
  logger.info({ backupPath }, 'Starting database restore');

  try {
    await restoreDatabase(backupPath);
    logger.info({ backupPath, durationMs: Date.now() - startedAt }, 'Restore completed');
  } catch (error) {
    logger.error({ err: error.message }, 'Restore failed');
    process.exit(1);
  }
}

main();
