const express = require('express');
const { auth, requireManagerOrAdmin } = require('../middleware/auth');
const Bin = require('../models/Bin');
const StorageLocation = require('../models/StorageLocation');
const Notification = require('../models/Notification');

const router = express.Router();

router.get('/', auth, async (req, res) => {
  try {
    const filters = {
      storage_location_id: req.query.storage_location_id,
      is_active: req.query.is_active ? req.query.is_active === 'true' : undefined,
      status: req.query.status,
      search: req.query.search,
      mass_utilization_min: req.query.mass_utilization_min,
      mass_utilization_max: req.query.mass_utilization_max,
      volume_utilization_min: req.query.volume_utilization_min,
      volume_utilization_max: req.query.volume_utilization_max,
      limit: req.query.limit
    };

    const bins = await Bin.findAll(filters, req.userId);
    res.json(bins);
  } catch (error) {
    console.error('Error fetching bins:', error);
    res.status(500).json({ error: 'Failed to fetch bins' });
  }
});

router.get('/stats', auth, async (req, res) => {
  try {
    const stats = await Bin.getStats(req.userId);
    res.json(stats);
  } catch (error) {
    console.error('Error fetching bin stats:', error);
    res.status(500).json({ error: 'Failed to fetch bin statistics' });
  }
});

// Approval workflow routes - MUST come before /:id route
router.get('/pending-approval', auth, requireManagerOrAdmin, async (req, res) => {
  try {
    const bins = await Bin.findPendingApproval();
    res.json(bins);
  } catch (error) {
    console.error('Error fetching pending bins:', error);
    res.status(500).json({ error: 'Failed to fetch pending bins' });
  }
});

// Get inventory items stored in a specific bin
router.get('/:id/inventory-items', auth, async (req, res) => {
  try {
    const binId = req.params.id;
    const query = `
      SELECT 
        ism.*,
        ii.id as inventory_item_id,
        ii.unit_price,
        ii.currency,
        ii.condition_grade,
        ii.condition_notes,
        ii.status as inventory_status,
        i.name as item_name,
        i.item_code,
        i.approved_item_code,
        i.description as item_description,
        i.unit_of_measure,
        i.criticality,
        i.mass_per_uom,
        i.volume_per_uom,
        (ism.quantity_in_location * COALESCE(i.mass_per_uom, 0)) as total_mass,
        (ism.quantity_in_location * COALESCE(i.volume_per_uom, 0)) as total_volume
      FROM inventory_storage_mappings ism
      JOIN inventory_items ii ON ism.inventory_item_id = ii.id
      JOIN items i ON ii.item_master_id = i.id
      WHERE ism.bin_id = $1 AND ism.user_id = $2
      ORDER BY i.name ASC
    `;
    
    const { pool } = require('../config/database');
    const result = await pool.query(query, [binId, req.userId]);
    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching bin inventory items:', error);
    res.status(500).json({ error: 'Failed to fetch bin inventory items' });
  }
});

router.get('/:id', auth, async (req, res) => {
  try {
    const bin = await Bin.findById(req.params.id, req.userId);
    if (!bin) {
      return res.status(404).json({ error: 'Bin not found' });
    }
    res.json(bin);
  } catch (error) {
    console.error('Error fetching bin:', error);
    res.status(500).json({ error: 'Failed to fetch bin' });
  }
});

router.get('/code/:code', auth, async (req, res) => {
  try {
    const bin = await Bin.findByCode(req.params.code, req.userId);
    if (!bin) {
      return res.status(404).json({ error: 'Bin not found' });
    }
    res.json(bin);
  } catch (error) {
    console.error('Error fetching bin by code:', error);
    res.status(500).json({ error: 'Failed to fetch bin' });
  }
});

