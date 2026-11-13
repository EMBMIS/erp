const express = require('express');
const router = express.Router();
const DeliverySchedule = require('../models/DeliverySchedule');
const { auth: requireAuth, requireRole } = require('../middleware/auth');

router.get('/', requireAuth, async (req, res) => {
  try {
    const filters = {
      search: req.query.search,
      status: req.query.status,
      customer_id: req.query.customer_id,
      sales_order_id: req.query.sales_order_id,
      priority: req.query.priority,
      delivery_date_from: req.query.delivery_date_from,
      delivery_date_to: req.query.delivery_date_to,
      driver_name: req.query.driver_name,
      limit: parseInt(req.query.limit) || 50,
      offset: parseInt(req.query.offset) || 0
    };

    const schedules = await DeliverySchedule.findAll(filters);
    
    res.json({
      success: true,
      data: schedules,
      total: schedules.length
    });
  } catch (error) {
    console.error('Error fetching delivery schedules:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to fetch delivery schedules' 
    });
  }
});

router.get('/stats', requireAuth, async (req, res) => {
  try {
    const stats = await DeliverySchedule.getStats();
    
    res.json({
      success: true,
      data: stats
    });
  } catch (error) {
    console.error('Error fetching delivery stats:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to fetch delivery statistics' 
    });
  }
});

router.get('/:id', requireAuth, async (req, res) => {
  try {
    const schedule = await DeliverySchedule.findById(req.params.id);
    
    if (!schedule) {
      return res.status(404).json({ 
        success: false, 
        error: 'Delivery schedule not found' 
      });
    }
    
    res.json({
      success: true,
      data: schedule
    });
  } catch (error) {
    console.error('Error fetching delivery schedule:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to fetch delivery schedule' 
    });
  }
});

router.get('/:id/status-history', requireAuth, async (req, res) => {
  try {
    const history = await DeliverySchedule.getStatusHistory(req.params.id);
    
    res.json({
      success: true,
      data: history
    });
  } catch (error) {
    console.error('Error fetching delivery status history:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to fetch status history' 
    });
  }
});

router.post('/', requireAuth, async (req, res) => {
  try {
    const {
      sales_order_id,
      sales_order_number,
      customer_id,
      customer_name,
      delivery_date,
      delivery_time_from,
      delivery_time_to,
      delivery_address,
      delivery_instructions,
      shipping_method,
      contact_person,
      contact_phone,
      contact_email,
      priority,
      driver_name,
      vehicle_number,
      tracking_number,
      estimated_delivery_time,
      notes,
      internal_notes,
      special_instructions,
      items
    } = req.body;

    if (!sales_order_id) {
      return res.status(400).json({ 
        success: false, 
        error: 'Sales order ID is required' 
      });
    }

    if (!customer_id) {
      return res.status(400).json({ 
        success: false, 
        error: 'Customer ID is required' 
      });
    }

    if (!delivery_date) {
      return res.status(400).json({ 
        success: false, 
        error: 'Delivery date is required' 
      });
    }

    if (!delivery_address) {
      return res.status(400).json({ 
        success: false, 
        error: 'Delivery address is required' 
      });
    }

    if (!items || items.length === 0) {
      return res.status(400).json({ 
        success: false, 
        error: 'At least one delivery item is required' 
      });
    }

    for (const item of items) {
      if (!item.item_name || !item.ordered_quantity || !item.unit_of_measure) {
        return res.status(400).json({ 
          success: false, 
          error: 'All item fields are required: item_name, ordered_quantity, unit_of_measure' 
        });
      }
    }

    const scheduleData = {
      sales_order_id,
      sales_order_number,
      customer_id,
      customer_name,
      delivery_date,
      delivery_time_from,
      delivery_time_to,
      delivery_address,
      delivery_instructions,
      shipping_method,
      contact_person,
      contact_phone,
      contact_email,
      priority,
      driver_name,
      vehicle_number,
      tracking_number,
      estimated_delivery_time,
      notes,
      internal_notes,
      special_instructions,
      items
    };

    const schedule = await DeliverySchedule.create(scheduleData, req.user.id);
    
    res.status(201).json({
      success: true,
      data: schedule,
      message: 'Delivery schedule created successfully'
    });
  } catch (error) {
    console.error('Error creating delivery schedule:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message || 'Failed to create delivery schedule' 
    });
  }
});

