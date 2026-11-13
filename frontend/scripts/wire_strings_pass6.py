#!/usr/bin/env python3
"""Sixth-pass: actual strings in finance/projects/ai files."""
import os, json

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC_DIR = os.path.join(BASE_DIR, 'src')
LOCALES_DIR = os.path.join(BASE_DIR, 'src', 'i18n', 'locales')
LOCALES = ['ar','az','bn','de','es','fa','fr','hi','id','it','ja','ko','nl','pl','pt','ru','tr','uk','ur','vi','zh']

def patch(filepath, pairs):
    full = os.path.join(SRC_DIR, filepath.replace('/', os.sep))
    if not os.path.exists(full):
        print(f"  SKIP: {filepath}"); return 0
    with open(full, 'r', encoding='utf-8', errors='replace') as f:
        content = f.read()
    original = content
    n = 0
    for old, new in pairs:
        if old in content:
            content = content.replace(old, new)
            n += 1
        else:
            print(f"  MISS [{filepath}]: {old[:60]!r}")
    if content != original:
        with open(full, 'w', encoding='utf-8') as f:
            f.write(content)
        print(f"  OK [{filepath}]: {n} wired")
    return n

def add_keys(new_keys):
    """Add keys to all locale files."""
    for lang_file in ['en'] + LOCALES:
        fpath = os.path.join(LOCALES_DIR, f'{lang_file}.json')
        if not os.path.exists(fpath): continue
        with open(fpath, 'r', encoding='utf-8') as f:
            data = json.load(f)
        if 'ui' not in data: data['ui'] = {}
        added = 0
        for k, v in new_keys.items():
            if k not in data['ui']:
                data['ui'][k] = v
                added += 1
        if added:
            with open(fpath, 'w', encoding='utf-8') as f:
                json.dump(data, f, ensure_ascii=False, indent=2)
                f.write('\n')
    print(f"  Added {len(new_keys)} keys to all locales")

# ---- New keys for this pass ----
add_keys({
    # BankReconciliation
    "failedToLoadBankAccounts": "Failed to load bank accounts",
    "failedToLoadAccount": "Failed to load account",
    "accountNameIsRequired": "Account name is required",
    "bankAccountAdded": "Bank account added",
    "failedToAddAccount": "Failed to add account",
    "statementLineAdded": "Statement line added",
    "failedToAddLine": "Failed to add line",
    # Budgets
    "failedToLoadBudgets": "Failed to load budgets",
    "failedToLoadReport": "Failed to load report",
    "nameAndFiscalYearAreRequired": "Name and fiscal year are required",
    "budgetCreated": "Budget created",
    "failedToCreateBudget": "Failed to create budget",
    "accountAndAmountAreRequired": "Account and amount are required",
    "budgetLineAdded": "Budget line added",
    # Currencies
    "failedToLoadCurrencies": "Failed to load currencies",
    "noRateAvailable": "No rate available",
    "conversionFailed": "Conversion failed",
    "codeAndNameAreRequired": "Code and name are required",
    "failedToAdd": "Failed to add",
    "rateSaved": "Rate saved",
    "failedToAddRate": "Failed to add rate",
    # Timesheet
    "couldNotLoadTimesheet": "Could not load your timesheet",
    "timeEntryDeleted": "Time entry deleted",
    "couldNotDeleteThatEntry": "Could not delete that entry",
    "chooseAProject": "Choose a project",
    "hoursMustBeBetween0And24": "Hours must be between 0 and 24",
    "timeEntryUpdated": "Time entry updated",
    "couldNotSaveThatTimeEntry": "Could not save that time entry",
    # KnowledgeBase
    "couldNotLoadKnowledgeBase": "Could not load the knowledge base",
    "removed": "Removed",
    "couldNotRemoveThatDocument": "Could not remove that document",
    "chooseAFileFirst": "Choose a file first",
    "titleAndContentAreRequired": "Title and content are both required",
    "uploadedIndexingInBackground": "Uploaded — indexing in the background",
    "couldNotUploadThatDocument": "Could not upload that document",
    # BOM extras
    "couldNotActivateBom": "Could not activate this bill of material",
    "couldNotCreateBom": "Could not create the bill of material",
    "couldNotLoadBom": "Could not load the bill of material",
    "couldNotAddComponent": "Could not add the component",
    "couldNotExplodeBom": "Could not explode this bill of material",
    "chooseAComponent": "Choose a component",
    "quantityPerOutputMustBeGreaterThanZero": "Quantity per output must be greater than zero",
    "componentAdded": "Component added",
    "bomCreatedAsDraft": "Bill of material created as a draft",
    # SalesRfq extras
    "failedToImportSalesOrderItems": "Failed to import sales order items",
    "pleaseEnterAtLeast3Characters": "Please enter at least 3 characters",
    "itemDetailsGeneratedWithAI": "Item details generated with AI",
    "failedToGenerateItemDetailsWithAI": "Failed to generate item details with AI",
    # Quotation extras
    "quotationSavedAsDraft": "Quotation saved as draft",
    # GoodsReceipt/Transfer alt strings
    "goodsReceiptPostedSuccessfully": "Goods receipt posted successfully",
    "goodsTransferPostedSuccessfully": "Goods transfer posted successfully",
})

