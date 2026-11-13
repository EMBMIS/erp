/**
 * Chart authoring — Simeli designs the chart, the database supplies the numbers.
 *
 * WHAT WAS WRONG WITH THE OLD WAY
 * ---------------------------------------------------------------------------
 * `generate_chart` handed the model a classifier: return one of "line", "bar"
 * or "pie", plus an x_key and some y_keys. That is not authoring a chart, it is
 * choosing a template. Anything a real analysis needs — a forecast segment
 * drawn differently from actuals, a threshold line, a shaded projection window,
 * a note on the month things cross over, two series on different scales — was
 * simply unreachable. The model could not express it, so it wrote a paragraph
 * about it instead.
 *
 * Here the model writes the whole specification: layers, marks, colours,
 * emphasis, reference lines, bands, annotations, axis treatment. There is no
 * enum of chart types, because there is no fixed set of charts.
 *
 * THE ONE THING IT MAY NOT WRITE IS THE DATA
 * ---------------------------------------------------------------------------
 * A model that can type `[{month: "Nov", cash: 51400}]` into a chart
 * specification can draw a completely convincing picture of a business that
 * does not exist. So the spec has no data property at all. It has a `source`,
 * which is either a question executed as read-only SQL, or a reference to a
 * tool result from earlier in this same run. The rows are fetched here and
 * attached here.
 *
 * Every field the spec references is checked against the columns that actually
 * came back. A layer naming a column that does not exist is dropped and the
 * model is told, in the tool result, exactly which field was wrong and which
 * ones exist. That is what lets it redraw on the next step of the agent loop
 * rather than shipping a chart with a missing series.
 *
 * Reference lines get the same treatment. A rule may be `{ agg: 'avg', field:
 * 'revenue' }`, which is computed from the real rows, or a literal value — and
 * a literal must carry a `note` saying where the number came from. An
 * unexplained horizontal line labelled "Operating threshold" is a claim about
 * the company's finances; if the model wants to draw one it has to say who told
 * it that.
 */

// Lazily required: nlQuery pulls in the database pool, and this module is
// loaded by the tool registry at startup on deployments that may not have the
// reporting path configured. require is cached, so this costs nothing per call.
const nlQuery = () => require('./nlQuery');

// Marks the renderer knows how to draw. Not chart types — these compose: a
// forecast is an area plus a solid line plus a dashed line plus a band.
const MARKS = ['line', 'area', 'bar', 'point', 'step', 'arc'];

// Palette keys rather than raw hex, so a chart the model authors still belongs
// to the EMBMIS visual system instead of introducing its own colours.
const TONES = ['blue', 'cyan', 'violet', 'magenta', 'indigo', 'green', 'amber', 'rose', 'slate'];

