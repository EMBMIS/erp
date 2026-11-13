#!/usr/bin/env node
/**
 * Check that every remote server in the MCP registry is actually there.
 *
 * A curated list of endpoints is only useful while the endpoints are real.
 * Vendors move them, retire them and rename them, and a list written from
 * memory is wrong the day it is written. This connects to each one and reports
 * what answered, so the catalogue can be corrected from evidence rather than
 * from recollection.
 *
 * Three outcomes, and the middle one matters most:
 *
 *   OK        completed an MCP handshake and listed its tools.
 *   AUTH      answered, but wants credentials first. Still a real server —
 *             this is the expected result for every OAuth entry, since we are
 *             deliberately not holding anyone's tokens here.
 *   DEAD      nothing that speaks MCP is at that address.
 *
 * Usage:
 *   node scripts/verify-mcp-registry.js            # check them all
 *   node scripts/verify-mcp-registry.js --erp      # only ERP-relevant ones
 *   node scripts/verify-mcp-registry.js --json     # machine-readable summary
 */

require('dotenv').config();
const { REGISTRY } = require('../services/ai/mcpRegistry');
const mcpClient = require('../services/ai/mcpClient');

const CONCURRENCY = 6;
const TIMEOUT_MS = 12000;

async function checkOne(entry) {
  const started = Date.now();
  try {
    const probed = await mcpClient.probe(entry.endpoint_url, { timeoutMs: TIMEOUT_MS });
    const ms = Date.now() - started;
    if (!probed) return { entry, status: 'DEAD', ms };
    if (probed.needs_auth) return { entry, status: 'AUTH', ms };
    return { entry, status: 'OK', ms, tools: probed.tools.map((t) => t.name) };
  } catch (err) {
    return { entry, status: 'DEAD', ms: Date.now() - started, error: err.message };
  }
}

async function pool(items, worker, limit) {
  const results = [];
  let index = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (index < items.length) {
        const mine = index++;
        results[mine] = await worker(items[mine]);
      }
    })
  );
  return results;
}

async function main() {
  const erpOnly = process.argv.includes('--erp');
  const asJson = process.argv.includes('--json');

  // Every catalogue entry is a remote server by definition — that is the entry
  // requirement — so all of them are probeable.
  const remote = REGISTRY.filter((r) => r.endpoint_url && (!erpOnly || r.erp));

  if (!asJson) {
    console.log(`Checking ${remote.length} endpoints...\n`);
  }

  const results = await pool(remote, checkOne, CONCURRENCY);

  const badge = { OK: '✅ OK  ', AUTH: '\u{1F512} AUTH', DEAD: '❌ DEAD' };
  if (!asJson) {
    for (const r of results.sort((a, b) => a.status.localeCompare(b.status))) {
      console.log(`${badge[r.status]}  ${r.entry.name.padEnd(28)} ${r.entry.endpoint_url}`);
      if (r.status === 'OK') console.log(`         ${r.tools.length} tools: ${r.tools.slice(0, 6).join(', ')}`);
      if (r.status === 'DEAD' && r.error) console.log(`         ${r.error.slice(0, 110)}`);
    }
  }

  const counts = results.reduce((acc, r) => ({ ...acc, [r.status]: (acc[r.status] || 0) + 1 }), {});
  if (asJson) {
    console.log(JSON.stringify({
      counts,
      results: results.map((r) => ({ name: r.entry.name, endpoint: r.entry.endpoint_url, status: r.status, tools: r.tools || [] })),
    }, null, 2));
  } else {
    console.log(`\nreachable: ${(counts.OK || 0) + (counts.AUTH || 0)}/${results.length}` +
      `  (open: ${counts.OK || 0}, needs auth: ${counts.AUTH || 0}, dead: ${counts.DEAD || 0})`);
    if (counts.DEAD) {
      console.log('\nDEAD entries are wrong and should be corrected or removed from services/ai/mcpRegistry.js.');
    }
  }
  process.exit(0);
}

main().catch((err) => {
  console.error('verify-mcp-registry failed:', err);
  process.exit(1);
});
