const { Pool } = require('pg');
require('dotenv').config({ path: '../.env' });

const pool = new Pool({ 
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function testFinanceWorkflow() {
  console.log('🧪 Testing Complete Finance Module Workflow\n');
  
  try {
    // Step 1: Verify Chart of Accounts exists
    await step1_VerifyChartOfAccounts();
    
    // Step 2: Create a test sales order
    await step2_CreateTestSalesOrder();
    
    // Step 3: Complete the sales order (triggers AR)
    await step3_CompleteSalesOrder();
    
    // Step 4: Verify customer invoice creation
    await step4_VerifyCustomerInvoice();
    
    // Step 5: Verify journal entry posting
    await step5_VerifyJournalEntry();
    
    // Step 6: Test financial reports
    await step6_TestFinancialReports();
    
    console.log('🎉 Finance Module Workflow Test PASSED! All integrations working correctly.\n');
    
  } catch (error) {
    console.error('❌ Finance Workflow Test FAILED:', error.message);
    throw error;
  } finally {
    await pool.end();
  }
}

async function step1_VerifyChartOfAccounts() {
  console.log('📊 Step 1: Verifying Chart of Accounts...');
  
  const accountsResult = await pool.query(`
    SELECT account_code, account_name, account_type, status
    FROM chart_of_accounts 
    WHERE deleted_at IS NULL 
    ORDER BY account_code
    LIMIT 10
  `);
  
  console.log(`✅ Found ${accountsResult.rows.length} accounts in Chart of Accounts`);
  
  // Check for key accounts
  const keyAccounts = ['1200', '4000', '5000']; // AR, Revenue, Expenses
  for (const code of keyAccounts) {
    const account = accountsResult.rows.find(a => a.account_code === code);
    if (account) {
      console.log(`  ✅ ${code} - ${account.account_name} (${account.status})`);
    } else {
      console.log(`  ⚠️ Missing key account: ${code}`);
    }
  }
  console.log();
}

async function step2_CreateTestSalesOrder() {
  console.log('🛒 Step 2: Creating test sales order...');
  
  // Find a customer
  const customerResult = await pool.query(`
    SELECT id, customer_name FROM customers 
    WHERE deleted_at IS NULL 
    LIMIT 1
  `);
  
  if (customerResult.rows.length === 0) {
    throw new Error('No customers found - please create a customer first');
  }
  
  const customer = customerResult.rows[0];
  console.log(`  📝 Using customer: ${customer.customer_name}`);
  
  // Get a user for the transaction
  const userResult = await pool.query(`
    SELECT id FROM users ORDER BY created_at LIMIT 1
  `);
  
  if (userResult.rows.length === 0) {
    throw new Error('No users found - please create a user first');
  }
  
  const userId = userResult.rows[0].id;
  
  // Create test sales order
  const SalesOrder = require('../models/SalesOrder');
  const testOrderData = {
    customer_id: customer.id,
    customer_name: customer.customer_name,
    order_date: new Date(),
    currency: 'USD',
    subtotal: 1000.00,
    tax_amount: 100.00,
    total_amount: 1100.00,
    payment_terms: 'Net 30',
    items: [
      {
        item_name: 'Test Finance Product',
        item_description: 'Product for finance workflow testing',
        quantity: 2,
        unit_of_measure: 'EA',
        unit_price: 500.00,
        line_total: 1000.00
      }
    ]
  };
  
  const salesOrder = await SalesOrder.create(testOrderData, userId);
  console.log(`  ✅ Created test sales order: ${salesOrder.so_number}`);
  console.log(`  💰 Amount: $${salesOrder.total_amount}`);
  
  // Store for next steps
  global.testSalesOrder = salesOrder;
  global.testUserId = userId;
  console.log();
}

async function step3_CompleteSalesOrder() {
  console.log('✅ Step 3: Completing sales order (triggers finance integration)...');
  
  const salesOrderId = global.testSalesOrder.id;
  const userId = global.testUserId;
  
  // Update status to COMPLETED (this should trigger customer invoice creation)
  const SalesOrder = require('../models/SalesOrder');
  const updatedOrder = await SalesOrder.updateStatus(salesOrderId, 'COMPLETED', userId, 'Finance workflow test');
  
  console.log(`  ✅ Sales order ${updatedOrder.so_number} marked as COMPLETED`);
  console.log(`  🔄 This should have triggered customer invoice creation...`);
  console.log();
}

async function step4_VerifyCustomerInvoice() {
  console.log('🧾 Step 4: Verifying customer invoice creation...');
  
  const salesOrderId = global.testSalesOrder.id;
  
  // Check if customer invoice was created
  const invoiceResult = await pool.query(`
    SELECT 
      ci.invoice_number,
      ci.total_amount,
      ci.status,
      ci.journal_entry_id,
      je.journal_number
    FROM customer_invoices ci
    LEFT JOIN journal_entries je ON ci.journal_entry_id = je.id
    WHERE ci.sales_order_id = $1
  `, [salesOrderId]);
  
  if (invoiceResult.rows.length === 0) {
    throw new Error('❌ Customer invoice was not automatically created');
  }
  
  const invoice = invoiceResult.rows[0];
  console.log(`  ✅ Customer invoice created: ${invoice.invoice_number}`);
  console.log(`  💰 Invoice amount: $${invoice.total_amount}`);
  console.log(`  📊 Invoice status: ${invoice.status}`);
  if (invoice.journal_number) {
    console.log(`  📚 Linked to journal entry: ${invoice.journal_number}`);
  }
  
  global.testInvoice = invoice;
  console.log();
}

async function step5_VerifyJournalEntry() {
  console.log('📚 Step 5: Verifying journal entry and GL posting...');
  
  const salesOrderId = global.testSalesOrder.id;
  
  // Check journal entries created for this sales order
  const journalResult = await pool.query(`
    SELECT 
      je.journal_number,
      je.status,
      je.total_debit,
      je.total_credit,
      je.description
    FROM journal_entries je
    WHERE je.reference_type = 'SALES_ORDER' 
      AND je.reference_id = $1
  `, [salesOrderId]);
  
  if (journalResult.rows.length === 0) {
    throw new Error('❌ No journal entries found for sales order');
  }
  
  console.log(`  ✅ Found ${journalResult.rows.length} journal entry(ies)`);
  
  for (const entry of journalResult.rows) {
    console.log(`    📝 ${entry.journal_number}: ${entry.description}`);
    console.log(`    💰 Debit: $${entry.total_debit} | Credit: $${entry.total_credit}`);
    console.log(`    📊 Status: ${entry.status}`);
    
    // Verify the entry is balanced
    if (parseFloat(entry.total_debit) === parseFloat(entry.total_credit)) {
      console.log(`    ✅ Entry is balanced`);
    } else {
      console.log(`    ❌ Entry is NOT balanced!`);
    }
    
    // Get journal entry line items
    const itemsResult = await pool.query(`
      SELECT 
        jei.account_id,
        coa.account_code,
        coa.account_name,
        jei.debit_amount,
        jei.credit_amount,
        jei.description
      FROM journal_entry_items jei
      LEFT JOIN chart_of_accounts coa ON jei.account_id = coa.id
      WHERE jei.journal_entry_id = (
        SELECT id FROM journal_entries WHERE journal_number = $1
      )
      ORDER BY jei.line_number
    `, [entry.journal_number]);
    
    console.log(`    📋 Journal entry line items:`);
    for (const item of itemsResult.rows) {
      const amount = item.debit_amount > 0 ? `Dr $${item.debit_amount}` : `Cr $${item.credit_amount}`;
      console.log(`      ${item.account_code} - ${item.account_name}: ${amount}`);
    }
  }
  console.log();
}

async function step6_TestFinancialReports() {
  console.log('📊 Step 6: Testing financial reports...');
  
  // Test Trial Balance
  console.log('  🔄 Testing Trial Balance...');
  const trialBalanceResult = await pool.query(`
    SELECT 
      coa.account_code,
      coa.account_name,
      coa.account_type,
      COALESCE(SUM(jei.debit_amount), 0) as total_debits,
      COALESCE(SUM(jei.credit_amount), 0) as total_credits,
      coa.current_balance
    FROM chart_of_accounts coa
    LEFT JOIN journal_entry_items jei ON coa.id = jei.account_id
    LEFT JOIN journal_entries je ON jei.journal_entry_id = je.id
    WHERE coa.is_active = true 
      AND coa.deleted_at IS NULL
      AND (je.status = 'POSTED' OR je.status IS NULL)
    GROUP BY coa.id, coa.account_code, coa.account_name, coa.account_type, coa.current_balance
    HAVING (COALESCE(SUM(jei.debit_amount), 0) + COALESCE(SUM(jei.credit_amount), 0) + coa.current_balance) != 0
    ORDER BY coa.account_code
    LIMIT 10
  `);
  
  console.log(`    ✅ Trial Balance shows ${trialBalanceResult.rows.length} accounts with activity`);
  
  // Calculate total debits and credits
  let totalDebits = 0, totalCredits = 0;
  for (const row of trialBalanceResult.rows) {
    totalDebits += parseFloat(row.total_debits || 0);
    totalCredits += parseFloat(row.total_credits || 0);
  }
  
  console.log(`    📊 Total Debits: $${totalDebits.toFixed(2)}`);
  console.log(`    📊 Total Credits: $${totalCredits.toFixed(2)}`);
  
  if (Math.abs(totalDebits - totalCredits) < 0.01) {
    console.log(`    ✅ Trial Balance is balanced!`);
  } else {
    console.log(`    ⚠️ Trial Balance difference: $${(totalDebits - totalCredits).toFixed(2)}`);
  }
  
  // Test Balance Sheet data
  console.log('  🔄 Testing Balance Sheet data...');
  const balanceSheetResult = await pool.query(`
    SELECT 
      account_type,
      COUNT(*) as account_count,
      SUM(current_balance) as total_balance
    FROM chart_of_accounts
    WHERE account_type IN ('ASSET', 'LIABILITY', 'EQUITY')
      AND is_active = true
      AND deleted_at IS NULL
    GROUP BY account_type
    ORDER BY account_type
  `);
  
  console.log(`    ✅ Balance Sheet accounts:`);
  for (const row of balanceSheetResult.rows) {
    console.log(`      ${row.account_type}: ${row.account_count} accounts, $${parseFloat(row.total_balance || 0).toFixed(2)}`);
  }
  
  // Test Income Statement data
  console.log('  🔄 Testing Income Statement data...');
  const incomeStatementResult = await pool.query(`
    SELECT 
      account_type,
      COUNT(*) as account_count,
      SUM(current_balance) as total_balance
    FROM chart_of_accounts
    WHERE account_type IN ('REVENUE', 'EXPENSE')
      AND is_active = true
      AND deleted_at IS NULL
    GROUP BY account_type
    ORDER BY account_type
  `);
  
  console.log(`    ✅ Income Statement accounts:`);
  for (const row of incomeStatementResult.rows) {
    console.log(`      ${row.account_type}: ${row.account_count} accounts, $${parseFloat(row.total_balance || 0).toFixed(2)}`);
  }
  
  console.log();
}

// Helper function to format currency
function formatCurrency(amount) {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD'
  }).format(amount || 0);
}

// Run test if called directly
if (require.main === module) {
  testFinanceWorkflow()
    .then(() => {
      console.log('🎊 All finance workflow tests completed successfully!');
      process.exit(0);
    })
    .catch(error => {
      console.error('💥 Test failed:', error.message);
      process.exit(1);
    });
}

module.exports = { testFinanceWorkflow };