const AGGS = ['avg', 'median', 'min', 'max', 'sum', 'first', 'last'];

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Numbers only, and only real ones. Strings that look numeric are accepted. */
function numeric(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * Resolve where the rows come from.
 *
 * @param source.query      a business question → safe read-only SQL via nlQuery
 * @param source.from_tool  the name of a tool that already ran in this turn
 * @param source.path       optional key inside that tool's result holding the rows
 */
async function resolveSource(source, ctx = {}) {
  if (!isObj(source)) {
    return { error: 'A chart needs a source: either { query } or { from_tool }. It may not carry its own data.' };
  }

  if (source.from_tool) {
    const prior = ctx.toolResults?.[source.from_tool];
    if (prior === undefined) {
      const ran = Object.keys(ctx.toolResults || {});
      return {
        error: `No tool named "${source.from_tool}" has run in this conversation turn.`
          + (ran.length ? ` Tools that have run: ${ran.join(', ')}.` : ' No tools have run yet — call one first.'),
      };
    }

    // Walk to the rows. Without a path, take the longest array of objects,
    // which is the same rule the result digests use.
    let rows = null;
    if (source.path) {
      rows = source.path.split('.').reduce((acc, key) => (isObj(acc) || Array.isArray(acc) ? acc?.[key] : undefined), prior);
      if (!Array.isArray(rows)) {
        return {
          error: `"${source.path}" in the result of ${source.from_tool} is not a list of rows.`
            + ` Available keys: ${isObj(prior) ? Object.keys(prior).join(', ') : typeof prior}.`,
        };
      }
    } else {
      rows = Array.isArray(prior) ? prior : longestRowList(prior);
      if (!rows) {
        return {
          error: `The result of ${source.from_tool} has no list of rows to chart.`
            + ` Pass a "path" naming the field that holds them.`
            + (isObj(prior) ? ` Available keys: ${Object.keys(prior).join(', ')}.` : ''),
        };
      }
    }

    const columns = rows.length ? Object.keys(rows[0]) : [];
    return { rows, columns, provenance: { kind: 'tool', tool: source.from_tool, path: source.path || null } };
  }

  if (source.query) {
    // explain:false — the prose summary costs a model call and the chart is the
    // output here, not a paragraph about it.
    const result = await nlQuery().ask(source.query, { explain: false });
    if (!result.answered) {
      return { error: result.error || 'That question could not be turned into a query.' };
    }
    return {
      rows: result.rows || [],
      columns: result.columns || [],
      provenance: { kind: 'query', question: source.query, sql: result.sql, truncated: !!result.truncated },
    };
  }

  return { error: 'A chart source needs either { query } or { from_tool }.' };
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

/** Compute a reference line from the rows themselves. */
function aggregate(agg, field, rows) {
  const values = rows.map((r) => numeric(r[field])).filter((n) => n !== null);
  if (!values.length) return null;
  switch (agg) {
    case 'avg': return values.reduce((s, n) => s + n, 0) / values.length;
    case 'sum': return values.reduce((s, n) => s + n, 0);
    case 'min': return Math.min(...values);
    case 'max': return Math.max(...values);
    case 'first': return values[0];
    case 'last': return values[values.length - 1];
    case 'median': {
      const sorted = [...values].sort((a, b) => a - b);
      const mid = Math.floor(sorted.length / 2);
      return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
    }
    default: return null;
  }
}

/**
 * Check the model's specification against the data that actually came back.
 *
 * Returns the cleaned spec plus every problem found. The problems are the
 * important half: they go back to the model as the tool result so it can fix
 * the chart on the next step rather than the user seeing a broken one.
 */
/**
 * Validate one presentation — the layers, rules, bands and annotations that
 * make up a single view of the data.
 *
 * Split out of validate() so a named view gets exactly the same column checking
 * as the default one. A view is an alternative way of looking at the same rows,
 * not a second chance to reference a column that does not exist.
 */
function validatePresentation(src, rows, columns, warnings, where) {
  const has = (field) => columns.includes(field);
  const known = () => columns.join(', ') || '(none — the query returned no columns)';
  const prefix = where ? `${where}: ` : '';
  const out = { layers: [], rules: [], bands: [], annotations: [] };

  const layers = Array.isArray(src.layers) ? src.layers : [];
  for (const layer of layers.slice(0, 8)) {
    if (!isObj(layer)) continue;
    if (!layer.field || !has(layer.field)) {
      warnings.push(`${prefix}Layer field ${layer.field ? `"${layer.field}" is not a column` : 'is missing'} and was dropped. Columns available: ${known()}.`);
      continue;
    }
    const anyNumeric = rows.some((r) => numeric(r[layer.field]) !== null);
    if (!anyNumeric) {
      warnings.push(`${prefix}Layer "${layer.field}" was dropped: none of its values are numeric.`);
      continue;
    }
    out.layers.push({
      mark: MARKS.includes(layer.mark) ? layer.mark : 'line',
      field: layer.field,
      label: typeof layer.label === 'string' ? layer.label.slice(0, 60) : layer.field,
      tone: TONES.includes(layer.tone) ? layer.tone : 'blue',
      dashed: !!layer.dashed,
      points: !!layer.points,
      opacity: Math.min(Math.max(Number(layer.opacity) || (layer.mark === 'area' ? 0.18 : 1), 0.04), 1),
      from: layer.from ?? null,
      to: layer.to ?? null,
      axis: layer.axis === 'right' ? 'right' : 'left',
      stack: typeof layer.stack === 'string' ? layer.stack.slice(0, 40) : null,
    });
  }

  for (const rule of (Array.isArray(src.rules) ? src.rules : []).slice(0, 4)) {
    if (!isObj(rule)) continue;
    let value = null;
    let note = typeof rule.note === 'string' ? rule.note.slice(0, 160) : null;

    if (rule.agg) {
      if (!AGGS.includes(rule.agg)) {
        warnings.push(`${prefix}Rule agg "${rule.agg}" is not one of: ${AGGS.join(', ')}. The rule was dropped.`);
        continue;
      }
      if (!rule.field || !has(rule.field)) {
        warnings.push(`${prefix}Rule agg field ${rule.field ? `"${rule.field}" is not a column` : 'is missing'}. The rule was dropped.`);
        continue;
      }
      value = aggregate(rule.agg, rule.field, rows);
      if (value === null) {
        warnings.push(`${prefix}Rule "${rule.agg} of ${rule.field}" could not be computed: no numeric values.`);
        continue;
      }
      note = note || `${rule.agg} of ${rule.field}, computed from the ${rows.length} rows shown`;
    } else {
      value = numeric(rule.value);
      if (value === null) {
        warnings.push(`${prefix}A rule had no agg and no numeric value, and was dropped.`);
        continue;
      }
      if (!note) {
        warnings.push(
          `${prefix}The rule at ${value} was dropped because it has no "note". A fixed reference line is a claim about the business `
          + '— say where the number came from (the user, a tool result, a policy), or use { agg, field } to compute one from the data.',
        );
        continue;
      }
    }

    out.rules.push({
      value,
      label: typeof rule.label === 'string' ? rule.label.slice(0, 60) : null,
      note,
      tone: TONES.includes(rule.tone) ? rule.tone : 'amber',
      computed: !!rule.agg,
    });
  }

  for (const band of (Array.isArray(src.bands) ? src.bands : []).slice(0, 4)) {
    if (!isObj(band) || band.from === undefined || band.to === undefined) continue;
    out.bands.push({
      from: band.from,
      to: band.to,
      label: typeof band.label === 'string' ? band.label.slice(0, 60) : null,
      tone: TONES.includes(band.tone) ? band.tone : 'violet',
    });
  }

  for (const note of (Array.isArray(src.annotations) ? src.annotations : []).slice(0, 6)) {
    if (!isObj(note) || note.x === undefined || !note.text) continue;
    if (note.field && !has(note.field)) {
      warnings.push(`${prefix}Annotation field "${note.field}" is not a column and the annotation was dropped.`);
      continue;
    }
    out.annotations.push({
      x: note.x,
      field: note.field || out.layers[0]?.field || null,
      text: String(note.text).slice(0, 120),
      tone: TONES.includes(note.tone) ? note.tone : 'cyan',
    });
  }

  return out;
}

function validate(spec, rows, columns) {
  const warnings = [];
  const has = (field) => columns.includes(field);
  const known = () => columns.join(', ') || '(none — the query returned no columns)';

  const out = {
    title: typeof spec.title === 'string' ? spec.title.slice(0, 120) : 'Chart',
    subtitle: typeof spec.subtitle === 'string' ? spec.subtitle.slice(0, 200) : null,
    layers: [],
    rules: [],
    bands: [],
    annotations: [],
    legend: spec.legend !== false,
    stacked: !!spec.stacked,
    height: Math.min(Math.max(Number(spec.height) || 260, 160), 520),
  };

  // --- x axis --------------------------------------------------------------
  const x = isObj(spec.x) ? spec.x : {};
  if (!x.field || !has(x.field)) {
    warnings.push(`x.field ${x.field ? `"${x.field}" is not a column` : 'is missing'}. Columns available: ${known()}.`);
    out.x = { field: columns[0] || null, label: null, type: 'category' };
  } else {
    out.x = {
      field: x.field,
      label: typeof x.label === 'string' ? x.label.slice(0, 60) : null,
      type: ['category', 'temporal', 'quantitative'].includes(x.type) ? x.type : 'category',
    };
  }

  // --- y axis --------------------------------------------------------------
  const y = isObj(spec.y) ? spec.y : {};
  out.y = {
    label: typeof y.label === 'string' ? y.label.slice(0, 60) : null,
    // Zero-based by default: a truncated y-axis exaggerates a change, which on
    // a financial chart is a way of being misleading without any wrong numbers.
    // The model may turn it off, and the renderer marks the axis when it does.
    zero: y.zero !== false,
    format: ['number', 'compact', 'percent'].includes(y.format) ? y.format : 'compact',
  };

  // --- presentations -------------------------------------------------------
  //
  // A chart may carry named views: alternative ways of looking at the SAME
  // rows, which the reader flips between with a chip. The data never changes —
  // only which layers are drawn — so a view cannot show a different number, and
  // each is column-checked exactly like the default.
  const base = validatePresentation(spec, rows, columns, warnings, null);
  out.layers = base.layers;
  out.rules = base.rules;
  out.bands = base.bands;
  out.annotations = base.annotations;

  const views = Array.isArray(spec.views) ? spec.views.slice(0, 5) : [];
  out.views = [];
  for (const view of views) {
    if (!isObj(view) || !view.label) continue;
    const label = String(view.label).slice(0, 40);
    const p = validatePresentation(view, rows, columns, warnings, `View "${label}"`);
    if (!p.layers.length) {
      warnings.push(`View "${label}" was dropped: no layer in it survived validation.`);
      continue;
    }
    out.views.push({
      label,
      subtitle: typeof view.subtitle === 'string' ? view.subtitle.slice(0, 200) : null,
      ...p,
    });
  }

  // When a chart has BOTH a default presentation and named views, the default
  // becomes the first chip rather than being silently dropped. The model wrote
  // it; something it wrote should not disappear because it also offered
  // alternatives. It is what the chart opens on either way.
  if (out.views.length && out.layers.length) {
    out.views.unshift({
      label: typeof spec.default_label === 'string' ? spec.default_label.slice(0, 40) : 'Overview',
      subtitle: out.subtitle,
      layers: out.layers,
      rules: out.rules,
      bands: out.bands,
      annotations: out.annotations,
    });
  } else if (out.views.length) {
    // Views only: the chart opens on the first one.
    const [first] = out.views;
    out.layers = first.layers;
    out.rules = first.rules;
    out.bands = first.bands;
    out.annotations = first.annotations;
    if (!out.subtitle) out.subtitle = first.subtitle;
  }

  if (!out.layers.length) warnings.push('No layers were given, so there is nothing to draw.');

  return { spec: out, warnings };
}

/**
 * Build a renderable chart from the model's specification.
 *
 * @returns {{chart_spec, warnings, provenance, row_count}} or {error}
 */
async function render(spec, ctx = {}) {
  if (!isObj(spec)) return { error: 'The chart specification must be an object.' };

  const resolved = await resolveSource(spec.source, ctx);
  if (resolved.error) return { error: resolved.error };

  const { rows, columns, provenance } = resolved;
  if (!rows.length) {
    return {
      error: 'The source returned no rows, so there is nothing to chart. Say that plainly rather than drawing an empty chart.',
      provenance,
    };
  }

  const { spec: clean, warnings } = validate(spec, rows, columns);

  if (!clean.layers.length) {
    return {
      error: 'No layer survived validation, so there is nothing to draw.',
      warnings,
      columns,
      provenance,
    };
  }

  // Rows ride along whole — this is the rendered object, not a summary of one.
  // Capped, because a chart of 4,000 points is not a chart.
  const MAX_POINTS = 400;
  clean.data = rows.slice(0, MAX_POINTS);
  clean.provenance = provenance;
  if (rows.length > MAX_POINTS) {
    warnings.push(`Only the first ${MAX_POINTS} of ${rows.length} rows are plotted. Aggregate in the query if the whole set matters.`);
    clean.truncated = { shown: MAX_POINTS, total: rows.length };
  }

  return {
    chart_spec: clean,
    // The point of returning these: the model sees what went wrong and redraws
    // on the next step of the loop instead of the user seeing a broken chart.
    warnings,
    columns,
    row_count: rows.length,
    provenance,
  };
}

module.exports = { render, validate, resolveSource, aggregate, MARKS, TONES, AGGS };
