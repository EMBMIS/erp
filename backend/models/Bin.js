const { pool } = require('../config/database');
const { v4: uuidv4 } = require('uuid');
const NotificationService = require('../services/notificationService');

class Bin {
  static async create(binData, userId) {
    const {
      code,
      description,
      max_mass_capacity,
      max_volume_capacity,
      storage_location_id,
      current_mass_used = 0,
      current_volume_used = 0,
      status = 'DRAFT'
    } = binData;

    const id = uuidv4();

    // Validate bin code format (8 digits: WWRRSSBB)
    if (!/^[0-9]{8}$/.test(code)) {
      throw new Error('Bin code must be exactly 8 digits in format WWRRSSBB');
    }

    // Validate capacities are positive
    if (max_mass_capacity <= 0 || max_volume_capacity <= 0) {
      throw new Error('Capacity values must be positive numbers');
    }

    // Validate current usage doesn't exceed capacity
    if (current_mass_used > max_mass_capacity) {
      throw new Error('Current mass used cannot exceed maximum mass capacity');
    }

    if (current_volume_used > max_volume_capacity) {
      throw new Error('Current volume used cannot exceed maximum volume capacity');
    }

    const query = `
      INSERT INTO bins (id, code, description, max_mass_capacity, max_volume_capacity, 
                       current_mass_used, current_volume_used, storage_location_id, status, user_id, is_active)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
      RETURNING *, 
                ROUND((current_mass_used / NULLIF(max_mass_capacity, 0)) * 100, 2) as mass_utilization_percent,
                ROUND((current_volume_used / NULLIF(max_volume_capacity, 0)) * 100, 4) as volume_utilization_percent
    `;

    const values = [id, code, description, max_mass_capacity, max_volume_capacity, 
                   current_mass_used, current_volume_used, storage_location_id, status, userId, false];

    try {
      const result = await pool.query(query, values);
      return result.rows[0];
    } catch (error) {
      throw error;
    }
  }

