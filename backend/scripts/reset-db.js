const { Client } = require('pg');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../../.env') });

async function resetDatabase() {
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false } // Always use SSL for remote connections
  });

  try {
    console.log('🔄 Connecting to database...');
    await client.connect();
    console.log('✅ Connected to database');

    // Drop all tables (in correct order due to dependencies)
    console.log('🔄 Dropping existing tables...');
    
    await client.query('DROP TABLE IF EXISTS items CASCADE');
    await client.query('DROP FUNCTION IF EXISTS update_updated_at_column() CASCADE');
    await client.query('DROP EXTENSION IF EXISTS "uuid-ossp"');
    
    console.log('✅ Existing tables dropped');
    console.log('🎉 Database reset completed!');

  } catch (error) {
    console.error('❌ Reset failed:', error.message);
    process.exit(1);
  } finally {
    await client.end();
  }
}

// Run reset if called directly
if (require.main === module) {
  resetDatabase();
}

module.exports = resetDatabase;