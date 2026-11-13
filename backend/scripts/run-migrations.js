#!/usr/bin/env node
// DEPRECATED — legacy ad-hoc migration runner, no longer wired to any npm
// script (`npm run migrate` now calls scripts/db-migrate.js, the tracked
// runner). This file's hardcoded migration list silently skipped every
// migration written after it (including the 2026-08-12 DoA batch), which is
// how databases ended up behind the code. Kept only for reference; do not
// re-wire it. Use: node scripts/db-migrate.js  (or npm run db:migrate)

const fs = require('fs');
const path = require('path');
const { pool } = require('../config/database');

// ANSI color codes for console output
const colors = {
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  reset: '\x1b[0m'
};

function log(message, color = 'reset') {
  console.log(`${colors[color]}${message}${colors.reset}`);
}

async function runMigration(migrationPath, migrationName) {
  try {
    log(`🔄 Running migration: ${migrationName}`, 'blue');
    
    // Read the migration file
    const migrationSQL = fs.readFileSync(migrationPath, 'utf8');
    
    // Execute the migration
    await pool.query(migrationSQL);
    
    log(`✅ Successfully executed: ${migrationName}`, 'green');
    return true;
  } catch (error) {
    log(`❌ Error executing ${migrationName}:`, 'red');
    console.error(error.message);
    return false;
  }
}

async function checkTableExists(tableName) {
  try {
    const result = await pool.query(`
      SELECT EXISTS (
        SELECT FROM information_schema.tables 
        WHERE table_schema = 'public' 
        AND table_name = $1
      );
    `, [tableName]);
    return result.rows[0].exists;
  } catch (error) {
    return false;
  }
}

async function checkColumnExists(tableName, columnName) {
  try {
    const result = await pool.query(`
      SELECT EXISTS (
        SELECT FROM information_schema.columns 
        WHERE table_schema = 'public' 
        AND table_name = $1 
        AND column_name = $2
      );
    `, [tableName, columnName]);
    return result.rows[0].exists;
  } catch (error) {
    return false;
  }
}

async function checkSequenceExists(sequenceName) {
  try {
    const result = await pool.query(`
      SELECT EXISTS (
        SELECT FROM information_schema.sequences 
        WHERE sequence_schema = 'public' 
        AND sequence_name = $1
      );
    `, [sequenceName]);
    return result.rows[0].exists;
  } catch (error) {
    return false;
  }
}

