-- Migration: Fix Plant 4 diesel transfer transactions
-- Date: 2025-02-15
-- Description: Identify and mark Plant 4 transfer transactions that occurred when the plant was closed

-- Step 1: Find potential Plant 4 transfer-out transactions
-- These are consumptions in Plant 4 that don't have an asset_id (general consumption)
-- and occurred around the time of plant closure
-- NOTE: This query identifies candidates - manual review recommended before executing updates

-- View to help identify transfer candidates
CREATE OR REPLACE VIEW diesel_transfer_candidates AS
SELECT 
    dt_out.id as transfer_out_id,
    dt_out.transaction_id as transfer_out_transaction_id,
    dt_out.quantity_liters as transfer_out_liters,
    dt_out.transaction_date as transfer_out_date,
    p_out.code as from_plant_code,
    p_out.name as from_plant_name,
    dt_in.id as transfer_in_id,
    dt_in.transaction_id as transfer_in_transaction_id,
    dt_in.quantity_liters as transfer_in_liters,
    dt_in.transaction_date as transfer_in_date,
    p_in.code as to_plant_code,
    p_in.name as to_plant_name,
    ABS(dt_out.quantity_liters - dt_in.quantity_liters) as quantity_diff,
    ABS(EXTRACT(EPOCH FROM (dt_out.transaction_date - dt_in.transaction_date)) / 86400) as days_diff
FROM diesel_transactions dt_out
JOIN plants p_out ON dt_out.plant_id = p_out.id
JOIN diesel_transactions dt_in ON dt_in.transaction_type = 'entry'
JOIN plants p_in ON dt_in.plant_id = p_in.id
WHERE dt_out.transaction_type = 'consumption'
  AND dt_out.plant_id = (SELECT id FROM plants WHERE code = 'P004')
  AND dt_out.asset_id IS NULL
  AND dt_out.asset_category = 'general'
  AND dt_out.is_transfer = false
  AND dt_in.is_transfer = false
  AND dt_in.asset_id IS NULL
  AND dt_in.asset_category = 'general'
  AND p_in.code != 'P004'  -- Different plant
  AND ABS(dt_out.quantity_liters - dt_in.quantity_liters) < 10  -- Within 10L difference
  AND ABS(EXTRACT(EPOCH FROM (dt_out.transaction_date - dt_in.transaction_date)) / 86400) <= 7  -- Within 7 days
ORDER BY dt_out.transaction_date DESC, quantity_diff ASC;

-- Step 2: Manual identification query
-- Run this to see potential transfers and manually verify before updating
-- SELECT * FROM diesel_transfer_candidates ORDER BY transfer_out_date DESC;

-- Step 3: Update identified transfer pairs
-- IMPORTANT: Review the candidates first, then uncomment and modify this section
-- Replace the transaction IDs with the actual IDs from the candidates view

/*
-- Example: Mark a transfer pair (replace IDs with actual values from candidates view)
-- Transfer-out transaction (consumption in Plant 4)
UPDATE diesel_transactions
SET 
    is_transfer = true,
    reference_transaction_id = 'TRANSFER_IN_TRANSACTION_ID_HERE',  -- Replace with actual transfer-in ID
    notes = COALESCE(notes, '') || CASE WHEN notes IS NOT NULL THEN ' | ' ELSE '' END || '[TRANSFER] From Plant 4 to Plant X'
WHERE id = 'TRANSFER_OUT_TRANSACTION_ID_HERE';  -- Replace with actual transfer-out ID

-- Transfer-in transaction (entry in receiving plant)
UPDATE diesel_transactions
SET 
    is_transfer = true,
    reference_transaction_id = 'TRANSFER_OUT_TRANSACTION_ID_HERE',  -- Replace with actual transfer-out ID
    notes = COALESCE(notes, '') || CASE WHEN notes IS NOT NULL THEN ' | ' ELSE '' END || '[TRANSFER] From Plant 4'
WHERE id = 'TRANSFER_IN_TRANSACTION_ID_HERE';  -- Replace with actual transfer-in ID
*/

-- Step 4: Verification query
-- Run this after updates to verify transfers are properly marked
/*
SELECT 
    dt.id,
    dt.transaction_id,
    dt.transaction_type,
    dt.quantity_liters,
    dt.transaction_date,
    p.code as plant_code,
    dt.is_transfer,
    dt.reference_transaction_id,
    dt.notes
FROM diesel_transactions dt
JOIN plants p ON dt.plant_id = p.id
WHERE dt.is_transfer = true
ORDER BY dt.transaction_date DESC;
*/

COMMENT ON VIEW diesel_transfer_candidates IS 
'Helps identify potential diesel transfer transactions between Plant 4 and other plants. 
Review candidates manually before marking as transfers.';
