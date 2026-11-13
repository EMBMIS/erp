require('dotenv').config();
const { pool } = require('../config/database');
const emailService = require('../services/emailService');

console.log('🚀 Testing Delivery Verification Email...');
console.log('=========================================');

async function testDeliveryVerificationEmail() {
  try {
    // Test data
    const mockPO = {
      po_number: 'PO-2025-1006',
      total_amount: '8990.00',
      currency: 'USD',
      delivery_date: new Date(),
      supplier_id: '401f4220-1a9d-4e16-a5b1-715752b8519a'
    };

    const mockSupplier = {
      legal_name: 'YSBR',
      email: 'owner@example.com'
    };

    console.log('\n📧 Testing SUCCESSFUL verification email...');
    const successResult = await emailService.sendDeliveryVerificationNotification(
      mockPO, 
      mockSupplier, 
      true, // verified = true
      'All items delivered in perfect condition. Excellent packaging and on-time delivery.', 
      'Admin User'
    );
    
    console.log(`✅ Success email sent!`);
    console.log(`   Message ID: ${successResult.messageId}`);
    console.log(`   Sent to: ${mockSupplier.email}`);

    console.log('\n📧 Testing ISSUE REPORT email...');
    const issueResult = await emailService.sendDeliveryVerificationNotification(
      mockPO, 
      mockSupplier, 
      false, // verified = false
      'Some items were damaged during transport. Missing 2 units from the order. Please contact us urgently to resolve this issue.', 
      'Admin User'
    );
    
    console.log(`✅ Issue report email sent!`);
    console.log(`   Message ID: ${issueResult.messageId}`);
    console.log(`   Sent to: ${mockSupplier.email}`);
    
    console.log('\n🎉 Both email types sent successfully!');
    console.log('📬 Please check the supplier email inbox (including spam folder)');
    
  } catch (error) {
    console.error('❌ Error during email testing:');
    console.error(error.message);
    if (error.stack) {
      console.error('Stack trace:', error.stack);
    }
  } finally {
    pool.end();
  }
}

testDeliveryVerificationEmail();