-- Add READY_TO_SHIP status to delivery schedules main status field

-- First, let's check what values are currently allowed
-- According to migration 032, the main status allows: SCHEDULED, IN_TRANSIT, DELIVERED, CANCELLED, FAILED
-- We need to add READY_TO_SHIP for when goods are issued from warehouse

-- Note: There's no constraint on the main status field in delivery_schedules, 
-- so we can use READY_TO_SHIP directly without needing to update a constraint