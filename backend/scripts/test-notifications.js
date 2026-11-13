#!/usr/bin/env node

const { pool } = require('../config/database');
const Notification = require('../models/Notification');

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

async function testNotifications() {
  log('🧪 Testing Notification System', 'blue');
  log('============================', 'blue');
  
  try {
    // Test database connection
    await pool.query('SELECT NOW()');
    log('✅ Database connection successful', 'green');
    
    // Test creating a notification
    log('🔔 Creating test notification...', 'blue');
    const testNotification = await Notification.create({
      type: 'ITEM_APPROVED',
      title: 'Test Notification',
      message: 'This is a test notification to verify the system works',
      data: {
        itemId: 'test-123',
        itemName: 'Test Item',
        oldItemCode: 'TEMP-20250108-001',
        newItemCode: 'INV-00000001'
      }
    });
    log(`✅ Notification created with ID: ${testNotification.id}`, 'green');
    
    // Test getting unread count
    const unreadCount = await Notification.getUnreadCount();
    log(`📊 Unread notifications count: ${unreadCount}`, 'blue');
    
    // Test getting all notifications
    const notifications = await Notification.findAll({ limit: 5 });
    log(`📋 Found ${notifications.length} notifications`, 'blue');
    
    if (notifications.length > 0) {
      const latest = notifications[0];
      log(`   Latest: "${latest.title}" - ${latest.message}`, 'yellow');
    }
    
    // Test marking as read
    log('✅ Marking test notification as read...', 'blue');
    await Notification.markAsRead(testNotification.id);
    log('✅ Notification marked as read', 'green');
    
    // Test deleting the test notification
    log('🗑️  Cleaning up test notification...', 'blue');
    await Notification.delete(testNotification.id);
    log('✅ Test notification deleted', 'green');
    
    log('============================', 'blue');
    log('🎉 All notification tests passed!', 'green');
    log('🚀 Notification system is working correctly', 'green');
    
  } catch (error) {
    log('❌ Notification test failed:', 'red');
    console.error(error);
    process.exit(1);
  }
  
  // Close database connection
  await pool.end();
  log('👋 Test completed', 'blue');
}

// Run the test
testNotifications().catch(async (error) => {
  log('💥 Test failed with unexpected error:', 'red');
  console.error(error);
  await pool.end();
  process.exit(1);
});