-- =====================================================
-- Add Product Type to diesel_warehouses Table
-- Migration: 20250130_add_product_type_to_warehouses
-- Description: Add product_type column to differentiate diesel and urea warehouses
-- =====================================================

-- Add product_type column to diesel_warehouses
ALTER TABLE diesel_warehouses 
ADD COLUMN IF NOT EXISTS product_type TEXT NOT NULL DEFAULT 'diesel'
  CHECK (product_type IN ('diesel', 'urea'));

-- Create index for filtering by product type
CREATE INDEX IF NOT EXISTS idx_diesel_warehouses_type ON diesel_warehouses(product_type);

-- Update existing warehouses to ensure they have product_type = 'diesel'
UPDATE diesel_warehouses 
SET product_type = 'diesel' 
WHERE product_type IS NULL OR product_type = '';

-- Add comment
COMMENT ON COLUMN diesel_warehouses.product_type IS 'Product type this warehouse stores: diesel or urea. Ensures complete separation between diesel and urea inventory.';

