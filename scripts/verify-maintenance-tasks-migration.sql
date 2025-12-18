-- Verification queries for maintenance tasks migration
-- Run these queries after migration to validate results

-- ============================================
-- 1. Check task counts per model
-- ============================================
-- This query shows how many tasks exist for each model after migration
SELECT 
    em.name as model_name,
    COUNT(DISTINCT mi.id) as interval_count,
    COUNT(mt.id) as task_count,
    COUNT(DISTINCT mt.type) as task_types_count
FROM equipment_models em
LEFT JOIN maintenance_intervals mi ON mi.model_id = em.id
LEFT JOIN maintenance_tasks mt ON mt.interval_id = mi.id
WHERE em.name IN (
    'T800 Water Truck',
    'INT-7600-ISM-320',
    'INT-WORKSTAR 7600-310',
    'KENWORTH-T460',
    'C7H 360HP 6X4 (AUTOMATICO)',
    'SIT-C7H-LONG CHASIS',
    'C7H 360HP 6X4 (MANUAL)',
    'CARGADOR FRONTAL 524 P',
    'CARGADOR FRONTAL 524K',
    'CARGADOR FRONTAL 524K II',
    'INT- 7600SBA 6X4',
    'INTERNATIONAL-TRACTOCAMION-LONG CHASIS',
    'BOM-PUTZMEISTER'
)
GROUP BY em.name
ORDER BY task_count DESC;

-- ============================================
-- 2. Check intervals without tasks
-- ============================================
-- This query identifies intervals that don't have any tasks
-- (might indicate missing migration data)
SELECT 
    em.name as model_name,
    mi.interval_value,
    mi.name as interval_name,
    mi.type as interval_type
FROM equipment_models em
JOIN maintenance_intervals mi ON mi.model_id = em.id
LEFT JOIN maintenance_tasks mt ON mt.interval_id = mi.id
WHERE em.name IN (
    'T800 Water Truck',
    'INT-7600-ISM-320',
    'INT-WORKSTAR 7600-310',
    'KENWORTH-T460',
    'C7H 360HP 6X4 (AUTOMATICO)',
    'SIT-C7H-LONG CHASIS',
    'C7H 360HP 6X4 (MANUAL)',
    'CARGADOR FRONTAL 524 P',
    'CARGADOR FRONTAL 524K',
    'CARGADOR FRONTAL 524K II',
    'INT- 7600SBA 6X4',
    'INTERNATIONAL-TRACTOCAMION-LONG CHASIS',
    'BOM-PUTZMEISTER'
)
AND mt.id IS NULL
ORDER BY em.name, mi.interval_value;

-- ============================================
-- 3. Task distribution by type
-- ============================================
-- Shows how tasks are distributed across different types
SELECT 
    em.name as model_name,
    mt.type as task_type,
    COUNT(mt.id) as task_count,
    AVG(mt.estimated_time) as avg_estimated_time,
    COUNT(CASE WHEN mt.requires_specialist = true THEN 1 END) as specialist_required_count
FROM equipment_models em
JOIN maintenance_intervals mi ON mi.model_id = em.id
JOIN maintenance_tasks mt ON mt.interval_id = mi.id
WHERE em.name IN (
    'T800 Water Truck',
    'INT-7600-ISM-320',
    'INT-WORKSTAR 7600-310',
    'KENWORTH-T460',
    'C7H 360HP 6X4 (AUTOMATICO)',
    'SIT-C7H-LONG CHASIS',
    'C7H 360HP 6X4 (MANUAL)',
    'CARGADOR FRONTAL 524 P',
    'CARGADOR FRONTAL 524K',
    'CARGADOR FRONTAL 524K II',
    'INT- 7600SBA 6X4',
    'INTERNATIONAL-TRACTOCAMION-LONG CHASIS',
    'BOM-PUTZMEISTER'
)
GROUP BY em.name, mt.type
ORDER BY em.name, task_count DESC;

-- ============================================
-- 4. Check for potential duplicates
-- ============================================
-- Identifies tasks that might be duplicates (same interval, description, and type)
SELECT 
    em.name as model_name,
    mi.interval_value,
    mt.description,
    mt.type,
    COUNT(mt.id) as duplicate_count,
    STRING_AGG(mt.id::text, ', ') as task_ids
FROM equipment_models em
JOIN maintenance_intervals mi ON mi.model_id = em.id
JOIN maintenance_tasks mt ON mt.interval_id = mi.id
WHERE em.name IN (
    'T800 Water Truck',
    'INT-7600-ISM-320',
    'INT-WORKSTAR 7600-310',
    'KENWORTH-T460',
    'C7H 360HP 6X4 (AUTOMATICO)',
    'SIT-C7H-LONG CHASIS',
    'C7H 360HP 6X4 (MANUAL)',
    'CARGADOR FRONTAL 524 P',
    'CARGADOR FRONTAL 524K',
    'CARGADOR FRONTAL 524K II',
    'INT- 7600SBA 6X4',
    'INTERNATIONAL-TRACTOCAMION-LONG CHASIS',
    'BOM-PUTZMEISTER'
)
GROUP BY em.name, mi.interval_value, mt.description, mt.type
HAVING COUNT(mt.id) > 1
ORDER BY duplicate_count DESC, em.name;

