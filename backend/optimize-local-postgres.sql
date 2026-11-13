-- PostgreSQL optimization for local development with high traffic
-- Run this as superuser: psql -U postgres -f optimize-local-postgres.sql

-- Connection settings
ALTER SYSTEM SET max_connections = 100;
ALTER SYSTEM SET shared_buffers = '256MB';
ALTER SYSTEM SET effective_cache_size = '1GB';

-- Performance settings
ALTER SYSTEM SET work_mem = '8MB';
ALTER SYSTEM SET maintenance_work_mem = '128MB';
ALTER SYSTEM SET checkpoint_completion_target = 0.9;
ALTER SYSTEM SET wal_buffers = '16MB';

-- Connection pooling optimization
ALTER SYSTEM SET tcp_keepalives_idle = 300;
ALTER SYSTEM SET tcp_keepalives_interval = 30;
ALTER SYSTEM SET tcp_keepalives_count = 3;

-- Timeout settings
ALTER SYSTEM SET statement_timeout = '60s';
ALTER SYSTEM SET idle_in_transaction_session_timeout = '60s';

-- Logging for debugging (optional)
ALTER SYSTEM SET log_connections = on;
ALTER SYSTEM SET log_disconnections = on;
ALTER SYSTEM SET log_min_duration_statement = 1000; -- Log queries > 1 second

-- Apply changes
SELECT pg_reload_conf();

-- Show current settings
SELECT name, setting, unit
FROM pg_settings
WHERE name IN (
  'max_connections',
  'shared_buffers',
  'effective_cache_size',
  'work_mem',
  'maintenance_work_mem'
);

-- Note: You may need to restart PostgreSQL service for some changes to take effect