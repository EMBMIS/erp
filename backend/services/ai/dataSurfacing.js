/**
 * What the person actually sees.
 *
 * THE PROBLEM THIS SOLVES
 * ---------------------------------------------------------------------------
 * A turn can touch six tools and pull four hundred rows. Putting all of it in
 * the answer buries the answer; putting none of it there makes every figure
 * unverifiable. The old behaviour was the first: every tool that returned
 * anything countable printed a panel into the message body, so asking a simple
 * question produced a wall of blocks the reader had to sift.
 *
 * The rule now is that the model decides, the same way a person writing a memo
 * decides what goes in the body and what goes in the appendix:
 *
 *   BODY        prose, charts it chose to draw, approvals it needs, and
 *               whatever it explicitly promotes with this tool.
 *   DISCLOSURE  every tool it called and everything each one returned,
 *               under one dropdown, always, without it having to ask.
 *
 * Nothing is hidden by this — the disclosure holds the complete record either
 * way. What the model controls is emphasis, not availability. That distinction
 * is why this is safe: an agent that could hide its working would be a much
 * worse thing than one that decides what to lead with.
 *
 * AND IT STILL CANNOT TYPE A NUMBER
 * ---------------------------------------------------------------------------
 * show_data takes a reference to a tool that ran — not values. It names the
 * tool, optionally a path into its result, and which fields matter. The numbers
 * are read out of that stored result here. So promoting something to the body
 * is a decision about attention, never an opportunity to author data.
 */

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function numeric(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

/** The longest array-of-objects in a result, wherever it is. */
function longestRowList(value, depth = 0) {
  if (depth > 2 || !isObj(value)) return null;
  let best = null;
  for (const v of Object.values(value)) {
    if (Array.isArray(v) && v.length && isObj(v[0])) {
      if (!best || v.length > best.length) best = v;
    } else if (isObj(v)) {
      const nested = longestRowList(v, depth + 1);
      if (nested && (!best || nested.length > best.length)) best = nested;
    }
  }
  return best;
}

/**
 * Promote part of a tool result into the answer.
 *
 * @param args.from_tool  a tool that already ran this turn
 * @param args.path       optional key into that result
 * @param args.fields     which columns to show, in order. Omit for all.
 * @param args.limit      how many rows. Default 8, max 25 — this is the body
 *                        of an answer, not a table dump.
 * @param args.as         'table' | 'figures'. Figures for a scalar summary,
 *                        table for rows.
 */
function show(args = {}, ctx = {}) {
  const results = ctx.toolResults || {};
  const source = results[args.from_tool];

  if (source === undefined) {
    const ran = Object.keys(results);
    return {
      error: `No tool named "${args.from_tool}" has run in this conversation turn.`
        + (ran.length ? ` Tools that have run: ${ran.join(', ')}.` : ' Call one first.'),
    };
  }

  const title = typeof args.title === 'string' ? args.title.slice(0, 80) : null;
  const note = typeof args.note === 'string' ? args.note.slice(0, 200) : null;

  // --- figures: the scalar summary fields of a result ----------------------
  if (args.as === 'figures') {
    if (!isObj(source)) {
      return { error: `The result of ${args.from_tool} is not an object, so it has no summary figures. Use as:"table".` };
    }
    const wanted = Array.isArray(args.fields) && args.fields.length ? args.fields : null;
    const figures = [];
    const missing = [];
    for (const key of wanted || Object.keys(source)) {
      const n = numeric(source[key]);
      if (n === null) {
        if (wanted) missing.push(key);
        continue;
      }
      figures.push({ key, value: n });
      if (figures.length >= 6) break;
    }
    if (!figures.length) {
      return {
        error: `No numeric field to show on ${args.from_tool}.`
          + ` Fields available: ${Object.keys(source).join(', ')}.`,
      };
    }
    return {
      surfaced: { kind: 'figures', title, note, figures, from_tool: args.from_tool },
      ...(missing.length ? { warnings: [`These fields are not numeric on ${args.from_tool} and were skipped: ${missing.join(', ')}.`] } : {}),
    };
  }

  // --- table: rows ---------------------------------------------------------
  let rows = null;
  if (args.path) {
    rows = String(args.path).split('.').reduce((acc, key) => (acc && typeof acc === 'object' ? acc[key] : undefined), source);
  } else {
    rows = Array.isArray(source) ? source : longestRowList(source);
  }

  if (!Array.isArray(rows)) {
    return {
      error: `${args.path ? `"${args.path}" on` : 'The result of'} ${args.from_tool} is not a list of rows.`
        + (isObj(source) ? ` Keys available: ${Object.keys(source).join(', ')}.` : ''),
    };
  }

  if (!rows.length) {
    // An empty set is a real finding and worth showing as one, rather than
    // being reported as a failure the model then works around.
    return { surfaced: { kind: 'table', title, note, columns: [], rows: [], empty: true, total: 0, from_tool: args.from_tool } };
  }

  const available = Object.keys(rows[0]);
  const warnings = [];
  let columns = available;
  if (Array.isArray(args.fields) && args.fields.length) {
    const missing = args.fields.filter((f) => !available.includes(f));
    if (missing.length) {
      warnings.push(`These fields are not on ${args.from_tool}'s rows and were skipped: ${missing.join(', ')}. Available: ${available.join(', ')}.`);
    }
    columns = args.fields.filter((f) => available.includes(f));
    if (!columns.length) columns = available;
  }
  columns = columns.slice(0, 6);

  const limit = Math.min(Math.max(Number(args.limit) || 8, 1), 25);
  const shown = rows.slice(0, limit).map((row) => {
    const out = {};
    for (const c of columns) out[c] = row[c] ?? null;
    return out;
  });

  return {
    surfaced: {
      kind: 'table',
      title,
      note,
      columns,
      rows: shown,
      total: rows.length,
      empty: false,
      from_tool: args.from_tool,
    },
    ...(warnings.length ? { warnings } : {}),
  };
}

module.exports = { show };