async function main() {
  log('🚀 Starting database migrations for Simeli ERP', 'blue');
  log('==========================================', 'blue');
  
  try {
    // Test database connection
    await pool.query('SELECT NOW()');
    log('✅ Database connection successful', 'green');
  } catch (error) {
    log('❌ Database connection failed:', 'red');
    console.error(error.message);
    process.exit(1);
  }

  const migrationsDir = path.join(__dirname, '../database/migrations');
  const migrations = [
    {
      file: '001_add_approval_features.sql',
      name: 'Add approval features (decline_reason, approved_item_code, inventory sequence)',
      checks: [
        () => checkColumnExists('items', 'decline_reason'),
        () => checkColumnExists('items', 'approved_item_code'),
        () => checkSequenceExists('inventory_code_seq')
      ]
    },
    {
      file: '002_create_notifications.sql',
      name: 'Create notifications system',
      checks: [
        () => checkTableExists('notifications')
      ]
    },
    {
      file: '003_create_users_and_auth.sql',
      name: 'Create users and authentication system',
      checks: [
        () => checkTableExists('users'),
        () => checkColumnExists('items', 'user_id'),
        () => checkColumnExists('notifications', 'user_id')
      ]
    },
    {
      file: '004_add_warehouse_fields.sql',
      name: 'Add warehouse fields and create storage locations, bins tables',
      checks: [
        () => checkColumnExists('items', 'volume'),
        () => checkColumnExists('items', 'mass'),
        () => checkTableExists('storage_locations'),
        () => checkTableExists('bins')
      ]
    },
    {
      file: '005_add_warehouse_approval_workflow.sql',
      name: 'Add approval workflow to warehouse tables',
      checks: [
        () => checkColumnExists('storage_locations', 'status'),
        () => checkColumnExists('storage_locations', 'decline_reason'),
        () => checkColumnExists('bins', 'status'),
        () => checkColumnExists('bins', 'decline_reason')
      ]
    },
    {
      file: '006_update_notifications_types.sql',
      name: 'Update notification types constraint',
      checks: [
        () => Promise.resolve(false) // Always run this migration
      ]
    },
    {
      file: '007_add_uom_mass_volume_fields.sql',
      name: 'Add Mass per UoM and Volume per UoM fields to items table',
      checks: [
        () => checkColumnExists('items', 'mass_per_uom'),
        () => checkColumnExists('items', 'volume_per_uom')
      ]
    },
    {
      file: '008_create_inventory_items.sql',
      name: 'Create inventory items table and storage mappings',
      checks: [
        () => checkTableExists('inventory_items'),
        () => checkTableExists('inventory_storage_mappings')
      ]
    },
    {
      file: '012_add_missing_inventory_status_columns.sql',
      name: 'Add inventory approval workflow and condition grading columns',
      checks: [
        () => checkColumnExists('inventory_items', 'status'),
        () => checkColumnExists('inventory_items', 'condition_grade'),
        () => checkColumnExists('inventory_items', 'approved_by')
      ]
    }
  ];

  let totalMigrations = 0;
  let successfulMigrations = 0;

  for (const migration of migrations) {
    const migrationPath = path.join(migrationsDir, migration.file);
    
    if (!fs.existsSync(migrationPath)) {
      log(`⚠️  Migration file not found: ${migration.file}`, 'yellow');
      continue;
    }

    totalMigrations++;

    // Check if migration already applied
    const checks = await Promise.all(migration.checks.map(check => check()));
    const alreadyApplied = checks.every(check => check === true);

    if (alreadyApplied) {
      log(`⏭️  Migration already applied: ${migration.file}`, 'yellow');
      successfulMigrations++;
      continue;
    }

    // Run the migration
    const success = await runMigration(migrationPath, migration.name);
    if (success) {
      successfulMigrations++;
    }
  }

  log('==========================================', 'blue');
  
  if (successfulMigrations === totalMigrations) {
    log(`🎉 All migrations completed successfully! (${successfulMigrations}/${totalMigrations})`, 'green');
    
    // Test the new functionality
    log('🧪 Testing new features...', 'blue');
    
    try {
      // Test inventory code generation
      const codeResult = await pool.query('SELECT generate_inventory_code() as code');
      log(`✅ Inventory code generation works: ${codeResult.rows[0].code}`, 'green');
      
      // Test notifications table
      await pool.query('SELECT COUNT(*) FROM notifications');
      log('✅ Notifications table is accessible', 'green');
      
      log('🚀 System is ready! You can now:', 'green');
      log('   • Approve items to generate INV codes', 'green');
      log('   • Decline items with reasons', 'green');  
      log('   • View notifications in the bell icon', 'green');
      
    } catch (error) {
      log('⚠️  Warning: Some features may not work properly:', 'yellow');
      console.error(error.message);
    }
  } else {
    log(`❌ Some migrations failed (${successfulMigrations}/${totalMigrations})`, 'red');
    process.exit(1);
  }

  // Close database connection
  await pool.end();
  log('👋 Database connection closed', 'blue');
}

// Handle graceful shutdown
process.on('SIGINT', async () => {
  log('\n🛑 Migration interrupted by user', 'yellow');
  await pool.end();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  log('\n🛑 Migration terminated', 'yellow');
  await pool.end();  
  process.exit(0);
});

// Run the migration
main().catch(async (error) => {
  log('💥 Migration failed with unexpected error:', 'red');
  console.error(error);
  await pool.end();
  process.exit(1);
});