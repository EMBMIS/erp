/**
 * Build progress: the steps of a design, reported while it happens.
 *
 * ===========================================================================
 * WHY THIS EXISTS
 * ===========================================================================
 * Designing an application takes anywhere from a second (the analyser) to the
 * better part of a minute (a model, plus a repair round). For all of that time
 * the old Studio showed a button reading "Designing…" and nothing else, which
 * is indistinguishable from a hung request. People do not wait patiently in
 * front of a screen that is not telling them anything; they reload, and then
 * they have two half-built applications.
 *
 * So the design emits its steps as it goes. Every step is one of a CLOSED set
 * of keys (below), because the Studio draws a checklist from them and an
 * unknown key would render as a blank row. `detail` is free text — it is
 * displayed, never interpreted.
 *
 * Nothing here changes what gets built. A design with no reporter attached runs
 * exactly as it did before; `reporter(null)` returns a no-op and every emit
 * site is a plain function call.
 */

/** The steps a build can report, in the order they normally happen. */
const STEPS = Object.freeze({
  reading_context: 'Reading what EMBMIS already has',
  designing: 'Designing the data model and the process',
  repairing: 'Correcting the design',
  interpreting: 'Working out what to change',
  applying: 'Applying the change',
  fallback: 'Falling back to the built-in analyser',
  composing: 'Deriving screens, roles and navigation',
  validating: 'Checking the design',
  planning: 'Preparing the plan',
  naming: 'Reserving the application key',
  saving: 'Saving the draft',
  ready: 'Ready',
});

/**
 * A reporter.
 *
 * `sink` receives `{ step, label, detail, status, at }` — `status` is 'running'
 * for a step that has started and 'done' for one that finished. The Studio
 * shows the last running step with a spinner and everything before it ticked,
 * which is why steps are emitted twice rather than once at completion: a step
 * that only appears when it is over cannot show that it is the slow one.
 *
 * A sink that throws is swallowed. Progress is commentary; a broken pipe (the
 * user closed the tab mid-build) must never take the build down with it.
 */
function reporter(sink) {
  if (typeof sink !== 'function') return noop;

  const send = (step, status, detail) => {
    if (!(step in STEPS)) throw new Error(`Unknown build step "${step}".`);
    try {
      sink({ step, label: STEPS[step], detail: detail ?? null, status, at: new Date().toISOString() });
    } catch { /* the listener went away; the build has not */ }
  };

  const emit = (step, detail) => send(step, 'running', detail);
  emit.done = (step, detail) => send(step, 'done', detail);
  /** Run `fn` bracketed by a running/done pair, and pass its result through. */
  emit.around = async (step, detail, fn) => {
    emit(step, detail);
    const result = await fn();
    emit.done(step, typeof result?.progressDetail === 'string' ? result.progressDetail : detail);
    return result;
  };
  return emit;
}

const noop = Object.assign(() => {}, {
  done: () => {},
  around: async (_step, _detail, fn) => fn(),
});

module.exports = { reporter, STEPS };
