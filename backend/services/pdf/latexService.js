/**
 * LaTeX → PDF rendering.
 *
 * pdfkit (services/pdf/templatedPdf.js) draws boxes and tables; it cannot set
 * mathematics, cross-references, or the kind of typography a financial report
 * going to a board is expected to have. LaTeX can, and a model writes it well.
 * So an agent can compose a full LaTeX document — booktabs tables, pgfplots
 * charts, proper page furniture — and get back a real PDF.
 *
 * SECURITY — LaTeX IS A PROGRAMMING LANGUAGE
 * ---------------------------------------------------------------------------
 * This is not a template renderer. TeX is Turing-complete and, left alone, can
 * read arbitrary files (`\input{/etc/passwd}`), write files, and — with shell
 * escape — execute commands. Rendering model-authored LaTeX therefore needs the
 * same posture as running model-authored code:
 *
 *   • `-no-shell-escape` on every invocation, and `openin_any=p` /
 *     `openout_any=p` in the environment, which is TeX's own switch for "no
 *     absolute paths, no parent directories". That is the load-bearing control:
 *     it is enforced by the engine, not by our regexes.
 *   • A fresh temporary directory per render, used as the CWD and as TEXMFOUTPUT,
 *     removed afterwards. Anything the document writes lands there and dies there.
 *   • `-interaction=nonstopmode` plus a killed-on-timeout child process, because
 *     a TeX error otherwise sits at an interactive prompt forever, and `\loop`
 *     without an exit is a hang.
 *   • A source scan that rejects the obvious escapes before we spawn anything.
 *     Defence in depth — a pattern list alone would not be sufficient.
 *   • No network. The engine is not given one, and \write18 is off.
 *
 * NO SILENT FALLBACK
 * ---------------------------------------------------------------------------
 * If no TeX engine is installed, this fails with an explicit, actionable error.
 * It does NOT quietly render something else that looks similar: a document
 * asked for as LaTeX and delivered as an approximation is a wrong answer that
 * looks like a right one, and the caller has no way to tell.
 */

const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

// In order of preference. tectonic is first because it fetches only the packages
// a document actually uses and needs no full TeX Live installation; xelatex
// handles system fonts and Unicode; pdflatex is the most commonly installed.
const ENGINES = [
  { name: 'tectonic', args: (file, dir) => ['--outdir', dir, '--chatter', 'minimal', '--reruns', '1', file] },
  { name: 'xelatex', args: (file, dir) => ['-no-shell-escape', '-interaction=nonstopmode', '-halt-on-error', `-output-directory=${dir}`, file] },
  { name: 'pdflatex', args: (file, dir) => ['-no-shell-escape', '-interaction=nonstopmode', '-halt-on-error', `-output-directory=${dir}`, file] },
  { name: 'lualatex', args: (file, dir) => ['--no-shell-escape', '--interaction=nonstopmode', '--halt-on-error', `--output-directory=${dir}`, file] },
];

// MiKTeX only. Without this, a document using a package that is not installed
// does not fail — the installer blocks waiting for a confirmation that cannot
// arrive (stdin is closed), producing a silent hang that looks exactly like a
// runaway macro. `tectonic` fetches packages by design and needs no equivalent;
// TeX Live simply reports the missing file. Rejected as an unknown option by
// non-MiKTeX builds, which is why it is applied only when detected.
const MIKTEX_ONLY_ARGS = ['--disable-installer'];

const MAX_SOURCE_BYTES = 400_000;
const DEFAULT_TIMEOUT_MS = 60_000;

