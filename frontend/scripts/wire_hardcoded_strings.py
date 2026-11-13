#!/usr/bin/env python3
"""
Wire hardcoded English toast messages and validation errors in JSX files to t() calls.
This script performs targeted string replacements per file.
"""

import os
import re

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC_DIR = os.path.join(BASE_DIR, 'src')

def replace_in_file(filepath, replacements):
    """Apply a list of (old_string, new_string) replacements to a file."""
    full_path = os.path.join(SRC_DIR, filepath.replace('/', os.sep))
    if not os.path.exists(full_path):
        print(f"  SKIP (not found): {filepath}")
        return 0

    with open(full_path, 'r', encoding='utf-8') as f:
        content = f.read()

    original = content
    count = 0
    for old, new in replacements:
        if old in content:
            content = content.replace(old, new, 1)
            count += 1
        else:
            print(f"  MISS in {filepath}: {old[:60]!r}")

    if content != original:
        with open(full_path, 'w', encoding='utf-8') as f:
            f.write(content)
        print(f"  OK: {filepath} ({count} replacements)")
    return count


# ============================================================
# Per-file replacements
# ============================================================

WIRES = {

    # ---- Login.jsx ----
    "pages/Login.jsx": [
        (
            "toast.success(`Welcome back, ${result.user.first_name}!`)",
            "toast.success(t('ui.welcomeBackName', { name: result.user.first_name }))"
        ),
        (
            "const errorMessage = 'Login failed. Please try again.'",
            "const errorMessage = t('ui.loginFailed')"
        ),
        (
            "toast.success('Verification email sent.')",
            "toast.success(t('ui.verificationEmailSent'))"
        ),
        (
            "toast.error('Could not resend — try again shortly.')",
            "toast.error(t('ui.couldNotResendTryAgain'))"
        ),
    ],

    # ---- Signup.jsx ----
    "pages/Signup.jsx": [
        (
            "toast.success(`Welcome, ${result.user.first_name} — your company is ready.`)",
            "toast.success(t('ui.welcomeToQira', { name: result.user.first_name }))"
        ),
        (
            "toast.success(`Suggested: ${suggestion.name}`)",
            "toast.success(t('ui.suggestedBusinessType', { name: suggestion.name }))"
        ),
        (
            "toast('No suggestion — pick a business type below', { icon: 'ℹ️' })",
            "toast(t('ui.noSuggestionPickManually'), { icon: 'ℹ️' })"
        ),
        (
            "toast.success('Verification email sent.')",
            "toast.success(t('ui.verificationEmailSent'))"
        ),
        (
            "toast.error('Could not resend — try again shortly.')",
            "toast.error(t('ui.couldNotResendTryAgain'))"
        ),
    ],

    # ---- CustomerContractResponse.jsx ----
    "pages/CustomerContractResponse.jsx": [
        (
            "toast.success(`Contract ${selectedAction}ed successfully`);",
            "toast.success(selectedAction === 'accept' ? t('ui.contractAcceptedSuccessfully') : t('ui.contractDeclinedSuccessfully'));"
        ),
        (
            "toast.error(error.response?.data?.error || 'Failed to submit response');",
            "toast.error(error.response?.data?.error || t('ui.failedToSubmitResponse'));"
        ),
        (
            "'We will process your acceptance and prepare the final contract for signing shortly.'",
            "t('ui.weWillProcessYourAcceptance')"
        ),
        (
            "'We appreciate your consideration and hope to work with you in the future.'",
            "t('ui.weApprecciateYourConsideration')"
        ),
    ],

    # ---- pages/ItemEdit.jsx ----
    "pages/ItemEdit.jsx": [
        (
            "toast.error('Failed to fetch item master');",
            "toast.error(t('ui.failedToFetchItemMaster'));"
        ),
        (
            "toast.success('Item master saved as draft');",
            "toast.success(t('ui.itemMasterSavedAsDraft'));"
        ),
        (
            "toast.success('Item master sent for approval');",
            "toast.success(t('ui.itemMasterSentForApproval'));"
        ),
        (
            "toast.success('Item master updated successfully');",
            "toast.success(t('ui.itemMasterUpdatedSuccessfully'));"
        ),
        (
            "toast.error('Failed to update item master - Check console for details');",
            "toast.error(t('ui.failedToUpdateItemMaster'));"
        ),
    ],

    # ---- pages/ItemCreate.jsx ----
    "pages/ItemCreate.jsx": [
        (
            "toast.success('Item master saved as draft');",
            "toast.success(t('ui.itemMasterSavedAsDraft'));"
        ),
        (
            "toast.success('Item master sent for approval');",
            "toast.success(t('ui.itemMasterSentForApproval'));"
        ),
        (
            "toast.error('Failed to create item master - Check console for details');",
            "toast.error(t('ui.failedToCreateItemMaster'));"
        ),
    ],

    # ---- pages/finance/CustomerInvoices.jsx ----
    "pages/finance/CustomerInvoices.jsx": [
        (
            "toast.error('This invoice is missing data required for a Peppol e-invoice.');",
            "toast.error(t('ui.invoiceMissingPeppolData'));"
        ),
        (
            "toast.error('Failed to load completed sales orders');",
            "toast.error(t('ui.failedToLoadCompletedSalesOrders'));"
        ),
        (
            "toast.error('Select a sales order');",
            "toast.error(t('ui.selectASalesOrder'));"
        ),
        (
            "toast.success('Invoice generated');",
            "toast.success(t('ui.invoiceGenerated'));"
        ),
        (
            "toast.error('Enter a valid amount');",
            "toast.error(t('ui.enterAValidAmount'));"
        ),
        (
            "toast.error('Amount exceeds outstanding balance');",
            "toast.error(t('ui.amountExceedsOutstandingBalance'));"
        ),
        (
            "toast.success('Payment recorded');",
            "toast.success(t('ui.paymentRecorded'));"
        ),
    ],

    # ---- pages/finance/SupplierInvoices.jsx ----
    "pages/finance/SupplierInvoices.jsx": [
        (
            "toast.error('Failed to load purchase orders');",
            "toast.error(t('ui.failedToLoadPurchaseOrders'));"
        ),
        (
            "toast.error('Select a purchase order');",
            "toast.error(t('ui.selectAPurchaseOrder'));"
        ),
        (
            "toast.success('Bill recorded');",
            "toast.success(t('ui.billRecorded'));"
        ),
        (
            "toast.error('Enter a valid amount');",
            "toast.error(t('ui.enterAValidAmount'));"
        ),
        (
            "toast.error('Amount exceeds outstanding balance');",
            "toast.error(t('ui.amountExceedsOutstandingBalance'));"
        ),
    ],

    # ---- pages/sales/DeliverySchedulesList.jsx ----
    "pages/sales/DeliverySchedulesList.jsx": [
        (
            "toast.success('Delivery schedule created successfully');",
            "toast.success(t('ui.deliveryScheduleCreatedSuccessfully'));"
        ),
        (
            "toast.error('Failed to create delivery schedule');",
            "toast.error(t('ui.failedToCreateDeliverySchedule'));"
        ),
        (
            "toast.error('Failed to fetch schedule details');",
            "toast.error(t('ui.failedToFetchScheduleDetails'));"
        ),
        (
            "toast.success('Delivery executed successfully');",
            "toast.success(t('ui.deliveryExecutedSuccessfully'));"
        ),
        (
            "toast.success('Delivery schedule deleted successfully');",
            "toast.success(t('ui.deliveryScheduleDeletedSuccessfully'));"
        ),
        (
            "toast.error('Failed to fetch order items');",
            "toast.error(t('ui.failedToFetchOrderItems'));"
        ),
        (
            "toast.error('Failed to update customer handover status');",
            "toast.error(t('ui.failedToUpdateCustomerHandoverStatus'));"
        ),
        (
            "toast.error('Failed to update delivery status');",
            "toast.error(t('ui.failedToUpdateDeliveryStatus'));"
        ),
    ],

    # ---- pages/sales/SalesContractEdit.jsx ----
    "pages/sales/SalesContractEdit.jsx": [
        (
            "toast.error('Failed to fetch contract details');",
            "toast.error(t('ui.failedToFetchContractDetails'));"
        ),
        (
            "toast.error('Contract name is required');",
            "toast.error(t('ui.contractNameIsRequired'));"
        ),
        (
            "toast.error('Start date and end date are required');",
            "toast.error(t('ui.startDateAndEndDateAreRequired'));"
        ),
        (
            "toast.error('End date must be after start date');",
            "toast.error(t('ui.endDateMustBeAfterStartDate'));"
        ),
        (
            "toast.error('At least one valid item is required');",
            "toast.error(t('ui.atLeastOneValidItemIsRequired'));"
        ),
    ],

    # ---- pages/warehouse/InventoryTransfers.jsx ----
    "pages/warehouse/InventoryTransfers.jsx": [
        (
            "toast.error('Could not load locations or items');",
            "toast.error(t('ui.couldNotLoadLocationsOrItems'));"
        ),
        (
            "toast.error('Pick an item');",
            "toast.error(t('ui.pickAnItem'));"
        ),
        (
            "toast.error('The quantity must be more than zero');",
            "toast.error(t('ui.theQuantityMustBeMoreThanZero'));"
        ),
        (
            "toast.error('Pick a source location');",
            "toast.error(t('ui.pickASourceLocation'));"
        ),
        (
            "toast.error('Pick a destination location');",
            "toast.error(t('ui.pickADestinationLocation'));"
        ),
    ],

    # ---- pages/admin/UserManagement.jsx ----
    "pages/admin/UserManagement.jsx": [
        (
            "toast.error('User management is administrator-only');",
            "toast.error(t('ui.userManagementIsAdministratorOnly'));"
        ),
        (
            "toast.success('User deleted');",
            "toast.success(t('ui.userDeleted'));"
        ),
        (
            "toast.error('Enter an email address');",
            "toast.error(t('ui.enterAnEmailAddress'));"
        ),
    ],

    # ---- pages/manufacturing/WorkOrders.jsx ----
    "pages/manufacturing/WorkOrders.jsx": [
        (
            "toast.error('Could not load bills of material');",
            "toast.error(t('ui.couldNotLoadBillsOfMaterial'));"
        ),
        (
            "toast.error('Choose what to make');",
            "toast.error(t('ui.chooseWhatToMake'));"
        ),
        (
            "toast.error('Quantity must be greater than zero');",
            "toast.error(t('ui.quantityMustBeGreaterThanZero'));"
        ),
        (
            "toast.success('Work order created as a draft');",
            "toast.success(t('ui.workOrderCreatedAsADraft'));"
        ),
        (
            "toast.error('Produced quantity must be greater than zero');",
            "toast.error(t('ui.producedQuantityMustBeGreaterThanZero'));"
        ),
    ],

    # ---- pages/finance/RecurringInvoices.jsx ----
    "pages/finance/RecurringInvoices.jsx": [
        (
            "toast.error('Could not load customers');",
            "toast.error(t('ui.couldNotLoadCustomers'));"
        ),
        (
            "toast.error('Pick a customer');",
            "toast.error(t('ui.pickACustomer'));"
        ),
        (
            "toast.error('Describe what is being billed');",
            "toast.error(t('ui.describeWhatIsBeingBilled'));"
        ),
        (
            "toast.error('The amount must be more than zero');",
            "toast.error(t('ui.theAmountMustBeMoreThanZero'));"
        ),
        (
            "toast.success('Recurring schedule created');",
            "toast.success(t('ui.recurringScheduleCreated'));"
        ),
    ],

    # ---- pages/sales/SalesOrderEdit.jsx ----
    "pages/sales/SalesOrderEdit.jsx": [
        (
            "toast.error('Failed to fetch sales order');",
            "toast.error(t('ui.failedToFetchSalesOrder'));"
        ),
        (
            "toast.error('Please select a customer');",
            "toast.error(t('ui.pleaseSelectACustomer'));"
        ),
        (
            "toast.error('Please add at least one item');",
            "toast.error(t('ui.pleaseAddAtLeastOneItem'));"
        ),
        (
            "toast.error('Please fill in all required item details');",
            "toast.error(t('ui.pleaseFillInAllRequiredItemDetails'));"
        ),
        (
            "toast.success('Sales order updated successfully!');",
            "toast.success(t('ui.salesOrderUpdatedSuccessfully'));"
        ),
    ],

    # ---- pages/sales/SalesQuotationEdit.jsx ----
    "pages/sales/SalesQuotationEdit.jsx": [
        (
            "toast.error('Failed to fetch quotation');",
            "toast.error(t('ui.failedToFetchQuotation'));"
        ),
        (
            "toast.error('Cannot edit quotations that are accepted, rejected, or cancelled');",
            "toast.error(t('ui.cannotEditQuotationWithStatus'));"
        ),
        (
            "toast.error('Please select a customer');",
            "toast.error(t('ui.pleaseSelectACustomer'));"
        ),
        (
            "toast.error('Please add at least one item');",
            "toast.error(t('ui.pleaseAddAtLeastOneItem'));"
        ),
        (
            "toast.error('Please fill in all required item details');",
            "toast.error(t('ui.pleaseFillInAllRequiredItemDetails'));"
        ),
    ],

    # ---- pages/sales/SalesRfqEdit.jsx ----
    "pages/sales/SalesRfqEdit.jsx": [
        (
            "toast.error('Failed to fetch RFQ details');",
            "toast.error(t('ui.failedToFetchRfqDetails'));"
        ),
        (
            "toast.error('RFQ title is required');",
            "toast.error(t('ui.rfqTitleIsRequired'));"
        ),
        (
            "toast.error('Supplier information is required');",
            "toast.error(t('ui.supplierInformationIsRequired'));"
        ),
        (
            "toast.error('Response deadline is required');",
            "toast.error(t('ui.responseDeadlineIsRequired'));"
        ),
        (
            "toast.error('At least one valid item is required');",
            "toast.error(t('ui.atLeastOneValidItemIsRequired'));"
        ),
    ],

    # ---- components/DOACreateForm.jsx ----
    "components/DOACreateForm.jsx": [
        (
            "toast.error('Failed to load configuration');",
            "toast.error(t('ui.failedToLoadConfiguration'));"
        ),
        (
            "toast.error('Failed to load users');",
            "toast.error(t('ui.failedToLoadUsers'));"
        ),
        (
            "toast.error('Please fill in all required fields');",
            "toast.error(t('ui.pleaseFillInAllRequiredFields'));"
        ),
        (
            "toast.error('Minimum amount cannot be greater than maximum amount');",
            "toast.error(t('ui.minimumAmountCannotBeGreaterThanMaximum'));"
        ),
        (
            "toast.error('End date must be after start date');",
            "toast.error(t('ui.endDateMustBeAfterStartDate'));"
        ),
    ],

    # ---- components/NotificationBell.jsx ----
    "components/NotificationBell.jsx": [
        (
            "toast.error('Failed to fetch notifications');",
            "toast.error(t('ui.failedToFetchNotifications'));"
        ),
        (
            "toast.error('Failed to mark notification as read');",
            "toast.error(t('ui.failedToMarkNotificationAsRead'));"
        ),
        (
            "toast.success('All notifications marked as read');",
            "toast.success(t('ui.allNotificationsMarkedAsRead'));"
        ),
        (
            "toast.error('Failed to mark all notifications as read');",
            "toast.error(t('ui.failedToMarkAllNotificationsAsRead'));"
        ),
        (
            "toast.success('Notification deleted');",
            "toast.success(t('ui.notificationDeleted'));"
        ),
        (
            "toast.error('Failed to delete notification');",
            "toast.error(t('ui.failedToDeleteNotification'));"
        ),
    ],

    # ---- pages/reports/Dashboards.jsx ----
    "pages/reports/Dashboards.jsx": [
        (
            "toast.success('Dashboard created');",
            "toast.success(t('ui.dashboardCreated'));"
        ),
        (
            "toast.error('Give the dashboard a name');",
            "toast.error(t('ui.giveTheDashboardAName'));"
        ),
        (
            "toast.success('Widget removed');",
            "toast.success(t('ui.widgetRemoved'));"
        ),
        (
            "toast.success('Dashboard deleted');",
            "toast.success(t('ui.dashboardDeleted'));"
        ),
        (
            "toast.error('Could not load reports');",
            "toast.error(t('ui.couldNotLoadReports'));"
        ),
    ],

    # ---- pages/reports/Reports.jsx ----
    "pages/reports/Reports.jsx": [
        (
            "toast.success('Report deleted');",
            "toast.success(t('ui.reportDeleted'));"
        ),
        (
            "toast.error('Could not load the report catalogue');",
            "toast.error(t('ui.couldNotLoadReportCatalogue'));"
        ),
        (
            "toast.error('Give the report a name');",
            "toast.error(t('ui.giveTheReportAName'));"
        ),
        (
            "toast.error('Pick a packaged report');",
            "toast.error(t('ui.pickAPackagedReport'));"
        ),
        (
            "toast.error('A query report needs SQL');",
            "toast.error(t('ui.aQueryReportNeedsSQL'));"
        ),
    ],

    # ---- components/DOASalesRfqApproval.jsx ----
    "components/DOASalesRfqApproval.jsx": [
        (
            "toast.error('Please provide approval notes');",
            "toast.error(t('ui.pleaseProvideApprovalNotes'));"
        ),
        (
            "toast.success('Sales RFQ approved by procurement team');",
            "toast.success(t('ui.salesRfqApprovedByProcurement'));"
        ),
        (
            "toast.error('Failed to approve Sales RFQ');",
            "toast.error(t('ui.failedToApproveSalesRfq'));"
        ),
        (
            "toast.error('Please provide rejection reason');",
            "toast.error(t('ui.pleaseProvideRejectionReason'));"
        ),
        (
            "toast.success('Sales RFQ rejected by procurement team');",
            "toast.success(t('ui.salesRfqRejectedByProcurement'));"
        ),
        (
            "toast.error('Failed to reject Sales RFQ');",
            "toast.error(t('ui.failedToRejectSalesRfq'));"
        ),
    ],

    # ---- pages/ai/PdfTemplates.jsx ----
    "pages/ai/PdfTemplates.jsx": [
        (
            "toast.error('Could not render a preview of that template');",
            "toast.error(t('ui.couldNotRenderPreviewOfTemplate'));"
        ),
        (
            "toast.error('Fix the body sections first');",
            "toast.error(t('ui.fixTheBodySectionsFirst'));"
        ),
        (
            "toast.success('Template saved');",
            "toast.success(t('ui.templateSaved'));"
        ),
        (
            "toast.success('Template created');",
            "toast.success(t('ui.templateCreated'));"
        ),
        (
            "toast.success('Deleted');",
            "toast.success(t('ui.deleted'));"
        ),
    ],

    # ---- pages/sales/CustomerCreate.jsx ----
    "pages/sales/CustomerCreate.jsx": [
        (
            "toast.error('Customer name is required');",
            "toast.error(t('ui.customerNameIsRequired'));"
        ),
        (
            "toast.error('Please enter a valid primary email address');",
            "toast.error(t('ui.pleaseEnterAValidPrimaryEmail'));"
        ),
        (
            "toast.error('Please enter a valid secondary email address');",
            "toast.error(t('ui.pleaseEnterAValidSecondaryEmail'));"
        ),
    ],

    # ---- pages/sales/CustomerEdit.jsx ----
    "pages/sales/CustomerEdit.jsx": [
        (
            "toast.error('Customer name is required');",
            "toast.error(t('ui.customerNameIsRequired'));"
        ),
        (
            "toast.error('Please enter a valid primary email address');",
            "toast.error(t('ui.pleaseEnterAValidPrimaryEmail'));"
        ),
        (
            "toast.error('Please enter a valid secondary email address');",
            "toast.error(t('ui.pleaseEnterAValidSecondaryEmail'));"
        ),
    ],
}


