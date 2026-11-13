/**
 * Sandboxed execution for user-authored tool code.
 *
 * A tool built inside the ERP is JavaScript that someone typed into a form and
 * that the AI may then call on its own. This module is the boundary around it.
 *
 * WHAT THIS IS AND IS NOT
 * ----------------------------------------------------------------------------
 * Node's `vm` module is explicitly NOT a security boundary against a determined
 * attacker — the documentation says so, and pretending otherwise is how these
 * systems get owned. So the *primary* control for custom tools is authorisation:
 * only ADMIN/MANAGER may author one, every revision is retained with its author
 * (ai_tool_versions), and every call is written to ai_audit_log.
 *
 * What this module adds on top is capability reduction — making the interesting
 * targets absent rather than merely forbidden:
 *
 *   • Fresh context per run. No require, no process, no Buffer, no timers, no
 *     filesystem, no network, no globalThis leakage from the host.
 *   • Only PRIMITIVES cross the realm boundary. Every host capability is reached
 *     through one function that takes and returns JSON strings, and the glue
 *     that parses them is compiled inside the sandbox. That closes the standard
 *     escape route, where a host-realm object handed to guest code yields
 *     `x.constructor.constructor('return process')()`. There is no host object
 *     in scope to walk.
 *   • The bridge function is unreachable from user code: the bootstrap closes
 *     over it and deletes the global before user code is compiled.
 *   • Code generation is disabled in the context, so eval/new Function throw.
 *   • A static scan rejects the obvious escape shapes before anything compiles.
 *     Defence in depth — a pattern list is not a barrier on its own.
 *   • Reads only. The exposed capabilities are the nlQuery read-only SQL path
 *     (single SELECT, table allowlist, READ ONLY transaction, row cap) and
 *     explicitly whitelisted read-only built-in tools. Writing is not something
 *     a custom tool can do at all; that lives at the agent layer, where
 *     services/agents/authority.js governs it.
 *
 * TIMEOUT — AN HONEST LIMITATION
 * ----------------------------------------------------------------------------
 * `vm`'s timeout interrupts SYNCHRONOUS guest code, and only while the guest is
 * running under a runInContext call. That gives two different guarantees, and
 * conflating them is how a "timeout" silently stops being one:
 *
 *   • A loop before the first await is genuinely terminated. The guest function
 *     is therefore *invoked* inside runInContext (not returned to the host and
 *     called from here, which would run its synchronous prefix unsupervised —
 *     the original form of this code hung the process on `while(true){}`).
 *   • Anything after an await runs as a microtask outside vm supervision. A
 *     hanging await is *abandoned* — raced against a timer, its result
 *     discarded, further bridge calls refused — but a busy loop placed after an
 *     await cannot be interrupted at all and will occupy the event loop.
 *
 * That residual hole is why authoring is restricted to ADMIN/MANAGER: the last
 * line of defence for a custom tool is who was allowed to write it. Everything
 * the guest can await is itself bounded (SQL runs under a statement timeout and
 * a row cap; built-in read tools are single queries), so an abandoned run stops
 * doing work shortly after. Adding an unbounded capability to the bridge would
 * break that property. Real preemption needs worker-thread isolation, which is
 * the natural next step for this module.
 */

const vm = require('vm');

// Hard ceilings that apply regardless of what a tool's own settings say.
const MAX_CODE_BYTES = 20000;
const MAX_HOST_CALLS = 25;        // bridge calls per execution
const MAX_RESULT_BYTES = 262144;  // 256 KB of returned JSON
const MAX_LOG_ENTRIES = 100;
const DEFAULT_TIMEOUT_MS = 5000;
const MAX_TIMEOUT_MS = 30000;