  static async findAll(filters = {}, userId = null) {
    let query = `
      SELECT b.*, 
             sl.name as storage_location_name,
             sl.code as storage_location_code,
             ROUND((b.current_mass_used / NULLIF(b.max_mass_capacity, 0)) * 100, 2) as mass_utilization_percent,
             ROUND((b.current_volume_used / NULLIF(b.max_volume_capacity, 0)) * 100, 4) as volume_utilization_percent
      FROM bins b
      LEFT JOIN storage_locations sl ON b.storage_location_id = sl.id
    `;
    
    let conditions = [];
    let values = [];
    let paramIndex = 1;

    // Always filter by user_id if provided
    if (userId) {
      conditions.push(`b.user_id = $${paramIndex}`);
      values.push(userId);
      paramIndex++;
    }

    if (filters.storage_location_id) {
      conditions.push(`b.storage_location_id = $${paramIndex}`);
      values.push(filters.storage_location_id);
      paramIndex++;
    }

    if (filters.is_active !== undefined && filters.is_active !== '') {
      conditions.push(`b.is_active = $${paramIndex}`);
      values.push(filters.is_active === 'true' || filters.is_active === true);
      paramIndex++;
    }

    if (filters.status) {
      conditions.push(`b.status = $${paramIndex}`);
      values.push(filters.status);
      paramIndex++;
    }

    if (filters.search) {
      conditions.push(`(
        b.code LIKE $${paramIndex} OR 
        LOWER(b.description) LIKE LOWER($${paramIndex}) OR
        LOWER(sl.name) LIKE LOWER($${paramIndex})
      )`);
      values.push(`%${filters.search}%`);
      paramIndex++;
    }

    // Filter by capacity utilization
    if (filters.mass_utilization_min) {
      conditions.push(`(b.current_mass_used / NULLIF(b.max_mass_capacity, 0)) * 100 >= $${paramIndex}`);
      values.push(parseFloat(filters.mass_utilization_min));
      paramIndex++;
    }

    if (filters.mass_utilization_max) {
      conditions.push(`(b.current_mass_used / NULLIF(b.max_mass_capacity, 0)) * 100 <= $${paramIndex}`);
      values.push(parseFloat(filters.mass_utilization_max));
      paramIndex++;
    }

    if (filters.volume_utilization_min) {
      conditions.push(`(b.current_volume_used / NULLIF(b.max_volume_capacity, 0)) * 100 >= $${paramIndex}`);
      values.push(parseFloat(filters.volume_utilization_min));
      paramIndex++;
    }

    if (filters.volume_utilization_max) {
      conditions.push(`(b.current_volume_used / NULLIF(b.max_volume_capacity, 0)) * 100 <= $${paramIndex}`);
      values.push(parseFloat(filters.volume_utilization_max));
      paramIndex++;
    }

    if (conditions.length > 0) {
      query += ' WHERE ' + conditions.join(' AND ');
    }

    query += ' ORDER BY b.code ASC';

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
    let query = `
      SELECT b.*, 
             sl.name as storage_location_name,
             sl.code as storage_location_code,
             ROUND((b.current_mass_used / NULLIF(b.max_mass_capacity, 0)) * 100, 2) as mass_utilization_percent,
             ROUND((b.current_volume_used / NULLIF(b.max_volume_capacity, 0)) * 100, 4) as volume_utilization_percent
      FROM bins b
      LEFT JOIN storage_locations sl ON b.storage_location_id = sl.id
      WHERE b.id = $1
    `;
    
    let values = [id];
    
    if (userId) {
      query += ' AND b.user_id = $2';
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
    let query = `
      SELECT b.*, 
             sl.name as storage_location_name,
             sl.code as storage_location_code,
             ROUND((b.current_mass_used / NULLIF(b.max_mass_capacity, 0)) * 100, 2) as mass_utilization_percent,
             ROUND((b.current_volume_used / NULLIF(b.max_volume_capacity, 0)) * 100, 4) as volume_utilization_percent
      FROM bins b
      LEFT JOIN storage_locations sl ON b.storage_location_id = sl.id
      WHERE b.code = $1
    `;
    
    let values = [code];
    
    if (userId) {
      query += ' AND b.user_id = $2';
      values.push(userId);
    }
    
    try {
      const result = await pool.query(query, values);
      return result.rows[0];
    } catch (error) {
      throw error;
    }
  }

  static async update(id, binData, userId = null) {
    const fields = [];
    const values = [];
    let paramIndex = 1;
    const allowedFields = ['description', 'max_mass_capacity', 'max_volume_capacity', 
                          'current_mass_used', 'current_volume_used', 'is_active'];

    // Validate capacity updates
    if (binData.hasOwnProperty('max_mass_capacity') && binData.max_mass_capacity <= 0) {
      throw new Error('Maximum mass capacity must be positive');
    }

    if (binData.hasOwnProperty('max_volume_capacity') && binData.max_volume_capacity <= 0) {
      throw new Error('Maximum volume capacity must be positive');
    }

    // Build dynamic SET clause
    allowedFields.forEach(field => {
      if (binData.hasOwnProperty(field)) {
        fields.push(`${field} = $${paramIndex}`);
        values.push(binData[field]);
        paramIndex++;
      }
    });

    if (fields.length === 0) {
      throw new Error('No valid fields to update');
    }

    values.push(id);
    let query = `
      UPDATE bins 
      SET ${fields.join(', ')} 
      WHERE id = $${paramIndex}
    `;
    
    if (userId) {
      paramIndex++;
      values.push(userId);
      query += ` AND user_id = $${paramIndex}`;
    }
    
    query += ` RETURNING *, 
                ROUND((current_mass_used / NULLIF(max_mass_capacity, 0)) * 100, 2) as mass_utilization_percent,
                ROUND((current_volume_used / NULLIF(max_volume_capacity, 0)) * 100, 4) as volume_utilization_percent`;

    try {
      const result = await pool.query(query, values);
      return result.rows[0];
    } catch (error) {
      throw error;
    }
  }

  static async delete(id, userId = null) {
    let query = 'DELETE FROM bins WHERE id = $1';
    let values = [id];
    
    if (userId) {
      query += ' AND user_id = $2';
      values.push(userId);
    }
    
    query += ' RETURNING *';
    
    try {
      const result = await pool.query(query, values);
      const submittedBin = result.rows[0];
      
      if (submittedBin) {
        // Get storage location details for notification
        const storageQuery = `
          SELECT name, code FROM storage_locations WHERE id = $1
        `;
        const storageResult = await pool.query(storageQuery, [submittedBin.storage_location_id]);
        const storageLocationDetails = storageResult.rows[0];
        
        // Create notification for managers about new bin submission
        await NotificationService.createBinSubmittedNotification(
          submittedBin,
          storageLocationDetails,
          userId || submittedBin.user_id
        );
      }
      
      return submittedBin;
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
        ROUND(AVG((current_mass_used / NULLIF(max_mass_capacity, 0)) * 100), 2) as avg_mass_utilization,
        ROUND(AVG((current_volume_used / NULLIF(max_volume_capacity, 0)) * 100), 2) as avg_volume_utilization,
        COUNT(CASE WHEN (current_mass_used / NULLIF(max_mass_capacity, 0)) * 100 >= 90 THEN 1 END) as near_mass_capacity,
        COUNT(CASE WHEN (current_volume_used / NULLIF(max_volume_capacity, 0)) * 100 >= 90 THEN 1 END) as near_volume_capacity,
        SUM(max_mass_capacity) as total_mass_capacity,
        SUM(max_volume_capacity) as total_volume_capacity,
        SUM(current_mass_used) as total_current_mass,
        SUM(current_volume_used) as total_current_volume
      FROM bins
    `;
    
    const values = [];
    if (userId) {
      query += ' WHERE user_id = $1';
      values.push(userId);
    }

    try {
      const result = await pool.query(query, values);
      const stats = result.rows[0];
      
      // Calculate overall utilization percentages
      if (stats.total_mass_capacity > 0) {
        stats.overall_mass_utilization = Math.round((stats.total_current_mass / stats.total_mass_capacity) * 100 * 100) / 100;
      } else {
        stats.overall_mass_utilization = 0;
      }

      if (stats.total_volume_capacity > 0) {
        stats.overall_volume_utilization = Math.round((stats.total_current_volume / stats.total_volume_capacity) * 100 * 100) / 100;
      } else {
        stats.overall_volume_utilization = 0;
      }

      return stats;
    } catch (error) {
      throw error;
    }
  }

  static async checkCapacity(binId, additionalWeight = 0, additionalVolume = 0, userId = null) {
    const bin = await this.findById(binId, userId);
    if (!bin) {
      throw new Error('Bin not found');
    }

    const newWeight = parseFloat(bin.current_mass_used) + parseFloat(additionalWeight);
    const newVolume = parseFloat(bin.current_volume_used) + parseFloat(additionalVolume);

    const weightUtilization = (newWeight / bin.max_mass_capacity) * 100;
    const volumeUtilization = (newVolume / bin.max_volume_capacity) * 100;

    return {
      canAccommodate: newWeight <= bin.max_mass_capacity && newVolume <= bin.max_volume_capacity,
      currentWeight: bin.current_mass_used,
      currentVolume: bin.current_volume_used,
      newWeight,
      newVolume,
      maxWeight: bin.max_mass_capacity,
      maxVolume: bin.max_volume_capacity,
      weightUtilization: Math.round(weightUtilization * 100) / 100,
      volumeUtilization: Math.round(volumeUtilization * 100) / 100,
      exceedsWeight: newWeight > bin.max_mass_capacity,
      exceedsVolume: newVolume > bin.max_volume_capacity
    };
  }

  static async updateCapacityUsage(binId, weightChange = 0, volumeChange = 0, userId = null) {
    const query = `
      UPDATE bins 
      SET current_mass_used = current_mass_used + $1, 
          current_volume_used = current_volume_used + $2 
      WHERE id = $3 ${userId ? 'AND user_id = $4' : ''}
      RETURNING *, 
                ROUND((current_mass_used / NULLIF(max_mass_capacity, 0)) * 100, 2) as mass_utilization_percent,
                ROUND((current_volume_used / NULLIF(max_volume_capacity, 0)) * 100, 4) as volume_utilization_percent
    `;
    
    const values = userId ? 
      [weightChange, volumeChange, binId, userId] : 
      [weightChange, volumeChange, binId];

    try {
      const result = await pool.query(query, values);
      return result.rows[0];
    } catch (error) {
      throw error;
    }
  }

  // Approval workflow methods
  static async findPendingApproval(userId = null) {
    let query = `
      SELECT b.*, 
             sl.name as storage_location_name,
             sl.code as storage_location_code,
             ROUND((b.current_mass_used / NULLIF(b.max_mass_capacity, 0)) * 100, 2) as mass_utilization_percent,
             ROUND((b.current_volume_used / NULLIF(b.max_volume_capacity, 0)) * 100, 4) as volume_utilization_percent
      FROM bins b
      LEFT JOIN storage_locations sl ON b.storage_location_id = sl.id
      WHERE b.status = $1
    `;
    let values = ['PENDING_APPROVAL'];
    
    if (userId) {
      query += ' AND b.user_id = $2';
      values.push(userId);
    }
    
    query += ' ORDER BY b.created_at DESC';

    try {
      const result = await pool.query(query, values);
      return result.rows;
    } catch (error) {
      throw error;
    }
  }

  static async submitForApproval(id, userId = null) {
    let query = `
      UPDATE bins 
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
      UPDATE bins 
      SET status = 'ACTIVE', 
          is_active = true,
          approved_by = $2, 
          approved_at = CURRENT_TIMESTAMP,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = $1 AND status = 'PENDING_APPROVAL'
      RETURNING *, 
                ROUND((current_mass_used / NULLIF(max_mass_capacity, 0)) * 100, 2) as mass_utilization_percent,
                ROUND((current_volume_used / NULLIF(max_volume_capacity, 0)) * 100, 4) as volume_utilization_percent
    `;

    try {
      const result = await pool.query(query, [id, approvedBy]);
      const approvedBin = result.rows[0];
      
      if (approvedBin) {
        // Get storage location details for notification
        const storageQuery = `
          SELECT name, code FROM storage_locations WHERE id = $1
        `;
        const storageResult = await pool.query(storageQuery, [approvedBin.storage_location_id]);
        const storageLocationDetails = storageResult.rows[0];
        
        // Create notification for the original user
        await NotificationService.createBinApprovedNotification(
          approvedBin,
          storageLocationDetails,
          approvedBy,
          approvedBin.user_id
        );
      }
      
      return approvedBin;
    } catch (error) {
      throw error;
    }
  }

  static async decline(id, declinedBy, reason) {
    const query = `
      UPDATE bins 
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
      const declinedBin = result.rows[0];
      
      if (declinedBin) {
        // Get storage location details for notification
        const storageQuery = `
          SELECT name, code FROM storage_locations WHERE id = $1
        `;
        const storageResult = await pool.query(storageQuery, [declinedBin.storage_location_id]);
        const storageLocationDetails = storageResult.rows[0];
        
        // Create notification for the original user
        await NotificationService.createBinDeclinedNotification(
          declinedBin,
          storageLocationDetails,
          declinedBy,
          declinedBin.user_id,
          reason
        );
      }
      
      return declinedBin;
    } catch (error) {
      throw error;
    }
  }

  static async deleteDeclined(id, userId = null) {
    let query = 'DELETE FROM bins WHERE id = $1 AND status = $2';
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

module.exports = Bin;