const { pool } = require('../config/database');
const { v4: uuidv4 } = require('uuid');
const NotificationService = require('../services/notificationService');

class StorageLocation {
  static async create(locationData, userId) {
    const {
      code,
      name,
      country,
      city,
      address,
      postal_code,
      description = null,
      status = 'DRAFT'
    } = locationData;

    const id = uuidv4();

    const query = `
      INSERT INTO storage_locations (id, code, name, country, city, address, postal_code, description, status, user_id, is_active)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
      RETURNING *
    `;

    const values = [id, code, name, country, city, address, postal_code, description, status, userId, false];

    try {
      const result = await pool.query(query, values);
      return result.rows[0];
    } catch (error) {
      throw error;
    }
  }

  static async findAll(filters = {}, userId = null) {
    let query = 'SELECT * FROM storage_locations';
    let conditions = [];
    let values = [];
    let paramIndex = 1;

    // Always filter by user_id if provided
    if (userId) {
      conditions.push(`user_id = $${paramIndex}`);
      values.push(userId);
      paramIndex++;
    }

    if (filters.country) {
      conditions.push(`LOWER(country) LIKE LOWER($${paramIndex})`);
      values.push(`%${filters.country}%`);
      paramIndex++;
    }

    if (filters.city) {
      conditions.push(`LOWER(city) LIKE LOWER($${paramIndex})`);
      values.push(`%${filters.city}%`);
      paramIndex++;
    }

    if (filters.is_active !== undefined && filters.is_active !== '') {
      conditions.push(`is_active = $${paramIndex}`);
      values.push(filters.is_active === 'true' || filters.is_active === true);
      paramIndex++;
    }

    if (filters.status) {
      conditions.push(`status = $${paramIndex}`);
      values.push(filters.status);
      paramIndex++;
    }

    if (filters.search) {
      conditions.push(`(
        LOWER(code) LIKE LOWER($${paramIndex}) OR 
        LOWER(name) LIKE LOWER($${paramIndex}) OR 
        LOWER(city) LIKE LOWER($${paramIndex}) OR 
        LOWER(country) LIKE LOWER($${paramIndex})
      )`);
      values.push(`%${filters.search}%`);
      paramIndex++;
    }

    if (conditions.length > 0) {
      query += ' WHERE ' + conditions.join(' AND ');
    }

    query += ' ORDER BY created_at DESC';

    if (filters.limit) {
      query += ` LIMIT $${paramIndex}`;
      values.push(parseInt(filters.limit));
      paramIndex++;
    }

    try {
      const result = await pool.query(query, values);
      return result.rows;
    } catch (error) {
      throw error;
    }
  }

  static async findById(id, userId = null) {
    let query = 'SELECT * FROM storage_locations WHERE id = $1';
    let values = [id];
    
    if (userId) {
      query += ' AND user_id = $2';
      values.push(userId);
    }
    
    try {
      const result = await pool.query(query, values);
      return result.rows[0];
    } catch (error) {
      throw error;
    }
  }

  static async findByCode(code, userId = null) {
    let query = 'SELECT * FROM storage_locations WHERE LOWER(code) = LOWER($1)';
    let values = [code];
    
    if (userId) {
      query += ' AND user_id = $2';
      values.push(userId);
    }
    
    try {
      const result = await pool.query(query, values);
      return result.rows[0];
    } catch (error) {
      throw error;
    }
  }

  static async update(id, locationData, userId = null) {
    const fields = [];
    const values = [];
    let paramIndex = 1;
    const allowedFields = ['code', 'name', 'country', 'city', 'address', 'postal_code', 'description', 'is_active'];

    // Build dynamic SET clause
    allowedFields.forEach(field => {
      if (locationData.hasOwnProperty(field)) {
        fields.push(`${field} = $${paramIndex}`);
        values.push(locationData[field]);
        paramIndex++;
      }
    });

    if (fields.length === 0) {
      throw new Error('No valid fields to update');
    }

    values.push(id);
    let query = `
      UPDATE storage_locations 
      SET ${fields.join(', ')} 
      WHERE id = $${paramIndex}
    `;
    
    if (userId) {
      paramIndex++;
      values.push(userId);
      query += ` AND user_id = $${paramIndex}`;
    }
    
    query += ' RETURNING *';

    try {
      const result = await pool.query(query, values);
      return result.rows[0];
    } catch (error) {
      throw error;
    }
  }