router.post('/', auth, async (req, res) => {
  try {
    const { 
      code, 
      description, 
      max_mass_capacity, 
      max_volume_capacity, 
      storage_location_id,
      current_mass_used = 0,
      current_volume_used = 0
    } = req.body;

    if (!code || !description || !max_mass_capacity || !max_volume_capacity || !storage_location_id) {
      return res.status(400).json({ 
        error: 'Missing required fields: code, description, max_mass_capacity, max_volume_capacity, storage_location_id' 
      });
    }

    const storageLocation = await StorageLocation.findById(storage_location_id, req.userId);
    if (!storageLocation) {
      return res.status(404).json({ error: 'Storage location not found' });
    }

    const existingBin = await Bin.findByCode(code, req.userId);
    if (existingBin) {
      return res.status(409).json({ error: 'Bin with this code already exists' });
    }

    const binData = {
      code,
      description,
      max_mass_capacity: parseFloat(max_mass_capacity),
      max_volume_capacity: parseFloat(max_volume_capacity),
      current_mass_used: parseFloat(current_mass_used),
      current_volume_used: parseFloat(current_volume_used),
      storage_location_id
    };

    const newBin = await Bin.create(binData, req.userId);
    res.status(201).json(newBin);
  } catch (error) {
    console.error('Error creating bin:', error);
    if (error.code === '23505') {
      return res.status(409).json({ error: 'Bin with this code already exists' });
    }
    res.status(400).json({ error: error.message });
  }
});

router.put('/:id', auth, async (req, res) => {
  try {
    const { 
      description, 
      max_mass_capacity, 
      max_volume_capacity, 
      current_mass_used,
      current_volume_used,
      is_active 
    } = req.body;

    const existingBin = await Bin.findById(req.params.id, req.userId);
    if (!existingBin) {
      return res.status(404).json({ error: 'Bin not found' });
    }

    const updateData = {};
    if (description !== undefined) updateData.description = description;
    if (max_mass_capacity !== undefined) updateData.max_mass_capacity = parseFloat(max_mass_capacity);
    if (max_volume_capacity !== undefined) updateData.max_volume_capacity = parseFloat(max_volume_capacity);
    if (current_mass_used !== undefined) updateData.current_mass_used = parseFloat(current_mass_used);
    if (current_volume_used !== undefined) updateData.current_volume_used = parseFloat(current_volume_used);
    if (is_active !== undefined) updateData.is_active = is_active;

    const updatedBin = await Bin.update(req.params.id, updateData, req.userId);
    if (!updatedBin) {
      return res.status(404).json({ error: 'Bin not found' });
    }

    res.json(updatedBin);
  } catch (error) {
    console.error('Error updating bin:', error);
    res.status(400).json({ error: error.message });
  }
});

router.delete('/:id', auth, async (req, res) => {
  try {
    const existingBin = await Bin.findById(req.params.id, req.userId);
    if (!existingBin) {
      return res.status(404).json({ error: 'Bin not found' });
    }

    if (existingBin.current_weight > 0 || existingBin.current_volume > 0) {
      return res.status(400).json({ 
        error: 'Cannot delete bin with current inventory. Please move inventory first.' 
      });
    }

    const deletedBin = await Bin.delete(req.params.id, req.userId);
    if (!deletedBin) {
      return res.status(404).json({ error: 'Bin not found' });
    }

    res.json({ message: 'Bin deleted successfully', bin: deletedBin });
  } catch (error) {
    console.error('Error deleting bin:', error);
    res.status(500).json({ error: 'Failed to delete bin' });
  }
});

router.post('/:id/check-capacity', auth, async (req, res) => {
  try {
    const { additional_weight = 0, additional_volume = 0 } = req.body;

    const capacityCheck = await Bin.checkCapacity(
      req.params.id, 
      additional_weight, 
      additional_volume, 
      req.userId
    );

    res.json(capacityCheck);
  } catch (error) {
    console.error('Error checking bin capacity:', error);
    res.status(400).json({ error: error.message });
  }
});

