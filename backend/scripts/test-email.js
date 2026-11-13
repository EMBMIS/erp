const EmailService = require('../services/emailService');

async function testEmailService() {
  console.log('🧪 Testing Simeli Email Service...');
  console.log('=====================================');

  try {
    // Test connection first
    console.log('1. Testing SMTP connection...');
    await EmailService.testConnection();
    console.log('✅ SMTP connection successful!');

    // Test supplier onboarding email
    console.log('\n2. Testing supplier onboarding email...');
    
    const testSupplier = {
      id: 'test-uuid-123',
      legal_name: 'Test Supplier Ltd',
      supplier_code: 'TEST-001',
      email: process.env.SMTP_USER, // Send test to your own configured Gmail address
    };

    const result = await EmailService.sendSupplierOnboardingEmail(testSupplier, 'Simeli Test Team');
    console.log('✅ Supplier onboarding email sent successfully!');
    console.log('📧 Message ID:', result.messageId);

    console.log('\n🎉 All email tests passed!');
    console.log('\nNext steps:');
    console.log('- Check your email inbox for the test email');
    console.log('- Try clicking the Accept/Decline buttons');
    console.log('- Test the full supplier workflow');

  } catch (error) {
    console.error('❌ Email test failed:', error.message);
    
    if (error.code === 'ECONNREFUSED') {
      console.error('💡 Suggestion: Check SMTP server and port settings');
    } else if (error.code === 'EAUTH') {
      console.error('💡 Suggestion: Check email credentials (username/password)');
    } else if (error.code === 'ESOCKET') {
      console.error('💡 Suggestion: Check internet connection and firewall');
    }
  }

  process.exit(0);
}

testEmailService();