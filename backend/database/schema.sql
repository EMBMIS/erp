-- Simeli ERP Inventory Database Schema
-- PostgreSQL Database Schema for Items Management

-- Create database (run this separately)
-- CREATE DATABASE qira_erp;

-- Use the database
-- \c qira_erp;

-- Create extension for UUID generation
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Items table (Master data for all items)
CREATE TABLE items (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    item_code VARCHAR(50) UNIQUE NOT NULL,
    name VARCHAR(255) NOT NULL,
    description TEXT,
    is_stock_item BOOLEAN NOT NULL DEFAULT TRUE,
    planned_stock BOOLEAN NOT NULL DEFAULT FALSE,
    stock_code VARCHAR(3) NOT NULL DEFAULT 'ST1' CHECK (stock_code IN ('ST1', 'ST2', 'NS3')),
    status VARCHAR(20) NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT', 'PENDING_REVIEW', 'APPROVED')),
    criticality VARCHAR(10) NOT NULL DEFAULT 'LOW' CHECK (criticality IN ('LOW', 'MEDIUM', 'HIGH')),
    unit_of_measure VARCHAR(20) NOT NULL DEFAULT 'pcs',
    unspsc_code VARCHAR(8),
    manufacturer VARCHAR(255),
    manufacturer_part_number VARCHAR(100),
    item_category VARCHAR(100),
    serial_number VARCHAR(100),
    equipment_tag VARCHAR(50),
    has_contract BOOLEAN DEFAULT FALSE,
    contract_number VARCHAR(50),
    has_barcode BOOLEAN DEFAULT FALSE,
    barcode VARCHAR(100),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Create indexes for better performance
CREATE INDEX idx_items_item_code ON items(item_code);
CREATE INDEX idx_items_status ON items(status);
CREATE INDEX idx_items_is_stock_item ON items(is_stock_item);
CREATE INDEX idx_items_planned_stock ON items(planned_stock);
CREATE INDEX idx_items_stock_code ON items(stock_code);
CREATE INDEX idx_items_criticality ON items(criticality);
CREATE INDEX idx_items_unspsc_code ON items(unspsc_code);
CREATE INDEX idx_items_manufacturer ON items(manufacturer);
CREATE INDEX idx_items_manufacturer_part_number ON items(manufacturer_part_number);
CREATE INDEX idx_items_item_category ON items(item_category);
CREATE INDEX idx_items_serial_number ON items(serial_number);
CREATE INDEX idx_items_equipment_tag ON items(equipment_tag);
CREATE INDEX idx_items_contract_number ON items(contract_number);
CREATE INDEX idx_items_barcode ON items(barcode);

-- Create function to update updated_at timestamp
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ language 'plpgsql';

-- Create trigger to auto-update updated_at
CREATE TRIGGER update_items_updated_at 
    BEFORE UPDATE ON items
    FOR EACH ROW 
    EXECUTE FUNCTION update_updated_at_column();

-- Insert sample data
INSERT INTO items (item_code, name, description, is_stock_item, planned_stock, stock_code, status, criticality, unit_of_measure, unspsc_code, manufacturer, manufacturer_part_number, item_category, serial_number, equipment_tag, has_contract, contract_number, has_barcode, barcode) VALUES
('TEMP-20250107-001', 'Bolt M10 x 20mm', 'Steel bolt for machine mounting', TRUE, FALSE, 'ST1', 'DRAFT', 'MEDIUM', 'pcs', '31161501', 'Acme Fasteners', 'AF-M10-20-SS', 'Fasteners', 'BLT-001-2025', 'EQ-MOUNT-01', FALSE, NULL, TRUE, '1234567890123'),
('TEMP-20250107-002', 'Steel Plate 10x20cm', 'Standard steel plate for construction', TRUE, TRUE, 'ST2', 'PENDING_REVIEW', 'HIGH', 'pcs', '30102505', 'Steel Works Inc', 'SW-PLT-1020', 'Raw Materials', 'PLT-002-2025', NULL, TRUE, 'CTR-2024-001', FALSE, NULL),
('TEMP-20250107-003', 'Maintenance Service', 'General maintenance service', FALSE, FALSE, 'NS3', 'APPROVED', 'LOW', 'hrs', '72141501', 'Service Corp', 'SVC-MAINT-001', 'Services', NULL, NULL, TRUE, 'CTR-2024-SVC', FALSE, NULL),
('TEMP-20250107-004', 'Bearing 6203', 'Deep groove ball bearing', TRUE, TRUE, 'ST2', 'APPROVED', 'HIGH', 'pcs', '31171501', 'SKF', '6203-2Z', 'Bearings', 'BRG-003-2025', 'EQ-MOTOR-02', FALSE, NULL, TRUE, '9876543210987'),
('TEMP-20250107-005', 'Lubricant Oil SAE 30', 'Motor oil for machinery', TRUE, FALSE, 'ST1', 'APPROVED', 'MEDIUM', 'liters', '15121801', 'Mobil', 'MOB-SAE30-5L', 'Lubricants', 'OIL-004-2025', NULL, FALSE, NULL, TRUE, '5555666677778');