router.post('/from-sales-order/:salesOrderId', requireAuth, async (req, res) => {
  try {
    const schedule = await DeliverySchedule.createFromSalesOrder(req.params.salesOrderId, req.user.id);
    
    res.status(201).json({
      success: true,
      data: schedule,
      message: 'Delivery schedule created from sales order successfully'
    });
  } catch (error) {
    console.error('Error creating delivery schedule from sales order:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message || 'Failed to create delivery schedule from sales order' 
    });
  }
});

router.put('/:id', requireAuth, async (req, res) => {
  try {
    const {
      sales_order_id,
      sales_order_number,
      customer_id,
      customer_name,
      delivery_date,
      delivery_time_from,
      delivery_time_to,
      delivery_address,
      delivery_instructions,
      shipping_method,
      contact_person,
      contact_phone,
      contact_email,
      priority,
      driver_name,
      vehicle_number,
      tracking_number,
      estimated_delivery_time,
      notes,
      internal_notes,
      special_instructions,
      items
    } = req.body;

    if (items && items.length > 0) {
      for (const item of items) {
        if (!item.item_name || !item.ordered_quantity || !item.unit_of_measure) {
          return res.status(400).json({ 
            success: false, 
            error: 'All item fields are required: item_name, ordered_quantity, unit_of_measure' 
          });
        }
      }
    }

    const scheduleData = {
      sales_order_id,
      sales_order_number,
      customer_id,
      customer_name,
      delivery_date,
      delivery_time_from,
      delivery_time_to,
      delivery_address,
      delivery_instructions,
      shipping_method,
      contact_person,
      contact_phone,
      contact_email,
      priority,
      driver_name,
      vehicle_number,
      tracking_number,
      estimated_delivery_time,
      notes,
      internal_notes,
      special_instructions,
      items
    };

    const schedule = await DeliverySchedule.update(req.params.id, scheduleData, req.user.id);
    
    if (!schedule) {
      return res.status(404).json({ 
        success: false, 
        error: 'Delivery schedule not found' 
      });
    }

    // Update related sales order status if delivery status changed. DELIVERED
    // is deliberately NOT handled here: DeliverySchedule.updateStatus (the
    // dedicated status-transition path, PUT /:id/status below) is what actually
    // advances the schedule to DELIVERED and, from there, decides whether to
    // advance the sales order — it waits for every outstanding shipment AND
    // checks that every ordered quantity was actually shipped before doing so
    // (see DeliverySchedule.isFullyShipped). This general update endpoint does
    // not even persist `status` onto delivery_schedules (DeliverySchedule.update
    // has no status column in its UPDATE), so unconditionally forcing the sales
    // order into WAITING_CUSTOMER_DELIVERY_CONFIRMATION here — as this used to —
    // would flip it on a delivery that wasn't actually marked delivered, and
    // without checking whether other shipments were still outstanding or the
    // order was fully shipped. That produced a customer invoice for the full
    // order total on a short-shipped or partially-fulfilled order.
    if (scheduleData.status && schedule.sales_order_id) {
      const SalesOrder = require('../models/SalesOrder');

      if (scheduleData.status === 'IN_TRANSIT') {
        await SalesOrder.updateStatus(schedule.sales_order_id, 'SHIPPED', req.user.id);
      } else if (scheduleData.status === 'READY_TO_SHIP') {
        await SalesOrder.updateStatus(schedule.sales_order_id, 'READY_FOR_DELIVERY', req.user.id);
      }
    }
    
    res.json({
      success: true,
      data: schedule,
      message: 'Delivery schedule updated successfully'
    });
  } catch (error) {
    console.error('Error updating delivery schedule:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message || 'Failed to update delivery schedule' 
    });
  }
});

