-- Migration: Add volume and mass fields to items, create warehouse tables
-- Add volume and mass fields needed for warehouse capacity management

-- Add volume and mass columns to items table
ALTER TABLE items 
ADD COLUMN IF NOT EXISTS volume DECIMAL(10,3),
ADD COLUMN IF NOT EXISTS mass DECIMAL(10,3);

-- Create indexes for items volume and mass
CREATE INDEX IF NOT EXISTS idx_items_volume ON items(volume);
CREATE INDEX IF NOT EXISTS idx_items_mass ON items(mass);

-- Create storage_locations table
CREATE TABLE IF NOT EXISTS storage_locations (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    code VARCHAR(10) UNIQUE NOT NULL,
    name VARCHAR(255) NOT NULL,
    country VARCHAR(100) NOT NULL,
    city VARCHAR(100) NOT NULL,
    address TEXT NOT NULL,
    postal_code VARCHAR(20) NOT NULL,
    description TEXT,
    is_active BOOLEAN DEFAULT TRUE,
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Create indexes for storage_locations
CREATE INDEX IF NOT EXISTS idx_storage_locations_code ON storage_locations(code);
CREATE INDEX IF NOT EXISTS idx_storage_locations_country ON storage_locations(country);
CREATE INDEX IF NOT EXISTS idx_storage_locations_city ON storage_locations(city);
CREATE INDEX IF NOT EXISTS idx_storage_locations_user_id ON storage_locations(user_id);
CREATE INDEX IF NOT EXISTS idx_storage_locations_is_active ON storage_locations(is_active);

-- Create bins table
CREATE TABLE IF NOT EXISTS bins (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    code VARCHAR(8) UNIQUE NOT NULL,
    description VARCHAR(255) NOT NULL,
    max_weight_capacity DECIMAL(10,3) NOT NULL,
    max_volume_capacity DECIMAL(10,3) NOT NULL,
    current_weight DECIMAL(10,3) DEFAULT 0,
    current_volume DECIMAL(10,3) DEFAULT 0,
    storage_location_id UUID REFERENCES storage_locations(id) ON DELETE CASCADE,
    is_active BOOLEAN DEFAULT TRUE,
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Create indexes for bins
CREATE INDEX IF NOT EXISTS idx_bins_code ON bins(code);
CREATE INDEX IF NOT EXISTS idx_bins_storage_location_id ON bins(storage_location_id);
CREATE INDEX IF NOT EXISTS idx_bins_user_id ON bins(user_id);
CREATE INDEX IF NOT EXISTS idx_bins_is_active ON bins(is_active);
CREATE INDEX IF NOT EXISTS idx_bins_capacity_weight ON bins(max_weight_capacity);
CREATE INDEX IF NOT EXISTS idx_bins_capacity_volume ON bins(max_volume_capacity);

-- Create triggers (PostgreSQL doesn't support IF NOT EXISTS for triggers)
DROP TRIGGER IF EXISTS update_storage_locations_updated_at ON storage_locations;
CREATE TRIGGER update_storage_locations_updated_at 
    BEFORE UPDATE ON storage_locations
    FOR EACH ROW 
    EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS update_bins_updated_at ON bins;
CREATE TRIGGER update_bins_updated_at 
    BEFORE UPDATE ON bins
    FOR EACH ROW 
    EXECUTE FUNCTION update_updated_at_column();

-- Add validation constraints (remove IF NOT EXISTS for older PostgreSQL compatibility)
DO $$
BEGIN
    -- Add validation constraint for bin code format (8 digits)
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'bins_code_format_check') THEN
        ALTER TABLE bins ADD CONSTRAINT bins_code_format_check CHECK (code ~ '^[0-9]{8}$');
    END IF;

    -- Add validation constraint for positive capacities
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'bins_positive_weight_capacity_check') THEN
        ALTER TABLE bins ADD CONSTRAINT bins_positive_weight_capacity_check CHECK (max_weight_capacity > 0);
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'bins_positive_volume_capacity_check') THEN
        ALTER TABLE bins ADD CONSTRAINT bins_positive_volume_capacity_check CHECK (max_volume_capacity > 0);
    END IF;

    -- Add validation constraint for current usage not exceeding max capacity
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'bins_current_weight_within_limit_check') THEN
        ALTER TABLE bins ADD CONSTRAINT bins_current_weight_within_limit_check CHECK (current_weight >= 0 AND current_weight <= max_weight_capacity);
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'bins_current_volume_within_limit_check') THEN
        ALTER TABLE bins ADD CONSTRAINT bins_current_volume_within_limit_check CHECK (current_volume >= 0 AND current_volume <= max_volume_capacity);
    END IF;

    -- Add validation constraint for positive item volume and mass
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'items_positive_volume_check') THEN
        ALTER TABLE items ADD CONSTRAINT items_positive_volume_check CHECK (volume IS NULL OR volume > 0);
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'items_positive_mass_check') THEN
        ALTER TABLE items ADD CONSTRAINT items_positive_mass_check CHECK (mass IS NULL OR mass > 0);
    END IF;
END $$;

-- Add comments
COMMENT ON COLUMN items.volume IS 'Item volume in cubic meters (m³) for warehouse capacity calculation';
COMMENT ON COLUMN items.mass IS 'Item mass in kilograms (kg) for warehouse capacity calculation';

COMMENT ON TABLE storage_locations IS 'Geographic storage locations with full address details';
COMMENT ON COLUMN storage_locations.code IS 'Unique short code, typically city-based (e.g., BRG, LON)';
COMMENT ON COLUMN storage_locations.name IS 'Full name of the storage location';
COMMENT ON COLUMN storage_locations.country IS 'Country where the storage location is situated';
COMMENT ON COLUMN storage_locations.city IS 'City where the storage location is situated';
COMMENT ON COLUMN storage_locations.address IS 'Full street address of the storage location';
COMMENT ON COLUMN storage_locations.postal_code IS 'Postal or ZIP code';
COMMENT ON COLUMN storage_locations.description IS 'Additional notes or details about the location';

COMMENT ON TABLE bins IS 'Smallest physical storage units within storage locations with capacity constraints';
COMMENT ON COLUMN bins.code IS 'Unique 8-digit bin code in format WWRRSSBB (Warehouse, Row, Shelf, Bin)';
COMMENT ON COLUMN bins.description IS 'Human-readable description of the bin location';
COMMENT ON COLUMN bins.max_weight_capacity IS 'Maximum weight the bin can hold in kilograms (kg)';
COMMENT ON COLUMN bins.max_volume_capacity IS 'Maximum volume the bin can hold in cubic meters (m³)';
COMMENT ON COLUMN bins.current_weight IS 'Current weight utilization in kilograms (kg)';
COMMENT ON COLUMN bins.current_volume IS 'Current volume utilization in cubic meters (m³)';