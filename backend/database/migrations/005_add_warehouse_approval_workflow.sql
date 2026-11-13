-- Migration: Add approval workflow to warehouse tables
-- Add status and approval fields to storage_locations and bins tables

-- Add approval workflow columns to storage_locations table
ALTER TABLE storage_locations 
ADD COLUMN IF NOT EXISTS status VARCHAR(20) DEFAULT 'DRAFT',
ADD COLUMN IF NOT EXISTS decline_reason TEXT,
ADD COLUMN IF NOT EXISTS approved_by UUID REFERENCES users(id),
ADD COLUMN IF NOT EXISTS approved_at TIMESTAMP WITH TIME ZONE,
ADD COLUMN IF NOT EXISTS declined_by UUID REFERENCES users(id),
ADD COLUMN IF NOT EXISTS declined_at TIMESTAMP WITH TIME ZONE;

-- Add approval workflow columns to bins table  
ALTER TABLE bins
ADD COLUMN IF NOT EXISTS status VARCHAR(20) DEFAULT 'DRAFT',
ADD COLUMN IF NOT EXISTS decline_reason TEXT,
ADD COLUMN IF NOT EXISTS approved_by UUID REFERENCES users(id),
ADD COLUMN IF NOT EXISTS approved_at TIMESTAMP WITH TIME ZONE,
ADD COLUMN IF NOT EXISTS declined_by UUID REFERENCES users(id),
ADD COLUMN IF NOT EXISTS declined_at TIMESTAMP WITH TIME ZONE;

-- Create indexes for performance
CREATE INDEX IF NOT EXISTS idx_storage_locations_status ON storage_locations(status);
CREATE INDEX IF NOT EXISTS idx_storage_locations_approved_by ON storage_locations(approved_by);
CREATE INDEX IF NOT EXISTS idx_bins_status ON bins(status);
CREATE INDEX IF NOT EXISTS idx_bins_approved_by ON bins(approved_by);
CREATE INDEX IF NOT EXISTS idx_bins_storage_location_status ON bins(storage_location_id, status);

-- Update existing records to have ACTIVE status (they were created before approval workflow)
UPDATE storage_locations SET status = 'ACTIVE', is_active = true WHERE status = 'DRAFT';
UPDATE bins SET status = 'ACTIVE', is_active = true WHERE status = 'DRAFT';

-- Add validation constraints
DO $$
BEGIN
    -- Add validation constraint for storage location status
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'storage_locations_status_check') THEN
        ALTER TABLE storage_locations ADD CONSTRAINT storage_locations_status_check 
        CHECK (status IN ('DRAFT', 'PENDING_APPROVAL', 'ACTIVE', 'DECLINED'));
    END IF;

    -- Add validation constraint for bin status
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'bins_status_check') THEN
        ALTER TABLE bins ADD CONSTRAINT bins_status_check 
        CHECK (status IN ('DRAFT', 'PENDING_APPROVAL', 'ACTIVE', 'DECLINED'));
    END IF;
END $$;

-- Add comments for documentation
COMMENT ON COLUMN storage_locations.status IS 'Approval status: DRAFT, PENDING_APPROVAL, ACTIVE, DECLINED';
COMMENT ON COLUMN storage_locations.decline_reason IS 'Reason for declining the storage location request';
COMMENT ON COLUMN storage_locations.approved_by IS 'User ID who approved this storage location';
COMMENT ON COLUMN storage_locations.approved_at IS 'Timestamp when storage location was approved';
COMMENT ON COLUMN storage_locations.declined_by IS 'User ID who declined this storage location';
COMMENT ON COLUMN storage_locations.declined_at IS 'Timestamp when storage location was declined';

COMMENT ON COLUMN bins.status IS 'Approval status: DRAFT, PENDING_APPROVAL, ACTIVE, DECLINED';
COMMENT ON COLUMN bins.decline_reason IS 'Reason for declining the bin request';
COMMENT ON COLUMN bins.approved_by IS 'User ID who approved this bin';
COMMENT ON COLUMN bins.approved_at IS 'Timestamp when bin was approved';
COMMENT ON COLUMN bins.declined_by IS 'User ID who declined this bin';
COMMENT ON COLUMN bins.declined_at IS 'Timestamp when bin was declined';