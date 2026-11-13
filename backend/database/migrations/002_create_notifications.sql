-- Migration: Create notifications system
-- Add notifications table for approval/decline notifications

-- Create notifications table
CREATE TABLE IF NOT EXISTS notifications (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    type VARCHAR(50) NOT NULL CHECK (type IN ('ITEM_APPROVED', 'ITEM_DECLINED', 'GENERAL')),
    title VARCHAR(255) NOT NULL,
    message TEXT NOT NULL,
    data JSONB,
    is_read BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    read_at TIMESTAMP WITH TIME ZONE
);

-- Create indexes for better performance
CREATE INDEX idx_notifications_type ON notifications(type);
CREATE INDEX idx_notifications_is_read ON notifications(is_read);
CREATE INDEX idx_notifications_created_at ON notifications(created_at DESC);

-- Add comments
COMMENT ON TABLE notifications IS 'System notifications for approval/decline actions';
COMMENT ON COLUMN notifications.type IS 'Type of notification (ITEM_APPROVED, ITEM_DECLINED, GENERAL)';
COMMENT ON COLUMN notifications.data IS 'JSON data containing context-specific information';
COMMENT ON COLUMN notifications.is_read IS 'Whether the notification has been read';
COMMENT ON COLUMN notifications.read_at IS 'Timestamp when notification was marked as read';