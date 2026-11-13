import { useState, useMemo, useEffect, useCallback, useRef } from 'react'
import { useSearchParams } from 'react-router-dom'
import toast from 'react-hot-toast'
import api from '../services/api'
import { useResource, useResourceMutation } from '../hooks/useResource'
import { keys } from '../services/queryKeys'
import ApprovalBrief from '../components/ai/ApprovalBrief'
import { useDecisionsHeldOpen, HeldOrders, INBOX_TAB } from '../components/approvals/DecisionsHeldOpen'
import { useAuth } from '../contexts/AuthContext'
import { CheckIcon, XMarkIcon, EyeIcon, ArrowPathIcon, CheckBadgeIcon } from '@heroicons/react/20/solid'
import {
  PageHeader, Button, DataTable, RowAction, BulkAction, Badge, StatusBadge, Money, Num, Stat, Segmented, Sheet, ConfirmDialog,
  InlineNotice, EmptyState, DescriptionList, Field, Input, formatMoney,
} from '../components/ui'

// ---------------------------------------------------------------------------
// One approval inbox.
//
// Every pending approval in the system lands here as a row typed by what is
// being approved (bin, item master, inventory item, item/storage assignment,
// storage location, supplier, certification, purchase requisition, contract,
// purchase order, sales RFQ, quotation, sales contract, sales order, delivery
// schedule). The rows come from the same backend endpoints the eleven old
// dashboards used — nothing was dropped, the URLs just moved.
// ---------------------------------------------------------------------------

const CATEGORIES = [
  { id: 'warehouse', label: 'Warehouse' },
  { id: 'inventory', label: 'Item Master & Inventory' },
  { id: 'procurement', label: 'Procurement' },
  { id: 'sales', label: 'Sales' }
]

const fmtCurrency = (amount, currency = 'USD') => {
  if (amount == null || amount === '' || isNaN(Number(amount))) return '—'
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: currency || 'USD'
  }).format(Number(amount))
}

const fmtDate = (value) => {
  if (!value) return '—'
  const d = new Date(value)
  if (isNaN(d.getTime())) return String(value)
  return d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })
}

