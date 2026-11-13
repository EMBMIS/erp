require('dotenv').config();
const { pool } = require('../config/database');
const emailService = require('../services/emailService');
const crypto = require('crypto');

console.log('🚀 Testing PO Approval Email Process...');
console.log('=====================================');

async function testPOApproval() {
  try {
    // Step 1: Get the pending PO
    const poResult = await pool.query(`
      SELECT po.*, s.legal_name as supplier_name, s.email as supplier_email
      FROM purchase_orders po
      LEFT JOIN suppliers s ON po.supplier_id = s.id
      WHERE po.po_number = 'PO-2025-1006'
    `);
    
    if (poResult.rows.length === 0) {
      console.log('❌ PO not found');
      return;
    }
    
    const po = poResult.rows[0];
    console.log(`✅ Found PO: ${po.po_number}`);
    console.log(`   Status: ${po.status}`);
    console.log(`   Supplier: ${po.supplier_name} (${po.supplier_email})`);
    console.log(`   Amount: ${po.currency} ${po.total_amount || '0.00'}`);
    
    if (po.status !== 'PENDING_APPROVAL') {
      console.log('⚠️  PO is not in PENDING_APPROVAL status, continuing anyway...');
    }
    
    // Step 2: Generate delivery token
    console.log('\n🔐 Generating delivery token...');
    const deliveryToken = crypto.randomBytes(32).toString('hex');
    const deliveryDue = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    console.log(`   Token: ${deliveryToken.substring(0, 20)}...`);
    console.log(`   Due: ${deliveryDue.toISOString()}`);
    
    // Step 3: Update PO status
    console.log('\n📝 Updating PO status...');
    await pool.query(`
      UPDATE purchase_orders 
      SET supplier_delivery_token = $1, 
          supplier_delivery_due = $2, 
          status = 'SENT_TO_SUPPLIER'
      WHERE id = $3
    `, [deliveryToken, deliveryDue, po.id]);
    console.log('✅ PO status updated to SENT_TO_SUPPLIER');
    
    // Step 4: Send email
    console.log('\n📧 Sending delivery confirmation email...');
    const supplier = {
      legal_name: po.supplier_name,
      email: po.supplier_email
    };
    
    const result = await emailService.sendPODeliveryConfirmation(po, supplier, deliveryToken);
    console.log(`✅ Email sent successfully!`);
    console.log(`   Message ID: ${result.messageId}`);
    console.log(`   Sent to: ${supplier.email}`);
    console.log(`   Portal URL: ${emailService.frontendUrl}/supplier-portal/delivery/${deliveryToken}`);
    
    console.log('\n🎉 Complete approval workflow executed successfully!');
    console.log('📬 Please check the supplier email inbox for the delivery confirmation');
    
  } catch (error) {
    console.error('❌ Error during approval process:');
    console.error(error.message);
    if (error.stack) {
      console.error('Stack trace:', error.stack);
    }
  } finally {
    pool.end();
  }
}

testPOApproval();