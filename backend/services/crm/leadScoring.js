/**
 * AI lead scoring for the CRM leads pipeline (routes/leads.js).
 *
 * `ai_score` (leads.ai_score, migration 135_phase4_depth.sql) was a bare
 * PATCH-able integer with no algorithm behind it anywhere in the codebase —
 * whatever a caller sent, stuck. This is the actual scoring logic, deliberately
 * NOT an LLM call: the inputs are a handful of structured signals already on
 * the row (or one join away), a rules-based score is instant, free, and fully
 * explainable to a sales rep, and none of that needs a model in the loop.
 *
 * Score is 0-100, built additively from independent signals and clamped at
 * the end — see SCORE_WEIGHTS below for the exact point values.
 */

const { pool } = require('../../config/database');

const SCORE_WEIGHTS = {
  companySize: 20,
  sourceReferral: 30,
  sourceWebsite: 15,
  sourceColdOutreach: 5,
  perActivity: 5,
  maxActivityScore: 25,
  dealSizeLarge: 20,   // potential_value > 50000
  dealSizeMedium: 10,  // potential_value > 10000
  recency: 10,         // created in the last 30 days
  missingPhonePenalty: -10,
  missingCompanyPenalty: -10,
};

const ENTERPRISE_PATTERN = /\b(enterprise|corp(?:oration)?|inc|ltd|llc|holdings?|group)\b/i;

// Free-text source field (no enum) — REFERRAL/WEBSITE/COLD_OUTREACH per spec,
// plus the values the lead-creation UI already offers (TRADE_SHOW, COLD_CALL).
const REFERRAL_SOURCES = new Set(['REFERRAL']);
const WEBSITE_SOURCES = new Set(['WEBSITE']);
const COLD_OUTREACH_SOURCES = new Set(['COLD_OUTREACH', 'COLD_CALL']);

/**
 * Pure scoring function — no I/O, so it is trivially unit-testable and reusable
 * from both the save-to-DB path and anywhere that just wants a preview.
 *
 * @param {object} lead - a row from `leads` (company_name, notes, source,
 *   potential_value, phone, created_at).
 * @param {number} activityCount - activities logged against this lead.
 * @returns {{ score: number, breakdown: object }}
 */
function computeScore(lead, activityCount = 0) {
  const breakdown = {};

  // Company size signals in the name/notes.
  const sizeText = `${lead.company_name || ''} ${lead.notes || ''}`;
  breakdown.company_size = ENTERPRISE_PATTERN.test(sizeText) ? SCORE_WEIGHTS.companySize : 0;

  // Source quality.
  const source = String(lead.source || '').trim().toUpperCase();
  if (REFERRAL_SOURCES.has(source)) breakdown.source_quality = SCORE_WEIGHTS.sourceReferral;
  else if (WEBSITE_SOURCES.has(source)) breakdown.source_quality = SCORE_WEIGHTS.sourceWebsite;
  else if (COLD_OUTREACH_SOURCES.has(source)) breakdown.source_quality = SCORE_WEIGHTS.sourceColdOutreach;
  else breakdown.source_quality = 0;

  // Engagement: activities logged, capped.
  const activityPoints = Math.min(
    Math.max(Number(activityCount) || 0, 0) * SCORE_WEIGHTS.perActivity,
    SCORE_WEIGHTS.maxActivityScore
  );
  breakdown.engagement = activityPoints;

  // Deal size.
  const value = Number(lead.potential_value) || 0;
  if (value > 50000) breakdown.deal_size = SCORE_WEIGHTS.dealSizeLarge;
  else if (value > 10000) breakdown.deal_size = SCORE_WEIGHTS.dealSizeMedium;
  else breakdown.deal_size = 0;

  // Recency.
  const createdAt = lead.created_at ? new Date(lead.created_at) : null;
  const ageDays = createdAt ? (Date.now() - createdAt.getTime()) / (24 * 60 * 60 * 1000) : Infinity;
  breakdown.recency = ageDays <= 30 ? SCORE_WEIGHTS.recency : 0;

  // Missing-data penalties.
  breakdown.missing_phone = lead.phone && String(lead.phone).trim() ? 0 : SCORE_WEIGHTS.missingPhonePenalty;
  breakdown.missing_company = lead.company_name && String(lead.company_name).trim() ? 0 : SCORE_WEIGHTS.missingCompanyPenalty;

  const raw = Object.values(breakdown).reduce((sum, v) => sum + v, 0);
  const score = Math.max(0, Math.min(100, Math.round(raw)));

  return { score, breakdown };
}

/** Look up a lead's activity count. */
async function countActivities(leadId) {
  const { rows } = await pool.query('SELECT COUNT(*)::int AS n FROM activities WHERE lead_id = $1', [leadId]);
  return rows[0]?.n || 0;
}

/**
 * Compute and persist a lead's score. Returns the updated lead row plus the
 * breakdown, so a caller (route, or the auto-rescore hook) can show its work
 * rather than just a bare number.
 */
async function scoreLead(leadId) {
  const { rows } = await pool.query('SELECT * FROM leads WHERE id = $1 AND deleted_at IS NULL', [leadId]);
  const lead = rows[0];
  if (!lead) throw new Error('Lead not found.');

  const activityCount = await countActivities(leadId);
  const { score, breakdown } = computeScore(lead, activityCount);

  const { rows: [updated] } = await pool.query(
    'UPDATE leads SET ai_score = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2 RETURNING *',
    [score, leadId]
  );

  return { lead: updated, score, breakdown, activity_count: activityCount };
}

module.exports = { computeScore, scoreLead, countActivities, SCORE_WEIGHTS };
