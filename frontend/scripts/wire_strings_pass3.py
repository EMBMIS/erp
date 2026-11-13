#!/usr/bin/env python3
"""
Third-pass: wire remaining high-count files.
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
            content = content.replace(old, new, 1)
            n += 1
        else:
            print(f"  MISS [{filepath}]: {old[:60]!r}")
    if content != original:
        with open(full, 'w', encoding='utf-8') as f:
            f.write(content)
        print(f"  OK [{filepath}]: {n}/{len(pairs)} wired")
    return n


# ---- pages/manufacturing/BillsOfMaterial.jsx ----
patch("pages/manufacturing/BillsOfMaterial.jsx", [
    ("toast.error('A bill of material with no components cannot be activated.')", "toast.error(t('ui.bomCannotBeActivatedWithNoComponents'))"),
    ("toast.error('Could not load the item master')", "toast.error(t('ui.couldNotLoadTheItemMaster'))"),
    ("toast.error('Choose which item this recipe produces')", "toast.error(t('ui.chooseWhichItemThisRecipeProduces'))"),
    ("toast.error('Output quantity must be greater than zero')", "toast.error(t('ui.outputQuantityMustBeGreaterThanZero'))"),
    ("toast.error('An item cannot be a component of itself.')", "toast.error(t('ui.itemCannotBeComponentOfItself'))"),
    ("toast.error('Please add at least one component')", "toast.error(t('ui.pleaseAddAtLeastOneComponent'))"),
    ("toast.success('Bill of material activated')", "toast.success(t('ui.bomActivated'))"),
    ("toast.success('Bill of material saved')", "toast.success(t('ui.bomSaved'))"),
    ("toast.success('Bill of material created')", "toast.success(t('ui.bomCreated'))"),
    ("toast.success('Bill of material deleted')", "toast.success(t('ui.bomDeleted'))"),
    ("toast.error('Failed to delete bill of material')", "toast.error(t('ui.failedToDeleteBom'))"),
    ("toast.error('Failed to load bills of material')", "toast.error(t('ui.failedToLoadBillsOfMaterial'))"),
])

# ---- pages/warehouse/BinCreate.jsx ----
patch("pages/warehouse/BinCreate.jsx", [
    ("toast.success('Bin submitted for approval!')", "toast.success(t('ui.binSubmittedForApproval'))"),
    ("toast.success('Bin saved as draft!')", "toast.success(t('ui.binSavedAsDraft'))"),
    ("toast.error('Maximum mass capacity must be greater than 0')", "toast.error(t('ui.maxMassCapacityMustBeGreaterThanZero'))"),
    ("toast.error('Maximum volume capacity must be greater than 0')", "toast.error(t('ui.maxVolumeCapacityMustBeGreaterThanZero'))"),
    ("toast.error('Current mass used cannot exceed maximum mass capacity')", "toast.error(t('ui.currentMassUsedCannotExceedMaximum'))"),
    ("toast.error('Bin name is required')", "toast.error(t('ui.binNameIsRequired'))"),
    ("toast.error('Storage location is required')", "toast.error(t('ui.storageLocationIsRequired'))"),
])

# ---- pages/admin/Integrations.jsx ----
patch("pages/admin/Integrations.jsx", [
    ("toast.error('API keys are administrator-only')", "toast.error(t('ui.apiKeysAreAdministratorOnly'))"),
    ("toast.success('Key revoked')", "toast.success(t('ui.keyRevoked'))"),
    ("toast.error('Give the key a name')", "toast.error(t('ui.giveTheKeyAName'))"),
    ("toast.error('A key with no scopes can do nothing')", "toast.error(t('ui.keyWithNoScopesCanDoNothing'))"),
    ("toast.success('API key created')", "toast.success(t('ui.apiKeyCreated'))"),
    ("toast.error('Failed to create API key')", "toast.error(t('ui.failedToCreateApiKey'))"),
])

# ---- pages/sales/SalesContractCreate.jsx ----
patch("pages/sales/SalesContractCreate.jsx", [
    ("toast.error('Contract name is required')", "toast.error(t('ui.contractNameIsRequired'))"),
    ("toast.error('Start date and end date are required')", "toast.error(t('ui.startDateAndEndDateAreRequired'))"),
    ("toast.error('End date must be after start date')", "toast.error(t('ui.endDateMustBeAfterStartDate'))"),
    ("toast.error('At least one valid item is required')", "toast.error(t('ui.atLeastOneValidItemIsRequired'))"),
    ("toast.success('Contract sent for approval successfully!')", "toast.success(t('ui.contractSentForApproval'))"),
    ("toast.success('Contract created successfully!')", "toast.success(t('ui.contractCreated'))"),
    ("toast.error('Failed to create contract')", "toast.error(t('ui.failedToCreateContract'))"),
])

# ---- pages/sales/SalesQuotationCreate.jsx ----
patch("pages/sales/SalesQuotationCreate.jsx", [
    ("toast.error('Please select a customer')", "toast.error(t('ui.pleaseSelectACustomer'))"),
    ("toast.error('Please add at least one item')", "toast.error(t('ui.pleaseAddAtLeastOneItem'))"),
    ("toast.error('Please fill in all required item details')", "toast.error(t('ui.pleaseFillInAllRequiredItemDetails'))"),
    ("toast.success('Quotation sent for approval successfully!')", "toast.success(t('ui.quotationSentForApproval'))"),
    ("toast.success('Quotation created successfully!')", "toast.success(t('ui.quotationCreated'))"),
    ("toast.error('Failed to create quotation')", "toast.error(t('ui.failedToCreateQuotation'))"),
    ("toast.error('Failed to fetch quotation')", "toast.error(t('ui.failedToFetchQuotation'))"),
])

# ---- pages/warehouse/transactions/StockAdjustment.jsx ----
patch("pages/warehouse/transactions/StockAdjustment.jsx", [
    ("toast.error('Please select an item and enter physical quantity')", "toast.error(t('ui.pleaseSelectItemAndEnterQuantity'))"),
    ("toast.success('Stock adjustment submitted for approval!')", "toast.success(t('ui.stockAdjustmentSubmittedForApproval'))"),
    ("toast.success('Stock adjustment posted successfully!')", "toast.success(t('ui.stockAdjustmentPostedSuccessfully'))"),
    ("toast.error('Please add at least one item to adjust')", "toast.error(t('ui.pleaseAddAtLeastOneItemToAdjust'))"),
    ("toast.error('Please remove items with zero adjustment quantity')", "toast.error(t('ui.pleaseRemoveItemsWithZeroQuantity'))"),
    ("toast.error('Could not load locations or items')", "toast.error(t('ui.couldNotLoadLocationsOrItems'))"),
])

# ---- pages/inventory/InventoryItemEdit.jsx ----
patch("pages/inventory/InventoryItemEdit.jsx", [
    ("toast.error('Failed to fetch inventory item')", "toast.error(t('ui.failedToFetchInventoryItem'))"),
    ("toast.error('Minimum stock level cannot be greater than maximum stock level')", "toast.error(t('ui.minStockCannotExceedMax'))"),
    ("toast.error('Reorder point should not be less than minimum stock level')", "toast.error(t('ui.reorderPointShouldNotBeLessThanMin'))"),
    ("toast.error('Reorder point should not be greater than maximum stock level')", "toast.error(t('ui.reorderPointShouldNotExceedMax'))"),
    ("toast.success('Inventory item updated successfully')", "toast.success(t('ui.inventoryItemUpdatedSuccessfully'))"),
    ("toast.error('Failed to update inventory item')", "toast.error(t('ui.failedToUpdateInventoryItem'))"),
    ("toast.error('Failed to save inventory item')", "toast.error(t('ui.failedToSaveInventoryItem'))"),
])

# ---- pages/sales/SalesRfqCreate.jsx ----
patch("pages/sales/SalesRfqCreate.jsx", [
    ("toast.error('RFQ title is required')", "toast.error(t('ui.rfqTitleIsRequired'))"),
    ("toast.error('Supplier information is required')", "toast.error(t('ui.supplierInformationIsRequired'))"),
    ("toast.error('Response deadline is required')", "toast.error(t('ui.responseDeadlineIsRequired'))"),
    ("toast.error('At least one valid item is required')", "toast.error(t('ui.atLeastOneValidItemIsRequired'))"),
    ("toast.success('RFQ sent for approval successfully!')", "toast.success(t('ui.rfqSentForApproval'))"),
    ("toast.success('RFQ created successfully!')", "toast.success(t('ui.rfqCreated'))"),
    ("toast.error('Failed to create RFQ')", "toast.error(t('ui.failedToCreateRfq'))"),
])

# ---- pages/sales/SalesOrderCreate.jsx ----
patch("pages/sales/SalesOrderCreate.jsx", [
    ("toast.error('Please select a customer')", "toast.error(t('ui.pleaseSelectACustomer'))"),
    ("toast.error('Please add at least one item')", "toast.error(t('ui.pleaseAddAtLeastOneItem'))"),
    ("toast.error('Please fill in all required item details')", "toast.error(t('ui.pleaseFillInAllRequiredItemDetails'))"),
    ("toast.success('Sales order created successfully!')", "toast.success(t('ui.salesOrderCreatedSuccessfully'))"),
    ("toast.error('Failed to create sales order')", "toast.error(t('ui.failedToCreateSalesOrder'))"),
])

# ---- pages/sales/DeliveryScheduling.jsx ----
patch("pages/sales/DeliveryScheduling.jsx", [
    ("toast.error('Please select an order')", "toast.error(t('ui.pleaseSelectAnOrder'))"),
    ("toast.error('Please select items to deliver')", "toast.error(t('ui.pleaseSelectItemsToDeliver'))"),
    ("toast.success('Delivery schedule created')", "toast.success(t('ui.deliveryScheduleCreatedSuccessfully'))"),
    ("toast.error('Failed to create delivery schedule')", "toast.error(t('ui.failedToCreateDeliverySchedule'))"),
    ("toast.error('Failed to load orders')", "toast.error(t('ui.failedToLoadOrders'))"),
    ("toast.error('Failed to load schedule')", "toast.error(t('ui.failedToLoadSchedule'))"),
])

# ---- pages/warehouse/transactions/GoodsReceipt.jsx ----
patch("pages/warehouse/transactions/GoodsReceipt.jsx", [
    ("toast.error('Please select an item and enter a quantity')", "toast.error(t('ui.pleaseSelectItemAndEnterQuantity'))"),
    ("toast.error('Please add at least one item')", "toast.error(t('ui.pleaseAddAtLeastOneItem'))"),
    ("toast.success('Goods receipt posted')", "toast.success(t('ui.goodsReceiptPosted'))"),
    ("toast.error('Failed to post goods receipt')", "toast.error(t('ui.failedToPostGoodsReceipt'))"),
    ("toast.error('Could not load locations or items')", "toast.error(t('ui.couldNotLoadLocationsOrItems'))"),
])

# ---- pages/warehouse/transactions/GoodsTransfer.jsx ----
patch("pages/warehouse/transactions/GoodsTransfer.jsx", [
    ("toast.error('Please select an item and enter a quantity')", "toast.error(t('ui.pleaseSelectItemAndEnterQuantity'))"),
    ("toast.error('Please add at least one item')", "toast.error(t('ui.pleaseAddAtLeastOneItem'))"),
    ("toast.success('Goods transfer posted')", "toast.success(t('ui.goodsTransferPosted'))"),
    ("toast.error('Failed to post goods transfer')", "toast.error(t('ui.failedToPostGoodsTransfer'))"),
    ("toast.error('Could not load locations or items')", "toast.error(t('ui.couldNotLoadLocationsOrItems'))"),
])

# ---- pages/inventory/InventoryItemCreate.jsx ----
patch("pages/inventory/InventoryItemCreate.jsx", [
    ("toast.error('Minimum stock level cannot be greater than maximum stock level')", "toast.error(t('ui.minStockCannotExceedMax'))"),
    ("toast.error('Reorder point should not be less than minimum stock level')", "toast.error(t('ui.reorderPointShouldNotBeLessThanMin'))"),
    ("toast.error('Reorder point should not be greater than maximum stock level')", "toast.error(t('ui.reorderPointShouldNotExceedMax'))"),
    ("toast.success('Inventory item created successfully')", "toast.success(t('ui.inventoryItemCreatedSuccessfully'))"),
    ("toast.error('Failed to create inventory item')", "toast.error(t('ui.failedToCreateInventoryItem'))"),
])

# ---- pages/finance/BankReconciliation.jsx ----
patch("pages/finance/BankReconciliation.jsx", [
    ("toast.success('Transaction matched')", "toast.success(t('ui.transactionMatched'))"),
    ("toast.error('Failed to match transaction')", "toast.error(t('ui.failedToMatchTransaction'))"),
    ("toast.success('Match cleared')", "toast.success(t('ui.matchCleared'))"),
    ("toast.error('Failed to clear match')", "toast.error(t('ui.failedToClearMatch'))"),
])

# ---- pages/finance/Budgets.jsx ----
patch("pages/finance/Budgets.jsx", [
    ("toast.success('Budget saved')", "toast.success(t('ui.budgetSaved'))"),
    ("toast.error('Failed to save budget')", "toast.error(t('ui.failedToSaveBudget'))"),
    ("toast.success('Budget deleted')", "toast.success(t('ui.budgetDeleted'))"),
    ("toast.error('Failed to delete budget')", "toast.error(t('ui.failedToDeleteBudget'))"),
])

# ---- pages/finance/Currencies.jsx ----
patch("pages/finance/Currencies.jsx", [
    ("toast.success('Rate updated')", "toast.success(t('ui.rateUpdated'))"),
    ("toast.error('Failed to update rate')", "toast.error(t('ui.failedToUpdateRate'))"),
    ("toast.success('Currency added')", "toast.success(t('ui.currencyAdded'))"),
    ("toast.error('Failed to add currency')", "toast.error(t('ui.failedToAddCurrency'))"),
])

# ---- pages/finance/InvoiceIntake.jsx ----
patch("pages/finance/InvoiceIntake.jsx", [
    ("toast.error('Supplier name and total amount are required')", "toast.error(t('ui.supplierNameAndAmountRequired'))"),
])

# ---- pages/reports/ReportSchedules.jsx ----
patch("pages/reports/ReportSchedules.jsx", [
    ("toast.success('Schedule created')", "toast.success(t('ui.scheduleCreated'))"),
    ("toast.error('Failed to create schedule')", "toast.error(t('ui.failedToCreateSchedule'))"),
    ("toast.success('Schedule deleted')", "toast.success(t('ui.scheduleDeleted'))"),
    ("toast.error('Failed to delete schedule')", "toast.error(t('ui.failedToDeleteSchedule'))"),
])

# ---- pages/projects/Timesheet.jsx ----
patch("pages/projects/Timesheet.jsx", [
    ("toast.success('Time logged')", "toast.success(t('ui.timeLogged'))"),
    ("toast.error('Failed to log time')", "toast.error(t('ui.failedToLogTime'))"),
    ("toast.success('Entry deleted')", "toast.success(t('ui.entryDeleted'))"),
    ("toast.error('Failed to delete entry')", "toast.error(t('ui.failedToDeleteEntry'))"),
])

# ---- pages/ai/AIChat.jsx ----
patch("pages/ai/AIChat.jsx", [
    ("toast.error('Failed to send message')", "toast.error(t('ui.failedToSendMessage'))"),
    ("toast.success('Conversation cleared')", "toast.success(t('ui.conversationCleared'))"),
    ("toast.error('Failed to load conversation')", "toast.error(t('ui.failedToLoadConversation'))"),
])

# ---- pages/ai/KnowledgeBase.jsx ----
patch("pages/ai/KnowledgeBase.jsx", [
    ("toast.success('Document uploaded')", "toast.success(t('ui.documentUploaded'))"),
    ("toast.error('Failed to upload document')", "toast.error(t('ui.failedToUploadDocument'))"),
    ("toast.success('Document deleted')", "toast.success(t('ui.documentDeleted'))"),
    ("toast.error('Failed to delete document')", "toast.error(t('ui.failedToDeleteDocument'))"),
])

print("\nDone.")