router.put('/:id/status', requireAuth, async (req, res) => {
  try {
    const { status, reason, location } = req.body;
    
    if (!status) {
      return res.status(400).json({ 
        success: false, 
        error: 'Status is required' 
      });
    }

    const validStatuses = ['SCHEDULED', 'READY_TO_SHIP', 'IN_TRANSIT', 'DELIVERED', 'CANCELLED', 'FAILED'];
    if (!validStatuses.includes(status)) {
      return res.status(400).json({ 
        success: false, 
        error: 'Invalid status' 
      });
    }

    const schedule = await DeliverySchedule.updateStatus(
      req.params.id, 
      status, 
      req.user.id, 
      reason || '', 
      location
    );
    
    if (!schedule) {
      return res.status(404).json({ 
        success: false, 
        error: 'Delivery schedule not found' 
      });
    }

    // Update related sales order status. DELIVERED is deliberately NOT handled
    // here — DeliverySchedule.updateStatus (just awaited above) already advances
    // the sales order itself once every shipment is in and every ordered
    // quantity has actually been delivered (DeliverySchedule.isFullyShipped).
    // This used to ALSO force the order into WAITING_CUSTOMER_DELIVERY_CONFIRMATION
    // unconditionally, on every single DELIVERED schedule regardless of other
    // outstanding shipments or shipped quantity — defeating that guard and
    // producing a customer invoice for the full order total after only a
    // partial or first-of-several shipments went out.
    if (schedule.sales_order_id) {
      const SalesOrder = require('../models/SalesOrder');

      if (status === 'DELIVERED') {
        // Only ask the customer to confirm receipt once the order actually IS
        // awaiting their confirmation (every shipment in, every quantity
        // shipped) — not on every individual schedule marked DELIVERED, which
        // would prompt a "please confirm delivery" email while shipments are
        // still outstanding.
        const { pool } = require('../config/database');
        const soNow = await pool.query('SELECT status FROM sales_orders WHERE id = $1', [schedule.sales_order_id]);
        if (soNow.rows[0]?.status === 'WAITING_CUSTOMER_DELIVERY_CONFIRMATION') {
          const customerEmailService = require('../services/customerEmailService');
          try {
            await customerEmailService.sendDeliveryConfirmationRequest(schedule.sales_order_id);
          } catch (emailError) {
            console.error('Failed to send delivery confirmation email:', emailError);
          }
        }
      } else if (status === 'IN_TRANSIT') {
        await SalesOrder.updateStatus(schedule.sales_order_id, 'SHIPPED', req.user.id);
      } else if (status === 'READY_TO_SHIP') {
        await SalesOrder.updateStatus(schedule.sales_order_id, 'READY_FOR_DELIVERY', req.user.id);
      }
    }
    
    res.json({
      success: true,
      data: schedule,
      message: 'Delivery status updated successfully'
    });
  } catch (error) {
    console.error('Error updating delivery status:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message || 'Failed to update delivery status' 
    });
  }
});

// Create hybrid delivery schedule with automatic PO creation
router.post('/:salesOrderId/create-hybrid', requireAuth, async (req, res) => {
  try {
    const { deliveryPlan, notes } = req.body;
    
    if (!deliveryPlan || !deliveryPlan.items || deliveryPlan.items.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'Delivery plan with items is required'
      });
    }

    // Validate delivery plan structure
    for (const item of deliveryPlan.items) {
      if (!item.item_name || !item.ordered_quantity || !item.unit_of_measure) {
        return res.status(400).json({
          success: false,
          error: 'All item fields required: item_name, ordered_quantity, unit_of_measure'
        });
      }
      
      if (!item.fulfillment_method || !['INVENTORY', 'DROPSHIP'].includes(item.fulfillment_method)) {
        return res.status(400).json({
          success: false,
          error: 'Valid fulfillment_method required: INVENTORY or DROPSHIP'
        });
      }
      
      if (item.fulfillment_method === 'DROPSHIP' && !item.supplier_id) {
        return res.status(400).json({
          success: false,
          error: 'supplier_id required for DROPSHIP items'
        });
      }
    }

    const result = await DeliverySchedule.createHybridDeliveryWithAutoPO(
      req.params.salesOrderId,
      deliveryPlan,
      req.user.id
    );
    
    res.status(201).json({
      success: true,
      data: result,
      message: 'Hybrid delivery schedule created with automatic purchase orders'
    });
  } catch (error) {
    console.error('Error creating hybrid delivery:', error);
    res.status(error.statusCode || 500).json({
      success: false,
      error: error.message || 'Failed to create hybrid delivery schedule'
    });
  }
});

// Postpone delivery schedule
router.post('/:id/postpone', requireAuth, async (req, res) => {
  try {
    const { new_delivery_date, postponement_reason } = req.body;
    
    if (!new_delivery_date) {
      return res.status(400).json({
        success: false,
        error: 'New delivery date is required'
      });
    }
    
    if (!postponement_reason) {
      return res.status(400).json({
        success: false,
        error: 'Postponement reason is required'
      });
    }

    const schedule = await DeliverySchedule.postpone(
      req.params.id,
      new_delivery_date,
      postponement_reason,
      req.user.id
    );
    
    if (!schedule) {
      return res.status(404).json({
        success: false,
        error: 'Delivery schedule not found'
      });
    }
    
    res.json({
      success: true,
      data: schedule,
      message: 'Delivery schedule postponed successfully'
    });
  } catch (error) {
    console.error('Error postponing delivery:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to postpone delivery schedule'
    });
  }
});

