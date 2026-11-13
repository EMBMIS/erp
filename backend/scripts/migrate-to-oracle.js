const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

// Database configurations
const renderConfig = {
  connectionString: process.env.RENDER_DATABASE_URL, // Your current Render URL
  ssl: { rejectUnauthorized: false }
};

const oracleConfig = {
  host: process.env.ORACLE_VM_IP, // Your Oracle VM public IP
  port: 5432,
  database: 'qira_erp',
  user: 'qira_erp_user',
  password: process.env.ORACLE_DB_PASSWORD,
  ssl: false // No SSL needed for direct VM connection
};

async function migrateDatabase() {
  let renderClient, oracleClient;
  
  try {
    console.log('🔄 Starting database migration from Render to Oracle Cloud...');
    
    // Connect to both databases
    const renderPool = new Pool(renderConfig);
    const oraclePool = new Pool(oracleConfig);
    
    renderClient = await renderPool.connect();
    oracleClient = await oraclePool.connect();
    
    console.log('✅ Connected to both databases');
    
    // Test Oracle connection
    await oracleClient.query('SELECT version()');
    console.log('✅ Oracle VM PostgreSQL is ready');
    
    // Get migration order
    const migrationOrder = [
      'users',
      'customers',
      'suppliers', 
      'items',
      'storage_locations',
      'bins',
      'inventory_items',
      'inventory_storage_mappings',
      'chart_of_accounts',
      'sales_orders',
      'sales_order_items',
      'purchase_orders',
      'purchase_order_items',
      'journal_entries',
      'journal_entry_items',
      'customer_invoices',
      'customer_invoice_items',
      'notifications',
      'delegation_of_authority'
    ];
    
    // Create schema on Oracle
    console.log('📋 Creating schema on Oracle VM...');
    const schemaPath = path.join(__dirname, '../database/schema.sql');
    if (fs.existsSync(schemaPath)) {
      const schema = fs.readFileSync(schemaPath, 'utf8');
      await oracleClient.query(schema);
      console.log('✅ Schema created on Oracle VM');
    } else {
      // Run migrations instead
      const migrationsDir = path.join(__dirname, '../database/migrations');
      const migrationFiles = fs.readdirSync(migrationsDir)
        .filter(file => file.endsWith('.sql'))
        .sort();
      
      for (const file of migrationFiles) {
        try {
          console.log(`🔧 Running migration: ${file}`);
          const migration = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
          await oracleClient.query(migration);
        } catch (error) {
          if (!error.message.includes('already exists')) {
            console.error(`⚠️ Migration ${file} failed:`, error.message);
          }
        }
      }
      console.log('✅ Migrations completed on Oracle VM');
    }
    
    // Migrate data table by table
    let totalRecords = 0;
    
    for (const tableName of migrationOrder) {
      try {
        // Check if table exists in Render
        const tableCheck = await renderClient.query(`
          SELECT COUNT(*) as count FROM information_schema.tables 
          WHERE table_name = $1 AND table_schema = 'public'
        `, [tableName]);
        
        if (tableCheck.rows[0].count === 0) {
          console.log(`⚪ Table ${tableName} does not exist in source, skipping...`);
          continue;
        }
        
        // Clear existing data in Oracle (for re-migration)
        await oracleClient.query(`TRUNCATE TABLE ${tableName} RESTART IDENTITY CASCADE`);
        
        // Get data from Render
        const dataResult = await renderClient.query(`SELECT * FROM ${tableName} ORDER BY created_at`);
        const records = dataResult.rows;
        
        if (records.length === 0) {
          console.log(`⚪ No data in ${tableName}`);
          continue;
        }
        
        console.log(`🔄 Migrating ${records.length} records from ${tableName}...`);
        
        // Batch insert to Oracle (process in chunks of 100)
        const chunkSize = 100;
        for (let i = 0; i < records.length; i += chunkSize) {
          const chunk = records.slice(i, i + chunkSize);
          
          for (const record of chunk) {
            const columns = Object.keys(record);
            const values = Object.values(record);
            const placeholders = values.map((_, index) => `$${index + 1}`).join(', ');
            
            const insertQuery = `
              INSERT INTO ${tableName} (${columns.join(', ')}) 
              VALUES (${placeholders})
              ON CONFLICT DO NOTHING
            `;
            
            try {
              await oracleClient.query(insertQuery, values);
            } catch (insertError) {
              // Skip conflicts but log other errors
              if (!insertError.message.includes('duplicate key') && 
                  !insertError.message.includes('violates unique constraint')) {
                console.error(`⚠️ Insert error in ${tableName}:`, insertError.message);
              }
            }
          }
        }
        
        // Verify migration
        const verifyResult = await oracleClient.query(`SELECT COUNT(*) as count FROM ${tableName}`);
        const migratedCount = verifyResult.rows[0].count;
        
        console.log(`✅ ${tableName}: ${migratedCount}/${records.length} records migrated`);
        totalRecords += parseInt(migratedCount);
        
      } catch (error) {
        console.error(`❌ Error migrating ${tableName}:`, error.message);
      }
    }
    
    // Refresh sequences
    console.log('🔄 Refreshing database sequences...');
    const sequenceQueries = [
      "SELECT setval('users_id_seq', (SELECT COALESCE(MAX(id), 1) FROM users)) WHERE EXISTS (SELECT 1 FROM users);",
      "SELECT setval('notifications_id_seq', (SELECT COALESCE(MAX(id), 1) FROM notifications)) WHERE EXISTS (SELECT 1 FROM notifications);"
    ];
    
    for (const seqQuery of sequenceQueries) {
      try {
        await oracleClient.query(seqQuery);
      } catch (error) {
        // Sequences might not exist, that's ok
        if (!error.message.includes('does not exist')) {
          console.error('Sequence refresh error:', error.message);
        }
      }
    }
    
    // Final verification
    console.log('🔍 Final verification...');
    for (const tableName of migrationOrder.slice(0, 5)) { // Check first 5 tables
      try {
        const countResult = await oracleClient.query(`SELECT COUNT(*) as count FROM ${tableName}`);
        console.log(`✅ ${tableName}: ${countResult.rows[0].count} records`);
      } catch (error) {
        console.log(`⚪ ${tableName}: table verification skipped`);
      }
    }
    
    console.log(`🎉 Migration completed successfully!`);
    console.log(`📊 Total records migrated: ${totalRecords}`);
    console.log(`🔗 Oracle connection string: postgresql://qira_erp_user:${process.env.ORACLE_DB_PASSWORD}@${process.env.ORACLE_VM_IP}:5432/qira_erp`);
    
  } catch (error) {
    console.error('❌ Migration failed:', error);
    throw error;
  } finally {
    if (renderClient) renderClient.release();
    if (oracleClient) oracleClient.release();
  }
}

// Run migration
if (require.main === module) {
  migrateDatabase().catch(console.error);
}

module.exports = { migrateDatabase };