-- ============================================
-- 5. Tasks per interval summary
-- ============================================
-- Shows how many tasks each interval has
SELECT 
    em.name as model_name,
    mi.interval_value,
    mi.name as interval_name,
    COUNT(mt.id) as task_count,
    SUM(mt.estimated_time) as total_estimated_time,
    COUNT(CASE WHEN mt.requires_specialist = true THEN 1 END) as specialist_tasks_count
FROM equipment_models em
JOIN maintenance_intervals mi ON mi.model_id = em.id
LEFT JOIN maintenance_tasks mt ON mt.interval_id = mi.id
WHERE em.name IN (
    'T800 Water Truck',
    'INT-7600-ISM-320',
    'INT-WORKSTAR 7600-310',
    'KENWORTH-T460',
    'C7H 360HP 6X4 (AUTOMATICO)',
    'SIT-C7H-LONG CHASIS',
    'C7H 360HP 6X4 (MANUAL)',
    'CARGADOR FRONTAL 524 P',
    'CARGADOR FRONTAL 524K',
    'CARGADOR FRONTAL 524K II',
    'INT- 7600SBA 6X4',
    'INTERNATIONAL-TRACTOCAMION-LONG CHASIS',
    'BOM-PUTZMEISTER'
)
GROUP BY em.name, mi.interval_value, mi.name
ORDER BY em.name, mi.interval_value;

-- ============================================
-- 6. Overall migration summary
-- ============================================
-- High-level summary of the migration
SELECT 
    COUNT(DISTINCT em.id) as total_models,
    COUNT(DISTINCT mi.id) as total_intervals,
    COUNT(mt.id) as total_tasks,
    COUNT(DISTINCT mt.type) as unique_task_types,
    AVG(task_counts.tasks_per_interval) as avg_tasks_per_interval,
    MAX(task_counts.tasks_per_interval) as max_tasks_per_interval,
    MIN(task_counts.tasks_per_interval) as min_tasks_per_interval
FROM equipment_models em
JOIN maintenance_intervals mi ON mi.model_id = em.id
LEFT JOIN maintenance_tasks mt ON mt.interval_id = mi.id
LEFT JOIN (
    SELECT 
        mi2.id as interval_id,
        COUNT(mt2.id) as tasks_per_interval
    FROM maintenance_intervals mi2
    LEFT JOIN maintenance_tasks mt2 ON mt2.interval_id = mi2.id
    GROUP BY mi2.id
) task_counts ON task_counts.interval_id = mi.id
WHERE em.name IN (
    'T800 Water Truck',
    'INT-7600-ISM-320',
    'INT-WORKSTAR 7600-310',
    'KENWORTH-T460',
    'C7H 360HP 6X4 (AUTOMATICO)',
    'SIT-C7H-LONG CHASIS',
    'C7H 360HP 6X4 (MANUAL)',
    'CARGADOR FRONTAL 524 P',
    'CARGADOR FRONTAL 524K',
    'CARGADOR FRONTAL 524K II',
    'INT- 7600SBA 6X4',
    'INTERNATIONAL-TRACTOCAMION-LONG CHASIS',
    'BOM-PUTZMEISTER'
);

-- ============================================
-- 7. Recent tasks check (verify migration timestamp)
-- ============================================
-- Shows recently created tasks (should match migration time)
SELECT 
    em.name as model_name,
    COUNT(mt.id) as recent_tasks_count,
    MIN(mt.created_at) as earliest_created,
    MAX(mt.created_at) as latest_created
FROM equipment_models em
JOIN maintenance_intervals mi ON mi.model_id = em.id
JOIN maintenance_tasks mt ON mt.interval_id = mi.id
WHERE em.name IN (
    'T800 Water Truck',
    'INT-7600-ISM-320',
    'INT-WORKSTAR 7600-310',
    'KENWORTH-T460',
    'C7H 360HP 6X4 (AUTOMATICO)',
    'SIT-C7H-LONG CHASIS',
    'C7H 360HP 6X4 (MANUAL)',
    'CARGADOR FRONTAL 524 P',
    'CARGADOR FRONTAL 524K',
    'CARGADOR FRONTAL 524K II',
    'INT- 7600SBA 6X4',
    'INTERNATIONAL-TRACTOCAMION-LONG CHASIS',
    'BOM-PUTZMEISTER'
)
AND mt.created_at >= NOW() - INTERVAL '24 hours'  -- Adjust time window as needed
GROUP BY em.name
ORDER BY recent_tasks_count DESC;
