const { pool } = require('../config/database');
const { v4: uuidv4 } = require('uuid');

class Notification {
  static async create(notificationData, userId = null) {
    const { type, title, message, data } = notificationData;
    const id = uuidv4();
    
    const query = `
      INSERT INTO notifications (id, type, title, message, data, user_id, created_at)
      VALUES ($1, $2, $3, $4, $5, $6, CURRENT_TIMESTAMP)
      RETURNING *
    `;

    try {
      const result = await pool.query(query, [id, type, title, message, JSON.stringify(data || {}), userId]);
      return result.rows[0];
    } catch (error) {
      throw error;
    }
  }

  static async findAll(options = {}, userId = null) {
    const { limit = 50, offset = 0, unreadOnly = false } = options;
    
    let query = 'SELECT * FROM notifications';
    let values = [];
    let conditions = [];
    let paramIndex = 1;

    if (userId) {
      conditions.push(`user_id = $${paramIndex}`);
      values.push(userId);
      paramIndex++;
    }

    if (unreadOnly) {
      conditions.push('is_read = FALSE');
    }

    if (conditions.length > 0) {
      query += ' WHERE ' + conditions.join(' AND ');
    }

    query += ` ORDER BY created_at DESC LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
    values.push(limit, offset);

    try {
      const result = await pool.query(query, values);
      return result.rows.map(notification => ({
        ...notification,
        data: typeof notification.data === 'string' ? JSON.parse(notification.data) : notification.data
      }));
    } catch (error) {
      throw error;
    }
  }

  static async markAsRead(id, userId = null) {
    let query = `
      UPDATE notifications 
      SET is_read = TRUE, read_at = CURRENT_TIMESTAMP 
      WHERE id = $1
    `;
    
    let values = [id];
    if (userId) {
      query += ' AND user_id = $2';
      values.push(userId);
    }
    
    query += ' RETURNING *';

    try {
      const result = await pool.query(query, values);
      if (result.rows.length === 0) {
        throw new Error('Notification not found');
      }
      return result.rows[0];
    } catch (error) {
      throw error;
    }
  }

  static async markAllAsRead(userId = null) {
    let query = `
      UPDATE notifications 
      SET is_read = TRUE, read_at = CURRENT_TIMESTAMP 
      WHERE is_read = FALSE
    `;
    
    let values = [];
    if (userId) {
      query += ' AND user_id = $1';
      values.push(userId);
    }
    
    query += ' RETURNING COUNT(*)';

    try {
      const result = await pool.query(query, values);
      return result.rowCount;
    } catch (error) {
      throw error;
    }
  }

  static async getUnreadCount(userId = null) {
    let query = 'SELECT COUNT(*) as count FROM notifications WHERE is_read = FALSE';
    let values = [];
    
    if (userId) {
      query += ' AND user_id = $1';
      values.push(userId);
    }

    try {
      const result = await pool.query(query, values);
      return parseInt(result.rows[0].count);
    } catch (error) {
      throw error;
    }
  }

  static async delete(id, userId = null) {
    let query = 'DELETE FROM notifications WHERE id = $1';
    let values = [id];
    
    if (userId) {
      query += ' AND user_id = $2';
      values.push(userId);
    }
    
    query += ' RETURNING *';
    
    try {
      const result = await pool.query(query, values);
      if (result.rows.length === 0) {
        throw new Error('Notification not found');
      }
      return result.rows[0];
    } catch (error) {
      throw error;
    }
  }

  static async deleteAll(userId = null) {
    let query = 'DELETE FROM notifications';
    let values = [];
    
    if (userId) {
      query += ' WHERE user_id = $1';
      values.push(userId);
    }
    
    query += ' RETURNING COUNT(*)';
    
    try {
      const result = await pool.query(query, values);
      return result.rowCount;
    } catch (error) {
      throw error;
    }
  }

  static async createForManagers(notificationData) {
    const { type, title, message, data } = notificationData;
    
    // Get all manager/admin users. Roles are stored uppercase throughout this
    // codebase (users.role CHECK constraint permits 'ADMIN'/'MANAGER'/'USER'/...)
    // — this query used to compare against lowercase values and therefore never
    // matched a single real user, so every call silently notified nobody.
    const managersQuery = `
      SELECT id FROM users
      WHERE role IN ('MANAGER', 'ADMIN')
    `;
    
    try {
      const managersResult = await pool.query(managersQuery);
      const managers = managersResult.rows;
      
      // Create notification for each manager
      const notifications = await Promise.all(
        managers.map(async (manager) => {
          return await this.create({
            type,
            title,
            message,
            data
          }, manager.id);
        })
      );
      
      return notifications;
    } catch (error) {
      throw error;
    }
  }
}

module.exports = Notification;