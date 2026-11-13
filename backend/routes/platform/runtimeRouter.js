/**
 * The generic application runtime API, shared by the internal side and every
 * portal.
 *
 * ===========================================================================
 * ONE ROUTER, TWO KINDS OF CALLER
 * ===========================================================================
 * The internal side and a supplier portal serve exactly the same endpoints. The
 * ONLY difference is how the principal is built: an employee's roles come from
 * their assignments, a portal user's come from their membership and carry an
 * anchor. Everything after that — visibility, field access, workflow
 * requirements — reads the principal and does not care which kind it is.
 *
 * That is the design working. If the portal needed its own list endpoint, the
 * portal would need its own filtering, and the second implementation of "only
 * their own records" is where the leak lives. There is one implementation, in
 * authorization.recordScopeClause, and both callers go through it.
 *
 * Note what the caller never supplies: a table name, a schema, a SQL fragment,
 * a company id, or their own anchor. They supply an application key, an entity
 * key, field names and values. The server resolves the rest.
 */

const express = require('express');
const multer = require('multer');

const { handler } = require('./_shared');
const { scopedMulter } = require('../../middleware/scopedMulter');
const resolver = require('../../services/platform/runtime/resolver');
const page = require('../../services/platform/runtime/page');
const data = require('../../services/platform/runtime/data');
const analytics = require('../../services/platform/runtime/analytics');
const workflowRuntime = require('../../services/platform/runtime/workflow');
const collaboration = require('../../services/platform/runtime/collaboration');
const automation = require('../../services/platform/runtime/automation');
const attachmentStorage = require('../../services/platform/runtime/attachmentStorage');
const companyContext = require('../../services/companyContext');

// ---------------------------------------------------------------------------
// Attachment uploads.
//
// The bytes go wherever runtime/attachmentStorage.js puts them — object storage
// when it is configured, local disk otherwise — so a multi-replica deployment
// does not serve 404s for files that landed on a different container's disk.
//
// Multer holds the file in memory rather than writing it, because the storage
// layer wants a buffer and the size limit bounds what that can cost. The type
// list is closed for the same reason every other vocabulary here is: anything a
// browser would execute is absent.
// ---------------------------------------------------------------------------
const MAX_ATTACHMENT_BYTES = Number(process.env.PLATFORM_ATTACHMENT_MAX_BYTES || 20 * 1024 * 1024);

const ALLOWED_ATTACHMENT_TYPES = new Set([
  'application/pdf', 'text/plain', 'text/csv',
  'image/png', 'image/jpeg', 'image/gif', 'image/webp',
  'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
]);

const attachmentUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_ATTACHMENT_BYTES, files: 1 },
  fileFilter(req, file, cb) {
    if (!ALLOWED_ATTACHMENT_TYPES.has(file.mimetype)) {
      cb(new Error('That kind of file cannot be attached here.'));
      return;
    }
    cb(null, true);
  },
});

/**
 * @param {(req, context) => Promise<object>} principalFor
 *        Builds the principal. The one thing that differs between the internal
 *        mount and a portal mount.
 * @param {(req) => string} companyFor
 */
