#!/usr/bin/env python3
"""
Second-pass wire script for files where exact quote chars differed.
Reads actual strings from files and replaces with t() calls.
"""

import os
import re

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC_DIR = os.path.join(BASE_DIR, 'src')


def patch(filepath, pairs):
    """pairs = [(old_literal, new_expr), ...]"""
    full = os.path.join(SRC_DIR, filepath.replace('/', os.sep))
    if not os.path.exists(full):
        print(f"  SKIP (not found): {filepath}")
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


# ---- pages/ItemCreate.jsx ----
patch("pages/ItemCreate.jsx", [
    ("toast.success('Item master saved as draft')", "toast.success(t('ui.itemMasterSavedAsDraft'))"),
    ("toast.success('Item master sent for approval')", "toast.success(t('ui.itemMasterSentForApproval'))"),
    ("toast.error('Failed to create item master - Check console for details')", "toast.error(t('ui.failedToCreateItemMaster'))"),
])

# ---- pages/finance/CustomerInvoices.jsx ----
patch("pages/finance/CustomerInvoices.jsx", [
    ("toast.error('This invoice is missing data required for a Peppol e-invoice.')", "toast.error(t('ui.invoiceMissingPeppolData'))"),
    ("toast.error('Failed to load completed sales orders')", "toast.error(t('ui.failedToLoadCompletedSalesOrders'))"),
    ("toast.error('Select a sales order')", "toast.error(t('ui.selectASalesOrder'))"),
    ("toast.success('Invoice generated')", "toast.success(t('ui.invoiceGenerated'))"),
    ("toast.error('Enter a valid amount')", "toast.error(t('ui.enterAValidAmount'))"),
    ("toast.error('Amount exceeds outstanding balance')", "toast.error(t('ui.amountExceedsOutstandingBalance'))"),
    ("toast.success('Payment recorded')", "toast.success(t('ui.paymentRecorded'))"),
])

# ---- pages/finance/SupplierInvoices.jsx ----
patch("pages/finance/SupplierInvoices.jsx", [
    ("toast.error('Failed to load purchase orders')", "toast.error(t('ui.failedToLoadPurchaseOrders'))"),
    ("toast.error('Select a purchase order')", "toast.error(t('ui.selectAPurchaseOrder'))"),
    ("toast.success('Bill recorded')", "toast.success(t('ui.billRecorded'))"),
    ("toast.error('Enter a valid amount')", "toast.error(t('ui.enterAValidAmount'))"),
    ("toast.error('Amount exceeds outstanding balance')", "toast.error(t('ui.amountExceedsOutstandingBalance'))"),
    ("toast.success('Payment recorded')", "toast.success(t('ui.paymentRecorded'))"),
])

# ---- pages/sales/DeliverySchedulesList.jsx ----
patch("pages/sales/DeliverySchedulesList.jsx", [
    ("toast.error('Failed to fetch schedule details')", "toast.error(t('ui.failedToFetchScheduleDetails'))"),
    ("toast.success('Delivery executed successfully')", "toast.success(t('ui.deliveryExecutedSuccessfully'))"),
])

# ---- pages/warehouse/InventoryTransfers.jsx ----
patch("pages/warehouse/InventoryTransfers.jsx", [
    ("toast.error('Could not load locations or items')", "toast.error(t('ui.couldNotLoadLocationsOrItems'))"),
    ("toast.error('Pick an item')", "toast.error(t('ui.pickAnItem'))"),
    ("toast.error('The quantity must be more than zero')", "toast.error(t('ui.theQuantityMustBeMoreThanZero'))"),
    ("toast.error('Pick a source location')", "toast.error(t('ui.pickASourceLocation'))"),
    ("toast.error('Pick a destination location')", "toast.error(t('ui.pickADestinationLocation'))"),
])

# ---- pages/admin/UserManagement.jsx ----
patch("pages/admin/UserManagement.jsx", [
    ("toast.error('User management is administrator-only')", "toast.error(t('ui.userManagementIsAdministratorOnly'))"),
    ("toast.success('User deleted')", "toast.success(t('ui.userDeleted'))"),
    ("toast.error('Enter an email address')", "toast.error(t('ui.enterAnEmailAddress'))"),
])

