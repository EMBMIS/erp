const express = require('express');
const fs = require('fs');
const path = require('path');
const router = express.Router();
const { pool, query } = require('../config/database');
const { getProviderInfo, isAIEnabled } = require('../config/aiConfig');
const logger = require('../config/logger');

const DOCUMENTS_DIR = process.env.AI_DOCUMENTS_DIR
  ? path.resolve(process.env.AI_DOCUMENTS_DIR)
  : path.join(__dirname, '../exports/ai-documents');

// Below this, treat disk space as a health concern, not just a number to
// report -- documentStore.saveDocument() writes PDFs to this same
// filesystem, and a full disk fails that write with a much less legible
// error than "disk_ok: false" would have been.
const DISK_LOW_SPACE_BYTES = 500 * 1024 * 1024; // 500MB

/**
 * Disk space on the volume backing generated-document storage. Best-effort:
 * fs.statfs isn't available on every platform Node runs on, so a failure here
 * degrades to "unknown" rather than failing the whole health check over a
 * capability gap that has nothing to do with whether the service is healthy.
 */
async function checkDisk() {
  try {
    if (!fs.existsSync(DOCUMENTS_DIR)) fs.mkdirSync(DOCUMENTS_DIR, { recursive: true });
    const stats = await fs.promises.statfs(DOCUMENTS_DIR);
    const freeBytes = stats.bavail * stats.bsize;
    return { checked: true, free_mb: Math.round(freeBytes / 1024 / 1024), low_space: freeBytes < DISK_LOW_SPACE_BYTES };
  } catch (error) {
    return { checked: false, reason: error.message };
  }
}

// Health check endpoint
router.get('/', async (req, res) => {
  try {
    const start = Date.now();

    // Test database connection with retry logic
    const result = await query('SELECT NOW() as current_time, version() as db_version');

    const duration = Date.now() - start;

    const disk = await checkDisk();
    const mem = process.memoryUsage();

    res.json({
      success: true,
      status: disk.low_space ? 'degraded' : 'healthy',
      database: {
        connected: true,
        response_time: `${duration}ms`,
        current_time: result.rows[0].current_time,
        version: result.rows[0].db_version.split(' ')[0],
        pool_info: {
          total_count: pool.totalCount,
          idle_count: pool.idleCount,
          waiting_count: pool.waitingCount
        }
      },
      ai: {
        enabled: isAIEnabled(),
        ...getProviderInfo(),
      },
      process: {
        uptime_seconds: Math.round(process.uptime()),
        memory_mb: {
          rss: Math.round(mem.rss / 1024 / 1024),
          heap_used: Math.round(mem.heapUsed / 1024 / 1024),
          heap_total: Math.round(mem.heapTotal / 1024 / 1024),
        },
        node_version: process.version,
      },
      disk,
      environment: process.env.NODE_ENV || 'development',
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    logger.error({ err: error }, 'Health check failed');

    res.status(503).json({
      success: false,
      status: 'unhealthy',
      error: error.message,
      database: {
        connected: false
      },
      timestamp: new Date().toISOString()
    });
  }
});

// Database pool info endpoint
router.get('/db-pool', async (req, res) => {
  try {
    res.json({
      success: true,
      pool_info: {
        total_count: pool.totalCount,
        idle_count: pool.idleCount,
        waiting_count: pool.waitingCount,
        max_connections: pool.options.max,
        min_connections: pool.options.min
      },
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

module.exports = router;