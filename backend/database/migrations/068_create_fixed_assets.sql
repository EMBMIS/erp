-- Fixed Assets register and depreciation schedule.
-- Depreciation posts Dr Depreciation Expense (5260) / Cr Accumulated
-- Depreciation (1220). Book value = acquisition cost - accumulated depreciation.

CREATE TABLE IF NOT EXISTS fixed_assets (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    asset_number VARCHAR(50) UNIQUE NOT NULL,          -- FA-YYYY-######
    name VARCHAR(255) NOT NULL,
    description TEXT,
    category VARCHAR(100),

    acquisition_date DATE NOT NULL DEFAULT CURRENT_DATE,
    acquisition_cost DECIMAL(15,2) NOT NULL,
    salvage_value DECIMAL(15,2) NOT NULL DEFAULT 0,
    useful_life_years INTEGER NOT NULL DEFAULT 5,
    depreciation_method VARCHAR(30) NOT NULL DEFAULT 'STRAIGHT_LINE',

    accumulated_depreciation DECIMAL(15,2) NOT NULL DEFAULT 0,
    book_value DECIMAL(15,2) GENERATED ALWAYS AS (acquisition_cost - accumulated_depreciation) STORED,
    last_depreciation_date DATE,

    status VARCHAR(30) NOT NULL DEFAULT 'ACTIVE',      -- ACTIVE, FULLY_DEPRECIATED, DISPOSED
    location VARCHAR(255),
    serial_number VARCHAR(100),
    supplier_id UUID REFERENCES suppliers(id),

    notes TEXT,
    created_by UUID NOT NULL REFERENCES users(id),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_by UUID REFERENCES users(id),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    deleted_at TIMESTAMP WITH TIME ZONE,
    deleted_by UUID REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS fixed_asset_depreciation (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    asset_id UUID NOT NULL REFERENCES fixed_assets(id) ON DELETE CASCADE,
    period_date DATE NOT NULL DEFAULT CURRENT_DATE,
    depreciation_amount DECIMAL(15,2) NOT NULL,
    accumulated_after DECIMAL(15,2) NOT NULL,
    journal_entry_id UUID REFERENCES journal_entries(id),
    created_by UUID NOT NULL REFERENCES users(id),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_fixed_assets_status ON fixed_assets(status);
CREATE INDEX IF NOT EXISTS idx_fixed_assets_category ON fixed_assets(category);
CREATE INDEX IF NOT EXISTS idx_fixed_assets_deleted_at ON fixed_assets(deleted_at);
CREATE INDEX IF NOT EXISTS idx_fa_depreciation_asset ON fixed_asset_depreciation(asset_id);

ALTER TABLE fixed_assets DROP CONSTRAINT IF EXISTS chk_fixed_asset_status_valid;
ALTER TABLE fixed_assets ADD CONSTRAINT chk_fixed_asset_status_valid
CHECK (status IN ('ACTIVE', 'FULLY_DEPRECIATED', 'DISPOSED'));

ALTER TABLE fixed_assets DROP CONSTRAINT IF EXISTS chk_fixed_asset_amounts;
ALTER TABLE fixed_assets ADD CONSTRAINT chk_fixed_asset_amounts
CHECK (acquisition_cost >= 0 AND salvage_value >= 0 AND useful_life_years > 0);

CREATE OR REPLACE FUNCTION generate_asset_number() RETURNS TEXT AS $$
DECLARE
    year_part TEXT;
    next_number INTEGER;
BEGIN
    year_part := EXTRACT(YEAR FROM CURRENT_DATE)::TEXT;
    SELECT COALESCE(MAX(
        CASE WHEN asset_number ~ ('^FA-' || year_part || '-[0-9]+$')
             THEN SUBSTRING(asset_number FROM ('\-([0-9]+)$'))::INTEGER ELSE 0 END
    ), 0) + 1 INTO next_number FROM fixed_assets;
    RETURN 'FA-' || year_part || '-' || LPAD(next_number::TEXT, 6, '0');
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS fixed_assets_updated_at ON fixed_assets;
CREATE TRIGGER fixed_assets_updated_at
    BEFORE UPDATE ON fixed_assets
    FOR EACH ROW EXECUTE FUNCTION update_sales_order_timestamp();

COMMENT ON TABLE fixed_assets IS 'Fixed asset register with straight-line depreciation';
COMMENT ON TABLE fixed_asset_depreciation IS 'Per-period depreciation entries posted to the GL';
