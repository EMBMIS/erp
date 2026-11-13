const fs = require('fs');
const path = require('path');
const db = require('../config/database');

async function runSalesRfqMigration() {
  try {
    console.log('🔄 Starting Sales RFQ migration...');
    
    // Read the migration file
    const migrationPath = path.join(__dirname, '..', 'database', 'migrations', '034_create_sales_rfqs_table.sql');
    const migrationSQL = fs.readFileSync(migrationPath, 'utf8');
    
    // Execute the migration
    await db.query(migrationSQL);
    
    console.log('✅ Sales RFQ migration completed successfully!');
    console.log('📋 Created tables:');
    console.log('   - sales_rfqs');
    console.log('   - sales_rfq_items');
    console.log('   - sales_rfq_status_history');
    console.log('   - sales_rfq_communications');
    console.log('🔧 Created functions:');
    console.log('   - generate_sales_rfq_number()');
    console.log('   - update_sales_rfqs_updated_at()');
    
  } catch (error) {
    console.error('❌ Sales RFQ migration failed:', error);
    process.exit(1);
  } finally {
    await db.end();
  }
}

runSalesRfqMigration();