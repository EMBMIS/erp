/**
 * Requirement text -> design brief, without a language model.
 *
 * ===========================================================================
 * WHAT THIS IS FOR, AND WHAT IT IS NOT
 * ===========================================================================
 * The Studio's first choice is always the model: it is far better at reading
 * "we need to track supplier quality problems and let suppliers respond" and
 * deciding what a finding is. This file is what happens when there is no model
 * configured, when the model is unreachable, or when what it produced does not
 * validate twice running.
 *
 * It is a genuine fallback, not a stub. It reads the requirement for the
 * business process it names, composes a real data model with a real workflow
 * and real external surfaces, and hands that to the composer — which produces
 * the same complete application it would from a model-authored brief. An
 * application built this way is smaller and blunter than one a model would
 * design. It still works, still deploys, and can still be iterated on.
 *
 * ===========================================================================
 * WHY A LEXICON AND NOT A PARSER
 * ===========================================================================
 * There is no honest way to derive a data model from English with regular
 * expressions. What there IS an honest way to do is recognise a business
 * process by the vocabulary it uses — "finding", "corrective action",
 * "warranty claim", "inspection" — and know in advance what each of those
 * needs, because those are well-understood processes with well-understood
 * shapes.
 *
 * So this is a lexicon of processes, and a general-purpose fallback for a
 * requirement it does not recognise. The general case produces a tracker: a
 * titled record with a status, a priority, an owner, a due date and a
 * workflow. That is a real, useful application for a process nobody has
 * modelled, and it is honest about being generic rather than pretending to
 * understand.
 */

const canonical = require('../spec/canonical');

const STANDARD_PRIORITY = {
  name: 'priority', label: 'Priority', type: 'enum',
  values: ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'], required: true, default: 'MEDIUM', indexed: true,
};

const OPEN_WORKFLOW = (entityKey, stateField = 'status') => ({
  key: `${entityKey}_flow`,
  label: 'Progress',
  entity: entityKey,
  state_field: stateField,
  states: [
    { key: 'OPEN', label: 'Open', initial: true, color: 'amber' },
    { key: 'IN_PROGRESS', label: 'In progress', color: 'blue' },
    { key: 'BLOCKED', label: 'Blocked', color: 'red' },
    { key: 'DONE', label: 'Done', terminal: true, color: 'emerald' },
    { key: 'CANCELLED', label: 'Cancelled', terminal: true, color: 'slate' },
  ],
  transitions: [
    { key: 'start', label: 'Start work', from: 'OPEN', to: 'IN_PROGRESS' },
    { key: 'block', label: 'Mark blocked', from: 'IN_PROGRESS', to: 'BLOCKED', requires: [{ type: 'comment' }] },
    { key: 'unblock', label: 'Unblock', from: 'BLOCKED', to: 'IN_PROGRESS' },
    { key: 'complete', label: 'Complete', from: 'IN_PROGRESS', to: 'DONE', requires: [{ type: 'role', role: 'manager' }] },
    { key: 'cancel', label: 'Cancel', from: 'OPEN', to: 'CANCELLED', requires: [{ type: 'comment' }] },
  ],
  slas: [{ state: 'OPEN', hours: 72, escalate_to_role: 'manager', label: 'Open longer than three days' }],
});

/**
 * The process lexicon.
 *
 * Each pack: the words that select it, the entities it contributes, the
 * workflow, and which external audience (if any) it implies. Packs compose —
 * a requirement mentioning both quality findings and corrective actions gets
 * both, wired together.
 */
