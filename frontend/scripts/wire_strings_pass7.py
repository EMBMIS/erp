#!/usr/bin/env python3
"""Seventh-pass: fix remaining files."""
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
    for lang_file in ['en'] + LOCALES:
        fpath = os.path.join(LOCALES_DIR, f'{lang_file}.json')
        if not os.path.exists(fpath): continue
        with open(fpath, 'r', encoding='utf-8') as f:
            data = json.load(f)
        if 'ui' not in data: data['ui'] = {}
        added = sum(1 for k, v in new_keys.items() if k not in data['ui'] and not data['ui'].update({k: v}))
        if added:
            with open(fpath, 'w', encoding='utf-8') as f:
                json.dump(data, f, ensure_ascii=False, indent=2); f.write('\n')
    print(f"  Added {len(new_keys)} keys to all locales")

add_keys({
    "failedToProcessPurchaseOrder": "Failed to process purchase order",
    "pleaseFillInRequiredFields": "Please fill in required fields",
    "pleaseFillInQuantityAndStorageLocation": "Please fill in quantity and storage location for all items",
    "pleaseFillInAllRequiredFields": "Please fill in all required fields",
    "transferQuantityCannotExceedAvailable": "Transfer quantity cannot exceed available quantity",
    "sourceAndDestinationCannotBeSame": "Source and destination cannot be the same",
    "pleaseAddAtLeastOneItemToTransfer": "Please add at least one item to transfer",
    "pleaseFillInAllRequiredFieldsForAllItems": "Please fill in all required fields for all items",
    "failedToFetchAvailableItemMasters": "Failed to fetch available item masters",
    "pleaseSelectAnItemMaster": "Please select an item master",
    "currentVolumeUsedCannotExceedMaximum": "Current volume used cannot exceed maximum volume capacity",
    "failedToLoadApiKeys": "Failed to load API keys",
    "couldNotRevokeThisKey": "Could not revoke this key",
    "couldNotCreateThisKey": "Could not create this key",
    "couldNotCopySelectManually": "Could not copy — select the value and copy it manually",
    "webhooksAreAdministratorOnly": "Webhooks are administrator-only",
    "failedToLoadWebhooks": "Failed to load webhooks",
    "subscriptionEnabled": "Subscription enabled",
    "subscriptionDisabled": "Subscription disabled",
    "couldNotUpdateThisSubscription": "Could not update this subscription",
    "subscriptionDeleted": "Subscription deleted",
    "couldNotDeleteThisSubscription": "Could not delete this subscription",
    "giveTheEndpointUrl": "Give the endpoint URL",
    "urlMustStartWithHttp": "The URL must start with http:// or https://",
    "pickAtLeastOneEvent": "Pick at least one event",
    "couldNotCreateThisSubscription": "Could not create this subscription",
    "contractCreatedSuccessfully": "Contract created successfully",
    "contractSavedAsDraft": "Contract saved as draft",
    "couldNotSendForApprovalTryFromView": "Could not send for approval. Please try from the contract view.",
    "failedToCreateSalesContract": "Failed to create sales contract",
    "failedToFetchOrderItems": "Failed to fetch order items",
    "failedToCreateDeliverySchedule": "Failed to create delivery schedule",
    "failedToFetchScheduleDetails": "Failed to fetch schedule details",
    "deliveryExecutedSuccessfully": "Delivery executed successfully",
    "failedToExecuteDelivery": "Failed to execute delivery",
    "purchaseOrderApprovedSuccessfully": "Purchase order approved successfully",
    "failedToApprovePurchaseOrder": "Failed to approve purchase order",
    "schedulePaused": "Schedule paused",
    "scheduleResumed": "Schedule resumed",
    "couldNotChangeThisSchedule": "Could not change this schedule",
    "couldNotDeleteThisSchedule": "Could not delete this schedule",
    "pickAReport": "Pick a report",
    "couldNotCreateThisSchedule": "Could not create this schedule",
    "currencyAdded": "Currency added",
    "removed": "Removed",
    "failedToUpdate": "Failed to update",
    "rateSaved": "Rate saved",
})

