#!/usr/bin/env node

const { pool } = require('../config/database');

async function updateUserRole() {
  console.log('🔧 Updating user role to MANAGER for testing approval workflows...');
  
  try {
    // Find the first active user and update their role to MANAGER
    const result = await pool.query(`
      UPDATE users 
      SET role = 'MANAGER'
      WHERE is_active = true 
      AND role = 'USER'
      RETURNING id, email, first_name, last_name, role
    `);
    
    if (result.rows.length > 0) {
      const user = result.rows[0];
      console.log('✅ Successfully updated user role:');
      console.log(`   • User: ${user.first_name} ${user.last_name} (${user.email})`);
      console.log(`   • Role: ${user.role}`);
      console.log(`   • User ID: ${user.id}`);
      console.log('');
      console.log('🎉 This user can now access the inventory approval dashboard!');
    } else {
      console.log('ℹ️  No USER role found to update. Checking existing users...');
      
      const allUsers = await pool.query(`
        SELECT email, first_name, last_name, role 
        FROM users 
        WHERE is_active = true 
        ORDER BY created_at
      `);
      
      if (allUsers.rows.length > 0) {
        console.log('📋 Current users:');
        allUsers.rows.forEach(user => {
          console.log(`   • ${user.first_name} ${user.last_name} (${user.email}) - Role: ${user.role}`);
        });
      } else {
        console.log('⚠️  No active users found. Please create a user first.');
      }
    }
    
  } catch (error) {
    console.error('❌ Error updating user role:', error.message);
  } finally {
    await pool.end();
  }
}

updateUserRole();