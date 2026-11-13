import json
import os
import re

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
LOCALES_DIR = os.path.join(BASE_DIR, 'src', 'i18n', 'locales')

LOCALES = [
    'ar.json', 'az.json', 'bn.json', 'de.json', 'es.json',
    'fa.json', 'fr.json', 'hi.json', 'id.json', 'it.json',
    'ja.json', 'ko.json', 'nl.json', 'pl.json', 'pt.json',
    'ru.json', 'tr.json', 'uk.json', 'ur.json', 'vi.json',
    'zh.json'
]

def flatten(obj, prefix=''):
    flat = {}
    for k, v in obj.items():
        key = f"{prefix}.{k}" if prefix else k
        if isinstance(v, dict):
            flat.update(flatten(v, key))
        elif isinstance(v, str):
            flat[key] = v
    return flat

def tNavKey(label):
    if not label:
        return label
    clean = re.sub(r'[^A-Za-z0-9 ]+', ' ', str(label)).strip()
    words = clean.split()
    if not words:
        return label
    key = words[0].lower() + ''.join(w.capitalize() for w in words[1:])
    return f"nav.{key}"

labels = [
    'Overview', 'Dashboard', 'Operations', 'Inventory', 'Inventory Overview', 'Inventory Items', 'Item Master', 'Warehouse', 'Warehouse Transactions', 'Inventory Transfers', 'Stocktake / Counting', 'Barcode Scanning',
    'Procurement', 'Procurement Dashboard', 'Suppliers', 'Contracts', 'Purchase Requisitions', 'Request for Quotations', 'Purchase Orders',
    'Sales', 'Customers', 'Sales Contracts', 'RFQ to Suppliers', 'Sales Quotations', 'Sales Orders', 'Delivery Schedules',
    'Manufacturing', 'Production', 'Work Orders', 'Bills of Material', 'MRP II Workbench', 'Work Centers & Routing',
    'Customers & Delivery', 'CRM', 'Leads', 'Deal Pipeline', 'Contacts', 'Activities', 'Projects', 'All Projects', 'My Timesheet',
    'Financials', 'Finance Overview', 'General Ledger', 'Chart of Accounts', 'Journal Entries', 'Receivables (AR)', 'Customer Invoices', 'Recurring Invoices', 'Payments Received',
    'Payables (AP)', 'Supplier Invoices', 'Invoice Intake (AI)', 'Credit Notes', 'Supplier Payments',
    'Assets & Cash', 'Fixed Assets', 'Bank Reconciliation', 'Cash Flow Forecast',
    'Controlling', 'Cost Centers', 'Budgets', 'Currencies & FX', 'Accounting Periods',
    'Reports', 'Trial Balance', 'Balance Sheet', 'Income Statement', 'Aging (AR/AP)', 'GR/IR Aging', 'Year-End Close Wizard', 'VAT Return',
    'Human Resources', 'HR & Payroll', 'Employees', 'Leave & Attendance', 'Payroll',
    'Intelligence', 'Reporting', 'All Reports', 'Dashboards', 'Scheduled Reports', 'Simeli AI', 'AI Chat', 'Business Intelligence', 'Transaction Analysis', 'AI Anomaly Resolution', 'Autonomous Agents', 'Build an Agent', 'Tool Library', 'Documents & Templates', 'Knowledge Base', 'AI Governance', 'AI Settings',
    'Governance', 'Delegation of Authority', 'DOA Management', 'Approval Inbox', 'Approval Simulator', 'Audit Trail',
    'Administration', 'Admin', 'User Management', 'SaaS Plan & Billing', 'Integrations', 'Modules'
]

print("=== AUDIT OF ALL 21 LOCALES FOR NAV KEYS ===")
for loc in LOCALES:
    file_path = os.path.join(LOCALES_DIR, loc)
    if not os.path.exists(file_path):
        print(f"MISSING FILE: {loc}")
        continue
    with open(file_path, 'r', encoding='utf-8') as f:
        data = json.load(f)
    flat = flatten(data)
    
    untranslated = []
    for l in labels:
        k = tNavKey(l)
        val = flat.get(k)
        if not val or val.lower() == l.lower() or val == k:
            untranslated.append((l, k, val))
            
    print(f"{loc}: {len(untranslated)} untranslated/matching-English nav keys out of {len(labels)}")
    if untranslated:
        for l, k, v in untranslated[:5]:
            print(f"   Label '{l}' -> Key '{k}' = {repr(v)}")
