-- =====================================================
-- Create UREA Product
-- Migration: 20250130_create_urea_product
-- Description: Insert UREA product into diesel_products table
-- =====================================================

-- Insert UREA product
-- Product code: 07UR01 (following the pattern 07DS01 for diesel)
INSERT INTO diesel_products (product_code, name, product_type, unit_of_measure)
VALUES ('07UR01', 'UREA', 'urea', 'liters')
ON CONFLICT (product_code) DO UPDATE
SET 
  name = EXCLUDED.name,
  product_type = EXCLUDED.product_type,
  unit_of_measure = EXCLUDED.unit_of_measure,
  updated_at = NOW();

-- Add comment
COMMENT ON TABLE diesel_products IS 'Products table for fuel inventory management. Supports diesel and urea products with complete separation via product_type.';

