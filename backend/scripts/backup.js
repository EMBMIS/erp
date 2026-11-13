/**
 * Database backup script.
 *
 * Dumps the database named by DATABASE_URL via `pg_dump`, gzips the output,
 * and writes it to ./backups/backup-YYYY-MM-DD-HHmm.sql.gz. Keeps only the
 * most recent 7 backups (by filename, which is chronological) and deletes
 * anything older.
 *
 * Usage:
 *   node backend/scripts/backup.js
 *
 * Requires the `pg_dump` binary (matching the Postgres major version, or
 * newer) to be on PATH. Schedule this with cron/Task Scheduler for daily
 * backups — this script does not schedule itself.
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { spawn } = require('child_process');
const logger = require('../config/logger');

const BACKUP_DIR = path.join(__dirname, '..', '..', 'backups');
const KEEP_COUNT = 7;

function timestamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
}

function dumpDatabase(outputPath) {
  return new Promise((resolve, reject) => {
    if (!process.env.DATABASE_URL) {
      return reject(new Error('DATABASE_URL is not set'));
    }

    const pgDump = spawn('pg_dump', [process.env.DATABASE_URL, '--no-owner', '--no-privileges'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stderr = '';
    pgDump.stderr.on('data', (chunk) => { stderr += chunk.toString(); });

    const gzip = zlib.createGzip();
    const out = fs.createWriteStream(outputPath);

    pgDump.stdout.pipe(gzip).pipe(out);

    pgDump.on('error', (err) => reject(new Error(`Failed to start pg_dump: ${err.message}`)));

    out.on('finish', () => {
      // pg_dump can still exit non-zero after the last byte was flushed;
      // 'finish' just means the file is fully written, not that the dump
      // succeeded. The exit-code check below is what actually decides that.
    });

    pgDump.on('close', (code) => {
      if (code !== 0) {
        return reject(new Error(`pg_dump exited with code ${code}: ${stderr.trim()}`));
      }
      resolve();
    });
  });
}

function pruneOldBackups() {
  const files = fs.readdirSync(BACKUP_DIR)
    .filter((f) => f.startsWith('backup-') && f.endsWith('.sql.gz'))
    .sort(); // filenames are chronological (YYYY-MM-DD-HHmm)

  const toDelete = files.slice(0, Math.max(0, files.length - KEEP_COUNT));
  for (const file of toDelete) {
    fs.unlinkSync(path.join(BACKUP_DIR, file));
    logger.info({ file }, 'Deleted old backup');
  }
}

async function main() {
  const startedAt = Date.now();
  fs.mkdirSync(BACKUP_DIR, { recursive: true });

  const filename = `backup-${timestamp()}.sql.gz`;
  const outputPath = path.join(BACKUP_DIR, filename);

  logger.info({ filename }, 'Starting database backup');

  try {
    await dumpDatabase(outputPath);
    const { size } = fs.statSync(outputPath);
    logger.info({ filename, sizeBytes: size, durationMs: Date.now() - startedAt }, 'Backup completed');

    pruneOldBackups();
  } catch (error) {
    logger.error({ err: error.message }, 'Backup failed');
    // Remove a partial/empty file so it doesn't get mistaken for a real backup.
    if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
    process.exit(1);
  }
}

main();
