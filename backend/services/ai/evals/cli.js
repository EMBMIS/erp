#!/usr/bin/env node
/**
 * CLI runner for the agent eval suite.
 *
 * Usage:
 *   node services/ai/evals/cli.js [filter]          — human-readable output
 *   node services/ai/evals/cli.js --json [filter]   — machine-readable JSON
 *
 * Exit code 1 if any scenario fails, so this can gate CI.
 */

const { runEvals } = require('./runner');

async function main() {
  const args = process.argv.slice(2);
  const useJson = args.includes('--json');
  const filter = args.filter((a) => a !== '--json')[0] || undefined;

  const { total, passed, failed, results } = await runEvals(filter ? { filter } : {});

  if (useJson) {
    console.log(JSON.stringify({ total, passed, failed, results }));
  } else {
    console.log(`Agent eval run — ${total} scenario${total === 1 ? '' : 's'}\n`);
    for (const r of results) {
      console.log(`[${r.ok ? 'PASS' : 'FAIL'}] ${r.id}`);
      if (!r.ok) {
        for (const reason of r.reasons) console.log(`       - ${reason}`);
      }
    }
    console.log(`\n${passed}/${total} passed, ${failed} failed`);
  }

  process.exitCode = failed > 0 ? 1 : 0;
}

main().catch((err) => {
  console.error('Eval run crashed:', err);
  process.exitCode = 1;
});