# GoodsReceipt
patch("pages/warehouse/transactions/GoodsReceipt.jsx", [
    ("toast.error('Failed to process purchase order')", "toast.error(t('ui.failedToProcessPurchaseOrder'))"),
    ("toast.error('Please fill in required fields')", "toast.error(t('ui.pleaseFillInRequiredFields'))"),
    ("toast.error('Please fill in quantity and storage location for all items')", "toast.error(t('ui.pleaseFillInQuantityAndStorageLocation'))"),
])

# GoodsTransfer
patch("pages/warehouse/transactions/GoodsTransfer.jsx", [
    ("toast.error('Please fill in all required fields')", "toast.error(t('ui.pleaseFillInAllRequiredFields'))"),
    ("toast.error('Transfer quantity cannot exceed available quantity')", "toast.error(t('ui.transferQuantityCannotExceedAvailable'))"),
    ("toast.error('Source and destination cannot be the same')", "toast.error(t('ui.sourceAndDestinationCannotBeSame'))"),
    ("toast.error('Please add at least one item to transfer')", "toast.error(t('ui.pleaseAddAtLeastOneItemToTransfer'))"),
    ("toast.error('Please fill in all required fields for all items')", "toast.error(t('ui.pleaseFillInAllRequiredFieldsForAllItems'))"),
])

# InventoryItemCreate
patch("pages/inventory/InventoryItemCreate.jsx", [
    ("toast.error('Failed to fetch available item masters')", "toast.error(t('ui.failedToFetchAvailableItemMasters'))"),
    ("toast.error('Please select an item master')", "toast.error(t('ui.pleaseSelectAnItemMaster'))"),
    ("error.response?.data?.error || 'Failed to create inventory item'", "error.response?.data?.error || t('ui.failedToCreateInventoryItem')"),
])

# BinCreate
patch("pages/warehouse/BinCreate.jsx", [
    ("toast.error('Current volume used cannot exceed maximum volume capacity')", "toast.error(t('ui.currentVolumeUsedCannotExceedMaximum'))"),
    ("toast.error('Bin name is required')", "toast.error(t('ui.binNameIsRequired'))"),
    ("toast.error('Storage location is required')", "toast.error(t('ui.storageLocationIsRequired'))"),
])

# Integrations
patch("pages/admin/Integrations.jsx", [
    ("err.response?.data?.error || 'Failed to load API keys'", "err.response?.data?.error || t('ui.failedToLoadApiKeys')"),
    ("err.response?.data?.error || 'Could not revoke this key'", "err.response?.data?.error || t('ui.couldNotRevokeThisKey')"),
    ("err.response?.data?.error || 'Could not create this key'", "err.response?.data?.error || t('ui.couldNotCreateThisKey')"),
    ("toast.error('Could not copy", "toast.error(t('ui.couldNotCopySelectManually') /* Could not copy"),
    ("toast.error('Webhooks are administrator-only')", "toast.error(t('ui.webhooksAreAdministratorOnly'))"),
    ("err.response?.data?.error || 'Failed to load webhooks'", "err.response?.data?.error || t('ui.failedToLoadWebhooks')"),
    ("next === 'ACTIVE' ? 'Subscription enabled' : 'Subscription disabled'", "next === 'ACTIVE' ? t('ui.subscriptionEnabled') : t('ui.subscriptionDisabled')"),
    ("err.response?.data?.error || 'Could not update this subscription'", "err.response?.data?.error || t('ui.couldNotUpdateThisSubscription')"),
    ("toast.success('Subscription deleted')", "toast.success(t('ui.subscriptionDeleted'))"),
    ("err.response?.data?.error || 'Could not delete this subscription'", "err.response?.data?.error || t('ui.couldNotDeleteThisSubscription')"),
    ("return toast.error('Give the endpoint URL')", "return toast.error(t('ui.giveTheEndpointUrl'))"),
    ("return toast.error('The URL must start with http:// or https://')", "return toast.error(t('ui.urlMustStartWithHttp'))"),
    ("return toast.error('Pick at least one event')", "return toast.error(t('ui.pickAtLeastOneEvent'))"),
    ("err.response?.data?.error || 'Could not create this subscription'", "err.response?.data?.error || t('ui.couldNotCreateThisSubscription')"),
    ("toast.success('API key created')", "toast.success(t('ui.apiKeyCreated'))"),
    ("err.response?.data?.error || 'Failed to create API key'", "err.response?.data?.error || t('ui.failedToCreateApiKey')"),
])

