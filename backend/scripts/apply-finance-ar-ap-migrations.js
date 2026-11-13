#!/usr/bin/env node

/**
 * Applies the Accounts Receivable (065) and Accounts Payable (066) finance
 * migrations. These create the customer_invoices / customer_payments and
 * supplier_invoices / supplier_payments tables plus their number-generation
 * functions. Safe to re-run: "already exists" errors are treated as no-ops.
 *
 *   node scripts/apply-finance-ar-ap-migrations.js
 */

const fs = require('fs');
const path = require('path');
const { pool } = require('../config/database');

const MIGRATIONS = [
  '065_create_customer_invoices_payments.sql',
  '066_create_supplier_invoices_payments.sql',
  '067_add_vat_accounts.sql',
  '068_create_fixed_assets.sql',
  '069_create_bank_reconciliation.sql',
  '070_create_budgets_cost_centers.sql',
  '071_create_currencies_fx.sql',
  '072_create_hr_payroll.sql',
  '073_create_accounting_periods.sql',
  '074_add_disposal_accounts.sql',
  '075_fix_journal_number_function.sql',
  '076_add_fixed_asset_source_type.sql',
  '077_multicurrency_fx.sql',
  '078_richer_payroll.sql',
];

async function applyMigration(migrationFile) {
  const migrationPath = path.join(__dirname, '../database/migrations', migrationFile);
  const sql = fs.readFileSync(migrationPath, 'utf8');
  try {
    console.log(`🔄 Applying ${migrationFile}...`);
    await pool.query(sql);
    console.log(`✅ Applied ${migrationFile}`);
    return true;
  } catch (error) {
    if (/already exists|duplicate/i.test(error.message)) {
      console.log(`ℹ️  ${migrationFile}: objects already present — skipping (${error.message})`);
      return true;
    }
    console.error(`❌ Error applying ${migrationFile}:`, error.message);
    return false;
  }
}

async function main() {
  try {
    await pool.query('SELECT NOW()');
    console.log('✅ Database connected');

    let ok = 0;
    for (const m of MIGRATIONS) {
      if (await applyMigration(m)) ok++;
    }
    console.log(`\n🎉 Finance AR/AP migrations complete: ${ok}/${MIGRATIONS.length}`);
    process.exit(ok === MIGRATIONS.length ? 0 : 1);
  } catch (error) {
    console.error('❌ Migration run failed:', error.message);
    process.exit(1);
  }
}

main();