# ---- pages/manufacturing/WorkOrders.jsx ----
patch("pages/manufacturing/WorkOrders.jsx", [
    ("toast.error('Could not load bills of material')", "toast.error(t('ui.couldNotLoadBillsOfMaterial'))"),
    ("toast.error('Choose what to make')", "toast.error(t('ui.chooseWhatToMake'))"),
    ("toast.error('Quantity must be greater than zero')", "toast.error(t('ui.quantityMustBeGreaterThanZero'))"),
    ("toast.success('Work order created as a draft')", "toast.success(t('ui.workOrderCreatedAsADraft'))"),
    ("toast.error('Produced quantity must be greater than zero')", "toast.error(t('ui.producedQuantityMustBeGreaterThanZero'))"),
])

# ---- pages/finance/RecurringInvoices.jsx ----
patch("pages/finance/RecurringInvoices.jsx", [
    ("toast.error('Could not load customers')", "toast.error(t('ui.couldNotLoadCustomers'))"),
    ("toast.error('Pick a customer')", "toast.error(t('ui.pickACustomer'))"),
    ("toast.error('Describe what is being billed')", "toast.error(t('ui.describeWhatIsBeingBilled'))"),
    ("toast.error('The amount must be more than zero')", "toast.error(t('ui.theAmountMustBeMoreThanZero'))"),
    ("toast.success('Recurring schedule created')", "toast.success(t('ui.recurringScheduleCreated'))"),
])

# ---- components/NotificationBell.jsx ----
patch("components/NotificationBell.jsx", [
    ("toast.error('Failed to fetch notifications')", "toast.error(t('ui.failedToFetchNotifications'))"),
    ("toast.error('Failed to mark notification as read')", "toast.error(t('ui.failedToMarkNotificationAsRead'))"),
    ("toast.success('All notifications marked as read')", "toast.success(t('ui.allNotificationsMarkedAsRead'))"),
    ("toast.error('Failed to mark all notifications as read')", "toast.error(t('ui.failedToMarkAllNotificationsAsRead'))"),
    ("toast.success('Notification deleted')", "toast.success(t('ui.notificationDeleted'))"),
    ("toast.error('Failed to delete notification')", "toast.error(t('ui.failedToDeleteNotification'))"),
])

# ---- pages/reports/Dashboards.jsx ----
patch("pages/reports/Dashboards.jsx", [
    ("toast.success('Dashboard created')", "toast.success(t('ui.dashboardCreated'))"),
    ("toast.error('Give the dashboard a name')", "toast.error(t('ui.giveTheDashboardAName'))"),
    ("toast.success('Widget removed')", "toast.success(t('ui.widgetRemoved'))"),
    ("toast.success('Dashboard deleted')", "toast.success(t('ui.dashboardDeleted'))"),
    ("toast.error('Could not load reports')", "toast.error(t('ui.couldNotLoadReports'))"),
])

# ---- pages/reports/Reports.jsx ----
patch("pages/reports/Reports.jsx", [
    ("toast.success('Report deleted')", "toast.success(t('ui.reportDeleted'))"),
    ("toast.error('Could not load the report catalogue')", "toast.error(t('ui.couldNotLoadReportCatalogue'))"),
    ("toast.error('Give the report a name')", "toast.error(t('ui.giveTheReportAName'))"),
    ("toast.error('Pick a packaged report')", "toast.error(t('ui.pickAPackagedReport'))"),
    ("toast.error('A query report needs SQL')", "toast.error(t('ui.aQueryReportNeedsSQL'))"),
])

# ---- pages/ai/PdfTemplates.jsx ----
patch("pages/ai/PdfTemplates.jsx", [
    ("toast.error('Could not render a preview of that template')", "toast.error(t('ui.couldNotRenderPreviewOfTemplate'))"),
    ("toast.error('Fix the body sections first')", "toast.error(t('ui.fixTheBodySectionsFirst'))"),
    ("toast.success('Template saved')", "toast.success(t('ui.templateSaved'))"),
    ("toast.success('Template created')", "toast.success(t('ui.templateCreated'))"),
    ("toast.success('Deleted')", "toast.success(t('ui.deleted'))"),
])

print("\nDone.")