// Get delivery fulfillment analysis
router.get('/:id/fulfillment-analysis', requireAuth, async (req, res) => {
  try {
    const analysis = await DeliverySchedule.getFulfillmentAnalysis(req.params.id);
    
    if (!analysis) {
      return res.status(404).json({
        success: false,
        error: 'Delivery schedule not found'
      });
    }
    
    res.json({
      success: true,
      data: analysis
    });
  } catch (error) {
    console.error('Error fetching fulfillment analysis:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch fulfillment analysis'
    });
  }
});

// Get auto-created purchase orders for delivery
router.get('/:id/auto-purchase-orders', requireAuth, async (req, res) => {
  try {
    const autoPOs = await DeliverySchedule.getAutoPurchaseOrders(req.params.id);
    
    res.json({
      success: true,
      data: autoPOs,
      count: autoPOs.length
    });
  } catch (error) {
    console.error('Error fetching auto purchase orders:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch auto purchase orders'
    });
  }
});

// Create Purchase Order for delivery schedule
router.post('/:id/create-purchase-order', requireAuth, async (req, res) => {
  try {
    const scheduleId = req.params.id;
    
    // Get delivery schedule with items
    const schedule = await DeliverySchedule.findById(scheduleId);
    if (!schedule) {
      return res.status(404).json({
        success: false,
        error: 'Delivery schedule not found'
      });
    }

    if (schedule.status !== 'SCHEDULED') {
      return res.status(400).json({
        success: false,
        error: 'Can only create purchase orders for scheduled deliveries'
      });
    }

    if (schedule.purchase_order_created) {
      return res.status(400).json({
        success: false,
        error: 'Purchase order already created for this delivery'
      });
    }

    // Filter items that need purchase orders (dropship/purchase order fulfillment)
    const poItems = schedule.items?.filter(item => 
      item.fulfillment_method === 'DROPSHIP' || 
      item.fulfillment_method === 'PURCHASE_ORDER'
    ) || [];

    if (poItems.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'No items require purchase order fulfillment'
      });
    }

    // Group items by supplier if needed, or create single PO
    const PurchaseOrder = require('../models/PurchaseOrder');
    
    const poData = {
      source_type: 'delivery_schedule',
      source_id: scheduleId,
      delivery_date: schedule.delivery_date,
      special_instructions: `Delivery Schedule: ${schedule.schedule_number}\nCustomer: ${schedule.customer_name}`,
      line_items: poItems.map(item => ({
        item_description: item.item_name + (item.item_specification ? ` - ${item.item_specification}` : ''),
        quantity: parseFloat(item.ordered_quantity),
        unit_of_measure: item.unit_of_measure,
        unit_price: parseFloat(item.unit_cost || 0),
        total_price: parseFloat(item.ordered_quantity) * parseFloat(item.unit_cost || 0),
        delivery_date: schedule.delivery_date,
        supplier_id: item.supplier_id
      }))
    };

    const purchaseOrder = await PurchaseOrder.create(poData, req.user.id);
    
    // Update delivery schedule to mark PO as created
    await DeliverySchedule.markPurchaseOrderCreated(scheduleId, purchaseOrder.id);
    
    res.status(201).json({
      success: true,
      data: {
        delivery_schedule: schedule,
        purchase_order: purchaseOrder,
        po_number: purchaseOrder.po_number
      },
      message: `Purchase Order ${purchaseOrder.po_number} created successfully`
    });
  } catch (error) {
    console.error('Error creating purchase order for delivery:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to create purchase order'
    });
  }
});

router.delete('/:id', requireAuth, requireRole('MANAGER', 'ADMIN'), async (req, res) => {
  try {
    const schedule = await DeliverySchedule.delete(req.params.id, req.user.id);
    
    if (!schedule) {
      return res.status(404).json({ 
        success: false, 
        error: 'Delivery schedule not found' 
      });
    }
    
    res.json({
      success: true,
      message: 'Delivery schedule deleted successfully'
    });
  } catch (error) {
    console.error('Error deleting delivery schedule:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to delete delivery schedule' 
    });
  }
});

module.exports = router;