// Shapes that have no legitimate use in a tool body and are the first thing
// anyone reaches for when probing a vm. Rejected before compilation with a
// message that says which one, so an honest author can fix their code.
const FORBIDDEN_PATTERNS = [
  [/\brequire\s*\(/, 'require() is not available in a tool'],
  [/\bprocess\b/, 'process is not available in a tool'],
  [/\bglobalThis\b/, 'globalThis is not available in a tool'],
  [/\bimport\s*\(/, 'dynamic import() is not available in a tool'],
  [/\beval\s*\(/, 'eval() is not available in a tool'],
  [/\bnew\s+Function\b/, 'new Function() is not available in a tool'],
  [/\bFunction\s*\(/, 'the Function constructor is not available in a tool'],
  [/\bconstructor\s*\[/, 'reaching through .constructor is not allowed'],
  [/\.\s*constructor\s*\.\s*constructor\b/, 'reaching through .constructor is not allowed'],
  [/\b__proto__\b/, '__proto__ is not allowed'],
  [/\bBuffer\b/, 'Buffer is not available in a tool'],
  [/\bWebAssembly\b/, 'WebAssembly is not available in a tool'],
  [/\bsetTimeout\b|\bsetInterval\b|\bsetImmediate\b/, 'timers are not available in a tool'],
];

/**
 * Static pre-check. Separate from execution so the tool editor can show the
 * author what is wrong at save time rather than at 3am inside an agent run.
 */
function lintToolCode(code) {
  const problems = [];
  if (typeof code !== 'string' || !code.trim()) {
    return { ok: false, problems: ['The tool has no implementation.'] };
  }
  if (Buffer.byteLength(code, 'utf8') > MAX_CODE_BYTES) {
    problems.push(`The implementation is larger than the ${MAX_CODE_BYTES} byte limit.`);
  }
  for (const [pattern, message] of FORBIDDEN_PATTERNS) {
    if (pattern.test(code)) problems.push(message);
  }
  // Compile-check the body in isolation so a syntax error is reported as one.
  if (!problems.length) {
    try {
      new vm.Script(`(async function(input, erp){${code}\n})`);
    } catch (err) {
      problems.push(`Syntax error: ${err.message}`);
    }
  }
  return { ok: problems.length === 0, problems };
}

// ---------------------------------------------------------------------------
// The in-sandbox bootstrap.
//
// Compiled inside the guest context, it builds the `erp` object out of the one
// bridge function and then removes that function from the global scope. User
// code sees only functions defined in its own realm which return its own
// promises — no host object is ever in scope for it to walk.
// ---------------------------------------------------------------------------
const BOOTSTRAP = `
(function () {
  var bridge = globalThis.__bridge;
  delete globalThis.__bridge;

  function call(op, payload) {
    // Args cross as a JSON string and come back as one, so nothing structural
    // is shared between the two realms.
    return bridge(op, JSON.stringify(payload === undefined ? null : payload));
  }

  var erp = {
    sql: async function (text, params) {
      return JSON.parse(await call('sql', { text: text, params: params || [] }));
    },
    callTool: async function (name, args) {
      return JSON.parse(await call('callTool', { name: name, args: args || {} }));
    },
    log: function () {
      var parts = [];
      for (var i = 0; i < arguments.length; i++) {
        var a = arguments[i];
        parts.push(typeof a === 'string' ? a : (function () {
          try { return JSON.stringify(a); } catch (e) { return String(a); }
        })());
      }
      call('log', parts.join(' '));
    },
  };

  Object.freeze(erp);
  globalThis.erp = erp;
  globalThis.console = Object.freeze({ log: erp.log, info: erp.log, warn: erp.log, error: erp.log });
})();
`;

/**
 * Execute a tool body.
 *
 * @param {object}   opts
 * @param {string}   opts.code        function body; receives (input, erp), returns a value
 * @param {object}   opts.input       arguments passed to the tool
 * @param {number}   [opts.timeoutMs]
 * @param {object}   opts.capabilities { sql?: fn(text, params), callTool?: fn(name, args) }
 * @returns {Promise<{ok, result, logs, host_calls, duration_ms, error}>}
 */
async function runSandboxed({ code, input = {}, timeoutMs = DEFAULT_TIMEOUT_MS, capabilities = {} }) {
  const lint = lintToolCode(code);
  if (!lint.ok) {
    return { ok: false, error: lint.problems.join(' '), logs: [], host_calls: 0, duration_ms: 0 };
  }

  const limit = Math.min(Math.max(Number(timeoutMs) || DEFAULT_TIMEOUT_MS, 100), MAX_TIMEOUT_MS);
  const logs = [];
  const startedAt = Date.now();
  let hostCalls = 0;
  let abandoned = false;

  // The single host capability. Takes and returns JSON strings only.
  const bridge = async (op, payloadJson) => {
    // Once we have given up on this run, stop doing work on its behalf — an
    // abandoned tool must not keep querying the database forever.
    if (abandoned) throw new Error('This tool run has already timed out.');
    if (op !== 'log' && ++hostCalls > MAX_HOST_CALLS) {
      throw new Error(`A tool may make at most ${MAX_HOST_CALLS} data calls per run.`);
    }

    let payload;
    try {
      payload = JSON.parse(payloadJson);
    } catch {
      throw new Error('Invalid arguments passed to an erp call.');
    }

    if (op === 'log') {
      if (logs.length < MAX_LOG_ENTRIES) logs.push(String(payload).slice(0, 2000));
      return '';
    }
    if (op === 'sql') {
      if (typeof capabilities.sql !== 'function') throw new Error('This tool is not permitted to run SQL.');
      return JSON.stringify(await capabilities.sql(payload.text, payload.params));
    }
    if (op === 'callTool') {
      if (typeof capabilities.callTool !== 'function') throw new Error('This tool is not permitted to call other tools.');
      return JSON.stringify(await capabilities.callTool(payload.name, payload.args));
    }
    throw new Error(`Unknown capability "${op}".`);
  };
  // A function whose prototype chain is null has no .constructor, removing the
  // shortest path from a reachable host function back to the host realm.
  Object.setPrototypeOf(bridge, null);

  const context = vm.createContext(
    { __bridge: bridge },
    {
      name: 'ai-custom-tool',
      // eval / new Function throw inside the guest.
      codeGeneration: { strings: false, wasm: false },
    }
  );

  try {
    new vm.Script(BOOTSTRAP, { filename: 'sandbox-bootstrap.js' }).runInContext(context, { timeout: 1000 });

    // The input crosses as a string, and the guest does its own parsing and
    // stringifying, so the host never holds a guest object other than the
    // promise it awaits.
    context.__input = JSON.stringify(input ?? {});

    // The guest function is CALLED here, inside runInContext, so its
    // synchronous prefix runs under vm's timeout. Calling it from the host
    // instead would leave `while (true) {}` unsupervised and wedge the process.
    const invocation = new vm.Script(
      `globalThis.__result = (async function (input, erp) {\n${code}\n})(JSON.parse(__input), erp)
         .then(function (out) { return out === undefined ? 'null' : JSON.stringify(out); });
       delete globalThis.__input;`,
      { filename: 'custom-tool.js' }
    );
    invocation.runInContext(context, { timeout: limit });

    // Everything after the guest's first await is outside vm supervision, so the
    // wall clock is enforced here too. The promise is abandoned, not cancelled —
    // see the header note.
    let timer;
    const deadline = new Promise((_, reject) => {
      // Deliberately NOT unref'd. This timer is the only thing that guarantees
      // this call returns at all; unref'ing it meant that when the event loop
      // had nothing else pending — a CLI script, a test — the timer never fired
      // and the caller's promise silently never settled. It is always cleared
      // in the finally below, so it cannot outlive the call either.
      timer = setTimeout(() => {
        abandoned = true;
        reject(new Error(`The tool did not finish within ${limit}ms.`));
      }, limit);
    });

    let resultJson;
    try {
      resultJson = await Promise.race([Promise.resolve(context.__result), deadline]);
    } finally {
      clearTimeout(timer);
      context.__result = undefined;
    }

    if (typeof resultJson !== 'string') {
      throw new Error('The tool returned a value that could not be serialised.');
    }
    if (Buffer.byteLength(resultJson, 'utf8') > MAX_RESULT_BYTES) {
      throw new Error(`The tool returned more than ${Math.round(MAX_RESULT_BYTES / 1024)} KB of data. Aggregate or limit the rows it returns.`);
    }

    return {
      ok: true,
      result: JSON.parse(resultJson),
      logs,
      host_calls: hostCalls,
      duration_ms: Date.now() - startedAt,
    };
  } catch (err) {
    return {
      ok: false,
      // Guest exceptions arrive as guest Error objects; read only the message,
      // and never propagate the object itself into host control flow.
      error: String(err?.message || err).slice(0, 2000),
      logs,
      host_calls: hostCalls,
      duration_ms: Date.now() - startedAt,
    };
  }
}

module.exports = {
  runSandboxed,
  lintToolCode,
  MAX_CODE_BYTES,
  MAX_HOST_CALLS,
  MAX_RESULT_BYTES,
  DEFAULT_TIMEOUT_MS,
  MAX_TIMEOUT_MS,
};
