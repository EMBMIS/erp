/**
 * Administering portal accounts: invite, grant, revoke.
 *
 * Every route is administrator-only, and every one of them is a decision about
 * who outside the company can see some of its data — which is why revocation is
 * a first-class endpoint rather than a status edit, and why granting a
 * membership names an application, a surface and a role rather than "access".
 */

const express = require('express');
const router = express.Router();

const { auth } = require('../../middleware/auth');
const { handler, requireAdmin, companyOf, userOf } = require('./_shared');
const identity = require('../../services/platform/runtime/externalIdentity');
const registry = require('../../services/platform/registry');
const canonical = require('../../services/platform/spec/canonical');

router.use(auth, requireAdmin);

router.get('/', handler(async (req, res) => {
  const instanceId = typeof req.query.instanceId === 'string' ? req.query.instanceId : null;
  res.json({ success: true, data: await identity.listIdentities({ companyId: companyOf(req), instanceId }) });
}));

/**
 * Invite someone outside the company.
 *
 * Returns the invitation token ONCE. It is stored only as a hash, so a lost
 * invitation is reissued rather than looked up — which is the property that
 * makes a database dump useless for getting into a portal.
 */
router.post('/', handler(async (req, res) => {
  const result = await identity.invite({
    companyId: companyOf(req),
    subjectKind: req.body?.subjectKind,
    subjectId: req.body?.subjectId,
    email: req.body?.email,
    displayName: req.body?.displayName,
    invitedBy: userOf(req),
  });
  await registry.recordEvent({
    companyId: companyOf(req),
    eventType: 'portal.identity_invited',
    provenanceClass: 'authorization',
    actorKind: 'user', actorId: userOf(req),
    summary: `Invited ${result.identity.email} as a ${result.identity.subject_kind} portal account.`,
    detail: { subjectKind: result.identity.subject_kind, subjectId: result.identity.subject_id },
  });
  res.status(201).json({ success: true, data: result });
}));

router.get('/anchors/:kind', handler(async (req, res) => {
  const entityKey = canonical.ANCHOR_ENTITIES[req.params.kind];
  if (!entityKey) {
    return res.status(400).json({
      success: false,
      error: `"${req.params.kind}" is not a kind of external identity that can be anchored.`,
      code: 'BAD_SUBJECT_KIND',
    });
  }
  const entity = canonical.entity(entityKey);
  const { quoteIdent } = require('../../services/platform/identifiers');
  const companyContext = require('../../services/companyContext');
  const search = typeof req.query.search === 'string' ? `%${req.query.search}%` : '%';
  const rows = await companyContext.withCompany(companyOf(req), async (client) => {
    const display = entity.display.filter((c) => entity.columns[c]);
    const { rows: found } = await client.query(
      `SELECT ${quoteIdent('id')} AS id, ${display.map((c) => quoteIdent(c)).join(', ')}
         FROM ${quoteIdent(entity.table)}
        WHERE ${display.map((c) => `${quoteIdent(c)}::text ILIKE $1`).join(' OR ')}
        ORDER BY ${quoteIdent(display[0])} LIMIT 50`,
      [search]
    );
    return found;
  });
  res.json({
    success: true,
    data: rows.map((r) => ({ id: r.id, label: entity.display.map((c) => r[c]).filter(Boolean).join(' · ') })),
  });
}));

router.get('/:identityId/memberships', handler(async (req, res) => {
  res.json({
    success: true,
    data: await identity.listMemberships({ companyId: companyOf(req), identityId: req.params.identityId }),
  });
}));

router.post('/:identityId/memberships', handler(async (req, res) => {
  const membership = await identity.grantMembership({
    companyId: companyOf(req),
    identityId: req.params.identityId,
    instanceId: req.body?.instanceId,
    surfaceKey: req.body?.surfaceKey,
    roleKey: req.body?.roleKey,
    grantedBy: userOf(req),
  });
  res.status(201).json({ success: true, data: membership });
}));

router.delete('/memberships/:membershipId', handler(async (req, res) => {
  res.json({
    success: true,
    data: await identity.revokeMembership({
      companyId: companyOf(req), membershipId: req.params.membershipId, revokedBy: userOf(req),
    }),
  });
}));

/** Total revocation: memberships, credentials and live sessions, at once. */
router.post('/:identityId/revoke', handler(async (req, res) => {
  res.json({
    success: true,
    data: await identity.revokeIdentity({
      companyId: companyOf(req), identityId: req.params.identityId, revokedBy: userOf(req),
    }),
  });
}));

module.exports = router;
