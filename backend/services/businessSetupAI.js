/**
 * AI-assisted business type suggestion for self-service signup.
 *
 * A new company picks a business type at signup (backend/services/
 * moduleService.js), which seeds a sensible default module set. Choosing
 * from 24 codes cold is friction a one-line description removes: describe
 * the business in plain language, get a suggested type back to confirm or
 * override — never applied silently.
 *
 * Best-effort only: no AI key configured, a timeout, or a nonsense response
 * all degrade to "no suggestion" rather than blocking signup. Picking a
 * business type manually is a completely normal path, not a fallback state.
 */

const { getAIClient, AI_MODEL_FAST, isAIEnabled } = require('../config/aiConfig');
const moduleService = require('./moduleService');

async function suggestBusinessType(description) {
  const text = String(description || '').trim();
  if (!text || !isAIEnabled()) return null;

  try {
    const types = await moduleService.listBusinessTypes();
    const client = getAIClient();
    const response = await client.chat.completions.create({
      model: AI_MODEL_FAST,
      messages: [
        {
          role: 'system',
          content:
            'Given a short business description, pick the single best-matching business type from the list below. ' +
            'Respond with ONLY the code — no punctuation, no explanation.\n\n' +
            types.map((t) => `${t.code}: ${t.name} — ${t.description}`).join('\n'),
        },
        { role: 'user', content: text.slice(0, 500) },
      ],
      temperature: 0,
      max_tokens: 20,
    });

    const code = response.choices?.[0]?.message?.content?.trim();
    const match = types.find((t) => t.code === code);
    return match ? { ...match, from_description: text } : null;
  } catch (err) {
    console.error('suggestBusinessType: AI suggestion failed:', err.message);
    return null;
  }
}

module.exports = { suggestBusinessType };
