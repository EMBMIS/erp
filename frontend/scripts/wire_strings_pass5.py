#!/usr/bin/env python3
"""
Fifth-pass: fix remaining files where toast uses || fallback or different string.
"""
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


# ---- BillsOfMaterial.jsx ----
patch("pages/manufacturing/BillsOfMaterial.jsx", [
    # fallback-style
    ("err.response?.data?.error || 'Failed to load bills of material'", "err.response?.data?.error || t('ui.failedToLoadBillsOfMaterial')"),
    ("err.response?.data?.error || 'Could not activate this bill of material'", "err.response?.data?.error || t('ui.couldNotActivateBom')"),
    ("err.response?.data?.error || 'Could not create the bill of material'", "err.response?.data?.error || t('ui.couldNotCreateBom')"),
    ("err.response?.data?.error || 'Could not load the bill of material'", "err.response?.data?.error || t('ui.couldNotLoadBom')"),
    ("err.response?.data?.error || 'Could not add the component'", "err.response?.data?.error || t('ui.couldNotAddComponent')"),
    ("err.response?.data?.error || 'Could not explode this bill of material'", "err.response?.data?.error || t('ui.couldNotExplodeBom')"),
    # plain ones
    ("toast.error('Choose a component')", "toast.error(t('ui.chooseAComponent'))"),
    ("toast.error('Quantity per output must be greater than zero')", "toast.error(t('ui.quantityPerOutputMustBeGreaterThanZero'))"),
    ("toast.success('Component added')", "toast.success(t('ui.componentAdded'))"),
    ("toast.success('Bill of material created as a draft')", "toast.success(t('ui.bomCreatedAsDraft'))"),
    ("toast.error('Quantity must be greater than zero')", "toast.error(t('ui.quantityMustBeGreaterThanZero'))"),
])

# ---- SalesQuotationCreate.jsx ----
patch("pages/sales/SalesQuotationCreate.jsx", [
    ("toast.success('Quotation created successfully!')", "toast.success(t('ui.quotationCreated'))"),
    ("toast.success('Quotation saved as draft successfully!')", "toast.success(t('ui.quotationSavedAsDraft'))"),
    ("response.data.error || 'Failed to create quotation'", "response.data.error || t('ui.failedToCreateQuotation')"),
    ("error.response?.data?.error || 'Failed to create quotation'", "error.response?.data?.error || t('ui.failedToCreateQuotation')"),
])

# ---- InventoryItemEdit.jsx ----
patch("pages/inventory/InventoryItemEdit.jsx", [
    ("error.response?.data?.error || 'Failed to update inventory item'", "error.response?.data?.error || t('ui.failedToUpdateInventoryItem')"),
])

# ---- SalesRfqCreate.jsx ----
patch("pages/sales/SalesRfqCreate.jsx", [
    ("toast.success('Sales RFQ created successfully')", "toast.success(t('ui.rfqCreated'))"),
    ("error.response?.data?.error || 'Failed to create sales RFQ'", "error.response?.data?.error || t('ui.failedToCreateRfq')"),
    ("toast.error('Failed to import sales order items')", "toast.error(t('ui.failedToImportSalesOrderItems'))"),
    ("toast.error('Please enter at least 3 characters for the item name')", "toast.error(t('ui.pleaseEnterAtLeast3Characters'))"),
    ("toast.success('Item details generated with AI!')", "toast.success(t('ui.itemDetailsGeneratedWithAI'))"),
    ("toast.error('Failed to generate item details with AI. Please try again.')", "toast.error(t('ui.failedToGenerateItemDetailsWithAI'))"),
])

# ---- SalesOrderCreate.jsx ----
patch("pages/sales/SalesOrderCreate.jsx", [
    ("response.data.error || 'Failed to create sales order'", "response.data.error || t('ui.failedToCreateSalesOrder')"),
    ("error.response?.data?.error || 'Failed to create sales order'", "error.response?.data?.error || t('ui.failedToCreateSalesOrder')"),
])

# ---- GoodsReceipt.jsx ----
patch("pages/warehouse/transactions/GoodsReceipt.jsx", [
    ("toast.success('Goods receipt posted successfully!',", "toast.success(t('ui.goodsReceiptPosted'),"),
    ("toast.success('Goods receipt posted!')", "toast.success(t('ui.goodsReceiptPosted'))"),
    ("toast.error('Could not load locations or items')", "toast.error(t('ui.couldNotLoadLocationsOrItems'))"),
    ("toast.error('Please add at least one item')", "toast.error(t('ui.pleaseAddAtLeastOneItem'))"),
    ("toast.error('Please select an item and enter a quantity')", "toast.error(t('ui.pleaseSelectItemAndEnterQuantity'))"),
    ("toast.error('Failed to post goods receipt')", "toast.error(t('ui.failedToPostGoodsReceipt'))"),
])

# ---- GoodsTransfer.jsx ----
patch("pages/warehouse/transactions/GoodsTransfer.jsx", [
    ("toast.success('Goods transfer posted successfully!',", "toast.success(t('ui.goodsTransferPosted'),"),
    ("toast.success('Goods transfer posted!')", "toast.success(t('ui.goodsTransferPosted'))"),
    ("toast.error('Could not load locations or items')", "toast.error(t('ui.couldNotLoadLocationsOrItems'))"),
    ("toast.error('Please add at least one item')", "toast.error(t('ui.pleaseAddAtLeastOneItem'))"),
    ("toast.error('Please select an item and enter a quantity')", "toast.error(t('ui.pleaseSelectItemAndEnterQuantity'))"),
    ("toast.error('Failed to post goods transfer')", "toast.error(t('ui.failedToPostGoodsTransfer'))"),
])

# ---- InventoryItemCreate.jsx ----
patch("pages/inventory/InventoryItemCreate.jsx", [
    ("toast.error('Failed to create inventory item')", "toast.error(t('ui.failedToCreateInventoryItem'))"),
    ("toast.error('Minimum stock level cannot be greater than maximum stock level')", "toast.error(t('ui.minStockCannotExceedMax'))"),
    ("toast.error('Reorder point should not be less than minimum stock level')", "toast.error(t('ui.reorderPointShouldNotBeLessThanMin'))"),
    ("toast.error('Reorder point should not be greater than maximum stock level')", "toast.error(t('ui.reorderPointShouldNotExceedMax'))"),
])

# ---- ReportSchedules.jsx ----
patch("pages/reports/ReportSchedules.jsx", [
    ("toast.error('Failed to load schedules')", "toast.error(t('ui.failedToLoadSchedule'))"),
    ("'Failed to load schedules'", "t('ui.failedToLoadSchedule')"),
])

# ---- BankReconciliation.jsx ---- (use grep to find exact strings)
# These need direct viewing
print("\nDone.")