const fmtDateTime = (value) => {
  if (!value) return '—'
  const d = new Date(value)
  if (isNaN(d.getTime())) return String(value)
  return d.toLocaleString('en-US', { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}


const approveNote = `Approved via Approval Inbox at ${new Date().toISOString()}`

// ---------------------------------------------------------------------------
// Type registry. One entry per approval type; each entry knows how to list the
// pending rows, how to render them, and which endpoints approve/decline them.
// All of these endpoints are the ones the old per-type dashboards called.
// ---------------------------------------------------------------------------

const APPROVAL_TYPES = [
  {
    id: 'bins',
    label: 'Bins',
    category: 'warehouse',
    description: 'Storage bins pending approval',
    fetchList: ({ signal }) => api.get('/bins/pending-approval', { signal }),
    normalize: (items) => items.map((b) => ({
      id: b.id,
      title: b.code,
      subtitle: b.description || '',
      amount: null,
      currency: null,
      status: b.status || 'PENDING_APPROVAL',
      createdBy: '',
      createdAt: b.created_at,
      raw: b
    })),
    detail: (r) => [
      ['Code', r.raw.code],
      ['Description', r.raw.description || '—'],
      ['Storage location', `${r.raw.storage_location_name || '—'} (${r.raw.storage_location_code || '—'})`],
      ['Weight capacity', r.raw.max_weight_capacity != null ? `${r.raw.max_weight_capacity} (${r.raw.weight_utilization_percent ?? 0}% used)` : '—'],
      ['Volume capacity', r.raw.max_volume_capacity != null ? `${r.raw.max_volume_capacity} (${r.raw.volume_utilization_percent ?? 0}% used)` : '—'],
      ['Created', fmtDateTime(r.raw.created_at)]
    ],
    approve: (r) => ({ url: `/bins/${r.id}/approve`, body: {} }),
    decline: (r, reason) => ({ url: `/bins/${r.id}/decline`, body: { reason } })
  },
  {
    id: 'storage-locations',
    label: 'Storage Locations',
    category: 'warehouse',
    description: 'Storage locations pending approval',
    fetchList: ({ signal }) => api.get('/storage-locations/pending-approval', { signal }),
    normalize: (items) => items.map((l) => ({
      id: l.id,
      title: l.name,
      subtitle: `${l.code || ''}${l.city ? ` · ${l.city}` : ''}${l.country ? `, ${l.country}` : ''}`,
      amount: null,
      currency: null,
      status: l.status || 'PENDING_APPROVAL',
      createdBy: '',
      createdAt: l.created_at,
      raw: l
    })),
    detail: (r) => [
      ['Name', r.raw.name],
      ['Code', r.raw.code || '—'],
      ['Address', [r.raw.address, r.raw.city, r.raw.postal_code, r.raw.country].filter(Boolean).join(', ') || '—'],
      ['Description', r.raw.description || '—'],
      ['Created', fmtDateTime(r.raw.created_at)]
    ],
    approve: (r) => ({ url: `/storage-locations/${r.id}/approve`, body: {} }),
    decline: (r, reason) => ({ url: `/storage-locations/${r.id}/decline`, body: { reason } })
  },
  {
    id: 'items',
    label: 'Item Masters',
    category: 'inventory',
    description: 'Item master records pending review',
    // /items scopes to the caller's OWN records, so this tab was filtering a
    // list that could never hold anyone else's submission — an approval queue
    // showing only your own work is empty of anything you may act on. The
    // dedicated endpoint returns PENDING_REVIEW across creators.
    fetchList: ({ signal }) => api.get('/items/pending-approvals', { signal }),
    normalize: (items) => items
      .map((i) => ({
        id: i.id,
        title: i.name,
        subtitle: [i.item_code, i.item_category].filter(Boolean).join(' · '),
        amount: null,
        currency: null,
        status: i.status || 'PENDING_REVIEW',
        createdBy: '',
        createdAt: null,
        raw: i
      })),
    detail: (r) => [
      ['Name', r.raw.name],
      ['Item code', r.raw.item_code || '—'],
      ['Category', r.raw.item_category || '—'],
      ['Criticality', r.raw.criticality || '—'],
      ['Manufacturer', r.raw.manufacturer || '—'],
      ['Manufacturer part no.', r.raw.manufacturer_part_number || '—'],
      ['Stock item', r.raw.is_stock_item ? 'Yes' : 'No'],
      ['UNSPSC code', r.raw.unspsc_code || '—'],
      ['Description', r.raw.description || '—']
    ],
    approve: (r) => ({ url: `/items/${r.id}/approve`, body: {} }),
    decline: (r, reason) => ({ url: `/items/${r.id}/decline`, body: { reason } })
  },
  {
    id: 'inventory-items',
    label: 'Inventory Items',
    category: 'inventory',
    description: 'Inventory items with stock control settings',
    fetchList: ({ signal }) => api.get('/inventory-items/pending-approvals', { signal }),
    normalize: (items) => items.map((i) => ({
      id: i.id,
      title: i.item_name,
      subtitle: [i.approved_item_code, i.unit_of_measure, i.criticality && i.criticality.toLowerCase()].filter(Boolean).join(' · '),
      amount: i.unit_price,
      currency: i.currency,
      status: i.status || 'PENDING_APPROVAL',
      createdBy: [i.first_name, i.last_name].filter(Boolean).join(' ') || '',
      createdAt: i.created_at,
      raw: i
    })),
    detail: (r) => [
      ['Item name', r.raw.item_name],
      ['Approved item code', r.raw.approved_item_code || '—'],
      ['Unit of measure', r.raw.unit_of_measure || '—'],
      ['Criticality', r.raw.criticality || '—'],
      ['Unit price', fmtCurrency(r.raw.unit_price, r.raw.currency)],
      ['Submitted by', r.raw.email ? `${[r.raw.first_name, r.raw.last_name].filter(Boolean).join(' ')} <${r.raw.email}>` : '—'],
      ['Submitted', fmtDateTime(r.raw.created_at)]
    ],
    // The approve endpoint accepts optional stock-control parameters; the
    // detail pane exposes them below the field list.
    stockFields: [
      { key: 'minimum_stock_level', label: 'Minimum stock level' },
      { key: 'maximum_stock_level', label: 'Maximum stock level' },
      { key: 'reorder_point', label: 'Reorder point' }
    ],
    approve: (r) => ({ url: `/inventory-items/${r.id}/approve`, body: {} }),
    decline: (r, reason) => ({ url: `/inventory-items/${r.id}/decline`, body: { reason } })
  },
  {
    id: 'item-assignments',
    label: 'Item Assignments',
    category: 'inventory',
    description: 'Inventory item → storage location/bin assignments',
    fetchList: ({ signal }) => api.get('/inventory-items/storage-assignments/pending', { signal }),
    normalize: (items) => items.map((a) => ({
      id: a.id,
      title: a.item_name || a.item_code,
      subtitle: `${a.bin_code || '—'} @ ${a.storage_name || '—'}`,
      amount: null,
      currency: null,
      status: 'PENDING_APPROVAL',
      createdBy: [a.first_name, a.last_name].filter(Boolean).join(' ') || '',
      createdAt: a.created_at,
      raw: a
    })),
    detail: (r) => [
      ['Item', r.raw.item_name || r.raw.item_code],
      ['Item code', r.raw.item_code || r.raw.approved_item_code || '—'],
      ['Bin', r.raw.bin_code || '—'],
      ['Storage location', r.raw.storage_name ? `${r.raw.storage_name} (${r.raw.storage_code || '—'})` : '—'],
      ['Quantity', r.raw.quantity_in_location != null ? `${r.raw.quantity_in_location} ${r.raw.unit_of_measure || ''}`.trim() : '—'],
      ['Requested by', r.raw.email ? `${[r.raw.first_name, r.raw.last_name].filter(Boolean).join(' ')} <${r.raw.email}>` : '—'],
      ['Requested', fmtDateTime(r.raw.created_at)]
    ],
    approve: (r) => ({ url: `/inventory-items/storage-assignments/${r.id}/approve`, body: {} }),
    decline: (r, reason) => ({ url: `/inventory-items/storage-assignments/${r.id}/decline`, body: { reason } })
  },
  {
    id: 'suppliers',
    label: 'Suppliers',
    category: 'procurement',
    description: 'Supplier registrations pending DoA approval',
    fetchList: ({ signal }) => api.get('/delegation-of-authority/pending-suppliers', { signal }),
    normalize: (items) => items.map((s) => ({
      id: s.id,
      title: s.legal_name || s.name,
      subtitle: `${s.supplier_code || ''}${s.trade_name ? ` · Trade: ${s.trade_name}` : ''}`,
      amount: null,
      currency: null,
      status: s.status || 'PENDING_APPROVAL',
      createdBy: '',
      createdAt: s.created_at,
      raw: s
    })),
    detail: (r) => [
      ['Legal name', r.raw.legal_name || r.raw.name],
      ['Supplier code', r.raw.supplier_code || '—'],
      ['Trade name', r.raw.trade_name || '—'],
      ['Email', r.raw.email || '—'],
      ['Phone', r.raw.phone || '—'],
      ['Registration', fmtDate(r.raw.created_at)]
    ],
    approve: (r) => ({ url: `/delegation-of-authority/approve-supplier/${r.id}`, body: {} }),
    decline: (r, reason) => ({ url: `/delegation-of-authority/decline-supplier/${r.id}`, body: { reason } })
  },
  {
    id: 'certifications',
    label: 'Supplier Certifications',
    category: 'procurement',
    description: 'Active suppliers pending certification',
    fetchList: ({ signal }) => api.get('/delegation-of-authority/pending-certifications', { signal }),
    normalize: (items) => items.map((s) => ({
      id: s.id,
      title: s.legal_name || s.name,
      subtitle: `${s.supplier_code || ''} · certification pending`,
      amount: null,
      currency: null,
      status: s.certification_status || 'PENDING',
      createdBy: '',
      createdAt: s.created_at,
      raw: s
    })),
    detail: (r) => [
      ['Legal name', r.raw.legal_name || r.raw.name],
      ['Supplier code', r.raw.supplier_code || '—'],
      ['Email', r.raw.email || '—'],
      ['Phone', r.raw.phone || '—'],
      ['Status', r.raw.status],
      ['Certification status', r.raw.certification_status || '—']
    ],
    approve: (r) => ({ url: `/delegation-of-authority/certify-supplier/${r.id}`, body: {} }),
    decline: (r, reason) => ({ url: `/delegation-of-authority/revoke-certification/${r.id}`, body: { reason } })
  },
  {
    id: 'purchase-requisitions',
    label: 'Purchase Requisitions',
    category: 'procurement',
    description: 'Internal purchase requests pending DoA approval',
    fetchList: ({ signal }) => api.get('/delegation-of-authority/pending-purchase-requisitions', { signal }),
    normalize: (items) => items.map((p) => ({
      id: p.id,
      title: p.pr_number,
      subtitle: p.item_description || p.item_name || '',
      amount: p.estimated_unit_price != null ? Number(p.quantity) * Number(p.estimated_unit_price) : null,
      currency: p.currency,
      status: p.status || 'PENDING_APPROVAL',
      createdBy: p.requested_by_name || '',
      createdAt: p.created_at,
      raw: p
    })),
    detail: (r) => [
      ['PR number', r.raw.pr_number || '—'],
      ['Cost center', r.raw.cost_center || '—'],
      ['Item', r.raw.item_name ? `${r.raw.item_name} (${r.raw.approved_item_code || '—'})` : (r.raw.item_description || '—')],
      ['Quantity', r.raw.quantity != null ? `${r.raw.quantity} ${r.raw.unit_of_measure || ''}`.trim() : '—'],
      ['Estimated value', r.raw.estimated_unit_price != null ? fmtCurrency(Number(r.raw.quantity) * Number(r.raw.estimated_unit_price), r.raw.currency) : '—'],
      ['Requested by', r.raw.requested_by_name || '—'],
      ['Recommended supplier', r.raw.recommended_supplier_name || '—'],
      ['Supplier recommendation', r.raw.supplier_recommendation_text || '—'],
      ['Requested', fmtDateTime(r.raw.created_at)]
    ],
    approve: (r) => ({ url: `/delegation-of-authority/approve-purchase-requisition/${r.id}`, body: {} }),
    decline: (r, reason) => ({ url: `/delegation-of-authority/decline-purchase-requisition/${r.id}`, body: { reason } })
  },
  {
    id: 'contracts',
    label: 'Contracts',
    category: 'procurement',
    description: 'Supplier contracts pending approval',
    fetchList: ({ signal }) => api.get('/contracts/pending-approvals', { signal }),
    normalize: (items) => items.map((c) => ({
      id: c.id,
      title: c.title || c.contract_number,
      subtitle: `${c.supplier_name || ''}${c.contract_number && c.contract_number !== c.title ? ` · ${c.contract_number}` : ''}`,
      amount: c.contract_value,
      currency: c.currency,
      status: c.status || 'PENDING_APPROVAL',
      createdBy: '',
      createdAt: c.created_at,
      raw: c
    })),
    detail: (r) => [
      ['Title', r.raw.title || '—'],
      ['Contract number', r.raw.contract_number || '—'],
      ['Supplier', r.raw.supplier_name || '—'],
      ['Value', fmtCurrency(r.raw.contract_value, r.raw.currency)],
      ['Start date', fmtDate(r.raw.start_date)],
      ['End date', fmtDate(r.raw.end_date)],
      ['Description', r.raw.description || '—'],
      ['Created', fmtDateTime(r.raw.created_at)]
    ],
    approve: (r) => ({ url: `/contracts/${r.id}/approve`, body: {} }),
    decline: (r, reason) => ({ url: `/contracts/${r.id}/decline`, body: { reason } })
  },
  {
    id: 'purchase-orders',
    label: 'Purchase Orders',
    category: 'procurement',
    description: 'Purchase orders pending sales/procurement approval',
    fetchList: ({ signal }) => api.get('/purchase-orders/pending-approval', { signal }),
    normalize: (items) => items.map((p) => ({
      id: p.id,
      title: p.po_number,
      subtitle: `${p.supplier_name || ''}${p.order_type ? ` · ${p.order_type}` : ''}`,
      amount: p.total_amount,
      currency: p.currency,
      status: p.overall_approval_status || p.status || 'PENDING_APPROVAL',
      createdBy: p.created_by_name || '',
      createdAt: p.created_at,
      raw: p
    })),
    detail: (r) => [
      ['PO number', r.raw.po_number || '—'],
      ['Supplier', r.raw.supplier_name || '—'],
      ['Order type', r.raw.order_type || '—'],
      ['Total amount', fmtCurrency(r.raw.total_amount, r.raw.currency)],
      ['Item count', r.raw.item_count ?? '—'],
      ['Priority', r.raw.priority || '—'],
      ['Required date', fmtDate(r.raw.required_date)],
      ['Sales approval status', r.raw.sales_approval_status || '—'],
      ['Procurement approval status', r.raw.procurement_approval_status || '—'],
      ['Created by', r.raw.created_by_name || '—'],
      ['Created', fmtDateTime(r.raw.created_at)]
    ],
    aiBriefType: 'purchase_order',
    approve: (r) => ({ url: `/purchase-orders/${r.id}/approve`, body: { approval_notes: approveNote } }),
    decline: (r, reason) => ({ url: `/purchase-orders/${r.id}/reject`, body: { rejection_reason: reason } })
  },
  {
    id: 'sales-rfqs-procurement',
    label: 'Sales RFQs — Procurement',
    category: 'procurement',
    description: 'Sales RFQs pending procurement-team approval',
    fetchList: ({ signal }) => api.get('/sales-rfqs/pending-procurement-approvals', { signal }),
    normalize: (items) => items.map((q) => ({
      id: q.id,
      title: q.rfq_number,
      subtitle: q.rfq_title || q.customer_company_name || '',
      amount: null,
      currency: null,
      status: q.procurement_approval_status || q.status || 'PENDING_APPROVAL',
      createdBy: q.created_by_name || '',
      createdAt: q.created_at,
      raw: q
    })),
    detail: (r) => [
      ['RFQ number', r.raw.rfq_number || '—'],
      ['Title', r.raw.rfq_title || '—'],
      ['Customer', r.raw.customer_company_name || '—'],
      ['Supplier', r.raw.supplier_company_name || '—'],
      ['Item count', r.raw.item_count ?? '—'],
      ['Response deadline', fmtDate(r.raw.response_deadline)],
      ['Priority', r.raw.priority || '—'],
      ['Request type', r.raw.request_type || '—'],
      ['Created by', r.raw.created_by_name || '—']
    ],
    approve: (r) => ({ url: `/sales-rfqs/${r.id}/approve-procurement`, body: { approval_notes: approveNote } }),
    decline: (r, reason) => ({ url: `/sales-rfqs/${r.id}/reject-procurement`, body: { rejection_reason: reason } })
  },
  {
    id: 'sales-quotations',
    label: 'Sales Quotations',
    category: 'sales',
    description: 'Quotations awaiting approval before sending to customer',
    fetchList: ({ signal }) => api.get('/sales-quotations/pending-approvals', { signal }),
    normalize: (items) => items.map((q) => ({
      id: q.id,
      title: q.quotation_number,
      subtitle: q.customer_name || '',
      amount: q.total_amount,
      currency: q.currency,
      status: q.status || 'PENDING_APPROVAL',
      createdBy: q.created_by_name || '',
      createdAt: q.created_at,
      raw: q
    })),
    detail: (r) => [
      ['Quotation number', r.raw.quotation_number || '—'],
      ['Customer', r.raw.customer_name || '—'],
      ['Total amount', fmtCurrency(r.raw.total_amount, r.raw.currency)],
      ['Item count', r.raw.item_count ?? '—'],
      ['Created by', r.raw.created_by_name || '—'],
      ['Created', fmtDateTime(r.raw.created_at)]
    ],
    approve: (r) => ({ url: `/sales-quotations/${r.id}/approve`, body: { approval_notes: approveNote } }),
    decline: (r, reason) => ({ url: `/sales-quotations/${r.id}/reject`, body: { rejection_reason: reason } })
  },
  {
    id: 'sales-contracts',
    label: 'Sales Contracts',
    category: 'sales',
    description: 'Sales contracts awaiting approval',
    fetchList: ({ signal }) => api.get('/sales-contracts/pending-approvals', { signal }),
    normalize: (items) => items.map((c) => ({
      id: c.id,
      title: c.contract_name,
      subtitle: c.customer_name || '',
      amount: c.contract_value,
      currency: c.currency,
      status: c.status || 'PENDING_APPROVAL',
      createdBy: '',
      createdAt: c.created_at,
      raw: c
    })),
    detail: (r) => [
      ['Contract name', r.raw.contract_name || '—'],
      ['Customer', r.raw.customer_name || '—'],
      ['Value', fmtCurrency(r.raw.contract_value, r.raw.currency)],
      ['Created', fmtDateTime(r.raw.created_at)]
    ],
    approve: (r) => ({ url: `/sales-contracts/${r.id}/approve`, body: { approval_notes: approveNote } }),
    decline: (r, reason) => ({ url: `/sales-contracts/${r.id}/reject`, body: { rejection_reason: reason } })
  },
  {
    id: 'sales-orders',
    label: 'Sales Orders',
    category: 'sales',
    description: 'Sales orders awaiting approval',
    fetchList: ({ signal }) => api.get('/sales-orders/pending-approvals', { signal }),
    normalize: (items) => items.map((o) => ({
      id: o.id,
      title: o.so_number,
      subtitle: o.customer_name || '',
      amount: o.total_amount,
      currency: o.currency,
      status: o.status || 'PENDING_APPROVAL',
      createdBy: '',
      createdAt: o.created_at,
      raw: o
    })),
    detail: (r) => [
      ['Sales order number', r.raw.so_number || '—'],
      ['Customer', r.raw.customer_name || '—'],
      ['Total amount', fmtCurrency(r.raw.total_amount, r.raw.currency)],
      ['Created', fmtDateTime(r.raw.created_at)]
    ],
    aiBriefType: 'sales_order',
    approve: (r) => ({ url: `/sales-orders/${r.id}/approve`, body: { approval_notes: approveNote } }),
    decline: (r, reason) => ({ url: `/sales-orders/${r.id}/reject`, body: { rejection_reason: reason } })
  },
  {
    id: 'sales-rfqs',
    label: 'Sales RFQs — Sales',
    category: 'sales',
    description: 'Sales RFQs pending sales-team approval',
    fetchList: ({ signal }) => api.get('/sales-rfqs/pending-sales-approvals', { signal }),
    normalize: (items) => items.map((q) => ({
      id: q.id,
      title: q.rfq_number,
      subtitle: q.rfq_title || q.customer_company_name || '',
      amount: null,
      currency: null,
      status: q.sales_approval_status || q.status || 'PENDING_APPROVAL',
      createdBy: q.created_by_name || '',
      createdAt: q.created_at,
      raw: q
    })),
    detail: (r) => [
      ['RFQ number', r.raw.rfq_number || '—'],
      ['Title', r.raw.rfq_title || '—'],
      ['Customer', r.raw.customer_company_name || '—'],
      ['Item count', r.raw.item_count ?? '—'],
      ['Response deadline', fmtDate(r.raw.response_deadline)],
      ['Priority', r.raw.priority || '—'],
      ['Created by', r.raw.created_by_name || '—']
    ],
    approve: (r) => ({ url: `/sales-rfqs/${r.id}/approve`, body: { approval_notes: approveNote } }),
    decline: (r, reason) => ({ url: `/sales-rfqs/${r.id}/reject`, body: { rejection_reason: reason } })
  },
  {
    id: 'delivery-schedules',
    label: 'Delivery Schedules',
    category: 'sales',
    description: 'Delivery schedules pending approval',
    fetchList: ({ signal }) => api.get('/delivery-schedules', { signal, params: { status: 'PENDING_APPROVAL' } }),
    normalize: (items) => items.map((d) => ({
      id: d.id,
      title: `DS-${d.id}`,
      subtitle: `SO-${d.sales_order_id || '—'} · ${d.customer_name || ''}`,
      amount: null,
      currency: null,
      status: d.status || 'PENDING_APPROVAL',
      createdBy: '',
      createdAt: null,
      raw: d
    })),
    detail: (r) => [
      ['Schedule', `DS-${r.raw.id}`],
      ['Sales order', `SO-${r.raw.sales_order_id || '—'}`],
      ['Customer', r.raw.customer_name || '—'],
      ['Scheduled date', fmtDate(r.raw.scheduled_date)]
    ],
    // Backend exposes PUT /delivery-schedules/:id/status, not approve/reject:
    // approving moves the pending schedule into the fulfilment workflow
    // (SCHEDULED); rejecting cancels it with the stated reason.
    approve: (r) => ({ url: `/delivery-schedules/${r.id}/status`, method: 'put', body: { status: 'SCHEDULED', reason: approveNote } }),
    decline: (r, reason) => ({ url: `/delivery-schedules/${r.id}/status`, method: 'put', body: { status: 'CANCELLED', reason } })
  }
]

const TYPE_MAP = Object.fromEntries(APPROVAL_TYPES.map((t) => [t.id, t]))

// ---------------------------------------------------------------------------
// Inbox fetch: every type's list endpoint, settled independently so one
// failing endpoint degrades to zero rows for that type instead of killing the
// whole inbox.
// ---------------------------------------------------------------------------

async function fetchApprovalInbox({ signal }) {
  const settled = await Promise.allSettled(
    APPROVAL_TYPES.map(async (type) => {
      const response = await type.fetchList({ signal })
      // Some list endpoints answer { success, data: [...] } and a few answer
      // the raw array; accept both.
      const body = response?.data
      const items = body && typeof body === 'object' && !Array.isArray(body) && 'data' in body
        ? (body.data || [])
        : (Array.isArray(body) ? body : [])
      return { typeId: type.id, items: type.normalize(items) }
    })
  )

  const byType = {}
  const failedTypes = []
  const rows = []
  for (const result of settled) {
    if (result.status === 'fulfilled') {
      byType[result.value.typeId] = result.value.items
      for (const row of result.value.items) rows.push({ ...row, typeId: result.value.typeId })
    } else {
      failedTypes.push(result.reason?.message || 'Request failed')
    }
  }
  // useResource() runs every fetcher's result through unwrap(), which expects
  // an axios response (`response.data.{success,data}`) — this aggregator
  // already produces the final shape, so it has to be wrapped in that same
  // envelope or unwrap() reads a nonexistent `.data.data` and silently hands
  // the page `undefined`, rendering as an inbox with nothing in it and no error.
  return { data: { success: true, data: { rows, byType, failedTypes } } }
}

const UnifiedApprovalPortal = () => {
  const [searchParams, setSearchParams] = useSearchParams()
  const initialTab = searchParams.get('tab')
  const initialFocusId = searchParams.get('id')

  const [activeCategory, setActiveCategory] = useState('all')
  const [activeType, setActiveType] = useState(initialTab || 'all')
  const [selected, setSelected] = useState(null) // { typeId, row }
  const [processing, setProcessing] = useState(new Set())
  const [stockParams, setStockParams] = useState({ minimum_stock_level: '', maximum_stock_level: '', reorder_point: '' })
  const deepLinkApplied = useRef(false)

  const { data, loading, refetch } = useResource(keys.approvalInbox(), fetchApprovalInbox)
  const rows = data?.rows || []

  // What each pending decision is worth and holding up, walked through the
  // delivery trace on the server. Keyed the way the inbox keys its rows.
  const held = useDecisionsHeldOpen()
  const heldByRow = useMemo(() => {
    const map = new Map()
    for (const d of held.data?.decisions || []) {
      if (INBOX_TAB[d.kind]) map.set(`${INBOX_TAB[d.kind]}:${d.id}`, d)
    }
    return map
  }, [held.data])
  const failedTypes = data?.failedTypes || []

  // Deep-link support: ?tab=<type>&id=<row id> (the old per-type detail URLs
  // redirect here with these query params). Applied once, when the data first
  // arrives.
  useEffect(() => {
    if (deepLinkApplied.current || !rows.length) return
    deepLinkApplied.current = true
    if (initialTab && TYPE_MAP[initialTab] && initialTab !== activeType) {
      setActiveType(initialTab)
    }
    if (initialFocusId) {
      const match = rows.find((r) => r.typeId === initialTab && String(r.id) === String(initialFocusId))
      if (match) setSelected({ typeId: match.typeId, row: match })
      setSearchParams({ tab: initialTab || 'all' }, { replace: true })
    }
  }, [initialTab, initialFocusId, rows.length])

  const approveMutation = useResourceMutation(
    ({ typeId, row, notes }) => {
      const type = TYPE_MAP[typeId]
      const action = type.approve(row)
      // Inventory-item approval applies optional stock-control parameters.
      const body = typeId === 'inventory-items' && notes ? { ...action.body, ...notes } : action.body
      if (action.method === 'put') return api.put(action.url, body)
      return api.post(action.url, body)
    },
    {
      invalidates: [keys.approvalInbox()],
      silent: true,
      onSuccess: (data, variables) => {
        const resp = data?.data || data
        const msg = resp?.message
        if (resp?.data?.status === 'PENDING') {
          // Multi-step approval chain: more steps remain
          toast(msg || 'Approval step completed — additional approvals required', { icon: 'ℹ️' })
        } else {
          toast.success(msg || `${TYPE_MAP[variables.typeId].label.replace(' — ', ' ')} item approved`)
        }
        if (variables.onDone) variables.onDone()
        held.reload()
      }
    }
  )

  const declineMutation = useResourceMutation(
    ({ typeId, row, reason }) => {
      const type = TYPE_MAP[typeId]
      const action = type.decline(row, reason)
      if (action.method === 'put') return api.put(action.url, action.body)
      return api.post(action.url, action.body)
    },
    {
      invalidates: [keys.approvalInbox()],
      silent: true,
      onSuccess: (data, variables) => {
        toast.success(`${TYPE_MAP[variables.typeId].label.replace(' — ', ' ')} item declined`)
        if (variables.onDone) variables.onDone()
        held.reload()
      }
    }
  )

  const handleApprove = useCallback(async (typeId, row, options = {}) => {
    const key = `${typeId}:${row.id}`
    setProcessing((prev) => new Set(prev).add(key))
    try {
      const notes = typeId === 'inventory-items'
        ? Object.fromEntries(Object.entries(options.stockParams || {}).map(([k, v]) => [k, v === '' ? null : v]))
        : undefined
      await approveMutation.mutateAsync({ typeId, row, notes, onDone: options.onDone })
    } finally {
      setProcessing((prev) => {
        const next = new Set(prev)
        next.delete(key)
        return next
      })
    }
  }, [approveMutation])

  const handleDecline = useCallback(async (typeId, row, reason, onDone) => {
    const key = `${typeId}:${row.id}`
    setProcessing((prev) => new Set(prev).add(key))
    try {
      await declineMutation.mutateAsync({ typeId, row, reason, onDone })
    } finally {
      setProcessing((prev) => {
        const next = new Set(prev)
        next.delete(key)
        return next
      })
    }
  }, [declineMutation])

  const selectedType = selected ? TYPE_MAP[selected.typeId] : null
  const showStockFields = selectedType?.id === 'inventory-items'
  return (
    <ApprovalQueueView
      rows={rows}
      loading={loading}
      refetch={refetch}
      failedTypes={failedTypes}
      held={held}
      heldByRow={heldByRow}
      selected={selected}
      setSelected={setSelected}
      selectedType={selectedType}
      showStockFields={showStockFields}
      stockParams={stockParams}
      setStockParams={setStockParams}
      processing={processing}
      handleApprove={handleApprove}
      handleDecline={handleDecline}
      approvePending={approveMutation.isPending}
      bulkApproveRows={async (targetRows) => {
        const failures = []
        for (const r of targetRows) {
          try { await approveMutation.mutateAsync({ typeId: r.typeId, row: r }) } catch (error) { failures.push(error) }
        }
        const ok = targetRows.length - failures.length
        if (ok > 0) toast.success(`${ok} approved`)
        if (failures.length) toast.error(`${failures.length} of ${targetRows.length} not approved: ${failures[0]?.response?.data?.error || failures[0]?.message || 'server error'}`)
      }}
      activeCategory={activeCategory}
      setActiveCategory={setActiveCategory}
      activeType={activeType}
      setActiveType={setActiveType}
    />
  )
}

/* ==========================================================================
   The queue, presented.
   ========================================================================== */

// Bulk approval is for decisions that are safe to make without opening them:
// small, not escalated, and not holding up a customer order.
const SAFE_LIMIT = 1000

const humanAge = (ms) => {
  if (!Number.isFinite(ms) || ms < 0) return null
  const h = ms / 36e5
  if (h < 1) return 'under an hour'
  if (h < 24) return `${Math.round(h)} h`
  return `${Math.round(h / 24)} d`
}

function ApprovalQueueView(props) {
  const {
    rows, loading, refetch, failedTypes, held, heldByRow, selected, setSelected, selectedType, showStockFields,
    stockParams, setStockParams, processing, handleApprove, handleDecline, bulkApproveRows,
    activeCategory, setActiveCategory, activeType, setActiveType,
  } = props
  const { user } = useAuth()
  const [reject, setReject] = useState(null) // { typeId, row }
  const [bulk, setBulk] = useState(null) // rows
  const { data: authority } = useResource(['doa', 'user', user?.id], ({ signal }) => api.get(`/delegation-of-authority/user/${user?.id}`, { signal }), { enabled: !!user?.id })
  const rules = Array.isArray(authority) ? authority.filter((r) => r.is_active) : []
  const summary = held.data?.summary

  // One row per pending decision, enriched with what the decision is worth
  // and what it holds up, then ranked by consequence.
  const queue = useMemo(() => rows.map((r) => {
    const key = `${r.typeId}:${r.id}`
    const d = heldByRow.get(key)
    const amount = d?.value ?? (r.amount != null && r.amount !== '' ? Number(r.amount) : null)
    const since = d?.waiting_since || r.createdAt
    const ageMs = since ? Date.now() - new Date(since).getTime() : null
    const escalated = Boolean(d?.escalated) || (ageMs != null && ageMs > 3 * 864e5)
    const heldValue = Number(d?.held_value) || 0
    const safe = !escalated && !heldValue && (amount == null || amount < SAFE_LIMIT)
    const rank = (escalated ? 1e12 : 0) + heldValue * 10 + (amount || 0) + (ageMs || 0) / 864e5
    return { ...r, key, decision: d, amount, currency: d?.currency || r.currency, ageMs, escalated, heldValue, safe, rank }
  }), [rows, heldByRow])

  const shown = useMemo(() => {
    let out = queue
    if (activeType !== 'all') out = out.filter((r) => r.typeId === activeType)
    else if (activeCategory !== 'all') out = out.filter((r) => TYPE_MAP[r.typeId].category === activeCategory)
    return out
  }, [queue, activeType, activeCategory])

  const totalValue = queue.reduce((s, r) => s + (r.amount || 0), 0)
  const oldest = queue.reduce((m, r) => Math.max(m, r.ageMs || 0), 0)

  const columns = [
    { id: 'type', header: 'Type', accessor: (r) => TYPE_MAP[r.typeId].label, filter: 'select', width: 170, cell: (r) => <Badge tone="ink">{TYPE_MAP[r.typeId].label.replace(/s$/, '')}</Badge>, mobile: 'meta' },
    {
      id: 'ref', header: 'Decision', accessor: (r) => `${r.title} ${r.subtitle || ''}`, minWidth: 220, maxWidth: 340, mobile: 'title',
      cell: (r) => (
        <span className="block min-w-0">
          <span className="block truncate font-mono text-[0.92em]">{r.title}</span>
          {r.subtitle && <span className="block truncate text-xs text-ink-500">{r.subtitle}</span>}
        </span>
      ),
    },
    { id: 'amount', header: 'Amount', accessor: (r) => r.amount, align: 'right', width: 130, cell: (r) => <Money amount={r.amount} currency={r.currency || 'USD'} />, mobile: 'trailing', filter: 'number' },
    {
      id: 'age', header: 'Waiting', accessor: (r) => r.ageMs, align: 'right', width: 110,
      cell: (r) => (r.ageMs == null ? <span className="text-ink-400">—</span> : (
        <span className={r.escalated ? 'font-medium text-warn-700' : 'text-ink-700'} title={r.escalated ? 'Waiting more than 3 days, or escalated' : undefined}>
          {r.escalated && <span aria-hidden="true">▲ </span>}{humanAge(r.ageMs)}
        </span>
      )),
    },
    {
      id: 'why', header: 'Why it is here', accessor: (r) => r.decision?.reason || TYPE_MAP[r.typeId].description, minWidth: 240, maxWidth: 420, wrap: false,
      cell: (r) => (
        <span className="block truncate text-ink-600" title={r.decision?.reason || TYPE_MAP[r.typeId].description}>
          {r.heldValue ? <span className="font-medium text-warn-700">Holds <Money amount={r.heldValue} currency={r.currency} digits={0} /> of customer orders · </span> : null}
          {r.decision?.waiting_on ? `Waiting on ${r.decision.waiting_on}` : TYPE_MAP[r.typeId].description}
        </span>
      ),
    },
    { id: 'by', header: 'Requested by', accessor: 'createdBy', width: 140, defaultHidden: true },
    { id: 'rank', header: 'Priority', accessor: (r) => r.rank, defaultHidden: true, hideable: true, cell: (r) => (r.escalated ? 'Escalated' : r.heldValue ? 'Holds orders' : '—') },
  ]

  const bulkTotal = bulk ? bulk.reduce((s, r) => s + (r.amount || 0), 0) : 0

  return (
    <div className="space-y-5">
      <PageHeader
        title="Approvals"
        description="Everything waiting on a decision you are allowed to make, most consequential first."
        secondary={
          <>
            <Button variant="ghost" icon={ArrowPathIcon} onClick={() => { refetch(); held.reload() }}>Refresh</Button>
            <Button to="/approvals/simulate">How routing works</Button>
          </>
        }
      />

      <InlineNotice tone="ink" title="Your authority">
        {rules.length ? (
          <span>
            {rules.map((r) => `${r.applies_to === 'ALL' ? 'All documents' : String(r.applies_to).replace(/_/g, ' ').toLowerCase()} from ${formatMoney(r.min_amount, r.currency, 0)} to ${Number(r.max_amount) >= 1e11 ? 'any amount' : formatMoney(r.max_amount, r.currency, 0)}${r.cost_center ? ` in cost centre ${r.cost_center}` : ''}${r.effective_until ? `, until ${new Date(r.effective_until).toLocaleDateString()}` : ''}`).join('; ')}.
            {' '}Items above your limit go to the next approver; you cannot approve what you raised yourself.
          </span>
        ) : (
          <span>You hold no delegated authority of your own. Items reach you here when they are routed to your role.</span>
        )}
      </InlineNotice>

      {failedTypes.length > 0 && (
        <InlineNotice tone="warn" title="Some approval types could not be read">
          {failedTypes.join('; ')}. Those types show no rows until they load; the rest of the queue is complete.
        </InlineNotice>
      )}

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Waiting on decisions" value={<Num value={queue.length} />} loading={loading} reason={summary?.yours ? `${summary.yours} yours to decide` : undefined} />
        <Stat label="Value waiting" value={<Money amount={totalValue} digits={0} />} loading={loading} footnote="Sum of decisions with an amount" />
        <Stat label="Oldest" value={oldest ? humanAge(oldest) : '—'} loading={loading} reason={oldest > 3 * 864e5 ? 'Past the 3-day escalation threshold' : undefined} />
        <Stat label="Decided this week" value={<Num value={summary?.made_this_week} />} loading={held.loading} />
      </div>

      <DataTable
        viewKey="approvals.queue"
        caption="Decisions waiting"
        noun="decision"
        rows={shown}
        columns={columns}
        rowKey={(r) => r.key}
        loading={loading}
        defaultSort={{ id: 'rank', dir: 'desc' }}
        onOpen={(r) => setSelected({ typeId: r.typeId, row: r })}
        rowClassName={(r) => (selected && selected.typeId === r.typeId && String(selected.row.id) === String(r.id) ? '!bg-brand-50' : processing.has(r.key) ? 'opacity-60' : undefined)}
        searchPlaceholder="Search reference, party or requester"
        toolbarStart={
          <Segmented
            label="Category"
            value={activeCategory}
            onChange={(v) => { setActiveCategory(v); setActiveType('all') }}
            options={[{ value: 'all', label: `All ${queue.length || ''}` }, ...CATEGORIES.map((c) => ({ value: c.id, label: `${c.label.replace('Item Master & ', '')} ${queue.filter((r) => TYPE_MAP[r.typeId].category === c.id).length || ''}` }))]}
          />
        }
        selectable
        isRowSelectable={(r) => r.safe}
        bulkActions={(sel, clear) => (
          <BulkAction tone="primary" icon={CheckIcon} onClick={() => { setBulk(sel); clear() }}>Approve {sel.length}</BulkAction>
        )}
        rowActions={(r) => (
          <>
            <RowAction icon={EyeIcon} label={`Review ${r.title}`} onClick={() => setSelected({ typeId: r.typeId, row: r })} />
            <RowAction icon={CheckIcon} label={`Approve ${r.title}`} disabled={processing.has(r.key)} onClick={() => handleApprove(r.typeId, r)} />
            <RowAction icon={XMarkIcon} tone="risk" label={`Reject ${r.title}`} disabled={processing.has(r.key)} onClick={() => setReject({ typeId: r.typeId, row: r })} />
          </>
        )}
        empty={
          <EmptyState
            icon={CheckBadgeIcon}
            title="You are clear"
            description={summary?.made_this_week ? `Nothing is waiting on you. ${summary.made_this_week} decision${summary.made_this_week === 1 ? ' was' : 's were'} made this week.` : 'Nothing is waiting on a decision from you.'}
          />
        }
      />
      <p className="text-xs text-ink-500">Only items under {formatMoney(SAFE_LIMIT, 'USD', 0)} that are not escalated and hold up no customer order can be approved in bulk. Open the rest to review.</p>

      {/* Review panel */}
      <Sheet
        open={Boolean(selected)}
        onClose={() => setSelected(null)}
        width="lg"
        title={selected ? `${selectedType.label}: ${selected.row.title}` : ''}
        description={selected?.row.subtitle}
        footer={selected && (
          <>
            <Button variant="ghost" disabled title="Delegating one decision is not available yet. Set a standing delegation in DOA management." to={undefined}>Delegate</Button>
            <span className="flex-1" />
            <Button variant="destructive" icon={XMarkIcon} onClick={() => setReject({ typeId: selected.typeId, row: selected.row })} disabled={processing.has(`${selected.typeId}:${selected.row.id}`)}>Reject</Button>
            <Button
              variant="primary"
              icon={CheckIcon}
              loading={processing.has(`${selected.typeId}:${selected.row.id}`)}
              onClick={() => handleApprove(selected.typeId, selected.row, { stockParams, onDone: () => { setSelected(null); setStockParams({ minimum_stock_level: '', maximum_stock_level: '', reorder_point: '' }) } })}
            >
              Approve
            </Button>
          </>
        )}
      >
        {selected && (
          <div className="space-y-4 p-4">
            <div className="flex flex-wrap items-center gap-2">
              <StatusBadge status={selected.row.status} />
              {(() => { const q = queue.find((x) => x.typeId === selected.typeId && String(x.id) === String(selected.row.id)); return q?.amount != null ? <Money amount={q.amount} currency={q.currency || 'USD'} className="text-base font-semibold" /> : null })()}
            </div>
            {(() => {
              const d = heldByRow.get(`${selected.typeId}:${selected.row.id}`)
              return (
                <section className="rounded-lg border border-ink-200 p-3">
                  <h3 className="label-mono mb-1">Why this reached you</h3>
                  <p className="text-sm text-ink-800">{d?.reason || `${selectedType.description}. Your role or delegated authority covers it.`}</p>
                  {d?.waiting_on && <p className="mt-1 text-xs text-ink-500">Routing: waiting on {d.waiting_on}{d.waiting_for ? ` for ${d.waiting_for}` : ''}.</p>}
                  {d?.held_value ? <div className="mt-2"><HeldOrders decision={d} /></div> : null}
                </section>
              )
            })()}
            {selectedType.aiBriefType && <ApprovalBrief type={selectedType.aiBriefType} id={selected.row.id} />}
            <DescriptionList items={selectedType.detail(selected.row).filter(([, value]) => value != null && value !== '—' && value !== '').map(([label, value]) => ({ label, value }))} />
            {showStockFields && (
              <section className="space-y-3 border-t border-ink-200 pt-4">
                <p className="text-sm font-medium text-ink-800">Stock control applied on approval</p>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                  {selectedType.stockFields.map((f) => (
                    <Field key={f.key} label={f.label} optional>
                      <Input numeric value={stockParams[f.key]} onChange={(e) => setStockParams((p) => ({ ...p, [f.key]: e.target.value }))} />
                    </Field>
                  ))}
                </div>
              </section>
            )}
          </div>
        )}
      </Sheet>

      {reject && (
        <ConfirmDialog
          open
          onClose={() => setReject(null)}
          title={`Reject ${reject.row.title}?`}
          consequence={`The ${TYPE_MAP[reject.typeId].label.toLowerCase().replace(/s$/, '')} goes back to its requester as rejected, with your reason.`}
          confirmLabel={`Reject ${reject.row.title}`}
          requireReason
          busy={processing.has(`${reject.typeId}:${reject.row.id}`)}
          onConfirm={async (reason) => {
            await handleDecline(reject.typeId, reject.row, reason, () => { setSelected(null) })
            setReject(null)
          }}
        />
      )}

      {bulk && (
        <ConfirmDialog
          open
          tone="primary"
          onClose={() => setBulk(null)}
          title={`Approve ${bulk.length} decision${bulk.length === 1 ? '' : 's'}?`}
          consequence={`${bulk.map((r) => r.title).slice(0, 6).join(', ')}${bulk.length > 6 ? ` and ${bulk.length - 6} more` : ''}${bulkTotal ? ` — ${formatMoney(bulkTotal, 'USD', 0)} in total` : ''}.`}
          confirmLabel={`Approve ${bulk.length}`}
          onConfirm={async () => { const target = bulk; setBulk(null); await bulkApproveRows(target) }}
        />
      )}
    </div>
  )
}

export default UnifiedApprovalPortal