def ensure_t_import(filepath):
    """Ensure useI18n is imported and t is destructured in the component."""
    full_path = os.path.join(SRC_DIR, filepath.replace('/', os.sep))
    if not os.path.exists(full_path):
        return

    with open(full_path, 'r', encoding='utf-8') as f:
        content = f.read()

    modified = False

    # Check if useI18n is already imported
    if 'useI18n' not in content:
        # Add import after the first import line
        first_import_end = content.find('\n', content.find('import ')) + 1
        content = content[:first_import_end] + "import { useI18n } from '../../contexts/I18nContext'\n" + content[first_import_end:]
        modified = True

    # Check if t is already destructured
    if "const { t }" not in content and "const {t}" not in content and "{ t," not in content and ", t }" not in content:
        # Find the component function body opening and add const { t } = useI18n()
        # Look for a pattern like const ComponentName = () => { or function ComponentName() {
        match = re.search(r'(const \w+ = [^{]*\{|function \w+[^{]*\{)', content)
        if match:
            insert_pos = match.end()
            content = content[:insert_pos] + "\n  const { t } = useI18n()" + content[insert_pos:]
            modified = True

    if modified:
        with open(full_path, 'w', encoding='utf-8') as f:
            f.write(content)
        print(f"  Added useI18n import+hook to {filepath}")


def main():
    total = 0
    for filepath, replacements in WIRES.items():
        count = replace_in_file(filepath, replacements)
        total += count

    print(f"\nTotal replacements made: {total}")


if __name__ == '__main__':
    main()
