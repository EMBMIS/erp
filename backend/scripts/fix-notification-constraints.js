const { pool } = require('../config/database');

async function fixNotificationConstraints() {
  console.log('🔧 Fixing notification constraints...');
  
  try {
    // First, check existing notification types
    const existingTypes = await pool.query('SELECT DISTINCT type FROM notifications');
    console.log('📊 Existing notification types:');
    existingTypes.rows.forEach(row => console.log(`  - ${row.type}`));
    
    // Drop the existing constraint
    await pool.query('ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_type_check');
    console.log('✅ Dropped existing constraint');
    
    // Add new constraint with all required types
    const constraintQuery = `
      ALTER TABLE notifications 
      ADD CONSTRAINT notifications_type_check CHECK (
        type IN (
          -- Legacy types
          'ITEM_APPROVED',
          'ITEM_DECLINED',
          'GENERAL',
          'approval',
          'decline',
          'approval_request',
          
          -- Item Master notifications
          'item_master_submitted',
          'item_master_approved',
          'item_master_declined',
          
          -- Inventory Item notifications
          'inventory_item_submitted',
          'inventory_item_approved',
          'inventory_item_declined',
          
          -- Storage Assignment notifications
          'storage_assignment_submitted',
          'storage_assignment_approved',
          'storage_assignment_declined',
          
          -- Storage Location notifications
          'storage_location_submitted',
          'storage_location_approved',
          'storage_location_declined',
          
          -- Bin notifications
          'bin_submitted',
          'bin_approved',
          'bin_declined',
          
          -- Procurement notifications
          -- Supplier notifications
          'supplier_submitted',
          'supplier_approved',
          'supplier_declined',
          'supplier_certified',
          'supplier_decertified',
          'supplier_partnership_accepted',
          'supplier_partnership_declined',
          
          -- Purchase Requisition notifications
          'pr_submitted',
          'pr_approved',
          'pr_declined',
          
          -- Request for Quotation notifications
          'rfq_sent',
          'rfq_response_received',
          'rfq_supplier_selected',
          
          -- Purchase Order notifications
          'po_submitted',
          'po_approved',
          'po_sent_to_supplier',
          'po_confirmed',
          'po_items_received',
          'po_supplier_confirmed',
          'po_supplier_rejected',
          
          -- Contract notifications
          'contract_created',
          'contract_sent_to_supplier',
          'contract_activated',
          'contract_expiring'
        )
      )
    `;
    
    await pool.query(constraintQuery);
    console.log('✅ Added updated notification constraint');
    
    // Verify the fix worked
    const testQuery = await pool.query('SELECT COUNT(*) FROM notifications');
    console.log(`✅ Constraint fix successful - ${testQuery.rows[0].count} notifications validated`);
    
  } catch (error) {
    console.error('❌ Error fixing constraints:', error.message);
    throw error;
  }
  
  process.exit(0);
}

fixNotificationConstraints();