const PACKS = [
  {
    key: 'supplier_quality',
    match: /(supplier|vendor).*(quality|non.?conformance|defect|finding|audit)|quality.*(supplier|vendor)/i,
    canonicalRefs: ['suppliers', 'purchase_orders', 'goods_receipts'],
    audiences: ['supplier'],
    entities: [
      {
        key: 'quality_findings',
        label: 'Quality Findings',
        singular: 'Quality Finding',
        description: 'A quality problem observed with a supplier, and its resolution.',
        primary: true,
        anchor: { field: 'supplier_id', kind: 'supplier' },
        display: { title_field: 'title' },
        fields: [
          { name: 'reference', label: 'Reference', type: 'text', required: true, unique: true },
          { name: 'title', label: 'Summary', type: 'text', required: true },
          { name: 'detail', label: 'What was found', type: 'long_text', required: true },
          { name: 'supplier_id', label: 'Supplier', type: 'reference', required: true, indexed: true,
            target: { kind: 'canonical', entity: 'suppliers', on_delete: 'restrict' }, externalWritable: false },
          { name: 'purchase_order_id', label: 'Purchase order', type: 'reference',
            target: { kind: 'canonical', entity: 'purchase_orders', on_delete: 'set_null' }, externalWritable: false },
          { name: 'category', label: 'Category', type: 'enum', required: true, default: 'PRODUCT',
            values: ['PRODUCT', 'DOCUMENTATION', 'DELIVERY', 'PROCESS', 'SAFETY'] },
          { name: 'severity', label: 'Severity', type: 'enum', required: true, default: 'MEDIUM',
            values: ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'], indexed: true },
          { name: 'status', label: 'Status', type: 'enum', required: true, default: 'OPEN',
            values: ['OPEN', 'ASSIGNED', 'SUPPLIER_RESPONSE', 'INTERNAL_REVIEW', 'CORRECTIVE_ACTION', 'VERIFIED', 'CLOSED', 'REJECTED'],
            indexed: true },
          { name: 'raised_on', label: 'Raised on', type: 'date', required: true, default: 'now' },
          { name: 'response_due', label: 'Response due', type: 'date' },
          // Marked sensitive: the company's own view of how bad this is, and
          // what it thinks it costs, is not the supplier's to read.
          { name: 'internal_assessment', label: 'Internal assessment', type: 'long_text', sensitive: true },
          { name: 'cost_impact', label: 'Cost impact', type: 'money', sensitive: true },
          { name: 'risk_score', label: 'Risk score', type: 'decimal', sensitive: true },
        ],
        computed: [
          { name: 'days_open', label: 'Days open', expression: 'days_since(raised_on)', result_type: 'integer' },
        ],
        indexes: [{ fields: ['supplier_id', 'status'] }],
        constraints: [
          { key: 'due_after_raised', expression: 'response_due = null or response_due >= raised_on',
            message: 'A response cannot be due before the finding was raised.' },
        ],
      },
      {
        key: 'corrective_actions',
        label: 'Corrective Actions',
        singular: 'Corrective Action',
        description: 'What the supplier will do about a finding, and whether it worked.',
        anchor: { field: 'supplier_id', kind: 'supplier' },
        display: { title_field: 'action' },
        fields: [
          { name: 'action', label: 'Action', type: 'text', required: true },
          { name: 'finding_id', label: 'Finding', type: 'reference', required: true, indexed: true,
            target: { kind: 'app', entity: 'quality_findings', on_delete: 'cascade' }, externalWritable: false },
          { name: 'supplier_id', label: 'Supplier', type: 'reference', required: true, indexed: true,
            target: { kind: 'canonical', entity: 'suppliers', on_delete: 'restrict' }, externalWritable: false },
          { name: 'root_cause', label: 'Root cause', type: 'long_text', required: true },
          { name: 'status', label: 'Status', type: 'enum', required: true, default: 'PROPOSED',
            values: ['PROPOSED', 'ACCEPTED', 'IN_PROGRESS', 'COMPLETED', 'VERIFIED', 'REJECTED'], indexed: true },
          { name: 'due_date', label: 'Due date', type: 'date' },
          { name: 'completed_on', label: 'Completed on', type: 'date' },
          { name: 'verification_note', label: 'Verification note', type: 'long_text', sensitive: true },
        ],
      },
      {
        key: 'supplier_assessments',
        label: 'Supplier Assessments',
        singular: 'Supplier Assessment',
        description: 'A periodic judgement of how a supplier is performing.',
        anchor: { field: 'supplier_id', kind: 'supplier' },
        display: { title_field: 'period' },
        fields: [
          { name: 'period', label: 'Period', type: 'text', required: true },
          { name: 'supplier_id', label: 'Supplier', type: 'reference', required: true, indexed: true,
            target: { kind: 'canonical', entity: 'suppliers', on_delete: 'restrict' }, externalWritable: false },
          { name: 'assessed_on', label: 'Assessed on', type: 'date', required: true, default: 'now' },
          { name: 'quality_score', label: 'Quality score', type: 'percent' },
          { name: 'delivery_score', label: 'Delivery score', type: 'percent' },
          { name: 'overall_rating', label: 'Overall rating', type: 'enum', required: true, default: 'ACCEPTABLE',
            values: ['EXCELLENT', 'GOOD', 'ACCEPTABLE', 'AT_RISK', 'UNACCEPTABLE'], indexed: true },
          { name: 'status', label: 'Status', type: 'enum', required: true, default: 'DRAFT',
            values: ['DRAFT', 'PUBLISHED', 'ARCHIVED'] },
          { name: 'internal_commentary', label: 'Internal commentary', type: 'long_text', sensitive: true },
        ],
      },
    ],
    workflows: [
      {
        key: 'finding_flow', label: 'Finding lifecycle', entity: 'quality_findings', state_field: 'status',
        states: [
          { key: 'OPEN', label: 'Open', initial: true, color: 'amber' },
          { key: 'ASSIGNED', label: 'Assigned to supplier', color: 'blue' },
          { key: 'SUPPLIER_RESPONSE', label: 'Supplier responded', color: 'violet' },
          { key: 'INTERNAL_REVIEW', label: 'Internal review', color: 'indigo' },
          { key: 'CORRECTIVE_ACTION', label: 'Corrective action', color: 'cyan' },
          { key: 'VERIFIED', label: 'Verified', color: 'teal' },
          { key: 'CLOSED', label: 'Closed', terminal: true, color: 'emerald' },
          { key: 'REJECTED', label: 'Rejected', terminal: true, color: 'slate' },
        ],
        transitions: [
          { key: 'assign', label: 'Assign to supplier', from: 'OPEN', to: 'ASSIGNED', requires: [{ type: 'role', role: 'contributor' }] },
          { key: 'respond', label: 'Submit response', from: 'ASSIGNED', to: 'SUPPLIER_RESPONSE', requires: [{ type: 'comment' }] },
          { key: 'review', label: 'Start review', from: 'SUPPLIER_RESPONSE', to: 'INTERNAL_REVIEW', requires: [{ type: 'role', role: 'manager' }] },
          { key: 'request_action', label: 'Require corrective action', from: 'INTERNAL_REVIEW', to: 'CORRECTIVE_ACTION', requires: [{ type: 'role', role: 'manager' }] },
          { key: 'send_back', label: 'Send back to supplier', from: 'INTERNAL_REVIEW', to: 'ASSIGNED', requires: [{ type: 'comment' }] },
          { key: 'verify', label: 'Verify', from: 'CORRECTIVE_ACTION', to: 'VERIFIED',
            requires: [{ type: 'role', role: 'manager' }, { type: 'evidence' }] },
          // Closing a high-severity finding needs someone with approval
          // authority, and cannot be done by whoever raised it. That is the
          // segregation-of-duties rule the process actually has.
          { key: 'close', label: 'Close', from: 'VERIFIED', to: 'CLOSED',
            requires: [{ type: 'approval', role: 'manager' }, { type: 'authority' }] },
          { key: 'reject', label: 'Reject', from: 'OPEN', to: 'REJECTED', requires: [{ type: 'comment' }, { type: 'role', role: 'manager' }] },
        ],
        slas: [
          { state: 'ASSIGNED', hours: 120, escalate_to_role: 'manager', label: 'Supplier has not responded in five days' },
          { state: 'INTERNAL_REVIEW', hours: 72, escalate_to_role: 'manager', label: 'Review outstanding for three days' },
        ],
      },
      {
        key: 'action_flow', label: 'Corrective action lifecycle', entity: 'corrective_actions', state_field: 'status',
        states: [
          { key: 'PROPOSED', label: 'Proposed', initial: true, color: 'amber' },
          { key: 'ACCEPTED', label: 'Accepted', color: 'blue' },
          { key: 'IN_PROGRESS', label: 'In progress', color: 'cyan' },
          { key: 'COMPLETED', label: 'Completed', color: 'teal' },
          { key: 'VERIFIED', label: 'Verified', terminal: true, color: 'emerald' },
          { key: 'REJECTED', label: 'Rejected', terminal: true, color: 'slate' },
        ],
        transitions: [
          { key: 'accept', label: 'Accept', from: 'PROPOSED', to: 'ACCEPTED', requires: [{ type: 'role', role: 'manager' }] },
          { key: 'reject', label: 'Reject', from: 'PROPOSED', to: 'REJECTED', requires: [{ type: 'comment' }, { type: 'role', role: 'manager' }] },
          { key: 'begin', label: 'Begin', from: 'ACCEPTED', to: 'IN_PROGRESS' },
          { key: 'complete', label: 'Mark complete', from: 'IN_PROGRESS', to: 'COMPLETED', requires: [{ type: 'evidence' }] },
          { key: 'verify', label: 'Verify', from: 'COMPLETED', to: 'VERIFIED', requires: [{ type: 'approval', role: 'manager' }] },
        ],
        slas: [{ state: 'IN_PROGRESS', hours: 336, escalate_to_role: 'manager', label: 'Action running more than two weeks' }],
      },
    ],
    externalEntities: { supplier: ['quality_findings', 'corrective_actions', 'supplier_assessments'] },
    externalWritable: { supplier: ['corrective_actions'] },
    externalNotifyStates: { finding_flow: ['ASSIGNED', 'CORRECTIVE_ACTION'], action_flow: ['ACCEPTED', 'REJECTED'] },
    identity: {
      key: 'supplier_quality', name: 'Supplier Quality Management', icon: 'shield-check', category: 'procurement',
      description: 'Records quality problems with suppliers, runs them through review and corrective action, and lets suppliers respond to their own findings without seeing anyone else\'s.',
    },
  },

  {
    key: 'supplier_risk',
    // "Create a supplier risk monitor" — the monitor is live, computed from
    // purchasing (canonical live measures); what the application OWNS is what
    // people decide about it: reviews of a risky supplier, and the mitigation
    // actions that come out of them, each approved by a manager.
    match: /(supplier|vendor).*(risk|reliab|monitor|scorecard|performance|watch|exposure)|(risk|reliab|exposure).*(supplier|vendor)/i,
    canonicalRefs: ['suppliers', 'purchase_orders', 'items'],
    liveMonitors: ['suppliers'],
    audiences: [],
    entities: [
      {
        key: 'risk_reviews',
        label: 'Risk Reviews',
        singular: 'Risk Review',
        description: 'A supplier the monitor flagged, what a person concluded about it, and what is being done.',
        primary: true,
        display: { title_field: 'title' },
        fields: [
          { name: 'reference', label: 'Reference', type: 'text', required: true, unique: true },
          { name: 'title', label: 'Summary', type: 'text', required: true },
          { name: 'supplier_id', label: 'Supplier', type: 'reference', required: true, indexed: true,
            target: { kind: 'canonical', entity: 'suppliers', on_delete: 'restrict' } },
          { name: 'risk_band', label: 'Risk at review', type: 'enum', required: true, default: 'HIGH',
            values: ['LOW', 'MEDIUM', 'HIGH'], indexed: true },
          { name: 'signal', label: 'What the monitor showed', type: 'long_text', required: true },
          { name: 'decision', label: 'Decision', type: 'enum', required: true, default: 'MITIGATE',
            values: ['ACCEPT', 'MITIGATE', 'DUAL_SOURCE', 'EXIT'] },
          { name: 'status', label: 'Status', type: 'enum', required: true, default: 'OPEN',
            values: ['OPEN', 'IN_REVIEW', 'MITIGATING', 'CLOSED', 'ACCEPTED'], indexed: true },
          { name: 'raised_on', label: 'Raised on', type: 'date', required: true, default: 'now' },
          { name: 'review_due', label: 'Review due', type: 'date' },
          { name: 'exposure', label: 'Exposure at review', type: 'money', sensitive: true },
        ],
        computed: [
          { name: 'days_open', label: 'Days open', expression: 'days_since(raised_on)', result_type: 'integer' },
        ],
        indexes: [{ fields: ['supplier_id', 'status'] }],
      },
      {
        key: 'mitigation_actions',
        label: 'Mitigation Actions',
        singular: 'Mitigation Action',
        description: 'What will be done about a supplier risk, approved by a manager before it starts.',
        display: { title_field: 'action' },
        fields: [
          { name: 'action', label: 'Action', type: 'text', required: true },
          { name: 'review_id', label: 'Risk review', type: 'reference', required: true, indexed: true,
            target: { kind: 'app', entity: 'risk_reviews', on_delete: 'cascade' } },
          { name: 'supplier_id', label: 'Supplier', type: 'reference', required: true, indexed: true,
            target: { kind: 'canonical', entity: 'suppliers', on_delete: 'restrict' } },
          { name: 'item_id', label: 'Item', type: 'reference',
            target: { kind: 'canonical', entity: 'items', on_delete: 'set_null' } },
          { name: 'action_type', label: 'Type', type: 'enum', required: true, default: 'CHASE',
            values: ['CHASE', 'SECOND_SOURCE', 'SAFETY_STOCK', 'RENEGOTIATE', 'SUPPLIER_REVIEW', 'OTHER'] },
          { name: 'status', label: 'Status', type: 'enum', required: true, default: 'PROPOSED',
            values: ['PROPOSED', 'APPROVED', 'IN_PROGRESS', 'DONE', 'REJECTED'], indexed: true },
          { name: 'due_date', label: 'Due date', type: 'date' },
          { name: 'estimated_cost', label: 'Estimated cost', type: 'money', sensitive: true },
        ],
      },
    ],
    workflows: [
      {
        key: 'review_flow', label: 'Risk review', entity: 'risk_reviews', state_field: 'status',
        states: [
          { key: 'OPEN', label: 'Open', initial: true, color: 'amber' },
          { key: 'IN_REVIEW', label: 'In review', color: 'blue' },
          { key: 'MITIGATING', label: 'Mitigating', color: 'violet' },
          { key: 'CLOSED', label: 'Closed', terminal: true, color: 'emerald' },
          { key: 'ACCEPTED', label: 'Risk accepted', terminal: true, color: 'slate' },
        ],
        transitions: [
          { key: 'review', label: 'Start review', from: 'OPEN', to: 'IN_REVIEW' },
          { key: 'mitigate', label: 'Mitigate', from: 'IN_REVIEW', to: 'MITIGATING', requires: [{ type: 'comment' }] },
          { key: 'accept', label: 'Accept the risk', from: 'IN_REVIEW', to: 'ACCEPTED',
            requires: [{ type: 'comment' }, { type: 'approval', role: 'manager' }] },
          { key: 'close', label: 'Close', from: 'MITIGATING', to: 'CLOSED', requires: [{ type: 'approval', role: 'manager' }] },
        ],
        slas: [{ state: 'OPEN', hours: 48, escalate_to_role: 'manager', label: 'A flagged supplier not looked at in two days' }],
      },
      {
        key: 'mitigation_flow', label: 'Mitigation', entity: 'mitigation_actions', state_field: 'status',
        states: [
          { key: 'PROPOSED', label: 'Proposed', initial: true, color: 'amber' },
          { key: 'APPROVED', label: 'Approved', color: 'blue' },
          { key: 'IN_PROGRESS', label: 'In progress', color: 'cyan' },
          { key: 'DONE', label: 'Done', terminal: true, color: 'emerald' },
          { key: 'REJECTED', label: 'Rejected', terminal: true, color: 'slate' },
        ],
        transitions: [
          { key: 'approve', label: 'Approve', from: 'PROPOSED', to: 'APPROVED', requires: [{ type: 'approval', role: 'manager' }] },
          { key: 'reject', label: 'Reject', from: 'PROPOSED', to: 'REJECTED', requires: [{ type: 'comment' }, { type: 'role', role: 'manager' }] },
          { key: 'begin', label: 'Begin', from: 'APPROVED', to: 'IN_PROGRESS' },
          { key: 'complete', label: 'Mark done', from: 'IN_PROGRESS', to: 'DONE', requires: [{ type: 'comment' }] },
        ],
      },
    ],
    externalEntities: {},
    externalWritable: {},
    externalNotifyStates: {},
    identity: {
      key: 'supplier_risk_monitor', name: 'Supplier Risk Monitor', icon: 'shield-alert', category: 'procurement',
      description: 'Watches every supplier live — reliability, lead time, open exposure, single sources and the customer orders at risk — and runs the reviews and manager-approved mitigations that follow.',
    },
  },
  {
    key: 'warehouse_twin',
    // "You need a digital twin of your warehouse" — the twin is live, drawn
    // from placed stock, goods issues and the delivery trace (canonical live
    // measures on storage locations); what the application OWNS is what
    // people do about a bay: count it when the shelf and the record disagree,
    // and move stock between bays, each adjustment or move approved by a
    // manager before it counts.
    match: /digital twin|\btwin\b.*(warehouse|stock|inventory|site)|(warehouse|storage).*(twin|map|layout|floor ?plan|model|3d|spatial|visuali[sz])|(bays?|bins?|racks?|racking).*(map|layout|twin|cover|view)/i,
    canonicalRefs: ['storage_locations', 'inventory_items', 'items', 'sales_orders'],
    liveMonitors: ['storage_locations'],
    audiences: [],
    entities: [
      {
        key: 'bay_checks',
        label: 'Bay Checks',
        singular: 'Bay Check',
        description: 'A bay the twin flagged, counted by someone on the floor; a difference is adjusted only once a manager approves it.',
        primary: true,
        display: { title_field: 'title' },
        fields: [
          { name: 'reference', label: 'Reference', type: 'text', required: true, unique: true },
          { name: 'title', label: 'Summary', type: 'text', required: true },
          { name: 'location_id', label: 'Location', type: 'reference', required: true, indexed: true,
            target: { kind: 'canonical', entity: 'storage_locations', on_delete: 'restrict' } },
          { name: 'bay_code', label: 'Bay', type: 'text', required: true, indexed: true },
          { name: 'item_id', label: 'Item', type: 'reference', indexed: true,
            target: { kind: 'canonical', entity: 'items', on_delete: 'set_null' } },
          { name: 'reason', label: 'Why', type: 'enum', required: true, default: 'SHORT_FOR_ORDER',
            values: ['SHORT_FOR_ORDER', 'LOW_COVER', 'RECORD_MISMATCH', 'DAMAGE', 'ROUTINE'], indexed: true },
          { name: 'expected_qty', label: 'Twin says', type: 'decimal' },
          { name: 'counted_qty', label: 'Counted', type: 'decimal' },
          { name: 'status', label: 'Status', type: 'enum', required: true, default: 'OPEN',
            values: ['OPEN', 'COUNTED', 'ADJUSTED', 'CLOSED'], indexed: true },
          { name: 'raised_on', label: 'Raised on', type: 'date', required: true, default: 'now' },
          { name: 'notes', label: 'Notes', type: 'long_text' },
        ],
        computed: [
          { name: 'days_open', label: 'Days open', expression: 'days_since(raised_on)', result_type: 'integer' },
        ],
        indexes: [{ fields: ['location_id', 'status'] }],
      },
      {
        key: 'slotting_moves',
        label: 'Slotting Moves',
        singular: 'Slotting Move',
        description: 'Stock to move from one bay to another — to the pick face, or towards the orders that need it — approved by a manager before anyone moves it.',
        display: { title_field: 'summary' },
        fields: [
          { name: 'summary', label: 'Move', type: 'text', required: true },
          { name: 'item_id', label: 'Item', type: 'reference', required: true, indexed: true,
            target: { kind: 'canonical', entity: 'items', on_delete: 'restrict' } },
          { name: 'from_location_id', label: 'From location', type: 'reference', required: true,
            target: { kind: 'canonical', entity: 'storage_locations', on_delete: 'restrict' } },
          { name: 'from_bay', label: 'From bay', type: 'text' },
          { name: 'to_location_id', label: 'To location', type: 'reference', required: true,
            target: { kind: 'canonical', entity: 'storage_locations', on_delete: 'restrict' } },
          { name: 'to_bay', label: 'To bay', type: 'text' },
          { name: 'quantity', label: 'Quantity', type: 'decimal', required: true },
          { name: 'for_order_id', label: 'For order', type: 'reference',
            target: { kind: 'canonical', entity: 'sales_orders', on_delete: 'set_null' } },
          { name: 'status', label: 'Status', type: 'enum', required: true, default: 'PROPOSED',
            values: ['PROPOSED', 'APPROVED', 'MOVED', 'REJECTED'], indexed: true },
          { name: 'due_date', label: 'Move by', type: 'date' },
        ],
      },
    ],
    workflows: [
      {
        key: 'bay_check_flow', label: 'Bay check', entity: 'bay_checks', state_field: 'status',
        states: [
          { key: 'OPEN', label: 'Open', initial: true, color: 'amber' },
          { key: 'COUNTED', label: 'Counted', color: 'blue' },
          { key: 'ADJUSTED', label: 'Adjustment approved', color: 'violet' },
          { key: 'CLOSED', label: 'Closed', terminal: true, color: 'emerald' },
        ],
        transitions: [
          { key: 'count', label: 'Record count', from: 'OPEN', to: 'COUNTED' },
          { key: 'adjust', label: 'Approve adjustment', from: 'COUNTED', to: 'ADJUSTED',
            requires: [{ type: 'comment' }, { type: 'approval', role: 'manager' }] },
          { key: 'close', label: 'Close — count matches', from: 'COUNTED', to: 'CLOSED' },
          { key: 'finish', label: 'Close', from: 'ADJUSTED', to: 'CLOSED' },
        ],
        slas: [{ state: 'OPEN', hours: 24, escalate_to_role: 'manager', label: 'A flagged bay not counted within a day' }],
      },
      {
        key: 'slotting_flow', label: 'Slotting move', entity: 'slotting_moves', state_field: 'status',
        states: [
          { key: 'PROPOSED', label: 'Proposed', initial: true, color: 'amber' },
          { key: 'APPROVED', label: 'Approved', color: 'blue' },
          { key: 'MOVED', label: 'Moved', terminal: true, color: 'emerald' },
          { key: 'REJECTED', label: 'Rejected', terminal: true, color: 'slate' },
        ],
        transitions: [
          { key: 'approve', label: 'Approve', from: 'PROPOSED', to: 'APPROVED', requires: [{ type: 'approval', role: 'manager' }] },
          { key: 'reject', label: 'Reject', from: 'PROPOSED', to: 'REJECTED', requires: [{ type: 'comment' }, { type: 'role', role: 'manager' }] },
          { key: 'moved', label: 'Mark moved', from: 'APPROVED', to: 'MOVED', requires: [{ type: 'comment' }] },
        ],
      },
    ],
    externalEntities: {},
    externalWritable: {},
    externalNotifyStates: {},
    identity: {
      key: 'warehouse_twin', name: 'Warehouse Twin', icon: 'warehouse', category: 'operations',
      description: 'A live model of every warehouse bay — stock, days of cover and the customer orders a short bay puts at risk — with the counts and manager-approved moves that follow.',
    },
  },
  {
    key: 'warranty',
    match: /warrant(y|ies)|(customer).*(claim|portal)|claim.*(customer|warranty)/i,
    canonicalRefs: ['customers', 'items', 'sales_orders'],
    audiences: ['customer'],
    entities: [
      {
        key: 'warranties',
        label: 'Warranties',
        singular: 'Warranty',
        description: 'A warranty held by a customer against something they bought.',
        anchor: { field: 'customer_id', kind: 'customer' },
        display: { title_field: 'warranty_number' },
        fields: [
          { name: 'warranty_number', label: 'Warranty number', type: 'text', required: true, unique: true },
          { name: 'customer_id', label: 'Customer', type: 'reference', required: true, indexed: true,
            target: { kind: 'canonical', entity: 'customers', on_delete: 'restrict' }, externalWritable: false },
          { name: 'item_id', label: 'Product', type: 'reference',
            target: { kind: 'canonical', entity: 'items', on_delete: 'set_null' } },
          { name: 'serial_number', label: 'Serial number', type: 'text', indexed: true },
          { name: 'starts_on', label: 'Cover starts', type: 'date', required: true },
          { name: 'ends_on', label: 'Cover ends', type: 'date', required: true },
          { name: 'status', label: 'Status', type: 'enum', required: true, default: 'ACTIVE',
            values: ['ACTIVE', 'EXPIRED', 'VOID'], indexed: true },
        ],
        constraints: [
          { key: 'cover_order', expression: 'ends_on >= starts_on', message: 'Cover cannot end before it starts.' },
        ],
      },
      {
        key: 'warranty_claims',
        label: 'Warranty Claims',
        singular: 'Warranty Claim',
        description: 'A customer\'s claim against a warranty, from submission to resolution.',
        primary: true,
        anchor: { field: 'customer_id', kind: 'customer' },
        display: { title_field: 'claim_number' },
        fields: [
          { name: 'claim_number', label: 'Claim number', type: 'text', required: true, unique: true },
          { name: 'customer_id', label: 'Customer', type: 'reference', required: true, indexed: true,
            target: { kind: 'canonical', entity: 'customers', on_delete: 'restrict' }, externalWritable: false },
          { name: 'warranty_id', label: 'Warranty', type: 'reference', indexed: true,
            target: { kind: 'app', entity: 'warranties', on_delete: 'set_null' } },
          { name: 'fault_description', label: 'What went wrong', type: 'long_text', required: true },
          { name: 'reported_on', label: 'Reported on', type: 'date', required: true, default: 'now' },
          { name: 'status', label: 'Status', type: 'enum', required: true, default: 'SUBMITTED',
            values: ['SUBMITTED', 'UNDER_REVIEW', 'INSPECTION', 'APPROVED', 'REPLACEMENT', 'REJECTED', 'CLOSED'], indexed: true },
          { name: 'resolution', label: 'Resolution', type: 'enum', default: 'PENDING',
            values: ['PENDING', 'REPAIR', 'REPLACE', 'REFUND', 'DECLINED'] },
          { name: 'target_resolution_date', label: 'Target resolution', type: 'date' },
          { name: 'assessed_cost', label: 'Assessed cost', type: 'money', sensitive: true },
          { name: 'internal_notes', label: 'Internal notes', type: 'long_text', sensitive: true },
        ],
        computed: [
          { name: 'days_open', label: 'Days open', expression: 'days_since(reported_on)', result_type: 'integer' },
        ],
      },
      {
        key: 'claim_inspections',
        label: 'Inspections',
        singular: 'Inspection',
        description: 'What an engineer found when they looked at the item.',
        anchor: { field: 'customer_id', kind: 'customer' },
        display: { title_field: 'summary' },
        fields: [
          { name: 'summary', label: 'Summary', type: 'text', required: true },
          { name: 'claim_id', label: 'Claim', type: 'reference', required: true, indexed: true,
            target: { kind: 'app', entity: 'warranty_claims', on_delete: 'cascade' }, externalWritable: false },
          { name: 'customer_id', label: 'Customer', type: 'reference', required: true, indexed: true,
            target: { kind: 'canonical', entity: 'customers', on_delete: 'restrict' }, externalWritable: false },
          { name: 'inspected_on', label: 'Inspected on', type: 'date', required: true, default: 'now' },
          { name: 'outcome', label: 'Outcome', type: 'enum', required: true, default: 'PENDING',
            values: ['PENDING', 'COVERED', 'NOT_COVERED', 'INCONCLUSIVE'], indexed: true },
          { name: 'engineer_notes', label: 'Engineer notes', type: 'long_text', sensitive: true },
        ],
      },
    ],
    workflows: [{
      key: 'claim_flow', label: 'Claim lifecycle', entity: 'warranty_claims', state_field: 'status',
      states: [
        { key: 'SUBMITTED', label: 'Submitted', initial: true, color: 'amber' },
        { key: 'UNDER_REVIEW', label: 'Under review', color: 'blue' },
        { key: 'INSPECTION', label: 'Inspection', color: 'cyan' },
        { key: 'APPROVED', label: 'Approved', color: 'teal' },
        { key: 'REPLACEMENT', label: 'Replacement issued', color: 'indigo' },
        { key: 'REJECTED', label: 'Rejected', terminal: true, color: 'slate' },
        { key: 'CLOSED', label: 'Closed', terminal: true, color: 'emerald' },
      ],
      transitions: [
        { key: 'review', label: 'Start review', from: 'SUBMITTED', to: 'UNDER_REVIEW', requires: [{ type: 'role', role: 'contributor' }] },
        { key: 'inspect', label: 'Send for inspection', from: 'UNDER_REVIEW', to: 'INSPECTION' },
        { key: 'approve', label: 'Approve claim', from: 'INSPECTION', to: 'APPROVED',
          requires: [{ type: 'approval', role: 'manager' }, { type: 'evidence' }] },
        { key: 'replace', label: 'Issue replacement', from: 'APPROVED', to: 'REPLACEMENT', requires: [{ type: 'role', role: 'manager' }] },
        { key: 'close', label: 'Close', from: 'REPLACEMENT', to: 'CLOSED' },
        { key: 'close_approved', label: 'Close', from: 'APPROVED', to: 'CLOSED' },
        { key: 'reject', label: 'Reject', from: 'UNDER_REVIEW', to: 'REJECTED', requires: [{ type: 'comment' }, { type: 'approval', role: 'manager' }] },
        { key: 'reject_after_inspection', label: 'Reject', from: 'INSPECTION', to: 'REJECTED', requires: [{ type: 'comment' }, { type: 'approval', role: 'manager' }] },
      ],
      slas: [
        { state: 'SUBMITTED', hours: 48, escalate_to_role: 'manager', label: 'Claim unacknowledged for two days' },
        { state: 'INSPECTION', hours: 168, escalate_to_role: 'manager', label: 'Inspection outstanding for a week' },
      ],
    }],
    externalEntities: { customer: ['warranty_claims', 'warranties'] },
    externalWritable: { customer: ['warranty_claims'] },
    externalNotifyStates: { claim_flow: ['UNDER_REVIEW', 'APPROVED', 'REJECTED', 'REPLACEMENT'] },
    identity: {
      key: 'customer_warranty', name: 'Customer Warranty Portal', icon: 'badge-check', category: 'service',
      description: 'Customers submit and track warranty claims; the company reviews, inspects, approves and resolves them.',
    },
  },

  {
    key: 'inspection',
    match: /inspection|site visit|checklist|construction|site.*(safety|audit)/i,
    canonicalRefs: ['projects', 'employees'],
    audiences: [],
    entities: [
      {
        key: 'site_inspections',
        label: 'Site Inspections',
        singular: 'Site Inspection',
        description: 'One visit to a site, what was checked, and what was wrong.',
        primary: true,
        display: { title_field: 'title' },
        fields: [
          { name: 'title', label: 'Inspection', type: 'text', required: true },
          { name: 'project_id', label: 'Project', type: 'reference', indexed: true,
            target: { kind: 'canonical', entity: 'projects', on_delete: 'set_null' } },
          { name: 'site_name', label: 'Site', type: 'text', required: true },
          { name: 'location', label: 'Location', type: 'geo_point' },
          { name: 'inspected_on', label: 'Inspected on', type: 'date', required: true, default: 'now' },
          { name: 'inspector_id', label: 'Inspector', type: 'reference',
            target: { kind: 'canonical', entity: 'employees', on_delete: 'set_null' } },
          { name: 'result', label: 'Result', type: 'enum', required: true, default: 'PENDING',
            values: ['PENDING', 'PASS', 'PASS_WITH_ACTIONS', 'FAIL'], indexed: true },
          { name: 'status', label: 'Status', type: 'enum', required: true, default: 'OPEN',
            values: ['OPEN', 'IN_PROGRESS', 'BLOCKED', 'DONE', 'CANCELLED'], indexed: true },
          { name: 'notes', label: 'Notes', type: 'long_text' },
        ],
      },
      {
        key: 'inspection_issues',
        label: 'Issues',
        singular: 'Issue',
        description: 'Something found during an inspection that needs fixing.',
        display: { title_field: 'title' },
        fields: [
          { name: 'title', label: 'Issue', type: 'text', required: true },
          { name: 'inspection_id', label: 'Inspection', type: 'reference', required: true, indexed: true,
            target: { kind: 'app', entity: 'site_inspections', on_delete: 'cascade' } },
          { name: 'severity', label: 'Severity', type: 'enum', required: true, default: 'MEDIUM',
            values: ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'], indexed: true },
          { name: 'status', label: 'Status', type: 'enum', required: true, default: 'OPEN',
            values: ['OPEN', 'IN_PROGRESS', 'BLOCKED', 'DONE', 'CANCELLED'], indexed: true },
          { name: 'due_date', label: 'Due date', type: 'date' },
          { name: 'detail', label: 'Detail', type: 'long_text' },
        ],
      },
    ],
    workflows: [OPEN_WORKFLOW('site_inspections'), OPEN_WORKFLOW('inspection_issues')],
    externalEntities: {},
    externalWritable: {},
    externalNotifyStates: {},
    identity: {
      key: 'site_inspections', name: 'Site Inspections', icon: 'clipboard-check', category: 'operations',
      description: 'Records site inspections, what was checked and where, and tracks every issue found through to resolution.',
    },
  },

  {
    key: 'fleet',
    match: /fleet|vehicle|maintenance.*(vehicle|fleet|asset)|servicing/i,
    canonicalRefs: ['employees', 'suppliers'],
    audiences: [],
    entities: [
      {
        key: 'fleet_vehicles',
        label: 'Vehicles',
        singular: 'Vehicle',
        description: 'A vehicle in the fleet.',
        primary: true,
        display: { title_field: 'registration' },
        fields: [
          { name: 'registration', label: 'Registration', type: 'text', required: true, unique: true },
          { name: 'make', label: 'Make', type: 'text' },
          { name: 'model', label: 'Model', type: 'text' },
          { name: 'in_service_since', label: 'In service since', type: 'date' },
          { name: 'odometer_km', label: 'Odometer (km)', type: 'integer' },
          { name: 'status', label: 'Status', type: 'enum', required: true, default: 'OPEN',
            values: ['OPEN', 'IN_PROGRESS', 'BLOCKED', 'DONE', 'CANCELLED'], indexed: true },
          { name: 'assigned_to_id', label: 'Assigned to', type: 'reference',
            target: { kind: 'canonical', entity: 'employees', on_delete: 'set_null' } },
        ],
      },
      {
        key: 'maintenance_events',
        label: 'Maintenance',
        singular: 'Maintenance Event',
        description: 'A service, repair or inspection carried out on a vehicle.',
        display: { title_field: 'summary' },
        fields: [
          { name: 'summary', label: 'Summary', type: 'text', required: true },
          { name: 'vehicle_id', label: 'Vehicle', type: 'reference', required: true, indexed: true,
            target: { kind: 'app', entity: 'fleet_vehicles', on_delete: 'cascade' } },
          { name: 'supplier_id', label: 'Garage', type: 'reference',
            target: { kind: 'canonical', entity: 'suppliers', on_delete: 'set_null' } },
          { name: 'kind', label: 'Kind', type: 'enum', required: true, default: 'SERVICE',
            values: ['SERVICE', 'REPAIR', 'INSPECTION', 'TYRES', 'RECALL'], indexed: true },
          { name: 'performed_on', label: 'Performed on', type: 'date', required: true, default: 'now' },
          { name: 'due_date', label: 'Next due', type: 'date' },
          { name: 'cost', label: 'Cost', type: 'money' },
          { name: 'status', label: 'Status', type: 'enum', required: true, default: 'OPEN',
            values: ['OPEN', 'IN_PROGRESS', 'BLOCKED', 'DONE', 'CANCELLED'], indexed: true },
        ],
      },
    ],
    workflows: [OPEN_WORKFLOW('maintenance_events')],
    externalEntities: {},
    externalWritable: {},
    externalNotifyStates: {},
    identity: {
      key: 'fleet_maintenance', name: 'Fleet Maintenance', icon: 'truck', category: 'operations',
      description: 'Tracks the fleet, everything done to each vehicle, what it cost and when the next service falls due.',
    },
  },
];

/** Canonical entities a requirement mentions by name. */
function detectCanonicalRefs(text) {
  const found = new Set();
  const lower = text.toLowerCase();
  const words = {
    suppliers: /supplier|vendor/, customers: /customer|client/, items: /product|item|part|material/,
    employees: /employee|staff|engineer|technician|inspector/, purchase_orders: /purchase order|\bpo\b|procurement/,
    sales_orders: /sales order|\bso\b|order from/, shipments: /shipment|delivery|dispatch/,
    goods_receipts: /goods receipt|receipt|received goods/, projects: /project|site|job/,
    customer_invoices: /customer invoice|billing/, supplier_invoices: /supplier invoice|\bbill\b/,
    inventory_items: /inventory|stock/, work_orders: /work order|production/,
    storage_locations: /warehouse|storage location|\bbins?\b|\bbays?\b/,
  };
  Object.entries(words).forEach(([key, re]) => { if (re.test(lower)) found.add(key); });
  return [...found].filter((k) => canonical.entity(k));
}

function detectAudiences(text) {
  const audiences = [];
  const lower = text.toLowerCase();
  if (/supplier|vendor/.test(lower) && /portal|respond|submit|collaborat|upload|their own/.test(lower)) audiences.push('supplier');
  if (/customer|client/.test(lower) && /portal|submit|track|claim|self.?serv/.test(lower)) audiences.push('customer');
  if (/partner|contractor|subcontractor/.test(lower) && /portal|access|respond/.test(lower)) audiences.push('partner');
  return audiences;
}

/**
 * The general case: a requirement this lexicon does not recognise.
 *
 * Produces a tracker named after the requirement's own subject. Honest about
 * being generic — the Studio says so in the plan, and the first iteration the
 * user asks for is usually "add these fields", which is exactly the thing the
 * platform is good at.
 */
function genericBrief(requirement, canonicalRefs) {
  const subject = extractSubject(requirement);
  const entityKey = pluralize(snake(subject));
  const label = titleCase(subject);

  const fields = [
    { name: 'title', label: 'Title', type: 'text', required: true },
    { name: 'detail', label: 'Detail', type: 'long_text' },
    { name: 'status', label: 'Status', type: 'enum', required: true, default: 'OPEN',
      values: ['OPEN', 'IN_PROGRESS', 'BLOCKED', 'DONE', 'CANCELLED'], indexed: true },
    { ...STANDARD_PRIORITY },
    { name: 'opened_on', label: 'Opened on', type: 'date', required: true, default: 'now' },
    { name: 'due_date', label: 'Due date', type: 'date' },
  ];

  // Reference whatever canonical data the requirement mentioned, so the
  // generic case still connects to the company's real records rather than
  // floating beside them.
  canonicalRefs.slice(0, 3).forEach((key) => {
    const entity = canonical.entity(key);
    fields.push({
      name: `${singularize(key)}_id`,
      label: entity.singular,
      type: 'reference',
      indexed: true,
      target: { kind: 'canonical', entity: key, on_delete: 'set_null' },
    });
  });

  const anchorRef = canonicalRefs.find((k) => canonical.entity(k)?.anchorKind);
  const anchor = anchorRef
    ? { field: `${singularize(anchorRef)}_id`, kind: canonical.entity(anchorRef).anchorKind }
    : null;

  return {
    identity: {
      key: snake(`${entityKey}_tracker`).slice(0, 47),
      name: `${label} Tracker`,
      icon: 'clipboard-list',
      category: 'operations',
      description: `Tracks ${label.toLowerCase()} from the point they are raised to the point they are done. Built from the requirement: "${requirement.slice(0, 200)}".`,
    },
    canonicalRefs,
    audiences: [],
    entities: [{
      key: entityKey,
      label,
      singular: label.replace(/s$/, ''),
      description: `One ${label.replace(/s$/, '').toLowerCase()}.`,
      primary: true,
      display: { title_field: 'title' },
      anchor,
      fields,
      computed: [{ name: 'days_open', label: 'Days open', expression: 'days_since(opened_on)', result_type: 'integer' }],
      indexes: [{ fields: ['status', 'priority'] }],
    }],
    workflows: [OPEN_WORKFLOW(entityKey)],
    externalEntities: {},
    externalWritable: {},
    externalNotifyStates: {},
    generic: true,
  };
}

/**
 * Turn a requirement into a design brief.
 *
 * @returns {{brief, matchedPacks: string[], generic: boolean}}
 */
function analyze(requirement) {
  const text = String(requirement || '').trim();
  const canonicalRefs = detectCanonicalRefs(text);
  const matched = PACKS.filter((p) => p.match.test(text));

  if (!matched.length) {
    const brief = genericBrief(text || 'record', canonicalRefs);
    return { brief, matchedPacks: [], generic: true };
  }

  // Compose every matching pack. Two packs contributing the same entity key
  // keep the first — the packs are ordered by specificity.
  const entities = [];
  const workflows = [];
  const externalEntities = {};
  const externalWritable = {};
  const externalNotifyStates = {};
  const refs = new Set(canonicalRefs);
  const audiences = new Set(detectAudiences(text));
  const liveMonitors = new Set();

  matched.forEach((pack) => {
    pack.entities.forEach((e) => { if (!entities.some((x) => x.key === e.key)) entities.push(deepClone(e)); });
    pack.workflows.forEach((w) => { if (!workflows.some((x) => x.key === w.key)) workflows.push(deepClone(w)); });
    (pack.canonicalRefs || []).forEach((r) => refs.add(r));
    (pack.liveMonitors || []).forEach((r) => liveMonitors.add(r));
    (pack.audiences || []).forEach((a) => audiences.add(a));
    Object.entries(pack.externalEntities || {}).forEach(([k, v]) => {
      externalEntities[k] = [...new Set([...(externalEntities[k] || []), ...v])];
    });
    Object.entries(pack.externalWritable || {}).forEach(([k, v]) => {
      externalWritable[k] = [...new Set([...(externalWritable[k] || []), ...v])];
    });
    Object.assign(externalNotifyStates, pack.externalNotifyStates || {});
  });

  const identity = { ...matched[0].identity };

  // If the requirement did not actually ask for a portal, do not build one:
  // an external surface is a security decision, and inferring one from the
  // word "supplier" alone would create a portal nobody asked for.
  const wanted = new Set(detectAudiences(text));
  const finalAudiences = [...audiences].filter((a) => wanted.has(a));

  return {
    brief: {
      identity,
      canonicalRefs: [...refs],
      liveMonitors: [...liveMonitors],
      audiences: finalAudiences,
      entities,
      workflows,
      externalEntities: Object.fromEntries(finalAudiences.map((a) => [a, externalEntities[a] || []])),
      externalWritable: Object.fromEntries(finalAudiences.map((a) => [a, externalWritable[a] || []])),
      externalNotifyStates,
    },
    matchedPacks: matched.map((p) => p.key),
    generic: false,
  };
}

// ---------------------------------------------------------------------------
const STOP_WORDS = new Set([
  'build', 'create', 'make', 'an', 'a', 'the', 'application', 'app', 'system', 'for', 'our', 'we', 'need',
  'to', 'track', 'manage', 'managing', 'tracking', 'internal', 'new', 'that', 'which', 'and', 'with', 'of',
  'want', 'would', 'like', 'please', 'can', 'you', 'me', 'us', 'company', 'business', 'process',
]);

function extractSubject(text) {
  const words = String(text).toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean);
  const candidates = words.filter((w) => !STOP_WORDS.has(w) && w.length > 2);
  if (!candidates.length) return 'record';
  // Two consecutive content words usually name the thing ("laboratory
  // certification", "site inspection"). One is the fallback.
  const pair = candidates.slice(0, 2);
  return pair.join(' ');
}

const snake = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').replace(/__+/g, '_') || 'record';
const titleCase = (s) => String(s).replace(/[_\s]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
const pluralize = (s) => (/(s|x|z|ch|sh)$/.test(s) ? `${s}es` : /[^aeiou]y$/.test(s) ? `${s.slice(0, -1)}ies` : `${s}s`);
const singularize = (s) => (s.endsWith('ies') ? `${s.slice(0, -3)}y` : s.endsWith('ses') ? s.slice(0, -2) : s.endsWith('s') ? s.slice(0, -1) : s);
const deepClone = (v) => JSON.parse(JSON.stringify(v));

module.exports = { analyze, PACKS, detectCanonicalRefs, detectAudiences, OPEN_WORKFLOW, snake, pluralize, singularize };
