/**
 * Chart Generator — turns a natural-language question into a chart specification.
 *
 * Uses nlQuery.js for SQL generation/execution (safe, validated, read-only),
 * then asks the model to suggest the best chart type and axis mapping from the
 * actual column names and a few sample rows. The result is a structured chart
 * spec the frontend renders with Recharts.
 *
 * This is a pure read operation — no writes, no side effects.
 */

const { getAIClient } = require('../../config/aiConfig');
const { AI_MODEL_FAST } = require('../../config/aiConfig');
const nlQuery = require('./nlQuery');

/**
 * @param {string} question — business question in plain language
 * @param {object} [opts]
 * @param {string} [opts.chart_type] — optional hint: 'line' | 'bar' | 'pie'
 * @returns {{ chart_spec: object|null, data: object, sql: string, error: string|null }}
 */
async function ask(question, opts = {}) {
  // 1. Generate and execute SQL via the existing NL query pipeline.
  //    This is the safe, validated path — no raw SQL from the model.
  const queryResult = await nlQuery.ask(question, { explain: false });
  if (!queryResult.answered) {
    return {
      chart_spec: null,
      data: null,
      sql: queryResult.sql || '',
      error: queryResult.error || 'Could not answer that question.',
    };
  }

  const { columns, rows, sql } = queryResult;
  if (!rows || rows.length === 0) {
    return {
      chart_spec: null,
      data: { columns, rows: [] },
      sql,
      error: 'The query returned no data to chart.',
    };
  }

  // 2. Ask the model to suggest the best chart given the question + data shape.
  const chartType = opts.chart_type || null;
  const chartSpec = await inferChartSpec(question, columns, rows, chartType);

  // 3. Merge the real row data into the chart spec for immediate rendering.
  if (chartSpec) {
    chartSpec.data = rows;
  }

  return { chart_spec: chartSpec, data: { columns, rows }, sql, error: null };
}

/**
 * Ask the model to pick the best chart type and axis mapping for the data.
 * Uses AI_MODEL_FAST since this is a cheap classification task (~50 tokens).
 */
async function inferChartSpec(question, columns, rows, hintType) {
  const client = getAIClient();
  const sample = rows.slice(0, 5);

  const systemPrompt = `You are a chart-type classifier. Given a business question, column names, and sample \
data rows, return a JSON object describing the best chart to render.

Rules:
- chart_type must be one of: "line", "bar", "pie"
- x_key is the column for the X axis (categories, dates, labels). For pie charts, this is the label key.
- y_keys is an array of numeric column(s) for the Y axis / values. For pie charts, use exactly one.
- title is a short, human-readable chart title derived from the question.
- Choose "line" for time-series (months, quarters, dates on X).
- Choose "bar" for comparisons across categories.
- Choose "pie" for part-to-whole composition (with a meaningful total).
- If the data has exactly one date/timestamp column and one numeric column, prefer "line".
- If the user asked for a specific chart type, honour that.

Respond with ONLY valid JSON — no markdown, no explanation.`;

  const userMessage = `Question: "${question}"
${hintType ? `User requested chart type: ${hintType}` : ''}

Columns: ${JSON.stringify(columns)}

Sample rows (first ${sample.length}):
${JSON.stringify(sample)}

Return JSON:
{
  "chart_type": "line" | "bar" | "pie",
  "title": "Human-readable chart title",
  "x_key": "column_name_for_x_axis_or_labels",
  "y_keys": ["column_name_for_values"]
}`;

  try {
    const response = await client.chat.completions.create({
      model: AI_MODEL_FAST,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMessage },
      ],
      temperature: 0.2,
      max_tokens: 300,
      response_format: { type: 'json_object' },
    });

    const raw = response.choices?.[0]?.message?.content || '{}';
    const parsed = JSON.parse(raw);

    // Validate the spec has the required fields
    if (!parsed.chart_type || !parsed.x_key || !parsed.y_keys) {
      return null;
    }
    if (!['line', 'bar', 'pie'].includes(parsed.chart_type)) {
      parsed.chart_type = 'bar'; // safe default
    }
    if (!Array.isArray(parsed.y_keys)) {
      parsed.y_keys = [parsed.y_keys];
    }

    return parsed;
  } catch (err) {
    console.error('Chart spec inference error:', err.message);
    return null;
  }
}

module.exports = { ask, inferChartSpec };
