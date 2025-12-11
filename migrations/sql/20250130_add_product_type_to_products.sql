-- =====================================================
-- Add Product Type to diesel_products Table
-- Migration: 20250130_add_product_type_to_products
-- Description: Add product_type column to differentiate diesel and urea products
-- =====================================================

-- Add product_type column to diesel_products
ALTER TABLE diesel_products 
ADD COLUMN IF NOT EXISTS product_type TEXT NOT NULL DEFAULT 'diesel'
  CHECK (product_type IN ('diesel', 'urea'));

-- Create index for filtering by product type
CREATE INDEX IF NOT EXISTS idx_diesel_products_type ON diesel_products(product_type);

-- Update existing diesel product to ensure it has product_type = 'diesel'
UPDATE diesel_products 
SET product_type = 'diesel' 
WHERE product_type IS NULL OR product_type = '';

-- Add comment
COMMENT ON COLUMN diesel_products.product_type IS 'Product type: diesel or urea. Used to separate diesel and urea inventory management.';

