#!/usr/bin/env python3
"""Fourth-pass: fix remaining MISS strings with exact literals found in files."""
import os

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC_DIR = os.path.join(BASE_DIR, 'src')

def patch(filepath, pairs):
    full = os.path.join(SRC_DIR, filepath.replace('/', os.sep))
    if not os.path.exists(full):
        print(f"  SKIP: {filepath}")
        return 0
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


patch("pages/manufacturing/BillsOfMaterial.jsx", [
    ("toast.error('Failed to load bills of material')", "toast.error(t('ui.failedToLoadBillsOfMaterial'))"),
])

patch("pages/sales/SalesQuotationCreate.jsx", [
    ("toast.error('Failed to create quotation')", "toast.error(t('ui.failedToCreateQuotation'))"),
])

patch("pages/inventory/InventoryItemEdit.jsx", [
    ("toast.error('Failed to update inventory item')", "toast.error(t('ui.failedToUpdateInventoryItem'))"),
])

patch("pages/sales/SalesRfqCreate.jsx", [
    ("toast.success('RFQ created successfully')", "toast.success(t('ui.rfqCreated'))"),
    ("toast.error('Failed to create RFQ')", "toast.error(t('ui.failedToCreateRfq'))"),
])

patch("pages/sales/SalesOrderCreate.jsx", [
    ("toast.error('Failed to create sales order')", "toast.error(t('ui.failedToCreateSalesOrder'))"),
])

patch("pages/sales/DeliveryScheduling.jsx", [
    ("toast.success('Delivery schedule created successfully')", "toast.success(t('ui.deliveryScheduleCreatedSuccessfully'))"),
])

patch("pages/warehouse/transactions/GoodsReceipt.jsx", [
    ("toast.success('Goods receipt posted successfully!'", "toast.success(t('ui.goodsReceiptPosted'),"),
    ("toast.success('Goods receipt posted!')", "toast.success(t('ui.goodsReceiptPosted'))"),
    ("toast.error('Could not load locations or items')", "toast.error(t('ui.couldNotLoadLocationsOrItems'))"),
    ("toast.error('Please add at least one item')", "toast.error(t('ui.pleaseAddAtLeastOneItem'))"),
    ("toast.error('Please select an item and enter a quantity')", "toast.error(t('ui.pleaseSelectItemAndEnterQuantity'))"),
    ("toast.error('Failed to post goods receipt')", "toast.error(t('ui.failedToPostGoodsReceipt'))"),
])

patch("pages/warehouse/transactions/GoodsTransfer.jsx", [
    ("toast.success('Goods transfer posted successfully!'", "toast.success(t('ui.goodsTransferPosted'),"),
    ("toast.success('Goods transfer posted!')", "toast.success(t('ui.goodsTransferPosted'))"),
    ("toast.error('Could not load locations or items')", "toast.error(t('ui.couldNotLoadLocationsOrItems'))"),
    ("toast.error('Please add at least one item')", "toast.error(t('ui.pleaseAddAtLeastOneItem'))"),
    ("toast.error('Please select an item and enter a quantity')", "toast.error(t('ui.pleaseSelectItemAndEnterQuantity'))"),
    ("toast.error('Failed to post goods transfer')", "toast.error(t('ui.failedToPostGoodsTransfer'))"),
])

patch("pages/inventory/InventoryItemCreate.jsx", [
    ("toast.error('Failed to create inventory item')", "toast.error(t('ui.failedToCreateInventoryItem'))"),
    ("toast.error('Minimum stock level cannot be greater than maximum stock level')", "toast.error(t('ui.minStockCannotExceedMax'))"),
    ("toast.error('Reorder point should not be less than minimum stock level')", "toast.error(t('ui.reorderPointShouldNotBeLessThanMin'))"),
    ("toast.error('Reorder point should not be greater than maximum stock level')", "toast.error(t('ui.reorderPointShouldNotExceedMax'))"),
])

patch("pages/reports/ReportSchedules.jsx", [
    ("toast.error('Failed to load schedules')", "toast.error(t('ui.failedToLoadSchedule'))"),
])

patch("pages/ai/AIChat.jsx", [
    ("toast.error('Failed to send message. Please try again.')", "toast.error(t('ui.failedToSendMessage'))"),
])

