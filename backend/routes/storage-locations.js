const express = require('express');
const { auth, requireManagerOrAdmin } = require('../middleware/auth');
const StorageLocation = require('../models/StorageLocation');
const Bin = require('../models/Bin');
const Notification = require('../models/Notification');

const router = express.Router();

router.get('/', auth, async (req, res) => {
  try {
    const filters = {
      country: req.query.country,
      city: req.query.city,
      is_active: req.query.is_active ? req.query.is_active === 'true' : undefined,
      status: req.query.status,
      search: req.query.search,
      limit: req.query.limit
    };

    const locations = await StorageLocation.findAll(filters, req.userId);
    res.json(locations);
  } catch (error) {
    console.error('Error fetching storage locations:', error);
    res.status(500).json({ error: 'Failed to fetch storage locations' });
  }
});

router.get('/stats', auth, async (req, res) => {
  try {
    const stats = await StorageLocation.getStats(req.userId);
    res.json(stats);
  } catch (error) {
    console.error('Error fetching storage location stats:', error);
    res.status(500).json({ error: 'Failed to fetch storage location statistics' });
  }
});

// Approval workflow routes - MUST come before /:id route
router.get('/pending-approval', auth, requireManagerOrAdmin, async (req, res) => {
  try {
    const locations = await StorageLocation.findPendingApproval();
    res.json(locations);
  } catch (error) {
    console.error('Error fetching pending storage locations:', error);
    res.status(500).json({ error: 'Failed to fetch pending storage locations' });
  }
});

router.get('/:id', auth, async (req, res) => {
  try {
    const location = await StorageLocation.findById(req.params.id, req.userId);
    if (!location) {
      return res.status(404).json({ error: 'Storage location not found' });
    }
    res.json(location);
  } catch (error) {
    console.error('Error fetching storage location:', error);
    res.status(500).json({ error: 'Failed to fetch storage location' });
  }
});

router.get('/code/:code', auth, async (req, res) => {
  try {
    const location = await StorageLocation.findByCode(req.params.code, req.userId);
    if (!location) {
      return res.status(404).json({ error: 'Storage location not found' });
    }
    res.json(location);
  } catch (error) {
    console.error('Error fetching storage location by code:', error);
    res.status(500).json({ error: 'Failed to fetch storage location' });
  }
});

router.get('/:id/bins', auth, async (req, res) => {
  try {
    const bins = await StorageLocation.getBinsByLocation(req.params.id, req.userId);
    res.json(bins);
  } catch (error) {
    console.error('Error fetching bins for storage location:', error);
    res.status(500).json({ error: 'Failed to fetch bins for storage location' });
  }
});

router.post('/', auth, async (req, res) => {
  try {
    const { code, name, country, city, address, postal_code, description } = req.body;

    if (!code || !name || !country || !city || !address || !postal_code) {
      return res.status(400).json({ 
        error: 'Missing required fields: code, name, country, city, address, postal_code' 
      });
    }

    const existingLocation = await StorageLocation.findByCode(code, req.userId);
    if (existingLocation) {
      return res.status(409).json({ error: 'Storage location with this code already exists' });
    }

    const locationData = {
      code: code.toUpperCase(),
      name,
      country,
      city,
      address,
      postal_code,
      description
    };

    const newLocation = await StorageLocation.create(locationData, req.userId);
    res.status(201).json(newLocation);
  } catch (error) {
    console.error('Error creating storage location:', error);
    if (error.code === '23505') {
      return res.status(409).json({ error: 'Storage location with this code already exists' });
    }
    res.status(500).json({ error: 'Failed to create storage location' });
  }
});

router.put('/:id', auth, async (req, res) => {
  try {
    const { code, name, country, city, address, postal_code, description, is_active } = req.body;

    const existingLocation = await StorageLocation.findById(req.params.id, req.userId);
    if (!existingLocation) {
      return res.status(404).json({ error: 'Storage location not found' });
    }

    if (code && code !== existingLocation.code) {
      const codeExists = await StorageLocation.findByCode(code, req.userId);
      if (codeExists && codeExists.id !== req.params.id) {
        return res.status(409).json({ error: 'Storage location with this code already exists' });
      }
    }

    const updateData = {};
    if (code !== undefined) updateData.code = code.toUpperCase();
    if (name !== undefined) updateData.name = name;
    if (country !== undefined) updateData.country = country;
    if (city !== undefined) updateData.city = city;
    if (address !== undefined) updateData.address = address;
    if (postal_code !== undefined) updateData.postal_code = postal_code;
    if (description !== undefined) updateData.description = description;
    if (is_active !== undefined) updateData.is_active = is_active;

    const updatedLocation = await StorageLocation.update(req.params.id, updateData, req.userId);
    if (!updatedLocation) {
      return res.status(404).json({ error: 'Storage location not found' });
    }

    res.json(updatedLocation);
  } catch (error) {
    console.error('Error updating storage location:', error);
    if (error.code === '23505') {
      return res.status(409).json({ error: 'Storage location with this code already exists' });
    }
    res.status(500).json({ error: 'Failed to update storage location' });
  }
});

