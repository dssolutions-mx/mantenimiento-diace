-- Migration: Add required_tasks column to work_orders table
-- Date: 2025-01-16
-- Description: Adds required_tasks JSONB column to store maintenance plan tasks when creating work orders

-- Check if column exists, if not add it
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 
    FROM information_schema.columns 
    WHERE table_schema = 'public' 
    AND table_name = 'work_orders' 
    AND column_name = 'required_tasks'
  ) THEN
    ALTER TABLE work_orders 
    ADD COLUMN required_tasks JSONB DEFAULT '[]'::jsonb;
    
    COMMENT ON COLUMN work_orders.required_tasks IS 'Array of maintenance tasks from the maintenance plan, stored as JSONB with task details including id, description, type, estimated_time, requires_specialist, and associated parts';
  END IF;
END $$;