// Constructs with no legitimate place in a generated report, rejected before an
// engine is spawned. The engine-level openin/openout restrictions are the real
// barrier; this exists so an author gets a clear message instead of a cryptic
// TeX failure, and so an obvious attempt is refused loudly.
const FORBIDDEN = [
  [/\\write18/, '\\write18 (shell escape) is not permitted.'],
  [/\\immediate\s*\\write\s*18/, 'shell escape is not permitted.'],
  [/\\ShellEscape/, 'shell escape is not permitted.'],
  [/\\input\s*\{?\s*[\/~]/, 'reading files by absolute path is not permitted.'],
  [/\\include\s*\{\s*[\/~]/, 'reading files by absolute path is not permitted.'],
  [/\\openout/, 'writing files is not permitted.'],
  [/\\openin/, 'reading arbitrary files is not permitted.'],
  [/\\usepackage\s*(\[[^\]]*\])?\s*\{[^}]*\bshellesc\b/, 'the shellesc package is not permitted.'],
  [/\\catcode`\\\\\s*=/, 'redefining the escape character is not permitted.'],
  [/\.\.[\/\\]/, 'parent-directory paths are not permitted.'],
];

let engineCache = null;

/**
 * Which engine is available, if any. Cached: this shells out, and the answer
 * does not change while the process is running.
 */
function detectEngine({ refresh = false } = {}) {
  if (engineCache && !refresh) return engineCache;

  for (const engine of ENGINES) {
    try {
      const version = execFileSync(engine.name, ['--version'], {
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 8000,
        encoding: 'utf8',
      });
      // MiKTeX installs missing packages on demand, and when it cannot ask a
      // human it waits rather than failing — with stdin closed that is an
      // indefinite hang, not an error. Knowing the distribution lets us turn
      // that off; see MIKTEX_ONLY_ARGS.
      engineCache = { available: true, ...engine, miktex: /miktex/i.test(version || '') };
      return engineCache;
    } catch {
      // Not installed, or not on PATH. Try the next one.
    }
  }
  engineCache = {
    available: false,
    reason:
      'No LaTeX engine is installed on this server. Install one of: tectonic (smallest — a single binary, downloads packages on demand), TeX Live, or MiKTeX. Then restart the server.',
  };
  return engineCache;
}

function latexStatus() {
  const engine = detectEngine();
  return engine.available
    ? { available: true, engine: engine.name }
    : { available: false, reason: engine.reason, engines_searched: ENGINES.map((e) => e.name) };
}

function lintLatex(source) {
  const problems = [];
  if (typeof source !== 'string' || !source.trim()) {
    return { ok: false, problems: ['The document is empty.'] };
  }
  if (Buffer.byteLength(source, 'utf8') > MAX_SOURCE_BYTES) {
    problems.push(`The document is larger than the ${Math.round(MAX_SOURCE_BYTES / 1024)} KB limit.`);
  }
  for (const [pattern, message] of FORBIDDEN) {
    if (pattern.test(source)) problems.push(message);
  }
  if (!/\\documentclass/.test(source)) {
    problems.push('The document has no \\documentclass — it must be a complete LaTeX document, not a fragment.');
  }
  if (!/\\begin\s*\{document\}/.test(source)) {
    problems.push('The document has no \\begin{document}.');
  }
  return { ok: problems.length === 0, problems };
}

/**
 * Render LaTeX source to a PDF Buffer.
 *
 * @param {string} source complete LaTeX document
 * @param {object} options { timeoutMs, passes }
 */
async function renderLatex(source, options = {}) {
  const lint = lintLatex(source);
  if (!lint.ok) {
    const err = new Error(`This LaTeX cannot be rendered: ${lint.problems.join(' ')}`);
    err.code = 'LATEX_REJECTED';
    throw err;
  }

  const engine = detectEngine();
  if (!engine.available) {
    const err = new Error(engine.reason);
    err.code = 'LATEX_UNAVAILABLE';
    throw err;
  }

  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qira-latex-'));
  const jobName = `doc-${crypto.randomBytes(6).toString('hex')}`;
  const texFile = path.join(workDir, `${jobName}.tex`);
  const pdfFile = path.join(workDir, `${jobName}.pdf`);

  try {
    fs.writeFileSync(texFile, source, 'utf8');

    // Cross-references, \tableofcontents and pgfplots need a second pass to
    // resolve. Tectonic reruns internally, so one invocation is enough there.
    const passes = engine.name === 'tectonic' ? 1 : Math.min(Number(options.passes) || 2, 3);
    let lastLog = '';

    for (let pass = 0; pass < passes; pass++) {
      const result = await runEngine(engine, texFile, workDir, options.timeoutMs || DEFAULT_TIMEOUT_MS);
      lastLog = result.output;
      if (result.timedOut) {
        // Include where it stopped. A bare "it timed out" sends the reader
        // looking for a macro loop, and the cause is more often the last file
        // the engine mentioned — a missing package, or a font it went hunting
        // for. The log tail is the difference between a guess and a diagnosis.
        const where = lastOpened(lastLog);
        const err = new Error(
          `LaTeX did not finish within ${Math.round((options.timeoutMs || DEFAULT_TIMEOUT_MS) / 1000)}s and was stopped. ` +
          (where
            ? `It stopped while processing ${where}, which usually means that package or font is not installed.`
            : 'This usually means an unterminated environment or an infinite macro loop.')
        );
        err.code = 'LATEX_TIMEOUT';
        err.log = lastLog.slice(-2000);
        throw err;
      }
      // A non-zero exit is only fatal if no PDF came out — LaTeX routinely
      // exits non-zero on warnings while still producing a perfectly good file.
      if (result.code !== 0 && !fs.existsSync(pdfFile)) {
        const err = new Error(`LaTeX failed to compile the document.\n\n${extractLatexError(result.output)}`);
        err.code = 'LATEX_ERROR';
        err.log = result.output.slice(-8000);
        throw err;
      }
    }

    if (!fs.existsSync(pdfFile)) {
      const err = new Error(`LaTeX produced no PDF.\n\n${extractLatexError(lastLog)}`);
      err.code = 'LATEX_ERROR';
      err.log = lastLog.slice(-8000);
      throw err;
    }

    return { buffer: fs.readFileSync(pdfFile), engine: engine.name };
  } finally {
    // Always clean up: temp directories full of half-built documents are how a
    // server runs out of disk three weeks later.
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

/**
 * Variables a TeX engine needs in order to start at all.
 *
 * `spawn`'s `env` REPLACES the environment rather than extending it, so listing
 * only PATH and our own restrictions left the engine with nothing else. On
 * Windows that is fatal: MiKTeX locates its package database and writes its
 * caches under APPDATA/LOCALAPPDATA, and resolves DLLs via SystemRoot. Without
 * them it fails at the shipout stage, or — because stdin is closed, so it cannot
 * be answered — sits on an install prompt until the timeout kills it. The
 * symptom was a 60-second hang on a document that renders in two seconds by
 * hand, which reads like an infinite macro loop and is not one.
 *
 * These are ambient process configuration, not secrets: the isolation that
 * matters is `-no-shell-escape` plus openin_any/openout_any, which the engine
 * enforces itself.
 */
const ENGINE_ENV_PASSTHROUGH = process.platform === 'win32'
  ? ['PATH', 'SystemRoot', 'windir', 'SystemDrive', 'APPDATA', 'LOCALAPPDATA',
     'USERPROFILE', 'ProgramData', 'ProgramFiles', 'ProgramFiles(x86)',
     'COMSPEC', 'PATHEXT', 'NUMBER_OF_PROCESSORS']
  : ['PATH', 'LANG', 'LC_ALL', 'TERM'];

function engineEnv(engine, workDir) {
  const env = {};
  // Windows environment names are case-insensitive; process.env preserves
  // whatever case the parent used, so match rather than index directly.
  const actual = new Map(Object.keys(process.env).map((k) => [k.toLowerCase(), k]));
  for (const name of ENGINE_ENV_PASSTHROUGH) {
    const key = actual.get(name.toLowerCase());
    if (key && process.env[key] !== undefined) env[name] = process.env[key];
  }

  // openin_any/openout_any=p is TeX's own restriction: no absolute paths, no
  // parent directories, no dotfiles. This is the load-bearing control.
  env.openin_any = 'p';
  env.openout_any = 'p';
  env.shell_escape = 'f';
  env.TEXMFOUTPUT = workDir;
  // Anything the document writes relative to $HOME lands in the work directory
  // and is removed with it. Deliberately NOT setting TEXMFVAR: that is where the
  // engine keeps its own format and font caches, and pointing it at an empty
  // directory makes every render rebuild them.
  env.HOME = workDir;

  // Tectonic caches downloaded packages under the real home; overriding it
  // would re-download the whole dependency set on every render.
  if (engine.name === 'tectonic') env.HOME = os.homedir();

  return env;
}

function runEngine(engine, texFile, workDir, timeoutMs) {
  return new Promise((resolve, reject) => {
    const args = engine.args(texFile, workDir);
    const child = spawn(engine.name, engine.miktex ? [...MIKTEX_ONLY_ARGS, ...args] : args, {
      cwd: workDir,
      env: engineEnv(engine, workDir),
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let output = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);

    // Cap what we retain: a runaway document can emit megabytes of log.
    const collect = (chunk) => {
      if (output.length < 200_000) output += chunk.toString();
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);

    child.on('error', (err) => {
      clearTimeout(timer);
      reject(new Error(`Could not run ${engine.name}: ${err.message}`));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, output, timedOut });
    });
  });
}

/**
 * The last thing the engine opened before it stopped.
 *
 * TeX announces each file it reads as `(/path/to/thing.sty`. When a render
 * hangs, the final unmatched one is what it was working on — for an on-demand
 * package install that is the document itself, and for a missing font or style
 * it names the culprit directly.
 */
function lastOpened(log) {
  const opens = String(log || '').match(/\(([^()\s]+\.(?:sty|cls|def|cfg|tex|fd))/gi);
  if (!opens || !opens.length) return null;
  const file = opens[opens.length - 1].slice(1);
  return file.split(/[/\\]/).pop();
}

/**
 * Pull the actual error out of a LaTeX log.
 *
 * A TeX log is thousands of lines of package chatter around three that matter.
 * Handing the whole thing to a model wastes context and usually gets the wrong
 * line quoted back to the user; the `!` lines are the errors.
 */
function extractLatexError(log) {
  const text = String(log || '');
  const lines = text.split(/\r?\n/);

  // Lead with missing packages. This text goes back to a model as a tool
  // result, and "siunitx is not installed, use a different package" is
  // something it can act on; the raw error buries that under an interactive
  // prompt ("Type X to quit...") that no one can answer here.
  const missing = [...new Set(
    [...text.matchAll(/File `([^']+)' not found/g)].map((m) => m[1])
  )];
  const heading = missing.length
    ? `Not installed on this server: ${missing.join(', ')}. ` +
      'Rewrite the document using only packages from a standard TeX distribution, or ask an administrator to install these.\n\n'
    : '';

  const errors = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith('!')) {
      errors.push(lines.slice(i, i + 4).join('\n'));
      if (errors.length >= 3) break;
    }
  }
  if (errors.length) return heading + errors.join('\n---\n');
  if (heading) return heading.trim();
  // No `!` line: fall back to the tail, which is where tectonic reports.
  return lines.slice(-25).join('\n');
}

module.exports = {
  renderLatex,
  lintLatex,
  detectEngine,
  latexStatus,
  extractLatexError,
  MAX_SOURCE_BYTES,
};
