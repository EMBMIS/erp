-- Add sourcing fields to sales_quotation_items table
-- Migration: 041_add_sourcing_fields_to_quotation_items

-- Add sourcing type and reference fields
ALTER TABLE sales_quotation_items 
ADD COLUMN IF NOT EXISTS sourcing_type VARCHAR(20) DEFAULT 'STOCK' CHECK (sourcing_type IN ('STOCK', 'SUPPLIER')),
ADD COLUMN IF NOT EXISTS source_bin_id UUID REFERENCES bins(id),
ADD COLUMN IF NOT EXISTS linked_sales_rfq_id INTEGER REFERENCES sales_rfqs(id),
ADD COLUMN IF NOT EXISTS supplier_id UUID REFERENCES suppliers(id),
ADD COLUMN IF NOT EXISTS supplier_name VARCHAR(255),
ADD COLUMN IF NOT EXISTS estimated_supplier_cost DECIMAL(12,2),
ADD COLUMN IF NOT EXISTS margin_percentage DECIMAL(5,2),
ADD COLUMN IF NOT EXISTS margin_amount DECIMAL(12,2);

-- Create indexes for better performance
CREATE INDEX IF NOT EXISTS idx_sales_quotation_items_sourcing_type ON sales_quotation_items(sourcing_type);
CREATE INDEX IF NOT EXISTS idx_sales_quotation_items_source_bin_id ON sales_quotation_items(source_bin_id) WHERE source_bin_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_sales_quotation_items_linked_sales_rfq_id ON sales_quotation_items(linked_sales_rfq_id) WHERE linked_sales_rfq_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_sales_quotation_items_supplier_id ON sales_quotation_items(supplier_id) WHERE supplier_id IS NOT NULL;

-- Add comments
COMMENT ON COLUMN sales_quotation_items.sourcing_type IS 'Whether item is sourced from stock or supplier';
COMMENT ON COLUMN sales_quotation_items.source_bin_id IS 'Bin ID when sourcing from stock';
COMMENT ON COLUMN sales_quotation_items.linked_sales_rfq_id IS 'Reference to sales RFQ when sourcing from supplier';
COMMENT ON COLUMN sales_quotation_items.supplier_id IS 'Supplier ID when sourcing from supplier';
COMMENT ON COLUMN sales_quotation_items.supplier_name IS 'Supplier name for display';
COMMENT ON COLUMN sales_quotation_items.estimated_supplier_cost IS 'Expected cost from supplier';
COMMENT ON COLUMN sales_quotation_items.margin_percentage IS 'Profit margin percentage';
COMMENT ON COLUMN sales_quotation_items.margin_amount IS 'Profit margin amount';