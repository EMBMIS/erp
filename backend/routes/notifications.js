const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const Notification = require('../models/Notification');
const User = require('../models/User');
const { validateUUID } = require('../middleware/validation');
const { auth } = require('../middleware/auth');

// GET /notifications/stream - Real-time SSE Live Event Stream Connection
//
// EventSource cannot send an Authorization header, so the browser passes the
// JWT as a query parameter — the auth middleware only reads the header, so
// the stream 401'd silently and live push never connected (the bell still
// worked via polling, which is why this was easy to miss). Verify the query
// token here; this route is deliberately the only one that accepts it.
router.get('/stream', async (req, res) => {
  try {
    const token = req.query.token || (req.header('Authorization') || '').replace(/^Bearer\s+/i, '');
    if (!token) {
      return res.status(401).json({ success: false, error: 'Access denied. No token provided.' });
    }
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const user = await User.findById(decoded.id);
    if (!user || !user.is_active) {
      return res.status(401).json({ success: false, error: 'Invalid token. User not found.' });
    }
    req.user = user;

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    const sseManager = require('../services/sseService');
    sseManager.addClient(res, user.id);

    res.write(`data: ${JSON.stringify({ type: 'CONNECTED', message: 'Connected to Simeli SSE Realtime Stream' })}\n\n`);
  } catch (error) {
    return res.status(401).json({ success: false, error: 'Invalid token.' });
  }
});

// GET /notifications - Get all notifications
router.get('/', auth, async (req, res) => {
  try {
    const { limit, offset, unreadOnly } = req.query;
    const options = {
      limit: limit ? parseInt(limit) : 50,
      offset: offset ? parseInt(offset) : 0,
      unreadOnly: unreadOnly === 'true'
    };

    const notifications = await Notification.findAll(options, req.user.id);
    
    res.json({
      success: true,
      data: notifications,
      count: notifications.length
    });
  } catch (error) {
    console.error('Error fetching notifications:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch notifications'
    });
  }
});

// GET /notifications/unread-count - Get unread notifications count
router.get('/unread-count', auth, async (req, res) => {
  try {
    const count = await Notification.getUnreadCount(req.user.id);
    
    res.json({
      success: true,
      data: { count }
    });
  } catch (error) {
    console.error('Error fetching unread count:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch unread count'
    });
  }
});

// PUT /notifications/:id/read - Mark notification as read
router.put('/:id/read', auth, validateUUID, async (req, res) => {
  try {
    const notification = await Notification.markAsRead(req.params.id, req.user.id);
    
    res.json({
      success: true,
      data: notification,
      message: 'Notification marked as read'
    });
  } catch (error) {
    console.error('Error marking notification as read:', error);
    
    if (error.message === 'Notification not found') {
      return res.status(404).json({
        success: false,
        error: 'Notification not found'
      });
    }
    
    res.status(500).json({
      success: false,
      error: 'Failed to mark notification as read'
    });
  }
});

// PUT /notifications/mark-all-read - Mark all notifications as read
router.put('/mark-all-read', auth, async (req, res) => {
  try {
    const count = await Notification.markAllAsRead(req.user.id);
    
    res.json({
      success: true,
      data: { count },
      message: `${count} notifications marked as read`
    });
  } catch (error) {
    console.error('Error marking all notifications as read:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to mark notifications as read'
    });
  }
});

// DELETE /notifications/:id - Delete notification
router.delete('/:id', auth, validateUUID, async (req, res) => {
  try {
    await Notification.delete(req.params.id, req.user.id);
    
    res.json({
      success: true,
      message: 'Notification deleted successfully'
    });
  } catch (error) {
    console.error('Error deleting notification:', error);
    
    if (error.message === 'Notification not found') {
      return res.status(404).json({
        success: false,
        error: 'Notification not found'
      });
    }
    
    res.status(500).json({
      success: false,
      error: 'Failed to delete notification'
    });
  }
});

// DELETE /notifications - Delete all notifications
router.delete('/', auth, async (req, res) => {
  try {
    const count = await Notification.deleteAll(req.user.id);
    
    res.json({
      success: true,
      data: { count },
      message: `${count} notifications deleted`
    });
  } catch (error) {
    console.error('Error deleting all notifications:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to delete notifications'
    });
  }
});

module.exports = router;