# SalesContractCreate
patch("pages/sales/SalesContractCreate.jsx", [
    ("toast.warning('Could not send for approval automatically. Please do it from the contract view.')", "toast(t('ui.couldNotSendForApprovalTryFromView'), { icon: 'ℹ️' })"),
    ("toast.success('Contract created successfully!')", "toast.success(t('ui.contractCreatedSuccessfully'))"),
    ("toast.warning('Could not send for approval. Please try from the contract view.')", "toast(t('ui.couldNotSendForApprovalTryFromView'), { icon: 'ℹ️' })"),
    ("toast.success('Contract saved as draft successfully!')", "toast.success(t('ui.contractSavedAsDraft'))"),
    ("error.response?.data?.error || 'Failed to create sales contract'", "error.response?.data?.error || t('ui.failedToCreateSalesContract')"),
])

# DeliveryScheduling
patch("pages/sales/DeliveryScheduling.jsx", [
    ("toast.error('Failed to fetch order items')", "toast.error(t('ui.failedToFetchOrderItems'))"),
    ("error.error || 'Failed to create delivery schedule'", "error.error || t('ui.failedToCreateDeliverySchedule')"),
    ("toast.error('Failed to fetch schedule details')", "toast.error(t('ui.failedToFetchScheduleDetails'))"),
    ("toast.success('Delivery executed successfully')", "toast.success(t('ui.deliveryExecutedSuccessfully'))"),
    ("error.error || 'Failed to execute delivery'", "error.error || t('ui.failedToExecuteDelivery')"),
    ("toast.error('Failed to execute delivery')", "toast.error(t('ui.failedToExecuteDelivery'))"),
    ("toast.success('Purchase Order approved successfully')", "toast.success(t('ui.purchaseOrderApprovedSuccessfully'))"),
    ("error.error || 'Failed to approve Purchase Order'", "error.error || t('ui.failedToApprovePurchaseOrder')"),
    ("toast.error('Failed to approve Purchase Order')", "toast.error(t('ui.failedToApprovePurchaseOrder'))"),
])

# ReportSchedules
patch("pages/reports/ReportSchedules.jsx", [
    ("s.enabled ? 'Schedule paused' : 'Schedule resumed'", "s.enabled ? t('ui.schedulePaused') : t('ui.scheduleResumed')"),
    ("err.response?.data?.error || 'Could not change this schedule'", "err.response?.data?.error || t('ui.couldNotChangeThisSchedule')"),
    ("err.response?.data?.error || 'Could not delete this schedule'", "err.response?.data?.error || t('ui.couldNotDeleteThisSchedule')"),
    ("toast.error('Could not load reports')", "toast.error(t('ui.couldNotLoadReports'))"),
    ("return toast.error('Pick a report')", "return toast.error(t('ui.pickAReport'))"),
    ("err.response?.data?.error || 'Could not create this schedule'", "err.response?.data?.error || t('ui.couldNotCreateThisSchedule')"),
])

# Currencies - fix the missed one
patch("pages/finance/Currencies.jsx", [
    ("toast.success('Currency added')", "toast.success(t('ui.currencyAdded'))"),
])

print("\nDone.")
