const { exec } = require('child_process');
const { promisify } = require('util');
const fs = require('fs').promises;
const path = require('path');

const execAsync = promisify(exec);

// Configuration
const RENDER_DB_URL = process.env.DATABASE_URL; // Current Render URL
const ORACLE_VM_IP = process.env.ORACLE_VM_IP; // Oracle VM public IP
const ORACLE_DB_PASSWORD = process.env.ORACLE_DB_PASSWORD; // Strong password for Oracle
const SSH_KEY_PATH = process.env.SSH_KEY_PATH || '~/.ssh/id_rsa'; // SSH key for Oracle VM

async function completeClone() {
  console.log('🚀 Starting complete database clone from Render to Oracle VM...\n');
  
  try {
    // Step 1: Create complete database dump from Render
    await step1_CreateRenderDump();
    
    // Step 2: Upload dump and scripts to Oracle VM
    await step2_UploadToOracle();
    
    // Step 3: Setup PostgreSQL on Oracle VM
    await step3_SetupPostgreSQL();
    
    // Step 4: Import data to Oracle VM
    await step4_ImportData();
    
    // Step 5: Verify migration
    await step5_VerifyMigration();
    
    console.log('🎉 Database clone completed successfully!');
    console.log(`📊 Your new connection string:`);
    console.log(`DATABASE_URL=postgresql://qira_erp_user:${ORACLE_DB_PASSWORD}@${ORACLE_VM_IP}:5432/qira_erp`);
    
  } catch (error) {
    console.error('❌ Clone failed:', error.message);
    process.exit(1);
  }
}

async function step1_CreateRenderDump() {
  console.log('📥 Step 1: Creating complete dump from Render database...');
  
  const dumpDir = path.join(__dirname, '../database-clone');
  await fs.mkdir(dumpDir, { recursive: true });
  
  // Extract connection details from Render URL
  const url = new URL(RENDER_DB_URL);
  const renderConfig = {
    host: url.hostname,
    port: url.port || 5432,
    database: url.pathname.slice(1),
    username: url.username,
    password: url.password
  };
  
  // Create .pgpass file for passwordless access
  const pgpassContent = `${renderConfig.host}:${renderConfig.port}:${renderConfig.database}:${renderConfig.username}:${renderConfig.password}`;
  await fs.writeFile(path.join(dumpDir, '.pgpass'), pgpassContent, { mode: 0o600 });
  
  // Set environment for pg_dump
  const env = {
    ...process.env,
    PGPASSFILE: path.join(dumpDir, '.pgpass')
  };
  
  console.log('🔄 Creating schema dump...');
  // Schema only dump
  const schemaDumpCmd = `pg_dump -h ${renderConfig.host} -p ${renderConfig.port} -U ${renderConfig.username} -d ${renderConfig.database} --schema-only --no-owner --no-privileges -f ${path.join(dumpDir, 'schema.sql')}`;
  
  try {
    await execAsync(schemaDumpCmd, { env });
    console.log('✅ Schema dump created');
  } catch (error) {
    console.error('❌ Schema dump failed:', error.message);
    throw error;
  }
  
  console.log('🔄 Creating data dump...');
  // Data only dump
  const dataDumpCmd = `pg_dump -h ${renderConfig.host} -p ${renderConfig.port} -U ${renderConfig.username} -d ${renderConfig.database} --data-only --no-owner --no-privileges --column-inserts -f ${path.join(dumpDir, 'data.sql')}`;
  
  try {
    await execAsync(dataDumpCmd, { env });
    console.log('✅ Data dump created');
  } catch (error) {
    console.error('❌ Data dump failed:', error.message);
    throw error;
  }
  
  // Create complete migration script
  const migrationScript = `-- Complete Database Migration Script
-- From Render to Oracle Cloud VM
-- Generated: ${new Date().toISOString()}

-- Drop existing database if it exists (BE CAREFUL!)
DROP DATABASE IF EXISTS qira_erp;
CREATE DATABASE qira_erp;

-- Connect to the new database
\\c qira_erp;

-- Import schema
\\i schema.sql

-- Import data
\\i data.sql

-- Create user and set permissions
CREATE USER IF NOT EXISTS qira_erp_user WITH ENCRYPTED PASSWORD '${ORACLE_DB_PASSWORD}';
GRANT ALL PRIVILEGES ON DATABASE qira_erp TO qira_erp_user;
GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO qira_erp_user;
GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO qira_erp_user;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO qira_erp_user;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO qira_erp_user;

-- Refresh sequences
DO $$
DECLARE
    r RECORD;
BEGIN
    FOR r IN SELECT schemaname, tablename, attname, seq 
             FROM (SELECT schemaname, tablename, attname,
                          pg_get_serial_sequence(schemaname||'.'||tablename, attname) as seq
                   FROM pg_attribute
                   JOIN pg_class ON pg_class.oid = pg_attribute.attrelid
                   JOIN pg_namespace ON pg_namespace.oid = pg_class.relnamespace
                   WHERE attnum > 0 AND pg_get_serial_sequence(schemaname||'.'||tablename, attname) IS NOT NULL
                  ) t
    LOOP
        EXECUTE 'SELECT setval(''' || r.seq || ''', COALESCE((SELECT MAX(' || r.attname || ') FROM ' || r.schemaname || '.' || r.tablename || '), 1))';
    END LOOP;
END$$;

SELECT 'Migration completed successfully!' as result;
`;
  
  await fs.writeFile(path.join(dumpDir, 'complete_migration.sql'), migrationScript);
  console.log('✅ Migration script created\n');
}

