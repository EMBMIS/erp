-- Delivery Schedules Table
CREATE TABLE delivery_schedules (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    schedule_number VARCHAR(50) UNIQUE NOT NULL,
    
    -- Sales Order Reference
    sales_order_id UUID NOT NULL REFERENCES sales_orders(id),
    sales_order_number VARCHAR(50) NOT NULL,
    
    -- Customer Information
    customer_id UUID NOT NULL REFERENCES customers(id),
    customer_name VARCHAR(255) NOT NULL,
    
    -- Delivery Information
    delivery_date DATE NOT NULL,
    delivery_time_from TIME,
    delivery_time_to TIME,
    delivery_address TEXT NOT NULL,
    delivery_instructions TEXT,
    shipping_method VARCHAR(100),
    
    -- Contact Information
    contact_person VARCHAR(255),
    contact_phone VARCHAR(50),
    contact_email VARCHAR(255),
    
    -- Status and Progress
    status VARCHAR(50) NOT NULL DEFAULT 'SCHEDULED',
    -- SCHEDULED, IN_TRANSIT, DELIVERED, CANCELLED, FAILED
    
    priority VARCHAR(20) DEFAULT 'NORMAL',
    -- LOW, NORMAL, HIGH, URGENT
    
    -- Delivery Team
    driver_name VARCHAR(255),
    vehicle_number VARCHAR(100),
    
    -- Tracking Information
    tracking_number VARCHAR(100),
    estimated_delivery_time TIMESTAMPTZ,
    actual_delivery_time TIMESTAMPTZ,
    
    -- Delivery Confirmation
    delivered_by VARCHAR(255),
    received_by VARCHAR(255),
    delivery_signature TEXT, -- Base64 encoded signature
    delivery_photo TEXT, -- URL or base64 encoded photo
    
    -- Additional Information
    notes TEXT,
    internal_notes TEXT,
    special_instructions TEXT,
    
    -- Audit Fields
    created_by UUID NOT NULL REFERENCES users(id),
    updated_by UUID REFERENCES users(id),
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    deleted_at TIMESTAMPTZ -- Soft delete
);

