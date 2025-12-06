-- =====================================================
-- Migration: Add Maintenance Intervals to All Equipment Models
-- Project: mantenimiento-diace
-- Date: 2024-11-24
-- Description: Comprehensive maintenance intervals for all equipment types
-- =====================================================

BEGIN;

-- =====================================================
-- SECTION 1: Generator/Motor Equipment Intervals
-- Model: 2979ee1b-0083-4bdc-b56f-3a7a967592d7
-- =====================================================

INSERT INTO maintenance_intervals (
    id, model_id, interval_value, name, description, type, 
    estimated_duration, cycle_defining_interval, is_recurring, 
    is_first_cycle_only, maintenance_category, created_at, updated_at
) VALUES
('c2b70f49-3344-4409-b655-4c1185684747', '2979ee1b-0083-4bdc-b56f-3a7a967592d7', 100, 'Mantenimiento 100 Horas - Asentamiento', '100 Horas - Aceite de motor', 'Preventivo', 4, NULL, true, true, 'standard', NOW(), NOW()),
('504e757a-61fe-4153-8828-f73846b34fca', '2979ee1b-0083-4bdc-b56f-3a7a967592d7', 300, 'Mantenimiento 300 Horas - Purificación de Aire', '300 Horas - Mantenimiento general', 'Preventivo', 20.5, NULL, true, false, 'standard', NOW(), NOW()),
('a9f44c76-10ab-4933-b3fa-262e204e46b9', '2979ee1b-0083-4bdc-b56f-3a7a967592d7', 600, 'Mantenimiento 600 Horas - Sistema Combustible', '600 Horas - Sistema de combustible', 'Preventivo', 0, NULL, true, false, 'standard', NOW(), NOW()),
('9197cb8c-b7d5-46b0-b6dd-4ecf69753137', '2979ee1b-0083-4bdc-b56f-3a7a967592d7', 900, 'Mantenimiento 900 Horas', '900 Horas - Aceite de motor', 'Preventivo', 0, NULL, true, false, 'standard', NOW(), NOW()),
('2c27e8ea-a84c-431d-9578-06e92c65b8cd', '2979ee1b-0083-4bdc-b56f-3a7a967592d7', 1200, 'Mantenimiento 1200 Horas', '1200 Horas - Aceite de motor', 'Preventivo', 0, NULL, true, false, 'standard', NOW(), NOW()),
('babc0d5c-1439-4655-9fab-41b75de1750f', '2979ee1b-0083-4bdc-b56f-3a7a967592d7', 1500, 'Mantenimiento 1500 Horas', '1500 Horas - Aceite de motor', 'Preventivo', 0, NULL, true, false, 'standard', NOW(), NOW()),
('9a70a424-e705-49c4-a825-e6c9c66acc75', '2979ee1b-0083-4bdc-b56f-3a7a967592d7', 1800, 'Mantenimiento 1800 Horas', '1800 Horas - Aceite de motor', 'Preventivo', 0, NULL, true, false, 'standard', NOW(), NOW()),
('5d096ea4-600f-43d1-9057-53d999c01eb6', '2979ee1b-0083-4bdc-b56f-3a7a967592d7', 2100, 'Mantenimiento 2100 Horas - Purificación de Aire', '2100 Horas - Mantenimiento general', 'Preventivo', 0, NULL, true, false, 'standard', NOW(), NOW()),
('e86e6cdb-0c05-4e40-bfe4-6899847385cf', '2979ee1b-0083-4bdc-b56f-3a7a967592d7', 2400, 'Mantenimiento 2400 Horas - Sistema Combustible', '2400 Horas - Sistema de combustible', 'Preventivo', 0, NULL, true, false, 'standard', NOW(), NOW()),
('9a3028ca-066c-4043-9afa-2fa2dd536172', '2979ee1b-0083-4bdc-b56f-3a7a967592d7', 2700, 'Mantenimiento 2700 Horas - Motor', '2700 Horas - Aceite de motor', 'Preventivo', 0, NULL, true, false, 'standard', NOW(), NOW()),
('ecf6af53-e096-4717-89d9-6e745f66c278', '2979ee1b-0083-4bdc-b56f-3a7a967592d7', 3000, 'Mantenimiento 3000 Horas - Sistema Combustible', '3000 Horas - Sistema de combustible', 'Preventivo', 0, NULL, true, false, 'standard', NOW(), NOW()),
('703fdd30-494c-4605-9294-2bffa20c1a83', '2979ee1b-0083-4bdc-b56f-3a7a967592d7', 3300, 'Mantenimiento 3300 Horas - Purificación de Aire', '3300 Horas - Mantenimiento general', 'Preventivo', 0, NULL, true, false, 'standard', NOW(), NOW()),
('f37916a3-bac0-43ba-ae1c-3dea38126ee8', '2979ee1b-0083-4bdc-b56f-3a7a967592d7', 3600, 'Mantenimiento 3600 Horas - Aceite Motor', '3600 Horas - Aceite de motor', 'Preventivo', 0, NULL, true, false, 'standard', NOW(), NOW())
ON CONFLICT (id) DO NOTHING;