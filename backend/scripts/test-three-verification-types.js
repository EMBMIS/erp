require('dotenv').config();
const { pool } = require('../config/database');
const emailService = require('../services/emailService');

console.log('🚀 Testing Three Verification Types Email...');
console.log('==========================================');

async function testThreeVerificationTypes() {
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

    console.log('\n📧 Testing PERFECT DELIVERY email...');
    const perfectResult = await emailService.sendDeliveryVerificationNotification(
      mockPO, 
      mockSupplier, 
      true, // verified = true
      'All items delivered perfectly. Excellent packaging, on-time delivery, and all quantities match exactly.', 
      'Admin User'
    );
    
    console.log(`✅ Perfect delivery email sent!`);
    console.log(`   Message ID: ${perfectResult.messageId}`);

    console.log('\n📧 Testing ACCEPT WITH ISSUES email...');
    const acceptWithIssuesResult = await emailService.sendDeliveryVerificationNotification(
      mockPO, 
      mockSupplier, 
      'accept_with_issues', // verified = 'accept_with_issues'
      'Some items had minor packaging damage but are still usable. We are accepting to maintain schedule but please improve packaging quality for future deliveries.', 
      'Admin User'
    );
    
    console.log(`⚠️ Accept with issues email sent!`);
    console.log(`   Message ID: ${acceptWithIssuesResult.messageId}`);

    console.log('\n📧 Testing DELIVERY REJECTED email...');
    const rejectedResult = await emailService.sendDeliveryVerificationNotification(
      mockPO, 
      mockSupplier, 
      false, // verified = false (rejected)
      'Severe quality issues found. Items are damaged beyond use and cannot be accepted. Please arrange pickup and provide replacement delivery after quality inspection.', 
      'Admin User'
    );
    
    console.log(`❌ Delivery rejected email sent!`);
    console.log(`   Message ID: ${rejectedResult.messageId}`);
    
    console.log('\n🎉 All three verification email types sent successfully!');
    console.log('📬 Please check the supplier email inbox for all three different email formats');
    
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

testThreeVerificationTypes();