# ---- BankReconciliation.jsx ----
patch("pages/finance/BankReconciliation.jsx", [
    ("err.response?.data?.error || 'Failed to load bank accounts'", "err.response?.data?.error || t('ui.failedToLoadBankAccounts')"),
    ("err.response?.data?.error || 'Failed to load account'", "err.response?.data?.error || t('ui.failedToLoadAccount')"),
    ("err.response?.data?.error || 'Failed to update'", "err.response?.data?.error || t('ui.failedToUpdate')"),
    ("toast.error('Account name is required')", "toast.error(t('ui.accountNameIsRequired'))"),
    ("toast.success('Bank account added')", "toast.success(t('ui.bankAccountAdded'))"),
    ("err.response?.data?.error || 'Failed to add account'", "err.response?.data?.error || t('ui.failedToAddAccount')"),
    ("toast.error('Enter a valid amount')", "toast.error(t('ui.enterAValidAmount'))"),
    ("toast.success('Statement line added')", "toast.success(t('ui.statementLineAdded'))"),
    ("err.response?.data?.error || 'Failed to add line'", "err.response?.data?.error || t('ui.failedToAddLine')"),
])

# ---- Budgets.jsx ----
patch("pages/finance/Budgets.jsx", [
    ("err.response?.data?.error || 'Failed to load budgets'", "err.response?.data?.error || t('ui.failedToLoadBudgets')"),
    ("err.response?.data?.error || 'Failed to load report'", "err.response?.data?.error || t('ui.failedToLoadReport')"),
    ("toast.error('Name and fiscal year are required')", "toast.error(t('ui.nameAndFiscalYearAreRequired'))"),
    ("toast.success('Budget created')", "toast.success(t('ui.budgetCreated'))"),
    ("err.response?.data?.error || 'Failed to create budget'", "err.response?.data?.error || t('ui.failedToCreateBudget')"),
    ("toast.error('Account and amount are required')", "toast.error(t('ui.accountAndAmountAreRequired'))"),
    ("toast.success('Budget line added')", "toast.success(t('ui.budgetLineAdded'))"),
    ("err.response?.data?.error || 'Failed to add line'", "err.response?.data?.error || t('ui.failedToAddLine')"),
])

# ---- Currencies.jsx ----
patch("pages/finance/Currencies.jsx", [
    ("err.response?.data?.error || 'Failed to load currencies'", "err.response?.data?.error || t('ui.failedToLoadCurrencies')"),
    ("d?.error || 'No rate available'", "d?.error || t('ui.noRateAvailable')"),
    ("err.response?.data?.error || 'Conversion failed'", "err.response?.data?.error || t('ui.conversionFailed')"),
    ("toast.error('Code and name are required')", "toast.error(t('ui.codeAndNameAreRequired'))"),
    ("err.response?.data?.error || 'Failed to add'", "err.response?.data?.error || t('ui.failedToAdd')"),
    ("toast.error('Enter a valid rate')", "toast.error(t('ui.enterAValidAmount'))"),
    ("toast.success('Rate saved')", "toast.success(t('ui.rateSaved'))"),
    ("err.response?.data?.error || 'Failed to add rate'", "err.response?.data?.error || t('ui.failedToAddRate')"),
    ("toast.success('Currency added')", "toast.success(t('ui.currencyAdded'))"),
])

# ---- Timesheet.jsx ----
patch("pages/projects/Timesheet.jsx", [
    ("err.response?.data?.error || 'Could not load your timesheet.'", "err.response?.data?.error || t('ui.couldNotLoadTimesheet')"),
    ("toast.success('Time entry deleted')", "toast.success(t('ui.timeEntryDeleted'))"),
    ("err.response?.data?.error || 'Could not delete that entry.'", "err.response?.data?.error || t('ui.couldNotDeleteThatEntry')"),
    ("toast.error('Choose a project.')", "toast.error(t('ui.chooseAProject'))"),
    ("toast.error('Hours must be between 0 and 24.')", "toast.error(t('ui.hoursMustBeBetween0And24'))"),
    ("toast.success('Time entry updated')", "toast.success(t('ui.timeEntryUpdated'))"),
    ("err.response?.data?.error || 'Could not save that time entry.'", "err.response?.data?.error || t('ui.couldNotSaveThatTimeEntry')"),
])

# ---- KnowledgeBase.jsx ----
patch("pages/ai/KnowledgeBase.jsx", [
    ("err.response?.data?.error || 'Could not load the knowledge base'", "err.response?.data?.error || t('ui.couldNotLoadKnowledgeBase')"),
    ("toast.success('Removed')", "toast.success(t('ui.removed'))"),
    ("err.response?.data?.error || 'Could not remove that document'", "err.response?.data?.error || t('ui.couldNotRemoveThatDocument')"),
    ("toast.error('Choose a file first')", "toast.error(t('ui.chooseAFileFirst'))"),
    ("toast.error('Title and content are both required')", "toast.error(t('ui.titleAndContentAreRequired'))"),
    ("err.response?.data?.error || 'Could not upload that document'", "err.response?.data?.error || t('ui.couldNotUploadThatDocument')"),
])

# ---- GoodsReceipt.jsx (view actual content) ----
fpath = os.path.join(SRC_DIR, 'pages', 'warehouse', 'transactions', 'GoodsReceipt.jsx')
if os.path.exists(fpath):
    with open(fpath, 'r', encoding='utf-8', errors='replace') as f:
        content = f.read()
    lines = content.split('\n')
    for i, ln in enumerate(lines, 1):
        if 'toast' in ln and 'ui.' not in ln:
            print(f"GoodsReceipt L{i}: {ln.strip()!r}")

# ---- GoodsTransfer.jsx (view actual content) ----
fpath2 = os.path.join(SRC_DIR, 'pages', 'warehouse', 'transactions', 'GoodsTransfer.jsx')
if os.path.exists(fpath2):
    with open(fpath2, 'r', encoding='utf-8', errors='replace') as f:
        content2 = f.read()
    lines2 = content2.split('\n')
    for i, ln in enumerate(lines2, 1):
        if 'toast' in ln and 'ui.' not in ln:
            print(f"GoodsTransfer L{i}: {ln.strip()!r}")

print("\nDone.")
