const { pool } = require('../config/database');

// Lightweight middleware optimized for Render's basic plan
const dbHealthCheck = async (req, res, next) => {
  try {
    // Skip health check for non-critical requests to save connections
    if (req.path.includes('/stats') || req.path.includes('/health')) {
      return next();
    }
    
    // Quick connectivity check only if pool is stressed
    if (pool.waitingCount > 0) {
      const start = Date.now();
      await pool.query('SELECT 1');
      const duration = Date.now() - start;
      
      if (duration > 5000) {
        console.warn(`⚠️ Database stress detected: ${duration}ms for ${req.method} ${req.path}`);
      }
    }
    
    next();
  } catch (error) {
    console.error(`🔴 Database connectivity failed for ${req.method} ${req.path}:`, error.message);
    
    res.status(503).json({
      success: false,
      error: 'Database connection issue. Please retry in a moment.',
      details: process.env.NODE_ENV === 'development' ? error.message : undefined,
      timestamp: new Date().toISOString()
    });
  }
};

// Optimized pool monitoring for Render's basic plan
const logPoolStatus = (req, res, next) => {
  // Only log concerning pool states to reduce overhead
  if (pool.waitingCount > 0) {
    console.warn(`⚠️ Database pool stressed: ${pool.waitingCount} waiting, ${pool.idleCount} idle of ${pool.totalCount} total`);
  }
  
  // Critical warning for Render's connection limits
  if (pool.totalCount >= 3 && pool.idleCount === 0) {
    console.warn('🚨 All database connections busy - consider request queuing');
  }
  
  // Add essential pool info for debugging
  if (process.env.NODE_ENV === 'development') {
    res.setHeader('X-DB-Pool-Status', `${pool.totalCount}/${pool.options.max}`);
    res.setHeader('X-DB-Pool-Waiting', pool.waitingCount);
  }
  
  next();
};

module.exports = {
  dbHealthCheck,
  logPoolStatus
};