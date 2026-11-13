-- Migration: Create users and authentication system
-- Add users table and user-based data isolation

-- Create users table
CREATE TABLE IF NOT EXISTS users (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    email VARCHAR(255) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    first_name VARCHAR(100) NOT NULL,
    last_name VARCHAR(100) NOT NULL,
    role VARCHAR(20) NOT NULL DEFAULT 'USER' CHECK (role IN ('ADMIN', 'MANAGER', 'USER')),
    is_active BOOLEAN DEFAULT TRUE,
    last_login TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Create indexes for users table
CREATE INDEX idx_users_email ON users(email);
CREATE INDEX idx_users_role ON users(role);
CREATE INDEX idx_users_is_active ON users(is_active);
CREATE INDEX idx_users_created_at ON users(created_at DESC);

-- Add user_id to items table
ALTER TABLE items 
ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES users(id) ON DELETE CASCADE;

-- Create index for items user_id
CREATE INDEX IF NOT EXISTS idx_items_user_id ON items(user_id);

-- Add user_id to notifications table
ALTER TABLE notifications 
ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES users(id) ON DELETE CASCADE;

-- Create index for notifications user_id
CREATE INDEX IF NOT EXISTS idx_notifications_user_id ON notifications(user_id);

-- Update updated_at trigger for users
CREATE TRIGGER update_users_updated_at 
    BEFORE UPDATE ON users
    FOR EACH ROW 
    EXECUTE FUNCTION update_updated_at_column();

-- Create default admin user (password: admin123)
-- Note: In production, this should be removed or use a secure password
INSERT INTO users (email, password_hash, first_name, last_name, role) 
VALUES (
    'admin@qiraerp.com',
    '$2b$10$c9rmb7nJrHbcFleGlSoOIuGomnqTSASp/hiCC.tWtu41/wcgVn8QG', -- admin123
    'Admin',
    'User',
    'ADMIN'
) ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash;

-- Add comments
COMMENT ON TABLE users IS 'System users with authentication and role-based access';
COMMENT ON COLUMN users.password_hash IS 'Bcrypt hashed password';
COMMENT ON COLUMN users.role IS 'User role: ADMIN, MANAGER, or USER';
COMMENT ON COLUMN users.is_active IS 'Whether the user account is active';
COMMENT ON COLUMN items.user_id IS 'References the user who created/owns this item';
COMMENT ON COLUMN notifications.user_id IS 'References the user who should receive this notification';