router.post('/:id/update-usage', auth, async (req, res) => {
  try {
    const { weight_change = 0, volume_change = 0 } = req.body;

    const capacityCheck = await Bin.checkCapacity(
      req.params.id,
      weight_change,
      volume_change,
      req.userId
    );

    if (!capacityCheck.canAccommodate) {
      return res.status(400).json({
        error: 'Operation would exceed bin capacity',
        details: capacityCheck
      });
    }

    const updatedBin = await Bin.updateCapacityUsage(
      req.params.id,
      weight_change,
      volume_change,
      req.userId
    );

    if (!updatedBin) {
      return res.status(404).json({ error: 'Bin not found' });
    }

    res.json(updatedBin);
  } catch (error) {
    console.error('Error updating bin capacity usage:', error);
    res.status(400).json({ error: error.message });
  }
});

router.post('/:id/submit-for-approval', auth, async (req, res) => {
  try {
    const bin = await Bin.submitForApproval(req.params.id, req.userId);
    
    if (!bin) {
      return res.status(404).json({ error: 'Bin not found or already submitted' });
    }

    try {
      // Create notification for managers
      await Notification.createForManagers({
        title: 'New Bin Approval Request',
        message: `Bin "${bin.code}" has been submitted for approval.`,
        type: 'approval_request',
        data: {
          related_item_id: bin.id,
          created_by: req.userId
        }
      });
    } catch (notificationError) {
      console.error('Error creating manager notifications:', notificationError);
      // Don't fail the whole operation if notification fails
    }

    res.json({ message: 'Bin submitted for approval', bin });
  } catch (error) {
    console.error('Error submitting bin for approval:', error);
    res.status(500).json({ error: 'Failed to submit bin for approval' });
  }
});

router.post('/:id/approve', auth, requireManagerOrAdmin, async (req, res) => {
  try {
    const bin = await Bin.approve(req.params.id, req.userId);
    
    if (!bin) {
      return res.status(404).json({ error: 'Bin not found or not pending approval' });
    }

    try {
      // Create notification for the creator
      await Notification.create({
        title: 'Bin Approved',
        message: `Your bin "${bin.code}" has been approved and is now active.`,
        type: 'approval',
        data: {
          related_item_id: bin.id,
          created_by: req.userId
        }
      }, bin.user_id);
    } catch (notificationError) {
      console.error('Error creating approval notification:', notificationError);
      // Don't fail the whole operation if notification fails
    }

    res.json({ message: 'Bin approved successfully', bin });
  } catch (error) {
    console.error('Error approving bin:', error);
    res.status(500).json({ error: 'Failed to approve bin' });
  }
});

router.post('/:id/decline', auth, requireManagerOrAdmin, async (req, res) => {
  try {
    const { reason } = req.body;
    
    if (!reason) {
      return res.status(400).json({ error: 'Decline reason is required' });
    }

    const bin = await Bin.decline(req.params.id, req.userId, reason);
    
    if (!bin) {
      return res.status(404).json({ error: 'Bin not found or not pending approval' });
    }

    try {
      // Create notification for the creator
      await Notification.create({
        title: 'Bin Declined',
        message: `Your bin "${bin.code}" has been declined. Reason: ${reason}`,
        type: 'decline',
        data: {
          related_item_id: bin.id,
          created_by: req.userId
        }
      }, bin.user_id);
    } catch (notificationError) {
      console.error('Error creating decline notification:', notificationError);
      // Don't fail the whole operation if notification fails
    }

    try {
      // Delete the declined bin
      await Bin.deleteDeclined(req.params.id);
    } catch (deleteError) {
      console.error('Error deleting declined bin:', deleteError);
      // The decline was successful even if deletion fails
    }

    res.json({ message: 'Bin declined successfully', reason });
  } catch (error) {
    console.error('Error declining bin:', error);
    res.status(500).json({ error: 'Failed to decline bin' });
  }
});

module.exports = router;