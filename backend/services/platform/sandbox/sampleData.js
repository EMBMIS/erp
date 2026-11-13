/**
 * Plausible sample records for a specification that has not been deployed.
 *
 * ===========================================================================
 * WHY PREVIEW NEEDS DATA AT ALL
 * ===========================================================================
 * An application previewed with no rows is a set of empty tables and charts
 * with no bars, which tells the user nothing about whether the design is right.
 * The whole point of showing them the application before it exists is that they
 * look at it and say "the severity should come before the category" — and they
 * cannot say that about an empty screen.
 *
 * ===========================================================================
 * WHY THE DATA IS FAKE, AND OBVIOUSLY SO
 * ===========================================================================
 * Nothing here touches the database. Not "writes and rolls back" — does not
 * touch it. A preview of an application that has not been approved must not be
 * able to read the company's real records, because the specification it is
 * previewing has not been through the deployment gate that checks what it would
 * expose.
 *
 * The values are deterministic from a seed, so the same specification previews
 * identically every time — a preview that reshuffled on every refresh would
 * make it impossible to tell a design change from noise. And they are visibly
 * synthetic ("Sample supplier 3"), so nobody mistakes a preview for their data.
 */

const ROWS_PER_ENTITY = 12;

/** A tiny deterministic PRNG — same specification, same preview, every time. */
function seeded(seed) {
  let state = 0;
  for (let i = 0; i < seed.length; i += 1) state = (state * 31 + seed.charCodeAt(i)) >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function buildPreview(spec) {
  const rand = seeded(spec.key || 'preview');
  const records = {};

  spec.data.entities.forEach((entity) => {
    records[entity.key] = [];
    for (let i = 0; i < ROWS_PER_ENTITY; i += 1) {
      records[entity.key].push(buildRecord(spec, entity, i, rand, records));
    }
  });

  const metrics = (spec.analytics?.metrics || []).map((metric) => {
    const query = (spec.analytics.queries || []).find((q) => q.key === metric.query);
    return { key: metric.key, label: metric.label, format: metric.format, value: computeMetric(query, records) };
  });

  const queries = {};
  (spec.analytics?.queries || []).forEach((query) => {
    queries[query.key] = computeQuery(query, records);
  });

  return { records, metrics, queries, synthetic: true, rowsPerEntity: ROWS_PER_ENTITY };
}

function buildRecord(spec, entity, index, rand, records) {
  const record = { id: `preview-${entity.key}-${index}`, __preview: true };
  entity.fields.forEach((field) => {
    record[field.name] = sampleValue(spec, entity, field, index, rand, records);
  });
  (entity.computed || []).forEach((computed) => {
    // Computed fields are evaluated with the real interpreter, so a preview
    // shows what the expression actually produces — including that it produces
    // nothing sensible, which is worth seeing before deployment.
    try {
      const expressions = require('../spec/expressions');
      record[computed.name] = expressions.evaluate(expressions.parse(computed.expression), record, {});
    } catch {
      record[computed.name] = null;
    }
  });
  record.created_at = daysAgo(index * 3 + 1);
  record.updated_at = daysAgo(index * 2);
  return record;
}

function sampleValue(spec, entity, field, index, rand, records) {
  switch (field.type) {
    case 'enum': {
      const values = field.values || [];
      if (!values.length) return null;
      return values[Math.floor(rand() * values.length) % values.length];
    }
    case 'boolean': return rand() > 0.5;
    case 'integer': return Math.floor(rand() * 100);
    case 'bigint': return Math.floor(rand() * 100000);
    case 'decimal': return Math.round(rand() * 10000) / 100;
    case 'money': return Math.round(rand() * 500000) / 100;
    case 'percent': return Math.round(rand() * 10000) / 100;
    case 'duration_hours': return Math.round(rand() * 400) / 10;
    case 'date': return daysAgo(Math.floor(rand() * 180)).slice(0, 10);
    case 'datetime': return daysAgo(Math.floor(rand() * 180));
    case 'email': return `contact${index + 1}@example.invalid`;
    case 'phone': return `+44 20 7000 ${String(1000 + index).slice(0, 4)}`;
    case 'url': return `https://example.invalid/${entity.key}/${index + 1}`;
    case 'long_text':
      return `Sample ${field.label.toLowerCase()} for ${entity.singular.toLowerCase()} ${index + 1}. This text is generated for the preview and is not real data.`;
    case 'json': return { sample: true, index: index + 1 };
    case 'geo_point':
      return { lat: Math.round((51.5 + (rand() - 0.5) * 2) * 1e6) / 1e6, lng: Math.round((-0.12 + (rand() - 0.5) * 2) * 1e6) / 1e6 };
    case 'reference': {
      if (field.target?.kind === 'app') {
        const parents = records[field.target.entity];
        if (parents?.length) return parents[index % parents.length].id;
        return null;
      }
      // A canonical reference in a preview is a label, not an id: the preview
      // has not read the company's suppliers and must not appear to have.
      return `preview-${field.target?.entity || 'record'}-${(index % 5) + 1}`;
    }
    default:
      if (entity.display?.title_field === field.name) {
        return `${entity.singular} ${String(index + 1).padStart(3, '0')}`;
      }
      return `${field.label} ${index + 1}`;
  }
}

/** Labels for canonical references, so a preview table is readable. */
function previewLabel(value) {
  if (typeof value !== 'string' || !value.startsWith('preview-')) return value;
  const parts = value.split('-');
  return `Sample ${parts[1].replace(/_/g, ' ')} ${parts[2]}`;
}

function computeQuery(query, records) {
  const rows = records[query.entity] || [];
  const expressions = require('../spec/expressions');
  const filtered = query.filter
    ? rows.filter((r) => { try { return expressions.evaluate(expressions.parse(query.filter), r, {}); } catch { return true; } })
    : rows;

  const bucketOf = (row) => {
    if (query.time_grain && query.date_field) {
      const d = new Date(row[query.date_field]);
      if (Number.isNaN(d.getTime())) return 'unknown';
      return query.time_grain === 'year' ? String(d.getUTCFullYear())
        : query.time_grain === 'month' ? `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`
          : d.toISOString().slice(0, 10);
    }
    if (query.group_by) return previewLabel(row[query.group_by]) ?? 'unknown';
    return null;
  };

  const groups = new Map();
  filtered.forEach((row) => {
    const key = bucketOf(row);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  });

  const aggregate = (group) => {
    switch (query.aggregation) {
      case 'count': case 'percent_of_total': return group.length;
      case 'count_distinct': return new Set(group.map((r) => r[query.field])).size;
      case 'sum': return round(group.reduce((s, r) => s + Number(r[query.field] || 0), 0));
      case 'avg': return group.length ? round(group.reduce((s, r) => s + Number(r[query.field] || 0), 0) / group.length) : 0;
      case 'min': return round(Math.min(...group.map((r) => Number(r[query.field] || 0))));
      case 'max': return round(Math.max(...group.map((r) => Number(r[query.field] || 0))));
      case 'median': {
        const values = group.map((r) => Number(r[query.field] || 0)).sort((a, b) => a - b);
        return values.length ? round(values[Math.floor(values.length / 2)]) : 0;
      }
      default: return group.length;
    }
  };

  let rowsOut = [...groups.entries()].map(([bucket, group]) => ({
    bucket, label: bucket === null ? query.label : String(bucket), value: aggregate(group),
  }));

  if (query.time_grain) rowsOut.sort((a, b) => String(a.bucket).localeCompare(String(b.bucket)));
  else rowsOut.sort((a, b) => (query.order === 'asc' ? a.value - b.value : b.value - a.value));
  rowsOut = rowsOut.slice(0, query.limit || 50);

  if (query.aggregation === 'percent_of_total') {
    const total = rowsOut.reduce((s, r) => s + r.value, 0);
    rowsOut.forEach((r) => { r.value = total ? round((r.value / total) * 100) : 0; });
  }

  return {
    key: query.key, label: query.label, entity: query.entity,
    grouped: !!(query.group_by || query.time_grain), timeGrain: query.time_grain || null,
    rows: rowsOut, total: rowsOut.reduce((s, r) => s + r.value, 0), synthetic: true,
  };
}

function computeMetric(query, records) {
  if (!query) return 0;
  return computeQuery(query, records).total;
}

const round = (n) => Math.round(n * 100) / 100;
const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString();

module.exports = { buildPreview, previewLabel, ROWS_PER_ENTITY };