function runtimeRouter({ principalFor, companyFor }) {
  const router = express.Router({ mergeParams: true });

  /** Resolve application + principal once, for every route below. */
  const load = async (req) => {
    const companyId = companyFor(req);
    const context = await resolver.resolveApplication(companyId, req.params.appKey);
    const principal = await principalFor(req, context);
    return { companyId, context, principal };
  };

  const parseFilters = (req) => {
    const raw = req.query.filters;
    if (!raw) return [];
    let parsed;
    try {
      parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    } catch {
      return [];
    }
    if (!Array.isArray(parsed)) return [];
    // Shape only. Whether a field may be filtered on at all is decided by
    // data.buildWhere against the specification and the principal.
    return parsed
      .filter((f) => f && typeof f.field === 'string' && typeof f.operator === 'string')
      .slice(0, 20)
      .map((f) => ({ field: f.field, operator: f.operator, value: f.value ?? null }));
  };

  const listOptions = (req) => ({
    filters: parseFilters(req),
    search: typeof req.query.search === 'string' ? req.query.search : '',
    sort: typeof req.query.sort === 'string' ? req.query.sort : null,
    direction: req.query.direction === 'asc' ? 'asc' : 'desc',
    page: Number(req.query.page) || 1,
    pageSize: Number(req.query.pageSize) || 25,
  });

  // -- shell ---------------------------------------------------------------
  router.get('/:appKey', handler(async (req, res) => {
    const { context, principal } = await load(req);
    res.json({ success: true, data: page.shell(context, principal) });
  }));

  // -- pages ---------------------------------------------------------------
  router.get('/:appKey/pages/:pageKey', handler(async (req, res) => {
    const { context, principal } = await load(req);
    const rendered = await page.render(context, principal, req.params.pageKey, {
      ...listOptions(req),
      recordId: typeof req.query.recordId === 'string' ? req.query.recordId : null,
    });
    res.json({ success: true, data: rendered });
  }));

  // -- records -------------------------------------------------------------
  router.get('/:appKey/entities/:entityKey', handler(async (req, res) => {
    const { context, principal } = await load(req);
    res.json({ success: true, data: await data.list(context, principal, req.params.entityKey, listOptions(req)) });
  }));

  router.get('/:appKey/entities/:entityKey/:recordId', handler(async (req, res) => {
    const { context, principal } = await load(req);
    res.json({ success: true, data: await data.get(context, principal, req.params.entityKey, req.params.recordId) });
  }));

  router.post('/:appKey/entities/:entityKey', handler(async (req, res) => {
    const { companyId, context, principal } = await load(req);
    const record = await data.create(context, principal, req.params.entityKey, req.body?.values || req.body || {});
    // Automations run after the write, outside its transaction: a failing
    // notification must not roll back a record the user successfully saved.
    fireAndForget(companyId, () => automation.dispatch(context, {
      kind: 'record_created', entityKey: req.params.entityKey, recordId: record.id, record,
    }));
    res.status(201).json({ success: true, data: record });
  }));

  router.patch('/:appKey/entities/:entityKey/:recordId', handler(async (req, res) => {
    const { companyId, context, principal } = await load(req);
    const record = await data.update(
      context, principal, req.params.entityKey, req.params.recordId, req.body?.values || req.body || {}
    );
    fireAndForget(companyId, () => automation.dispatch(context, {
      kind: 'record_updated', entityKey: req.params.entityKey, recordId: record.id, record,
    }));
    res.json({ success: true, data: record });
  }));

  router.delete('/:appKey/entities/:entityKey/:recordId', handler(async (req, res) => {
    const { context, principal } = await load(req);
    res.json({ success: true, data: await data.remove(context, principal, req.params.entityKey, req.params.recordId) });
  }));

  router.get('/:appKey/entities/:entityKey/:recordId/related/:relatedEntity/:field', handler(async (req, res) => {
    const { context, principal } = await load(req);
    const result = await data.related(
      context, principal, req.params.relatedEntity, req.params.field, req.params.recordId, listOptions(req)
    );
    res.json({ success: true, data: result });
  }));

  // -- canonical EMBMIS data (read-only, for pickers and reference columns) --
  router.get('/:appKey/canonical/:entityKey', handler(async (req, res) => {
    const { context, principal } = await load(req);
    const result = await data.listCanonical(context, principal, req.params.entityKey, {
      search: typeof req.query.search === 'string' ? req.query.search : '',
      pageSize: Number(req.query.pageSize) || 50,
    });
    res.json({ success: true, data: result });
  }));

  // -- analytics -----------------------------------------------------------
  router.get('/:appKey/metrics', handler(async (req, res) => {
    const { context, principal } = await load(req);
    const keys = typeof req.query.keys === 'string' ? req.query.keys.split(',').filter(Boolean) : [];
    res.json({ success: true, data: await analytics.metrics(context, principal, keys) });
  }));

  router.get('/:appKey/queries/:queryKey', handler(async (req, res) => {
    const { context, principal } = await load(req);
    res.json({ success: true, data: await analytics.run(context, principal, req.params.queryKey) });
  }));

  // -- workflow ------------------------------------------------------------
  router.get('/:appKey/entities/:entityKey/:recordId/transitions', handler(async (req, res) => {
    const { context, principal } = await load(req);
    const workflow = resolver.workflowForEntity(context.spec, req.params.entityKey);
    if (!workflow) return res.json({ success: true, data: { workflow: null, transitions: [] } });
    const record = await data.get(context, principal, req.params.entityKey, req.params.recordId);
    res.json({
      success: true,
      data: {
        workflow: { key: workflow.key, label: workflow.label, stateField: workflow.state_field, states: workflow.states },
        current: record[workflow.state_field],
        transitions: workflowRuntime.availableTransitions(context.spec, workflow, record, principal),
      },
    });
  }));

  router.post('/:appKey/entities/:entityKey/:recordId/transitions/:transitionKey', handler(async (req, res) => {
    const { companyId, context, principal } = await load(req);
    const result = await workflowRuntime.transition(
      context, principal, req.params.entityKey, req.params.recordId, req.params.transitionKey,
      { reason: req.body?.reason || '' }
    );
    fireAndForget(companyId, () => automation.dispatch(context, {
      kind: 'state_changed',
      entityKey: req.params.entityKey,
      recordId: req.params.recordId,
      record: result.record,
      workflow: result.workflow,
      toState: result.to,
    }));
    res.json({ success: true, data: result });
  }));

  router.get('/:appKey/entities/:entityKey/:recordId/history', handler(async (req, res) => {
    const { context, principal } = await load(req);
    res.json({
      success: true,
      data: await workflowRuntime.history(context, principal, req.params.entityKey, req.params.recordId),
    });
  }));

  router.get('/:appKey/workflows/:workflowKey/sla-breaches', handler(async (req, res) => {
    const { context, principal } = await load(req);
    res.json({ success: true, data: await workflowRuntime.slaBreaches(context, principal, req.params.workflowKey) });
  }));

  // -- collaboration -------------------------------------------------------
  router.get('/:appKey/entities/:entityKey/:recordId/comments', handler(async (req, res) => {
    const { context, principal } = await load(req);
    res.json({
      success: true,
      data: await collaboration.listComments(context, principal, req.params.entityKey, req.params.recordId),
    });
  }));

  router.post('/:appKey/entities/:entityKey/:recordId/comments', handler(async (req, res) => {
    const { context, principal } = await load(req);
    const comment = await collaboration.addComment(
      context, principal, req.params.entityKey, req.params.recordId,
      { body: req.body?.body, visibility: req.body?.visibility }
    );
    res.status(201).json({ success: true, data: comment });
  }));

  router.get('/:appKey/entities/:entityKey/:recordId/activity', handler(async (req, res) => {
    const { context, principal } = await load(req);
    res.json({
      success: true,
      data: await collaboration.activity(context, principal, req.params.entityKey, req.params.recordId),
    });
  }));

  router.get('/:appKey/entities/:entityKey/:recordId/attachments', handler(async (req, res) => {
    const { context, principal } = await load(req);
    res.json({
      success: true,
      data: await collaboration.listAttachments(context, principal, req.params.entityKey, req.params.recordId),
    });
  }));

  router.post(
    '/:appKey/entities/:entityKey/:recordId/attachments',
    scopedMulter(attachmentUpload.single('file')),
    handler(async (req, res) => {
      if (!req.file) {
        return res.status(400).json({ success: false, error: 'No file was attached.', code: 'NO_FILE' });
      }
      const { context, principal } = await load(req);

      const storageKey = await attachmentStorage.put({
        instanceId: context.instance.id,
        entityKey: req.params.entityKey,
        originalName: req.file.originalname,
        buffer: req.file.buffer,
        contentType: req.file.mimetype,
      });

      try {
        const attachment = await collaboration.addAttachment(
          context, principal, req.params.entityKey, req.params.recordId,
          {
            fileName: req.file.originalname,
            contentType: req.file.mimetype,
            byteSize: req.file.size,
            storageKey,
            visibility: req.body?.visibility,
          }
        );
        return res.status(201).json({ success: true, data: attachment });
      } catch (error) {
        // The row was refused, so the bytes should not linger either.
        await attachmentStorage.remove(storageKey);
        throw error;
      }
    })
  );

  /**
   * Download one attachment.
   *
   * Authorization is not "do you have the id": listAttachments applies the
   * principal's visibility (which reads the record first, which applies their
   * record scope), so an attachment that is not in their list is not fetchable
   * with its id either.
   */
  router.get('/:appKey/entities/:entityKey/:recordId/attachments/:attachmentId', handler(async (req, res) => {
    const { context, principal } = await load(req);
    const visible = await collaboration.listAttachments(
      context, principal, req.params.entityKey, req.params.recordId
    );
    const attachment = visible.find((a) => a.id === req.params.attachmentId);
    if (!attachment) {
      return res.status(404).json({ success: false, error: 'No such document.', code: 'ATTACHMENT_NOT_FOUND' });
    }

    const storageKey = await collaboration.storagePathFor(context, req.params.attachmentId);
    const stream = await attachmentStorage.open(storageKey);
    if (!stream) {
      return res.status(404).json({
        success: false, error: 'That document is no longer stored.', code: 'ATTACHMENT_MISSING',
      });
    }

    res.setHeader('Content-Type', attachment.content_type || 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${String(attachment.file_name).replace(/["\r\n]/g, '')}"`);
    stream.on('error', () => res.destroy());
    return stream.pipe(res);
  }));

  // -- notifications -------------------------------------------------------
  router.get('/:appKey/notifications', handler(async (req, res) => {
    const { companyId, context, principal } = await load(req);
    const rows = await companyContext.withCompany(companyId, async (client) => {
      const { rows: found } = await client.query(
        `SELECT id, subject, body, entity_key, record_id, read_at, created_at
           FROM app_notifications
          WHERE app_instance_id = $1
            AND ( (recipient_kind = 'user' AND recipient_user_id = $2)
               OR (recipient_kind = 'role' AND recipient_role = ANY($3))
               OR (recipient_kind = 'external' AND recipient_external_id = $4) )
          ORDER BY created_at DESC LIMIT 100`,
        [context.instance.id, principal.userId, principal.roleKeys, principal.externalIdentityId]
      );
      return found;
    });
    res.json({ success: true, data: rows });
  }));

  return router;
}

/**
 * Run automation without making the user wait for it, and without letting it
 * fail their request.
 *
 * The company context has to be carried in explicitly: the request's own
 * AsyncLocalStorage scope is gone by the time this runs.
 */
function fireAndForget(companyId, fn) {
  const { asCompany } = require('../../services/platform/db');
  setImmediate(() => {
    asCompany(companyId, fn).catch((error) => {
      console.error('[platform] automation dispatch failed:', error.message);
    });
  });
}

module.exports = { runtimeRouter };
