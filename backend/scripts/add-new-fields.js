const { Client } = require('pg');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../../.env') });

async function addNewFields() {
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
  });

  try {
    console.log('🔄 Connecting to database...');
    await client.connect();
    console.log('✅ Connected to database');

    console.log('🔄 Adding new columns to items table...');

    // Check if columns already exist
    const checkColumnsQuery = `
      SELECT column_name 
      FROM information_schema.columns 
      WHERE table_name = 'items' AND table_schema = 'public'
      AND column_name IN (
        'manufacturer', 'manufacturer_part_number', 'item_category', 
        'serial_number', 'equipment_tag', 'has_contract', 
        'contract_number', 'has_barcode', 'barcode'
      )
    `;

    const existingColumns = await client.query(checkColumnsQuery);
    const existingColumnNames = existingColumns.rows.map(row => row.column_name);

    console.log('📋 Existing new columns:', existingColumnNames);

    // Add columns that don't exist
    const columnsToAdd = [
      { name: 'manufacturer', definition: 'manufacturer VARCHAR(255)' },
      { name: 'manufacturer_part_number', definition: 'manufacturer_part_number VARCHAR(100)' },
      { name: 'item_category', definition: 'item_category VARCHAR(100)' },
      { name: 'serial_number', definition: 'serial_number VARCHAR(100)' },
      { name: 'equipment_tag', definition: 'equipment_tag VARCHAR(50)' },
      { name: 'has_contract', definition: 'has_contract BOOLEAN DEFAULT FALSE' },
      { name: 'contract_number', definition: 'contract_number VARCHAR(50)' },
      { name: 'has_barcode', definition: 'has_barcode BOOLEAN DEFAULT FALSE' },
      { name: 'barcode', definition: 'barcode VARCHAR(100)' }
    ];

    for (const column of columnsToAdd) {
      if (!existingColumnNames.includes(column.name)) {
        console.log(`➕ Adding column: ${column.name}`);
        await client.query(`ALTER TABLE items ADD COLUMN ${column.definition}`);
      } else {
        console.log(`⏭️  Column ${column.name} already exists, skipping`);
      }
    }

    console.log('🔄 Creating indexes for new columns...');

    // Create indexes for new columns (only if they don't exist)
    const indexesToAdd = [
      'CREATE INDEX IF NOT EXISTS idx_items_manufacturer ON items(manufacturer)',
      'CREATE INDEX IF NOT EXISTS idx_items_manufacturer_part_number ON items(manufacturer_part_number)',
      'CREATE INDEX IF NOT EXISTS idx_items_item_category ON items(item_category)',
      'CREATE INDEX IF NOT EXISTS idx_items_serial_number ON items(serial_number)',
      'CREATE INDEX IF NOT EXISTS idx_items_equipment_tag ON items(equipment_tag)',
      'CREATE INDEX IF NOT EXISTS idx_items_contract_number ON items(contract_number)',
      'CREATE INDEX IF NOT EXISTS idx_items_barcode ON items(barcode)'
    ];

    for (const indexQuery of indexesToAdd) {
      await client.query(indexQuery);
    }

    console.log('✅ All indexes created successfully');

    // Update existing sample data with new fields
    console.log('🔄 Updating existing sample data...');
    
    const updateQueries = [
      {
        id: "item_code = 'TEMP-20250107-001'",
        updates: {
          manufacturer: 'Acme Fasteners',
          manufacturer_part_number: 'AF-M10-20-SS',
          item_category: 'Fasteners',
          serial_number: 'BLT-001-2025',
          equipment_tag: 'EQ-MOUNT-01',
          has_contract: false,
          has_barcode: true,
          barcode: '1234567890123'
        }
      },
      {
        id: "item_code = 'TEMP-20250107-002'",
        updates: {
          manufacturer: 'Steel Works Inc',
          manufacturer_part_number: 'SW-PLT-1020',
          item_category: 'Raw Materials',
          serial_number: 'PLT-002-2025',
          has_contract: true,
          contract_number: 'CTR-2024-001',
          has_barcode: false
        }
      },
      {
        id: "item_code = 'TEMP-20250107-003'",
        updates: {
          manufacturer: 'Service Corp',
          manufacturer_part_number: 'SVC-MAINT-001',
          item_category: 'Services',
          has_contract: true,
          contract_number: 'CTR-2024-SVC',
          has_barcode: false
        }
      },
      {
        id: "item_code = 'TEMP-20250107-004'",
        updates: {
          manufacturer: 'SKF',
          manufacturer_part_number: '6203-2Z',
          item_category: 'Bearings',
          serial_number: 'BRG-003-2025',
          equipment_tag: 'EQ-MOTOR-02',
          has_contract: false,
          has_barcode: true,
          barcode: '9876543210987'
        }
      },
      {
        id: "item_code = 'TEMP-20250107-005'",
        updates: {
          manufacturer: 'Mobil',
          manufacturer_part_number: 'MOB-SAE30-5L',
          item_category: 'Lubricants',
          serial_number: 'OIL-004-2025',
          has_contract: false,
          has_barcode: true,
          barcode: '5555666677778'
        }
      }
    ];

    for (const update of updateQueries) {
      const setClause = Object.entries(update.updates)
        .map(([key, value]) => {
          if (typeof value === 'boolean') {
            return `${key} = ${value}`;
          } else if (value === null) {
            return `${key} = NULL`;
          } else {
            return `${key} = '${value}'`;
          }
        })
        .join(', ');

      const updateQuery = `UPDATE items SET ${setClause} WHERE ${update.id}`;
      await client.query(updateQuery);
    }

    console.log('✅ Sample data updated successfully');

    // Verify the migration
    const verifyQuery = 'SELECT COUNT(*) as total FROM items';
    const result = await client.query(verifyQuery);
    console.log(`📊 Total items in database: ${result.rows[0].total}`);

    // Show sample of updated data
    const sampleQuery = 'SELECT item_code, name, manufacturer, item_category, has_contract, has_barcode FROM items LIMIT 3';
    const sampleResult = await client.query(sampleQuery);
    console.log('📋 Sample updated data:');
    sampleResult.rows.forEach(row => {
      console.log(`   ${row.item_code}: ${row.name} (${row.manufacturer || 'No manufacturer'}, ${row.item_category || 'No category'})`);
    });

    console.log('🎉 Migration completed successfully!');

  } catch (error) {
    console.error('❌ Migration failed:', error.message);
    process.exit(1);
  } finally {
    await client.end();
  }
}

// Run migration if called directly
if (require.main === module) {
  addNewFields();
}

module.exports = addNewFields;