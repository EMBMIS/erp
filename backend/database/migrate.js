const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });
require('dotenv').config({ path: path.join(__dirname, '../../.env') });

const dbUrl = process.env.DATABASE_URL || '';
const looksLocal = /(localhost|127\.0\.0\.1|\[?::1\]?)/i.test(dbUrl) || !dbUrl;
const dbSslEnv = String(process.env.DB_SSL || '').toLowerCase();
const ssl = dbSslEnv === 'true' ? { rejectUnauthorized: false }
  : dbSslEnv === 'false' ? false
  : (looksLocal ? false : { rejectUnauthorized: false });

// Database connection configuration
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl
});

async function runMigration(migrationFile) {
  try {
    console.log(`📦 Running migration: ${migrationFile}`);
    
    const migrationPath = path.join(__dirname, 'migrations', migrationFile);
    const migrationSQL = fs.readFileSync(migrationPath, 'utf8');
    
    const client = await pool.connect();
    try {
      await client.query(migrationSQL);
      console.log(`✅ Migration ${migrationFile} completed successfully`);
    } finally {
      client.release();
    }
  } catch (error) {
    console.error(`❌ Migration ${migrationFile} failed:`, error.message);
    throw error;
  }
}

async function checkTableStructure() {
  try {
    const client = await pool.connect();
    try {
      // Check if items table exists
      const tableCheck = await client.query(`
        SELECT EXISTS (
          SELECT FROM information_schema.tables 
          WHERE table_schema = 'public' 
          AND table_name = 'items'
        );
      `);
      
      if (!tableCheck.rows[0].exists) {
        console.log('❌ Items table does not exist. Please run the full schema.sql first.');
        return false;
      }
      
      // Check for new columns
      const columnCheck = await client.query(`
        SELECT column_name 
        FROM information_schema.columns 
        WHERE table_name = 'items' 
        AND table_schema = 'public'
        ORDER BY ordinal_position;
      `);
      
      const existingColumns = columnCheck.rows.map(row => row.column_name);
      const requiredColumns = [
        'id', 'item_code', 'name', 'description', 'is_stock_item', 'planned_stock',
        'stock_code', 'status', 'criticality', 'unit_of_measure', 'unspsc_code',
        'manufacturer', 'manufacturer_part_number', 'item_category', 'serial_number',
        'equipment_tag', 'has_contract', 'contract_number', 'has_barcode', 'barcode',
        'created_at', 'updated_at'
      ];
      
      const missingColumns = requiredColumns.filter(col => !existingColumns.includes(col));
      
      console.log('📊 Table Structure Analysis:');
      console.log(`   Existing columns: ${existingColumns.length}`);
      console.log(`   Required columns: ${requiredColumns.length}`);
      console.log(`   Missing columns: ${missingColumns.length}`);
      
      if (missingColumns.length > 0) {
        console.log('❌ Missing columns:', missingColumns.join(', '));
        return false;
      } else {
        console.log('✅ All required columns are present');
        return true;
      }
      
    } finally {
      client.release();
    }
  } catch (error) {
    console.error('❌ Error checking table structure:', error.message);
    return false;
  }
}

async function main() {
  console.log('🚀 Starting database migration process...');
  
  try {
    // Test database connection
    console.log('🔗 Testing database connection...');
    const client = await pool.connect();
    client.release();
    console.log('✅ Database connection successful');
    
    // Check current table structure
    const isUpToDate = await checkTableStructure();
    
    if (!isUpToDate) {
      console.log('🔧 Running migration to add missing fields...');
      await runMigration('001_add_new_fields.sql');
      
      // Verify migration
      const postMigrationCheck = await checkTableStructure();
      if (postMigrationCheck) {
        console.log('🎉 Migration completed successfully! Database is now up to date.');
      } else {
        console.log('❌ Migration verification failed. Please check the logs.');
      }
    } else {
      console.log('✅ Database is already up to date. No migration needed.');
    }
    
  } catch (error) {
    console.error('💥 Migration failed:', error.message);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

// Run if called directly
if (require.main === module) {
  main();
}

module.exports = { runMigration, checkTableStructure };