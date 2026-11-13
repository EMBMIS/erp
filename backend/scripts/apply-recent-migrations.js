#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { pool } = require('../config/database');

async function applyMigration(migrationFile) {
  try {
    console.log(`🔄 Applying ${migrationFile}...`);
    
    const migrationPath = path.join(__dirname, '../database/migrations', migrationFile);
    const migrationSQL = fs.readFileSync(migrationPath, 'utf8');
    
    await pool.query(migrationSQL);
    console.log(`✅ Applied ${migrationFile} successfully`);
    return true;
  } catch (error) {
    console.error(`❌ Error applying ${migrationFile}:`, error.message);
    return false;
  }
}

async function main() {
  try {
    console.log('🚀 Applying recent migrations...');
    
    // Test connection
    await pool.query('SELECT NOW()');
    console.log('✅ Database connected');

    const migrations = [
      '015_add_status_to_inventory_storage_mappings.sql',
      '016_update_notifications_type_constraint.sql',
      '017_cleanup_bins_weight_mass_columns.sql',
      '018_create_procurement_tables.sql',
      '019_add_procurement_notification_types.sql'
    ];

    let successCount = 0;
    for (const migration of migrations) {
      const success = await applyMigration(migration);
      if (success) successCount++;
    }

    console.log(`\n🎉 Applied ${successCount}/${migrations.length} migrations successfully`);
    
  } catch (error) {
    console.error('❌ Migration failed:', error);
  } finally {
    await pool.end();
  }
}

main();