router.delete('/:id', auth, async (req, res) => {
  try {
    const existingLocation = await StorageLocation.findById(req.params.id, req.userId);
    if (!existingLocation) {
      return res.status(404).json({ error: 'Storage location not found' });
    }

    const bins = await StorageLocation.getBinsByLocation(req.params.id, req.userId);
    if (bins.length > 0) {
      return res.status(400).json({ 
        error: `Cannot delete storage location with ${bins.length} associated bins. Please delete bins first.` 
      });
    }

    const deletedLocation = await StorageLocation.delete(req.params.id, req.userId);
    if (!deletedLocation) {
      return res.status(404).json({ error: 'Storage location not found' });
    }

    res.json({ message: 'Storage location deleted successfully', location: deletedLocation });
  } catch (error) {
    console.error('Error deleting storage location:', error);
    res.status(500).json({ error: 'Failed to delete storage location' });
  }
});

router.post('/:id/submit-for-approval', auth, async (req, res) => {
  try {
    const location = await StorageLocation.submitForApproval(req.params.id, req.userId);
    
    if (!location) {
      return res.status(404).json({ error: 'Storage location not found or already submitted' });
    }

    try {
      // Create notification for managers
      await Notification.createForManagers({
        title: 'New Storage Location Approval Request',
        message: `Storage location "${location.name}" (${location.code}) has been submitted for approval.`,
        type: 'approval_request',
        data: {
          related_item_id: location.id,
          created_by: req.userId
        }
      });
    } catch (notificationError) {
      console.error('Error creating manager notifications:', notificationError);
      // Don't fail the whole operation if notification fails
    }

    res.json({ message: 'Storage location submitted for approval', location });
  } catch (error) {
    console.error('Error submitting storage location for approval:', error);
    res.status(500).json({ error: 'Failed to submit storage location for approval' });
  }
});

router.post('/:id/approve', auth, requireManagerOrAdmin, async (req, res) => {
  try {
    const location = await StorageLocation.approve(req.params.id, req.userId);
    
    if (!location) {
      return res.status(404).json({ error: 'Storage location not found or not pending approval' });
    }

    try {
      // Create notification for the creator
      await Notification.create({
        title: 'Storage Location Approved',
        message: `Your storage location "${location.name}" (${location.code}) has been approved and is now active.`,
        type: 'approval',
        data: {
          related_item_id: location.id,
          created_by: req.userId
        }
      }, location.user_id);
    } catch (notificationError) {
      console.error('Error creating approval notification:', notificationError);
      // Don't fail the whole operation if notification fails
    }

    res.json({ message: 'Storage location approved successfully', location });
  } catch (error) {
    console.error('Error approving storage location:', error);
    res.status(500).json({ error: 'Failed to approve storage location' });
  }
});

router.post('/:id/decline', auth, requireManagerOrAdmin, async (req, res) => {
  try {
    const { reason } = req.body;
    
    if (!reason) {
      return res.status(400).json({ error: 'Decline reason is required' });
    }

    const location = await StorageLocation.decline(req.params.id, req.userId, reason);
    
    if (!location) {
      return res.status(404).json({ error: 'Storage location not found or not pending approval' });
    }

    try {
      // Create notification for the creator
      await Notification.create({
        title: 'Storage Location Declined',
        message: `Your storage location "${location.name}" (${location.code}) has been declined. Reason: ${reason}`,
        type: 'decline',
        data: {
          related_item_id: location.id,
          created_by: req.userId
        }
      }, location.user_id);
    } catch (notificationError) {
      console.error('Error creating decline notification:', notificationError);
      // Don't fail the whole operation if notification fails
    }

    try {
      // Delete the declined location
      await StorageLocation.deleteDeclined(req.params.id);
    } catch (deleteError) {
      console.error('Error deleting declined location:', deleteError);
      // The decline was successful even if deletion fails
    }

    res.json({ message: 'Storage location declined successfully', reason });
  } catch (error) {
    console.error('Error declining storage location:', error);
    res.status(500).json({ error: 'Failed to decline storage location' });
  }
});

module.exports = router;