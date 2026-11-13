/**
 * Static configuration options for the Delegation of Authority forms.
 * Kept out of the route so the route stays HTTP + persistence only.
 */

module.exports = {
  transaction_types: [
    // General
    { value: 'ALL', label: 'All Transactions', category: 'General' },

    // Procurement
    { value: 'SUPPLIERS', label: 'Supplier Management', category: 'Procurement' },
    { value: 'CERTIFICATION', label: 'Supplier Certification', category: 'Procurement' },
    { value: 'PURCHASE_REQUISITIONS', label: 'Purchase Requisitions', category: 'Procurement' },
    { value: 'PURCHASE_ORDERS', label: 'Purchase Orders', category: 'Procurement' },
    { value: 'CONTRACTS', label: 'Purchase Contracts', category: 'Procurement' },
    { value: 'RFQ', label: 'Request for Quotations', category: 'Procurement' },

    // Sales
    { value: 'SALES', label: 'All Sales Transactions', category: 'Sales' },
    { value: 'SALES_QUOTATION', label: 'Sales Quotations', category: 'Sales' },
    { value: 'SALES_CONTRACT', label: 'Sales Contracts', category: 'Sales' },
    { value: 'SALES_ORDER', label: 'Sales Orders', category: 'Sales' },
    { value: 'SALES_RFQ', label: 'Sales RFQ to Suppliers', category: 'Sales' },

    // Inventory
    { value: 'INVENTORY_ITEMS', label: 'Inventory Item Approvals', category: 'Inventory' },
    { value: 'STORAGE_LOCATIONS', label: 'Storage Location Management', category: 'Inventory' },
    { value: 'WAREHOUSE_TRANSACTIONS', label: 'Warehouse Transactions', category: 'Inventory' }
  ],

  currencies: [
    { value: 'USD', label: 'US Dollar (USD)' },
    { value: 'EUR', label: 'Euro (EUR)' },
    { value: 'GBP', label: 'British Pound (GBP)' },
    { value: 'SAR', label: 'Saudi Riyal (SAR)' },
    { value: 'AED', label: 'UAE Dirham (AED)' }
  ],

  cost_centers: [
    { value: 'SALES', label: 'Sales Department' },
    { value: 'PROCUREMENT', label: 'Procurement Department' },
    { value: 'OPERATIONS', label: 'Operations Department' },
    { value: 'FINANCE', label: 'Finance Department' },
    { value: 'IT', label: 'IT Department' },
    { value: 'HR', label: 'Human Resources' },
    { value: 'WAREHOUSE', label: 'Warehouse & Logistics' }
  ]
};
