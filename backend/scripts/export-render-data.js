const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

// Render database connection
const renderPool = new Pool({
  connectionString: process.env.DATABASE_URL // Your current Render connection string
});

async function exportRenderData() {
  const client = await renderPool.connect();
  
  try {
    console.log('🔄 Starting data export from Render PostgreSQL...');
    
    // Get all table names
    const tablesResult = await client.query(`
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'public' 
      ORDER BY table_name
    `);
    
    const tables = tablesResult.rows.map(row => row.table_name);
    console.log(`📊 Found ${tables.length} tables to export:`, tables);
    
    // Create export directory
    const exportDir = path.join(__dirname, '../exports');
    if (!fs.existsSync(exportDir)) {
      fs.mkdirSync(exportDir, { recursive: true });
    }
    
    // Export schema
    console.log('📋 Exporting database schema...');
    const schemaResult = await client.query(`
      SELECT 
        'CREATE TABLE ' || table_name || ' (' ||
        array_to_string(
          array_agg(
            column_name || ' ' || 
            CASE 
              WHEN data_type = 'character varying' THEN 'VARCHAR(' || character_maximum_length || ')'
              WHEN data_type = 'numeric' THEN 'NUMERIC(' || numeric_precision || ',' || numeric_scale || ')'
              WHEN data_type = 'timestamp with time zone' THEN 'TIMESTAMP WITH TIME ZONE'
              WHEN data_type = 'uuid' THEN 'UUID'
              ELSE UPPER(data_type)
            END ||
            CASE WHEN is_nullable = 'NO' THEN ' NOT NULL' ELSE '' END
          ), ', '
        ) || ');' as create_statement
      FROM information_schema.columns 
      WHERE table_schema = 'public'
      GROUP BY table_name
      ORDER BY table_name
    `);
    
    const schemaSQL = schemaResult.rows.map(row => row.create_statement).join('\n\n');
    fs.writeFileSync(path.join(exportDir, 'schema.sql'), schemaSQL);
    
    // Export data for each table
    let totalRecords = 0;
    for (const tableName of tables) {
      try {
        console.log(`📤 Exporting data from ${tableName}...`);
        
        const dataResult = await client.query(`SELECT * FROM ${tableName}`);
        const records = dataResult.rows;
        
        if (records.length > 0) {
          // Convert to INSERT statements
          const columns = Object.keys(records[0]);
          const insertStatements = records.map(record => {
            const values = columns.map(col => {
              const value = record[col];
              if (value === null) return 'NULL';
              if (typeof value === 'string') return `'${value.replace(/'/g, "''")}'`;
              if (value instanceof Date) return `'${value.toISOString()}'`;
              return value;
            });
            return `INSERT INTO ${tableName} (${columns.join(', ')}) VALUES (${values.join(', ')});`;
          });
          
          const tableSQL = insertStatements.join('\n');
          fs.writeFileSync(path.join(exportDir, `${tableName}_data.sql`), tableSQL);
          
          console.log(`✅ Exported ${records.length} records from ${tableName}`);
          totalRecords += records.length;
        } else {
          console.log(`⚪ No data in ${tableName}`);
        }
      } catch (error) {
        console.error(`❌ Error exporting ${tableName}:`, error.message);
      }
    }
    
    // Create migration order file
    const migrationOrder = [
      'users',
      'customers', 
      'suppliers',
      'items',
      'inventory_items',
      'storage_locations',
      'bins',
      'chart_of_accounts',
      'sales_orders',
      'sales_order_items',
      'purchase_orders',
      'journal_entries',
      'journal_entry_items',
      'customer_invoices',
      'customer_invoice_items'
    ].filter(table => tables.includes(table));
    
    fs.writeFileSync(
      path.join(exportDir, 'migration_order.txt'), 
      migrationOrder.join('\n')
    );
    
    // Create complete migration script
    const migrationScript = `-- Oracle Cloud PostgreSQL Migration Script
-- Generated from Render database on ${new Date().toISOString()}

-- Step 1: Create schema
\\i schema.sql

-- Step 2: Import data (in dependency order)
${migrationOrder.map(table => `\\i ${table}_data.sql`).join('\n')}

-- Step 3: Refresh sequences (if any)
SELECT setval(pg_get_serial_sequence('users', 'id'), (SELECT MAX(id) FROM users)) WHERE EXISTS (SELECT 1 FROM users);
-- Add more sequence refreshes as needed

SELECT 'Migration completed successfully!' as result;
`;
    
    fs.writeFileSync(path.join(exportDir, 'complete_migration.sql'), migrationScript);
    
    console.log(`🎉 Export completed successfully!`);
    console.log(`📊 Total records exported: ${totalRecords}`);
    console.log(`📁 Files created in: ${exportDir}`);
    console.log('📝 Files:');
    console.log('  - schema.sql (database structure)');
    console.log('  - *_data.sql (table data)');
    console.log('  - complete_migration.sql (full migration script)');
    console.log('  - migration_order.txt (import order)');
    
  } catch (error) {
    console.error('❌ Export failed:', error);
  } finally {
    client.release();
    await renderPool.end();
  }
}

// Run export
exportRenderData().catch(console.error);