# Check other common patterns with single quotes vs double quotes
patch("pages/finance/BankReconciliation.jsx", [
    ("toast.success('Transaction matched')", "toast.success(t('ui.transactionMatched'))"),
    ('toast.success("Transaction matched")', 'toast.success(t("ui.transactionMatched"))'),
    ("toast.error('Failed to match transaction')", "toast.error(t('ui.failedToMatchTransaction'))"),
    ('toast.error("Failed to match transaction")', 'toast.error(t("ui.failedToMatchTransaction"))'),
    ("toast.success('Match cleared')", "toast.success(t('ui.matchCleared'))"),
    ('toast.success("Match cleared")', 'toast.success(t("ui.matchCleared"))'),
    ("toast.error('Failed to clear match')", "toast.error(t('ui.failedToClearMatch'))"),
    ('toast.error("Failed to clear match")', 'toast.error(t("ui.failedToClearMatch"))'),
])

patch("pages/finance/Budgets.jsx", [
    ("toast.success('Budget saved')", "toast.success(t('ui.budgetSaved'))"),
    ('toast.success("Budget saved")', 'toast.success(t("ui.budgetSaved"))'),
    ("toast.error('Failed to save budget')", "toast.error(t('ui.failedToSaveBudget'))"),
    ('toast.error("Failed to save budget")', 'toast.error(t("ui.failedToSaveBudget"))'),
    ("toast.success('Budget deleted')", "toast.success(t('ui.budgetDeleted'))"),
    ('toast.success("Budget deleted")', 'toast.success(t("ui.budgetDeleted"))'),
    ("toast.error('Failed to delete budget')", "toast.error(t('ui.failedToDeleteBudget'))"),
    ('toast.error("Failed to delete budget")', 'toast.error(t("ui.failedToDeleteBudget"))'),
])

patch("pages/finance/Currencies.jsx", [
    ("toast.success('Rate updated')", "toast.success(t('ui.rateUpdated'))"),
    ('toast.success("Rate updated")', 'toast.success(t("ui.rateUpdated"))'),
    ("toast.error('Failed to update rate')", "toast.error(t('ui.failedToUpdateRate'))"),
    ('toast.error("Failed to update rate")', 'toast.error(t("ui.failedToUpdateRate"))'),
    ("toast.error('Failed to add currency')", "toast.error(t('ui.failedToAddCurrency'))"),
    ('toast.error("Failed to add currency")', 'toast.error(t("ui.failedToAddCurrency"))'),
])

patch("pages/projects/Timesheet.jsx", [
    ("toast.success('Time logged')", "toast.success(t('ui.timeLogged'))"),
    ('toast.success("Time logged")', 'toast.success(t("ui.timeLogged"))'),
    ("toast.error('Failed to log time')", "toast.error(t('ui.failedToLogTime'))"),
    ('toast.error("Failed to log time")', 'toast.error(t("ui.failedToLogTime"))'),
    ("toast.success('Entry deleted')", "toast.success(t('ui.entryDeleted'))"),
    ('toast.success("Entry deleted")', 'toast.success(t("ui.entryDeleted"))'),
    ("toast.error('Failed to delete entry')", "toast.error(t('ui.failedToDeleteEntry'))"),
    ('toast.error("Failed to delete entry")', 'toast.error(t("ui.failedToDeleteEntry"))'),
])

patch("pages/ai/KnowledgeBase.jsx", [
    ("toast.success('Document uploaded')", "toast.success(t('ui.documentUploaded'))"),
    ('toast.success("Document uploaded")', 'toast.success(t("ui.documentUploaded"))'),
    ("toast.error('Failed to upload document')", "toast.error(t('ui.failedToUploadDocument'))"),
    ('toast.error("Failed to upload document")', 'toast.error(t("ui.failedToUploadDocument"))'),
    ("toast.success('Document deleted')", "toast.success(t('ui.documentDeleted'))"),
    ('toast.success("Document deleted")', 'toast.success(t("ui.documentDeleted"))'),
    ("toast.error('Failed to delete document')", "toast.error(t('ui.failedToDeleteDocument'))"),
    ('toast.error("Failed to delete document")', 'toast.error(t("ui.failedToDeleteDocument"))'),
])

print("\nDone.")