-- Delivery Items Table
CREATE TABLE delivery_items (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    delivery_schedule_id UUID NOT NULL REFERENCES delivery_schedules(id) ON DELETE CASCADE,
    
    -- Item Information
    sales_order_item_id UUID, -- Reference to original sales order item
    item_code VARCHAR(100),
    item_name VARCHAR(255) NOT NULL,
    item_description TEXT,
    
    -- Quantity Information
    ordered_quantity DECIMAL(15,3) NOT NULL,
    delivered_quantity DECIMAL(15,3) DEFAULT 0,
    remaining_quantity DECIMAL(15,3) NOT NULL,
    unit_of_measure VARCHAR(20) NOT NULL,
    
    -- Packaging Information
    package_type VARCHAR(100), -- Box, Pallet, Container, etc.
    package_count INTEGER DEFAULT 1,
    weight_kg DECIMAL(10,3),
    dimensions_cm VARCHAR(100), -- LxWxH format
    
    -- Status
    status VARCHAR(50) NOT NULL DEFAULT 'PENDING',
    -- PENDING, PACKED, LOADED, DELIVERED, DAMAGED, MISSING
    
    -- Additional Information
    notes TEXT,
    
    -- Audit Fields
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

-- Delivery Status History Table
CREATE TABLE delivery_status_history (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    delivery_schedule_id UUID NOT NULL REFERENCES delivery_schedules(id) ON DELETE CASCADE,
    
    from_status VARCHAR(50),
    to_status VARCHAR(50) NOT NULL,
    status_date TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    
    location VARCHAR(255), -- Current location when status changed
    latitude DECIMAL(10, 8), -- GPS coordinates
    longitude DECIMAL(11, 8),
    
    changed_by UUID NOT NULL REFERENCES users(id),
    reason TEXT,
    notes TEXT,
    
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

-- Delivery Routes Table (for route optimization)
CREATE TABLE delivery_routes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    route_number VARCHAR(50) UNIQUE NOT NULL,
    route_name VARCHAR(255),
    
    -- Route Information
    route_date DATE NOT NULL,
    start_location TEXT,
    end_location TEXT,
    estimated_distance_km DECIMAL(8,2),
    estimated_duration_minutes INTEGER,
    
    -- Driver and Vehicle
    driver_name VARCHAR(255),
    driver_phone VARCHAR(50),
    vehicle_number VARCHAR(100),
    vehicle_type VARCHAR(100),
    
    -- Status
    status VARCHAR(50) NOT NULL DEFAULT 'PLANNED',
    -- PLANNED, IN_PROGRESS, COMPLETED, CANCELLED
    
    started_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ,
    
    -- Additional Information
    notes TEXT,
    
    -- Audit Fields
    created_by UUID NOT NULL REFERENCES users(id),
    updated_by UUID REFERENCES users(id),
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

-- Delivery Route Stops Table
CREATE TABLE delivery_route_stops (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    delivery_route_id UUID NOT NULL REFERENCES delivery_routes(id) ON DELETE CASCADE,
    delivery_schedule_id UUID NOT NULL REFERENCES delivery_schedules(id),
    
    stop_order INTEGER NOT NULL, -- Order of stops in the route
    estimated_arrival_time TIMESTAMPTZ,
    actual_arrival_time TIMESTAMPTZ,
    estimated_departure_time TIMESTAMPTZ,
    actual_departure_time TIMESTAMPTZ,
    
    -- Status
    status VARCHAR(50) NOT NULL DEFAULT 'PENDING',
    -- PENDING, ARRIVED, COMPLETED, SKIPPED
    
    notes TEXT,
    
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

-- Delivery Exceptions Table (for tracking issues)
CREATE TABLE delivery_exceptions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    delivery_schedule_id UUID NOT NULL REFERENCES delivery_schedules(id),
    
    exception_type VARCHAR(100) NOT NULL,
    -- DAMAGED_GOODS, WRONG_ADDRESS, CUSTOMER_UNAVAILABLE, VEHICLE_BREAKDOWN, WEATHER, TRAFFIC, OTHER
    
    exception_date TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    description TEXT NOT NULL,
    resolution TEXT,
    
    -- Impact
    delay_minutes INTEGER,
    additional_cost DECIMAL(15,2),
    
    -- Status
    status VARCHAR(50) NOT NULL DEFAULT 'OPEN',
    -- OPEN, IN_PROGRESS, RESOLVED, CLOSED
    
    resolved_at TIMESTAMPTZ,
    resolved_by UUID REFERENCES users(id),
    
    -- Additional Information
    photos TEXT[], -- Array of photo URLs
    documents TEXT[], -- Array of document URLs
    
    -- Audit Fields
    created_by UUID NOT NULL REFERENCES users(id),
    updated_by UUID REFERENCES users(id),
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

-- Indexes for Performance
CREATE INDEX idx_delivery_schedules_sales_order ON delivery_schedules(sales_order_id);
CREATE INDEX idx_delivery_schedules_customer ON delivery_schedules(customer_id);
CREATE INDEX idx_delivery_schedules_status ON delivery_schedules(status);
CREATE INDEX idx_delivery_schedules_date ON delivery_schedules(delivery_date);
CREATE INDEX idx_delivery_schedules_schedule_number ON delivery_schedules(schedule_number);
CREATE INDEX idx_delivery_schedules_tracking ON delivery_schedules(tracking_number);
CREATE INDEX idx_delivery_schedules_created_by ON delivery_schedules(created_by);
CREATE INDEX idx_delivery_schedules_deleted_at ON delivery_schedules(deleted_at);

CREATE INDEX idx_delivery_items_schedule ON delivery_items(delivery_schedule_id);
CREATE INDEX idx_delivery_items_sales_order_item ON delivery_items(sales_order_item_id);
CREATE INDEX idx_delivery_items_status ON delivery_items(status);

CREATE INDEX idx_delivery_status_history_schedule ON delivery_status_history(delivery_schedule_id);
CREATE INDEX idx_delivery_status_history_date ON delivery_status_history(status_date);

CREATE INDEX idx_delivery_routes_date ON delivery_routes(route_date);
CREATE INDEX idx_delivery_routes_status ON delivery_routes(status);
CREATE INDEX idx_delivery_routes_driver ON delivery_routes(driver_name);

CREATE INDEX idx_delivery_route_stops_route ON delivery_route_stops(delivery_route_id);
CREATE INDEX idx_delivery_route_stops_schedule ON delivery_route_stops(delivery_schedule_id);
CREATE INDEX idx_delivery_route_stops_order ON delivery_route_stops(delivery_route_id, stop_order);

CREATE INDEX idx_delivery_exceptions_schedule ON delivery_exceptions(delivery_schedule_id);
CREATE INDEX idx_delivery_exceptions_type ON delivery_exceptions(exception_type);
CREATE INDEX idx_delivery_exceptions_status ON delivery_exceptions(status);
CREATE INDEX idx_delivery_exceptions_date ON delivery_exceptions(exception_date);

-- Add constraints
ALTER TABLE delivery_items ADD CONSTRAINT chk_delivery_ordered_qty_positive CHECK (ordered_quantity > 0);
ALTER TABLE delivery_items ADD CONSTRAINT chk_delivery_delivered_qty_positive CHECK (delivered_quantity >= 0);
ALTER TABLE delivery_items ADD CONSTRAINT chk_delivery_remaining_qty_positive CHECK (remaining_quantity >= 0);
ALTER TABLE delivery_route_stops ADD CONSTRAINT chk_delivery_stop_order_positive CHECK (stop_order > 0);
ALTER TABLE delivery_route_stops ADD CONSTRAINT unique_delivery_route_stop_order UNIQUE (delivery_route_id, stop_order);

-- Comments for documentation
COMMENT ON TABLE delivery_schedules IS 'Scheduled deliveries for sales orders with tracking and status management';
COMMENT ON TABLE delivery_items IS 'Individual items within each delivery schedule';
COMMENT ON TABLE delivery_status_history IS 'Audit trail for delivery status changes with location tracking';
COMMENT ON TABLE delivery_routes IS 'Optimized delivery routes grouping multiple deliveries';
COMMENT ON TABLE delivery_route_stops IS 'Individual stops within delivery routes';
COMMENT ON TABLE delivery_exceptions IS 'Tracking of delivery issues and exceptions';

-- Trigger to update updated_at timestamp
CREATE TRIGGER delivery_schedules_updated_at
    BEFORE UPDATE ON delivery_schedules
    FOR EACH ROW
    EXECUTE FUNCTION update_sales_order_timestamp();

CREATE TRIGGER delivery_items_updated_at
    BEFORE UPDATE ON delivery_items
    FOR EACH ROW
    EXECUTE FUNCTION update_sales_order_timestamp();

CREATE TRIGGER delivery_routes_updated_at
    BEFORE UPDATE ON delivery_routes
    FOR EACH ROW
    EXECUTE FUNCTION update_sales_order_timestamp();

CREATE TRIGGER delivery_route_stops_updated_at
    BEFORE UPDATE ON delivery_route_stops
    FOR EACH ROW
    EXECUTE FUNCTION update_sales_order_timestamp();

CREATE TRIGGER delivery_exceptions_updated_at
    BEFORE UPDATE ON delivery_exceptions
    FOR EACH ROW
    EXECUTE FUNCTION update_sales_order_timestamp();