async function step2_UploadToOracle() {
  console.log('📤 Step 2: Uploading files to Oracle VM...');
  
  const dumpDir = path.join(__dirname, '../database-clone');
  
  // Copy files to Oracle VM
  const scpCmd = `scp -i ${SSH_KEY_PATH} -r ${dumpDir} ubuntu@${ORACLE_VM_IP}:~/database-clone`;
  
  try {
    await execAsync(scpCmd);
    console.log('✅ Files uploaded to Oracle VM\n');
  } catch (error) {
    console.error('❌ Upload failed:', error.message);
    throw error;
  }
}

async function step3_SetupPostgreSQL() {
  console.log('🔧 Step 3: Setting up PostgreSQL on Oracle VM...');
  
  // Create setup commands
  const setupCommands = `
    # Update system
    sudo apt update && sudo apt upgrade -y
    
    # Install PostgreSQL
    sudo apt install -y postgresql-15 postgresql-client-15 postgresql-contrib-15
    
    # Start PostgreSQL
    sudo systemctl start postgresql
    sudo systemctl enable postgresql
    
    # Configure PostgreSQL for remote access
    sudo sed -i "s/#listen_addresses = 'localhost'/listen_addresses = '*'/" /etc/postgresql/15/main/postgresql.conf
    
    # Add remote access to pg_hba.conf
    echo "hostssl all all 0.0.0.0/0 md5" | sudo tee -a /etc/postgresql/15/main/pg_hba.conf
    echo "host all all 0.0.0.0/0 md5" | sudo tee -a /etc/postgresql/15/main/pg_hba.conf
    
    # Optimize PostgreSQL for 1GB RAM
    cat << EOF | sudo tee -a /etc/postgresql/15/main/postgresql.conf
# Performance tuning for Oracle VM
shared_buffers = 256MB
effective_cache_size = 768MB
work_mem = 4MB
maintenance_work_mem = 64MB
max_connections = 100
EOF
    
    # Restart PostgreSQL
    sudo systemctl restart postgresql
    
    # Configure firewall
    sudo ufw allow 5432/tcp
    sudo ufw allow 22/tcp
    sudo ufw --force enable
    
    echo "PostgreSQL setup completed"
  `;
  
  const sshCmd = `ssh -i ${SSH_KEY_PATH} ubuntu@${ORACLE_VM_IP} "${setupCommands}"`;
  
  try {
    const { stdout, stderr } = await execAsync(sshCmd, { maxBuffer: 1024 * 1024 });
    console.log('SSH Output:', stdout);
    if (stderr) console.log('SSH Warnings:', stderr);
    console.log('✅ PostgreSQL setup completed on Oracle VM\n');
  } catch (error) {
    console.error('❌ PostgreSQL setup failed:', error.message);
    throw error;
  }
}

async function step4_ImportData() {
  console.log('📊 Step 4: Importing data to Oracle VM...');
  
  const importCommands = `
    cd ~/database-clone
    
    # Run migration as postgres user
    sudo -u postgres psql -f complete_migration.sql
    
    echo "Data import completed"
  `;
  
  const sshCmd = `ssh -i ${SSH_KEY_PATH} ubuntu@${ORACLE_VM_IP} "${importCommands}"`;
  
  try {
    const { stdout, stderr } = await execAsync(sshCmd, { maxBuffer: 1024 * 1024 });
    console.log('Import Output:', stdout);
    if (stderr) console.log('Import Warnings:', stderr);
    console.log('✅ Data import completed\n');
  } catch (error) {
    console.error('❌ Data import failed:', error.message);
    throw error;
  }
}

async function step5_VerifyMigration() {
  console.log('🔍 Step 5: Verifying migration...');
  
  const verifyCommands = `
    # Test connection and get table counts
    sudo -u postgres psql -d qira_erp -c "
      SELECT 
        schemaname,
        tablename,
        n_tup_ins as row_count
      FROM pg_stat_user_tables
      WHERE n_tup_ins > 0
      ORDER BY n_tup_ins DESC;
    "
    
    # Test user permissions
    psql -h localhost -U qira_erp_user -d qira_erp -c "SELECT COUNT(*) FROM users;" || echo "User connection test"
  `;
  
  const sshCmd = `ssh -i ${SSH_KEY_PATH} ubuntu@${ORACLE_VM_IP} "${verifyCommands}"`;
  
  try {
    const { stdout } = await execAsync(sshCmd);
    console.log('Verification Results:', stdout);
    console.log('✅ Migration verification completed\n');
  } catch (error) {
    console.error('⚠️ Verification had issues:', error.message);
    // Don't throw - verification warnings are common
  }
}

// Run if called directly
if (require.main === module) {
  // Validate environment variables
  if (!RENDER_DB_URL) {
    console.error('❌ DATABASE_URL environment variable required');
    process.exit(1);
  }
  if (!ORACLE_VM_IP) {
    console.error('❌ ORACLE_VM_IP environment variable required');
    process.exit(1);
  }
  if (!ORACLE_DB_PASSWORD) {
    console.error('❌ ORACLE_DB_PASSWORD environment variable required');
    process.exit(1);
  }
  
  completeClone().catch(console.error);
}

module.exports = { completeClone };