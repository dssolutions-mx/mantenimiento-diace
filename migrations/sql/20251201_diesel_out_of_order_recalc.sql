-- Migration: Fix diesel inventory calculation for out-of-order transactions
-- Date: 2025-12-01
-- Applied: 2025-12-01 via Supabase MCP
-- Description: When a transaction is inserted out of chronological order,
--              automatically recalculate all balances from that point forward
--              to ensure correct running totals.

-- ============================================================================
-- PROBLEM:
-- When transactions are entered out of chronological order, the incremental
-- update_warehouse_on_transaction() trigger blindly adds/subtracts from
-- current_inventory without considering that earlier transactions may need
-- their balances recalculated.
--
-- SOLUTION:
-- Create an AFTER INSERT trigger that detects out-of-order insertions and
-- calls recalc_balances_from() to fix all affected balances.
-- ============================================================================

-- Also created: recalculate_warehouse_balances_with_initial(uuid, numeric)
-- This function allows recalculating balances with a specified initial balance
-- for warehouses that had existing inventory before the first recorded transaction.

CREATE OR REPLACE FUNCTION public.recalculate_warehouse_balances_with_initial(
  p_warehouse_id uuid,
  p_initial_balance numeric DEFAULT 0
) RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_running NUMERIC(10,2);
  v_count INTEGER := 0;
  r RECORD;
BEGIN
  v_running := COALESCE(p_initial_balance, 0);
  
  FOR r IN
    SELECT id, transaction_type, quantity_liters
    FROM diesel_transactions
    WHERE warehouse_id = p_warehouse_id
    ORDER BY transaction_date ASC, created_at ASC, id ASC
  LOOP
    UPDATE diesel_transactions
    SET 
      previous_balance = v_running,
      current_balance = CASE 
        WHEN transaction_type = 'entry' THEN v_running + quantity_liters
        WHEN transaction_type = 'consumption' THEN v_running - quantity_liters
        WHEN transaction_type = 'adjustment' THEN v_running + quantity_liters
        ELSE v_running
      END,
      updated_at = NOW()
    WHERE id = r.id;
    
    v_running := CASE 
      WHEN r.transaction_type = 'entry' THEN v_running + r.quantity_liters
      WHEN r.transaction_type = 'consumption' THEN v_running - r.quantity_liters
      WHEN r.transaction_type = 'adjustment' THEN v_running + r.quantity_liters
      ELSE v_running
    END;
    
    v_count := v_count + 1;
  END LOOP;
  
  UPDATE diesel_warehouses
  SET 
    current_inventory = v_running,
    last_updated = NOW()
  WHERE id = p_warehouse_id;
  
  RETURN json_build_object(
    'success', true,
    'transactions_updated', v_count,
    'initial_balance', p_initial_balance,
    'final_balance', v_running
  );
  
EXCEPTION WHEN OTHERS THEN
  RETURN json_build_object('error', SQLERRM);
END;
$$;

COMMENT ON FUNCTION public.recalculate_warehouse_balances_with_initial(uuid, numeric) IS 
'Recalculates all diesel transaction balances for a warehouse starting from a given initial balance.';

-- Create the trigger function for recalculating on out-of-order INSERT
CREATE OR REPLACE FUNCTION public.trg_recalc_on_out_of_order_insert()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_latest_ts timestamptz;
  v_is_out_of_order boolean := false;
BEGIN
  -- Check if this transaction is out of order
  SELECT MAX(transaction_date) INTO v_latest_ts
  FROM diesel_transactions
  WHERE warehouse_id = NEW.warehouse_id
    AND id <> NEW.id;

  IF v_latest_ts IS NOT NULL AND NEW.transaction_date < v_latest_ts THEN
    v_is_out_of_order := true;
  END IF;

  -- If out of order, recalculate all balances from this transaction forward
  IF v_is_out_of_order THEN
    PERFORM set_config('diesel.recalc_running', '1', true);
    PERFORM public.recalc_balances_from(NEW.id);
    PERFORM set_config('diesel.recalc_running', '0', true);
    
    RAISE NOTICE 'Out-of-order diesel transaction detected (id: %, date: %). Balances recalculated.',
      NEW.id, NEW.transaction_date;
  END IF;

  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.trg_recalc_on_out_of_order_insert() IS 
'Automatically recalculates diesel inventory balances when a transaction is inserted out of chronological order.';

-- Create the AFTER INSERT trigger
DROP TRIGGER IF EXISTS trg_diesel_recalc_on_out_of_order ON diesel_transactions;

CREATE TRIGGER trg_diesel_recalc_on_out_of_order
  AFTER INSERT ON diesel_transactions
  FOR EACH ROW
  EXECUTE FUNCTION public.trg_recalc_on_out_of_order_insert();

-- Grant necessary permissions
GRANT EXECUTE ON FUNCTION public.trg_recalc_on_out_of_order_insert() TO authenticated;
GRANT EXECUTE ON FUNCTION public.trg_recalc_on_out_of_order_insert() TO service_role;

-- ============================================================================
-- DATA FIX APPLIED (2025-12-01):
-- Fixed 6 warehouses with incorrect balances:
-- 1. ALM-001-10 (UREA): initial 824.90, final 939.09 (90 transactions)
-- 2. ALM-002-11 (UREA): initial 177.00, final 11.00 (39 transactions)
-- 3. ALM-003-12 (UREA): initial 285.00, final 67.00 (10 transactions)
-- 4. ALM-001-6 (Diesel): initial 0, final 4841.00 (712 transactions)
-- 5. ALM-002-7 (Diesel): initial 0, final 5569.00 (862 transactions)
-- 6. ALM-004-13 (UREA): initial 0, final 1207.00 (35 transactions)
-- ============================================================================