  static async delete(id, userId = null) {
    let query = 'DELETE FROM storage_locations WHERE id = $1';
    let values = [id];
    
    if (userId) {
      query += ' AND user_id = $2';
      values.push(userId);
    }
    
    query += ' RETURNING *';
    
    try {
      const result = await pool.query(query, values);
      const submittedLocation = result.rows[0];
      
      if (submittedLocation) {
        // Create notification for managers about new storage location submission
        await NotificationService.createStorageLocationSubmittedNotification(
          submittedLocation,
          userId || submittedLocation.user_id
        );
      }
      
      return submittedLocation;
    } catch (error) {
      throw error;
    }
  }

  static async getStats(userId = null) {
    let query = `
      SELECT 
        COUNT(*) as total,
        COUNT(CASE WHEN is_active = true THEN 1 END) as active,
        COUNT(CASE WHEN is_active = false THEN 1 END) as inactive,
        COUNT(DISTINCT country) as countries,
        COUNT(DISTINCT city) as cities
      FROM storage_locations
    `;
    
    const values = [];
    if (userId) {
      query += ' WHERE user_id = $1';
      values.push(userId);
    }

    try {
      const result = await pool.query(query, values);
      return result.rows[0];
    } catch (error) {
      throw error;
    }
  }

  static async getBinsByLocation(locationId, userId = null) {
    let query = `
      SELECT 
        b.*,
        ROUND((b.current_weight / b.max_weight_capacity) * 100, 2) as weight_utilization_percent,
        ROUND((b.current_volume / b.max_volume_capacity) * 100, 2) as volume_utilization_percent
      FROM bins b 
      WHERE b.storage_location_id = $1
    `;
    
    let values = [locationId];
    
    if (userId) {
      query += ' AND b.user_id = $2';
      values.push(userId);
    }
    
    query += ' ORDER BY b.code ASC';

    try {
      const result = await pool.query(query, values);
      return result.rows;
    } catch (error) {
      throw error;
    }
  }

  // Approval workflow methods
  static async findPendingApproval(userId = null) {
    let query = 'SELECT * FROM storage_locations WHERE status = $1';
    let values = ['PENDING_APPROVAL'];
    
    if (userId) {
      query += ' AND user_id = $2';
      values.push(userId);
    }
    
    query += ' ORDER BY created_at DESC';

    try {
      const result = await pool.query(query, values);
      return result.rows;
    } catch (error) {
      throw error;
    }
  }

  static async submitForApproval(id, userId = null) {
    let query = `
      UPDATE storage_locations 
      SET status = 'PENDING_APPROVAL', updated_at = CURRENT_TIMESTAMP
      WHERE id = $1 AND status = 'DRAFT'
    `;
    
    let values = [id];
    
    if (userId) {
      query += ' AND user_id = $2';
      values.push(userId);
    }
    
    query += ' RETURNING *';

    try {
      const result = await pool.query(query, values);
      return result.rows[0];
    } catch (error) {
      throw error;
    }
  }

  static async approve(id, approvedBy) {
    const query = `
      UPDATE storage_locations 
      SET status = 'ACTIVE', 
          is_active = true,
          approved_by = $2, 
          approved_at = CURRENT_TIMESTAMP,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = $1 AND status = 'PENDING_APPROVAL'
      RETURNING *
    `;

    try {
      const result = await pool.query(query, [id, approvedBy]);
      const approvedLocation = result.rows[0];
      
      if (approvedLocation) {
        // Create notification for the original user
        await NotificationService.createStorageLocationApprovedNotification(
          approvedLocation,
          approvedBy,
          approvedLocation.user_id
        );
      }
      
      return approvedLocation;
    } catch (error) {
      throw error;
    }
  }

  static async decline(id, declinedBy, reason) {
    const query = `
      UPDATE storage_locations 
      SET status = 'DECLINED',
          decline_reason = $3,
          declined_by = $2,
          declined_at = CURRENT_TIMESTAMP,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = $1 AND status = 'PENDING_APPROVAL'
      RETURNING *
    `;

    try {
      const result = await pool.query(query, [id, declinedBy, reason]);
      const declinedLocation = result.rows[0];
      
      if (declinedLocation) {
        // Create notification for the original user
        await NotificationService.createStorageLocationDeclinedNotification(
          declinedLocation,
          declinedBy,
          declinedLocation.user_id,
          reason
        );
      }
      
      return declinedLocation;
    } catch (error) {
      throw error;
    }
  }

  static async deleteDeclined(id, userId = null) {
    let query = 'DELETE FROM storage_locations WHERE id = $1 AND status = $2';
    let values = [id, 'DECLINED'];
    
    if (userId) {
      query += ' AND user_id = $3';
      values.push(userId);
    }
    
    query += ' RETURNING *';

    try {
      const result = await pool.query(query, values);
      return result.rows[0];
    } catch (error) {
      throw error;
    }
  }
}

module.exports = StorageLocation;