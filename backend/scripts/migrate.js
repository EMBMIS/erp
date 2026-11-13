const { Client } = require('pg');
const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../../.env') });

async function runMigration() {
  console.log('🔍 Environment check:');
  console.log('DATABASE_URL:', process.env.DATABASE_URL ? 'Found' : 'Missing');
  console.log('DB_HOST:', process.env.DB_HOST || 'Missing');
  
  // For cloud databases, we'll connect directly to the target database
  // Most cloud providers don't allow database creation via client
  const dbClient = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false } // Always use SSL for remote connections
  });

  try {
    console.log('🔄 Starting database migration...');

    // Connect to target database
    await dbClient.connect();
    console.log('✅ Connected to remote PostgreSQL database');

    // Read and execute schema
    const schemaPath = path.join(__dirname, '../database/schema.sql');
    const schema = fs.readFileSync(schemaPath, 'utf8');
    
    console.log('🔄 Running database schema...');
    await dbClient.query(schema);
    console.log('✅ Database schema created successfully');

    // Verify tables were created
    const tablesResult = await dbClient.query(`
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'public'
    `);
    
    console.log('📋 Created tables:');
    tablesResult.rows.forEach(row => {
      console.log(`   - ${row.table_name}`);
    });

    // Check sample data
    const itemsCount = await dbClient.query('SELECT COUNT(*) FROM items');
    console.log(`📊 Sample data: ${itemsCount.rows[0].count} items inserted`);

    console.log('🎉 Migration completed successfully!');

  } catch (error) {
    console.error('❌ Migration failed:', error.message);
    
    if (error.code) {
      console.error(`   Error Code: ${error.code}`);
    }
    
    // Common error help
    if (error.message.includes('authentication failed')) {
      console.error('💡 Check your database credentials in .env file');
    } else if (error.message.includes('connection refused')) {
      console.error('💡 Check your database host and port in .env file');
    } else if (error.message.includes('database') && error.message.includes('does not exist')) {
      console.error('💡 Database connection issue - check DB_HOST and credentials');
    }
    
    process.exit(1);
  } finally {
    try {
      await dbClient.end();
    } catch (err) {
      // Ignore cleanup errors
    }
  }
}

// Run migration if called directly
if (require.main === module) {
  runMigration();
}

module.exports = runMigration;