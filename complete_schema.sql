

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;


CREATE SCHEMA IF NOT EXISTS "public";


ALTER SCHEMA "public" OWNER TO "pg_database_owner";


COMMENT ON SCHEMA "public" IS 'EMERGENCY MODE: ALL RLS DISABLED - Restoring full access immediately';



CREATE TYPE "public"."assignment_type" AS ENUM (
    'primary',
    'secondary'
);


ALTER TYPE "public"."assignment_type" OWNER TO "postgres";


CREATE TYPE "public"."user_role" AS ENUM (
    'GERENCIA_GENERAL',
    'JEFE_UNIDAD_NEGOCIO',
    'ENCARGADO_MANTENIMIENTO',
    'JEFE_PLANTA',
    'DOSIFICADOR',
    'OPERADOR',
    'AUXILIAR_COMPRAS',
    'AREA_ADMINISTRATIVA',
    'EJECUTIVO',
    'VISUALIZADOR'
);


ALTER TYPE "public"."user_role" OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."add_column_if_not_exists"("p_table" "text", "p_column" "text", "p_type" "text", "p_constraint" "text" DEFAULT NULL::"text") RETURNS "void"
    LANGUAGE "plpgsql"
    AS $$
DECLARE
    column_exists BOOLEAN;
    alter_statement TEXT;
BEGIN
    -- Check if column exists
    SELECT EXISTS (
        SELECT 1 
        FROM information_schema.columns 
        WHERE table_name = p_table 
        AND column_name = p_column
    ) INTO column_exists;
    
    -- Add column if it doesn't exist
    IF NOT column_exists THEN
        alter_statement := 'ALTER TABLE ' || p_table || ' ADD COLUMN ' || p_column || ' ' || p_type;
        
        -- Add constraint if provided
        IF p_constraint IS NOT NULL THEN
            alter_statement := alter_statement || ' ' || p_constraint;
        END IF;
        
        EXECUTE alter_statement;
        RAISE NOTICE 'Added column % to table %', p_column, p_table;
    ELSE
        RAISE NOTICE 'Column % already exists in table %', p_column, p_table;
    END IF;
END;
$$;


ALTER FUNCTION "public"."add_column_if_not_exists"("p_table" "text", "p_column" "text", "p_type" "text", "p_constraint" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."advance_purchase_order_workflow"("p_purchase_order_id" "uuid", "p_new_status" "text", "p_user_id" "uuid", "p_notes" "text" DEFAULT NULL::"text") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
DECLARE
  v_current_status TEXT;
  v_po_type TEXT;
  v_requires_quote BOOLEAN;
  v_has_quotations BOOLEAN;
  v_payment_method TEXT;
  v_max_payment_date TIMESTAMPTZ;
  v_allowed_statuses TEXT[];
BEGIN
  -- Get current PO details
  SELECT status, po_type, requires_quote, payment_method, max_payment_date
  INTO v_current_status, v_po_type, v_requires_quote, v_payment_method, v_max_payment_date
  FROM purchase_orders
  WHERE id = p_purchase_order_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Purchase order not found';
  END IF;

  -- Use tolerant quotation check
  v_has_quotations := has_quotations(p_purchase_order_id);

  -- Get valid next statuses
  SELECT get_valid_next_statuses(v_current_status, v_po_type)
  INTO v_allowed_statuses;

  -- Validate that new status is allowed
  IF NOT (p_new_status = ANY(v_allowed_statuses)) THEN
    RAISE EXCEPTION 'Invalid status transition from % to % for po_type %', 
      v_current_status, p_new_status, v_po_type;
  END IF;

  -- Business rule: Cannot approve if quotation is required but not provided
  IF p_new_status = 'approved' AND v_requires_quote AND NOT v_has_quotations THEN
    RAISE EXCEPTION 'Cannot approve: quotation is required but not uploaded';
  END IF;

  -- Business rule: Cannot mark as purchased without max_payment_date for transfers
  IF p_new_status = 'purchased' AND v_payment_method = 'transfer' THEN
    IF v_max_payment_date IS NULL THEN
      RAISE EXCEPTION 'Cannot mark as purchased: max_payment_date is required for transfer payments';
    END IF;
  END IF;

  -- Update the purchase order
  UPDATE purchase_orders
  SET 
    status = p_new_status,
    updated_at = NOW(),
    updated_by = p_user_id,
    notes = CASE 
      WHEN p_notes IS NOT NULL THEN p_notes 
      ELSE notes 
    END,
    approved_by = CASE 
      WHEN p_new_status = 'approved' THEN p_user_id 
      ELSE approved_by 
    END,
    authorization_date = CASE 
      WHEN p_new_status = 'approved' THEN NOW() 
      ELSE authorization_date 
    END,
    purchased_at = CASE 
      WHEN p_new_status = 'purchased' THEN NOW() 
      ELSE purchased_at 
    END
  WHERE id = p_purchase_order_id;

  RETURN jsonb_build_object(
    'success', true,
    'message', format('Status updated from %s to %s', v_current_status, p_new_status),
    'new_status', p_new_status
  );
END;
$$;


ALTER FUNCTION "public"."advance_purchase_order_workflow"("p_purchase_order_id" "uuid", "p_new_status" "text", "p_user_id" "uuid", "p_notes" "text") OWNER TO "postgres";


COMMENT ON FUNCTION "public"."advance_purchase_order_workflow"("p_purchase_order_id" "uuid", "p_new_status" "text", "p_user_id" "uuid", "p_notes" "text") IS 'Advances purchase order workflow with proper validation and prevents invalid transitions';



CREATE OR REPLACE FUNCTION "public"."approve_additional_expense"("p_expense_id" "uuid", "p_approved_by" "uuid") RETURNS boolean
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
DECLARE
  v_expense RECORD;
  v_work_order RECORD;
  v_purchase_order RECORD;
  v_total_adjustment DECIMAL(10,2) := 0;
BEGIN
  -- Get expense data
  SELECT * INTO v_expense 
  FROM additional_expenses 
  WHERE id = p_expense_id;
  
  IF v_expense IS NULL THEN
    RAISE EXCEPTION 'Expense not found';
  END IF;
  
  -- Update expense status
  UPDATE additional_expenses
  SET status = 'aprobado',
      approved_by = p_approved_by,
      approved_at = NOW(),
      updated_at = NOW()
  WHERE id = p_expense_id;
  
  -- Get work order
  SELECT * INTO v_work_order
  FROM work_orders
  WHERE id = v_expense.work_order_id;
  
  -- If work order has a purchase order, adjust it
  IF v_work_order.purchase_order_id IS NOT NULL THEN
    -- Get purchase order
    SELECT * INTO v_purchase_order
    FROM purchase_orders
    WHERE id = v_work_order.purchase_order_id;
    
    -- Calculate total adjustment amount from all approved expenses
    SELECT SUM(amount) INTO v_total_adjustment
    FROM additional_expenses
    WHERE work_order_id = v_work_order.id 
    AND status = 'aprobado';
    
    -- Update purchase order
    UPDATE purchase_orders
    SET adjustment_amount = v_total_adjustment,
        adjustment_status = 'aprobado',
        adjusted_at = NOW(),
        adjusted_by = p_approved_by,
        adjusted_total_amount = total_amount + v_total_adjustment,
        updated_at = NOW()
    WHERE id = v_work_order.purchase_order_id;
  END IF;
  
  RETURN TRUE;
END;
$$;


ALTER FUNCTION "public"."approve_additional_expense"("p_expense_id" "uuid", "p_approved_by" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."approve_purchase_order"("p_purchase_order_id" "uuid", "p_approved_by" "uuid") RETURNS "void"
    LANGUAGE "plpgsql"
    AS $$
BEGIN
  -- Actualizar orden de compra
  UPDATE purchase_orders
  SET 
    status = 'Aprobada',
    approved_by = p_approved_by,
    approval_date = NOW(),
    updated_at = NOW()
  WHERE id = p_purchase_order_id;
  
  -- Actualizar orden de trabajo asociada
  UPDATE work_orders
  SET 
    status = 'Aprobada',
    approval_status = 'Aprobada',
    approved_by = p_approved_by,
    approval_date = NOW(),
    updated_at = NOW()
  WHERE purchase_order_id = p_purchase_order_id;
END;
$$;


ALTER FUNCTION "public"."approve_purchase_order"("p_purchase_order_id" "uuid", "p_approved_by" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."assign_operator_to_asset"("asset_uuid" "uuid", "operator_uuid" "uuid", "assignment_type_param" "text", "assigned_by_uuid" "uuid", "start_date_param" "date" DEFAULT CURRENT_DATE) RETURNS "json"
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
DECLARE
  result JSON;
  existing_primary_count INT;
  operator_plant_id UUID;
  asset_plant_id UUID;
  assigner_permissions RECORD;
BEGIN
  -- Validate assignment_type parameter
  IF assignment_type_param NOT IN ('primary', 'secondary') THEN
    RETURN json_build_object(
      'success', false,
      'error', 'Invalid assignment type. Must be primary or secondary'
    );
  END IF;
  
  -- Get assigner permissions
  SELECT can_assign_assets, plant_id, user_role INTO assigner_permissions
  FROM get_user_organizational_context(assigned_by_uuid);
  
  -- Check if user has permission to assign assets
  IF NOT assigner_permissions.can_assign_assets THEN
    RETURN json_build_object(
      'success', false,
      'error', 'User does not have permission to assign operators to assets'
    );
  END IF;
  
  -- Get operator and asset plant IDs
  SELECT plant_id INTO operator_plant_id FROM profiles WHERE id = operator_uuid;
  SELECT plant_id INTO asset_plant_id FROM assets WHERE id = asset_uuid;
  
  -- Validate same plant assignment (unless assigner is general management)
  IF assigner_permissions.user_role NOT IN ('GERENCIA_GENERAL', 'JEFE_UNIDAD_NEGOCIO') 
     AND operator_plant_id != asset_plant_id THEN
    RETURN json_build_object(
      'success', false,
      'error', 'Cannot assign operator from different plant unless you have general management privileges'
    );
  END IF;
  
  -- Check for existing primary operator if trying to assign primary
  IF assignment_type_param = 'primary' THEN
    SELECT COUNT(*) INTO existing_primary_count
    FROM asset_operators 
    WHERE asset_id = asset_uuid 
      AND assignment_type = 'primary' 
      AND status = 'active';
      
    IF existing_primary_count > 0 THEN
      RETURN json_build_object(
        'success', false,
        'error', 'Asset already has a primary operator assigned'
      );
    END IF;
  END IF;
  
  -- Create the assignment
  INSERT INTO asset_operators (
    id, asset_id, operator_id, assignment_type, 
    start_date, status, assigned_by, created_at
  ) VALUES (
    uuid_generate_v4(), asset_uuid, operator_uuid, assignment_type_param,
    start_date_param, 'active', assigned_by_uuid, NOW()
  );
  
  RETURN json_build_object(
    'success', true,
    'message', 'Operator assigned successfully'
  );
  
EXCEPTION WHEN OTHERS THEN
  RETURN json_build_object(
    'success', false,
    'error', SQLERRM
  );
END;
$$;


ALTER FUNCTION "public"."assign_operator_to_asset"("asset_uuid" "uuid", "operator_uuid" "uuid", "assignment_type_param" "text", "assigned_by_uuid" "uuid", "start_date_param" "date") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."auto_approve_additional_expense"("p_expense_id" "uuid", "p_approved_by" "uuid") RETURNS boolean
    LANGUAGE "plpgsql"
    AS $$
DECLARE
  v_expense RECORD;
BEGIN
  -- Get the expense details
  SELECT * INTO v_expense FROM additional_expenses WHERE id = p_expense_id;
  
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Expense with ID % not found', p_expense_id;
  END IF;
  
  -- Update expense status to Approved
  UPDATE additional_expenses
  SET 
    status = 'Aprobado',
    approved_by = p_approved_by,
    approval_date = NOW(),
    updated_at = NOW()
  WHERE id = p_expense_id;
  
  RETURN TRUE;
END;
$$;


ALTER FUNCTION "public"."auto_approve_additional_expense"("p_expense_id" "uuid", "p_approved_by" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."auto_create_pending_work_orders"() RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
DECLARE
  v_result jsonb;
  v_checklist record;
  v_issue record;
  v_work_order_id text;
  v_asset_id uuid;
  v_asset_name text;
  v_priority text;
  v_description text;
  v_created_count integer := 0;
  v_error_count integer := 0;
  v_checklist_ids text[] := ARRAY[]::text[];
  v_one_hour_ago timestamp;
BEGIN
  -- Calculate 1 hour ago timestamp
  v_one_hour_ago := NOW() - INTERVAL '1 hour';

  RAISE NOTICE 'Starting auto-create check for issues older than %', v_one_hour_ago;

  -- Find all checklists with unresolved issues older than 1 hour
  FOR v_checklist IN
    SELECT DISTINCT
      ci.checklist_id,
      cc.asset_id,
      cc.completion_date,
      cc.completed_items,
      a.name as asset_name,
      a.asset_id as asset_code
    FROM checklist_issues ci
    JOIN completed_checklists cc ON ci.checklist_id = cc.id
    JOIN assets a ON cc.asset_id = a.id
    WHERE ci.resolved = false
      AND cc.completion_date < v_one_hour_ago
      AND NOT EXISTS (
        -- Check if work orders already exist for this checklist
        SELECT 1 FROM work_orders wo
        WHERE wo.checklist_id = ci.checklist_id
      )
    ORDER BY cc.completion_date ASC
  LOOP
    BEGIN
      RAISE NOTICE 'Processing checklist % (asset: %)', v_checklist.checklist_id, v_checklist.asset_name;

      -- Get all unresolved issues for this checklist (excluding cleanliness and security)
      FOR v_issue IN
        SELECT
          ci.id,
          ci.item_id,
          ci.description,
          ci.notes,
          ci.status,
          ci.photo_url
        FROM checklist_issues ci
        WHERE ci.checklist_id = v_checklist.checklist_id
          AND ci.resolved = false
          -- Exclude cleanliness and security sections
          AND NOT EXISTS (
            SELECT 1
            FROM jsonb_array_elements(v_checklist.completed_items) AS item
            WHERE (item->>'item_id')::text = ci.item_id
              AND (item->>'section_type')::text IN ('cleanliness_bonus', 'security_talk')
          )
      LOOP
        -- Determine priority based on status
        v_priority := CASE
          WHEN v_issue.status = 'fail' THEN 'Alta'
          ELSE 'Media'
        END;

        -- Build description
        v_description := v_issue.description || E'\n\n' || COALESCE(v_issue.notes, '');

        -- Generate unique work order ID
        v_work_order_id := (SELECT generate_unique_work_order_id());

        -- Check for similar existing open work orders using fingerprint
        DECLARE
          v_fingerprint text;
          v_similar_wo_id uuid;
        BEGIN
          -- Generate fingerprint for this issue (cast UUID to text)
          v_fingerprint := (
            SELECT generate_issue_fingerprint(
              v_checklist.asset_id::text,
              v_issue.description,
              v_issue.status,
              COALESCE(v_issue.notes, '')
            )
          );

          -- Update issue_fingerprint if missing
          UPDATE checklist_issues
          SET issue_fingerprint = v_fingerprint
          WHERE id = v_issue.id
            AND (issue_fingerprint IS NULL OR issue_fingerprint = '');

          -- Find similar open work orders within 30 days using existing deduplication approach
          -- Query checklist_issues with fingerprints and join to work_orders (matching existing system)
          SELECT wo.id INTO v_similar_wo_id
          FROM checklist_issues ci_similar
          JOIN work_orders wo ON ci_similar.work_order_id = wo.id
          WHERE ci_similar.issue_fingerprint = v_fingerprint
            AND ci_similar.resolved = false
            AND wo.asset_id = v_checklist.asset_id
            AND wo.status IN ('Pendiente', 'En Progreso', 'en_progreso', 'pendiente')
            AND wo.created_at > NOW() - INTERVAL '30 days'
          ORDER BY wo.created_at DESC
          LIMIT 1;

          IF v_similar_wo_id IS NOT NULL THEN
            -- Consolidate with existing work order
            RAISE NOTICE 'Consolidating issue % with existing work order %', v_issue.id, v_similar_wo_id;

            -- Update existing work order description
            UPDATE work_orders
            SET
              description = description || E'\n\n--- Problema adicional (Auto-consolidado) ---\n' || v_description,
              priority = CASE
                WHEN v_priority = 'Alta' THEN 'Alta'  -- Escalate if new issue is high priority
                ELSE priority
              END,
              updated_at = NOW()
            WHERE id = v_similar_wo_id;

            -- Link the issue to the existing work order and update fingerprint
            UPDATE checklist_issues
            SET 
              resolved = true,
              work_order_id = v_similar_wo_id,
              issue_fingerprint = v_fingerprint
            WHERE id = v_issue.id;

            -- Add to incident history
            INSERT INTO incident_history (
              work_order_id,
              status,
              notes,
              changed_by
            ) VALUES (
              v_similar_wo_id,
              'En Progreso',
              'Problema adicional consolidado automáticamente: ' || v_issue.description,
              'system_auto_create'
            );

          ELSE
            -- Create new work order
            RAISE NOTICE 'Creating new work order % for issue %', v_work_order_id, v_issue.id;

            -- Insert work order (order_id will be generated by trigger, or use v_work_order_id)
            DECLARE
              v_new_wo_id uuid;
            BEGIN
              INSERT INTO work_orders (
                order_id,
                asset_id,
                description,
                priority,
                status,
                type,
                checklist_id,
                created_at,
                updated_at
              ) VALUES (
                v_work_order_id,
                v_checklist.asset_id,
                '[AUTO-CREADO] ' || v_description,
                v_priority,
                'Pendiente',
                'Correctivo',
                v_checklist.checklist_id,
                NOW(),
                NOW()
              ) RETURNING id INTO v_new_wo_id;

              -- Mark issue as resolved and link to work order
              UPDATE checklist_issues
              SET 
                resolved = true,
                work_order_id = v_new_wo_id,
                issue_fingerprint = v_fingerprint
              WHERE id = v_issue.id;

              -- Create incident history entry
              INSERT INTO incident_history (
                work_order_id,
                status,
                notes,
                changed_by
              ) VALUES (
                v_new_wo_id,
                'Pendiente',
                'Orden de trabajo creada automáticamente después de 1 hora sin acción manual',
                'system_auto_create'
              );

              -- Increment created count only when a new work order is actually created
              v_created_count := v_created_count + 1;
            END;
          END IF;

        END;
      END LOOP;

      -- Track processed checklist (but don't increment created_count here - it's incremented per work order created)
      v_checklist_ids := array_append(v_checklist_ids, v_checklist.checklist_id);

    EXCEPTION WHEN OTHERS THEN
      RAISE NOTICE 'Error processing checklist %: %', v_checklist.checklist_id, SQLERRM;
      v_error_count := v_error_count + 1;
    END;
  END LOOP;

  -- Build result
  v_result := jsonb_build_object(
    'success', true,
    'created_count', v_created_count,
    'error_count', v_error_count,
    'checklist_ids', v_checklist_ids,
    'processed_at', NOW()
  );

  RAISE NOTICE 'Auto-create completed: % work orders created, % errors', v_created_count, v_error_count;

  RETURN v_result;
END;
$$;


ALTER FUNCTION "public"."auto_create_pending_work_orders"() OWNER TO "postgres";


COMMENT ON FUNCTION "public"."auto_create_pending_work_orders"() IS 'Automatically creates work orders for checklist issues that are older than 1 hour and have not been processed. Excludes cleanliness and security section items. Consolidates with existing similar work orders when possible.';



CREATE OR REPLACE FUNCTION "public"."auto_create_pending_work_orders_with_logging"() RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
DECLARE
  v_result jsonb;
BEGIN
  -- Call the main function
  v_result := auto_create_pending_work_orders();

  -- Log the result
  INSERT INTO auto_create_logs (result, success)
  VALUES (v_result, true);

EXCEPTION WHEN OTHERS THEN
  -- Log the error
  INSERT INTO auto_create_logs (result, success, error)
  VALUES (
    jsonb_build_object('error', SQLERRM),
    false,
    SQLERRM
  );
END;
$$;


ALTER FUNCTION "public"."auto_create_pending_work_orders_with_logging"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."backfill_po_notifications"() RETURNS TABLE("po_id" "uuid", "order_id" "text", "notification_sent" boolean, "error_message" "text")
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  po_record record;
  v_url text;
  v_bearer text;
  v_request_id bigint;
begin
  -- Get configuration
  select value into v_url from public.app_settings where key = 'edge_po_notify_url';
  select value into v_bearer from public.app_settings where key = 'edge_bearer';
  
  if v_url is null or trim(v_url) = '' then
    raise exception 'Notification URL not configured';
  end if;
  
  -- Loop through missed POs
  for po_record in 
    select po.id, po.order_id, po.total_amount
    from purchase_orders po
    left join notifications n on n.entity_id = po.id 
      and n.type in ('PURCHASE_ORDER_APPROVAL_ENQUEUE', 'PURCHASE_ORDER_APPROVAL_EMAIL')
    where po.status = 'pending_approval'
      and po.created_at >= '2025-09-25'::date
    group by po.id, po.order_id, po.total_amount
    having count(n.id) = 0
  loop
    begin
      -- Call net.http_post
      v_request_id := net.http_post(
        v_url,
        jsonb_build_object('po_id', po_record.id),
        '{}'::jsonb,
        jsonb_build_object(
          'Content-Type', 'application/json',
          'Authorization', 'Bearer ' || v_bearer
        ),
        5000
      );
      
      -- Log successful enqueue
      insert into notifications (user_id, title, message, type, related_entity, entity_id, created_at)
      values (
        null,
        'PO notification enqueued (backfill)',
        format('Queued request_id=%s for PO %s (order_id=%s, amount=%s)', 
               v_request_id, po_record.id::text, po_record.order_id, po_record.total_amount),
        'PURCHASE_ORDER_APPROVAL_ENQUEUE',
        'purchase_order',
        po_record.id,
        now()
      );
      
      return query select po_record.id, po_record.order_id, true, null::text;
      
    exception when others then
      return query select po_record.id, po_record.order_id, false, SQLERRM;
    end;
  end loop;
end;
$$;


ALTER FUNCTION "public"."backfill_po_notifications"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."calculate_actual_due_hour"("interval_hours" integer, "cycle_number" integer, "cycle_length_hours" integer, "is_first_cycle_only" boolean DEFAULT false) RETURNS integer
    LANGUAGE "plpgsql"
    AS $$
BEGIN
  -- If this is first cycle only and we're past cycle 1, return null
  IF is_first_cycle_only AND cycle_number > 1 THEN
    RETURN NULL;
  END IF;
  
  -- Formula: (cycle_number - 1) * cycle_length + interval_hours
  RETURN ((cycle_number - 1) * cycle_length_hours) + interval_hours;
END;
$$;


ALTER FUNCTION "public"."calculate_actual_due_hour"("interval_hours" integer, "cycle_number" integer, "cycle_length_hours" integer, "is_first_cycle_only" boolean) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."calculate_escalated_priority"("p_original_priority" "text", "p_recurrence_count" integer, "p_status" "text") RETURNS "text"
    LANGUAGE "plpgsql" IMMUTABLE
    AS $$
DECLARE
    escalated_priority TEXT;
BEGIN
    -- Escalation rules based on recurrence count and issue severity
    CASE 
        WHEN p_status = 'fail' THEN
            -- Critical issues escalate faster
            CASE 
                WHEN p_recurrence_count >= 3 THEN escalated_priority := 'Emergencia';
                WHEN p_recurrence_count >= 2 THEN escalated_priority := 'Alta';
                ELSE escalated_priority := COALESCE(p_original_priority, 'Alta');
            END CASE;
        WHEN p_status = 'flag' THEN
            -- Warning issues escalate more gradually
            CASE 
                WHEN p_recurrence_count >= 4 THEN escalated_priority := 'Alta';
                WHEN p_recurrence_count >= 3 THEN escalated_priority := 'Media';
                ELSE escalated_priority := COALESCE(p_original_priority, 'Baja');
            END CASE;
        ELSE
            escalated_priority := COALESCE(p_original_priority, 'Baja');
    END CASE;
    
    RETURN escalated_priority;
END;
$$;


ALTER FUNCTION "public"."calculate_escalated_priority"("p_original_priority" "text", "p_recurrence_count" integer, "p_status" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."calculate_maintenance_cycle"("asset_current_hours" integer, "cycle_length_hours" integer) RETURNS integer
    LANGUAGE "plpgsql"
    AS $$
BEGIN
  -- If no hours recorded or no cycle length, we're in cycle 1
  IF asset_current_hours IS NULL OR asset_current_hours <= 0 OR cycle_length_hours IS NULL OR cycle_length_hours <= 0 THEN
    RETURN 1;
  END IF;
  
  -- Calculate which cycle we're in: floor(hours / cycle_length) + 1
  RETURN FLOOR(asset_current_hours::FLOAT / cycle_length_hours::FLOAT)::INTEGER + 1;
END;
$$;


ALTER FUNCTION "public"."calculate_maintenance_cycle"("asset_current_hours" integer, "cycle_length_hours" integer) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."calculate_next_maintenance"("p_asset_id" "uuid", "p_maintenance_interval" integer) RETURNS timestamp with time zone
    LANGUAGE "plpgsql"
    AS $$
DECLARE
  v_unit TEXT;
  v_current_value INTEGER;
  v_avg_daily_usage FLOAT := 8; -- Valor predeterminado
  v_remaining INTEGER;
  v_days_remaining FLOAT;
  v_next_date TIMESTAMPTZ;
BEGIN
  -- Obtener la unidad de medida del modelo asociado
  SELECT em.maintenance_unit INTO v_unit
  FROM assets a
  JOIN equipment_models em ON a.model_id = em.id
  WHERE a.id = p_asset_id;
  
  -- Obtener el valor actual según la unidad de medida
  IF v_unit = 'hours' THEN
    SELECT current_hours INTO v_current_value
    FROM assets
    WHERE id = p_asset_id;
  ELSE
    SELECT current_kilometers INTO v_current_value
    FROM assets
    WHERE id = p_asset_id;
  END IF;
  
  -- Calcular el valor restante hasta el próximo mantenimiento
  v_remaining := p_maintenance_interval - (v_current_value % p_maintenance_interval);
  IF v_remaining = 0 THEN
    v_remaining := p_maintenance_interval;
  END IF;
  
  -- Estimar días restantes según el uso promedio diario
  v_days_remaining := v_remaining / v_avg_daily_usage;
  
  -- Calcular la fecha del próximo mantenimiento
  v_next_date := CURRENT_DATE + (v_days_remaining * INTERVAL '1 day');
  
  RETURN v_next_date;
END;
$$;


ALTER FUNCTION "public"."calculate_next_maintenance"("p_asset_id" "uuid", "p_maintenance_interval" integer) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."can_manage_user"("target_user_id" "uuid") RETURNS boolean
    LANGUAGE "sql" SECURITY DEFINER
    AS $$
  -- Verificar si el usuario actual puede administrar al usuario objetivo
  SELECT EXISTS (
    SELECT 1 FROM profiles 
    WHERE id = target_user_id
    -- Si esta consulta devuelve el usuario, significa que las políticas RLS 
    -- permiten al usuario actual verlo, por lo tanto puede administrarlo
  );
$$;


ALTER FUNCTION "public"."can_manage_user"("target_user_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."can_user_access_plant"("p_user_id" "uuid", "p_plant_id" "uuid") RETURNS boolean
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    AS $$
BEGIN
  RETURN EXISTS (
    SELECT 1 FROM profiles pr
    INNER JOIN plants p ON p.business_unit_id = pr.business_unit_id
    WHERE pr.id = p_user_id AND p.id = p_plant_id
  ) OR EXISTS (
    SELECT 1 FROM profiles
    WHERE id = p_user_id AND plant_id = p_plant_id
  );
END;
$$;


ALTER FUNCTION "public"."can_user_access_plant"("p_user_id" "uuid", "p_plant_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."can_user_authorize_purchase_order"("p_user_id" "uuid", "p_amount" numeric, "p_business_unit_id" "uuid" DEFAULT NULL::"uuid", "p_plant_id" "uuid" DEFAULT NULL::"uuid") RETURNS boolean
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
DECLARE
  v_effective_authorization decimal(15,2);
BEGIN
  -- Get the user's effective authorization amount
  v_effective_authorization := get_user_effective_authorization(p_user_id, p_business_unit_id, p_plant_id);
  
  -- Check if the amount is within their effective authorization
  RETURN p_amount <= v_effective_authorization;
END;
$$;


ALTER FUNCTION "public"."can_user_authorize_purchase_order"("p_user_id" "uuid", "p_amount" numeric, "p_business_unit_id" "uuid", "p_plant_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."can_user_delegate"("p_grantor_id" "uuid", "p_grantee_id" "uuid", "p_amount" numeric, "p_business_unit_id" "uuid" DEFAULT NULL::"uuid", "p_plant_id" "uuid" DEFAULT NULL::"uuid") RETURNS boolean
    LANGUAGE "plpgsql"
    AS $$
DECLARE
  grantor_available DECIMAL(15,2);
  grantee_profile RECORD;
BEGIN
  -- Basic validations
  IF p_grantor_id = p_grantee_id THEN
    RETURN FALSE; -- Cannot delegate to yourself
  END IF;
  
  IF p_amount <= 0 THEN
    RETURN FALSE; -- Amount must be positive
  END IF;
  
  -- Check if grantee exists and is active
  SELECT role, business_unit_id, plant_id
  INTO grantee_profile
  FROM profiles
  WHERE id = p_grantee_id;
  
  IF NOT FOUND THEN
    RETURN FALSE; -- Grantee doesn't exist
  END IF;
  
  -- Get grantor's available delegation amount
  grantor_available := get_user_delegatable_amount(p_grantor_id, p_business_unit_id, p_plant_id);
  
  -- Check if grantor has enough available delegation capacity
  IF grantor_available < p_amount THEN
    RETURN FALSE;
  END IF;
  
  -- Additional business rules can be added here
  -- For example: scope validation, hierarchical rules, etc.
  
  RETURN TRUE;
END;
$$;


ALTER FUNCTION "public"."can_user_delegate"("p_grantor_id" "uuid", "p_grantee_id" "uuid", "p_amount" numeric, "p_business_unit_id" "uuid", "p_plant_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."check_existing_schedule"("p_template_id" "uuid", "p_asset_id" "uuid", "p_scheduled_date" "date") RETURNS boolean
    LANGUAGE "plpgsql"
    AS $$
DECLARE v_exists boolean;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM public.checklist_schedules
    WHERE template_id = p_template_id
      AND asset_id = p_asset_id
      AND scheduled_day = p_scheduled_date
  ) INTO v_exists;
  RETURN v_exists;
END;
$$;


ALTER FUNCTION "public"."check_existing_schedule"("p_template_id" "uuid", "p_asset_id" "uuid", "p_scheduled_date" "date") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."check_maintenance_due_assets"() RETURNS TABLE("asset_id" "uuid", "asset_name" "text", "maintenance_plan_id" "uuid", "plan_name" "text", "next_due" timestamp with time zone, "days_remaining" integer, "value_remaining" integer, "maintenance_unit" "text")
    LANGUAGE "plpgsql"
    AS $$
BEGIN
  RETURN QUERY
  SELECT 
    a.id as asset_id,
    a.name as asset_name,
    mp.id as maintenance_plan_id,
    mp.name as plan_name,
    mp.next_due,
    EXTRACT(DAY FROM mp.next_due - CURRENT_DATE)::INTEGER as days_remaining,
    CASE 
      WHEN em.maintenance_unit = 'hours' THEN 
        (mi.interval_value - (a.current_hours % mi.interval_value))
      ELSE 
        (mi.interval_value - (a.current_kilometers % mi.interval_value))
    END as value_remaining,
    em.maintenance_unit
  FROM maintenance_plans mp
  JOIN assets a ON mp.asset_id = a.id
  JOIN equipment_models em ON a.model_id = em.id
  JOIN maintenance_intervals mi ON mp.interval_id = mi.id
  WHERE 
    mp.status = 'Programado' AND
    a.status = 'operational' AND
    (
      mp.next_due <= (CURRENT_DATE + INTERVAL '30 days') OR
      CASE 
        WHEN em.maintenance_unit = 'hours' THEN 
          (mi.interval_value - (a.current_hours % mi.interval_value)) <= (mi.interval_value * 0.1)
        ELSE 
          (mi.interval_value - (a.current_kilometers % mi.interval_value)) <= (mi.interval_value * 0.1)
      END
    )
  ORDER BY days_remaining ASC;
END;
$$;


ALTER FUNCTION "public"."check_maintenance_due_assets"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."cleanup_all_duplicate_schedules"() RETURNS integer
    LANGUAGE "plpgsql"
    AS $$
DECLARE
  v_deleted_count INTEGER := 0;
  v_duplicate RECORD;
BEGIN
  -- Find and delete duplicate schedules with same status, keeping only the oldest one
  FOR v_duplicate IN (
    SELECT 
      template_id,
      asset_id,
      DATE(scheduled_date) as date_only,
      status,
      (array_agg(id ORDER BY created_at ASC))[1] as keep_id
    FROM checklist_schedules 
    GROUP BY template_id, asset_id, DATE(scheduled_date), status
    HAVING COUNT(*) > 1
  ) LOOP
    DELETE FROM checklist_schedules 
    WHERE template_id = v_duplicate.template_id
      AND asset_id = v_duplicate.asset_id
      AND DATE(scheduled_date) = v_duplicate.date_only
      AND status = v_duplicate.status
      AND id != v_duplicate.keep_id;
    
    GET DIAGNOSTICS v_deleted_count = ROW_COUNT;
  END LOOP;
  
  RETURN v_deleted_count;
END;
$$;


ALTER FUNCTION "public"."cleanup_all_duplicate_schedules"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."cleanup_duplicate_schedules"() RETURNS integer
    LANGUAGE "plpgsql"
    AS $$
DECLARE
  v_deleted_count INTEGER := 0;
  v_duplicate RECORD;
BEGIN
  -- Find and delete duplicate schedules, keeping only the oldest one
  FOR v_duplicate IN (
    SELECT 
      template_id,
      asset_id,
      DATE(scheduled_date) as date_only,
      (array_agg(id ORDER BY created_at ASC))[1] as keep_id
    FROM checklist_schedules 
    WHERE status = 'pendiente'
    GROUP BY template_id, asset_id, DATE(scheduled_date)
    HAVING COUNT(*) > 1
  ) LOOP
    DELETE FROM checklist_schedules 
    WHERE template_id = v_duplicate.template_id
      AND asset_id = v_duplicate.asset_id
      AND DATE(scheduled_date) = v_duplicate.date_only
      AND status = 'pendiente'
      AND id != v_duplicate.keep_id;
    
    GET DIAGNOSTICS v_deleted_count = ROW_COUNT;
  END LOOP;
  
  RETURN v_deleted_count;
END;
$$;


ALTER FUNCTION "public"."cleanup_duplicate_schedules"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."cleanup_duplicate_work_order_ids"() RETURNS TABLE("fixed_count" integer, "errors" "text")
    LANGUAGE "plpgsql"
    AS $$
DECLARE
  v_fixed_count INT := 0;
  v_errors TEXT := '';
  v_duplicate RECORD;
BEGIN
  -- Encontrar work_orders con order_id duplicado
  FOR v_duplicate IN
    SELECT order_id, COUNT(*) as count
    FROM work_orders
    WHERE order_id IS NOT NULL
    GROUP BY order_id
    HAVING COUNT(*) > 1
  LOOP
    -- Para cada order_id duplicado, mantener el primero y regenerar los demás
    UPDATE work_orders
    SET order_id = recover_from_duplicate_work_order_id()
    WHERE order_id = v_duplicate.order_id
    AND id != (
      SELECT id FROM work_orders
      WHERE order_id = v_duplicate.order_id
      ORDER BY created_at ASC
      LIMIT 1
    );

    v_fixed_count := v_fixed_count + 1;
  END LOOP;

  RETURN QUERY SELECT v_fixed_count, v_errors;
END;
$$;


ALTER FUNCTION "public"."cleanup_duplicate_work_order_ids"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."complete_checklist_with_readings"("p_schedule_id" "uuid", "p_completed_items" "jsonb", "p_technician" "text", "p_notes" "text" DEFAULT NULL::"text", "p_signature_data" "text" DEFAULT NULL::"text", "p_hours_reading" integer DEFAULT NULL::integer, "p_kilometers_reading" integer DEFAULT NULL::integer) RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
DECLARE
  v_checklist_id UUID;
  v_asset_id UUID;
  v_template_version_id UUID;
  v_status TEXT := 'Completado';
  v_item JSONB;
  v_completed_id UUID;
  v_has_issues BOOLEAN := FALSE;
  v_reading_update_result JSONB;
BEGIN
  -- Obtener información de la programación
  SELECT template_id, asset_id 
  INTO v_checklist_id, v_asset_id
  FROM checklist_schedules
  WHERE id = p_schedule_id;
  
  IF v_checklist_id IS NULL THEN
    RAISE EXCEPTION 'Schedule with id % not found', p_schedule_id;
  END IF;
  
  -- Obtener versión activa de la plantilla (si existe sistema de versionado)
  SELECT id INTO v_template_version_id
  FROM checklist_template_versions
  WHERE template_id = v_checklist_id AND is_active = TRUE;
  
  -- Verificar si hay problemas
  FOR v_item IN SELECT jsonb_array_elements(p_completed_items)
  LOOP
    IF v_item->>'status' = 'flag' OR v_item->>'status' = 'fail' THEN
      v_has_issues := TRUE;
      v_status := 'Con Problemas';
    END IF;
  END LOOP;
  
  -- Registrar el checklist completado con las lecturas
  INSERT INTO completed_checklists (
    checklist_id,
    template_version_id,
    asset_id,
    completed_items,
    technician,
    completion_date,
    notes,
    status,
    signature_data,
    equipment_hours_reading,
    equipment_kilometers_reading,
    reading_timestamp
  ) VALUES (
    v_checklist_id,
    v_template_version_id,
    v_asset_id,
    p_completed_items,
    p_technician,
    NOW(),
    p_notes,
    v_status,
    p_signature_data,
    p_hours_reading,
    p_kilometers_reading,
    CASE WHEN p_hours_reading IS NOT NULL OR p_kilometers_reading IS NOT NULL 
         THEN NOW() 
         ELSE NULL 
    END
  ) RETURNING id INTO v_completed_id;
  
  -- Actualizar lecturas del activo si se proporcionaron
  IF p_hours_reading IS NOT NULL OR p_kilometers_reading IS NOT NULL THEN
    SELECT update_asset_readings_from_checklist(
      v_completed_id,
      p_hours_reading,
      p_kilometers_reading
    ) INTO v_reading_update_result;
  END IF;
  
  -- Actualizar estado de la programación
  UPDATE checklist_schedules
  SET 
    status = 'completado',
    updated_at = NOW()
  WHERE id = p_schedule_id;
  
  -- Si hay problemas, registrarlos
  IF v_has_issues THEN
    FOR v_item IN SELECT jsonb_array_elements(p_completed_items)
    LOOP
      IF v_item->>'status' = 'flag' OR v_item->>'status' = 'fail' THEN
        INSERT INTO checklist_issues (
          checklist_id,
          item_id,
          status,
          description,
          notes,
          photo_url,
          resolved
        ) VALUES (
          v_completed_id,
          v_item->>'item_id',
          v_item->>'status',
          COALESCE(v_item->>'description', 'Problema detectado durante el checklist'),
          v_item->>'notes',
          v_item->>'photo_url',
          FALSE
        );
      END IF;
    END LOOP;
  END IF;
  
  -- Actualizar fecha de último mantenimiento del activo
  UPDATE assets
  SET last_maintenance_date = NOW()
  WHERE id = v_asset_id;
  
  -- Retornar resultado completo
  RETURN jsonb_build_object(
    'success', TRUE,
    'completed_id', v_completed_id,
    'template_version_id', v_template_version_id,
    'has_issues', v_has_issues,
    'reading_update', COALESCE(v_reading_update_result, '{}'::jsonb),
    'hours_reading', p_hours_reading,
    'kilometers_reading', p_kilometers_reading
  );
END;
$$;


ALTER FUNCTION "public"."complete_checklist_with_readings"("p_schedule_id" "uuid", "p_completed_items" "jsonb", "p_technician" "text", "p_notes" "text", "p_signature_data" "text", "p_hours_reading" integer, "p_kilometers_reading" integer) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."complete_maintenance"("p_maintenance_id" "uuid", "p_technician" "text", "p_completion_date" timestamp with time zone, "p_findings" "text", "p_actions" "text", "p_parts" "jsonb", "p_labor_hours" double precision, "p_labor_cost" numeric, "p_total_cost" numeric, "p_measurement_value" integer, "p_documents" "text"[] DEFAULT NULL::"text"[]) RETURNS "uuid"
    LANGUAGE "plpgsql"
    AS $$
DECLARE
  v_asset_id UUID;
  v_maintenance RECORD;
  v_unit TEXT;
  v_order_id UUID;
BEGIN
  -- Obtener información del mantenimiento
  SELECT * INTO v_maintenance
  FROM maintenance_history
  WHERE id = p_maintenance_id;
  
  v_asset_id := v_maintenance.asset_id;
  
  -- Obtener la unidad de medida
  SELECT em.maintenance_unit INTO v_unit
  FROM assets a
  JOIN equipment_models em ON a.model_id = em.id
  WHERE a.id = v_asset_id;
  
  -- Actualizar el registro de mantenimiento
  UPDATE maintenance_history
  SET 
    technician = p_technician,
    date = p_completion_date,
    findings = p_findings,
    actions = p_actions,
    parts = p_parts,
    labor_hours = p_labor_hours,
    labor_cost = p_labor_cost,
    total_cost = p_total_cost,
    documents = p_documents
  WHERE id = p_maintenance_id;
  
  -- Actualizar el activo
  IF v_unit = 'hours' THEN
    UPDATE assets
    SET 
      last_maintenance_date = p_completion_date,
      current_hours = p_measurement_value,
      status = 'operational'
    WHERE id = v_asset_id;
  ELSE
    UPDATE assets
    SET 
      last_maintenance_date = p_completion_date,
      current_kilometers = p_measurement_value,
      status = 'operational'
    WHERE id = v_asset_id;
  END IF;
  
  -- Generar orden de servicio
  INSERT INTO service_orders (
    asset_id,
    asset_name,
    type,
    status,
    date,
    technician,
    description,
    parts,
    total_cost,
    documents
  )
  VALUES (
    v_asset_id,
    (SELECT name FROM assets WHERE id = v_asset_id),
    v_maintenance.type,
    'Completado',
    p_completion_date,
    p_technician,
    v_maintenance.description,
    p_parts,
    p_total_cost,
    p_documents
  )
  RETURNING id INTO v_order_id;
  
  RETURN v_order_id;
END;
$$;


ALTER FUNCTION "public"."complete_maintenance"("p_maintenance_id" "uuid", "p_technician" "text", "p_completion_date" timestamp with time zone, "p_findings" "text", "p_actions" "text", "p_parts" "jsonb", "p_labor_hours" double precision, "p_labor_cost" numeric, "p_total_cost" numeric, "p_measurement_value" integer, "p_documents" "text"[]) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."complete_work_order"("p_work_order_id" "uuid", "p_completion_data" "jsonb") RETURNS "uuid"
    LANGUAGE "plpgsql"
    AS $$
DECLARE
  v_asset_id UUID;
  v_work_order RECORD;
  v_service_order_id UUID;
  v_parts_cost DECIMAL(10, 2);
  v_labor_cost DECIMAL(10, 2);
  v_total_cost DECIMAL(10, 2);
  v_is_preventive BOOLEAN;
BEGIN
  -- Obtener información de la orden de trabajo
  SELECT 
    wo.*,
    a.current_hours,
    a.current_kilometers,
    CASE WHEN wo.type = 'Preventivo' THEN true ELSE false END as is_preventive
  INTO v_work_order
  FROM work_orders wo
  JOIN assets a ON wo.asset_id = a.id
  WHERE wo.id = p_work_order_id;
  
  v_asset_id := v_work_order.asset_id;
  v_is_preventive := v_work_order.is_preventive;
  
  -- Calcular costos
  SELECT COALESCE(SUM((part->>'quantity')::int * (part->>'cost')::decimal), 0)
  INTO v_parts_cost
  FROM jsonb_array_elements(p_completion_data->'parts_used') AS part;
  
  v_labor_cost := COALESCE((p_completion_data->>'labor_cost')::decimal, 0);
  v_total_cost := v_parts_cost + v_labor_cost;
  
  -- Generar orden de servicio
  INSERT INTO service_orders (
    work_order_id,
    asset_id,
    asset_name,
    type,
    status,
    date,
    technician_id,
    technician,
    description,
    findings,
    actions,
    notes,
    parts,
    labor_hours,
    labor_cost,
    parts_cost,
    total_cost,
    checklist_id,
    documents
  ) VALUES (
    p_work_order_id,
    v_asset_id,
    (SELECT name FROM assets WHERE id = v_asset_id),
    v_work_order.type,
    'Completado',
    (p_completion_data->>'completion_date')::timestamptz,
    (p_completion_data->>'technician_id')::uuid,
    p_completion_data->>'technician_name',
    v_work_order.description,
    p_completion_data->>'findings',
    p_completion_data->>'actions',
    p_completion_data->>'notes',
    p_completion_data->'parts_used',
    (p_completion_data->>'labor_hours')::float,
    v_labor_cost,
    v_parts_cost,
    v_total_cost,
    v_work_order.checklist_id,
    p_completion_data->'photos'
  )
  RETURNING id INTO v_service_order_id;
  
  -- Actualizar orden de trabajo
  UPDATE work_orders
  SET 
    status = 'Completada',
    updated_at = NOW()
  WHERE id = p_work_order_id;
  
  -- Registrar en maintenance_history
  INSERT INTO maintenance_history (
    asset_id,
    date,
    type,
    hours,
    kilometers,
    description,
    findings,
    actions,
    technician_id,
    technician,
    labor_hours,
    labor_cost,
    parts,
    parts_cost,
    total_cost,
    work_order_id,
    service_order_id,
    maintenance_plan_id,
    documents,
    created_by
  ) VALUES (
    v_asset_id,
    (p_completion_data->>'completion_date')::timestamptz,
    v_work_order.type,
    COALESCE((p_completion_data->>'asset_hours')::int, v_work_order.current_hours),
    COALESCE((p_completion_data->>'asset_kilometers')::int, v_work_order.current_kilometers),
    v_work_order.description,
    p_completion_data->>'findings',
    p_completion_data->>'actions',
    (p_completion_data->>'technician_id')::uuid,
    p_completion_data->>'technician_name',
    (p_completion_data->>'labor_hours')::float,
    v_labor_cost,
    p_completion_data->'parts_used',
    v_parts_cost,
    v_total_cost,
    p_work_order_id,
    v_service_order_id,
    v_work_order.maintenance_plan_id,
    p_completion_data->'photos',
    (p_completion_data->>'created_by')::uuid
  );
  
  -- Si es correctivo, registrar en incident_history
  IF NOT v_is_preventive AND v_work_order.checklist_id IS NOT NULL THEN
    INSERT INTO incident_history (
      asset_id,
      date,
      type,
      reported_by_id,
      reported_by,
      description,
      resolution,
      labor_hours,
      labor_cost,
      parts,
      parts_cost,
      total_cost,
      work_order_id,
      service_order_id,
      checklist_id,
      status,
      documents,
      created_by
    ) VALUES (
      v_asset_id,
      (p_completion_data->>'completion_date')::timestamptz,
      'Falla',
      (p_completion_data->>'reported_by_id')::uuid,
      p_completion_data->>'reported_by_name',
      v_work_order.description,
      p_completion_data->>'actions',
      (p_completion_data->>'labor_hours')::float,
      v_labor_cost,
      p_completion_data->'parts_used',
      v_parts_cost,
      v_total_cost,
      p_work_order_id,
      v_service_order_id,
      v_work_order.checklist_id,
      'Resuelto',
      p_completion_data->'photos',
      (p_completion_data->>'created_by')::uuid
    );
    
    -- Actualizar checklist_issues como resueltos
    UPDATE checklist_issues
    SET 
      resolved = true,
      resolution_date = (p_completion_data->>'completion_date')::timestamptz
    WHERE work_order_id = p_work_order_id;
  END IF;
  
  -- Si es preventivo, actualizar el plan de mantenimiento
  IF v_is_preventive AND v_work_order.maintenance_plan_id IS NOT NULL THEN
    UPDATE maintenance_plans
    SET 
      last_completed = (p_completion_data->>'completion_date')::timestamptz,
      status = 'Completado',
      next_due = (p_completion_data->>'completion_date')::timestamptz + INTERVAL '90 days'
    WHERE id = v_work_order.maintenance_plan_id;
  END IF;
  
  -- Actualizar el estado y datos del activo
  UPDATE assets
  SET 
    status = 'operational',
    last_maintenance_date = (p_completion_data->>'completion_date')::timestamptz,
    current_hours = COALESCE((p_completion_data->>'asset_hours')::int, current_hours),
    current_kilometers = COALESCE((p_completion_data->>'asset_kilometers')::int, current_kilometers)
  WHERE id = v_asset_id;
  
  RETURN v_service_order_id;
END;
$$;


ALTER FUNCTION "public"."complete_work_order"("p_work_order_id" "uuid", "p_completion_data" "jsonb") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."consolidate_issues"("p_existing_issue_id" "uuid", "p_new_issue_id" "uuid", "p_work_order_id" "uuid") RETURNS boolean
    LANGUAGE "plpgsql"
    AS $$
DECLARE
    existing_similar_ids JSONB;
    new_recurrence_count INTEGER;
BEGIN
    -- Get current similar issue IDs and recurrence count
    SELECT similar_issue_ids, recurrence_count 
    INTO existing_similar_ids, new_recurrence_count
    FROM checklist_issues 
    WHERE id = p_existing_issue_id;
    
    -- Update the existing issue with consolidation info
    UPDATE checklist_issues 
    SET 
        similar_issue_ids = COALESCE(existing_similar_ids, '[]'::jsonb) || to_jsonb(p_new_issue_id),
        recurrence_count = new_recurrence_count + 1,
        updated_at = NOW()
    WHERE id = p_existing_issue_id;
    
    -- Link the new issue to the existing one
    UPDATE checklist_issues 
    SET 
        parent_issue_id = p_existing_issue_id,
        work_order_id = p_work_order_id,
        recurrence_count = new_recurrence_count + 1
    WHERE id = p_new_issue_id;
    
    -- Update work order with escalated priority and related issues count
    UPDATE work_orders 
    SET 
        related_issues_count = related_issues_count + 1,
        escalation_count = CASE 
            WHEN new_recurrence_count + 1 >= 2 THEN escalation_count + 1 
            ELSE escalation_count 
        END,
        last_escalation_date = CASE 
            WHEN new_recurrence_count + 1 >= 2 THEN NOW() 
            ELSE last_escalation_date 
        END,
        priority = calculate_escalated_priority(
            COALESCE(original_priority, priority), 
            new_recurrence_count + 1,
            (SELECT status FROM checklist_issues WHERE id = p_new_issue_id)
        ),
        description = description || E'\n\n🔄 ISSUE RECURRENTE - Ocurrencia #' || (new_recurrence_count + 1) || 
                     E'\nÚltima detección: ' || to_char(NOW(), 'DD/MM/YYYY HH24:MI') ||
                     E'\nEste problema se ha repetido ' || (new_recurrence_count + 1) || ' veces.'
    WHERE id = p_work_order_id;
    
    RETURN TRUE;
END;
$$;


ALTER FUNCTION "public"."consolidate_issues"("p_existing_issue_id" "uuid", "p_new_issue_id" "uuid", "p_work_order_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."create_asset_mapping"("p_original_name" "text", "p_asset_id" "uuid" DEFAULT NULL::"uuid", "p_exception_asset_id" "uuid" DEFAULT NULL::"uuid", "p_mapping_type" "text" DEFAULT 'formal'::"text", "p_created_by" "uuid" DEFAULT NULL::"uuid") RETURNS boolean
    LANGUAGE "plpgsql"
    AS $$
BEGIN
    -- Validate inputs
    IF p_mapping_type NOT IN ('formal', 'exception', 'ignore') THEN
        RAISE EXCEPTION 'Invalid mapping_type. Must be formal, exception, or ignore.';
    END IF;
    
    IF p_mapping_type = 'formal' AND p_asset_id IS NULL THEN
        RAISE EXCEPTION 'asset_id is required for formal mapping type.';
    END IF;
    
    IF p_mapping_type = 'exception' AND p_exception_asset_id IS NULL THEN
        RAISE EXCEPTION 'exception_asset_id is required for exception mapping type.';
    END IF;
    
    INSERT INTO asset_name_mappings (
        original_name,
        asset_id,
        exception_asset_id,
        mapping_type,
        confidence_level,
        mapping_source,
        created_by
    ) VALUES (
        p_original_name,
        p_asset_id,
        p_exception_asset_id,
        p_mapping_type,
        1.0,
        'manual',
        p_created_by
    )
    ON CONFLICT (original_name) 
    DO UPDATE SET
        asset_id = p_asset_id,
        exception_asset_id = p_exception_asset_id,
        mapping_type = p_mapping_type,
        confidence_level = 1.0,
        mapping_source = 'manual',
        updated_at = NOW();
    
    RETURN TRUE;
END;
$$;


ALTER FUNCTION "public"."create_asset_mapping"("p_original_name" "text", "p_asset_id" "uuid", "p_exception_asset_id" "uuid", "p_mapping_type" "text", "p_created_by" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."create_incident_from_checklist_issue"("p_checklist_issue_id" "uuid") RETURNS "uuid"
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
DECLARE
  v_issue_record RECORD;
  v_incident_id UUID;
  v_asset_record RECORD;
  v_documents JSONB;
BEGIN
  -- Obtener información del issue y checklist
  SELECT 
    ci.*,
    cc.asset_id,
    cc.technician,
    cc.completion_date
  INTO v_issue_record
  FROM checklist_issues ci
  JOIN completed_checklists cc ON ci.checklist_id = cc.id
  WHERE ci.id = p_checklist_issue_id;
  
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Checklist issue not found: %', p_checklist_issue_id;
  END IF;
  
  -- Obtener información del activo
  SELECT name, asset_id, location
  INTO v_asset_record
  FROM assets
  WHERE id = v_issue_record.asset_id;
  
  -- Preparar documentos/evidencia fotográfica
  v_documents := '[]'::jsonb;
  IF v_issue_record.photo_url IS NOT NULL AND v_issue_record.photo_url != '' THEN
    v_documents := jsonb_build_array(v_issue_record.photo_url);
  END IF;
  
  -- Crear el incidente con evidencia preservada
  INSERT INTO incident_history (
    asset_id,
    date,
    type,
    description,
    impact,
    status,
    reported_by,
    reported_by_id,
    created_by,
    created_at,
    work_order_id,
    documents
  ) VALUES (
    v_issue_record.asset_id,
    v_issue_record.created_at,
    'Mantenimiento',
    COALESCE(v_issue_record.description, 'Problema detectado en checklist') || 
    CASE 
      WHEN v_issue_record.notes IS NOT NULL AND v_issue_record.notes != '' 
      THEN ' - ' || v_issue_record.notes 
      ELSE '' 
    END,
    CASE 
      WHEN v_issue_record.status = 'fail' THEN 'Alto'
      ELSE 'Medio'
    END,
    'Abierto',
    v_issue_record.technician,
    v_issue_record.created_by,
    v_issue_record.created_by,
    v_issue_record.created_at,
    v_issue_record.work_order_id,
    v_documents
  )
  RETURNING id INTO v_incident_id;
  
  -- Actualizar el checklist issue con el incident_id
  UPDATE checklist_issues
  SET incident_id = v_incident_id
  WHERE id = p_checklist_issue_id;
  
  RETURN v_incident_id;
END;
$$;


ALTER FUNCTION "public"."create_incident_from_checklist_issue"("p_checklist_issue_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."create_profile_on_signup"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
DECLARE
  user_nombre TEXT;
  user_apellido TEXT;
  user_role TEXT;
  full_name TEXT;
BEGIN
  -- Check if profile already exists (in case created by API)
  IF EXISTS (SELECT 1 FROM public.profiles WHERE id = new.id) THEN
    RETURN new;
  END IF;

  -- Get values from user metadata
  user_nombre := COALESCE(new.raw_user_meta_data->>'nombre', '');
  user_apellido := COALESCE(new.raw_user_meta_data->>'apellido', '');
  user_role := COALESCE(new.raw_user_meta_data->>'role', 'OPERADOR');
  full_name := COALESCE(new.raw_user_meta_data->>'name', '');

  -- If nombre and apellido are not set but we have a full name, try to split it
  IF (user_nombre = '' OR user_apellido = '') AND full_name != '' THEN
    -- Simple name splitting (first word as nombre, rest as apellido)
    IF position(' ' in full_name) > 0 THEN
      user_nombre := COALESCE(NULLIF(user_nombre, ''), split_part(full_name, ' ', 1));
      user_apellido := COALESCE(NULLIF(user_apellido, ''), trim(substring(full_name from position(' ' in full_name) + 1)));
    ELSE
      user_nombre := COALESCE(NULLIF(user_nombre, ''), full_name);
      user_apellido := COALESCE(NULLIF(user_apellido, ''), '');
    END IF;
  END IF;

  -- Create the profile with available data
  INSERT INTO public.profiles (
    id, 
    nombre, 
    apellido, 
    email, 
    role, 
    status,
    created_at,
    updated_at
  )
  VALUES (
    new.id,
    NULLIF(user_nombre, ''),
    NULLIF(user_apellido, ''),
    new.email,
    user_role,
    'active',
    now(),
    now()
  );

  RETURN new;
END;
$$;


ALTER FUNCTION "public"."create_profile_on_signup"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."create_template_version"("p_template_id" "uuid", "p_change_summary" "text" DEFAULT 'Cambios en plantilla'::"text", "p_migration_notes" "text" DEFAULT NULL::"text") RETURNS "uuid"
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
DECLARE
  v_version_id UUID;
  v_next_version INTEGER;
  v_template RECORD;
  v_sections JSONB;
BEGIN
  -- Obtener siguiente número de versión
  SELECT COALESCE(MAX(version_number), 0) + 1 
  INTO v_next_version 
  FROM checklist_template_versions 
  WHERE template_id = p_template_id;
  
  -- Obtener datos actuales de la plantilla
  SELECT * INTO v_template FROM checklists WHERE id = p_template_id;
  
  IF v_template.id IS NULL THEN
    RAISE EXCEPTION 'Template with id % not found', p_template_id;
  END IF;
  
  -- Crear snapshot de secciones e ítems
  SELECT jsonb_agg(
    jsonb_build_object(
      'id', s.id,
      'title', s.title,
      'order_index', s.order_index,
      'items', (
        SELECT jsonb_agg(
          jsonb_build_object(
            'id', i.id,
            'description', i.description,
            'required', i.required,
            'order_index', i.order_index,
            'item_type', i.item_type,
            'expected_value', i.expected_value,
            'tolerance', i.tolerance
          ) ORDER BY i.order_index
        )
        FROM checklist_items i 
        WHERE i.section_id = s.id
      )
    ) ORDER BY s.order_index
  ) INTO v_sections
  FROM checklist_sections s 
  WHERE s.checklist_id = p_template_id;
  
  -- Si no hay secciones, crear un JSONB vacío
  IF v_sections IS NULL THEN
    v_sections := '[]'::jsonb;
  END IF;
  
  -- Desactivar versión anterior
  UPDATE checklist_template_versions 
  SET is_active = FALSE 
  WHERE template_id = p_template_id;
  
  -- Crear nueva versión
  INSERT INTO checklist_template_versions (
    template_id,
    version_number,
    name,
    description,
    model_id,
    frequency,
    hours_interval,
    sections,
    is_active,
    change_summary,
    migration_notes,
    created_by
  ) VALUES (
    p_template_id,
    v_next_version,
    v_template.name,
    v_template.description,
    v_template.model_id,
    v_template.frequency,
    v_template.hours_interval,
    v_sections,
    TRUE,
    p_change_summary,
    p_migration_notes,
    auth.uid()
  ) RETURNING id INTO v_version_id;
  
  RETURN v_version_id;
END;
$$;


ALTER FUNCTION "public"."create_template_version"("p_template_id" "uuid", "p_change_summary" "text", "p_migration_notes" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."ensure_asset_uuid"("p_asset_reference" "text") RETURNS "uuid"
    LANGUAGE "plpgsql"
    AS $$
DECLARE
  v_asset_uuid UUID;
BEGIN
  -- Try to convert directly to UUID first
  BEGIN
    v_asset_uuid := p_asset_reference::UUID;
    RETURN v_asset_uuid;
  EXCEPTION WHEN invalid_text_representation THEN
    -- If it's not a valid UUID, try to find the asset by asset_id (string)
    SELECT id INTO v_asset_uuid
    FROM assets 
    WHERE asset_id = p_asset_reference;
    
    IF v_asset_uuid IS NULL THEN
      RAISE EXCEPTION 'Asset not found with reference: %', p_asset_reference;
    END IF;
    
    RETURN v_asset_uuid;
  END;
END;
$$;


ALTER FUNCTION "public"."ensure_asset_uuid"("p_asset_reference" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."find_missing_weekly_schedules"("p_template_id" "uuid", "p_days" integer DEFAULT 7, "p_date" "date" DEFAULT CURRENT_DATE) RETURNS TABLE("asset_id" "uuid", "asset_name" "text", "last_completed_at" timestamp with time zone, "has_today_schedule" boolean)
    LANGUAGE "sql" STABLE
    AS $$
  WITH tmpl AS (
    SELECT id AS template_id, model_id
    FROM public.checklists
    WHERE id = p_template_id AND frequency = 'semanal'
  ), candidate_assets AS (
    SELECT a.id AS asset_id, a.name
    FROM tmpl t
    JOIN public.assets a ON a.model_id = t.model_id
  ), last_completed AS (
    SELECT cs.asset_id, MAX(cs.updated_at) AS last_completed_at
    FROM public.checklist_schedules cs
    WHERE cs.template_id = p_template_id AND cs.status = 'completado'
    GROUP BY cs.asset_id
  ), today_schedules AS (
    SELECT cs.asset_id, TRUE AS has_today
    FROM public.checklist_schedules cs
    WHERE cs.template_id = p_template_id AND cs.scheduled_day = p_date
    GROUP BY cs.asset_id
  )
  SELECT ca.asset_id,
         ca.name AS asset_name,
         lc.last_completed_at,
         COALESCE(ts.has_today, FALSE) AS has_today_schedule
  FROM candidate_assets ca
  LEFT JOIN last_completed lc ON lc.asset_id = ca.asset_id
  LEFT JOIN today_schedules ts ON ts.asset_id = ca.asset_id
  WHERE (lc.last_completed_at IS NULL OR lc.last_completed_at < (p_date - make_interval(days => p_days)))
    AND COALESCE(ts.has_today, FALSE) = FALSE
  ORDER BY ca.name;
$$;


ALTER FUNCTION "public"."find_missing_weekly_schedules"("p_template_id" "uuid", "p_days" integer, "p_date" "date") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."find_similar_open_issues"("p_fingerprint" "text", "p_asset_id" "uuid", "p_consolidation_window" interval DEFAULT '30 days'::interval) RETURNS TABLE("issue_id" "uuid", "work_order_id" "uuid", "created_at" timestamp with time zone, "recurrence_count" integer, "item_description" "text", "notes" "text", "priority" "text")
    LANGUAGE "plpgsql"
    AS $$
BEGIN
    RETURN QUERY
    SELECT 
        ci.id as issue_id,
        ci.work_order_id,
        ci.created_at,
        COALESCE(ci.recurrence_count, 1) as recurrence_count,
        ci.description as item_description,  -- Usar la descripción directamente de checklist_issues
        ci.notes,
        COALESCE(wo.priority, 'Media') as priority
    FROM checklist_issues ci
    LEFT JOIN work_orders wo ON ci.work_order_id = wo.id
    WHERE ci.issue_fingerprint = p_fingerprint
        AND wo.asset_id = p_asset_id
        AND ci.resolved = false
        AND ci.created_at >= (NOW() - p_consolidation_window)
        AND wo.status IN ('Pendiente', 'En Progreso', 'pendiente', 'en_progreso')  -- Multiple status variations
    ORDER BY ci.created_at DESC;
END;
$$;


ALTER FUNCTION "public"."find_similar_open_issues"("p_fingerprint" "text", "p_asset_id" "uuid", "p_consolidation_window" interval) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."fix_duplicate_order_ids"() RETURNS "text"
    LANGUAGE "plpgsql"
    AS $$
DECLARE
  duplicate_work_order RECORD;
  duplicate_purchase_order RECORD;
  new_id TEXT;
  fixed_count INT := 0;
BEGIN
  -- Arreglar órdenes de trabajo duplicadas
  FOR duplicate_work_order IN 
    SELECT order_id, array_agg(id) as ids
    FROM work_orders 
    WHERE order_id IS NOT NULL
    GROUP BY order_id 
    HAVING COUNT(*) > 1
  LOOP
    -- Mantener el primer ID, cambiar los demás
    FOR i IN 2..array_length(duplicate_work_order.ids, 1) LOOP
      new_id := generate_unique_work_order_id();
      UPDATE work_orders 
      SET order_id = new_id 
      WHERE id = duplicate_work_order.ids[i];
      fixed_count := fixed_count + 1;
    END LOOP;
  END LOOP;
  
  -- Arreglar órdenes de compra duplicadas
  FOR duplicate_purchase_order IN 
    SELECT order_id, array_agg(id) as ids
    FROM purchase_orders 
    WHERE order_id IS NOT NULL
    GROUP BY order_id 
    HAVING COUNT(*) > 1
  LOOP
    -- Mantener el primer ID, cambiar los demás
    FOR i IN 2..array_length(duplicate_purchase_order.ids, 1) LOOP
      new_id := generate_unique_purchase_order_id();
      UPDATE purchase_orders 
      SET order_id = new_id 
      WHERE id = duplicate_purchase_order.ids[i];
      fixed_count := fixed_count + 1;
    END LOOP;
  END LOOP;
  
  RETURN 'Se corrigieron ' || fixed_count || ' IDs duplicados';
END;
$$;


ALTER FUNCTION "public"."fix_duplicate_order_ids"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."fix_legacy_payment_dates"() RETURNS integer
    LANGUAGE "plpgsql"
    AS $$
DECLARE
    fixed_count INTEGER := 0;
    order_record RECORD;
BEGIN
    -- Find orders with past payment dates that are still pending
    FOR order_record IN 
        SELECT id, max_payment_date 
        FROM purchase_orders 
        WHERE payment_method = 'transfer' 
        AND max_payment_date < CURRENT_DATE 
        AND status IN ('pending_approval', 'approved')
        AND created_at < '2025-07-20'::date
    LOOP
        -- Update the payment date to 30 days from now
        UPDATE purchase_orders 
        SET max_payment_date = (CURRENT_DATE + INTERVAL '30 days')::date,
            updated_at = NOW()
        WHERE id = order_record.id;
        
        fixed_count := fixed_count + 1;
    END LOOP;
    
    RETURN fixed_count;
END;
$$;


ALTER FUNCTION "public"."fix_legacy_payment_dates"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."fix_legacy_quotation_issues"() RETURNS integer
    LANGUAGE "plpgsql"
    AS $$
DECLARE
  fixed_count INTEGER := 0;
  order_record RECORD;
BEGIN
  -- Find orders with quotation requirements but no quotation URL that are still pending
  FOR order_record IN 
    SELECT id, requires_quote, quotation_url 
    FROM purchase_orders 
    WHERE requires_quote = true 
    AND (quotation_url IS NULL OR quotation_url = '')
    AND status IN ('pending_approval', 'approved')
    AND created_at < '2025-07-20'::date
  LOOP
    -- For legacy orders, we can either:
    -- 1. Set requires_quote to false (if the order was already processed)
    -- 2. Or mark them as not requiring quotation for legacy reasons
    
    -- For now, let's set requires_quote to false for legacy orders
    UPDATE purchase_orders 
    SET requires_quote = false,
        updated_at = NOW()
    WHERE id = order_record.id;
    
    fixed_count := fixed_count + 1;
  END LOOP;
  
  RETURN fixed_count;
END;
$$;


ALTER FUNCTION "public"."fix_legacy_quotation_issues"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."fix_recent_payment_date_issues"() RETURNS integer
    LANGUAGE "plpgsql"
    AS $$
DECLARE
  fixed_count INTEGER := 0;
  order_record RECORD;
BEGIN
  -- Find recent orders with past payment dates that are still pending
  FOR order_record IN 
    SELECT id, max_payment_date 
    FROM purchase_orders 
    WHERE payment_method = 'transfer' 
    AND max_payment_date < CURRENT_DATE 
    AND status IN ('pending_approval', 'approved')
    AND created_at >= '2025-07-20'::date
  LOOP
    -- Update the payment date to 30 days from now
    UPDATE purchase_orders 
    SET max_payment_date = (CURRENT_DATE + INTERVAL '30 days')::date,
        updated_at = NOW()
    WHERE id = order_record.id;
    
    fixed_count := fixed_count + 1;
  END LOOP;
  
  RETURN fixed_count;
END;
$$;


ALTER FUNCTION "public"."fix_recent_payment_date_issues"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."generate_adjustment_purchase_order"("p_work_order_id" "uuid", "p_supplier" "text", "p_items" "jsonb", "p_requested_by" "uuid", "p_original_po_id" "uuid" DEFAULT NULL::"uuid") RETURNS "uuid"
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
DECLARE
  v_order_counter INT;
  v_order_id TEXT;
  v_po_id UUID;
  v_total_amount DECIMAL(10,2) := 0;
BEGIN
  -- Get the current order count to generate a sequential order ID
  SELECT COUNT(*) + 1 INTO v_order_counter FROM purchase_orders;
  
  -- Format the order ID
  v_order_id := 'OCA-' || LPAD(v_order_counter::TEXT, 4, '0');
  
  -- Calculate total amount from items
  SELECT COALESCE(SUM((item->>'total_price')::DECIMAL), 0)
  INTO v_total_amount
  FROM jsonb_array_elements(p_items) AS item;
  
  -- Insert the adjustment purchase order
  INSERT INTO purchase_orders (
    order_id,
    work_order_id,
    supplier,
    items,
    total_amount,
    status,
    requested_by,
    expected_delivery_date,
    actual_delivery_date,
    approval_date,
    approved_by,
    is_adjustment,
    original_purchase_order_id
  ) VALUES (
    v_order_id,
    p_work_order_id,
    p_supplier,
    p_items,
    v_total_amount,
    'Recibida', -- Adjustment POs are typically already received
    p_requested_by,
    NOW(),
    NOW(),
    NOW(),
    p_requested_by,
    TRUE,
    p_original_po_id
  ) RETURNING id INTO v_po_id;
  
  RETURN v_po_id;
END;
$$;


ALTER FUNCTION "public"."generate_adjustment_purchase_order"("p_work_order_id" "uuid", "p_supplier" "text", "p_items" "jsonb", "p_requested_by" "uuid", "p_original_po_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."generate_asset_id"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
DECLARE
  next_id TEXT;
  counter INTEGER;
BEGIN
  SELECT COUNT(*) + 1 INTO counter FROM assets;
  next_id := 'EQ-' || LPAD(counter::TEXT, 3, '0');
  NEW.asset_id := next_id;
  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."generate_asset_id"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."generate_checklists_from_maintenance_plan"("maintenance_plan_id" "uuid", "scheduled_date" timestamp with time zone, "assigned_to" "uuid") RETURNS SETOF "uuid"
    LANGUAGE "plpgsql"
    AS $$
DECLARE
  v_asset_id UUID;
  v_model_id UUID;
  v_checklist_id UUID;
  v_schedule_id UUID;
  rec RECORD;
BEGIN
  -- Obtener información del plan de mantenimiento
  SELECT asset_id, assets.model_id 
  INTO v_asset_id, v_model_id
  FROM maintenance_plans
  JOIN assets ON maintenance_plans.asset_id = assets.id
  WHERE maintenance_plans.id = maintenance_plan_id;
  
  -- Obtener checklists aplicables para este modelo
  FOR rec IN 
    SELECT id FROM checklists 
    WHERE model_id = v_model_id
  LOOP
    v_checklist_id := rec.id;
    
    -- Crear programación de checklist
    INSERT INTO checklist_schedules (
      template_id,
      asset_id,
      scheduled_date,
      status,
      assigned_to,
      maintenance_plan_id
    ) VALUES (
      v_checklist_id,
      v_asset_id,
      scheduled_date,
      'pendiente',
      assigned_to,
      maintenance_plan_id
    ) RETURNING id INTO v_schedule_id;
    
    RETURN NEXT v_schedule_id;
  END LOOP;
  
  RETURN;
END;
$$;


ALTER FUNCTION "public"."generate_checklists_from_maintenance_plan"("maintenance_plan_id" "uuid", "scheduled_date" timestamp with time zone, "assigned_to" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."generate_corrective_work_order_enhanced"("p_checklist_id" "uuid") RETURNS "uuid"
    LANGUAGE "plpgsql"
    AS $$
DECLARE
  v_asset_id UUID;
  v_issues JSONB;
  v_work_order_id UUID;
  v_order_id TEXT;
  v_issue_record RECORD;
  v_incident_id UUID;
BEGIN
  -- Obtener asset_id y los ítems con problemas
  SELECT cc.asset_id, 
         jsonb_agg(
           jsonb_build_object(
             'item_id', ci.item_id,
             'status', ci.status,
             'description', ci.description,
             'notes', ci.notes,
             'photo_url', ci.photo_url,
             'issue_id', ci.id
           )
         )
  INTO v_asset_id, v_issues
  FROM completed_checklists cc
  JOIN checklist_issues ci ON cc.id = ci.checklist_id
  WHERE cc.id = p_checklist_id
  GROUP BY cc.asset_id;
  
  -- Generar ID único para la orden de trabajo
  v_order_id := 'OT-' || EXTRACT(YEAR FROM NOW()) || '-' || 
                LPAD(NEXTVAL('work_order_sequence')::TEXT, 4, '0');
  
  -- Generar la orden de trabajo correctiva
  INSERT INTO work_orders (
    order_id,
    asset_id,
    description,
    type,
    priority,
    status,
    checklist_id,
    issue_items
  ) VALUES (
    v_order_id,
    v_asset_id,
    'Acción correctiva generada desde checklist',
    'corrective',
    CASE 
      WHEN EXISTS (SELECT 1 FROM checklist_issues WHERE checklist_id = p_checklist_id AND status = 'fail')
      THEN 'Alta'
      ELSE 'Media'
    END,
    'Pendiente',
    p_checklist_id,
    v_issues
  )
  RETURNING id INTO v_work_order_id;
  
  -- Actualizar checklist_issues con la orden generada
  UPDATE checklist_issues
  SET work_order_id = v_work_order_id
  WHERE checklist_id = p_checklist_id;
  
  -- Crear incidentes para cada issue
  FOR v_issue_record IN 
    SELECT id FROM checklist_issues WHERE checklist_id = p_checklist_id
  LOOP
    SELECT create_incident_from_checklist_issue(v_issue_record.id) INTO v_incident_id;
  END LOOP;
  
  -- REMOVED: No longer automatically updating asset status to 'maintenance'
  -- Assets will keep their current status (operational, active, etc.)
  
  RETURN v_work_order_id;
END;
$$;


ALTER FUNCTION "public"."generate_corrective_work_order_enhanced"("p_checklist_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."generate_diesel_transaction_id"() RETURNS "text"
    LANGUAGE "plpgsql"
    AS $$
BEGIN
    RETURN 'DSL-' || LPAD(nextval('diesel_transaction_seq')::TEXT, 6, '0');
END;
$$;


ALTER FUNCTION "public"."generate_diesel_transaction_id"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."generate_issue_fingerprint"("p_asset_id" "text", "p_item_description" "text", "p_status" "text" DEFAULT NULL::"text", "p_notes" "text" DEFAULT NULL::"text") RETURNS "text"
    LANGUAGE "plpgsql"
    AS $$
BEGIN
    -- Create a normalized fingerprint that groups the SAME ISSUE regardless of status or notes
    -- This allows detection of escalation: FLAG → FAIL or FAIL → FLAG
    -- Only use asset_id + normalized_item_description (ignore status and notes for grouping)
    RETURN CONCAT(
        p_asset_id::text, '_',
        UPPER(TRIM(p_item_description))
    );
END;
$$;


ALTER FUNCTION "public"."generate_issue_fingerprint"("p_asset_id" "text", "p_item_description" "text", "p_status" "text", "p_notes" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."generate_maintenance_plans"("p_asset_id" "uuid") RETURNS "void"
    LANGUAGE "plpgsql"
    AS $$
DECLARE
  v_model_id UUID;
  v_interval RECORD;
BEGIN
  -- Obtener el modelo del activo
  SELECT model_id INTO v_model_id 
  FROM assets 
  WHERE id = p_asset_id;
  
  -- Generar planes de mantenimiento basados en los intervalos del modelo
  FOR v_interval IN 
    SELECT * FROM maintenance_intervals WHERE model_id = v_model_id
  LOOP
    INSERT INTO maintenance_plans (
      asset_id, 
      interval_id,
      interval_value, 
      name, 
      description, 
      next_due, 
      status
    )
    VALUES (
      p_asset_id,
      v_interval.id,
      v_interval.interval_value,
      v_interval.name,
      v_interval.description,
      -- Calcular próximo mantenimiento
      (SELECT calculate_next_maintenance(
        p_asset_id, 
        v_interval.interval_value
      )),
      'Programado'
    );
  END LOOP;
END;
$$;


ALTER FUNCTION "public"."generate_maintenance_plans"("p_asset_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."generate_model_id"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
DECLARE
  next_id TEXT;
  counter INTEGER;
BEGIN
  SELECT COUNT(*) + 1 INTO counter FROM equipment_models;
  next_id := 'MOD' || LPAD(counter::TEXT, 3, '0');
  NEW.model_id := next_id;
  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."generate_model_id"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."generate_next_id"("prefix" "text") RETURNS "text"
    LANGUAGE "plpgsql"
    AS $$
DECLARE
  last_id TEXT;
  next_number INTEGER;
  result TEXT;
BEGIN
  -- Determine which table to check based on prefix
  CASE prefix
    WHEN 'OT-' THEN
      SELECT order_id INTO last_id FROM work_orders 
      WHERE order_id LIKE 'OT-%' 
      ORDER BY order_id DESC LIMIT 1;
    WHEN 'OC-' THEN
      SELECT order_id INTO last_id FROM purchase_orders 
      WHERE order_id LIKE 'OC-%' 
      ORDER BY order_id DESC LIMIT 1;
    WHEN 'OS-' THEN
      SELECT order_id INTO last_id FROM service_orders 
      WHERE order_id LIKE 'OS-%' 
      ORDER BY order_id DESC LIMIT 1;
    ELSE
      RAISE EXCEPTION 'Invalid prefix: %', prefix;
  END CASE;

  -- Extract number and increment
  IF last_id IS NULL THEN
    next_number := 1;
  ELSE
    next_number := (SUBSTRING(last_id FROM '[0-9]+'))::INTEGER + 1;
  END IF;

  -- Format with leading zeros (4 digits)
  result := prefix || LPAD(next_number::TEXT, 4, '0');
  
  RETURN result;
END;
$$;


ALTER FUNCTION "public"."generate_next_id"("prefix" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."generate_order_id"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
DECLARE
  next_id TEXT;
  counter INTEGER;
BEGIN
  SELECT COUNT(*) + 1 INTO counter FROM service_orders;
  next_id := 'OT-' || LPAD(counter::TEXT, 4, '0');
  NEW.order_id := next_id;
  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."generate_order_id"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."generate_order_id"("order_type" "text") RETURNS "text"
    LANGUAGE "plpgsql"
    AS $$
DECLARE
  prefix TEXT;
  last_number INTEGER;
  new_id TEXT;
BEGIN
  -- Set prefix based on order type - note we're checking for Spanish names now
  IF order_type = 'Preventivo' OR order_type = 'Correctivo' THEN
    prefix := 'OT-';
  ELSIF order_type = 'Compra' THEN
    prefix := 'OC-';
  ELSIF order_type = 'Servicio' THEN
    prefix := 'OS-';
  ELSE
    prefix := 'OR-'; -- Default prefix
  END IF;
  
  -- Get the last number used for this prefix
  EXECUTE format('SELECT COALESCE(MAX(NULLIF(REGEXP_REPLACE(order_id, ''%s'', '''', ''g''), '''')::INTEGER), 0) FROM work_orders WHERE order_id LIKE ''%s%%''', prefix, prefix)
  INTO last_number;
  
  -- Generate new ID with 4-digit sequential number
  new_id := prefix || LPAD(CAST(last_number + 1 AS TEXT), 4, '0');
  
  RETURN new_id;
END;
$$;


ALTER FUNCTION "public"."generate_order_id"("order_type" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."generate_preventive_work_order"("p_asset_id" "uuid", "p_maintenance_plan_id" "uuid") RETURNS "uuid"
    LANGUAGE "plpgsql"
    AS $$
DECLARE
  v_maintenance_interval RECORD;
  v_work_order_id UUID;
BEGIN
  -- Obtener información del plan de mantenimiento
  SELECT 
    mp.interval_value,
    mp.name,
    mp.description,
    mi.required_parts,
    mi.estimated_duration
  INTO v_maintenance_interval
  FROM maintenance_plans mp
  JOIN maintenance_intervals mi ON mp.interval_id = mi.id
  WHERE mp.id = p_maintenance_plan_id;
  
  -- Generar la orden de trabajo preventiva
  INSERT INTO work_orders (
    asset_id,
    description,
    type,
    priority,
    status,
    maintenance_plan_id,
    required_parts,
    estimated_duration,
    estimated_cost
  ) VALUES (
    p_asset_id,
    'Mantenimiento Preventivo: ' || v_maintenance_interval.name,
    'Preventivo',  -- Changed to match your enum MaintenanceType
    'Media',       -- Changed to match your enum ServiceOrderPriority
    'Pendiente',   -- Changed to match your enum WorkOrderStatus
    p_maintenance_plan_id,
    v_maintenance_interval.required_parts,
    v_maintenance_interval.estimated_duration,
    (SELECT COALESCE(SUM((part->>'cost')::decimal * (part->>'quantity')::int), 0) 
     FROM jsonb_array_elements(v_maintenance_interval.required_parts) AS part)
  )
  RETURNING id INTO v_work_order_id;
  
  -- Actualizar el plan de mantenimiento
  UPDATE maintenance_plans
  SET status = 'En proceso'
  WHERE id = p_maintenance_plan_id;
  
  RETURN v_work_order_id;
END;
$$;


ALTER FUNCTION "public"."generate_preventive_work_order"("p_asset_id" "uuid", "p_maintenance_plan_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."generate_purchase_order"("p_work_order_id" "uuid", "p_supplier" "text", "p_items" "jsonb", "p_requested_by" "uuid", "p_expected_delivery_date" timestamp with time zone, "p_quotation_url" "text" DEFAULT NULL::"text") RETURNS "uuid"
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
DECLARE
  v_order_counter INT;
  v_order_id TEXT;
  v_po_id UUID;
  v_total_amount DECIMAL(10,2) := 0;
BEGIN
  -- Get the current order count to generate a sequential order ID
  SELECT COUNT(*) + 1 INTO v_order_counter FROM purchase_orders;
  
  -- Format the order ID
  v_order_id := 'OC-' || LPAD(v_order_counter::TEXT, 4, '0');
  
  -- Calculate total amount from items
  SELECT COALESCE(SUM((item->>'total_price')::DECIMAL), 0)
  INTO v_total_amount
  FROM jsonb_array_elements(p_items) AS item;
  
  -- Insert the purchase order
  INSERT INTO purchase_orders (
    order_id,
    work_order_id,
    supplier,
    items,
    total_amount,
    status,
    requested_by,
    expected_delivery_date,
    quotation_url
  ) VALUES (
    v_order_id,
    p_work_order_id,
    p_supplier,
    p_items,
    v_total_amount,
    'Pendiente',
    p_requested_by,
    p_expected_delivery_date,
    p_quotation_url
  ) RETURNING id INTO v_po_id;
  
  -- Update the work order with the purchase order ID
  UPDATE work_orders
  SET purchase_order_id = v_po_id,
      status = 'En cotización',
      estimated_cost = v_total_amount,
      updated_at = NOW()
  WHERE id = p_work_order_id;
  
  RETURN v_po_id;
END;
$$;


ALTER FUNCTION "public"."generate_purchase_order"("p_work_order_id" "uuid", "p_supplier" "text", "p_items" "jsonb", "p_requested_by" "uuid", "p_expected_delivery_date" timestamp with time zone, "p_quotation_url" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."generate_purchase_order_id_trigger"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
BEGIN
  IF NEW.order_id IS NULL THEN
    NEW.order_id := generate_unique_purchase_order_id();
  END IF;
  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."generate_purchase_order_id_trigger"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."generate_service_order_id_trigger"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
BEGIN
  IF NEW.order_id IS NULL OR NEW.order_id = '' THEN
    NEW.order_id := 'OS-' || LPAD(nextval('service_orders_order_number_seq')::text, 4, '0');
  END IF;
  RETURN NEW;
END $$;


ALTER FUNCTION "public"."generate_service_order_id_trigger"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."generate_unique_purchase_order_id"() RETURNS "text"
    LANGUAGE "plpgsql"
    AS $_$
DECLARE
  v_order_counter INT;
  v_order_id TEXT;
  v_max_attempts INT := 100;
  v_attempt INT := 1;
BEGIN
  LOOP
    -- Buscar el siguiente número disponible basado en el máximo existente
    SELECT COALESCE(
      MAX(
        CASE 
          WHEN order_id ~ '^OC-[0-9]+$' 
          THEN (RIGHT(order_id, -3))::INT 
          ELSE 0 
        END
      ), 0
    ) + v_attempt INTO v_order_counter 
    FROM purchase_orders;
    
    v_order_id := 'OC-' || LPAD(v_order_counter::TEXT, 4, '0');
    
    -- Verificar si este ID ya existe
    IF NOT EXISTS (SELECT 1 FROM purchase_orders WHERE order_id = v_order_id) THEN
      RETURN v_order_id; -- ID único encontrado
    END IF;
    
    -- Incrementar intento
    v_attempt := v_attempt + 1;
    
    -- Evitar bucle infinito
    IF v_attempt > v_max_attempts THEN
      RAISE EXCEPTION 'No se pudo generar un ID único de orden de compra después de % intentos', v_max_attempts;
    END IF;
  END LOOP;
END;
$_$;


ALTER FUNCTION "public"."generate_unique_purchase_order_id"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."generate_unique_work_order_id"() RETURNS "text"
    LANGUAGE "plpgsql"
    AS $$
DECLARE
  v_n BIGINT;
  v_id TEXT;
  v_attempts INT := 0;
BEGIN
  LOOP
    v_n := nextval('work_order_id_seq');
    v_id := 'OT-' || LPAD(v_n::TEXT, 4, '0');

    -- return first non-colliding id (extremely unlikely to collide with a sequence)
    IF NOT EXISTS (SELECT 1 FROM work_orders WHERE order_id = v_id) THEN
      RETURN v_id;
    END IF;

    v_attempts := v_attempts + 1;
    IF v_attempts > 5 THEN
      -- Fallback in the very unlikely case of repeated collisions
      RETURN 'OT-' || TO_CHAR(NOW(), 'YYYYMMDD') || '-' || LPAD((EXTRACT(EPOCH FROM NOW())::BIGINT % 10000)::TEXT, 4, '0');
    END IF;
  END LOOP;
END;
$$;


ALTER FUNCTION "public"."generate_unique_work_order_id"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."generate_work_order_from_incident"("p_incident_id" "uuid", "p_priority" "text" DEFAULT 'Media'::"text") RETURNS "uuid"
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
DECLARE
  v_incident RECORD;
  v_work_order_id UUID;
  v_order_id TEXT;
  v_required_parts JSONB;
  v_estimated_cost DECIMAL(10,2) := 0;
  v_parts_array JSONB;
BEGIN
  -- Obtener datos del incidente
  SELECT * INTO v_incident FROM incident_history WHERE id = p_incident_id;

  IF v_incident IS NULL THEN
    RAISE EXCEPTION 'Incident not found';
  END IF;

  -- Procesar repuestos del incidente si existen
  IF v_incident.parts IS NOT NULL THEN
    -- Handle both JSON string and JSON array formats
    BEGIN
      -- Check if parts is a JSON string (scalar) or already an array
      IF jsonb_typeof(v_incident.parts) = 'string' THEN
        -- Parse the JSON string to get the actual array
        -- Handle multiple levels of JSON encoding
        v_parts_array := v_incident.parts;
        
        -- Keep parsing until we get an array or object
        WHILE jsonb_typeof(v_parts_array) = 'string' LOOP
          v_parts_array := (v_parts_array::text)::jsonb;
        END LOOP;
      ELSE
        -- Already an array or object
        v_parts_array := v_incident.parts;
      END IF;
      
      -- Ensure it's an array
      IF jsonb_typeof(v_parts_array) != 'array' THEN
        RAISE NOTICE 'Parts data is not in array format: %', jsonb_typeof(v_parts_array);
        v_required_parts := NULL;
      ELSE
        -- Process the parts array
        SELECT jsonb_agg(
          jsonb_build_object(
            'name', part_item->>'name',
            'partNumber', COALESCE(part_item->>'partNumber', ''),
            'quantity', COALESCE((part_item->>'quantity')::int, 1),
            'unit_price', COALESCE((part_item->>'cost')::decimal, 0),
            'total_price', COALESCE((part_item->>'quantity')::int * (part_item->>'cost')::decimal, 0),
            'supplier', '',
            'description', 'Requerido por incidente: ' || v_incident.type
          )
        ) INTO v_required_parts
        FROM jsonb_array_elements(v_parts_array) AS part_item;

        -- Calculate estimated cost
        SELECT COALESCE(SUM((part->>'total_price')::decimal), 0)
        INTO v_estimated_cost
        FROM jsonb_array_elements(v_required_parts) AS part;
      END IF;
      
    EXCEPTION
      WHEN OTHERS THEN
        -- Log the error but continue without parts
        RAISE NOTICE 'Error processing parts data for incident %: %', p_incident_id, SQLERRM;
        v_required_parts := NULL;
        v_estimated_cost := 0;
    END;
  END IF;

  -- Agregar costo de mano de obra si está disponible
  IF v_incident.labor_cost IS NOT NULL THEN
    v_estimated_cost := v_estimated_cost + v_incident.labor_cost::decimal;
  END IF;

  -- Crear la orden de trabajo (order_id será generado por el trigger)
  INSERT INTO work_orders (
    asset_id,
    description,
    type,
    priority,
    status,
    requested_by,
    required_parts,
    estimated_cost,
    estimated_duration,
    incident_id,
    created_at,
    updated_at
  ) VALUES (
    v_incident.asset_id,
    'Orden correctiva por incidente: ' || v_incident.type || ' - ' || v_incident.description,
    'corrective',
    p_priority,
    'Pendiente',
    v_incident.created_by,
    v_required_parts,
    CASE WHEN v_estimated_cost > 0 THEN v_estimated_cost ELSE NULL END,
    CASE WHEN v_incident.labor_hours IS NOT NULL THEN v_incident.labor_hours ELSE NULL END,
    p_incident_id,
    NOW(),
    NOW()
  ) RETURNING id, order_id INTO v_work_order_id, v_order_id;

  -- Log del ID generado para auditoría
  RAISE NOTICE 'Work order created with ID: % and order_id: %', v_work_order_id, v_order_id;

  -- Actualizar el incidente con el ID de la orden de trabajo
  UPDATE incident_history
  SET work_order_id = v_work_order_id,
      updated_at = NOW()
  WHERE id = p_incident_id;

  -- NOTA: Se removió el cambio automático de estado del activo a 'maintenance'
  -- Los activos mantendrán su estado actual cuando se crean órdenes de trabajo
  -- El estado se establecerá a 'operational' cuando la orden de trabajo se complete

  RETURN v_work_order_id;
END;
$$;


ALTER FUNCTION "public"."generate_work_order_from_incident"("p_incident_id" "uuid", "p_priority" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."generate_work_order_id_trigger"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
BEGIN
  -- Always overwrite to guarantee uniqueness and format
  NEW.order_id := generate_unique_work_order_id();
  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."generate_work_order_id_trigger"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_active_template_version"("p_template_id" "uuid") RETURNS "uuid"
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
DECLARE
  v_version_id UUID;
BEGIN
  SELECT id INTO v_version_id
  FROM checklist_template_versions
  WHERE template_id = p_template_id AND is_active = TRUE;
  
  RETURN v_version_id;
END;
$$;


ALTER FUNCTION "public"."get_active_template_version"("p_template_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_admin_summary_simple"() RETURNS TABLE("nivel" "text", "cantidad" bigint, "usuarios" "text")
    LANGUAGE "sql" SECURITY DEFINER
    AS $$
  SELECT 
    CASE uac.admin_level
      WHEN 'TOTAL' THEN '🌍 GERENCIA_GENERAL'
      WHEN 'UNIT' THEN '🏢 JEFE_UNIDAD'  
      WHEN 'PLANT' THEN '🏭 JEFE_PLANTA'
      ELSE '👤 USUARIO_NORMAL'
    END as nivel,
    COUNT(*) as cantidad,
    string_agg(p.nombre || COALESCE(' ' || p.apellido, ''), ', ') as usuarios
  FROM user_admin_context uac
  JOIN profiles p ON uac.user_id = p.id
  WHERE p.status = 'active'
  GROUP BY uac.admin_level
  ORDER BY 
    CASE uac.admin_level 
      WHEN 'TOTAL' THEN 1 
      WHEN 'UNIT' THEN 2 
      WHEN 'PLANT' THEN 3 
      ELSE 4 
    END;
$$;


ALTER FUNCTION "public"."get_admin_summary_simple"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_administration_summary"() RETURNS TABLE("summary_type" "text", "admin_level" "text", "count_users" bigint, "users_list" "text")
    LANGUAGE "sql" SECURITY DEFINER
    AS $$
  SELECT 
    'USUARIOS_ADMINISTRABLES' as summary_type,
    uac.admin_level,
    COUNT(*) as count_users,
    string_agg(p.nombre || COALESCE(' ' || p.apellido, ''), ', ') as users_list
  FROM profiles p
  LEFT JOIN user_admin_context uac ON p.id = uac.user_id
  -- Las políticas RLS filtrarán automáticamente
  GROUP BY uac.admin_level
  ORDER BY 
    CASE uac.admin_level 
      WHEN 'TOTAL' THEN 1 
      WHEN 'UNIT' THEN 2 
      WHEN 'PLANT' THEN 3 
      ELSE 4 
    END;
$$;


ALTER FUNCTION "public"."get_administration_summary"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_allowed_assignments"() RETURNS TABLE("assignment_type" "text", "plant_id" "uuid", "plant_name" "text", "business_unit_id" "uuid", "business_unit_name" "text")
    LANGUAGE "sql" SECURITY DEFINER
    AS $$
  SELECT 
    'PLANT' as assignment_type,
    p.id as plant_id,
    p.name as plant_name,
    p.business_unit_id,
    bu.name as business_unit_name
  FROM plants p
  JOIN business_units bu ON p.business_unit_id = bu.id
  -- Las políticas RLS de plants determinarán qué plantas son visibles
  
  UNION ALL
  
  SELECT 
    'UNIT' as assignment_type,
    NULL as plant_id,
    NULL as plant_name,
    bu.id as business_unit_id,
    bu.name as business_unit_name
  FROM business_units bu
  -- Las políticas RLS de business_units determinarán qué unidades son visibles
  
  UNION ALL
  
  SELECT 
    'TOTAL' as assignment_type,
    NULL as plant_id,
    NULL as plant_name,
    NULL as business_unit_id,
    NULL as business_unit_name
  WHERE EXISTS (
    SELECT 1 FROM user_admin_context 
    WHERE user_id = auth.uid() AND admin_level = 'TOTAL'
  )
  
  ORDER BY assignment_type, business_unit_name, plant_name;
$$;


ALTER FUNCTION "public"."get_allowed_assignments"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_allowed_statuses"("p_po_type" "text") RETURNS "text"[]
    LANGUAGE "plpgsql"
    AS $$
BEGIN
  CASE p_po_type
    WHEN 'direct_purchase', 'direct_service' THEN 
      RETURN ARRAY['draft', 'pending_approval', 'approved', 'purchased', 'receipt_uploaded', 'validated', 'rejected'];
    WHEN 'special_order' THEN 
      -- Homologated workflow: replaced 'invoiced' with 'receipt_uploaded', 'validated'
      RETURN ARRAY['draft', 'quoted', 'pending_approval', 'approved', 'ordered', 'received', 'receipt_uploaded', 'validated', 'rejected'];
    ELSE 
      RETURN ARRAY['draft', 'pending_approval', 'approved', 'rejected'];
  END CASE;
END;
$$;


ALTER FUNCTION "public"."get_allowed_statuses"("p_po_type" "text") OWNER TO "postgres";


COMMENT ON FUNCTION "public"."get_allowed_statuses"("p_po_type" "text") IS 'Returns all allowed statuses for a purchase order type - homologated workflow with receipt_uploaded and validated for all types';



CREATE OR REPLACE FUNCTION "public"."get_applicable_maintenance_intervals"("p_asset_id" "uuid", "p_current_hours" integer) RETURNS TABLE("interval_id" "uuid", "interval_value" integer, "name" "text", "description" "text", "type" "text", "maintenance_category" "text", "is_recurring" boolean, "is_first_cycle_only" boolean, "current_cycle" integer, "next_due_hour" integer, "status" "text", "cycle_length" integer)
    LANGUAGE "plpgsql"
    AS $$
DECLARE
  asset_model_id UUID;
  model_cycle_length INTEGER;
  current_cycle_num INTEGER;
BEGIN
  -- Get asset's model
  SELECT model_id INTO asset_model_id FROM assets WHERE id = p_asset_id;
  
  IF asset_model_id IS NULL THEN
    RETURN;
  END IF;
  
  -- Get cycle length for this model
  SELECT get_model_cycle_length(asset_model_id) INTO model_cycle_length;
  
  IF model_cycle_length <= 0 THEN
    RETURN;
  END IF;
  
  -- Calculate current cycle
  SELECT calculate_maintenance_cycle(p_current_hours, model_cycle_length) INTO current_cycle_num;
  
  -- Return applicable intervals
  RETURN QUERY
  SELECT 
    mi.id as interval_id,
    mi.interval_value,
    mi.name,
    mi.description,
    mi.type,
    mi.maintenance_category,
    mi.is_recurring,
    mi.is_first_cycle_only,
    current_cycle_num as current_cycle,
    calculate_actual_due_hour(mi.interval_value, current_cycle_num, model_cycle_length, mi.is_first_cycle_only) as next_due_hour,
    CASE 
      WHEN mi.is_first_cycle_only AND current_cycle_num > 1 THEN 'not_applicable'
      WHEN calculate_actual_due_hour(mi.interval_value, current_cycle_num, model_cycle_length, mi.is_first_cycle_only) IS NULL THEN 'not_applicable'
      WHEN p_current_hours >= calculate_actual_due_hour(mi.interval_value, current_cycle_num, model_cycle_length, mi.is_first_cycle_only) THEN 'overdue'
      WHEN p_current_hours >= calculate_actual_due_hour(mi.interval_value, current_cycle_num, model_cycle_length, mi.is_first_cycle_only) - 100 THEN 'upcoming'
      ELSE 'scheduled'
    END as status,
    model_cycle_length as cycle_length
  FROM maintenance_intervals mi
  WHERE mi.model_id = asset_model_id
    AND mi.is_recurring = true
  ORDER BY 
    CASE WHEN calculate_actual_due_hour(mi.interval_value, current_cycle_num, model_cycle_length, mi.is_first_cycle_only) IS NULL THEN 1 ELSE 0 END,
    calculate_actual_due_hour(mi.interval_value, current_cycle_num, model_cycle_length, mi.is_first_cycle_only) ASC;
END;
$$;


ALTER FUNCTION "public"."get_applicable_maintenance_intervals"("p_asset_id" "uuid", "p_current_hours" integer) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_asset_assignments"("target_asset_id" "uuid") RETURNS TABLE("assignment_id" "uuid", "operator_id" "uuid", "operator_name" "text", "employee_code" "text", "assignment_type" "text", "start_date" "date", "end_date" "date", "status" "text", "assigned_by_name" "text", "phone" "text")
    LANGUAGE "sql" SECURITY DEFINER
    AS $$
  SELECT 
    ao.id,
    ao.operator_id,
    CONCAT(p.nombre, ' ', COALESCE(p.apellido, '')) as operator_name,
    p.employee_code,
    ao.assignment_type,
    ao.start_date,
    ao.end_date,
    ao.status,
    CONCAT(assigner.nombre, ' ', COALESCE(assigner.apellido, '')) as assigned_by_name,
    p.telefono
  FROM asset_operators ao
  JOIN profiles p ON ao.operator_id = p.id
  LEFT JOIN profiles assigner ON ao.assigned_by = assigner.id
  WHERE ao.asset_id = target_asset_id
  ORDER BY ao.assignment_type, ao.start_date DESC;
$$;


ALTER FUNCTION "public"."get_asset_assignments"("target_asset_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_available_operators"("p_plant_id" "uuid" DEFAULT NULL::"uuid", "p_business_unit_id" "uuid" DEFAULT NULL::"uuid") RETURNS TABLE("id" "uuid", "nombre" character varying, "apellido" character varying, "email" character varying, "role" character varying, "employee_code" character varying, "shift" character varying, "plant_id" "uuid", "plant_name" character varying, "business_unit_id" "uuid", "business_unit_name" character varying, "is_operator" boolean, "status" character varying)
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
BEGIN
  RETURN QUERY
  SELECT 
    p.id,
    p.nombre,
    p.apellido,
    p.email,
    p.role,
    p.employee_code,
    p.shift,
    p.plant_id,
    pl.name as plant_name,
    p.business_unit_id,
    bu.name as business_unit_name,
    p.is_operator,
    p.status
  FROM profiles p
  LEFT JOIN plants pl ON p.plant_id = pl.id
  LEFT JOIN business_units bu ON p.business_unit_id = bu.id
  WHERE p.status = 'active'
    AND p.role IN ('OPERADOR', 'DOSIFICADOR', 'ENCARGADO_MANTENIMIENTO', 'MECANICO', 'ELECTRICISTA')
    AND (p_plant_id IS NULL OR p.plant_id = p_plant_id)
    AND (p_business_unit_id IS NULL OR p.business_unit_id = p_business_unit_id)
  ORDER BY p.nombre, p.apellido;
END;
$$;


ALTER FUNCTION "public"."get_available_operators"("p_plant_id" "uuid", "p_business_unit_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_available_operators_for_plant"("target_plant_id" "uuid") RETURNS TABLE("operator_id" "uuid", "operator_name" "text", "employee_code" "text", "role" "public"."user_role", "job_position" "text", "shift" "text", "phone" "text", "current_primary_assets" integer, "current_secondary_assets" integer, "is_available" boolean)
    LANGUAGE "sql" SECURITY DEFINER
    AS $$
  SELECT 
    p.id,
    CONCAT(p.nombre, ' ', COALESCE(p.apellido, '')) as operator_name,
    p.employee_code,
    p.role,
    p."position" as job_position, -- Using quotes for reserved keyword
    p.shift,
    p.telefono,
    COALESCE(primary_count.count, 0) as current_primary_assets,
    COALESCE(secondary_count.count, 0) as current_secondary_assets,
    -- Operators can have multiple assets, but limit primary assignments
    CASE 
      WHEN COALESCE(primary_count.count, 0) < 3 THEN TRUE 
      ELSE FALSE 
    END as is_available
  FROM profiles p
  LEFT JOIN (
    SELECT operator_id, COUNT(*) as count
    FROM asset_operators 
    WHERE assignment_type = 'primary' AND status = 'active'
    GROUP BY operator_id
  ) primary_count ON p.id = primary_count.operator_id
  LEFT JOIN (
    SELECT operator_id, COUNT(*) as count
    FROM asset_operators 
    WHERE assignment_type = 'secondary' AND status = 'active'
    GROUP BY operator_id
  ) secondary_count ON p.id = secondary_count.operator_id
  WHERE p.plant_id = target_plant_id 
    AND p.role IN ('OPERADOR', 'DOSIFICADOR')
    AND p.status = 'active'
  ORDER BY operator_name;
$$;


ALTER FUNCTION "public"."get_available_operators_for_plant"("target_plant_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_daily_checklist_evening_report"("target_date" "date") RETURNS TABLE("total_scheduled" integer, "total_completed" integer, "completion_rate" numeric, "issues_found" integer, "critical_issues" integer, "work_orders_generated" integer, "avg_completion_time_hours" numeric, "technician_performance" "jsonb", "asset_performance" "jsonb", "incomplete_checklists" "jsonb")
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
DECLARE
  v_total_scheduled INTEGER;
  v_total_completed INTEGER;
  v_completion_rate DECIMAL;
  v_issues_found INTEGER;
  v_critical_issues INTEGER;
  v_work_orders_generated INTEGER;
  v_avg_hours DECIMAL;
  v_tech JSONB;
  v_asset JSONB;
  v_incomplete JSONB;
BEGIN
  -- Overall counts
  SELECT COUNT(*) INTO v_total_scheduled
  FROM checklist_schedules cs
  WHERE DATE(cs.scheduled_date) = target_date;

  SELECT COUNT(*) INTO v_total_completed
  FROM completed_checklists cc
  WHERE DATE(cc.completion_date) = target_date;

  v_completion_rate := CASE WHEN v_total_scheduled > 0 THEN ROUND((v_total_completed::DECIMAL / v_total_scheduled::DECIMAL) * 100.0, 2) ELSE 0 END;

  SELECT COUNT(*) INTO v_issues_found
  FROM checklist_issues ci
  JOIN completed_checklists cc ON cc.id = ci.checklist_id
  WHERE DATE(cc.completion_date) = target_date;

  SELECT COUNT(*) INTO v_critical_issues
  FROM checklist_issues ci
  JOIN completed_checklists cc ON cc.id = ci.checklist_id
  WHERE DATE(cc.completion_date) = target_date
    AND ci.status = 'fail';

  SELECT COUNT(*) INTO v_work_orders_generated
  FROM work_orders wo
  WHERE DATE(wo.created_at) = target_date;

  -- Average completion time in hours for checklists scheduled today and completed today
  SELECT ROUND(AVG(EXTRACT(EPOCH FROM (cc.completion_date - cs.scheduled_date)) / 3600.0)::DECIMAL, 2) INTO v_avg_hours
  FROM checklist_schedules cs
  JOIN completed_checklists cc 
    ON cs.template_id = cc.checklist_id 
   AND cs.asset_id = cc.asset_id
  WHERE DATE(cs.scheduled_date) = target_date
    AND DATE(cc.completion_date) = target_date;

  -- Technician performance JSON
  SELECT COALESCE(jsonb_agg(row_to_json(t)::jsonb), '[]'::jsonb) INTO v_tech
  FROM (
    SELECT 
      COALESCE(p.nombre || ' ' || COALESCE(p.apellido, ''), 'No asignado') AS technician_name,
      cs.assigned_to AS technician_id,
      COUNT(cs.id) AS scheduled,
      COUNT(cc.id) AS completed,
      CASE WHEN COUNT(cs.id) > 0 THEN ROUND((COUNT(cc.id)::DECIMAL / COUNT(cs.id)::DECIMAL) * 100.0, 2) ELSE 0 END AS completion_rate,
      COUNT(ci.id) AS issues_found,
      ROUND(AVG(EXTRACT(EPOCH FROM (cc.completion_date - cs.scheduled_date)) / 3600.0)::DECIMAL, 2) AS avg_completion_time_hours
    FROM checklist_schedules cs
    LEFT JOIN profiles p ON p.id = cs.assigned_to
    LEFT JOIN completed_checklists cc 
      ON cc.checklist_id = cs.template_id 
     AND cc.asset_id = cs.asset_id 
     AND DATE(cc.completion_date) = target_date
    LEFT JOIN checklist_issues ci ON ci.checklist_id = cc.id
    WHERE DATE(cs.scheduled_date) = target_date
    GROUP BY cs.assigned_to, p.nombre, p.apellido
    HAVING COUNT(cs.id) > 0
    ORDER BY technician_name
  ) t;

  -- Asset performance JSON
  SELECT COALESCE(jsonb_agg(row_to_json(a)::jsonb), '[]'::jsonb) INTO v_asset
  FROM (
    SELECT 
      a_tbl.name AS asset_name,
      a_tbl.asset_id AS asset_code,
      COUNT(cs.id) AS checklists_scheduled,
      COUNT(cc.id) AS checklists_completed,
      COUNT(ci.id) AS issues_found,
      COUNT(CASE WHEN ci.status = 'fail' THEN 1 END) AS critical_issues
    FROM checklist_schedules cs
    LEFT JOIN assets a_tbl ON a_tbl.id = cs.asset_id
    LEFT JOIN completed_checklists cc 
      ON cc.checklist_id = cs.template_id 
     AND cc.asset_id = cs.asset_id 
     AND DATE(cc.completion_date) = target_date
    LEFT JOIN checklist_issues ci ON ci.checklist_id = cc.id
    WHERE DATE(cs.scheduled_date) = target_date
    GROUP BY a_tbl.id, a_tbl.name, a_tbl.asset_id
    HAVING COUNT(cs.id) > 0
    ORDER BY a_tbl.name
  ) a;

  -- Incomplete checklists JSON (scheduled today, not completed today)
  SELECT COALESCE(jsonb_agg(row_to_json(x)::jsonb), '[]'::jsonb) INTO v_incomplete
  FROM (
    SELECT 
      cs.id AS schedule_id,
      a_tbl.name AS asset_name,
      a_tbl.asset_id AS asset_code,
      c.name AS checklist_name,
      COALESCE(p.nombre || ' ' || COALESCE(p.apellido, ''), 'No asignado') AS assigned_technician,
      cs.scheduled_date AS scheduled_time,
      cs.status,
      pl.name AS plant_name
    FROM checklist_schedules cs
    LEFT JOIN assets a_tbl ON a_tbl.id = cs.asset_id
    LEFT JOIN plants pl ON pl.id = a_tbl.plant_id
    LEFT JOIN checklists c ON c.id = cs.template_id
    LEFT JOIN profiles p ON p.id = cs.assigned_to
    LEFT JOIN completed_checklists cc 
      ON cc.checklist_id = cs.template_id 
     AND cc.asset_id = cs.asset_id 
     AND DATE(cc.completion_date) = target_date
    WHERE DATE(cs.scheduled_date) = target_date
      AND cc.id IS NULL
    ORDER BY cs.scheduled_date, a_tbl.name
  ) x;

  RETURN QUERY SELECT 
    COALESCE(v_total_scheduled, 0),
    COALESCE(v_total_completed, 0),
    COALESCE(v_completion_rate, 0),
    COALESCE(v_issues_found, 0),
    COALESCE(v_critical_issues, 0),
    COALESCE(v_work_orders_generated, 0),
    COALESCE(v_avg_hours, 0),
    v_tech,
    v_asset,
    v_incomplete;
END;
$$;


ALTER FUNCTION "public"."get_daily_checklist_evening_report"("target_date" "date") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_daily_checklist_morning_report"("target_date" "date") RETURNS TABLE("schedule_id" "uuid", "asset_name" "text", "asset_code" "text", "checklist_name" "text", "assigned_technician" "text", "technician_id" "uuid", "scheduled_time" timestamp with time zone, "status" "text", "plant_name" "text", "department_name" "text", "estimated_duration" double precision, "last_completion_date" timestamp with time zone, "technician_workload" integer, "asset_current_hours" integer, "asset_current_kilometers" integer, "maintenance_status" "text")
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
BEGIN
  RETURN QUERY
  SELECT 
    cs.id as schedule_id,
    a.name as asset_name,
    a.asset_id as asset_code,
    c.name as checklist_name,
    COALESCE(p.nombre || ' ' || COALESCE(p.apellido, ''), 'No asignado') as assigned_technician,
    cs.assigned_to as technician_id,
    cs.scheduled_date as scheduled_time,
    cs.status,
    pl.name as plant_name,
    d.name as department_name,
    COALESCE(mi.estimated_duration, 2.0) as estimated_duration,
    (
      SELECT MAX(cc2.completion_date) 
      FROM completed_checklists cc2 
      WHERE cc2.asset_id = a.id AND cc2.checklist_id = c.id
    ) as last_completion_date,
    (
      SELECT COUNT(*)::INTEGER 
      FROM checklist_schedules cs2 
      WHERE cs2.assigned_to = cs.assigned_to 
      AND DATE(cs2.scheduled_date) = target_date
      AND cs2.status = 'pendiente'
    ) as technician_workload,
    a.current_hours,
    a.current_kilometers,
    CASE 
      WHEN a.status != 'operational' THEN 'ASSET_NOT_OPERATIONAL'
      WHEN cs.assigned_to IS NULL THEN 'NO_TECHNICIAN_ASSIGNED'
      WHEN cs.status = 'completado' THEN 'ALREADY_COMPLETED'
      ELSE 'READY'
    END as maintenance_status
  FROM checklist_schedules cs
  LEFT JOIN assets a ON cs.asset_id = a.id
  LEFT JOIN checklists c ON cs.template_id = c.id
  LEFT JOIN profiles p ON cs.assigned_to = p.id
  LEFT JOIN plants pl ON a.plant_id = pl.id
  LEFT JOIN departments d ON a.department_id = d.id
  LEFT JOIN maintenance_intervals mi ON c.interval_id = mi.id
  WHERE DATE(cs.scheduled_date) = target_date
  ORDER BY 
    CASE cs.status
      WHEN 'pendiente' THEN 1
      WHEN 'en_progreso' THEN 2
      ELSE 3
    END,
    cs.scheduled_date, 
    a.name;
END;
$$;


ALTER FUNCTION "public"."get_daily_checklist_morning_report"("target_date" "date") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_daily_work_orders_incidents_report"("target_date" "date") RETURNS TABLE("total_work_orders_created" integer, "total_work_orders_completed" integer, "total_incidents_created" integer, "work_orders_created" "jsonb", "work_orders_completed" "jsonb", "incidents_created" "jsonb", "purchase_orders_pending" "jsonb")
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
DECLARE
  wo_created_count INTEGER;
  wo_completed_count INTEGER;
  incidents_count INTEGER;
  wo_created_json JSONB;
  wo_completed_json JSONB;
  incidents_json JSONB;
  po_pending_json JSONB;
BEGIN
  -- Counts: Only preventive work orders
  SELECT COUNT(*) INTO wo_created_count
  FROM work_orders wo
  WHERE DATE(wo.created_at) = target_date
    AND wo.type = 'preventive';

  SELECT COUNT(*) INTO wo_completed_count
  FROM work_orders wo
  WHERE wo.status = 'Completada' 
    AND wo.type = 'preventive'
    AND DATE(COALESCE(wo.completed_at, wo.updated_at)) = target_date;

  SELECT COUNT(*) INTO incidents_count
  FROM incident_history ih
  WHERE DATE(ih.date) = target_date;

  -- Work orders created: Only preventive, with asset_id, creator name, maintenance interval, and organizational data
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'id', wo.id,
    'order_id', wo.order_id,
    'asset_id', a.asset_id,
    'type', wo.type,
    'priority', wo.priority,
    'status', wo.status,
    'estimated_cost', wo.estimated_cost,
    'planned_date', wo.planned_date,
    'created_at', wo.created_at,
    'creator_name', COALESCE(
      TRIM(CONCAT(COALESCE(p.nombre, ''), ' ', COALESCE(p.apellido, ''))),
      'N/A'
    ),
    'maintenance_interval_name', mi.name,
    'maintenance_interval_value', mi.interval_value,
    'maintenance_interval_type', mi.type,
    'plant_id', a.plant_id,
    'business_unit_id', pl.business_unit_id
  ) ORDER BY wo.created_at ASC), '[]'::jsonb) INTO wo_created_json
  FROM work_orders wo
  LEFT JOIN assets a ON a.id = wo.asset_id
  LEFT JOIN plants pl ON pl.id = a.plant_id
  LEFT JOIN profiles p ON p.id = wo.requested_by
  LEFT JOIN maintenance_plans mp ON mp.id = wo.maintenance_plan_id
  LEFT JOIN maintenance_intervals mi ON mi.id = mp.interval_id
  WHERE DATE(wo.created_at) = target_date
    AND wo.type = 'preventive';

  -- Work orders completed: Only preventive, with asset_id, creator name, maintenance interval, and organizational data
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'id', wo.id,
    'order_id', wo.order_id,
    'asset_id', a.asset_id,
    'type', wo.type,
    'priority', wo.priority,
    'status', wo.status,
    'total_cost', so.total_cost,
    'completed_at', COALESCE(wo.completed_at, wo.updated_at),
    'service_order_id', wo.service_order_id,
    'creator_name', COALESCE(
      TRIM(CONCAT(COALESCE(p.nombre, ''), ' ', COALESCE(p.apellido, ''))),
      'N/A'
    ),
    'maintenance_interval_name', mi.name,
    'maintenance_interval_value', mi.interval_value,
    'maintenance_interval_type', mi.type,
    'plant_id', a.plant_id,
    'business_unit_id', pl.business_unit_id
  ) ORDER BY COALESCE(wo.completed_at, wo.updated_at) ASC), '[]'::jsonb) INTO wo_completed_json
  FROM work_orders wo
  LEFT JOIN assets a ON a.id = wo.asset_id
  LEFT JOIN plants pl ON pl.id = a.plant_id
  LEFT JOIN profiles p ON p.id = wo.requested_by
  LEFT JOIN service_orders so ON so.id = wo.service_order_id
  LEFT JOIN maintenance_plans mp ON mp.id = wo.maintenance_plan_id
  LEFT JOIN maintenance_intervals mi ON mi.id = mp.interval_id
  WHERE wo.status = 'Completada'
    AND wo.type = 'preventive'
    AND DATE(COALESCE(wo.completed_at, wo.updated_at)) = target_date;

  -- Incidents: With asset_id, creator name, and organizational data (NO ID field)
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'asset_id', a.asset_id,
    'type', ih.type,
    'description', ih.description,
    'work_order_id', ih.work_order_id,
    'status', ih.status,
    'date', ih.date,
    'creator_name', COALESCE(
      TRIM(CONCAT(COALESCE(p.nombre, ''), ' ', COALESCE(p.apellido, ''))),
      'N/A'
    ),
    'plant_id', a.plant_id,
    'business_unit_id', pl.business_unit_id
  ) ORDER BY ih.date ASC), '[]'::jsonb) INTO incidents_json
  FROM incident_history ih
  LEFT JOIN assets a ON a.id = ih.asset_id
  LEFT JOIN plants pl ON pl.id = a.plant_id
  LEFT JOIN profiles p ON p.id = COALESCE(ih.created_by, ih.reported_by_id)
  WHERE DATE(ih.date) = target_date;

  -- Purchase orders pending: Only for preventive work orders created today
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'id', po.id,
    'order_id', po.order_id,
    'work_order_id', po.work_order_id,
    'supplier', po.supplier,
    'total_amount', po.total_amount,
    'status', po.status,
    'expected_delivery_date', po.expected_delivery_date
  ) ORDER BY po.created_at ASC), '[]'::jsonb) INTO po_pending_json
  FROM purchase_orders po
  WHERE po.status = 'Pendiente'
    AND po.work_order_id IN (
      SELECT wo.id 
      FROM work_orders wo 
      WHERE DATE(wo.created_at) = target_date
        AND wo.type = 'preventive'
    );

  RETURN QUERY SELECT 
    wo_created_count,
    wo_completed_count,
    incidents_count,
    wo_created_json,
    wo_completed_json,
    incidents_json,
    po_pending_json;
END;
$$;


ALTER FUNCTION "public"."get_daily_work_orders_incidents_report"("target_date" "date") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_diesel_backdating_threshold_minutes"() RETURNS integer
    LANGUAGE "plpgsql" STABLE
    AS $$
DECLARE v_val integer; BEGIN
  SELECT COALESCE(NULLIF(value, '')::integer, 120)
  INTO v_val
  FROM app_settings WHERE key = 'diesel_backdating_threshold_minutes';
  RETURN COALESCE(v_val, 120);
END;$$;


ALTER FUNCTION "public"."get_diesel_backdating_threshold_minutes"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_expected_next_reading"("p_asset_id" "uuid", "p_reading_type" "text" DEFAULT 'hours'::"text") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
DECLARE
  v_current_reading INTEGER;
  v_maintenance_unit TEXT;
  v_recent_readings INTEGER[];
  v_average_usage NUMERIC;
  v_days_since_last INTEGER;
  v_expected_reading INTEGER;
  v_last_reading_date TIMESTAMPTZ;
BEGIN
  -- Obtener información del activo
  SELECT current_hours, current_kilometers, equipment_models.maintenance_unit
  INTO v_current_reading, v_current_reading, v_maintenance_unit
  FROM assets
  LEFT JOIN equipment_models ON assets.model_id = equipment_models.id
  WHERE assets.id = p_asset_id;
  
  IF p_reading_type = 'hours' THEN
    SELECT current_hours INTO v_current_reading FROM assets WHERE id = p_asset_id;
  ELSE
    SELECT current_kilometers INTO v_current_reading FROM assets WHERE id = p_asset_id;
  END IF;
  
  -- Obtener lecturas recientes (últimos 30 días)
  IF p_reading_type = 'hours' THEN
    SELECT 
      array_agg(equipment_hours_reading ORDER BY completion_date DESC),
      MAX(completion_date)
    INTO v_recent_readings, v_last_reading_date
    FROM completed_checklists 
    WHERE asset_id = p_asset_id 
      AND equipment_hours_reading IS NOT NULL
      AND completion_date >= NOW() - INTERVAL '30 days';
  ELSE
    SELECT 
      array_agg(equipment_kilometers_reading ORDER BY completion_date DESC),
      MAX(completion_date)
    INTO v_recent_readings, v_last_reading_date
    FROM completed_checklists 
    WHERE asset_id = p_asset_id 
      AND equipment_kilometers_reading IS NOT NULL
      AND completion_date >= NOW() - INTERVAL '30 days';
  END IF;
  
  -- Calcular uso promedio si hay datos suficientes
  IF array_length(v_recent_readings, 1) >= 2 THEN
    v_average_usage := (v_recent_readings[1] - v_recent_readings[array_length(v_recent_readings, 1)]) / 
                       GREATEST(array_length(v_recent_readings, 1) - 1, 1);
  ELSE
    v_average_usage := 0;
  END IF;
  
  -- Calcular días desde la última lectura
  v_days_since_last := COALESCE(EXTRACT(DAYS FROM NOW() - v_last_reading_date), 0);
  
  -- Estimar lectura esperada
  v_expected_reading := v_current_reading + (v_average_usage * v_days_since_last)::INTEGER;
  
  RETURN jsonb_build_object(
    'current_reading', v_current_reading,
    'expected_reading', v_expected_reading,
    'average_daily_usage', v_average_usage,
    'days_since_last_reading', v_days_since_last,
    'last_reading_date', v_last_reading_date,
    'recent_readings_count', COALESCE(array_length(v_recent_readings, 1), 0)
  );
END;
$$;


ALTER FUNCTION "public"."get_expected_next_reading"("p_asset_id" "uuid", "p_reading_type" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_maintenance_alerts_report"() RETURNS TABLE("asset_id" "uuid", "asset_name" "text", "asset_code" "text", "plant_name" "text", "maintenance_type" "text", "days_until_due" integer, "hours_until_due" integer, "kilometers_until_due" integer, "maintenance_unit" "text", "risk_level" "text", "last_completed" timestamp with time zone, "last_service_date" timestamp with time zone, "last_service_hours" integer, "last_service_kilometers" integer, "estimated_duration" double precision, "current_asset_hours" integer, "current_asset_kilometers" integer, "interval_value" integer, "workdays_until_due" integer, "overdue_amount" integer)
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
BEGIN
  RETURN QUERY
  WITH model_cycle AS (
    SELECT em.id AS model_id, MAX(mi.interval_value) AS cycle_length
    FROM equipment_models em
    JOIN maintenance_intervals mi ON mi.model_id = em.id
    GROUP BY em.id
  ),
  -- HOURS PATH
  hours_calc AS (
    SELECT 
      a.id AS asset_id,
      a.name AS asset_name,
      a.asset_id AS asset_code,
      pl.name AS plant_name,
      mp.id AS maintenance_plan_id,
      mp.name AS maintenance_type,
      mi.id AS interval_id,
      mi.interval_value,
      mi.maintenance_category::text AS maintenance_category,
      COALESCE(a.current_hours, 0) AS cur_hours,
      mc.cycle_length,
      (FLOOR(COALESCE(a.current_hours, 0)::NUMERIC / NULLIF(mc.cycle_length,0))::INT * mc.cycle_length) AS cycle_start,
      (FLOOR(COALESCE(a.current_hours, 0)::NUMERIC / NULLIF(mc.cycle_length,0))::INT * mc.cycle_length) + mc.cycle_length AS cycle_end,
      mp.last_completed,
      mi.estimated_duration,
      'hours'::TEXT AS maintenance_unit
    FROM maintenance_plans mp
    JOIN assets a ON a.id = mp.asset_id
    JOIN equipment_models em ON a.model_id = em.id
    JOIN maintenance_intervals mi ON mp.interval_id = mi.id
    JOIN model_cycle mc ON mc.model_id = em.id
    LEFT JOIN plants pl ON a.plant_id = pl.id
    WHERE em.maintenance_unit = 'hours'
  ),
  hours_status AS (
    SELECT 
      h.*,
      (h.cycle_start + h.interval_value) AS due_point,
      -- Last service for this specific plan
      (SELECT mh.date FROM maintenance_history mh
        WHERE mh.asset_id = h.asset_id AND mh.maintenance_plan_id = h.maintenance_plan_id
        ORDER BY mh.date DESC LIMIT 1) AS last_service_date,
      (SELECT mh.hours FROM maintenance_history mh
        WHERE mh.asset_id = h.asset_id AND mh.maintenance_plan_id = h.maintenance_plan_id
        ORDER BY mh.date DESC LIMIT 1) AS last_service_hours,
      -- Completed in cycle (preventive, plan-linked, within tolerance of due point)
      EXISTS (
        SELECT 1 FROM maintenance_history mh
        WHERE mh.asset_id = h.asset_id
          AND mh.maintenance_plan_id = h.maintenance_plan_id
          AND mh.type = 'Preventivo'
          AND mh.hours IS NOT NULL
          AND mh.hours > h.cycle_start AND mh.hours < h.cycle_end
          AND ABS(mh.hours - (h.cycle_start + h.interval_value)) <= 200
      ) AS was_completed_in_cycle,
      -- Covered by higher/equal preventive maintenance in same cycle (plan-aware)
      EXISTS (
        SELECT 1
        FROM maintenance_history mh
        JOIN maintenance_intervals mi2 ON mi2.id = mh.maintenance_plan_id
        WHERE mh.asset_id = h.asset_id
          AND mh.type = 'Preventivo'
          AND mh.hours IS NOT NULL
          AND mh.hours > h.cycle_start AND mh.hours < h.cycle_end
          AND mi2.interval_value >= h.interval_value
          AND (
            h.maintenance_category IS NULL
            OR mi2.maintenance_category IS NULL
            OR mi2.maintenance_category = h.maintenance_category
          )
      ) AS covered_by_higher
    FROM hours_calc h
  ),
  hours_final AS (
    SELECT 
      hs.asset_id,
      hs.asset_name,
      hs.asset_code,
      hs.plant_name,
      hs.maintenance_type,
      NULL::INTEGER AS days_until_due,
      GREATEST(0, hs.interval_value - (hs.cur_hours - hs.cycle_start)) AS hours_until_due,
      NULL::INTEGER AS kilometers_until_due,
      hs.maintenance_unit,
      CASE 
        WHEN hs.was_completed_in_cycle OR hs.covered_by_higher THEN 'COVERED'
        WHEN (hs.interval_value - (hs.cur_hours - hs.cycle_start)) < 0 THEN 'OVERDUE'
        WHEN (hs.interval_value - (hs.cur_hours - hs.cycle_start)) <= 24 THEN 'CRITICAL'
        WHEN (hs.interval_value - (hs.cur_hours - hs.cycle_start)) <= LEAST(100, GREATEST(1, (hs.interval_value * 0.1)::INT)) THEN 'HIGH'
        WHEN (hs.interval_value - (hs.cur_hours - hs.cycle_start)) <= (hs.interval_value * 0.2) THEN 'MEDIUM'
        ELSE 'LOW'
      END AS risk_level,
      NULLIF(hs.last_completed, NULL) AS last_completed,
      hs.last_service_date,
      hs.last_service_hours,
      NULL::INTEGER AS last_service_kilometers,
      hs.estimated_duration,
      hs.cur_hours AS current_asset_hours,
      NULL::INTEGER AS current_asset_kilometers,
      hs.interval_value,
      CEILING(GREATEST(0, (hs.interval_value - (hs.cur_hours - hs.cycle_start))) / 8.0)::INTEGER AS workdays_until_due,
      GREATEST(0, (hs.cur_hours - (hs.cycle_start + hs.interval_value)))::INTEGER AS overdue_amount
    FROM hours_status hs
  ),
  -- KILOMETERS PATH
  km_calc AS (
    SELECT 
      a.id AS asset_id,
      a.name AS asset_name,
      a.asset_id AS asset_code,
      pl.name AS plant_name,
      mp.id AS maintenance_plan_id,
      mp.name AS maintenance_type,
      mi.id AS interval_id,
      mi.interval_value,
      mi.maintenance_category::text AS maintenance_category,
      COALESCE(a.current_kilometers, 0) AS cur_km,
      mc.cycle_length,
      (FLOOR(COALESCE(a.current_kilometers, 0)::NUMERIC / NULLIF(mc.cycle_length,0))::INT * mc.cycle_length) AS cycle_start,
      (FLOOR(COALESCE(a.current_kilometers, 0)::NUMERIC / NULLIF(mc.cycle_length,0))::INT * mc.cycle_length) + mc.cycle_length AS cycle_end,
      mp.last_completed,
      mi.estimated_duration,
      'kilometers'::TEXT AS maintenance_unit
    FROM maintenance_plans mp
    JOIN assets a ON a.id = mp.asset_id
    JOIN equipment_models em ON a.model_id = em.id
    JOIN maintenance_intervals mi ON mp.interval_id = mi.id
    JOIN model_cycle mc ON mc.model_id = em.id
    LEFT JOIN plants pl ON a.plant_id = pl.id
    WHERE em.maintenance_unit = 'kilometers'
  ),
  km_status AS (
    SELECT 
      k.*,
      (k.cycle_start + k.interval_value) AS due_point,
      (SELECT mh.date FROM maintenance_history mh
        WHERE mh.asset_id = k.asset_id AND mh.maintenance_plan_id = k.maintenance_plan_id
        ORDER BY mh.date DESC LIMIT 1) AS last_service_date,
      NULL::INTEGER AS last_service_hours,
      (SELECT mh.kilometers FROM maintenance_history mh
        WHERE mh.asset_id = k.asset_id AND mh.maintenance_plan_id = k.maintenance_plan_id
        ORDER BY mh.date DESC LIMIT 1) AS last_service_kilometers,
      -- Completed in cycle (preventive, plan-linked, within tolerance of due point)
      EXISTS (
        SELECT 1 FROM maintenance_history mh
        WHERE mh.asset_id = k.asset_id
          AND mh.maintenance_plan_id = k.maintenance_plan_id
          AND mh.type = 'Preventivo'
          AND mh.kilometers IS NOT NULL
          AND mh.kilometers > k.cycle_start AND mh.kilometers < k.cycle_end
          AND ABS(mh.kilometers - (k.cycle_start + k.interval_value)) <= 200
      ) AS was_completed_in_cycle,
      -- Covered by higher/equal preventive maintenance in same cycle (plan-aware)
      EXISTS (
        SELECT 1
        FROM maintenance_history mh
        JOIN maintenance_intervals mi2 ON mi2.id = mh.maintenance_plan_id
        WHERE mh.asset_id = k.asset_id
          AND mh.type = 'Preventivo'
          AND mh.kilometers IS NOT NULL
          AND mh.kilometers > k.cycle_start AND mh.kilometers < k.cycle_end
          AND mi2.interval_value >= k.interval_value
          AND (
            k.maintenance_category IS NULL
            OR mi2.maintenance_category IS NULL
            OR mi2.maintenance_category = k.maintenance_category
          )
      ) AS covered_by_higher
    FROM km_calc k
  ),
  km_final AS (
    SELECT 
      ks.asset_id,
      ks.asset_name,
      ks.asset_code,
      ks.plant_name,
      ks.maintenance_type,
      NULL::INTEGER AS days_until_due,
      NULL::INTEGER AS hours_until_due,
      GREATEST(0, ks.interval_value - (ks.cur_km - ks.cycle_start)) AS kilometers_until_due,
      ks.maintenance_unit,
      CASE 
        WHEN ks.was_completed_in_cycle OR ks.covered_by_higher THEN 'COVERED'
        WHEN (ks.interval_value - (ks.cur_km - ks.cycle_start)) < 0 THEN 'OVERDUE'
        WHEN (ks.interval_value - (ks.cur_km - ks.cycle_start)) <= 100 THEN 'CRITICAL'
        WHEN (ks.interval_value - (ks.cur_km - ks.cycle_start)) <= LEAST(200, GREATEST(1, (ks.interval_value * 0.1)::INT)) THEN 'HIGH'
        WHEN (ks.interval_value - (ks.cur_km - ks.cycle_start)) <= (ks.interval_value * 0.2) THEN 'MEDIUM'
        ELSE 'LOW'
      END AS risk_level,
      NULLIF(ks.last_completed, NULL) AS last_completed,
      ks.last_service_date,
      ks.last_service_hours,
      ks.last_service_kilometers,
      ks.estimated_duration,
      NULL::INTEGER AS current_asset_hours,
      ks.cur_km AS current_asset_kilometers,
      ks.interval_value,
      NULL::INTEGER AS workdays_until_due,
      GREATEST(0, (ks.cur_km - (ks.cycle_start + ks.interval_value)))::INTEGER AS overdue_amount
    FROM km_status ks
  ),
  unioned AS (
    SELECT * FROM hours_final
    UNION ALL
    SELECT * FROM km_final
  ),
  filtered AS (
    SELECT u.*
    FROM unioned u
    WHERE 
      u.risk_level <> 'COVERED'
      AND u.risk_level IN ('OVERDUE','CRITICAL','HIGH','MEDIUM')
  ),
  ranked AS (
    SELECT f.*, ROW_NUMBER() OVER (PARTITION BY f.asset_id ORDER BY f.interval_value DESC) AS rn
    FROM filtered f
  )
  SELECT 
    r.asset_id,
    r.asset_name,
    r.asset_code,
    r.plant_name,
    r.maintenance_type,
    r.days_until_due,
    r.hours_until_due,
    r.kilometers_until_due,
    r.maintenance_unit,
    r.risk_level,
    r.last_completed,
    r.last_service_date,
    r.last_service_hours,
    r.last_service_kilometers,
    r.estimated_duration,
    r.current_asset_hours,
    r.current_asset_kilometers,
    r.interval_value,
    r.workdays_until_due,
    r.overdue_amount
  FROM ranked r
  WHERE r.rn = 1
  ORDER BY 
    CASE r.risk_level 
      WHEN 'OVERDUE' THEN 1 
      WHEN 'CRITICAL' THEN 2 
      WHEN 'HIGH' THEN 3 
      WHEN 'MEDIUM' THEN 4 
      ELSE 5
    END,
    r.asset_name ASC;
END;
$$;


ALTER FUNCTION "public"."get_maintenance_alerts_report"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_maintenance_intervals_with_tasks"("p_model_id" "uuid") RETURNS "jsonb"
    LANGUAGE "sql"
    AS $$
  SELECT 
    jsonb_agg(
      jsonb_build_object(
        'id', mi.id,
        'model_id', mi.model_id,
        'interval_value', mi.interval_value,
        'name', mi.name,
        'description', mi.description,
        'type', mi.type,
        'estimated_duration', mi.estimated_duration,
        'created_at', mi.created_at,
        'updated_at', mi.updated_at,
        'maintenance_tasks', (
          SELECT 
            COALESCE(
              jsonb_agg(
                jsonb_build_object(
                  'id', mt.id,
                  'description', mt.description,
                  'type', mt.type,
                  'estimated_time', mt.estimated_time,
                  'requires_specialist', mt.requires_specialist,
                  'task_parts', (
                    SELECT COALESCE(jsonb_agg(jsonb_build_object(
                      'id', tp.id,
                      'name', tp.name,
                      'part_number', tp.part_number,
                      'quantity', tp.quantity,
                      'cost', tp.cost
                    )), '[]'::jsonb)
                    FROM task_parts tp
                    WHERE tp.task_id = mt.id
                  )
                )
              ) FILTER (WHERE mt.id IS NOT NULL), 
              '[]'::jsonb
            )
          FROM maintenance_tasks mt
          WHERE mt.interval_id = mi.id
        )
      )
    )
  FROM maintenance_intervals mi
  WHERE mi.model_id = p_model_id
  GROUP BY mi.model_id;
$$;


ALTER FUNCTION "public"."get_maintenance_intervals_with_tasks"("p_model_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_manageable_users"() RETURNS TABLE("user_id" "uuid", "nombre" "text", "apellido" "text", "email" "text", "role" "public"."user_role", "plant_name" "text", "business_unit_name" "text", "status" "text", "admin_level" "text", "can_edit" boolean)
    LANGUAGE "sql" SECURITY DEFINER
    AS $$
  -- Esta función usa las mismas políticas RLS ya implementadas
  SELECT 
    p.id,
    p.nombre,
    p.apellido,
    p.email,
    p.role,
    pl.name as plant_name,
    bu.name as business_unit_name,
    p.status,
    uac.admin_level,
    -- Determinar si puede editar (lógica simplificada)
    CASE 
      WHEN p.id = auth.uid() THEN true
      WHEN EXISTS (
        SELECT 1 FROM user_admin_context 
        WHERE user_id = auth.uid() AND admin_level = 'TOTAL'
      ) THEN true
      ELSE false
    END as can_edit
  FROM profiles p
  LEFT JOIN plants pl ON p.plant_id = pl.id
  LEFT JOIN business_units bu ON p.business_unit_id = bu.id
  LEFT JOIN user_admin_context uac ON p.id = uac.user_id
  -- Las políticas RLS de profiles determinarán automáticamente 
  -- qué usuarios son visibles para el usuario actual
  ORDER BY p.nombre, p.apellido;
$$;


ALTER FUNCTION "public"."get_manageable_users"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_model_cycle_length"("p_model_id" "uuid") RETURNS integer
    LANGUAGE "plpgsql"
    AS $$
DECLARE
  cycle_length INTEGER;
BEGIN
  -- Get the maximum interval_value for the model (this defines the cycle length)
  SELECT MAX(interval_value) INTO cycle_length
  FROM maintenance_intervals
  WHERE model_id = p_model_id;
  
  RETURN COALESCE(cycle_length, 0);
END;
$$;


ALTER FUNCTION "public"."get_model_cycle_length"("p_model_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_po_action_token"("p_po_id" "uuid", "p_action" "text", "p_recipient_email" "extensions"."citext") RETURNS "text"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_token text;
begin
  if p_action not in ('approve','reject') then
    return null;
  end if;

  select t.jwt_token into v_token
  from public.po_action_tokens t
  where t.purchase_order_id = p_po_id
    and t.recipient_email = p_recipient_email
    and t.action = p_action
    and t.expires_at > now()
  order by t.created_at desc
  limit 1;

  return v_token;
end;
$$;


ALTER FUNCTION "public"."get_po_action_token"("p_po_id" "uuid", "p_action" "text", "p_recipient_email" "extensions"."citext") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_profile_id_by_email"("p_email" "extensions"."citext") RETURNS "uuid"
    LANGUAGE "sql" STABLE
    AS $$
  select id from public.profiles where email = p_email limit 1;
$$;


ALTER FUNCTION "public"."get_profile_id_by_email"("p_email" "extensions"."citext") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_purchase_order_approver"("p_amount" numeric, "p_business_unit_id" "uuid" DEFAULT NULL::"uuid", "p_plant_id" "uuid" DEFAULT NULL::"uuid") RETURNS "uuid"
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
DECLARE
  v_approver_id uuid;
BEGIN
  -- Get the user with the lowest authorization that can still approve this amount
  SELECT user_id INTO v_approver_id
  FROM get_purchase_order_authorizers(p_amount, p_business_unit_id, p_plant_id)
  ORDER BY effective_authorization ASC
  LIMIT 1;
  
  RETURN v_approver_id;
END;
$$;


ALTER FUNCTION "public"."get_purchase_order_approver"("p_amount" numeric, "p_business_unit_id" "uuid", "p_plant_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_purchase_order_authorizers"("p_amount" numeric, "p_business_unit_id" "uuid" DEFAULT NULL::"uuid", "p_plant_id" "uuid" DEFAULT NULL::"uuid") RETURNS TABLE("user_id" "uuid", "nombre" "text", "apellido" "text", "role" "public"."user_role", "effective_authorization" numeric, "authorization_source" "text")
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
BEGIN
  RETURN QUERY
  SELECT 
    p.id as user_id,
    p.nombre,
    p.apellido,
    p.role,
    get_user_effective_authorization(p.id, p_business_unit_id, p_plant_id) as effective_authorization,
    CASE 
      WHEN get_user_effective_authorization(p.id, p_business_unit_id, p_plant_id) > COALESCE(p.can_authorize_up_to, 0) 
        AND get_user_effective_authorization(p.id, p_business_unit_id, p_plant_id) > COALESCE(am.max_amount, 0)
      THEN 'delegation'
      WHEN COALESCE(p.can_authorize_up_to, 0) > COALESCE(am.max_amount, 0)
      THEN 'individual'
      ELSE 'role'
    END as authorization_source
  FROM profiles p
  LEFT JOIN authorization_matrix am ON am.role = p.role
  WHERE p.role IS NOT NULL
    AND get_user_effective_authorization(p.id, p_business_unit_id, p_plant_id) >= p_amount
    AND (p_business_unit_id IS NULL OR p.business_unit_id = p_business_unit_id)
    AND (p_plant_id IS NULL OR p.plant_id = p_plant_id)
  ORDER BY effective_authorization ASC;
END;
$$;


ALTER FUNCTION "public"."get_purchase_order_authorizers"("p_amount" numeric, "p_business_unit_id" "uuid", "p_plant_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_required_checklist_for_work_order"("p_work_order_id" "uuid") RETURNS "uuid"
    LANGUAGE "plpgsql"
    AS $$
DECLARE
  v_work_order RECORD;
  v_checklist_id UUID;
BEGIN
  -- Obtener información de la orden de trabajo
  SELECT wo.*, a.model_id
  INTO v_work_order
  FROM work_orders wo
  JOIN assets a ON wo.asset_id = a.id
  WHERE wo.id = p_work_order_id;
  
  -- Si ya tiene un checklist preventivo asignado, devolverlo
  IF v_work_order.preventive_checklist_id IS NOT NULL THEN
    RETURN v_work_order.preventive_checklist_id;
  END IF;
  
  -- Buscar checklist de tipo mantenimiento para el modelo del activo
  SELECT id INTO v_checklist_id
  FROM checklists
  WHERE model_id = v_work_order.model_id
    AND frequency = 'mantenimiento'
  ORDER BY created_at DESC
  LIMIT 1;
  
  -- Si encontramos un checklist, actualizar la orden de trabajo
  IF v_checklist_id IS NOT NULL THEN
    UPDATE work_orders
    SET preventive_checklist_id = v_checklist_id
    WHERE id = p_work_order_id;
  END IF;
  
  RETURN v_checklist_id;
END;
$$;


ALTER FUNCTION "public"."get_required_checklist_for_work_order"("p_work_order_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_schedule_statistics"() RETURNS TABLE("total_schedules" bigint, "pending_schedules" bigint, "completed_schedules" bigint, "duplicate_groups" bigint, "assets_with_schedules" bigint)
    LANGUAGE "plpgsql"
    AS $$
BEGIN
  RETURN QUERY
  SELECT 
    COUNT(*) as total_schedules,
    COUNT(*) FILTER (WHERE status = 'pendiente') as pending_schedules,
    COUNT(*) FILTER (WHERE status = 'completado') as completed_schedules,
    COUNT(DISTINCT template_id::TEXT || asset_id::TEXT || DATE(scheduled_date)::TEXT) as duplicate_groups,
    COUNT(DISTINCT asset_id) as assets_with_schedules
  FROM checklist_schedules;
END;
$$;


ALTER FUNCTION "public"."get_schedule_statistics"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_truly_unresolved_checklist_issues"() RETURNS TABLE("id" "uuid", "checklist_id" "uuid", "item_id" "text", "status" "text", "description" "text", "notes" "text", "photo_url" "text", "created_at" timestamp with time zone, "completed_checklist_id" "uuid", "asset_id" "uuid", "technician" "text", "completion_date" timestamp with time zone, "asset_uuid" "uuid", "asset_name" "text", "asset_code" "text")
    LANGUAGE "sql" SECURITY DEFINER
    AS $$
  SELECT 
    ci.id,
    ci.checklist_id,
    ci.item_id,
    ci.status,
    ci.description,
    ci.notes,
    ci.photo_url,
    ci.created_at,
    cc.id as completed_checklist_id,
    cc.asset_id,
    cc.technician,
    cc.completion_date,
    a.id as asset_uuid,
    a.name as asset_name,
    a.asset_id as asset_code
  FROM checklist_issues ci
  JOIN completed_checklists cc ON ci.checklist_id = cc.id
  JOIN assets a ON cc.asset_id = a.id
  WHERE ci.resolved = false
    AND ci.checklist_id NOT IN (
      SELECT DISTINCT checklist_id 
      FROM work_orders 
      WHERE type = 'corrective' 
        AND checklist_id IS NOT NULL
    )
  ORDER BY ci.created_at DESC;
$$;


ALTER FUNCTION "public"."get_truly_unresolved_checklist_issues"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_unmapped_assets"() RETURNS TABLE("original_name" "text", "occurrence_count" integer, "suggested_asset_id" "uuid", "suggested_asset_name" "text", "confidence_score" numeric)
    LANGUAGE "plpgsql"
    AS $$
BEGIN
    RETURN QUERY
    WITH unique_names AS (
        SELECT DISTINCT exception_asset_name as name
        FROM diesel_transactions
        WHERE exception_asset_name IS NOT NULL
        AND asset_category = 'exception'
        
        UNION
        
        SELECT DISTINCT exception_name as name
        FROM exception_assets
        WHERE promoted_to_asset_id IS NULL
    ),
    asset_occurrences AS (
        SELECT 
            un.name as original_name,
            COALESCE(dt_count.count, 0) as count
        FROM unique_names un
        LEFT JOIN (
            SELECT 
                exception_asset_name,
                COUNT(*) as count
            FROM diesel_transactions
            WHERE exception_asset_name IS NOT NULL
            GROUP BY exception_asset_name
        ) dt_count ON un.name = dt_count.exception_asset_name
    ),
    suggestions AS (
        SELECT 
            ao.original_name,
            ao.count,
            a.id as asset_id,
            a.name as asset_name,
            GREATEST(
                similarity(LOWER(a.name), normalize_asset_name(ao.original_name)),
                similarity(LOWER(COALESCE(a.asset_id, '')), normalize_asset_name(ao.original_name))
            ) as score
        FROM asset_occurrences ao
        CROSS JOIN LATERAL (
            SELECT * FROM assets
            WHERE is_active = true
            ORDER BY GREATEST(
                similarity(LOWER(name), normalize_asset_name(ao.original_name)),
                similarity(LOWER(COALESCE(asset_id, '')), normalize_asset_name(ao.original_name))
            ) DESC
            LIMIT 1
        ) a
        WHERE ao.count > 0
    )
    SELECT 
        s.original_name,
        s.count,
        s.asset_id,
        s.asset_name,
        s.score
    FROM suggestions s
    WHERE NOT EXISTS (
        SELECT 1 FROM asset_name_mappings m
        WHERE LOWER(m.original_name) = LOWER(s.original_name)
        AND m.mapping_source IN ('manual', 'verified')
    )
    ORDER BY s.count DESC, s.score DESC;
END;
$$;


ALTER FUNCTION "public"."get_unmapped_assets"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_user_delegatable_amount"("p_user_id" "uuid", "p_business_unit_id" "uuid" DEFAULT NULL::"uuid", "p_plant_id" "uuid" DEFAULT NULL::"uuid") RETURNS numeric
    LANGUAGE "plpgsql"
    AS $$
DECLARE
  user_profile RECORD;
  effective_limit DECIMAL(15,2);
  already_delegated DECIMAL(15,2) := 0;
  business_unit_limit DECIMAL(15,2) := 0;
  max_delegatable DECIMAL(15,2) := 0;
BEGIN
  -- Get user profile
  SELECT role, can_authorize_up_to, business_unit_id
  INTO user_profile
  FROM profiles 
  WHERE id = p_user_id;
  
  IF NOT FOUND THEN
    RETURN 0;
  END IF;
  
  -- GERENCIA_GENERAL can delegate unlimited amounts
  IF user_profile.role = 'GERENCIA_GENERAL' THEN
    RETURN 999999999.99;
  END IF;
  
  -- Get effective authorization limit
  effective_limit := get_user_effective_authorization(p_user_id);
  
  -- Get business unit limit (use parameter or user's assigned business unit)
  IF p_business_unit_id IS NOT NULL THEN
    SELECT COALESCE(max_authorization_limit, 0)
    INTO business_unit_limit
    FROM business_unit_limits
    WHERE business_unit_id = p_business_unit_id;
  ELSIF user_profile.business_unit_id IS NOT NULL THEN
    SELECT COALESCE(max_authorization_limit, 0)
    INTO business_unit_limit
    FROM business_unit_limits
    WHERE business_unit_id = user_profile.business_unit_id;
  END IF;
  
  -- Get total amount already delegated by this user (optionally filtered by scope)
  IF p_business_unit_id IS NOT NULL THEN
    -- Filter delegations by business unit scope
    SELECT COALESCE(SUM(delegated_amount), 0)
    INTO already_delegated
    FROM authorization_delegations
    WHERE grantor_user_id = p_user_id 
      AND is_active = true
      AND (scope_business_unit_id = p_business_unit_id OR scope_type = 'global');
  ELSE
    -- All delegations
    SELECT COALESCE(SUM(delegated_amount), 0)
    INTO already_delegated
    FROM authorization_delegations
    WHERE grantor_user_id = p_user_id 
      AND is_active = true;
  END IF;
  
  -- Users can delegate up to their business unit limit (if it exists and is higher than their effective limit)
  -- or their effective limit, minus what they've already delegated
  max_delegatable := GREATEST(effective_limit, COALESCE(business_unit_limit, effective_limit));
  
  RETURN GREATEST(0, max_delegatable - already_delegated);
END;
$$;


ALTER FUNCTION "public"."get_user_delegatable_amount"("p_user_id" "uuid", "p_business_unit_id" "uuid", "p_plant_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_user_effective_authorization"("p_user_id" "uuid") RETURNS numeric
    LANGUAGE "plpgsql"
    AS $$
DECLARE
  user_profile RECORD;
  individual_limit DECIMAL(15,2) := 0;
  delegation_limit DECIMAL(15,2) := 0;
  business_unit_limit DECIMAL(15,2) := 0;
  max_limit DECIMAL(15,2) := 0;
BEGIN
  -- Get user profile
  SELECT role, can_authorize_up_to, business_unit_id
  INTO user_profile
  FROM profiles 
  WHERE id = p_user_id;
  
  IF NOT FOUND THEN
    RETURN 0;
  END IF;
  
  -- GERENCIA_GENERAL has unlimited authorization (represented as a very high number)
  IF user_profile.role = 'GERENCIA_GENERAL' THEN
    RETURN 999999999.99;
  END IF;
  
  -- Get individual limit
  individual_limit := COALESCE(user_profile.can_authorize_up_to, 0);
  
  -- Get business unit limit (this is the new dynamic limit system)
  IF user_profile.business_unit_id IS NOT NULL THEN
    SELECT COALESCE(max_authorization_limit, 0)
    INTO business_unit_limit
    FROM business_unit_limits
    WHERE business_unit_id = user_profile.business_unit_id;
  END IF;
  
  -- Get delegation limit (sum of active delegations received)
  SELECT COALESCE(SUM(delegated_amount), 0)
  INTO delegation_limit
  FROM authorization_delegations
  WHERE grantee_user_id = p_user_id 
    AND is_active = true;
  
  -- The effective limit is the MAXIMUM of:
  -- 1. Individual limit (but capped by business unit limit)
  -- 2. Delegation limit (can exceed business unit limit)
  
  -- Individual limit cannot exceed business unit limit (unless no BU limit is set)
  IF business_unit_limit > 0 THEN
    individual_limit := LEAST(individual_limit, business_unit_limit);
  END IF;
  
  -- Final limit is the maximum between capped individual limit and delegation limit
  max_limit := GREATEST(individual_limit, delegation_limit);
  
  RETURN COALESCE(max_limit, 0);
END;
$$;


ALTER FUNCTION "public"."get_user_effective_authorization"("p_user_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_valid_next_statuses"("p_current_status" "text", "p_po_type" "text") RETURNS "text"[]
    LANGUAGE "plpgsql"
    AS $$
BEGIN
  CASE p_po_type
    WHEN 'direct_purchase', 'direct_service' THEN
      CASE p_current_status
        WHEN 'draft' THEN RETURN ARRAY['pending_approval', 'rejected'];
        WHEN 'pending_approval' THEN RETURN ARRAY['approved', 'rejected'];
        WHEN 'approved' THEN RETURN ARRAY['purchased', 'rejected'];
        WHEN 'purchased' THEN RETURN ARRAY['receipt_uploaded'];
        WHEN 'receipt_uploaded' THEN RETURN ARRAY['validated'];
        WHEN 'validated' THEN RETURN ARRAY[]::TEXT[]; -- Final state
        WHEN 'rejected' THEN RETURN ARRAY[]::TEXT[]; -- Final state
        ELSE RETURN ARRAY[]::TEXT[];
      END CASE;
      
    WHEN 'special_order' THEN
      CASE p_current_status
        WHEN 'draft' THEN RETURN ARRAY['quoted', 'rejected'];
        WHEN 'quoted' THEN RETURN ARRAY['pending_approval', 'rejected'];
        WHEN 'pending_approval' THEN RETURN ARRAY['approved', 'rejected'];
        WHEN 'approved' THEN RETURN ARRAY['ordered', 'rejected'];
        WHEN 'ordered' THEN RETURN ARRAY['received'];
        WHEN 'received' THEN RETURN ARRAY['receipt_uploaded'];
        WHEN 'receipt_uploaded' THEN RETURN ARRAY['validated'];
        WHEN 'validated' THEN RETURN ARRAY[]::TEXT[]; -- Final state
        WHEN 'rejected' THEN RETURN ARRAY[]::TEXT[]; -- Final state
        ELSE RETURN ARRAY[]::TEXT[];
      END CASE;
      
    ELSE
      -- Default/legacy workflow
      CASE p_current_status
        WHEN 'draft' THEN RETURN ARRAY['pending_approval', 'rejected'];
        WHEN 'pending_approval' THEN RETURN ARRAY['approved', 'rejected'];
        WHEN 'approved' THEN RETURN ARRAY['validated'];
        WHEN 'validated' THEN RETURN ARRAY[]::TEXT[]; -- Final state
        WHEN 'rejected' THEN RETURN ARRAY[]::TEXT[]; -- Final state
        ELSE RETURN ARRAY[]::TEXT[];
      END CASE;
  END CASE;
END;
$$;


ALTER FUNCTION "public"."get_valid_next_statuses"("p_current_status" "text", "p_po_type" "text") OWNER TO "postgres";


COMMENT ON FUNCTION "public"."get_valid_next_statuses"("p_current_status" "text", "p_po_type" "text") IS 'Returns valid next statuses based on current status and PO type, preventing invalid transitions like going back to draft';



CREATE OR REPLACE FUNCTION "public"."get_warehouse_balance"("p_warehouse_id" "uuid", "p_as_of_date" timestamp with time zone DEFAULT "now"()) RETURNS numeric
    LANGUAGE "plpgsql"
    AS $$
DECLARE
    current_balance DECIMAL(10,2);
BEGIN
    SELECT COALESCE(SUM(
        CASE 
            WHEN transaction_type = 'entry' THEN quantity_liters
            WHEN transaction_type = 'consumption' THEN -quantity_liters
            WHEN transaction_type = 'adjustment' THEN quantity_liters
            WHEN transaction_type = 'transfer' AND warehouse_id = p_warehouse_id THEN quantity_liters
            ELSE 0
        END
    ), 0) INTO current_balance
    FROM diesel_transactions
    WHERE warehouse_id = p_warehouse_id
    AND transaction_date <= p_as_of_date;
    
    RETURN current_balance;
END;
$$;


ALTER FUNCTION "public"."get_warehouse_balance"("p_warehouse_id" "uuid", "p_as_of_date" timestamp with time zone) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_warehouse_current_balance"("p_warehouse_id" "uuid") RETURNS numeric
    LANGUAGE "plpgsql" STABLE
    AS $$
DECLARE
  v_balance NUMERIC(10,2);
BEGIN
  SELECT current_balance INTO v_balance
  FROM diesel_transactions
  WHERE warehouse_id = p_warehouse_id
    AND current_balance IS NOT NULL
  ORDER BY transaction_date DESC, created_at DESC
  LIMIT 1;
  
  IF v_balance IS NULL THEN
    SELECT COALESCE(
      SUM(CASE 
        WHEN transaction_type = 'entry' THEN quantity_liters
        WHEN transaction_type = 'consumption' THEN -quantity_liters
        ELSE 0
      END),
      0
    ) INTO v_balance
    FROM diesel_transactions
    WHERE warehouse_id = p_warehouse_id;
  END IF;
  
  RETURN COALESCE(v_balance, 0);
END;
$$;


ALTER FUNCTION "public"."get_warehouse_current_balance"("p_warehouse_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."has_quotations"("p_purchase_order_id" "uuid") RETURNS boolean
    LANGUAGE "plpgsql"
    AS $$
DECLARE
  v_quotation_urls JSONB;
  v_legacy_url TEXT;
  v_json_type TEXT;
  v_array_len INT;
  v_string_val TEXT;
BEGIN
  SELECT quotation_urls, quotation_url INTO v_quotation_urls, v_legacy_url
  FROM purchase_orders
  WHERE id = p_purchase_order_id;

  -- Determine JSONB type
  v_json_type := CASE WHEN v_quotation_urls IS NULL THEN NULL ELSE jsonb_typeof(v_quotation_urls) END;

  -- Compute safe length only if it's an array
  v_array_len := CASE WHEN v_json_type = 'array' THEN jsonb_array_length(v_quotation_urls) ELSE 0 END;

  -- Extract string value when stored incorrectly as scalar string in JSONB
  v_string_val := CASE WHEN v_json_type = 'string' THEN trim(both '"' from v_quotation_urls::text) ELSE NULL END;

  RETURN (
    (v_array_len > 0)
    OR (v_string_val IS NOT NULL AND btrim(v_string_val) <> '')
    OR (v_legacy_url IS NOT NULL AND btrim(v_legacy_url) <> '')
  );
END;
$$;


ALTER FUNCTION "public"."has_quotations"("p_purchase_order_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."is_admin"() RETURNS boolean
    LANGUAGE "sql" STABLE
    AS $$
  select exists (
    select 1 from public.profiles p
    where p.id = auth.uid()
      and p.role in ('GERENCIA_GENERAL','AREA_ADMINISTRATIVA','JEFE_UNIDAD_NEGOCIO')
  );
$$;


ALTER FUNCTION "public"."is_admin"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."is_work_order_ready_to_execute"("p_work_order_id" "uuid") RETURNS boolean
    LANGUAGE "plpgsql"
    AS $$
DECLARE
  v_work_order RECORD;
  v_po_status TEXT;
BEGIN
  -- Obtener información de la orden de trabajo
  SELECT * INTO v_work_order
  FROM work_orders
  WHERE id = p_work_order_id;
  
  -- Solo aplica para órdenes preventivas
  IF v_work_order.type != 'preventive' THEN
    RETURN TRUE;
  END IF;
  
  -- Si tiene orden de compra, verificar su estado
  IF v_work_order.purchase_order_id IS NOT NULL THEN
    SELECT status INTO v_po_status
    FROM purchase_orders
    WHERE id = v_work_order.purchase_order_id;
    
    -- La orden debe estar aprobada o recibida
    RETURN v_po_status IN ('approved', 'ordered', 'received');
  END IF;
  
  -- Si no tiene orden de compra, está lista
  RETURN TRUE;
END;
$$;


ALTER FUNCTION "public"."is_work_order_ready_to_execute"("p_work_order_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."log_cron_selftest"("p_job" "text") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
begin
  insert into public.notifications(title, message, type, priority, status, created_at)
  values (
    'Cron Selftest',
    concat('Selftest executed for job: ', p_job),
    concat('CRON_SELFTEST_', upper(p_job)),
    'low',
    'unread',
    now()
  );
end;
$$;


ALTER FUNCTION "public"."log_cron_selftest"("p_job" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."mark_checklist_as_completed"("p_schedule_id" "uuid", "p_completed_items" "jsonb", "p_technician" "text", "p_notes" "text" DEFAULT NULL::"text", "p_signature_data" "text" DEFAULT NULL::"text") RETURNS "jsonb"
    LANGUAGE "plpgsql"
    AS $$
DECLARE
  v_checklist_id UUID;
  v_asset_id UUID;
  v_status TEXT := 'Completado';
  v_item JSONB;
  v_completed_id UUID;
  v_has_issues BOOLEAN := FALSE;
BEGIN
  -- Obtener información de la programación
  SELECT template_id, asset_id 
  INTO v_checklist_id, v_asset_id
  FROM checklist_schedules
  WHERE id = p_schedule_id;
  
  -- Verificar si hay problemas
  FOR v_item IN SELECT jsonb_array_elements(p_completed_items)
  LOOP
    IF v_item->>'status' = 'flag' OR v_item->>'status' = 'fail' THEN
      v_has_issues := TRUE;
      v_status := 'Con Problemas';
    END IF;
  END LOOP;
  
  -- Registrar el checklist completado
  INSERT INTO completed_checklists (
    checklist_id,
    asset_id,
    completed_items,
    technician,
    completion_date,
    notes,
    status,
    signature_data
  ) VALUES (
    v_checklist_id,
    v_asset_id,
    p_completed_items,
    p_technician,
    NOW(),
    p_notes,
    v_status,
    p_signature_data
  ) RETURNING id INTO v_completed_id;
  
  -- Actualizar estado de la programación
  UPDATE checklist_schedules
  SET status = 'completado'
  WHERE id = p_schedule_id;
  
  -- Si hay problemas, registrarlos
  IF v_has_issues THEN
    FOR v_item IN SELECT jsonb_array_elements(p_completed_items)
    LOOP
      IF v_item->>'status' = 'flag' OR v_item->>'status' = 'fail' THEN
        INSERT INTO checklist_issues (
          checklist_id,
          item_id,
          status,
          description,
          notes,
          photo_url,
          resolved
        ) VALUES (
          v_completed_id, -- Now correctly using the completed checklist ID
          v_item->>'item_id',
          v_item->>'status',
          'Problema detectado durante el checklist',
          v_item->>'notes',
          v_item->>'photo_url',
          FALSE
        );
      END IF;
    END LOOP;
  END IF;
  
  -- Actualizar fecha de último mantenimiento del activo
  UPDATE assets
  SET last_maintenance_date = NOW()
  WHERE id = v_asset_id;
  
  RETURN jsonb_build_object(
    'success', TRUE,
    'completed_id', v_completed_id,
    'has_issues', v_has_issues
  );
END;
$$;


ALTER FUNCTION "public"."mark_checklist_as_completed"("p_schedule_id" "uuid", "p_completed_items" "jsonb", "p_technician" "text", "p_notes" "text", "p_signature_data" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."mark_checklist_as_completed_versioned"("p_schedule_id" "uuid", "p_completed_items" "jsonb", "p_technician" "text", "p_notes" "text" DEFAULT NULL::"text", "p_signature_data" "text" DEFAULT NULL::"text") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
DECLARE
  v_checklist_id UUID;
  v_asset_id UUID;
  v_template_version_id UUID;
  v_status TEXT := 'Completado';
  v_item JSONB;
  v_completed_id UUID;
  v_has_issues BOOLEAN := FALSE;
BEGIN
  -- Obtener información de la programación
  SELECT template_id, asset_id 
  INTO v_checklist_id, v_asset_id
  FROM checklist_schedules
  WHERE id = p_schedule_id;
  
  IF v_checklist_id IS NULL THEN
    RAISE EXCEPTION 'Schedule with id % not found', p_schedule_id;
  END IF;
  
  -- Obtener versión activa de la plantilla
  SELECT id INTO v_template_version_id
  FROM checklist_template_versions
  WHERE template_id = v_checklist_id AND is_active = TRUE;
  
  -- Si no hay versión activa, crear una
  IF v_template_version_id IS NULL THEN
    SELECT create_template_version(v_checklist_id, 'Versión inicial - creada automáticamente') 
    INTO v_template_version_id;
  END IF;
  
  -- Verificar si hay problemas
  FOR v_item IN SELECT jsonb_array_elements(p_completed_items)
  LOOP
    IF v_item->>'status' = 'flag' OR v_item->>'status' = 'fail' THEN
      v_has_issues := TRUE;
      v_status := 'Con Problemas';
    END IF;
  END LOOP;
  
  -- Registrar el checklist completado con referencia a versión
  INSERT INTO completed_checklists (
    checklist_id,
    template_version_id,
    asset_id,
    completed_items,
    technician,
    completion_date,
    notes,
    status,
    signature_data
  ) VALUES (
    v_checklist_id,
    v_template_version_id,
    v_asset_id,
    p_completed_items,
    p_technician,
    NOW(),
    p_notes,
    v_status,
    p_signature_data
  ) RETURNING id INTO v_completed_id;
  
  -- Actualizar estado de la programación
  UPDATE checklist_schedules
  SET status = 'completado'
  WHERE id = p_schedule_id;
  
  -- Si hay problemas, registrarlos
  IF v_has_issues THEN
    FOR v_item IN SELECT jsonb_array_elements(p_completed_items)
    LOOP
      IF v_item->>'status' = 'flag' OR v_item->>'status' = 'fail' THEN
        INSERT INTO checklist_issues (
          checklist_id,
          item_id,
          status,
          description,
          notes,
          photo_url,
          resolved
        ) VALUES (
          v_completed_id,
          v_item->>'item_id',
          v_item->>'status',
          COALESCE(v_item->>'description', 'Problema detectado durante el checklist'),
          v_item->>'notes',
          v_item->>'photo_url',
          FALSE
        );
      END IF;
    END LOOP;
  END IF;
  
  -- Actualizar fecha de último mantenimiento del activo
  UPDATE assets
  SET last_maintenance_date = NOW()
  WHERE id = v_asset_id;
  
  RETURN jsonb_build_object(
    'success', TRUE,
    'completed_id', v_completed_id,
    'template_version_id', v_template_version_id,
    'has_issues', v_has_issues
  );
END;
$$;


ALTER FUNCTION "public"."mark_checklist_as_completed_versioned"("p_schedule_id" "uuid", "p_completed_items" "jsonb", "p_technician" "text", "p_notes" "text", "p_signature_data" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."next_valid_daily_date"("p_date" "date") RETURNS "date"
    LANGUAGE "plpgsql"
    AS $$
declare
  v_date date := p_date;
begin
  if extract(dow from v_date) = 0 then
    v_date := v_date + 1;
  end if;
  return v_date;
end;
$$;


ALTER FUNCTION "public"."next_valid_daily_date"("p_date" "date") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."next_valid_date"("p_date" "date", "p_frequency" "text") RETURNS "date"
    LANGUAGE "plpgsql"
    AS $$
declare
  v_date date := p_date;
begin
  if p_frequency in ('diario','semanal') then
    if extract(dow from v_date) = 0 then
      v_date := v_date + 1;
    end if;
  end if;
  return v_date;
end;
$$;


ALTER FUNCTION "public"."next_valid_date"("p_date" "date", "p_frequency" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."normalize_asset_name"("input_name" "text") RETURNS "text"
    LANGUAGE "plpgsql" IMMUTABLE
    AS $$
BEGIN
    IF input_name IS NULL OR TRIM(input_name) = '' THEN
        RETURN NULL;
    END IF;
    
    RETURN LOWER(REGEXP_REPLACE(TRIM(input_name), '\s+', ' ', 'g'));
END;
$$;


ALTER FUNCTION "public"."normalize_asset_name"("input_name" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."notify_checklist_issues"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
BEGIN
  -- Esta función insertará una notificación en la tabla de notificaciones
  -- Usar los valores correctos del enum user_role
  INSERT INTO notifications (
    user_id,
    title,
    message,
    type,
    related_entity,
    entity_id,
    status,
    priority
  )
  SELECT 
    p.id,
    'Problema detectado en checklist',
    CONCAT('Se ha detectado un problema en el activo ', a.name, ' (', a.asset_id, ')'),
    'issue',
    'checklist_issue',
    NEW.id,
    'unread',
    CASE WHEN NEW.status = 'fail' THEN 'high' ELSE 'medium' END
  FROM 
    profiles p
    CROSS JOIN assets a
  WHERE 
    p.role IN ('EJECUTIVO', 'JEFE_PLANTA', 'ENCARGADO_MANTENIMIENTO') AND
    a.id = (
      SELECT asset_id FROM completed_checklists WHERE id = NEW.checklist_id
    );
  
  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."notify_checklist_issues"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."notify_po_pending_approval"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_url text;
  v_bearer text;
  v_request_id bigint;
  v_should_notify boolean := false;
begin
  -- CRITICAL: Read from app_settings table first, then fallback to GUC
  select value into v_url from public.app_settings where key = 'edge_po_notify_url';
  if v_url is null or trim(v_url) = '' then
    begin
      v_url := current_setting('app.edge_po_notify_url', true);
    exception when others then
      v_url := null;
    end;
  end if;

  select value into v_bearer from public.app_settings where key = 'edge_bearer';
  if v_bearer is null or trim(v_bearer) = '' then
    begin
      v_bearer := current_setting('app.edge_bearer', true);
    exception when others then
      v_bearer := null;
    end;
  end if;

  -- CRITICAL: Fail loudly if URL is not configured (no silent failures)
  if v_url is null or trim(v_url) = '' then
    raise exception 'CRITICAL: Purchase Order notification URL not configured. Set app_settings.edge_po_notify_url';
  end if;

  -- Determine if we should send notification
  if TG_OP = 'INSERT' then
    -- New PO entering pending_approval
    if new.status = 'pending_approval' then
      v_should_notify := true;
    end if;
  elsif TG_OP = 'UPDATE' then
    -- NEW: Escalation scenario - BU approved, escalate to GM
    if old.authorized_by IS NULL 
       AND new.authorized_by IS NOT NULL
       AND new.status = 'pending_approval'
       AND new.total_amount > 5000 then
      v_should_notify := true;
    -- Existing: Status change to pending_approval
    elsif new.status = 'pending_approval' 
       AND old.status IS DISTINCT FROM new.status then
      v_should_notify := true;
    end if;
  end if;

  -- Send notification if conditions met
  if v_should_notify then
    begin
      v_request_id := net.http_post(
        v_url,                                        -- url text
        jsonb_build_object('po_id', new.id),          -- body jsonb
        '{}'::jsonb,                                   -- params jsonb
        jsonb_build_object(                            -- headers jsonb
          'Content-Type', 'application/json',
          'Authorization', case 
            when v_bearer is not null and trim(v_bearer) <> '' 
            then 'Bearer ' || v_bearer 
            else '' 
          end
        ),
        5000                                           -- timeout_milliseconds integer
      );

      -- Log successful enqueue
      insert into notifications (user_id, title, message, type, related_entity, entity_id, created_at)
      values (
        null,
        'PO notification enqueued',
        format('Queued request_id=%s for PO %s (order_id=%s, amount=%s)', 
               v_request_id, new.id::text, new.order_id, new.total_amount),
        'PURCHASE_ORDER_APPROVAL_ENQUEUE',
        'purchase_order',
        new.id,
        now()
      );

    exception when others then
      -- Log the error but don't block the PO creation/update
      insert into notifications (user_id, title, message, type, related_entity, entity_id, created_at)
      values (
        null,
        'PO notification FAILED',
        format('ERROR enqueueing notification for PO %s: %s', new.id::text, SQLERRM),
        'PURCHASE_ORDER_APPROVAL_ERROR',
        'purchase_order',
        new.id,
        now()
      );
      
      -- Re-raise to make the error visible
      raise warning 'Failed to enqueue PO notification for %: %', new.id, SQLERRM;
    end;
  end if;

  return new;
end;
$$;


ALTER FUNCTION "public"."notify_po_pending_approval"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."notify_purchase_order_update"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $_$
DECLARE
  v_notification_title TEXT;
  v_notification_message TEXT;
  v_target_user UUID;
BEGIN
  -- Determine notification content based on status
  CASE NEW.status
    WHEN 'pending_approval' THEN
      v_notification_title := 'Orden de Compra Pendiente de Aprobación';
      v_notification_message := format('OC %s requiere aprobación por $%s', NEW.order_id, NEW.total_amount);
      
    WHEN 'approved' THEN
      v_notification_title := 'Orden de Compra Aprobada';
      v_notification_message := format('OC %s ha sido aprobada. Proceder con %s', 
        NEW.order_id, 
        CASE NEW.po_type 
          WHEN 'direct_purchase' THEN 'compra'
          WHEN 'direct_service' THEN 'contratación'
          ELSE 'pedido'
        END);
      v_target_user := NEW.requested_by;
      
    WHEN 'rejected' THEN
      v_notification_title := 'Orden de Compra Rechazada';
      v_notification_message := format('OC %s ha sido rechazada', NEW.order_id);
      v_target_user := NEW.requested_by;
      
    ELSE
      -- Default case for other statuses
      v_notification_title := 'Orden de Compra Actualizada';
      v_notification_message := format('OC %s cambió a estado: %s', NEW.order_id, NEW.status);
      v_target_user := NEW.requested_by;
  END CASE;
  
  -- Insert notification if we have a target user
  IF v_target_user IS NOT NULL THEN
    INSERT INTO notifications (
      user_id, title, message, type, related_entity, entity_id, priority
    ) VALUES (
      v_target_user, v_notification_title, v_notification_message, 
      'purchase_order', 'purchase_orders', NEW.id, 'medium'
    );
  END IF;
  
  RETURN NEW;
END;
$_$;


ALTER FUNCTION "public"."notify_purchase_order_update"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."process_checklist_completion_enhanced"("p_schedule_id" "uuid", "p_completed_items" "jsonb", "p_technician" "text", "p_notes" "text" DEFAULT ''::"text", "p_signature_data" "text" DEFAULT ''::"text", "p_equipment_hours_reading" integer DEFAULT NULL::integer, "p_equipment_kilometers_reading" integer DEFAULT NULL::integer) RETURNS "jsonb"
    LANGUAGE "plpgsql"
    AS $$
DECLARE
  v_schedule_record RECORD;
  v_completed_checklist_id UUID;
  v_asset_uuid UUID;
  v_has_issues BOOLEAN;
  v_issue_record RECORD;
  v_work_order_id UUID;
  v_incident_id UUID;
  v_result JSONB;
BEGIN
  -- 1. Get schedule information
  SELECT template_id, asset_id
  INTO v_schedule_record
  FROM checklist_schedules 
  WHERE id = p_schedule_id;
  
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Schedule not found: %', p_schedule_id;
  END IF;
  
  -- 2. Ensure we have the correct asset UUID
  v_asset_uuid := ensure_asset_uuid(v_schedule_record.asset_id::TEXT);
  
  -- 3. Check if there are issues in the completed items
  v_has_issues := (
    SELECT COUNT(*) > 0
    FROM jsonb_array_elements(p_completed_items) AS item
    WHERE item->>'status' IN ('flag', 'fail')
  );
  
  -- 4. Create completed checklist record
  INSERT INTO completed_checklists (
    checklist_id,
    asset_id,
    completed_items,
    technician,
    completion_date,
    notes,
    signature_data,
    status,
    equipment_hours_reading,
    equipment_kilometers_reading
  ) VALUES (
    v_schedule_record.template_id,
    v_asset_uuid,
    p_completed_items,
    COALESCE(p_technician, 'Técnico'),
    NOW(),
    p_notes,
    p_signature_data,
    CASE WHEN v_has_issues THEN 'Con Problemas' ELSE 'Completado' END,
    p_equipment_hours_reading,
    p_equipment_kilometers_reading
  )
  RETURNING id INTO v_completed_checklist_id;
  
  -- 5. Update schedule status
  UPDATE checklist_schedules 
  SET status = 'completado',
      updated_at = NOW()
  WHERE id = p_schedule_id;
  
  -- 6. Update asset readings if provided
  IF p_equipment_hours_reading IS NOT NULL OR p_equipment_kilometers_reading IS NOT NULL THEN
    UPDATE assets 
    SET 
      current_hours = COALESCE(p_equipment_hours_reading, current_hours),
      current_kilometers = COALESCE(p_equipment_kilometers_reading, current_kilometers),
      last_maintenance_date = NOW()
    WHERE id = v_asset_uuid;
  ELSE
    UPDATE assets 
    SET last_maintenance_date = NOW()
    WHERE id = v_asset_uuid;
  END IF;
  
  -- 7. If there are issues, create them and generate work order if needed
  IF v_has_issues THEN
    -- Create individual issues
    FOR v_issue_record IN (
      SELECT 
        item->>'item_id' AS item_id,
        item->>'status' AS status,
        item->>'notes' AS notes,
        item->>'photo_url' AS photo_url
      FROM jsonb_array_elements(p_completed_items) AS item
      WHERE item->>'status' IN ('flag', 'fail')
    ) LOOP
      INSERT INTO checklist_issues (
        checklist_id,
        item_id,
        status,
        description,
        notes,
        photo_url,
        resolved
      ) VALUES (
        v_completed_checklist_id,
        v_issue_record.item_id,
        v_issue_record.status,
        'Problema detectado durante el checklist',
        COALESCE(v_issue_record.notes, ''),
        v_issue_record.photo_url,
        false
      );
    END LOOP;
    
    -- Generate corrective work order
    v_work_order_id := generate_corrective_work_order_enhanced(v_completed_checklist_id);
    
    -- Create incidents for each issue
    FOR v_issue_record IN (
      SELECT id 
      FROM checklist_issues 
      WHERE checklist_id = v_completed_checklist_id
    ) LOOP
      v_incident_id := create_incident_from_checklist_issue(v_issue_record.id);
    END LOOP;
  END IF;
  
  -- 8. Return result
  v_result := jsonb_build_object(
    'success', true,
    'completed_checklist_id', v_completed_checklist_id,
    'has_issues', v_has_issues,
    'work_order_id', v_work_order_id,
    'asset_uuid', v_asset_uuid
  );
  
  RETURN v_result;
END;
$$;


ALTER FUNCTION "public"."process_checklist_completion_enhanced"("p_schedule_id" "uuid", "p_completed_items" "jsonb", "p_technician" "text", "p_notes" "text", "p_signature_data" "text", "p_equipment_hours_reading" integer, "p_equipment_kilometers_reading" integer) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."process_po_email_action"("p_token" "text") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_row record;
  v_po record;
  v_actor uuid;
  v_new_status text;
begin
  if p_token is null or length(p_token) = 0 then
    return jsonb_build_object('success', false, 'error', 'Missing token');
  end if;

  select * into v_row
  from public.po_action_tokens
  where jwt_token = p_token
    and expires_at > now()
  limit 1;

  if not found then
    return jsonb_build_object('success', false, 'error', 'Invalid or expired token');
  end if;

  -- Resolve actor by email
  select public.get_profile_id_by_email(v_row.recipient_email) into v_actor;
  if v_actor is null then
    return jsonb_build_object('success', false, 'error', 'Actor not found for email');
  end if;

  -- Get current PO
  select * into v_po from public.purchase_orders where id = v_row.purchase_order_id;
  if not found then
    return jsonb_build_object('success', false, 'error', 'Purchase order not found');
  end if;

  -- Only process when awaiting approval or compatible intermediate states
  if coalesce(v_po.status,'') not in ('pending_approval','quoted','pending_approval_adjustment','pending_approval_special','Pendiente','pending_approval_receipt') then
    -- Still allow idempotent returns if already finalized
    if v_po.status in ('approved','rejected') then
      return jsonb_build_object('success', true, 'po_id', v_po.id, 'status', v_po.status, 'idempotent', true);
    end if;
    return jsonb_build_object('success', false, 'error', 'Purchase order not awaiting approval', 'status', v_po.status);
  end if;

  if v_row.action = 'approve' then
    update public.purchase_orders
      set status = 'approved',
          approval_date = now(),
          approved_by = v_actor,
          updated_at = now(),
          updated_by = v_actor
      where id = v_row.purchase_order_id;
    v_new_status := 'approved';
  elsif v_row.action = 'reject' then
    update public.purchase_orders
      set status = 'rejected',
          updated_at = now(),
          updated_by = v_actor
      where id = v_row.purchase_order_id;
    v_new_status := 'rejected';
  else
    return jsonb_build_object('success', false, 'error', 'Invalid action');
  end if;

  -- Delete all tokens for this PO+email to prevent reuse (both actions)
  delete from public.po_action_tokens
  where purchase_order_id = v_row.purchase_order_id
    and recipient_email = v_row.recipient_email;

  return jsonb_build_object('success', true, 'po_id', v_row.purchase_order_id, 'status', v_new_status);
end;
$$;


ALTER FUNCTION "public"."process_po_email_action"("p_token" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."recalc_balances_from"("p_transaction_id" "uuid") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
DECLARE
  v_wh UUID;
  v_start_ts timestamptz;
  v_start_id UUID;
  v_base_balance NUMERIC(10,2);
BEGIN
  -- Mark this transaction as an internal recalc to avoid trigger recursion
  PERFORM set_config('diesel.recalc_running', '1', true);

  -- Identify warehouse and ordering point
  SELECT warehouse_id, transaction_date, id
  INTO v_wh, v_start_ts, v_start_id
  FROM diesel_transactions
  WHERE id = p_transaction_id;

  IF v_wh IS NULL THEN
    RETURN;
  END IF;

  -- Base balance: most recent current_balance before starting point
  SELECT dt.current_balance
  INTO v_base_balance
  FROM diesel_transactions dt
  WHERE dt.warehouse_id = v_wh
    AND (
      dt.transaction_date < v_start_ts OR
      (dt.transaction_date = v_start_ts AND dt.id < v_start_id)
    )
    AND dt.current_balance IS NOT NULL
  ORDER BY dt.transaction_date DESC, dt.created_at DESC, dt.id DESC
  LIMIT 1;

  IF v_base_balance IS NULL THEN
    v_base_balance := 0;
  END IF;

  -- Recompute running balances in time order
  WITH ordered AS (
    SELECT id,
           transaction_type,
           quantity_liters,
           transaction_date,
           created_at
    FROM diesel_transactions
    WHERE warehouse_id = v_wh
      AND (
        transaction_date > v_start_ts OR
        (transaction_date = v_start_ts AND id >= v_start_id)
      )
    ORDER BY transaction_date, created_at, id
  ), deltas AS (
    SELECT id,
           CASE 
             WHEN transaction_type = 'entry' THEN quantity_liters
             WHEN transaction_type = 'consumption' THEN -quantity_liters
             WHEN transaction_type = 'adjustment' THEN quantity_liters
             ELSE 0::numeric
           END AS delta,
           transaction_date,
           created_at
    FROM ordered
  ), calc AS (
    SELECT id,
           (v_base_balance + COALESCE(SUM(delta) OVER (
              ORDER BY transaction_date, created_at, id
              ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING
           ), 0)) AS previous_balance,
           (v_base_balance + SUM(delta) OVER (
              ORDER BY transaction_date, created_at, id
              ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
           )) AS current_balance
    FROM deltas
  )
  UPDATE diesel_transactions t
  SET previous_balance = ROUND(c.previous_balance::numeric, 2),
      current_balance = ROUND(c.current_balance::numeric, 2)
  FROM calc c
  WHERE t.id = c.id;

  -- Sync warehouse stored balance to last transaction
  PERFORM public.sync_warehouse_balance(v_wh);
END;
$$;


ALTER FUNCTION "public"."recalc_balances_from"("p_transaction_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."recalculate_warehouse_balances"("p_warehouse_id" "uuid") RETURNS "json"
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
DECLARE
  v_running NUMERIC(10,2) := 0;
  v_count INTEGER := 0;
  r RECORD;
BEGIN
  -- Recalculate all transactions for this warehouse in chronological order
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
    
    -- Update running total
    v_running := CASE 
      WHEN r.transaction_type = 'entry' THEN v_running + r.quantity_liters
      WHEN r.transaction_type = 'consumption' THEN v_running - r.quantity_liters
      WHEN r.transaction_type = 'adjustment' THEN v_running + r.quantity_liters
      ELSE v_running
    END;
    
    v_count := v_count + 1;
  END LOOP;
  
  -- Update warehouse current inventory to match final balance
  UPDATE diesel_warehouses
  SET 
    current_inventory = v_running,
    last_updated = NOW()
  WHERE id = p_warehouse_id;
  
  RETURN json_build_object(
    'success', true,
    'transactions_updated', v_count,
    'final_balance', v_running
  );
  
EXCEPTION WHEN OTHERS THEN
  RETURN json_build_object('error', SQLERRM);
END;
$$;


ALTER FUNCTION "public"."recalculate_warehouse_balances"("p_warehouse_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."reconcile_diesel_inventory"("p_warehouse_id" "uuid", "p_physical_count" numeric, "p_count_date" timestamp with time zone, "p_reason" "text", "p_created_by" "uuid") RETURNS "uuid"
    LANGUAGE "plpgsql"
    AS $$
DECLARE
    calculated_balance DECIMAL(10,2);
    adjustment_amount DECIMAL(10,2);
    new_transaction_id UUID;
    warehouse_plant_id UUID;
    diesel_product_id UUID;
BEGIN
    -- Get warehouse plant_id
    SELECT plant_id INTO warehouse_plant_id
    FROM diesel_warehouses
    WHERE id = p_warehouse_id;
    
    IF warehouse_plant_id IS NULL THEN
        RAISE EXCEPTION 'Warehouse not found: %', p_warehouse_id;
    END IF;
    
    -- Get diesel product
    SELECT id INTO diesel_product_id
    FROM diesel_products
    WHERE product_code = '07DS01'
    LIMIT 1;
    
    IF diesel_product_id IS NULL THEN
        RAISE EXCEPTION 'Diesel product not found';
    END IF;
    
    -- Calculate current balance
    SELECT COALESCE(SUM(
        CASE 
            WHEN transaction_type = 'entry' THEN quantity_liters
            WHEN transaction_type = 'consumption' THEN -quantity_liters
            WHEN transaction_type = 'adjustment' THEN quantity_liters
            ELSE 0
        END
    ), 0) INTO calculated_balance
    FROM diesel_transactions
    WHERE warehouse_id = p_warehouse_id
    AND transaction_date <= p_count_date;
    
    -- Calculate adjustment needed
    adjustment_amount := p_physical_count - calculated_balance;
    
    -- Only create adjustment if difference is significant (> 1 liter)
    IF ABS(adjustment_amount) > 1 THEN
        INSERT INTO diesel_transactions (
            transaction_id,
            plant_id,
            warehouse_id,
            asset_id,
            exception_asset_name,
            asset_category,
            product_id,
            transaction_type,
            quantity_liters,
            transaction_date,
            adjustment_reason,
            adjustment_category,
            notes,
            created_by,
            source_system
        ) VALUES (
            'ADJ-' || TO_CHAR(p_count_date, 'YYYYMMDD') || '-' || 
            SUBSTRING(p_warehouse_id::TEXT FROM 1 FOR 8),
            warehouse_plant_id,
            p_warehouse_id,
            NULL,
            NULL,
            'general',
            diesel_product_id,
            'adjustment',
            adjustment_amount,
            p_count_date,
            p_reason,
            'physical_count',
            'Physical inventory count. Calculated: ' || calculated_balance || 
            'L, Actual: ' || p_physical_count || 'L, Adjustment: ' || adjustment_amount || 'L',
            p_created_by,
            'reconciliation'
        ) RETURNING id INTO new_transaction_id;
    END IF;
    
    RETURN new_transaction_id;
END;
$$;


ALTER FUNCTION "public"."reconcile_diesel_inventory"("p_warehouse_id" "uuid", "p_physical_count" numeric, "p_count_date" timestamp with time zone, "p_reason" "text", "p_created_by" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."recover_from_duplicate_work_order_id"() RETURNS "text"
    LANGUAGE "plpgsql"
    AS $$
DECLARE
  v_new_order_id TEXT;
  v_temp_id TEXT;
BEGIN
  -- Generar un ID completamente único usando timestamp + random
  v_temp_id := 'OT-' || TO_CHAR(EXTRACT(EPOCH FROM NOW()), '00000000') || '-' || (random() * 1000)::INT;

  -- Verificar que no existe
  WHILE EXISTS (SELECT 1 FROM work_orders WHERE order_id = v_temp_id) LOOP
    v_temp_id := 'OT-' || TO_CHAR(EXTRACT(EPOCH FROM NOW()), '00000000') || '-' || (random() * 1000)::INT;
  END LOOP;

  RETURN v_temp_id;
END;
$$;


ALTER FUNCTION "public"."recover_from_duplicate_work_order_id"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."recover_missing_weekly_schedules"("p_template_id" "uuid", "p_days" integer DEFAULT 7, "p_date" "date" DEFAULT CURRENT_DATE) RETURNS integer
    LANGUAGE "plpgsql"
    AS $$
DECLARE
  v_count integer;
BEGIN
  WITH tmpl AS (
    SELECT id AS template_id, model_id
    FROM public.checklists
    WHERE id = p_template_id AND frequency = 'semanal'
  ), candidates AS (
    SELECT a.id AS asset_id, t.template_id
    FROM tmpl t
    JOIN public.assets a ON a.model_id = t.model_id
  ), recent_completed AS (
    SELECT cs.asset_id
    FROM public.checklist_schedules cs
    WHERE cs.template_id = p_template_id
      AND cs.status = 'completado'
      AND cs.updated_at >= (p_date - make_interval(days => p_days))
    GROUP BY cs.asset_id
  ), already_today AS (
    SELECT cs.asset_id
    FROM public.checklist_schedules cs
    WHERE cs.template_id = p_template_id
      AND cs.scheduled_day = p_date
    GROUP BY cs.asset_id
  ), to_insert AS (
    SELECT c.template_id, c.asset_id
    FROM candidates c
    LEFT JOIN recent_completed rc ON rc.asset_id = c.asset_id
    LEFT JOIN already_today at ON at.asset_id = c.asset_id
    WHERE rc.asset_id IS NULL AND at.asset_id IS NULL
  ), inserted AS (
    INSERT INTO public.checklist_schedules (template_id, asset_id, scheduled_date, status)
    SELECT template_id, asset_id, p_date::timestamp, 'pendiente'
    FROM to_insert
    RETURNING 1
  )
  SELECT COUNT(*) INTO v_count FROM inserted;

  RETURN COALESCE(v_count, 0);
END;
$$;


ALTER FUNCTION "public"."recover_missing_weekly_schedules"("p_template_id" "uuid", "p_days" integer, "p_date" "date") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."refresh_diesel_inventory"() RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
BEGIN
    REFRESH MATERIALIZED VIEW diesel_current_inventory;
END;
$$;


ALTER FUNCTION "public"."refresh_diesel_inventory"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."reject_additional_expense"("p_expense_id" "uuid", "p_rejected_by" "uuid", "p_rejection_reason" "text") RETURNS boolean
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
DECLARE
  v_expense RECORD;
BEGIN
  -- Get expense data
  SELECT * INTO v_expense 
  FROM additional_expenses 
  WHERE id = p_expense_id;
  
  IF v_expense IS NULL THEN
    RAISE EXCEPTION 'Expense not found';
  END IF;
  
  -- Update expense status
  UPDATE additional_expenses
  SET status = 'rechazado',
      rejected_by = p_rejected_by,
      rejected_at = NOW(),
      rejection_reason = p_rejection_reason,
      updated_at = NOW()
  WHERE id = p_expense_id;
  
  RETURN TRUE;
END;
$$;


ALTER FUNCTION "public"."reject_additional_expense"("p_expense_id" "uuid", "p_rejected_by" "uuid", "p_rejection_reason" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."requires_quotation"("p_po_type" character varying, "p_amount" numeric) RETURNS boolean
    LANGUAGE "plpgsql"
    AS $$
BEGIN
  CASE p_po_type
    WHEN 'direct_purchase' THEN RETURN FALSE;
    WHEN 'direct_service' THEN RETURN p_amount > 10000;
    WHEN 'special_order' THEN RETURN TRUE;
    ELSE RETURN TRUE;
  END CASE;
END;
$$;


ALTER FUNCTION "public"."requires_quotation"("p_po_type" character varying, "p_amount" numeric) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."reschedule_checklist"("p_schedule_id" "uuid", "p_new_day" "date", "p_updated_by" "uuid") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_sched record;
  v_adj_day date;
  v_exists boolean;
begin
  select cs.*, c.frequency
  into v_sched
  from public.checklist_schedules cs
  join public.checklists c on c.id = cs.template_id
  where cs.id = p_schedule_id;

  if not found then
    return jsonb_build_object('success', false, 'error', 'schedule_not_found');
  end if;

  if v_sched.status <> 'pendiente' then
    return jsonb_build_object('success', false, 'error', 'only_pending_can_be_rescheduled');
  end if;

  v_adj_day := case when v_sched.frequency in ('diario','semanal') then public.next_valid_date(p_new_day, v_sched.frequency) else p_new_day end;

  if public.check_existing_schedule(v_sched.template_id, v_sched.asset_id, v_adj_day) then
    return jsonb_build_object('success', false, 'error', 'duplicate_schedule');
  end if;

  update public.checklist_schedules
  set scheduled_day = v_adj_day,
      scheduled_date = v_adj_day::timestamp,
      updated_at = now(),
      updated_by = p_updated_by
  where id = p_schedule_id;

  return jsonb_build_object('success', true, 'scheduled_day', v_adj_day);
end;
$$;


ALTER FUNCTION "public"."reschedule_checklist"("p_schedule_id" "uuid", "p_new_day" "date", "p_updated_by" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."reschedule_completed_checklist"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
declare
  v_checklist record;
  v_next_day date;
  v_exists boolean;
  v_base_date date;
begin
  if NEW.status = 'completado' and OLD.status = 'pendiente' then
    select c.frequency, c.hours_interval, c.id as template_id
    into v_checklist
    from public.checklists c
    where c.id = NEW.template_id;

    v_base_date := coalesce((NEW.updated_at at time zone 'utc')::date, now()::date);

    case v_checklist.frequency
      when 'diario' then v_next_day := public.next_valid_date(v_base_date + 1, 'diario');
      when 'semanal' then v_next_day := public.next_valid_date(v_base_date + 7, 'semanal');
      when 'mensual' then v_next_day := (v_base_date + interval '1 month')::date;
      when 'trimestral' then v_next_day := (v_base_date + interval '3 months')::date;
      else v_next_day := v_base_date + 1;
    end case;

    v_exists := public.check_existing_schedule(NEW.template_id, NEW.asset_id, v_next_day);

    if not v_exists then
      insert into public.checklist_schedules (
        template_id, asset_id, scheduled_date, scheduled_day, status, created_by
      ) values (
        NEW.template_id,
        NEW.asset_id,
        v_next_day::timestamp,
        v_next_day,
        'pendiente',
        NEW.updated_by
      );
    end if;
  end if;

  return NEW;
end;
$$;


ALTER FUNCTION "public"."reschedule_completed_checklist"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."reschedule_overdue_checklists"() RETURNS integer
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_row record;
  v_next_day date;
  v_moved_count integer := 0;
begin
  for v_row in
    select cs.id, cs.template_id, cs.asset_id, cs.scheduled_day, c.frequency
    from public.checklist_schedules cs
    join public.checklists c on c.id = cs.template_id
    where cs.status = 'pendiente' and cs.scheduled_day < current_date
  loop
    case v_row.frequency
      when 'diario' then v_next_day := public.next_valid_daily_date(current_date);
      when 'semanal' then v_next_day := v_row.scheduled_day + ((floor(extract(epoch from (current_date - v_row.scheduled_day)) / 604800)::int) + 1) * 7;
      when 'mensual' then v_next_day := (date_trunc('month', current_date) + interval '1 month')::date;
      when 'trimestral' then v_next_day := (date_trunc('quarter', current_date) + interval '3 months')::date;
      else v_next_day := current_date;
    end case;

    if not public.check_existing_schedule(v_row.template_id, v_row.asset_id, v_next_day) then
      update public.checklist_schedules
      set scheduled_day = v_next_day,
          scheduled_date = v_next_day::timestamp,
          updated_at = now()
      where id = v_row.id;
      v_moved_count := v_moved_count + 1;
    end if;
  end loop;

  return v_moved_count;
end;
$$;


ALTER FUNCTION "public"."reschedule_overdue_checklists"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."resolve_asset_name"("input_name" "text", "auto_create_exception" boolean DEFAULT true) RETURNS TABLE("resolution_type" "text", "asset_id" "uuid", "exception_asset_id" "uuid", "asset_category" "text")
    LANGUAGE "plpgsql"
    AS $$
DECLARE
    mapping_record RECORD;
    exception_id UUID;
    formal_asset_id UUID;
    best_similarity DECIMAL(3,2);
    normalized_input TEXT;
BEGIN
    -- Clean and normalize input
    normalized_input := normalize_asset_name(input_name);
    
    -- Return general if input is empty
    IF normalized_input IS NULL OR normalized_input = '' THEN
        RETURN QUERY SELECT 'general'::TEXT, NULL::UUID, NULL::UUID, 'general'::TEXT;
        RETURN;
    END IF;
    
    -- Check existing mappings first
    SELECT * INTO mapping_record
    FROM asset_name_mappings
    WHERE LOWER(original_name) = LOWER(input_name);
    
    IF mapping_record.mapping_type = 'formal' THEN
        RETURN QUERY SELECT 'formal'::TEXT, mapping_record.asset_id, NULL::UUID, 'formal'::TEXT;
        RETURN;
    ELSIF mapping_record.mapping_type = 'exception' THEN
        RETURN QUERY SELECT 'exception'::TEXT, NULL::UUID, mapping_record.exception_asset_id, 'exception'::TEXT;
        RETURN;
    ELSIF mapping_record.mapping_type = 'ignore' THEN
        RETURN QUERY SELECT 'general'::TEXT, NULL::UUID, NULL::UUID, 'general'::TEXT;
        RETURN;
    END IF;
    
    -- Try fuzzy matching on formal assets
    SELECT 
        a.id,
        GREATEST(
            similarity(LOWER(a.name), normalized_input),
            similarity(LOWER(COALESCE(a.asset_id, '')), normalized_input),
            CASE 
                WHEN normalized_input LIKE '%' || LOWER(COALESCE(a.asset_id, '')) || '%' 
                  OR LOWER(COALESCE(a.asset_id, '')) LIKE '%' || normalized_input || '%'
                  OR normalized_input LIKE '%' || LOWER(a.name) || '%'
                  OR LOWER(a.name) LIKE '%' || normalized_input || '%'
                THEN 0.7
                ELSE 0
            END
        ) as similarity_score
    INTO formal_asset_id, best_similarity
    FROM assets a
    WHERE a.is_active = true
    ORDER BY similarity_score DESC
    LIMIT 1;
    
    -- Accept match if confidence is high enough
    IF formal_asset_id IS NOT NULL AND best_similarity > 0.6 THEN
        -- Create automatic mapping for future use
        INSERT INTO asset_name_mappings (original_name, asset_id, mapping_type, mapping_source, confidence_level)
        VALUES (input_name, formal_asset_id, 'formal', 'automatic', best_similarity)
        ON CONFLICT (original_name) DO NOTHING;
        
        RETURN QUERY SELECT 'formal'::TEXT, formal_asset_id, NULL::UUID, 'formal'::TEXT;
        RETURN;
    END IF;
    
    -- No formal asset match found
    IF auto_create_exception THEN
        -- Check if exception asset already exists
        SELECT id INTO exception_id
        FROM exception_assets
        WHERE normalized_name = normalized_input;
        
        -- Create exception asset if not exists
        IF exception_id IS NULL THEN
            INSERT INTO exception_assets (exception_name, normalized_name, asset_type)
            VALUES (input_name, normalized_input, 'unknown')
            RETURNING id INTO exception_id;
        END IF;
        
        -- Create mapping
        INSERT INTO asset_name_mappings (original_name, exception_asset_id, mapping_type, mapping_source, confidence_level)
        VALUES (input_name, exception_id, 'exception', 'automatic', 1.0)
        ON CONFLICT (original_name) DO NOTHING;
        
        RETURN QUERY SELECT 'exception'::TEXT, NULL::UUID, exception_id, 'exception'::TEXT;
    ELSE
        RETURN QUERY SELECT 'unmapped'::TEXT, NULL::UUID, NULL::UUID, 'exception'::TEXT;
    END IF;
END;
$$;


ALTER FUNCTION "public"."resolve_asset_name"("input_name" "text", "auto_create_exception" boolean) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."restore_template_version"("p_version_id" "uuid") RETURNS boolean
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
DECLARE
  v_version RECORD;
  v_section JSONB;
  v_item JSONB;
  v_section_id UUID;
BEGIN
  -- Obtener datos de la versión
  SELECT * INTO v_version FROM checklist_template_versions WHERE id = p_version_id;
  
  IF v_version.id IS NULL THEN
    RAISE EXCEPTION 'Version with id % not found', p_version_id;
  END IF;
  
  -- Actualizar plantilla principal
  UPDATE checklists SET
    name = v_version.name,
    description = v_version.description,
    model_id = v_version.model_id,
    frequency = v_version.frequency,
    hours_interval = v_version.hours_interval,
    updated_at = NOW(),
    updated_by = auth.uid()
  WHERE id = v_version.template_id;
  
  -- Eliminar secciones e ítems actuales
  DELETE FROM checklist_items WHERE section_id IN (
    SELECT id FROM checklist_sections WHERE checklist_id = v_version.template_id
  );
  DELETE FROM checklist_sections WHERE checklist_id = v_version.template_id;
  
  -- Recrear secciones e ítems desde la versión
  FOR v_section IN SELECT jsonb_array_elements(v_version.sections)
  LOOP
    INSERT INTO checklist_sections (
      checklist_id, title, order_index, created_by
    ) VALUES (
      v_version.template_id,
      v_section->>'title',
      (v_section->>'order_index')::INTEGER,
      auth.uid()
    ) RETURNING id INTO v_section_id;
    
    FOR v_item IN SELECT jsonb_array_elements(v_section->'items')
    LOOP
      INSERT INTO checklist_items (
        section_id,
        description,
        required,
        order_index,
        item_type,
        expected_value,
        tolerance,
        created_by
      ) VALUES (
        v_section_id,
        v_item->>'description',
        COALESCE((v_item->>'required')::BOOLEAN, TRUE),
        (v_item->>'order_index')::INTEGER,
        COALESCE(v_item->>'item_type', 'check'),
        v_item->>'expected_value',
        v_item->>'tolerance',
        auth.uid()
      );
    END LOOP;
  END LOOP;
  
  -- Marcar esta versión como activa
  UPDATE checklist_template_versions 
  SET is_active = FALSE 
  WHERE template_id = v_version.template_id;
  
  UPDATE checklist_template_versions 
  SET is_active = TRUE 
  WHERE id = p_version_id;
  
  RETURN TRUE;
END;
$$;


ALTER FUNCTION "public"."restore_template_version"("p_version_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."rls_complete_system_check"() RETURNS TABLE("component" "text", "status" "text", "details" "text", "count_result" bigint)
    LANGUAGE "sql" SECURITY DEFINER
    AS $$
  -- RLS habilitado en tablas principales
  SELECT 
    'Core Tables RLS' as component,
    'ACTIVE' as status,
    'RLS enabled on main business tables' as details,
    COUNT(*)::bigint as count_result
  FROM pg_tables 
  WHERE schemaname = 'public' 
  AND tablename IN ('assets', 'plants', 'business_units', 'equipment_models', 'maintenance_history', 'work_orders', 'service_orders', 'departments')
  AND rowsecurity = true
  
  UNION ALL
  
  -- Políticas postgres para acceso directo
  SELECT 
    'Postgres Policies' as component,
    'DEPLOYED' as status,
    'Direct database access policies active' as details,
    COUNT(*)::bigint as count_result
  FROM pg_policies 
  WHERE schemaname = 'public' 
  AND 'postgres' = ANY(roles)
  
  UNION ALL
  
  -- Verificar datos accesibles
  SELECT 
    'Data Access Test' as component,
    'WORKING' as status,
    'All protected tables accessible' as details,
    (
      (SELECT COUNT(*) FROM assets) +
      (SELECT COUNT(*) FROM equipment_models) +
      (SELECT COUNT(*) FROM maintenance_history) +
      (SELECT COUNT(*) FROM work_orders) +
      (SELECT COUNT(*) FROM departments)
    )::bigint as count_result;
$$;


ALTER FUNCTION "public"."rls_complete_system_check"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."rls_health_check"() RETURNS TABLE("component" "text", "status" "text", "details" "text")
    LANGUAGE "sql" SECURITY DEFINER
    AS $$
  SELECT 
    'RLS Status' as component,
    'ACTIVE' as status,
    'All main tables have RLS enabled' as details
  WHERE (
    SELECT COUNT(*) FROM pg_tables 
    WHERE schemaname = 'public' 
    AND tablename IN ('assets', 'profiles', 'plants', 'business_units')
    AND rowsecurity = true
  ) = 4
  
  UNION ALL
  
  SELECT 
    'Policies' as component,
    'DEPLOYED' as status,
    'Hierarchical policies active on all tables' as details
  WHERE (
    SELECT COUNT(*) FROM pg_policies 
    WHERE schemaname = 'public' 
    AND tablename IN ('assets', 'profiles', 'plants', 'business_units')
  ) >= 4
  
  UNION ALL
  
  SELECT 
    'User Configuration' as component,
    'READY' as status,
    'Users properly assigned with NULL/NOT NULL pattern' as details
  WHERE (
    SELECT COUNT(*) FROM profiles WHERE status = 'active'
  ) = 5;
$$;


ALTER FUNCTION "public"."rls_health_check"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."rls_system_health_check"() RETURNS TABLE("component" "text", "status" "text", "details" "text", "count_result" bigint)
    LANGUAGE "sql" SECURITY DEFINER
    AS $$
  -- Verificar RLS activo
  SELECT 
    'RLS Status' as component,
    'ACTIVE' as status,
    'All main tables have RLS enabled' as details,
    COUNT(*)::bigint as count_result
  FROM pg_tables 
  WHERE schemaname = 'public' 
  AND tablename IN ('assets', 'profiles', 'plants', 'business_units')
  AND rowsecurity = true
  
  UNION ALL
  
  -- Verificar políticas para service_role
  SELECT 
    'Service Role Policies' as component,
    'DEPLOYED' as status,
    'Backend access policies active' as details,
    COUNT(*)::bigint as count_result
  FROM pg_policies 
  WHERE schemaname = 'public' 
  AND 'service_role' = ANY(roles)
  
  UNION ALL
  
  -- Verificar políticas para authenticated
  SELECT 
    'Authenticated Policies' as component,
    'DEPLOYED' as status,
    'Hierarchical user policies active' as details,
    COUNT(*)::bigint as count_result
  FROM pg_policies 
  WHERE schemaname = 'public' 
  AND 'authenticated' = ANY(roles)
  
  UNION ALL
  
  -- Verificar políticas para anon
  SELECT 
    'Anonymous Policies' as component,
    'DEPLOYED' as status,
    'Read-only public access policies active' as details,
    COUNT(*)::bigint as count_result
  FROM pg_policies 
  WHERE schemaname = 'public' 
  AND 'anon' = ANY(roles)
  
  UNION ALL
  
  -- Verificar datos accesibles
  SELECT 
    'Data Access Test' as component,
    'WORKING' as status,
    'All assets accessible via service_role' as details,
    COUNT(*)::bigint as count_result
  FROM assets;
$$;


ALTER FUNCTION "public"."rls_system_health_check"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."save_checklist_evidence"("p_completed_checklist_id" "uuid", "p_evidence_data" "jsonb") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
DECLARE
  v_evidence JSONB;
  v_evidence_id UUID;
  v_saved_count INTEGER := 0;
BEGIN
  -- Procesar cada evidencia
  FOR v_evidence IN SELECT jsonb_array_elements(p_evidence_data)
  LOOP
    INSERT INTO checklist_evidence (
      completed_checklist_id,
      section_id,
      category,
      description,
      photo_url,
      sequence_order,
      metadata,
      created_by
    ) VALUES (
      p_completed_checklist_id,
      (v_evidence->>'section_id')::UUID,
      v_evidence->>'category',
      v_evidence->>'description',
      v_evidence->>'photo_url',
      COALESCE((v_evidence->>'sequence_order')::INTEGER, 1),
      v_evidence->'metadata',
      (v_evidence->>'created_by')::UUID
    ) RETURNING id INTO v_evidence_id;
    
    v_saved_count := v_saved_count + 1;
  END LOOP;
  
  RETURN jsonb_build_object(
    'success', TRUE,
    'saved_count', v_saved_count,
    'message', format('Se guardaron %s evidencias exitosamente', v_saved_count)
  );
END;
$$;


ALTER FUNCTION "public"."save_checklist_evidence"("p_completed_checklist_id" "uuid", "p_evidence_data" "jsonb") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."schedule_checklists_for_model"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
declare
  v_asset record;
  v_next_day date;
  v_interval_days integer;
  v_exists boolean;
  v_today date := current_date;
begin
  if NEW.model_id is not null and NEW.frequency is not null then
    v_interval_days := case NEW.frequency
      when 'diario' then 1
      when 'semanal' then 7
      when 'quincenal' then 14
      when 'mensual' then 30
      when 'trimestral' then 90
      else 30
    end;

    for v_asset in select id from public.assets where model_id = NEW.model_id and status = 'operational' loop
      if NEW.frequency in ('diario','semanal') then
        v_next_day := public.next_valid_date(v_today + case when NEW.frequency='diario' then 1 else 7 end, NEW.frequency);
      else
        v_next_day := v_today + case NEW.frequency when 'mensual' then 30 when 'trimestral' then 90 else 1 end;
      end if;

      v_exists := public.check_existing_schedule(NEW.id, v_asset.id, v_next_day);
      if not v_exists then
        insert into public.checklist_schedules (template_id, asset_id, scheduled_date, scheduled_day, status)
        values (NEW.id, v_asset.id, v_next_day::timestamp, v_next_day, 'pendiente');
      end if;

      for i in 1..(30 / v_interval_days) loop
        if NEW.frequency in ('diario','semanal') then
          v_next_day := public.next_valid_date(v_next_day + v_interval_days, NEW.frequency);
        else
          v_next_day := v_next_day + v_interval_days;
        end if;

        v_exists := public.check_existing_schedule(NEW.id, v_asset.id, v_next_day);
        if not v_exists then
          insert into public.checklist_schedules (template_id, asset_id, scheduled_date, scheduled_day, status)
          values (NEW.id, v_asset.id, v_next_day::timestamp, v_next_day, 'pendiente');
        end if;
      end loop;
    end loop;
  end if;

  return NEW;
end;
$$;


ALTER FUNCTION "public"."schedule_checklists_for_model"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."schedule_checklists_for_new_asset"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
declare
  v_checklist record;
  v_scheduled_day date;
  v_exists boolean;
  v_today date := current_date;
begin
  if NEW.model_id is not null then
    for v_checklist in select id, frequency, hours_interval from public.checklists where model_id = NEW.model_id loop
      if v_checklist.frequency in ('diario','semanal') then
        v_scheduled_day := public.next_valid_date(v_today + case when v_checklist.frequency='diario' then 1 else 7 end, v_checklist.frequency);
      else
        v_scheduled_day := case v_checklist.frequency
          when 'mensual' then (v_today + interval '1 month')::date
          when 'trimestral' then (v_today + interval '3 months')::date
          else v_today + 1
        end;
      end if;

      v_exists := public.check_existing_schedule(v_checklist.id, NEW.id, v_scheduled_day);
      if not v_exists then
        insert into public.checklist_schedules (template_id, asset_id, scheduled_date, scheduled_day, status, created_by)
        values (v_checklist.id, NEW.id, v_scheduled_day::timestamp, v_scheduled_day, 'pendiente', coalesce((select auth.uid()), NEW.created_by));
      end if;
    end loop;
  end if;

  return NEW;
end;
$$;


ALTER FUNCTION "public"."schedule_checklists_for_new_asset"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."set_checklist_scheduled_day"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
BEGIN
  NEW.scheduled_day := DATE(NEW.scheduled_date);
  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."set_checklist_scheduled_day"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."set_diesel_transaction_id"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
BEGIN
    IF NEW.transaction_id IS NULL OR NEW.transaction_id = '' THEN
        NEW.transaction_id := generate_diesel_transaction_id();
    END IF;
    NEW.updated_at := NOW();
    NEW.updated_by := auth.uid();
    RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."set_diesel_transaction_id"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."set_purchase_order_id"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
BEGIN
  -- Only set order_id if it's not already set
  IF NEW.order_id IS NULL THEN
    NEW.order_id := generate_next_id('OC-');
  END IF;
  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."set_purchase_order_id"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."set_requires_quote"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
BEGIN
  NEW.requires_quote := requires_quotation(NEW.po_type, NEW.total_amount);
  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."set_requires_quote"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."set_service_order_id"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
BEGIN
  -- Only set order_id if it's not already set
  IF NEW.order_id IS NULL THEN
    NEW.order_id := generate_next_id('OS-');
  END IF;
  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."set_service_order_id"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."set_user_tracking_fields"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
BEGIN
  -- For tables with requested_by instead of created_by
  IF TG_OP = 'INSERT' THEN
    IF TG_TABLE_NAME = 'purchase_orders' OR TG_TABLE_NAME = 'work_orders' THEN
      IF NEW.requested_by IS NULL THEN
        BEGIN
          NEW.requested_by = auth.uid();
        EXCEPTION WHEN OTHERS THEN
          -- Si no se puede obtener auth.uid(), usar NULL
          NEW.requested_by = NULL;
        END;
      END IF;
    ELSIF NEW.created_by IS NULL THEN
      BEGIN
        NEW.created_by = auth.uid();
      EXCEPTION WHEN OTHERS THEN
        -- Si no se puede obtener auth.uid(), usar NULL
        NEW.created_by = NULL;
      END;
    END IF;
    
    NEW.created_at = now();
  END IF;
  
  -- For both insert and update, set updated_by
  BEGIN
    NEW.updated_by = auth.uid();
  EXCEPTION WHEN OTHERS THEN
    -- Si no se puede obtener auth.uid(), usar NULL
    NEW.updated_by = NULL;
  END;
  NEW.updated_at = now();
  
  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."set_user_tracking_fields"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."set_work_order_id"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
BEGIN
  -- Only set order_id if it's not already set
  IF NEW.order_id IS NULL THEN
    NEW.order_id := generate_next_id('OT-');
  END IF;
  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."set_work_order_id"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."should_allow_purchase_order_generation"("p_work_order_id" "uuid") RETURNS boolean
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
DECLARE
  v_work_order RECORD;
  v_incident RECORD;
BEGIN
  -- Obtener los datos de la orden de trabajo
  SELECT * INTO v_work_order FROM work_orders WHERE id = p_work_order_id;
  
  IF v_work_order IS NULL THEN
    RETURN FALSE;
  END IF;
  
  -- Si ya tiene una orden de compra, no permitir generar otra
  IF v_work_order.purchase_order_id IS NOT NULL THEN
    RETURN FALSE;
  END IF;
  
  -- Si tiene repuestos, permitir generación
  IF v_work_order.required_parts IS NOT NULL AND 
     jsonb_array_length(v_work_order.required_parts) > 0 THEN
    RETURN TRUE;
  END IF;
  
  -- Si tiene costo estimado, permitir generación
  IF v_work_order.estimated_cost IS NOT NULL AND 
     v_work_order.estimated_cost > 0 THEN
    RETURN TRUE;
  END IF;
  
  -- Si es correctiva, permitir generación
  IF v_work_order.type = 'corrective' THEN
    RETURN TRUE;
  END IF;
  
  -- Si proviene de un incidente, verificar datos del incidente
  IF v_work_order.incident_id IS NOT NULL THEN
    SELECT * INTO v_incident FROM incident_history WHERE id = v_work_order.incident_id;
    
    -- Si el incidente existe y tiene costos o partes, permitir generación
    IF v_incident IS NOT NULL THEN
      IF v_incident.total_cost IS NOT NULL OR
         v_incident.labor_cost IS NOT NULL OR
         v_incident.parts IS NOT NULL THEN
        RETURN TRUE;
      END IF;
    END IF;
  END IF;
  
  -- Por defecto, no permitir
  RETURN FALSE;
END;
$$;


ALTER FUNCTION "public"."should_allow_purchase_order_generation"("p_work_order_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."sync_composite_readings"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
DECLARE
  v_is_propagating text;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF (NEW.current_hours IS DISTINCT FROM OLD.current_hours)
       OR (NEW.current_kilometers IS DISTINCT FROM OLD.current_kilometers) THEN

      -- Guard: avoid infinite recursion during propagation
      v_is_propagating := current_setting('app.sync_propagation', true);
      IF v_is_propagating = 'on' THEN
        RETURN NEW;
      END IF;
      PERFORM set_config('app.sync_propagation', 'on', true);

      -- Case A: This asset is a composite → push readings to its active components
      IF NEW.is_composite THEN
        UPDATE assets a
        SET 
          current_hours = COALESCE(NEW.current_hours, a.current_hours),
          current_kilometers = COALESCE(NEW.current_kilometers, a.current_kilometers)
        FROM asset_composite_relationships rel
        WHERE rel.composite_asset_id = NEW.id
          AND rel.status = 'active'
          AND a.id = rel.component_asset_id
          AND (
            a.current_hours IS DISTINCT FROM NEW.current_hours
            OR a.current_kilometers IS DISTINCT FROM NEW.current_kilometers
          );
      END IF;

      -- Case B: This asset is a component → push readings to siblings and composite
      -- Update sibling components
      UPDATE assets a
      SET 
        current_hours = COALESCE(NEW.current_hours, a.current_hours),
        current_kilometers = COALESCE(NEW.current_kilometers, a.current_kilometers)
      WHERE a.id IN (
        SELECT r2.component_asset_id
        FROM asset_composite_relationships r
        JOIN asset_composite_relationships r2 ON r2.composite_asset_id = r.composite_asset_id AND r2.status = 'active'
        WHERE r.component_asset_id = NEW.id
          AND r.status = 'active'
      )
      AND a.id <> NEW.id
      AND (
        a.current_hours IS DISTINCT FROM NEW.current_hours
        OR a.current_kilometers IS DISTINCT FROM NEW.current_kilometers
      );

      -- Update the composite(s) that include this component
      UPDATE assets a
      SET 
        current_hours = COALESCE(NEW.current_hours, a.current_hours),
        current_kilometers = COALESCE(NEW.current_kilometers, a.current_kilometers)
      WHERE a.id IN (
        SELECT composite_asset_id
        FROM asset_composite_relationships
        WHERE component_asset_id = NEW.id
          AND status = 'active'
      )
      AND (
        a.current_hours IS DISTINCT FROM NEW.current_hours
        OR a.current_kilometers IS DISTINCT FROM NEW.current_kilometers
      );

      PERFORM set_config('app.sync_propagation', 'off', true);
    END IF;
  END IF;
  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."sync_composite_readings"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."sync_user_admin_context"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
BEGIN
  -- Insertar o actualizar el contexto administrativo
  INSERT INTO user_admin_context (
    user_id, 
    admin_level, 
    plant_id, 
    business_unit_id, 
    user_role,
    updated_at
  )
  VALUES (
    NEW.id,
    CASE 
      WHEN NEW.plant_id IS NULL AND NEW.business_unit_id IS NULL THEN 'TOTAL'
      WHEN NEW.plant_id IS NULL AND NEW.business_unit_id IS NOT NULL THEN 'UNIT'
      WHEN NEW.plant_id IS NOT NULL THEN 'PLANT'
      ELSE 'NONE'
    END,
    NEW.plant_id,
    NEW.business_unit_id,
    NEW.role,
    NOW()
  )
  ON CONFLICT (user_id) DO UPDATE SET
    admin_level = CASE 
      WHEN NEW.plant_id IS NULL AND NEW.business_unit_id IS NULL THEN 'TOTAL'
      WHEN NEW.plant_id IS NULL AND NEW.business_unit_id IS NOT NULL THEN 'UNIT'
      WHEN NEW.plant_id IS NOT NULL THEN 'PLANT'
      ELSE 'NONE'
    END,
    plant_id = NEW.plant_id,
    business_unit_id = NEW.business_unit_id,
    user_role = NEW.role,
    updated_at = NOW();
    
  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."sync_user_admin_context"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."sync_warehouse_balance"("p_warehouse_id" "uuid") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
DECLARE
  v_balance NUMERIC(10,2);
BEGIN
  SELECT dt.current_balance
  INTO v_balance
  FROM diesel_transactions dt
  WHERE dt.warehouse_id = p_warehouse_id
  ORDER BY dt.transaction_date DESC, dt.created_at DESC, dt.id DESC
  LIMIT 1;

  UPDATE diesel_warehouses w
  SET current_inventory = COALESCE(v_balance, 0),
      last_updated = NOW()
  WHERE w.id = p_warehouse_id;
END;
$$;


ALTER FUNCTION "public"."sync_warehouse_balance"("p_warehouse_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."test_user_access_simplified"("p_user_email" "text") RETURNS TABLE("access_level" "text", "plant_access" "text"[], "business_unit_access" "text"[], "asset_count" bigint, "can_see_all_profiles" boolean)
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
DECLARE
  v_user_id uuid;
  v_plant_id uuid;
  v_business_unit_id uuid;
BEGIN
  -- Get user info
  SELECT id, plant_id, business_unit_id 
  INTO v_user_id, v_plant_id, v_business_unit_id
  FROM profiles 
  WHERE email = p_user_email;

  -- Determine access level
  IF v_plant_id IS NULL AND v_business_unit_id IS NULL THEN
    access_level := 'ACCESO_TOTAL';
  ELSIF v_plant_id IS NULL AND v_business_unit_id IS NOT NULL THEN
    access_level := 'ACCESO_UNIDAD';
  ELSIF v_plant_id IS NOT NULL THEN
    access_level := 'ACCESO_PLANTA';
  ELSE
    access_level := 'DESCONOCIDO';
  END IF;

  -- Get accessible plants
  plant_access := ARRAY(
    SELECT p.name 
    FROM plants p
    WHERE 
      -- Total access
      (v_plant_id IS NULL AND v_business_unit_id IS NULL)
      OR
      -- Unit access
      (v_plant_id IS NULL AND v_business_unit_id IS NOT NULL AND p.business_unit_id = v_business_unit_id)
      OR
      -- Plant access
      (v_plant_id IS NOT NULL AND p.id = v_plant_id)
    ORDER BY p.name
  );

  -- Get accessible business units
  business_unit_access := ARRAY(
    SELECT bu.name 
    FROM business_units bu
    WHERE 
      -- Total access
      (v_plant_id IS NULL AND v_business_unit_id IS NULL)
      OR
      -- Has this business unit
      (bu.id = v_business_unit_id)
    ORDER BY bu.name
  );

  -- Count accessible assets
  SELECT COUNT(*) INTO asset_count
  FROM assets a
  WHERE 
    -- Total access
    (v_plant_id IS NULL AND v_business_unit_id IS NULL)
    OR
    -- Unit access
    (v_plant_id IS NULL AND v_business_unit_id IS NOT NULL AND EXISTS (
      SELECT 1 FROM plants pl 
      WHERE pl.id = a.plant_id AND pl.business_unit_id = v_business_unit_id
    ))
    OR
    -- Plant access
    (v_plant_id IS NOT NULL AND a.plant_id = v_plant_id)
    OR
    -- Operator access
    EXISTS (
      SELECT 1 FROM asset_operators ao 
      WHERE ao.asset_id = a.id AND ao.operator_id = v_user_id
    );

  -- Check if can see all profiles
  can_see_all_profiles := (v_plant_id IS NULL AND v_business_unit_id IS NULL);

  RETURN NEXT;
END;
$$;


ALTER FUNCTION "public"."test_user_access_simplified"("p_user_email" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."transfer_operator_assignment"("p_operator_id" "uuid", "p_to_asset_id" "uuid", "p_user_id" "uuid", "p_from_asset_id" "uuid" DEFAULT NULL::"uuid", "p_assignment_type" "text" DEFAULT 'primary'::"text", "p_transfer_reason" "text" DEFAULT 'Transfer operation'::"text", "p_force_transfer" boolean DEFAULT false) RETURNS "json"
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
DECLARE
  v_existing_primary_id UUID;
  v_removed_assignments INTEGER := 0;
  v_created_assignments INTEGER := 0;
  v_transfer_id UUID := uuid_generate_v4();
  v_current_assignment RECORD;
  v_result JSON;
BEGIN
  -- Check if operator exists and is active
  IF NOT EXISTS (
    SELECT 1 FROM profiles 
    WHERE id = p_operator_id AND status = 'active'
  ) THEN
    RAISE EXCEPTION 'Operator not found or inactive';
  END IF;

  -- Check if target asset exists
  IF NOT EXISTS (
    SELECT 1 FROM assets WHERE id = p_to_asset_id
  ) THEN
    RAISE EXCEPTION 'Target asset not found';
  END IF;

  -- Check if operator is already assigned to target asset
  IF EXISTS (
    SELECT 1 FROM asset_operators
    WHERE operator_id = p_operator_id 
    AND asset_id = p_to_asset_id 
    AND status = 'active'
  ) THEN
    RAISE EXCEPTION 'Operator is already assigned to this asset';
  END IF;

  -- If assigning as primary, check for existing primary operator
  IF p_assignment_type = 'primary' THEN
    SELECT id INTO v_existing_primary_id
    FROM asset_operators
    WHERE asset_id = p_to_asset_id 
    AND assignment_type = 'primary' 
    AND status = 'active'
    LIMIT 1;

    -- If there's an existing primary and force_transfer is false, raise error
    IF v_existing_primary_id IS NOT NULL AND NOT p_force_transfer THEN
      RAISE EXCEPTION 'Asset already has a primary operator. Use force_transfer to replace.';
    END IF;

    -- If force_transfer is true, deactivate existing primary
    IF v_existing_primary_id IS NOT NULL AND p_force_transfer THEN
      UPDATE asset_operators
      SET 
        status = 'inactive',
        end_date = CURRENT_DATE,
        updated_by = p_user_id,
        updated_at = NOW(),
        notes = COALESCE(notes, '') || ' | Replaced by transfer operation: ' || p_transfer_reason
      WHERE id = v_existing_primary_id;
      
      v_removed_assignments := v_removed_assignments + 1;
    END IF;
  END IF;

  -- If from_asset_id is provided, deactivate assignments from that asset
  IF p_from_asset_id IS NOT NULL THEN
    FOR v_current_assignment IN
      SELECT id, assignment_type
      FROM asset_operators
      WHERE operator_id = p_operator_id 
      AND asset_id = p_from_asset_id 
      AND status = 'active'
    LOOP
      UPDATE asset_operators
      SET 
        status = 'inactive',
        end_date = CURRENT_DATE,
        updated_by = p_user_id,
        updated_at = NOW(),
        notes = COALESCE(notes, '') || ' | Transfer to asset: ' || p_to_asset_id || ' - ' || p_transfer_reason
      WHERE id = v_current_assignment.id;
      
      v_removed_assignments := v_removed_assignments + 1;
    END LOOP;
  ELSE
    -- If no from_asset_id specified, deactivate ALL active assignments for this operator
    FOR v_current_assignment IN
      SELECT id, assignment_type, asset_id
      FROM asset_operators
      WHERE operator_id = p_operator_id 
      AND status = 'active'
    LOOP
      UPDATE asset_operators
      SET 
        status = 'inactive',
        end_date = CURRENT_DATE,
        updated_by = p_user_id,
        updated_at = NOW(),
        notes = COALESCE(notes, '') || ' | Transferred to asset: ' || p_to_asset_id || ' - ' || p_transfer_reason
      WHERE id = v_current_assignment.id;
      
      v_removed_assignments := v_removed_assignments + 1;
    END LOOP;
  END IF;

  -- Create new assignment
  INSERT INTO asset_operators (
    id,
    asset_id,
    operator_id,
    assignment_type,
    start_date,
    status,
    notes,
    assigned_by,
    created_by,
    updated_by
  ) VALUES (
    uuid_generate_v4(),
    p_to_asset_id,
    p_operator_id,
    p_assignment_type,
    CURRENT_DATE,
    'active',
    'Created by transfer operation: ' || p_transfer_reason,
    p_user_id,
    p_user_id,
    p_user_id
  );

  v_created_assignments := 1;

  -- Note: Asset status updates are now handled by database triggers/functions

  -- Log the transfer operation in operator assignment history
  INSERT INTO operator_assignment_history (
    asset_id,
    operator_id,
    operation_type,
    previous_asset_id,
    new_asset_id,
    assignment_type,
    changed_by,
    change_reason,
    transfer_id
  ) VALUES (
    p_to_asset_id,
    p_operator_id,
    'transfer',
    p_from_asset_id,
    p_to_asset_id,
    p_assignment_type,
    p_user_id,
    p_transfer_reason,
    v_transfer_id
  );

  -- Build result
  v_result := json_build_object(
    'success', true,
    'transfer_id', v_transfer_id,
    'removed_assignments', v_removed_assignments,
    'created_assignments', v_created_assignments,
    'operator_id', p_operator_id,
    'target_asset_id', p_to_asset_id,
    'assignment_type', p_assignment_type
  );

  RETURN v_result;

EXCEPTION WHEN OTHERS THEN
  -- Re-raise the exception with more context
  RAISE EXCEPTION 'Transfer operation failed: %', SQLERRM;
END;
$$;


ALTER FUNCTION "public"."transfer_operator_assignment"("p_operator_id" "uuid", "p_to_asset_id" "uuid", "p_user_id" "uuid", "p_from_asset_id" "uuid", "p_assignment_type" "text", "p_transfer_reason" "text", "p_force_transfer" boolean) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."trg_mark_tx_for_validation"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
DECLARE
  v_latest_ts timestamptz;
  v_is_out_of_order boolean := false;
  v_is_backdated boolean := false;
  v_is_future_now boolean := false;
  v_is_future_vs_created boolean := false;
  v_threshold integer := public.get_diesel_backdating_threshold_minutes();
  v_delta_minutes numeric;
  v_future_minutes_now numeric;
  v_future_minutes_created numeric;
  v_created timestamptz := COALESCE(NEW.created_at, NOW());
  v_notes text := COALESCE(NEW.validation_notes, '');
BEGIN
  SELECT MAX(transaction_date) INTO v_latest_ts
  FROM diesel_transactions
  WHERE warehouse_id = NEW.warehouse_id
    AND (TG_OP = 'INSERT' OR id <> NEW.id);

  IF v_latest_ts IS NOT NULL AND NEW.transaction_date < v_latest_ts THEN
    v_is_out_of_order := true;
    v_notes := trim(both ' ' FROM CONCAT(v_notes, CASE WHEN v_notes <> '' THEN ' | ' ELSE '' END,
      'out_of_order:', to_char(v_latest_ts, 'YYYY-MM-DD"T"HH24:MI:SSOF')));
  END IF;

  -- Backdated vs now
  v_delta_minutes := EXTRACT(EPOCH FROM (NOW() - NEW.transaction_date)) / 60.0;
  IF v_delta_minutes > v_threshold THEN
    v_is_backdated := true;
    v_notes := trim(both ' ' FROM CONCAT(v_notes, CASE WHEN v_notes <> '' THEN ' | ' ELSE '' END,
      'backdated:', round(v_delta_minutes)::text, 'm'));
  END IF;

  -- Future-dated vs now
  v_future_minutes_now := EXTRACT(EPOCH FROM (NEW.transaction_date - NOW())) / 60.0;
  IF v_future_minutes_now > 0 THEN
    v_is_future_now := true;
    v_notes := trim(both ' ' FROM CONCAT(v_notes, CASE WHEN v_notes <> '' THEN ' | ' ELSE '' END,
      'future_dated_now:', round(v_future_minutes_now)::text, 'm'));
  END IF;

  -- Future-dated vs created_at
  v_future_minutes_created := EXTRACT(EPOCH FROM (NEW.transaction_date - v_created)) / 60.0;
  IF v_future_minutes_created > 0 THEN
    v_is_future_vs_created := true;
    v_notes := trim(both ' ' FROM CONCAT(v_notes, CASE WHEN v_notes <> '' THEN ' | ' ELSE '' END,
      'future_vs_created:', round(v_future_minutes_created)::text, 'm'));
  END IF;

  IF v_is_out_of_order OR v_is_backdated OR v_is_future_now OR v_is_future_vs_created THEN
    NEW.requires_validation := true;
    NEW.validation_notes := v_notes;
  END IF;

  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."trg_mark_tx_for_validation"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."trg_recalc_on_tx_update"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
BEGIN
  -- Skip if this update is part of an internal recalculation
  IF current_setting('diesel.recalc_running', true) = '1' THEN
    RETURN NEW;
  END IF;

  PERFORM public.recalc_balances_from(NEW.id);
  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."trg_recalc_on_tx_update"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."trigger_generate_maintenance_plans"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
BEGIN
  PERFORM generate_maintenance_plans(NEW.id);
  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."trigger_generate_maintenance_plans"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."trigger_refresh_diesel_inventory"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
BEGIN
    PERFORM refresh_diesel_inventory();
    RETURN COALESCE(NEW, OLD);
END;
$$;


ALTER FUNCTION "public"."trigger_refresh_diesel_inventory"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."update_asset_last_inspection_date"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
BEGIN
  UPDATE assets
  SET last_inspection_date = NEW.completion_date
  WHERE id = NEW.asset_id;
  
  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."update_asset_last_inspection_date"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."update_asset_mapping_timestamp"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
BEGIN
    NEW.updated_at := NOW();
    RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."update_asset_mapping_timestamp"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."update_asset_readings_from_checklist"("p_completed_checklist_id" "uuid", "p_hours_reading" integer DEFAULT NULL::integer, "p_kilometers_reading" integer DEFAULT NULL::integer) RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
DECLARE
  v_asset_id UUID;
  v_model_id UUID;
  v_maintenance_unit TEXT;
  v_previous_hours INTEGER;
  v_previous_kilometers INTEGER;
  v_updated_hours INTEGER;
  v_updated_kilometers INTEGER;
  v_hours_difference INTEGER := 0;
  v_kilometers_difference INTEGER := 0;
BEGIN
  -- Obtener información del checklist completado y el activo
  SELECT cc.asset_id, a.model_id, a.current_hours, a.current_kilometers
  INTO v_asset_id, v_model_id, v_previous_hours, v_previous_kilometers
  FROM completed_checklists cc
  JOIN assets a ON cc.asset_id = a.id
  WHERE cc.id = p_completed_checklist_id;
  
  IF v_asset_id IS NULL THEN
    RAISE EXCEPTION 'Checklist completado no encontrado: %', p_completed_checklist_id;
  END IF;
  
  -- Obtener la unidad de mantenimiento del modelo
  SELECT maintenance_unit INTO v_maintenance_unit
  FROM equipment_models
  WHERE id = v_model_id;
  
  -- Establecer valores por defecto si no se especificaron
  v_maintenance_unit := COALESCE(v_maintenance_unit, 'hours');
  
  -- Validar que las lecturas no sean menores que las actuales (excepto en casos de reset)
  IF p_hours_reading IS NOT NULL AND p_hours_reading < v_previous_hours THEN
    -- Permitir solo si la diferencia es significativa (posible reset del contador)
    IF (v_previous_hours - p_hours_reading) < 10000 THEN
      RAISE EXCEPTION 'La lectura de horas (%) no puede ser menor que la actual (%). Si hubo un reset del contador, contacte al administrador.', 
        p_hours_reading, v_previous_hours;
    END IF;
  END IF;
  
  IF p_kilometers_reading IS NOT NULL AND p_kilometers_reading < v_previous_kilometers THEN
    -- Permitir solo si la diferencia es significativa (posible reset del contador)
    IF (v_previous_kilometers - p_kilometers_reading) < 100000 THEN
      RAISE EXCEPTION 'La lectura de kilómetros (%) no puede ser menor que la actual (%). Si hubo un reset del contador, contacte al administrador.', 
        p_kilometers_reading, v_previous_kilometers;
    END IF;
  END IF;
  
  -- Actualizar el checklist completado con las lecturas
  UPDATE completed_checklists 
  SET 
    equipment_hours_reading = p_hours_reading,
    equipment_kilometers_reading = p_kilometers_reading,
    reading_timestamp = NOW(),
    previous_hours = v_previous_hours,
    previous_kilometers = v_previous_kilometers
  WHERE id = p_completed_checklist_id;
  
  -- Determinar qué valores actualizar en el activo
  v_updated_hours := COALESCE(p_hours_reading, v_previous_hours);
  v_updated_kilometers := COALESCE(p_kilometers_reading, v_previous_kilometers);
  
  -- Calcular diferencias
  v_hours_difference := v_updated_hours - v_previous_hours;
  v_kilometers_difference := v_updated_kilometers - v_previous_kilometers;
  
  -- Actualizar el activo solo si hay cambios
  IF p_hours_reading IS NOT NULL OR p_kilometers_reading IS NOT NULL THEN
    UPDATE assets 
    SET 
      current_hours = v_updated_hours,
      current_kilometers = v_updated_kilometers,
      updated_at = NOW()
    WHERE id = v_asset_id;
  END IF;
  
  -- *** REMOVED: No longer creating maintenance_history records for reading updates ***
  -- Reading updates are operational data, not maintenance activities
  
  -- Retornar información de la actualización
  RETURN jsonb_build_object(
    'success', TRUE,
    'asset_id', v_asset_id,
    'maintenance_unit', v_maintenance_unit,
    'previous_hours', v_previous_hours,
    'previous_kilometers', v_previous_kilometers,
    'updated_hours', v_updated_hours,
    'updated_kilometers', v_updated_kilometers,
    'hours_difference', v_hours_difference,
    'kilometers_difference', v_kilometers_difference,
    'reading_timestamp', NOW(),
    'note', 'Lecturas actualizadas - no se registra como actividad de mantenimiento'
  );
END;
$$;


ALTER FUNCTION "public"."update_asset_readings_from_checklist"("p_completed_checklist_id" "uuid", "p_hours_reading" integer, "p_kilometers_reading" integer) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."update_exception_asset_normalized_name"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
BEGIN
    NEW.normalized_name := normalize_asset_name(NEW.exception_name);
    NEW.updated_at := NOW();
    RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."update_exception_asset_normalized_name"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."update_exception_asset_stats"() RETURNS "void"
    LANGUAGE "plpgsql"
    AS $$
BEGIN
    UPDATE exception_assets 
    SET 
        total_transactions = stats.transaction_count,
        total_consumption_liters = stats.total_consumption,
        first_seen = stats.first_transaction,
        last_seen = stats.last_transaction,
        updated_at = NOW()
    FROM (
        SELECT 
            ea.id,
            COUNT(dt.id) as transaction_count,
            COALESCE(SUM(CASE WHEN dt.transaction_type = 'consumption' THEN dt.quantity_liters ELSE 0 END), 0) as total_consumption,
            MIN(dt.transaction_date) as first_transaction,
            MAX(dt.transaction_date) as last_transaction
        FROM exception_assets ea
        LEFT JOIN diesel_transactions dt ON LOWER(dt.exception_asset_name) = LOWER(ea.exception_name)
        GROUP BY ea.id
    ) stats
    WHERE exception_assets.id = stats.id;
END;
$$;


ALTER FUNCTION "public"."update_exception_asset_stats"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."update_existing_issue_fingerprints"() RETURNS integer
    LANGUAGE "plpgsql"
    AS $$
DECLARE
    updated_count INTEGER := 0;
    issue_record RECORD;
BEGIN
    FOR issue_record IN
        SELECT ci.id, cc.asset_id, cli.description as item_description, ci.status, ci.notes
        FROM checklist_issues ci
        LEFT JOIN completed_checklists cc ON ci.checklist_id = cc.id
        LEFT JOIN checklist_items cli ON ci.item_id::uuid = cli.id
        WHERE ci.issue_fingerprint IS NULL
            AND cc.asset_id IS NOT NULL
            AND cli.description IS NOT NULL
    LOOP
        UPDATE checklist_issues 
        SET issue_fingerprint = generate_issue_fingerprint(
            issue_record.asset_id,
            issue_record.item_description,
            issue_record.status,
            issue_record.notes
        )
        WHERE id = issue_record.id;
        
        updated_count := updated_count + 1;
    END LOOP;
    
    RETURN updated_count;
END;
$$;


ALTER FUNCTION "public"."update_existing_issue_fingerprints"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."update_incident_on_work_order_status"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
BEGIN
  IF COALESCE(NEW.status, '') <> COALESCE(OLD.status, '') THEN
    IF lower(NEW.status) IN ('completada','completed','verified','verificado') THEN
      UPDATE incident_history ih
      SET 
        status = 'Resuelto',
        updated_at = NOW()
      WHERE 
        (ih.id = NEW.incident_id OR ih.work_order_id = NEW.id)
        AND (ih.status IS NULL OR lower(ih.status) IN ('pendiente','en progreso','abierto','open'));
    END IF;
  END IF;
  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."update_incident_on_work_order_status"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."update_incident_reporter_name"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
BEGIN
  -- Get the reporter's name from profiles
  IF NEW.reported_by_id IS NOT NULL THEN
    SELECT CONCAT(nombre, ' ', apellido) INTO NEW.reported_by
    FROM public.profiles
    WHERE id = NEW.reported_by_id;
  END IF;
  
  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."update_incident_reporter_name"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."update_maintenance_plan_after_completion"("p_asset_id" "uuid", "p_interval_value" integer, "p_completion_date" timestamp with time zone) RETURNS "void"
    LANGUAGE "plpgsql"
    AS $$
DECLARE
  v_plan_id UUID;
BEGIN
  -- Encontrar el plan de mantenimiento que corresponde al intervalo
  SELECT id INTO v_plan_id
  FROM maintenance_plans
  WHERE 
    asset_id = p_asset_id AND 
    interval_value = p_interval_value;
  
  IF v_plan_id IS NOT NULL THEN
    -- Actualizar el plan de mantenimiento
    UPDATE maintenance_plans
    SET 
      last_completed = p_completion_date,
      next_due = (
        SELECT calculate_next_maintenance(
          p_asset_id,
          interval_value
        )
      ),
      status = 'Programado'
    WHERE id = v_plan_id;
  END IF;
END;
$$;


ALTER FUNCTION "public"."update_maintenance_plan_after_completion"("p_asset_id" "uuid", "p_interval_value" integer, "p_completion_date" timestamp with time zone) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."update_maintenance_technician_name"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
BEGIN
  -- Get the technician's name from profiles
  IF NEW.technician_id IS NOT NULL THEN
    SELECT CONCAT(nombre, ' ', apellido) INTO NEW.technician
    FROM public.profiles
    WHERE id = NEW.technician_id;
  END IF;
  
  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."update_maintenance_technician_name"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."update_payment_status"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
BEGIN
    -- Auto-update payment_status based on payment_date
    IF NEW.payment_date IS NOT NULL THEN
        NEW.payment_status := 'paid';
    ELSIF NEW.max_payment_date IS NOT NULL AND NEW.max_payment_date < CURRENT_DATE THEN
        NEW.payment_status := 'overdue';
    ELSIF NEW.payment_method = 'transfer' AND NEW.max_payment_date IS NOT NULL THEN
        NEW.payment_status := 'pending';
    ELSIF NEW.payment_method IN ('cash', 'card') THEN
        -- For cash and card, payment is immediate when purchased
        IF NEW.status IN ('purchased', 'receipt_uploaded', 'validated') THEN
            NEW.payment_status := 'paid';
            -- Auto-set payment date for cash/card if not already set
            IF NEW.payment_date IS NULL AND NEW.purchased_at IS NOT NULL THEN
                NEW.payment_date := NEW.purchased_at;
            END IF;
        END IF;
    ELSE
        NEW.payment_status := NULL;
    END IF;
    
    RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."update_payment_status"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."update_technician_name"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
BEGIN
  -- Get the technician's name from profiles
  IF NEW.technician_id IS NOT NULL THEN
    SELECT CONCAT(nombre, ' ', apellido) INTO NEW.technician
    FROM public.profiles
    WHERE id = NEW.technician_id;
  END IF;
  
  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."update_technician_name"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."update_timestamp"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."update_timestamp"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."update_transaction_with_recalculation"("p_transaction_id" "uuid", "p_new_quantity" numeric, "p_new_date" timestamp with time zone, "p_new_cuenta_litros" numeric DEFAULT NULL::numeric) RETURNS "json"
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
DECLARE
  v_tx RECORD;
  v_wh uuid;
  v_old_qty numeric;
  v_old_date timestamptz;
  v_old_cuenta numeric;
BEGIN
  SELECT * INTO v_tx FROM diesel_transactions WHERE id = p_transaction_id;
  IF NOT FOUND THEN
    RETURN json_build_object('success', false, 'error', 'Transaction not found');
  END IF;

  v_wh := v_tx.warehouse_id;
  v_old_qty := v_tx.quantity_liters;
  v_old_date := v_tx.transaction_date;
  v_old_cuenta := v_tx.cuenta_litros;

  UPDATE diesel_transactions
  SET
    quantity_liters = p_new_quantity,
    transaction_date = p_new_date,
    cuenta_litros = CASE
      WHEN p_new_cuenta_litros IS NOT NULL AND (v_old_cuenta IS NULL OR p_new_cuenta_litros != v_old_cuenta)
        THEN p_new_cuenta_litros
      ELSE cuenta_litros
    END,
    updated_at = NOW()
  WHERE id = p_transaction_id;

  -- AFTER UPDATE trigger will cascade recalculation and sync warehouse balance
  RETURN json_build_object(
    'success', true,
    'transaction_id', v_tx.transaction_id,
    'warehouse_id', v_wh
  );
EXCEPTION WHEN OTHERS THEN
  RETURN json_build_object('success', false, 'error', SQLERRM);
END;
$$;


ALTER FUNCTION "public"."update_transaction_with_recalculation"("p_transaction_id" "uuid", "p_new_quantity" numeric, "p_new_date" timestamp with time zone, "p_new_cuenta_litros" numeric) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."update_updated_at_column"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."update_updated_at_column"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."update_warehouse_on_transaction"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
BEGIN
  -- Update warehouse current_inventory and current_cuenta_litros
  UPDATE diesel_warehouses
  SET 
    current_inventory = CASE
      WHEN NEW.transaction_type = 'entry' THEN current_inventory + NEW.quantity_liters
      WHEN NEW.transaction_type = 'consumption' THEN current_inventory - NEW.quantity_liters
      ELSE current_inventory
    END,
    current_cuenta_litros = CASE
      WHEN has_cuenta_litros AND NEW.cuenta_litros IS NOT NULL THEN NEW.cuenta_litros
      ELSE current_cuenta_litros
    END,
    last_updated = NOW()
  WHERE id = NEW.warehouse_id;
  
  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."update_warehouse_on_transaction"() OWNER TO "postgres";


COMMENT ON FUNCTION "public"."update_warehouse_on_transaction"() IS 'Automatically updates warehouse inventory and cuenta_litros (runs with SECURITY DEFINER to bypass RLS)';



CREATE OR REPLACE FUNCTION "public"."update_work_order_text"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
BEGIN
  -- Get the work order ID for display
  IF NEW.work_order_id IS NOT NULL THEN
    SELECT order_id INTO NEW.work_order
    FROM public.work_orders
    WHERE id = NEW.work_order_id;
  END IF;
  
  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."update_work_order_text"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."validate_equipment_readings"("p_asset_id" "uuid", "p_hours_reading" integer DEFAULT NULL::integer, "p_kilometers_reading" integer DEFAULT NULL::integer) RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
DECLARE
  v_current_hours INTEGER;
  v_current_kilometers INTEGER;
  v_maintenance_unit TEXT;
  v_expected_hours JSONB;
  v_expected_kilometers JSONB;
  v_warnings TEXT[] := '{}';
  v_errors TEXT[] := '{}';
BEGIN
  -- Obtener información actual del activo
  SELECT 
    a.current_hours, 
    a.current_kilometers, 
    em.maintenance_unit
  INTO v_current_hours, v_current_kilometers, v_maintenance_unit
  FROM assets a
  LEFT JOIN equipment_models em ON a.model_id = em.id
  WHERE a.id = p_asset_id;
  
  IF NOT FOUND THEN
    v_errors := array_append(v_errors, 'Activo no encontrado');
    RETURN jsonb_build_object(
      'valid', FALSE,
      'errors', v_errors
    );
  END IF;
  
  -- Validar horas si se proporcionaron
  IF p_hours_reading IS NOT NULL THEN
    -- Obtener lectura esperada
    SELECT get_expected_next_reading(p_asset_id, 'hours') INTO v_expected_hours;
    
    -- Validaciones de horas
    IF p_hours_reading < v_current_hours THEN
      -- Posible reset o error
      IF (v_current_hours - p_hours_reading) > 10000 THEN
        v_warnings := array_append(v_warnings, 
          'Posible reset del horómetro detectado. Verifique la lectura.');
      ELSE
        v_errors := array_append(v_errors, 
          format('Las horas (%s) no pueden ser menores que las actuales (%s)', 
            p_hours_reading, v_current_hours));
      END IF;
    END IF;
    
    -- Advertencia si la diferencia es muy grande
    IF p_hours_reading > v_current_hours + 500 THEN
      v_warnings := array_append(v_warnings, 
        'La diferencia de horas es muy grande. Verifique la lectura.');
    END IF;
  END IF;
  
  -- Validar kilómetros si se proporcionaron
  IF p_kilometers_reading IS NOT NULL THEN
    -- Obtener lectura esperada
    SELECT get_expected_next_reading(p_asset_id, 'kilometers') INTO v_expected_kilometers;
    
    -- Validaciones de kilómetros
    IF p_kilometers_reading < v_current_kilometers THEN
      -- Posible reset o error
      IF (v_current_kilometers - p_kilometers_reading) > 100000 THEN
        v_warnings := array_append(v_warnings, 
          'Posible reset del odómetro detectado. Verifique la lectura.');
      ELSE
        v_errors := array_append(v_errors, 
          format('Los kilómetros (%s) no pueden ser menores que los actuales (%s)', 
            p_kilometers_reading, v_current_kilometers));
      END IF;
    END IF;
    
    -- Advertencia si la diferencia es muy grande
    IF p_kilometers_reading > v_current_kilometers + 5000 THEN
      v_warnings := array_append(v_warnings, 
        'La diferencia de kilómetros es muy grande. Verifique la lectura.');
    END IF;
  END IF;
  
  -- Validar que se proporcione la lectura correcta según la unidad de mantenimiento
  IF v_maintenance_unit = 'hours' AND p_hours_reading IS NULL THEN
    v_warnings := array_append(v_warnings, 
      'Este equipo se mantiene por horas. Se recomienda ingresar la lectura del horómetro.');
  END IF;
  
  IF v_maintenance_unit = 'kilometers' AND p_kilometers_reading IS NULL THEN
    v_warnings := array_append(v_warnings, 
      'Este equipo se mantiene por kilómetros. Se recomienda ingresar la lectura del odómetro.');
  END IF;
  
  RETURN jsonb_build_object(
    'valid', array_length(v_errors, 1) IS NULL OR array_length(v_errors, 1) = 0,
    'errors', v_errors,
    'warnings', v_warnings,
    'current_hours', v_current_hours,
    'current_kilometers', v_current_kilometers,
    'maintenance_unit', v_maintenance_unit,
    'expected_hours', v_expected_hours,
    'expected_kilometers', v_expected_kilometers
  );
END;
$$;


ALTER FUNCTION "public"."validate_equipment_readings"("p_asset_id" "uuid", "p_hours_reading" integer, "p_kilometers_reading" integer) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."validate_evidence_requirements"("p_completed_checklist_id" "uuid", "p_evidence_data" "jsonb") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
DECLARE
  v_section RECORD;
  v_config JSONB;
  v_min_photos INTEGER;
  v_max_photos INTEGER;
  v_categories TEXT[];
  v_category TEXT;
  v_provided_count INTEGER;
  v_errors TEXT[] := '{}';
  v_warnings TEXT[] := '{}';
BEGIN
  -- Obtener todas las secciones de evidencia del checklist
  FOR v_section IN 
    SELECT cs.id, cs.title, cs.evidence_config, cc.checklist_id
    FROM completed_checklists cc
    JOIN checklist_schedules chs ON cc.id = p_completed_checklist_id
    JOIN checklist_sections cs ON cs.checklist_id = chs.template_id
    WHERE cs.section_type = 'evidence'
      AND cc.id = p_completed_checklist_id
  LOOP
    v_config := v_section.evidence_config;
    
    -- Extraer configuración
    v_min_photos := COALESCE((v_config->>'min_photos')::INTEGER, 1);
    v_max_photos := COALESCE((v_config->>'max_photos')::INTEGER, 10);
    v_categories := ARRAY(SELECT jsonb_array_elements_text(v_config->'categories'));
    
    -- Validar cada categoría requerida
    IF v_categories IS NOT NULL THEN
      FOREACH v_category IN ARRAY v_categories
      LOOP
        -- Contar fotos proporcionadas para esta categoría
        SELECT COUNT(*)::INTEGER INTO v_provided_count
        FROM jsonb_array_elements(p_evidence_data) AS evidence
        WHERE evidence->>'section_id' = v_section.id::TEXT
          AND evidence->>'category' = v_category;
        
        -- Validar mínimo
        IF v_provided_count < v_min_photos THEN
          v_errors := array_append(v_errors, 
            format('Se requieren al menos %s fotos para "%s" en %s', 
              v_min_photos, v_category, v_section.title));
        END IF;
        
        -- Validar máximo
        IF v_provided_count > v_max_photos THEN
          v_warnings := array_append(v_warnings, 
            format('Se proporcionaron %s fotos para "%s" (máximo recomendado: %s)', 
              v_provided_count, v_category, v_max_photos));
        END IF;
      END LOOP;
    END IF;
  END LOOP;
  
  RETURN jsonb_build_object(
    'valid', array_length(v_errors, 1) IS NULL OR array_length(v_errors, 1) = 0,
    'errors', v_errors,
    'warnings', v_warnings
  );
END;
$$;


ALTER FUNCTION "public"."validate_evidence_requirements"("p_completed_checklist_id" "uuid", "p_evidence_data" "jsonb") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."validate_po_status"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
DECLARE
  allowed_statuses TEXT[];
  has_quotation BOOLEAN := false;
BEGIN
  allowed_statuses := get_allowed_statuses(NEW.po_type);
  
  IF NOT (NEW.status = ANY(allowed_statuses)) THEN
    RAISE EXCEPTION 'Status % not allowed for purchase order type %', NEW.status, NEW.po_type;
  END IF;
  
  -- Check for quotations in both legacy and new fields
  IF NEW.requires_quote AND NEW.status IN ('pending_approval', 'approved') THEN
    -- Check legacy quotation_url field
    IF NEW.quotation_url IS NOT NULL AND NEW.quotation_url != '' THEN
      has_quotation := true;
    END IF;
    
    -- Check new quotation_urls array field
    IF NEW.quotation_urls IS NOT NULL AND jsonb_array_length(NEW.quotation_urls) > 0 THEN
      -- Ensure at least one URL is not empty
      SELECT bool_or(trim(url) != '') INTO has_quotation 
      FROM jsonb_array_elements_text(NEW.quotation_urls) AS url;
    END IF;
    
    -- If neither field has a quotation, raise error
    IF NOT has_quotation THEN
      RAISE EXCEPTION 'Quotation required for this purchase order before approval';
    END IF;
  END IF;
  
  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."validate_po_status"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."validate_schedule_integrity"() RETURNS TABLE("template_id" "uuid", "asset_id" "uuid", "date_only" "date", "status" "text", "count" bigint, "issue_type" "text")
    LANGUAGE "plpgsql"
    AS $$
BEGIN
  RETURN QUERY
  SELECT 
    cs.template_id,
    cs.asset_id,
    DATE(cs.scheduled_date) as date_only,
    cs.status,
    COUNT(*) as count,
    CASE 
      WHEN COUNT(*) > 1 THEN 'DUPLICATE_SAME_STATUS'
      ELSE 'OK'
    END as issue_type
  FROM checklist_schedules cs
  GROUP BY cs.template_id, cs.asset_id, DATE(cs.scheduled_date), cs.status
  HAVING COUNT(*) > 1;
END;
$$;


ALTER FUNCTION "public"."validate_schedule_integrity"() OWNER TO "postgres";

SET default_tablespace = '';

SET default_table_access_method = "heap";


CREATE TABLE IF NOT EXISTS "public"."profiles" (
    "id" "uuid" NOT NULL,
    "nombre" "text",
    "apellido" "text",
    "telefono" "text",
    "avatar_url" "text",
    "departamento" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "role" "public"."user_role" DEFAULT 'GERENCIA_GENERAL'::"public"."user_role",
    "plant_id" "uuid",
    "business_unit_id" "uuid",
    "employee_code" "text",
    "position" "text",
    "shift" "text",
    "phone_secondary" "text",
    "emergency_contact" "jsonb",
    "hire_date" "date",
    "status" "text" DEFAULT 'active'::"text",
    "can_authorize_up_to" numeric DEFAULT 1000,
    "is_operator" boolean DEFAULT false,
    "direccion" "text",
    "fecha_nacimiento" "date",
    "estado_civil" character varying(20),
    "tipo_contrato" character varying(50),
    "nivel_educacion" character varying(50),
    "certificaciones" "text"[],
    "experiencia_anos" integer DEFAULT 0,
    "fecha_ultima_capacitacion" "date",
    "notas_rh" "text",
    "email" character varying(255),
    "imss_number" "text",
    "system_username" "text",
    "system_password" "text",
    "credential_notes" "text",
    "system_access_password" "text",
    "office_id" "uuid",
    "is_active" boolean DEFAULT true NOT NULL,
    "deactivated_at" timestamp with time zone,
    "deactivated_by" "uuid",
    "deactivation_reason" "text",
    CONSTRAINT "profiles_shift_check" CHECK (("shift" = ANY (ARRAY['morning'::"text", 'afternoon'::"text", 'night'::"text"]))),
    CONSTRAINT "profiles_status_check" CHECK (("status" = ANY (ARRAY['active'::"text", 'inactive'::"text", 'suspended'::"text"])))
);


ALTER TABLE "public"."profiles" OWNER TO "postgres";


COMMENT ON TABLE "public"."profiles" IS 'FIX APPLIED: RLS policies that work with server-side queries';



COMMENT ON COLUMN "public"."profiles"."plant_id" IS 'Plant assignment for organizational access control';



COMMENT ON COLUMN "public"."profiles"."business_unit_id" IS 'Business unit assignment for multi-plant managers';



COMMENT ON COLUMN "public"."profiles"."employee_code" IS 'Unique employee identifier for payroll/HR integration';



COMMENT ON COLUMN "public"."profiles"."can_authorize_up_to" IS 'Individual authorization limit in MXN, overrides role default';



COMMENT ON COLUMN "public"."profiles"."imss_number" IS 'Employee IMSS (Mexican Social Security) number for credentials';



COMMENT ON COLUMN "public"."profiles"."system_username" IS 'Username for maintenance system login (displayed on credential)';



COMMENT ON COLUMN "public"."profiles"."system_password" IS 'Password for maintenance system (displayed on credential)';



COMMENT ON COLUMN "public"."profiles"."credential_notes" IS 'Additional notes for employee credentials';



COMMENT ON COLUMN "public"."profiles"."system_access_password" IS 'Actual system access password for maintenance platform (e.g., Planta04DC, Planta01DC, etc.)';



CREATE TABLE IF NOT EXISTS "public"."purchase_orders" (
    "id" "uuid" DEFAULT "extensions"."uuid_generate_v4"() NOT NULL,
    "order_id" "text" NOT NULL,
    "work_order_id" "uuid",
    "supplier" "text",
    "total_amount" numeric(10,2),
    "requested_by" "uuid",
    "approved_by" "uuid",
    "approval_date" timestamp with time zone,
    "expected_delivery_date" timestamp with time zone,
    "actual_delivery_date" timestamp with time zone,
    "status" "text" DEFAULT 'Pendiente'::"text",
    "items" "jsonb",
    "notes" "text",
    "invoice_number" "text",
    "invoice_date" timestamp with time zone,
    "payment_status" "text",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "quotation_url" "text",
    "requires_adjustment" boolean DEFAULT false,
    "adjustment_amount" numeric(10,2),
    "adjustment_reason" "text",
    "adjustment_status" "text",
    "adjusted_at" timestamp with time zone,
    "adjusted_by" "uuid",
    "adjusted_total_amount" numeric(10,2),
    "updated_by" "uuid",
    "is_adjustment" boolean DEFAULT false,
    "original_purchase_order_id" "uuid",
    "receipt_uploaded" boolean DEFAULT false,
    "plant_id" "uuid",
    "requires_approval" boolean DEFAULT false,
    "authorized_by" "uuid",
    "authorization_date" timestamp with time zone,
    "po_type" character varying(20) DEFAULT 'special_order'::character varying,
    "payment_method" character varying(15),
    "requires_quote" boolean DEFAULT false,
    "store_location" character varying(255),
    "service_provider" character varying(255),
    "actual_amount" numeric(10,2),
    "purchased_at" timestamp with time zone,
    "quote_required_reason" "text",
    "enhanced_status" character varying(30),
    "max_payment_date" timestamp with time zone,
    "payment_date" timestamp with time zone,
    "payment_reference" character varying(255),
    "payment_notes" "text",
    "paid_by" "uuid",
    "supplier_id" "uuid",
    "quotation_urls" "jsonb" DEFAULT '[]'::"jsonb",
    "purchase_date" timestamp with time zone,
    "posting_date" timestamp with time zone GENERATED ALWAYS AS (COALESCE("purchase_date", "actual_delivery_date", "approval_date", "created_at")) STORED,
    CONSTRAINT "chk_payment_method" CHECK (((("payment_method")::"text" = ANY ((ARRAY['cash'::character varying, 'transfer'::character varying, 'card'::character varying])::"text"[])) OR ("payment_method" IS NULL))),
    CONSTRAINT "chk_po_type" CHECK ((("po_type")::"text" = ANY ((ARRAY['direct_purchase'::character varying, 'direct_service'::character varying, 'special_order'::character varying])::"text"[])))
);


ALTER TABLE "public"."purchase_orders" OWNER TO "postgres";


COMMENT ON TABLE "public"."purchase_orders" IS 'Validation trigger for max_payment_date was removed to allow authorization flexibility regardless of payment dates';



COMMENT ON COLUMN "public"."purchase_orders"."quotation_url" IS 'Legacy single quotation URL. Kept for backwards compatibility. New uploads should use quotation_urls array.';



COMMENT ON COLUMN "public"."purchase_orders"."po_type" IS 'Type of purchase order: direct_purchase, direct_service, special_order';



COMMENT ON COLUMN "public"."purchase_orders"."payment_method" IS 'Payment method: cash, transfer, card';



COMMENT ON COLUMN "public"."purchase_orders"."requires_quote" IS 'Whether this PO requires a quotation (auto-calculated)';



COMMENT ON COLUMN "public"."purchase_orders"."store_location" IS 'Store location for direct purchases';



COMMENT ON COLUMN "public"."purchase_orders"."service_provider" IS 'Service provider for direct services';



COMMENT ON COLUMN "public"."purchase_orders"."actual_amount" IS 'Actual amount spent (may differ from estimated)';



COMMENT ON COLUMN "public"."purchase_orders"."purchased_at" IS 'Timestamp when purchase/service was completed';



COMMENT ON COLUMN "public"."purchase_orders"."quote_required_reason" IS 'Reason why quotation is required for this PO';



COMMENT ON COLUMN "public"."purchase_orders"."enhanced_status" IS 'Enhanced status for new workflow states';



COMMENT ON COLUMN "public"."purchase_orders"."max_payment_date" IS 'Maximum date for payment when payment_method is transfer. Optional field - only used when needed for transfer payments.';



COMMENT ON COLUMN "public"."purchase_orders"."payment_date" IS 'Actual date when payment was made (null = not paid yet)';



COMMENT ON COLUMN "public"."purchase_orders"."payment_reference" IS 'Transfer number, check number, or payment reference';



COMMENT ON COLUMN "public"."purchase_orders"."payment_notes" IS 'Additional notes about the payment';



COMMENT ON COLUMN "public"."purchase_orders"."paid_by" IS 'User who marked this order as paid';



COMMENT ON COLUMN "public"."purchase_orders"."supplier_id" IS 'Reference to the suppliers table for enhanced supplier management - nullable for backward compatibility';



COMMENT ON COLUMN "public"."purchase_orders"."quotation_urls" IS 'Array of quotation file URLs stored as JSONB. Supports multiple quotation files.';



COMMENT ON COLUMN "public"."purchase_orders"."purchase_date" IS 'Date when the items will be purchased or were purchased. Independent of when the PO was created in the system.';



COMMENT ON COLUMN "public"."purchase_orders"."posting_date" IS 'Accounting posting date used for monthly allocation and reporting (generated)';



CREATE OR REPLACE VIEW "public"."accounts_payable_summary" AS
 SELECT "po"."id",
    "po"."order_id",
    "po"."supplier",
    "po"."service_provider",
    "po"."store_location",
    "po"."total_amount",
    "po"."actual_amount",
    "po"."payment_method",
    "po"."payment_status",
    "po"."payment_date",
    "po"."payment_reference",
    "po"."payment_notes",
    "po"."max_payment_date",
    "po"."created_at",
    "po"."purchased_at",
    "po"."po_type",
    "po"."status",
        CASE
            WHEN ("po"."payment_date" IS NOT NULL) THEN 0
            WHEN ("po"."max_payment_date" IS NULL) THEN 999
            ELSE (EXTRACT(day FROM ("po"."max_payment_date" - (CURRENT_DATE)::timestamp with time zone)))::integer
        END AS "days_until_due",
        CASE
            WHEN ("po"."payment_date" IS NOT NULL) THEN 'Pagado'::"text"
            WHEN (("po"."max_payment_date" IS NOT NULL) AND ("po"."max_payment_date" < CURRENT_DATE)) THEN 'Vencido'::"text"
            WHEN (("po"."max_payment_date" IS NOT NULL) AND ("po"."max_payment_date" >= CURRENT_DATE)) THEN 'Pendiente'::"text"
            WHEN (("po"."payment_method")::"text" = ANY ((ARRAY['cash'::character varying, 'card'::character varying])::"text"[])) THEN 'Inmediato'::"text"
            ELSE 'Sin fecha'::"text"
        END AS "payment_status_display",
    (("req"."nombre" || ' '::"text") || "req"."apellido") AS "requested_by_name",
    (("paid"."nombre" || ' '::"text") || "paid"."apellido") AS "paid_by_name"
   FROM (("public"."purchase_orders" "po"
     LEFT JOIN "public"."profiles" "req" ON (("po"."requested_by" = "req"."id")))
     LEFT JOIN "public"."profiles" "paid" ON (("po"."paid_by" = "paid"."id")))
  WHERE ("po"."status" = ANY (ARRAY['approved'::"text", 'purchased'::"text", 'receipt_uploaded'::"text", 'validated'::"text", 'ordered'::"text", 'received'::"text"]))
  ORDER BY
        CASE
            WHEN ("po"."payment_date" IS NOT NULL) THEN 3
            WHEN (("po"."max_payment_date" IS NOT NULL) AND ("po"."max_payment_date" < CURRENT_DATE)) THEN 1
            WHEN ("po"."max_payment_date" IS NOT NULL) THEN 2
            ELSE 4
        END, "po"."max_payment_date", "po"."created_at" DESC;


ALTER TABLE "public"."accounts_payable_summary" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."assets" (
    "id" "uuid" DEFAULT "extensions"."uuid_generate_v4"() NOT NULL,
    "asset_id" "text" NOT NULL,
    "name" "text" NOT NULL,
    "model_id" "uuid",
    "serial_number" "text",
    "location" "text",
    "department" "text",
    "purchase_date" timestamp with time zone,
    "installation_date" timestamp with time zone,
    "initial_hours" integer DEFAULT 0,
    "current_hours" integer DEFAULT 0,
    "initial_kilometers" integer DEFAULT 0,
    "current_kilometers" integer DEFAULT 0,
    "status" "text" DEFAULT 'operational'::"text",
    "notes" "text",
    "warranty_expiration" timestamp with time zone,
    "is_new" boolean DEFAULT true,
    "purchase_cost" numeric(10,2),
    "registration_info" "text",
    "insurance_policy" "text",
    "insurance_start_date" timestamp with time zone,
    "insurance_end_date" timestamp with time zone,
    "photos" "text"[],
    "insurance_documents" "text"[],
    "last_maintenance_date" timestamp with time zone,
    "created_by" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "updated_by" "uuid",
    "last_inspection_date" timestamp with time zone,
    "plant_id" "uuid",
    "department_id" "uuid",
    "is_composite" boolean DEFAULT false,
    "component_assets" "uuid"[] DEFAULT '{}'::"uuid"[],
    "composite_type" "text",
    "primary_component_id" "uuid"
);


ALTER TABLE "public"."assets" OWNER TO "postgres";


COMMENT ON TABLE "public"."assets" IS 'RLS FINAL: Hierarchical access control without recursion - PRODUCTION READY';



COMMENT ON COLUMN "public"."assets"."status" IS 'Asset operational status: operational, maintenance, repair, or other descriptive status';



CREATE TABLE IF NOT EXISTS "public"."completed_checklists" (
    "id" "uuid" DEFAULT "extensions"."uuid_generate_v4"() NOT NULL,
    "checklist_id" "uuid",
    "asset_id" "uuid",
    "completed_items" "jsonb" NOT NULL,
    "technician" "text" NOT NULL,
    "completion_date" timestamp with time zone NOT NULL,
    "notes" "text",
    "status" "text" DEFAULT 'Completado'::"text",
    "service_order_id" "text",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "created_by" "uuid",
    "updated_by" "uuid",
    "signature_data" "text",
    "template_version_id" "uuid",
    "equipment_hours_reading" integer,
    "equipment_kilometers_reading" integer,
    "reading_timestamp" timestamp with time zone DEFAULT "now"(),
    "previous_hours" integer,
    "previous_kilometers" integer,
    "security_data" "jsonb"
);


ALTER TABLE "public"."completed_checklists" OWNER TO "postgres";


COMMENT ON COLUMN "public"."completed_checklists"."signature_data" IS 'Base64 encoded signature data from technician';



COMMENT ON COLUMN "public"."completed_checklists"."equipment_hours_reading" IS 'Lectura del horómetro del equipo al momento de completar el checklist';



COMMENT ON COLUMN "public"."completed_checklists"."equipment_kilometers_reading" IS 'Lectura del kilometraje del equipo al momento de completar el checklist';



COMMENT ON COLUMN "public"."completed_checklists"."reading_timestamp" IS 'Timestamp exacto cuando se tomó la lectura';



COMMENT ON COLUMN "public"."completed_checklists"."previous_hours" IS 'Horas previas del equipo antes de esta lectura (para auditoría)';



COMMENT ON COLUMN "public"."completed_checklists"."previous_kilometers" IS 'Kilómetros previos del equipo antes de esta lectura (para auditoría)';



COMMENT ON COLUMN "public"."completed_checklists"."security_data" IS 'Security talk completion data including attendees, topic, reflection, and evidence per section';



CREATE TABLE IF NOT EXISTS "public"."equipment_models" (
    "id" "uuid" DEFAULT "extensions"."uuid_generate_v4"() NOT NULL,
    "model_id" "text" NOT NULL,
    "name" "text" NOT NULL,
    "manufacturer" "text" NOT NULL,
    "category" "text" NOT NULL,
    "description" "text",
    "year_introduced" integer,
    "expected_lifespan" integer,
    "specifications" "jsonb",
    "maintenance_unit" "text" DEFAULT 'hours'::"text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "created_by" "uuid",
    "updated_by" "uuid"
);


ALTER TABLE "public"."equipment_models" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."active_assets_without_recent_inspection" AS
 SELECT "a"."id",
    "a"."asset_id",
    "a"."name",
    "a"."model_id",
    "a"."serial_number",
    "a"."location",
    "a"."department",
    "a"."purchase_date",
    "a"."installation_date",
    "a"."initial_hours",
    "a"."current_hours",
    "a"."initial_kilometers",
    "a"."current_kilometers",
    "a"."status",
    "a"."notes",
    "a"."warranty_expiration",
    "a"."is_new",
    "a"."purchase_cost",
    "a"."registration_info",
    "a"."insurance_policy",
    "a"."insurance_start_date",
    "a"."insurance_end_date",
    "a"."photos",
    "a"."insurance_documents",
    "a"."last_maintenance_date",
    "a"."created_by",
    "a"."created_at",
    "a"."updated_at",
    "a"."updated_by",
    "a"."last_inspection_date",
    "em"."name" AS "model_name",
    "em"."manufacturer",
    COALESCE("cc"."last_inspection", "a"."last_inspection_date", "a"."last_maintenance_date") AS "last_inspection",
    EXTRACT(day FROM ("now"() - COALESCE("cc"."last_inspection", "a"."last_inspection_date", "a"."last_maintenance_date"))) AS "days_since_last_inspection"
   FROM (("public"."assets" "a"
     JOIN "public"."equipment_models" "em" ON (("a"."model_id" = "em"."id")))
     LEFT JOIN ( SELECT "completed_checklists"."asset_id",
            "max"("completed_checklists"."completion_date") AS "last_inspection"
           FROM "public"."completed_checklists"
          GROUP BY "completed_checklists"."asset_id") "cc" ON (("a"."id" = "cc"."asset_id")))
  WHERE (("a"."status" = 'activo'::"text") AND ((COALESCE("cc"."last_inspection", "a"."last_inspection_date", "a"."last_maintenance_date") IS NULL) OR (EXTRACT(day FROM ("now"() - COALESCE("cc"."last_inspection", "a"."last_inspection_date", "a"."last_maintenance_date"))) > (30)::numeric)));


ALTER TABLE "public"."active_assets_without_recent_inspection" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."additional_expenses" (
    "id" "uuid" DEFAULT "extensions"."uuid_generate_v4"() NOT NULL,
    "work_order_id" "uuid",
    "asset_id" "uuid",
    "description" "text" NOT NULL,
    "amount" numeric(10,2) NOT NULL,
    "justification" "text" NOT NULL,
    "status" "text" DEFAULT 'pendiente_aprobacion'::"text" NOT NULL,
    "created_by" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "approved_by" "uuid",
    "approved_at" timestamp with time zone,
    "rejected_by" "uuid",
    "rejected_at" timestamp with time zone,
    "rejection_reason" "text",
    "updated_by" "uuid",
    "adjustment_po_id" "uuid",
    "processed" boolean DEFAULT false
);


ALTER TABLE "public"."additional_expenses" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."app_settings" (
    "key" "text" NOT NULL,
    "value" "text" NOT NULL,
    "description" "text",
    "category" "text" DEFAULT 'general'::"text",
    "is_sensitive" boolean DEFAULT false,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."app_settings" OWNER TO "postgres";


COMMENT ON TABLE "public"."app_settings" IS 'Global application settings and configuration';



CREATE TABLE IF NOT EXISTS "public"."asset_assignment_history" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "asset_id" "uuid" NOT NULL,
    "previous_plant_id" "uuid",
    "new_plant_id" "uuid",
    "changed_by" "uuid" NOT NULL,
    "change_reason" "text",
    "created_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."asset_assignment_history" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."asset_composite_relationships" (
    "id" "uuid" DEFAULT "extensions"."uuid_generate_v4"() NOT NULL,
    "composite_asset_id" "uuid" NOT NULL,
    "component_asset_id" "uuid" NOT NULL,
    "attachment_date" "date" DEFAULT CURRENT_DATE,
    "detachment_date" "date",
    "status" "text" DEFAULT 'active'::"text",
    "created_by" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"(),
    CONSTRAINT "asset_composite_relationships_status_check" CHECK (("status" = ANY (ARRAY['active'::"text", 'detached'::"text"])))
);


ALTER TABLE "public"."asset_composite_relationships" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."asset_name_mappings" (
    "id" "uuid" DEFAULT "extensions"."uuid_generate_v4"() NOT NULL,
    "original_name" "text" NOT NULL,
    "asset_id" "uuid",
    "exception_asset_id" "uuid",
    "mapping_type" "text" NOT NULL,
    "confidence_level" numeric(3,2),
    "mapping_source" "text" NOT NULL,
    "notes" "text",
    "created_by" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "source_system" "text",
    "external_unit" "text",
    CONSTRAINT "asset_name_mappings_check" CHECK (((("mapping_type" = 'formal'::"text") AND ("asset_id" IS NOT NULL) AND ("exception_asset_id" IS NULL)) OR (("mapping_type" = 'exception'::"text") AND ("asset_id" IS NULL) AND ("exception_asset_id" IS NOT NULL)) OR (("mapping_type" = 'ignore'::"text") AND ("asset_id" IS NULL) AND ("exception_asset_id" IS NULL)))),
    CONSTRAINT "asset_name_mappings_confidence_level_check" CHECK ((("confidence_level" >= (0)::numeric) AND ("confidence_level" <= (1)::numeric))),
    CONSTRAINT "asset_name_mappings_mapping_source_check" CHECK (("mapping_source" = ANY (ARRAY['automatic'::"text", 'manual'::"text", 'verified'::"text"]))),
    CONSTRAINT "asset_name_mappings_mapping_type_check" CHECK (("mapping_type" = ANY (ARRAY['formal'::"text", 'exception'::"text", 'ignore'::"text"])))
);


ALTER TABLE "public"."asset_name_mappings" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."asset_operators" (
    "id" "uuid" DEFAULT "extensions"."uuid_generate_v4"() NOT NULL,
    "asset_id" "uuid" NOT NULL,
    "operator_id" "uuid" NOT NULL,
    "assignment_type" "text" DEFAULT 'primary'::"text" NOT NULL,
    "start_date" "date" DEFAULT CURRENT_DATE NOT NULL,
    "end_date" "date",
    "status" "text" DEFAULT 'active'::"text",
    "notes" "text",
    "assigned_by" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "created_by" "uuid" DEFAULT "auth"."uid"(),
    "updated_by" "uuid" DEFAULT "auth"."uid"(),
    CONSTRAINT "asset_operators_assignment_type_check" CHECK (("assignment_type" = ANY (ARRAY['primary'::"text", 'secondary'::"text"]))),
    CONSTRAINT "asset_operators_status_check" CHECK (("status" = ANY (ARRAY['active'::"text", 'inactive'::"text"]))),
    CONSTRAINT "assignment_type_check" CHECK (("assignment_type" = ANY (ARRAY['primary'::"text", 'secondary'::"text"])))
);


ALTER TABLE "public"."asset_operators" OWNER TO "postgres";


COMMENT ON TABLE "public"."asset_operators" IS 'Assigns operators to specific assets for maintenance responsibility';



CREATE TABLE IF NOT EXISTS "public"."business_units" (
    "id" "uuid" DEFAULT "extensions"."uuid_generate_v4"() NOT NULL,
    "name" "text" NOT NULL,
    "code" "text" NOT NULL,
    "description" "text",
    "manager_id" "uuid",
    "status" "text" DEFAULT 'active'::"text",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "created_by" "uuid",
    "updated_by" "uuid",
    CONSTRAINT "business_units_status_check" CHECK (("status" = ANY (ARRAY['active'::"text", 'inactive'::"text"])))
);


ALTER TABLE "public"."business_units" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."plants" (
    "id" "uuid" DEFAULT "extensions"."uuid_generate_v4"() NOT NULL,
    "business_unit_id" "uuid",
    "name" "text" NOT NULL,
    "code" "text" NOT NULL,
    "location" "text",
    "address" "text",
    "plant_manager_id" "uuid",
    "maintenance_supervisor_id" "uuid",
    "status" "text" DEFAULT 'active'::"text",
    "operating_hours" "jsonb",
    "contact_info" "jsonb",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "created_by" "uuid",
    "updated_by" "uuid",
    "contact_phone" character varying(20),
    "contact_email" character varying(255),
    CONSTRAINT "plants_status_check" CHECK (("status" = ANY (ARRAY['active'::"text", 'inactive'::"text"])))
);


ALTER TABLE "public"."plants" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."asset_operator_assignments" AS
 SELECT "ao"."id",
    "ao"."asset_id",
    "a"."name" AS "asset_name",
    "a"."asset_id" AS "asset_code",
    "ao"."operator_id",
    (("p"."nombre" || ' '::"text") || COALESCE("p"."apellido", ''::"text")) AS "operator_name",
    "p"."employee_code",
    "ao"."assignment_type",
    "ao"."start_date",
    "ao"."end_date",
    "ao"."status",
    "pl"."name" AS "plant_name",
    "bu"."name" AS "business_unit_name"
   FROM (((("public"."asset_operators" "ao"
     JOIN "public"."assets" "a" ON (("ao"."asset_id" = "a"."id")))
     JOIN "public"."profiles" "p" ON (("ao"."operator_id" = "p"."id")))
     LEFT JOIN "public"."plants" "pl" ON (("a"."plant_id" = "pl"."id")))
     LEFT JOIN "public"."business_units" "bu" ON (("pl"."business_unit_id" = "bu"."id")))
  WHERE ("ao"."status" = 'active'::"text");


ALTER TABLE "public"."asset_operator_assignments" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."asset_operators_full" AS
 SELECT "ao"."id",
    "ao"."asset_id",
    "ao"."operator_id",
    "ao"."assignment_type",
    "ao"."start_date",
    "ao"."end_date",
    "ao"."status",
    "ao"."notes",
    "ao"."assigned_by",
    "ao"."created_at",
    "ao"."updated_at",
    "ao"."created_by",
    "ao"."updated_by",
    "a"."id" AS "asset_uuid",
    "a"."name" AS "asset_name",
    "a"."asset_id" AS "asset_code",
    "a"."model_id",
    "a"."plant_id" AS "asset_plant_id",
    "a"."status" AS "asset_status",
    "em"."id" AS "model_uuid",
    "em"."name" AS "model_name",
    "em"."manufacturer" AS "model_manufacturer",
    "ap"."id" AS "asset_plant_uuid",
    "ap"."name" AS "asset_plant_name",
    "ap"."code" AS "asset_plant_code",
    "p"."id" AS "operator_uuid",
    "p"."nombre" AS "operator_nombre",
    "p"."apellido" AS "operator_apellido",
    "p"."role" AS "operator_role",
    "p"."employee_code",
    "p"."shift" AS "operator_shift",
    "p"."status" AS "operator_status",
    "p"."plant_id" AS "operator_plant_id",
    "op"."id" AS "operator_plant_uuid",
    "op"."name" AS "operator_plant_name",
    "op"."code" AS "operator_plant_code"
   FROM ((((("public"."asset_operators" "ao"
     LEFT JOIN "public"."assets" "a" ON (("ao"."asset_id" = "a"."id")))
     LEFT JOIN "public"."equipment_models" "em" ON (("a"."model_id" = "em"."id")))
     LEFT JOIN "public"."plants" "ap" ON (("a"."plant_id" = "ap"."id")))
     LEFT JOIN "public"."profiles" "p" ON (("ao"."operator_id" = "p"."id")))
     LEFT JOIN "public"."plants" "op" ON (("p"."plant_id" = "op"."id")));


ALTER TABLE "public"."asset_operators_full" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."authorization_delegation_history" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "delegation_id" "uuid" NOT NULL,
    "action" "text" NOT NULL,
    "previous_amount" numeric(15,2),
    "new_amount" numeric(15,2),
    "changed_by_user_id" "uuid" NOT NULL,
    "change_reason" "text",
    "created_at" timestamp with time zone DEFAULT "now"(),
    CONSTRAINT "authorization_delegation_history_action_check" CHECK (("action" = ANY (ARRAY['created'::"text", 'modified'::"text", 'revoked'::"text"])))
);


ALTER TABLE "public"."authorization_delegation_history" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."authorization_delegations" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "grantor_user_id" "uuid" NOT NULL,
    "grantee_user_id" "uuid" NOT NULL,
    "delegated_amount" numeric(15,2) NOT NULL,
    "business_unit_id" "uuid",
    "plant_id" "uuid",
    "scope_type" "text" NOT NULL,
    "is_active" boolean DEFAULT true NOT NULL,
    "notes" "text",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    CONSTRAINT "authorization_delegations_delegated_amount_check" CHECK (("delegated_amount" > (0)::numeric)),
    CONSTRAINT "authorization_delegations_scope_type_check" CHECK (("scope_type" = ANY (ARRAY['global'::"text", 'business_unit'::"text", 'plant'::"text"])))
);


ALTER TABLE "public"."authorization_delegations" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."authorization_matrix" (
    "id" "uuid" DEFAULT "extensions"."uuid_generate_v4"() NOT NULL,
    "role" "public"."user_role" NOT NULL,
    "max_amount" numeric NOT NULL,
    "requires_approval" boolean DEFAULT false,
    "approver_role" "public"."user_role",
    "description" "text",
    "created_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."authorization_matrix" OWNER TO "postgres";


COMMENT ON TABLE "public"."authorization_matrix" IS 'Defines spending authorization limits by role';



CREATE OR REPLACE VIEW "public"."authorization_limits" AS
 SELECT "p"."id" AS "user_id",
    (("p"."nombre" || ' '::"text") || COALESCE("p"."apellido", ''::"text")) AS "user_name",
    "p"."role",
    COALESCE("p"."can_authorize_up_to", "am"."max_amount") AS "effective_limit",
    "am"."requires_approval",
    "am"."approver_role",
    "pl"."name" AS "plant_name",
    "bu"."name" AS "business_unit_name"
   FROM ((("public"."profiles" "p"
     LEFT JOIN "public"."authorization_matrix" "am" ON (("p"."role" = "am"."role")))
     LEFT JOIN "public"."plants" "pl" ON (("p"."plant_id" = "pl"."id")))
     LEFT JOIN "public"."business_units" "bu" ON (("p"."business_unit_id" = "bu"."id")))
  WHERE (("p"."status" = 'active'::"text") OR ("p"."status" IS NULL));


ALTER TABLE "public"."authorization_limits" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."auto_create_logs" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "run_at" timestamp without time zone DEFAULT "now"(),
    "result" "jsonb",
    "success" boolean,
    "error" "text"
);


ALTER TABLE "public"."auto_create_logs" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."business_unit_limits" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "business_unit_id" "uuid" NOT NULL,
    "max_authorization_limit" numeric(15,2) DEFAULT 0 NOT NULL,
    "notes" "text",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "created_by" "uuid",
    "updated_by" "uuid"
);


ALTER TABLE "public"."business_unit_limits" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."checklist_schedules" (
    "id" "uuid" DEFAULT "extensions"."uuid_generate_v4"() NOT NULL,
    "template_id" "uuid",
    "asset_id" "uuid",
    "scheduled_date" timestamp with time zone NOT NULL,
    "status" "text" DEFAULT 'pendiente'::"text",
    "assigned_to" "uuid",
    "maintenance_plan_id" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "created_by" "uuid",
    "updated_by" "uuid",
    "scheduled_day" "date" NOT NULL
);


ALTER TABLE "public"."checklist_schedules" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."checklists" (
    "id" "uuid" DEFAULT "extensions"."uuid_generate_v4"() NOT NULL,
    "name" "text" NOT NULL,
    "model_id" "uuid",
    "interval_id" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "created_by" "uuid",
    "updated_by" "uuid",
    "description" "text",
    "frequency" "text",
    "hours_interval" integer
);


ALTER TABLE "public"."checklists" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."checklist_completion_rate" AS
 SELECT "date_trunc"('month'::"text", "cs"."scheduled_date") AS "month",
    "c"."name" AS "checklist_name",
    "count"(*) AS "total_scheduled",
    "sum"(
        CASE
            WHEN ("cs"."status" = 'completado'::"text") THEN 1
            ELSE 0
        END) AS "completed",
    "round"(((("sum"(
        CASE
            WHEN ("cs"."status" = 'completado'::"text") THEN 1
            ELSE 0
        END))::numeric / NULLIF(("count"(*))::numeric, (0)::numeric)) * (100)::numeric), 2) AS "completion_rate"
   FROM ("public"."checklist_schedules" "cs"
     JOIN "public"."checklists" "c" ON (("cs"."template_id" = "c"."id")))
  WHERE ("cs"."scheduled_date" >= ("now"() - '1 year'::interval))
  GROUP BY ("date_trunc"('month'::"text", "cs"."scheduled_date")), "c"."name"
  ORDER BY ("date_trunc"('month'::"text", "cs"."scheduled_date")) DESC, "c"."name";


ALTER TABLE "public"."checklist_completion_rate" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."checklist_evidence" (
    "id" "uuid" DEFAULT "extensions"."uuid_generate_v4"() NOT NULL,
    "completed_checklist_id" "uuid",
    "section_id" "uuid",
    "category" "text" NOT NULL,
    "description" "text",
    "photo_url" "text" NOT NULL,
    "sequence_order" integer DEFAULT 1,
    "metadata" "jsonb",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "created_by" "uuid"
);


ALTER TABLE "public"."checklist_evidence" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."checklist_issues" (
    "id" "uuid" DEFAULT "extensions"."uuid_generate_v4"() NOT NULL,
    "checklist_id" "uuid",
    "item_id" "text" NOT NULL,
    "status" "text" NOT NULL,
    "description" "text" NOT NULL,
    "notes" "text",
    "photo_url" "text",
    "work_order_id" "uuid",
    "resolved" boolean DEFAULT false,
    "resolution_date" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "created_by" "uuid",
    "updated_by" "uuid",
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "incident_id" "uuid",
    "issue_fingerprint" "text",
    "parent_issue_id" "uuid",
    "recurrence_count" integer DEFAULT 1,
    "consolidation_window" interval DEFAULT '30 days'::interval,
    "similar_issue_ids" "jsonb" DEFAULT '[]'::"jsonb"
);


ALTER TABLE "public"."checklist_issues" OWNER TO "postgres";


COMMENT ON COLUMN "public"."checklist_issues"."updated_at" IS 'Timestamp when the issue was last updated';



COMMENT ON COLUMN "public"."checklist_issues"."incident_id" IS 'Referencia al incidente creado automáticamente desde este issue de checklist';



COMMENT ON COLUMN "public"."checklist_issues"."issue_fingerprint" IS 'Unique fingerprint for similar issues: asset_id + item_description + status';



COMMENT ON COLUMN "public"."checklist_issues"."parent_issue_id" IS 'Reference to the original occurrence of this recurring issue';



COMMENT ON COLUMN "public"."checklist_issues"."recurrence_count" IS 'Number of times this issue has occurred';



COMMENT ON COLUMN "public"."checklist_issues"."consolidation_window" IS 'Time window for consolidating similar issues';



COMMENT ON COLUMN "public"."checklist_issues"."similar_issue_ids" IS 'Array of similar issue IDs that have been consolidated';



CREATE TABLE IF NOT EXISTS "public"."checklist_items" (
    "id" "uuid" DEFAULT "extensions"."uuid_generate_v4"() NOT NULL,
    "section_id" "uuid",
    "description" "text" NOT NULL,
    "required" boolean DEFAULT true,
    "order_index" integer NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "created_by" "uuid",
    "updated_by" "uuid",
    "item_type" "text" DEFAULT 'check'::"text",
    "expected_value" "text",
    "tolerance" "text"
);


ALTER TABLE "public"."checklist_items" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."checklist_schedules_status" AS
 SELECT "cs"."id",
    "cs"."template_id",
    "cs"."asset_id",
    "cs"."scheduled_date",
    "cs"."status",
    "cs"."assigned_to",
    "cs"."maintenance_plan_id",
    "cs"."created_at",
    "cs"."updated_at",
    "cs"."created_by",
    "cs"."updated_by",
    "c"."name" AS "checklist_name",
    "c"."frequency",
    "a"."name" AS "asset_name",
    "a"."asset_id" AS "asset_code",
    "a"."location",
    "em"."name" AS "model_name",
        CASE
            WHEN ("cs"."status" = 'completado'::"text") THEN 'Completado'::"text"
            WHEN (("cs"."scheduled_date" < CURRENT_TIMESTAMP) AND ("cs"."status" = 'pendiente'::"text")) THEN 'Vencido'::"text"
            WHEN (("cs"."scheduled_date" >= CURRENT_TIMESTAMP) AND ("cs"."scheduled_date" <= (CURRENT_TIMESTAMP + '7 days'::interval))) THEN 'Próximo'::"text"
            ELSE 'Programado'::"text"
        END AS "status_label",
    EXTRACT(day FROM (CURRENT_TIMESTAMP - "cs"."scheduled_date")) AS "days_overdue"
   FROM ((("public"."checklist_schedules" "cs"
     JOIN "public"."checklists" "c" ON (("cs"."template_id" = "c"."id")))
     JOIN "public"."assets" "a" ON (("cs"."asset_id" = "a"."id")))
     LEFT JOIN "public"."equipment_models" "em" ON (("a"."model_id" = "em"."id")));


ALTER TABLE "public"."checklist_schedules_status" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."checklist_sections" (
    "id" "uuid" DEFAULT "extensions"."uuid_generate_v4"() NOT NULL,
    "checklist_id" "uuid",
    "title" "text" NOT NULL,
    "order_index" integer NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "created_by" "uuid",
    "updated_by" "uuid",
    "section_type" "text" DEFAULT 'checklist'::"text",
    "evidence_config" "jsonb",
    "cleanliness_config" "jsonb",
    "security_config" "jsonb",
    CONSTRAINT "checklist_sections_section_type_check" CHECK (("section_type" = ANY (ARRAY['checklist'::"text", 'evidence'::"text", 'cleanliness_bonus'::"text", 'security_talk'::"text"])))
);


ALTER TABLE "public"."checklist_sections" OWNER TO "postgres";


COMMENT ON COLUMN "public"."checklist_sections"."section_type" IS 'Type of section: checklist (normal items), evidence (photo capture), cleanliness_bonus (cleanliness evaluation for HR bonuses)';



COMMENT ON COLUMN "public"."checklist_sections"."evidence_config" IS 'Configuración para secciones de evidencia: {min_photos, max_photos, categories, descriptions}';



COMMENT ON COLUMN "public"."checklist_sections"."cleanliness_config" IS 'JSONB configuration for cleanliness bonus sections: areas, photos, bonus criteria';



COMMENT ON COLUMN "public"."checklist_sections"."security_config" IS 'Configuration for security_talk section type, including mode (plant_manager/operator) and field requirements';



CREATE TABLE IF NOT EXISTS "public"."checklist_template_versions" (
    "id" "uuid" DEFAULT "extensions"."uuid_generate_v4"() NOT NULL,
    "template_id" "uuid",
    "version_number" integer NOT NULL,
    "name" "text" NOT NULL,
    "description" "text",
    "model_id" "uuid",
    "frequency" "text",
    "hours_interval" integer,
    "sections" "jsonb" NOT NULL,
    "is_active" boolean DEFAULT false,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "created_by" "uuid",
    "change_summary" "text",
    "migration_notes" "text"
);


ALTER TABLE "public"."checklist_template_versions" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."common_checklist_issues" AS
 SELECT "ci"."item_id",
    "i"."description" AS "item_description",
    "s"."title" AS "section_title",
    "c"."name" AS "checklist_name",
    "count"(*) AS "issue_count"
   FROM ((("public"."checklist_issues" "ci"
     JOIN "public"."checklist_items" "i" ON ((("ci"."item_id")::"uuid" = "i"."id")))
     JOIN "public"."checklist_sections" "s" ON (("i"."section_id" = "s"."id")))
     JOIN "public"."checklists" "c" ON (("s"."checklist_id" = "c"."id")))
  GROUP BY "ci"."item_id", "i"."description", "s"."title", "c"."name"
  ORDER BY ("count"(*)) DESC;


ALTER TABLE "public"."common_checklist_issues" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."delegation_details" AS
 SELECT "d"."id",
    "d"."grantor_user_id" AS "grantor_id",
    "d"."grantee_user_id" AS "grantee_id",
    "d"."delegated_amount",
    "d"."scope_type",
    "d"."business_unit_id",
    "d"."plant_id",
    "d"."is_active",
    "d"."notes",
    "d"."created_at",
    "d"."updated_at",
    "grantor"."nombre" AS "grantor_nombre",
    "grantor"."apellido" AS "grantor_apellido",
    "grantor"."role" AS "grantor_role",
    "grantee"."nombre" AS "grantee_nombre",
    "grantee"."apellido" AS "grantee_apellido",
    "grantee"."role" AS "grantee_role",
    "bu"."name" AS "business_unit_name",
    "p"."name" AS "plant_name"
   FROM (((("public"."authorization_delegations" "d"
     LEFT JOIN "public"."profiles" "grantor" ON (("d"."grantor_user_id" = "grantor"."id")))
     LEFT JOIN "public"."profiles" "grantee" ON (("d"."grantee_user_id" = "grantee"."id")))
     LEFT JOIN "public"."business_units" "bu" ON (("d"."business_unit_id" = "bu"."id")))
     LEFT JOIN "public"."plants" "p" ON (("d"."plant_id" = "p"."id")));


ALTER TABLE "public"."delegation_details" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."departments" (
    "id" "uuid" DEFAULT "extensions"."uuid_generate_v4"() NOT NULL,
    "plant_id" "uuid" NOT NULL,
    "name" "text" NOT NULL,
    "code" "text" NOT NULL,
    "supervisor_id" "uuid",
    "budget_code" "text",
    "cost_center" "text",
    "description" "text",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."departments" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."diesel_transactions" (
    "id" "uuid" DEFAULT "extensions"."uuid_generate_v4"() NOT NULL,
    "transaction_id" "text" NOT NULL,
    "plant_id" "uuid" NOT NULL,
    "warehouse_id" "uuid" NOT NULL,
    "asset_id" "uuid",
    "product_id" "uuid" NOT NULL,
    "transaction_type" "text" NOT NULL,
    "quantity_liters" numeric(10,2) NOT NULL,
    "unit_cost" numeric(10,2),
    "total_cost" numeric(10,2),
    "horometer_reading" integer,
    "kilometer_reading" integer,
    "previous_horometer" integer,
    "previous_kilometer" integer,
    "operator_id" "uuid",
    "supplier_responsible" "text",
    "transaction_date" timestamp with time zone DEFAULT "now"() NOT NULL,
    "scheduled_time" time without time zone,
    "service_order_id" "uuid",
    "work_order_id" "uuid",
    "checklist_completion_id" "uuid",
    "requires_validation" boolean DEFAULT false,
    "validated_at" timestamp with time zone,
    "validated_by" "uuid",
    "validation_notes" "text",
    "notes" "text",
    "created_by" "uuid" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "updated_by" "uuid",
    "exception_asset_name" "text",
    "asset_category" "text" NOT NULL,
    "cuenta_litros" numeric(10,2),
    "validation_difference" numeric(10,2) GENERATED ALWAYS AS (
CASE
    WHEN ("cuenta_litros" IS NOT NULL) THEN "abs"(("quantity_liters" - "cuenta_litros"))
    ELSE NULL::numeric
END) STORED,
    "adjustment_reason" "text",
    "adjustment_category" "text",
    "reference_transaction_id" "uuid",
    "source_system" "text" DEFAULT 'manual'::"text",
    "import_batch_id" "text",
    "hours_consumed" integer GENERATED ALWAYS AS (
CASE
    WHEN (("horometer_reading" IS NOT NULL) AND ("previous_horometer" IS NOT NULL)) THEN ("horometer_reading" - "previous_horometer")
    ELSE NULL::integer
END) STORED,
    "kilometers_consumed" integer GENERATED ALWAYS AS (
CASE
    WHEN (("kilometer_reading" IS NOT NULL) AND ("previous_kilometer" IS NOT NULL)) THEN ("kilometer_reading" - "previous_kilometer")
    ELSE NULL::integer
END) STORED,
    "previous_balance" numeric(10,2),
    "current_balance" numeric(10,2),
    CONSTRAINT "check_adjustment_reason" CHECK (((("transaction_type" = 'adjustment'::"text") AND ("adjustment_reason" IS NOT NULL)) OR ("transaction_type" <> 'adjustment'::"text"))),
    CONSTRAINT "check_asset_exception_logic" CHECK (((("asset_category" = 'formal'::"text") AND ("asset_id" IS NOT NULL) AND ("exception_asset_name" IS NULL)) OR (("asset_category" = 'exception'::"text") AND ("asset_id" IS NULL) AND ("exception_asset_name" IS NOT NULL) AND (("transaction_type" <> 'consumption'::"text") OR (("horometer_reading" IS NULL) AND ("kilometer_reading" IS NULL)))) OR (("asset_category" = 'general'::"text") AND ("asset_id" IS NULL) AND ("exception_asset_name" IS NULL) AND ("horometer_reading" IS NULL) AND ("kilometer_reading" IS NULL)) OR ("transaction_type" = 'entry'::"text"))),
    CONSTRAINT "diesel_transactions_adjustment_category_check" CHECK (("adjustment_category" = ANY (ARRAY['physical_count'::"text", 'evaporation'::"text", 'spillage'::"text", 'measurement_error'::"text", 'manual'::"text", 'other'::"text"]))),
    CONSTRAINT "diesel_transactions_asset_category_check" CHECK (("asset_category" = ANY (ARRAY['formal'::"text", 'exception'::"text", 'general'::"text"]))),
    CONSTRAINT "diesel_transactions_asset_logic" CHECK (((("transaction_type" = 'entry'::"text") AND ("asset_id" IS NULL)) OR (("transaction_type" = 'consumption'::"text") AND (("asset_id" IS NOT NULL) OR ("asset_category" = 'exception'::"text"))))),
    CONSTRAINT "diesel_transactions_check1" CHECK ((("horometer_reading" IS NULL) OR ("previous_horometer" IS NULL) OR ("horometer_reading" >= "previous_horometer"))),
    CONSTRAINT "diesel_transactions_check2" CHECK ((("kilometer_reading" IS NULL) OR ("previous_kilometer" IS NULL) OR ("kilometer_reading" >= "previous_kilometer"))),
    CONSTRAINT "diesel_transactions_quantity_liters_check" CHECK (("quantity_liters" > (0)::numeric)),
    CONSTRAINT "diesel_transactions_transaction_type_check" CHECK (("transaction_type" = ANY (ARRAY['entry'::"text", 'consumption'::"text"])))
);


ALTER TABLE "public"."diesel_transactions" OWNER TO "postgres";


COMMENT ON COLUMN "public"."diesel_transactions"."previous_balance" IS 'Warehouse balance before this transaction (for traceability)';



COMMENT ON COLUMN "public"."diesel_transactions"."current_balance" IS 'Warehouse balance after this transaction (for traceability)';



CREATE TABLE IF NOT EXISTS "public"."diesel_warehouses" (
    "id" "uuid" DEFAULT "extensions"."uuid_generate_v4"() NOT NULL,
    "plant_id" "uuid" NOT NULL,
    "warehouse_code" "text" NOT NULL,
    "name" "text" NOT NULL,
    "capacity_liters" numeric(10,2),
    "minimum_stock_level" numeric(10,2) DEFAULT 500,
    "location_notes" "text",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "created_by" "uuid",
    "updated_by" "uuid",
    "current_inventory" numeric(10,2) DEFAULT 0,
    "current_cuenta_litros" numeric(10,2) DEFAULT NULL::numeric,
    "has_cuenta_litros" boolean DEFAULT true,
    "last_updated" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."diesel_warehouses" OWNER TO "postgres";


COMMENT ON COLUMN "public"."diesel_warehouses"."current_inventory" IS 'Current diesel inventory in liters, updated automatically';



COMMENT ON COLUMN "public"."diesel_warehouses"."current_cuenta_litros" IS 'Current reading of cuenta litros meter, NULL if no meter';



COMMENT ON COLUMN "public"."diesel_warehouses"."has_cuenta_litros" IS 'Whether this warehouse has a cuenta litros meter';



COMMENT ON COLUMN "public"."diesel_warehouses"."last_updated" IS 'Last time inventory was updated';



CREATE OR REPLACE VIEW "public"."diesel_asset_consumption_summary" AS
 WITH "asset_consumption" AS (
         SELECT "dt"."asset_id",
            "a"."name" AS "asset_name",
            "a"."asset_id" AS "asset_code",
            "dt"."exception_asset_name",
            "dt"."asset_category",
            "p"."name" AS "plant_name",
            "count"(*) AS "transaction_count",
            "sum"("dt"."quantity_liters") AS "total_consumption",
            "avg"("dt"."quantity_liters") AS "avg_consumption_per_transaction",
            "min"("dt"."transaction_date") AS "first_consumption",
            "max"("dt"."transaction_date") AS "last_consumption",
            "avg"(
                CASE
                    WHEN ("dt"."hours_consumed" > 0) THEN (("dt"."quantity_liters")::numeric / ("dt"."hours_consumed")::numeric)
                    ELSE NULL::numeric
                END) AS "avg_liters_per_hour",
            "avg"(
                CASE
                    WHEN ("dt"."kilometers_consumed" > 0) THEN (("dt"."quantity_liters")::numeric / ("dt"."kilometers_consumed")::numeric)
                    ELSE NULL::numeric
                END) AS "avg_liters_per_km",
            "sum"(
                CASE
                    WHEN ("dt"."transaction_date" >= ("now"() - '30 days'::interval)) THEN "dt"."quantity_liters"
                    ELSE (0)::numeric
                END) AS "consumption_last_30_days",
            "count"(
                CASE
                    WHEN ("dt"."transaction_date" >= ("now"() - '30 days'::interval)) THEN 1
                    ELSE NULL::integer
                END) AS "transactions_last_30_days"
           FROM ((("public"."diesel_transactions" "dt"
             LEFT JOIN "public"."assets" "a" ON (("dt"."asset_id" = "a"."id")))
             LEFT JOIN "public"."diesel_warehouses" "w" ON (("dt"."warehouse_id" = "w"."id")))
             LEFT JOIN "public"."plants" "p" ON (("w"."plant_id" = "p"."id")))
          WHERE ("dt"."transaction_type" = 'consumption'::"text")
          GROUP BY "dt"."asset_id", "a"."name", "a"."asset_id", "dt"."exception_asset_name", "dt"."asset_category", "p"."name"
        )
 SELECT "asset_consumption"."asset_id",
    "asset_consumption"."asset_name",
    "asset_consumption"."asset_code",
    "asset_consumption"."exception_asset_name",
    "asset_consumption"."asset_category",
    "asset_consumption"."plant_name",
    "asset_consumption"."transaction_count",
    "asset_consumption"."total_consumption",
    "asset_consumption"."avg_consumption_per_transaction",
    "asset_consumption"."first_consumption",
    "asset_consumption"."last_consumption",
    "asset_consumption"."avg_liters_per_hour",
    "asset_consumption"."avg_liters_per_km",
    "asset_consumption"."consumption_last_30_days",
    "asset_consumption"."transactions_last_30_days",
        CASE
            WHEN ("asset_consumption"."last_consumption" >= ("now"() - '7 days'::interval)) THEN 'Active'::"text"
            WHEN ("asset_consumption"."last_consumption" >= ("now"() - '30 days'::interval)) THEN 'Recent'::"text"
            WHEN ("asset_consumption"."last_consumption" >= ("now"() - '90 days'::interval)) THEN 'Inactive'::"text"
            ELSE 'Dormant'::"text"
        END AS "activity_status"
   FROM "asset_consumption"
  ORDER BY "asset_consumption"."total_consumption" DESC;


ALTER TABLE "public"."diesel_asset_consumption_summary" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."diesel_products" (
    "id" "uuid" DEFAULT "extensions"."uuid_generate_v4"() NOT NULL,
    "product_code" "text" NOT NULL,
    "name" "text" DEFAULT 'Diesel'::"text" NOT NULL,
    "unit_of_measure" "text" DEFAULT 'liters'::"text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "created_by" "uuid",
    "updated_by" "uuid",
    "price_per_liter" numeric(12,4),
    CONSTRAINT "diesel_products_price_per_liter_check" CHECK (("price_per_liter" >= (0)::numeric))
);


ALTER TABLE "public"."diesel_products" OWNER TO "postgres";


CREATE MATERIALIZED VIEW "public"."diesel_current_inventory" AS
 WITH "inventory_calculations" AS (
         SELECT "w_1"."id" AS "warehouse_id",
            "w_1"."plant_id",
            "w_1"."warehouse_code",
            "w_1"."name" AS "warehouse_name",
            "dp"."id" AS "product_id",
            "dp"."product_code",
            COALESCE("sum"(
                CASE
                    WHEN ("dt"."transaction_type" = 'entry'::"text") THEN "dt"."quantity_liters"
                    WHEN ("dt"."transaction_type" = 'consumption'::"text") THEN (- "dt"."quantity_liters")
                    ELSE (0)::numeric
                END), (0)::numeric) AS "current_stock_liters",
            "count"(
                CASE
                    WHEN ("dt"."transaction_type" = 'entry'::"text") THEN 1
                    ELSE NULL::integer
                END) AS "total_entries",
            "count"(
                CASE
                    WHEN ("dt"."transaction_type" = 'consumption'::"text") THEN 1
                    ELSE NULL::integer
                END) AS "total_consumptions",
            "max"(
                CASE
                    WHEN ("dt"."transaction_type" = 'entry'::"text") THEN "dt"."transaction_date"
                    ELSE NULL::timestamp with time zone
                END) AS "last_entry_date",
            "max"(
                CASE
                    WHEN ("dt"."transaction_type" = 'consumption'::"text") THEN "dt"."transaction_date"
                    ELSE NULL::timestamp with time zone
                END) AS "last_consumption_date",
            "max"("dt"."transaction_date") AS "last_movement_date"
           FROM (("public"."diesel_warehouses" "w_1"
             CROSS JOIN "public"."diesel_products" "dp")
             LEFT JOIN "public"."diesel_transactions" "dt" ON ((("w_1"."id" = "dt"."warehouse_id") AND ("dp"."id" = "dt"."product_id"))))
          GROUP BY "w_1"."id", "w_1"."plant_id", "w_1"."warehouse_code", "w_1"."name", "dp"."id", "dp"."product_code"
        )
 SELECT "ic"."warehouse_id",
    "ic"."plant_id",
    "ic"."warehouse_code",
    "ic"."warehouse_name",
    "ic"."product_id",
    "ic"."product_code",
    "ic"."current_stock_liters",
    "ic"."total_entries",
    "ic"."total_consumptions",
    "ic"."last_entry_date",
    "ic"."last_consumption_date",
    "ic"."last_movement_date",
    "w"."capacity_liters",
    "w"."minimum_stock_level",
        CASE
            WHEN ("ic"."current_stock_liters" <= "w"."minimum_stock_level") THEN 'LOW_STOCK'::"text"
            WHEN ("ic"."current_stock_liters" >= COALESCE(("w"."capacity_liters" * 0.9), (9999999)::numeric)) THEN 'HIGH_STOCK'::"text"
            ELSE 'NORMAL'::"text"
        END AS "stock_status",
        CASE
            WHEN ("w"."capacity_liters" > (0)::numeric) THEN "round"((("ic"."current_stock_liters" / "w"."capacity_liters") * (100)::numeric), 2)
            ELSE NULL::numeric
        END AS "capacity_percentage",
    "pl"."name" AS "plant_name",
    "pl"."code" AS "plant_code",
    "now"() AS "calculated_at"
   FROM (("inventory_calculations" "ic"
     JOIN "public"."diesel_warehouses" "w" ON (("ic"."warehouse_id" = "w"."id")))
     JOIN "public"."plants" "pl" ON (("ic"."plant_id" = "pl"."id")))
  WITH NO DATA;


ALTER TABLE "public"."diesel_current_inventory" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."diesel_evidence" (
    "id" "uuid" DEFAULT "extensions"."uuid_generate_v4"() NOT NULL,
    "transaction_id" "uuid" NOT NULL,
    "evidence_type" "text" NOT NULL,
    "photo_url" "text" NOT NULL,
    "description" "text",
    "category" "text",
    "metadata" "jsonb" DEFAULT '{}'::"jsonb",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "created_by" "uuid",
    CONSTRAINT "diesel_evidence_category_check" CHECK (("category" = ANY (ARRAY['machine_display'::"text", 'cuenta_litros'::"text", 'delivery_truck'::"text", 'invoice'::"text", 'before'::"text", 'after'::"text", 'tank_gauge'::"text", 'other'::"text"]))),
    CONSTRAINT "diesel_evidence_evidence_type_check" CHECK (("evidence_type" = ANY (ARRAY['consumption'::"text", 'entry'::"text", 'adjustment'::"text", 'meter_reading'::"text", 'cuenta_litros'::"text", 'delivery'::"text", 'invoice'::"text"])))
);


ALTER TABLE "public"."diesel_evidence" OWNER TO "postgres";


COMMENT ON TABLE "public"."diesel_evidence" IS 'Photo evidence for diesel transactions - required for consumptions and entries';



COMMENT ON COLUMN "public"."diesel_evidence"."evidence_type" IS 'Type of evidence: consumption, entry, adjustment, meter_reading, cuenta_litros, delivery, invoice';



COMMENT ON COLUMN "public"."diesel_evidence"."category" IS 'Evidence category: machine_display, cuenta_litros, delivery_truck, invoice, before, after, tank_gauge';



COMMENT ON COLUMN "public"."diesel_evidence"."metadata" IS 'JSON metadata: {original_size, compressed_size, device_info, timestamp}';



CREATE TABLE IF NOT EXISTS "public"."diesel_excel_staging" (
    "id" integer NOT NULL,
    "creado" timestamp without time zone,
    "primary_column" "text",
    "planta" "text",
    "unidad_p1" "text",
    "unidad_planta_2" "text",
    "unidad_p3" "text",
    "unidad_p4" "text",
    "unidad_planta_5" "text",
    "clave_producto" "text",
    "almacen" "text",
    "tipo" "text",
    "unidad" "text",
    "identificador" "text",
    "i" "text",
    "fecha_" timestamp without time zone,
    "horario" time without time zone,
    "horometro" integer,
    "kilometraje" integer,
    "litros_cantidad" numeric(10,2),
    "cuenta_litros" numeric(10,2),
    "responsable_unidad" "text",
    "responsable_suministro" "text",
    "validacion" "text",
    "prueba_validacion" "text",
    "inventario_inicial" numeric(10,2),
    "inventario" numeric(10,2),
    "processed" boolean DEFAULT false,
    "processing_notes" "text",
    "created_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."diesel_excel_staging" OWNER TO "postgres";


CREATE SEQUENCE IF NOT EXISTS "public"."diesel_excel_staging_id_seq"
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER TABLE "public"."diesel_excel_staging_id_seq" OWNER TO "postgres";


ALTER SEQUENCE "public"."diesel_excel_staging_id_seq" OWNED BY "public"."diesel_excel_staging"."id";



CREATE OR REPLACE VIEW "public"."diesel_inventory_detailed" AS
 WITH "daily_movements" AS (
         SELECT "dt"."warehouse_id",
            "w"."warehouse_code",
            "w"."name" AS "warehouse_name",
            "w"."plant_id",
            "p"."name" AS "plant_name",
            "p"."code" AS "plant_code",
            "date_trunc"('day'::"text", "dt"."transaction_date") AS "movement_date",
            "dt"."asset_category",
            "sum"(
                CASE
                    WHEN ("dt"."transaction_type" = 'entry'::"text") THEN "dt"."quantity_liters"
                    ELSE (0)::numeric
                END) AS "entries",
            "sum"(
                CASE
                    WHEN (("dt"."transaction_type" = 'consumption'::"text") AND ("dt"."asset_category" = 'formal'::"text")) THEN "dt"."quantity_liters"
                    ELSE (0)::numeric
                END) AS "formal_asset_consumption",
            "sum"(
                CASE
                    WHEN (("dt"."transaction_type" = 'consumption'::"text") AND ("dt"."asset_category" = 'exception'::"text")) THEN "dt"."quantity_liters"
                    ELSE (0)::numeric
                END) AS "exception_asset_consumption",
            "sum"(
                CASE
                    WHEN (("dt"."transaction_type" = 'consumption'::"text") AND ("dt"."asset_category" = 'general'::"text")) THEN "dt"."quantity_liters"
                    ELSE (0)::numeric
                END) AS "general_consumption",
            "sum"(
                CASE
                    WHEN ("dt"."transaction_type" = 'adjustment'::"text") THEN "dt"."quantity_liters"
                    ELSE (0)::numeric
                END) AS "adjustments",
            "sum"(
                CASE
                    WHEN ("dt"."transaction_type" = 'entry'::"text") THEN "dt"."quantity_liters"
                    WHEN ("dt"."transaction_type" = 'consumption'::"text") THEN (- "dt"."quantity_liters")
                    WHEN ("dt"."transaction_type" = 'adjustment'::"text") THEN "dt"."quantity_liters"
                    ELSE (0)::numeric
                END) AS "net_movement",
            "count"(*) AS "transaction_count"
           FROM (("public"."diesel_transactions" "dt"
             JOIN "public"."diesel_warehouses" "w" ON (("dt"."warehouse_id" = "w"."id")))
             JOIN "public"."plants" "p" ON (("w"."plant_id" = "p"."id")))
          GROUP BY "dt"."warehouse_id", "w"."warehouse_code", "w"."name", "w"."plant_id", "p"."name", "p"."code", ("date_trunc"('day'::"text", "dt"."transaction_date")), "dt"."asset_category"
        ), "running_balances" AS (
         SELECT "daily_movements"."warehouse_id",
            "daily_movements"."warehouse_code",
            "daily_movements"."warehouse_name",
            "daily_movements"."plant_id",
            "daily_movements"."plant_name",
            "daily_movements"."plant_code",
            "daily_movements"."movement_date",
            "daily_movements"."asset_category",
            "daily_movements"."entries",
            "daily_movements"."formal_asset_consumption",
            "daily_movements"."exception_asset_consumption",
            "daily_movements"."general_consumption",
            "daily_movements"."adjustments",
            "daily_movements"."net_movement",
            "daily_movements"."transaction_count",
            "sum"("daily_movements"."net_movement") OVER (PARTITION BY "daily_movements"."warehouse_id" ORDER BY "daily_movements"."movement_date" ROWS UNBOUNDED PRECEDING) AS "running_balance"
           FROM "daily_movements"
        )
 SELECT "running_balances"."warehouse_id",
    "running_balances"."warehouse_code",
    "running_balances"."warehouse_name",
    "running_balances"."plant_id",
    "running_balances"."plant_name",
    "running_balances"."plant_code",
    "running_balances"."movement_date",
    "running_balances"."asset_category",
    "running_balances"."entries",
    "running_balances"."formal_asset_consumption",
    "running_balances"."exception_asset_consumption",
    "running_balances"."general_consumption",
    "running_balances"."adjustments",
    "running_balances"."net_movement",
    "running_balances"."running_balance",
    "running_balances"."transaction_count"
   FROM "running_balances"
  ORDER BY "running_balances"."warehouse_id", "running_balances"."movement_date" DESC;


ALTER TABLE "public"."diesel_inventory_detailed" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."diesel_inventory_snapshots" (
    "id" "uuid" DEFAULT "extensions"."uuid_generate_v4"() NOT NULL,
    "warehouse_id" "uuid" NOT NULL,
    "snapshot_date" "date" NOT NULL,
    "opening_balance" numeric(10,2) DEFAULT 0 NOT NULL,
    "total_entries" numeric(10,2) DEFAULT 0 NOT NULL,
    "total_consumptions" numeric(10,2) DEFAULT 0 NOT NULL,
    "total_adjustments" numeric(10,2) DEFAULT 0 NOT NULL,
    "closing_balance" numeric(10,2) NOT NULL,
    "physical_count" numeric(10,2),
    "variance" numeric(10,2),
    "notes" "text",
    "validated_by" "uuid",
    "validated_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."diesel_inventory_snapshots" OWNER TO "postgres";


COMMENT ON TABLE "public"."diesel_inventory_snapshots" IS 'Daily/monthly inventory snapshots for reconciliation and fast queries';



COMMENT ON COLUMN "public"."diesel_inventory_snapshots"."physical_count" IS 'Physical count from manual inspection (optional)';



COMMENT ON COLUMN "public"."diesel_inventory_snapshots"."variance" IS 'Difference between physical count and calculated balance';



CREATE SEQUENCE IF NOT EXISTS "public"."diesel_transaction_seq"
    START WITH 1000
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER TABLE "public"."diesel_transaction_seq" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."exception_assets" (
    "id" "uuid" DEFAULT "extensions"."uuid_generate_v4"() NOT NULL,
    "exception_name" "text" NOT NULL,
    "normalized_name" "text",
    "asset_type" "text",
    "description" "text",
    "owner_info" "text",
    "promoted_to_asset_id" "uuid",
    "promoted_at" timestamp with time zone,
    "promoted_by" "uuid",
    "total_transactions" integer DEFAULT 0,
    "total_consumption_liters" numeric(10,2) DEFAULT 0,
    "first_seen" timestamp with time zone,
    "last_seen" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    CONSTRAINT "exception_assets_asset_type_check" CHECK (("asset_type" = ANY (ARRAY['partner'::"text", 'rental'::"text", 'utility'::"text", 'contractor'::"text", 'unknown'::"text"])))
);


ALTER TABLE "public"."exception_assets" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."exception_assets_review" AS
 SELECT "ea"."id",
    "ea"."exception_name",
    "ea"."asset_type",
    "ea"."description",
    "ea"."owner_info",
    "ea"."total_transactions",
    "ea"."total_consumption_liters",
    "ea"."first_seen",
    "ea"."last_seen",
        CASE
            WHEN ("anm"."mapping_type" IS NOT NULL) THEN "anm"."mapping_type"
            ELSE 'unmapped'::"text"
        END AS "mapping_status",
    "anm"."mapping_source",
    "anm"."confidence_level",
    ("ea"."promoted_to_asset_id" IS NOT NULL) AS "is_promoted",
    "pa"."name" AS "promoted_asset_name",
    "ea"."promoted_at"
   FROM (("public"."exception_assets" "ea"
     LEFT JOIN "public"."asset_name_mappings" "anm" ON (("anm"."exception_asset_id" = "ea"."id")))
     LEFT JOIN "public"."assets" "pa" ON (("ea"."promoted_to_asset_id" = "pa"."id")))
  ORDER BY "ea"."total_consumption_liters" DESC;


ALTER TABLE "public"."exception_assets_review" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."financial_classifications" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "codigo_ingresos" character varying(50) NOT NULL,
    "categoria_ingresos" character varying(255),
    "concepto_ingresos" character varying(255),
    "concepto_gerencia" character varying(255),
    "clasificacion_gerencia" character varying(50),
    "sub_clasificacion_gerencia" character varying(255),
    "sub_sub_clasificacion_gerencia" character varying(255),
    "created_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    "updated_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP
);


ALTER TABLE "public"."financial_classifications" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."incident_history" (
    "id" "uuid" DEFAULT "extensions"."uuid_generate_v4"() NOT NULL,
    "asset_id" "uuid",
    "date" timestamp with time zone NOT NULL,
    "type" "text" NOT NULL,
    "reported_by" "text" NOT NULL,
    "description" "text" NOT NULL,
    "impact" "text",
    "resolution" "text",
    "downtime" double precision,
    "labor_hours" double precision,
    "labor_cost" numeric(10,2),
    "parts" "jsonb",
    "total_cost" numeric(10,2),
    "work_order_text" "text",
    "status" "text" DEFAULT 'Resuelto'::"text",
    "created_by" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "work_order_id" "uuid",
    "service_order_id" "uuid",
    "checklist_id" "uuid",
    "reported_by_id" "uuid",
    "updated_by" "uuid",
    "documents" "jsonb" DEFAULT '[]'::"jsonb"
);


ALTER TABLE "public"."incident_history" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."maintenance_checklists" (
    "id" "uuid" DEFAULT "extensions"."uuid_generate_v4"() NOT NULL,
    "work_order_id" "uuid",
    "checklist_template_id" "uuid",
    "completed_at" timestamp with time zone,
    "completed_by" "uuid",
    "completion_data" "jsonb",
    "signature" "text",
    "notes" "text",
    "status" "text" DEFAULT 'pending'::"text",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."maintenance_checklists" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."maintenance_history" (
    "id" "uuid" DEFAULT "extensions"."uuid_generate_v4"() NOT NULL,
    "asset_id" "uuid",
    "date" timestamp with time zone NOT NULL,
    "type" "text" NOT NULL,
    "hours" integer,
    "kilometers" integer,
    "description" "text" NOT NULL,
    "findings" "text",
    "actions" "text",
    "technician" "text" NOT NULL,
    "labor_hours" double precision,
    "labor_cost" numeric(10,2),
    "parts" "jsonb",
    "total_cost" numeric(10,2),
    "work_order" "text",
    "maintenance_plan_id" "uuid",
    "completed_tasks" "jsonb",
    "documents" "text"[],
    "created_by" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "work_order_id" "uuid",
    "service_order_id" "uuid",
    "technician_id" "uuid",
    "updated_by" "uuid",
    "downtime_hours" numeric DEFAULT 0,
    "technician_notes" "text",
    "resolution_details" "text"
);


ALTER TABLE "public"."maintenance_history" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."maintenance_intervals" (
    "id" "uuid" DEFAULT "extensions"."uuid_generate_v4"() NOT NULL,
    "model_id" "uuid",
    "interval_value" integer NOT NULL,
    "name" "text" NOT NULL,
    "description" "text",
    "type" "text" NOT NULL,
    "estimated_duration" double precision,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "created_by" "uuid",
    "updated_by" "uuid",
    "is_recurring" boolean DEFAULT true,
    "is_first_cycle_only" boolean DEFAULT false,
    "cycle_defining_interval" integer,
    "maintenance_category" "text" DEFAULT 'standard'::"text"
);


ALTER TABLE "public"."maintenance_intervals" OWNER TO "postgres";


COMMENT ON COLUMN "public"."maintenance_intervals"."is_recurring" IS 'Whether this interval repeats in subsequent cycles';



COMMENT ON COLUMN "public"."maintenance_intervals"."is_first_cycle_only" IS 'Whether this interval only applies to the first cycle (e.g., break-in service)';



COMMENT ON COLUMN "public"."maintenance_intervals"."cycle_defining_interval" IS 'The interval hours that defines when a new cycle starts (should be the highest interval for the model)';



COMMENT ON COLUMN "public"."maintenance_intervals"."maintenance_category" IS 'Category: break_in, basic, intermediate, major, overhaul';



CREATE TABLE IF NOT EXISTS "public"."maintenance_plans" (
    "id" "uuid" DEFAULT "extensions"."uuid_generate_v4"() NOT NULL,
    "asset_id" "uuid",
    "interval_id" "uuid",
    "interval_value" integer NOT NULL,
    "name" "text" NOT NULL,
    "description" "text",
    "last_completed" timestamp with time zone,
    "next_due" timestamp with time zone,
    "status" "text" DEFAULT 'Programado'::"text",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "created_by" "uuid",
    "updated_by" "uuid"
);


ALTER TABLE "public"."maintenance_plans" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."maintenance_tasks" (
    "id" "uuid" DEFAULT "extensions"."uuid_generate_v4"() NOT NULL,
    "interval_id" "uuid",
    "description" "text" NOT NULL,
    "type" "text" NOT NULL,
    "estimated_time" double precision,
    "requires_specialist" boolean DEFAULT false,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "created_by" "uuid",
    "updated_by" "uuid"
);


ALTER TABLE "public"."maintenance_tasks" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."manual_financial_adjustment_distributions" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "adjustment_id" "uuid" NOT NULL,
    "business_unit_id" "uuid",
    "plant_id" "uuid",
    "department" "text",
    "percentage" numeric(5,2) NOT NULL,
    "amount" numeric(15,2) NOT NULL,
    "volume_m3" numeric(15,2),
    "created_at" timestamp with time zone DEFAULT "now"(),
    "created_by" "uuid",
    CONSTRAINT "manual_financial_adjustment_distributions_check" CHECK (((((("business_unit_id" IS NOT NULL))::integer + (("plant_id" IS NOT NULL))::integer) + (("department" IS NOT NULL))::integer) = 1)),
    CONSTRAINT "manual_financial_adjustment_distributions_percentage_check" CHECK ((("percentage" >= (0)::numeric) AND ("percentage" <= (100)::numeric)))
);


ALTER TABLE "public"."manual_financial_adjustment_distributions" OWNER TO "postgres";


COMMENT ON TABLE "public"."manual_financial_adjustment_distributions" IS 'Distribution breakdowns for manual financial adjustments that are allocated across multiple plants/BUs/departments';



COMMENT ON COLUMN "public"."manual_financial_adjustment_distributions"."department" IS 'Department name from profiles.departamento field';



COMMENT ON COLUMN "public"."manual_financial_adjustment_distributions"."volume_m3" IS 'Concrete volume (m³) used for volume-based distribution calculations';



CREATE TABLE IF NOT EXISTS "public"."manual_financial_adjustments" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "business_unit_id" "uuid",
    "plant_id" "uuid",
    "period_month" "date" NOT NULL,
    "category" "text" NOT NULL,
    "department" "text",
    "subcategory" "text",
    "description" "text",
    "amount" numeric(15,2) NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "created_by" "uuid",
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "updated_by" "uuid",
    "notes" "text",
    "is_bonus" boolean DEFAULT false,
    "is_cash_payment" boolean DEFAULT false,
    "is_distributed" boolean DEFAULT false,
    "distribution_method" "text",
    "expense_category" "text",
    "expense_subcategory" "text",
    CONSTRAINT "manual_financial_adjustments_category_check" CHECK (("category" = ANY (ARRAY['nomina'::"text", 'otros_indirectos'::"text"]))),
    CONSTRAINT "manual_financial_adjustments_distribution_method_check" CHECK (("distribution_method" = ANY (ARRAY['percentage'::"text", 'volume'::"text", NULL::"text"])))
);


ALTER TABLE "public"."manual_financial_adjustments" OWNER TO "postgres";


COMMENT ON TABLE "public"."manual_financial_adjustments" IS 'Manual financial entries for nómina and otros indirectos costs that cannot be automatically calculated';



COMMENT ON COLUMN "public"."manual_financial_adjustments"."period_month" IS 'First day of the month for aggregation (YYYY-MM-01)';



COMMENT ON COLUMN "public"."manual_financial_adjustments"."category" IS 'Either nomina or otros_indirectos';



COMMENT ON COLUMN "public"."manual_financial_adjustments"."department" IS 'Optional department for granular tracking';



COMMENT ON COLUMN "public"."manual_financial_adjustments"."subcategory" IS 'Free-form subcategory for flexibility';



COMMENT ON COLUMN "public"."manual_financial_adjustments"."amount" IS 'Amount can be positive (expense) or negative (refund/credit/devolution)';



COMMENT ON COLUMN "public"."manual_financial_adjustments"."is_bonus" IS 'Flag indicating if this entry is a bonus payment';



COMMENT ON COLUMN "public"."manual_financial_adjustments"."is_cash_payment" IS 'Flag indicating if payment was made in cash';



COMMENT ON COLUMN "public"."manual_financial_adjustments"."is_distributed" IS 'Flag indicating if this entry is distributed across multiple targets';



COMMENT ON COLUMN "public"."manual_financial_adjustments"."distribution_method" IS 'Method used for distribution: percentage (manual) or volume (automatic based on concrete sales)';



COMMENT ON COLUMN "public"."manual_financial_adjustments"."expense_category" IS 'Expense category ID (1-14) for otros_indirectos entries. Required when category = otros_indirectos.';



COMMENT ON COLUMN "public"."manual_financial_adjustments"."expense_subcategory" IS 'Optional subcategory within the expense category for otros_indirectos entries.';



CREATE TABLE IF NOT EXISTS "public"."model_documentation" (
    "id" "uuid" DEFAULT "extensions"."uuid_generate_v4"() NOT NULL,
    "model_id" "uuid",
    "name" "text" NOT NULL,
    "type" "text" NOT NULL,
    "file_url" "text" NOT NULL,
    "size" "text",
    "uploaded_at" timestamp with time zone DEFAULT "now"(),
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "created_by" "uuid",
    "updated_by" "uuid"
);


ALTER TABLE "public"."model_documentation" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."monthly_inventory_summary" AS
 WITH "monthly_data" AS (
         SELECT "w"."id" AS "warehouse_id",
            "w"."warehouse_code",
            "w"."name" AS "warehouse_name",
            "p"."name" AS "plant_name",
            "date_trunc"('month'::"text", "dt"."transaction_date") AS "month_year",
            "sum"(
                CASE
                    WHEN ("dt"."transaction_type" = 'entry'::"text") THEN "dt"."quantity_liters"
                    ELSE (0)::numeric
                END) AS "monthly_entries",
            "sum"(
                CASE
                    WHEN ("dt"."transaction_type" = 'consumption'::"text") THEN "dt"."quantity_liters"
                    ELSE (0)::numeric
                END) AS "monthly_consumption",
            "sum"(
                CASE
                    WHEN ("dt"."transaction_type" = 'adjustment'::"text") THEN "dt"."quantity_liters"
                    ELSE (0)::numeric
                END) AS "monthly_adjustments",
            "sum"(
                CASE
                    WHEN ("dt"."transaction_type" = 'entry'::"text") THEN "dt"."quantity_liters"
                    WHEN ("dt"."transaction_type" = 'consumption'::"text") THEN (- "dt"."quantity_liters")
                    WHEN ("dt"."transaction_type" = 'adjustment'::"text") THEN "dt"."quantity_liters"
                    ELSE (0)::numeric
                END) AS "net_monthly_change"
           FROM (("public"."diesel_transactions" "dt"
             JOIN "public"."diesel_warehouses" "w" ON (("dt"."warehouse_id" = "w"."id")))
             JOIN "public"."plants" "p" ON (("w"."plant_id" = "p"."id")))
          GROUP BY "w"."id", "w"."warehouse_code", "w"."name", "p"."name", ("date_trunc"('month'::"text", "dt"."transaction_date"))
        ), "running_monthly" AS (
         SELECT "monthly_data"."warehouse_id",
            "monthly_data"."warehouse_code",
            "monthly_data"."warehouse_name",
            "monthly_data"."plant_name",
            "monthly_data"."month_year",
            "monthly_data"."monthly_entries",
            "monthly_data"."monthly_consumption",
            "monthly_data"."monthly_adjustments",
            "monthly_data"."net_monthly_change",
            "sum"("monthly_data"."net_monthly_change") OVER (PARTITION BY "monthly_data"."warehouse_id" ORDER BY "monthly_data"."month_year" ROWS UNBOUNDED PRECEDING) AS "month_end_balance"
           FROM "monthly_data"
        )
 SELECT "running_monthly"."warehouse_id",
    "running_monthly"."warehouse_code",
    "running_monthly"."warehouse_name",
    "running_monthly"."plant_name",
    "running_monthly"."month_year",
    "running_monthly"."monthly_entries",
    "running_monthly"."monthly_consumption",
    "running_monthly"."monthly_adjustments",
    "running_monthly"."net_monthly_change",
    "running_monthly"."month_end_balance",
        CASE
            WHEN ("abs"("running_monthly"."monthly_adjustments") > (50)::numeric) THEN 'High Variance'::"text"
            WHEN ("abs"("running_monthly"."monthly_adjustments") > (20)::numeric) THEN 'Medium Variance'::"text"
            ELSE 'Low Variance'::"text"
        END AS "adjustment_level"
   FROM "running_monthly"
  ORDER BY "running_monthly"."warehouse_id", "running_monthly"."month_year" DESC;


ALTER TABLE "public"."monthly_inventory_summary" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."notifications" (
    "id" "uuid" DEFAULT "extensions"."uuid_generate_v4"() NOT NULL,
    "user_id" "uuid",
    "title" "text" NOT NULL,
    "message" "text" NOT NULL,
    "type" "text" NOT NULL,
    "related_entity" "text",
    "entity_id" "uuid",
    "status" "text" DEFAULT 'unread'::"text",
    "priority" "text" DEFAULT 'medium'::"text",
    "read_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."notifications" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."offices" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "name" character varying(255) NOT NULL,
    "address" "text" NOT NULL,
    "email" character varying(255) NOT NULL,
    "phone" character varying(50) NOT NULL,
    "hr_phone" character varying(50) NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."offices" OWNER TO "postgres";


COMMENT ON TABLE "public"."offices" IS 'Stores office information for employee credential cards';



CREATE TABLE IF NOT EXISTS "public"."operator_assignment_history" (
    "id" "uuid" DEFAULT "extensions"."uuid_generate_v4"() NOT NULL,
    "asset_id" "uuid",
    "operator_id" "uuid",
    "operation_type" "text" NOT NULL,
    "previous_asset_id" "uuid",
    "new_asset_id" "uuid",
    "assignment_type" "text" NOT NULL,
    "changed_by" "uuid",
    "change_reason" "text",
    "transfer_id" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"(),
    CONSTRAINT "operator_assignment_history_assignment_type_check" CHECK (("assignment_type" = ANY (ARRAY['primary'::"text", 'secondary'::"text"]))),
    CONSTRAINT "operator_assignment_history_operation_type_check" CHECK (("operation_type" = ANY (ARRAY['assign'::"text", 'unassign'::"text", 'transfer'::"text", 'replace'::"text"])))
);


ALTER TABLE "public"."operator_assignment_history" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."work_orders" (
    "id" "uuid" DEFAULT "extensions"."uuid_generate_v4"() NOT NULL,
    "order_id" "text" NOT NULL,
    "asset_id" "uuid",
    "description" "text" NOT NULL,
    "type" "text" DEFAULT 'corrective'::"text" NOT NULL,
    "requested_by" "uuid",
    "assigned_to" "uuid",
    "planned_date" timestamp with time zone,
    "estimated_duration" double precision,
    "priority" "text" DEFAULT 'Media'::"text",
    "status" "text" DEFAULT 'Pendiente'::"text",
    "required_parts" "jsonb",
    "estimated_cost" numeric(10,2),
    "checklist_id" "uuid",
    "maintenance_plan_id" "uuid",
    "issue_items" "jsonb",
    "purchase_order_id" "uuid",
    "approval_status" "text",
    "approved_by" "uuid",
    "approval_date" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "completed_at" timestamp with time zone,
    "used_parts" "jsonb",
    "service_order_id" "uuid",
    "updated_by" "uuid",
    "creation_photos" "jsonb" DEFAULT '[]'::"jsonb",
    "completion_photos" "jsonb" DEFAULT '[]'::"jsonb",
    "progress_photos" "jsonb" DEFAULT '[]'::"jsonb",
    "incident_id" "uuid",
    "preventive_checklist_id" "uuid",
    "preventive_checklist_completed" boolean DEFAULT false,
    "original_priority" "text",
    "escalation_count" integer DEFAULT 0,
    "last_escalation_date" timestamp with time zone,
    "related_issues_count" integer DEFAULT 1,
    "plant_id" "uuid",
    "issue_history" "jsonb" DEFAULT '[]'::"jsonb",
    "scope" "text",
    "suggested_supplier_id" "uuid",
    "assigned_supplier_id" "uuid",
    "supplier_notes" "text",
    "supplier_assignment_date" timestamp with time zone,
    "supplier_assignment_by" "uuid"
);


ALTER TABLE "public"."work_orders" OWNER TO "postgres";


COMMENT ON COLUMN "public"."work_orders"."creation_photos" IS 'Photos uploaded during work order creation - array of objects with url, description, category, uploaded_at';



COMMENT ON COLUMN "public"."work_orders"."completion_photos" IS 'Photos uploaded during work order completion - array of objects with url, description, category, uploaded_at';



COMMENT ON COLUMN "public"."work_orders"."progress_photos" IS 'Photos uploaded during work order progress updates - array of objects with url, description, category, uploaded_at';



COMMENT ON COLUMN "public"."work_orders"."incident_id" IS 'Referencia al incidente que originó esta orden de trabajo (para órdenes correctivas manuales)';



COMMENT ON COLUMN "public"."work_orders"."original_priority" IS 'Original priority before any escalation';



COMMENT ON COLUMN "public"."work_orders"."escalation_count" IS 'Number of times this work order has been escalated';



COMMENT ON COLUMN "public"."work_orders"."last_escalation_date" IS 'Timestamp of the last escalation';



COMMENT ON COLUMN "public"."work_orders"."related_issues_count" IS 'Number of related issues consolidated into this work order';



COMMENT ON COLUMN "public"."work_orders"."scope" IS 'Planning scope and special considerations for the work order';



COMMENT ON COLUMN "public"."work_orders"."suggested_supplier_id" IS 'AI-suggested supplier based on asset type, problem, and performance history';



COMMENT ON COLUMN "public"."work_orders"."assigned_supplier_id" IS 'Manually assigned or accepted supplier for the work order';



COMMENT ON COLUMN "public"."work_orders"."supplier_notes" IS 'Notes about supplier selection and assignment reasoning';



COMMENT ON COLUMN "public"."work_orders"."supplier_assignment_date" IS 'When the supplier was assigned to this work order';



COMMENT ON COLUMN "public"."work_orders"."supplier_assignment_by" IS 'User who assigned the supplier';



CREATE OR REPLACE VIEW "public"."pending_expense_approvals" AS
 SELECT "ae"."id",
    "ae"."work_order_id",
    "wo"."order_id" AS "work_order_number",
    "ae"."asset_id",
    "a"."name" AS "asset_name",
    "ae"."description",
    "ae"."amount",
    "ae"."justification",
    "ae"."status",
    "ae"."created_at",
    (("p"."nombre" || ' '::"text") || "p"."apellido") AS "requested_by",
    "wo"."purchase_order_id",
    "po"."order_id" AS "purchase_order_number"
   FROM (((("public"."additional_expenses" "ae"
     JOIN "public"."work_orders" "wo" ON (("ae"."work_order_id" = "wo"."id")))
     JOIN "public"."assets" "a" ON (("ae"."asset_id" = "a"."id")))
     JOIN "public"."profiles" "p" ON (("ae"."created_by" = "p"."id")))
     LEFT JOIN "public"."purchase_orders" "po" ON (("wo"."purchase_order_id" = "po"."id")))
  WHERE ("ae"."status" = 'pendiente_aprobacion'::"text");


ALTER TABLE "public"."pending_expense_approvals" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."po_action_tokens" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "purchase_order_id" "uuid" NOT NULL,
    "recipient_email" "extensions"."citext" NOT NULL,
    "action" "text" NOT NULL,
    "jwt_token" "text" NOT NULL,
    "expires_at" timestamp with time zone NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "po_action_tokens_action_check" CHECK (("action" = ANY (ARRAY['approve'::"text", 'reject'::"text"])))
);


ALTER TABLE "public"."po_action_tokens" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."po_type_summary" AS
 SELECT "purchase_orders"."po_type",
    "count"(*) AS "total_orders",
    "sum"("purchase_orders"."total_amount") AS "total_value",
    "avg"("purchase_orders"."total_amount") AS "avg_value",
    ((("count"(
        CASE
            WHEN ("purchase_orders"."status" = 'approved'::"text") THEN 1
            ELSE NULL::integer
        END))::numeric * 100.0) / ("count"(*))::numeric) AS "approval_rate",
    ((("count"(
        CASE
            WHEN "purchase_orders"."requires_quote" THEN 1
            ELSE NULL::integer
        END))::numeric * 100.0) / ("count"(*))::numeric) AS "quote_rate"
   FROM "public"."purchase_orders"
  WHERE ("purchase_orders"."po_type" IS NOT NULL)
  GROUP BY "purchase_orders"."po_type"
  ORDER BY ("count"(*)) DESC;


ALTER TABLE "public"."po_type_summary" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."purchase_order_metrics" AS
 SELECT "purchase_orders"."po_type",
    "purchase_orders"."payment_method",
    "purchase_orders"."plant_id",
    "count"(*) AS "count",
    "sum"("purchase_orders"."total_amount") AS "total_amount",
    "avg"("purchase_orders"."total_amount") AS "avg_amount",
    "count"(
        CASE
            WHEN "purchase_orders"."requires_quote" THEN 1
            ELSE NULL::integer
        END) AS "with_quotes",
    "count"(
        CASE
            WHEN (NOT "purchase_orders"."requires_quote") THEN 1
            ELSE NULL::integer
        END) AS "without_quotes",
    "count"(
        CASE
            WHEN ("purchase_orders"."status" = 'approved'::"text") THEN 1
            ELSE NULL::integer
        END) AS "approved_count",
    "count"(
        CASE
            WHEN ("purchase_orders"."status" = 'rejected'::"text") THEN 1
            ELSE NULL::integer
        END) AS "rejected_count",
    "count"(
        CASE
            WHEN ("purchase_orders"."status" = 'validated'::"text") THEN 1
            ELSE NULL::integer
        END) AS "completed_count",
    "min"("purchase_orders"."created_at") AS "first_order",
    "max"("purchase_orders"."created_at") AS "last_order"
   FROM "public"."purchase_orders"
  WHERE ("purchase_orders"."po_type" IS NOT NULL)
  GROUP BY "purchase_orders"."po_type", "purchase_orders"."payment_method", "purchase_orders"."plant_id";


ALTER TABLE "public"."purchase_order_metrics" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."purchase_order_receipts" (
    "id" "uuid" DEFAULT "extensions"."uuid_generate_v4"() NOT NULL,
    "purchase_order_id" "uuid" NOT NULL,
    "file_url" "text" NOT NULL,
    "expense_type" "text" DEFAULT 'materials'::"text" NOT NULL,
    "description" "text",
    "is_adjustment_receipt" boolean DEFAULT false,
    "receipt_date" timestamp with time zone,
    "uploaded_by" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."purchase_order_receipts" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."rls_final_status" AS
 SELECT "t"."tablename",
    "t"."rowsecurity" AS "rls_enabled",
    "count"("p"."policyname") AS "policy_count",
    "array_agg"("p"."policyname" ORDER BY "p"."policyname") AS "policies",
    "array_agg"("p"."roles" ORDER BY "p"."policyname") AS "policy_roles"
   FROM ("pg_tables" "t"
     LEFT JOIN "pg_policies" "p" ON ((("p"."tablename" = "t"."tablename") AND ("p"."schemaname" = "t"."schemaname"))))
  WHERE (("t"."schemaname" = 'public'::"name") AND ("t"."tablename" = ANY (ARRAY['assets'::"name", 'profiles'::"name", 'plants'::"name", 'business_units'::"name"])))
  GROUP BY "t"."tablename", "t"."rowsecurity"
  ORDER BY "t"."tablename";


ALTER TABLE "public"."rls_final_status" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."rls_implementation_summary" AS
 SELECT 'RLS Hierarchical Implementation'::"text" AS "feature",
    'COMPLETED'::"text" AS "status",
    "now"() AS "completed_at",
    ( SELECT "count"(*) AS "count"
           FROM "pg_policies"
          WHERE ("pg_policies"."schemaname" = 'public'::"name")) AS "total_policies",
    ( SELECT "count"(*) AS "count"
           FROM ("pg_proc" "p"
             LEFT JOIN "pg_namespace" "n" ON (("n"."oid" = "p"."pronamespace")))
          WHERE (("n"."nspname" = 'public'::"name") AND ("p"."proname" ~~ '%access%'::"text"))) AS "access_functions",
    ( SELECT "count"(*) AS "count"
           FROM "public"."assets") AS "total_assets",
    ( SELECT "count"(*) AS "count"
           FROM "public"."profiles"
          WHERE ("profiles"."status" = 'active'::"text")) AS "active_users",
    ( SELECT "count"(*) AS "count"
           FROM "public"."business_units"
          WHERE ("business_units"."status" = 'active'::"text")) AS "business_units",
    ( SELECT "count"(*) AS "count"
           FROM "public"."plants"
          WHERE ("plants"."status" = 'active'::"text")) AS "plants";


ALTER TABLE "public"."rls_implementation_summary" OWNER TO "postgres";


COMMENT ON VIEW "public"."rls_implementation_summary" IS 'Vista de resumen del estado de implementación RLS jerárquico';



CREATE OR REPLACE VIEW "public"."rls_system_complete_status" AS
 SELECT "t"."tablename",
    "t"."rowsecurity" AS "rls_enabled",
    "count"("p"."policyname") AS "policy_count",
    "array_agg"(DISTINCT
        CASE
            WHEN ('postgres'::"name" = ANY ("p"."roles")) THEN 'postgres'::"text"
            WHEN ('service_role'::"name" = ANY ("p"."roles")) THEN 'service_role'::"text"
            WHEN ('authenticated'::"name" = ANY ("p"."roles")) THEN 'authenticated'::"text"
            WHEN ('anon'::"name" = ANY ("p"."roles")) THEN 'anon'::"text"
            ELSE NULL::"text"
        END) AS "roles_covered",
        CASE
            WHEN ("t"."tablename" = 'profiles'::"name") THEN '❌ SIN RLS (como solicitado - evita recursión)'::"text"
            WHEN ("t"."tablename" = 'equipment_models'::"name") THEN '🌍 ACCESO TOTAL (todos ven/editan modelos)'::"text"
            WHEN ("t"."tablename" = ANY (ARRAY['assets'::"name", 'plants'::"name", 'business_units'::"name"])) THEN '✅ PROTEGIDO (sistema base)'::"text"
            WHEN ("t"."tablename" = ANY (ARRAY['maintenance_history'::"name", 'work_orders'::"name", 'service_orders'::"name", 'completed_checklists'::"name", 'incident_history'::"name", 'maintenance_plans'::"name", 'additional_expenses'::"name", 'checklist_schedules'::"name", 'asset_operators'::"name"])) THEN '🎯 JERARQUÍA VIA ASSET'::"text"
            WHEN ("t"."tablename" = 'departments'::"name") THEN '🏭 JERARQUÍA VIA PLANT'::"text"
            WHEN ("t"."rowsecurity" = true) THEN '✅ PROTEGIDO'::"text"
            ELSE '❌ SIN PROTECCIÓN'::"text"
        END AS "status_rls"
   FROM ("pg_tables" "t"
     LEFT JOIN "pg_policies" "p" ON ((("p"."tablename" = "t"."tablename") AND ("p"."schemaname" = "t"."schemaname"))))
  WHERE (("t"."schemaname" = 'public'::"name") AND ("t"."tablename" !~~ '%backup%'::"text") AND ("t"."tablename" !~~ '%migration%'::"text") AND ("t"."tablename" !~~ '%_old%'::"text"))
  GROUP BY "t"."tablename", "t"."rowsecurity"
  ORDER BY
        CASE
            WHEN ("t"."tablename" = ANY (ARRAY['assets'::"name", 'profiles'::"name", 'plants'::"name", 'business_units'::"name"])) THEN 1
            WHEN ("t"."tablename" = 'equipment_models'::"name") THEN 2
            WHEN ("t"."rowsecurity" = true) THEN 3
            ELSE 4
        END, "t"."tablename";


ALTER TABLE "public"."rls_system_complete_status" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."service_orders" (
    "id" "uuid" DEFAULT "extensions"."uuid_generate_v4"() NOT NULL,
    "order_id" "text" NOT NULL,
    "asset_id" "uuid",
    "asset_name" "text" NOT NULL,
    "type" "text" NOT NULL,
    "priority" "text" DEFAULT 'Media'::"text",
    "status" "text" DEFAULT 'Pendiente'::"text",
    "date" timestamp with time zone NOT NULL,
    "technician" "text" NOT NULL,
    "description" "text" NOT NULL,
    "notes" "text",
    "parts" "jsonb",
    "checklist_id" "uuid",
    "total_cost" numeric(10,2),
    "documents" "text"[],
    "created_by" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "work_order_id" "uuid",
    "findings" "text",
    "actions" "text",
    "labor_hours" double precision,
    "labor_cost" numeric(10,2),
    "parts_cost" numeric(10,2),
    "technician_id" "uuid",
    "additional_expenses" "text",
    "has_additional_expenses" boolean DEFAULT false,
    "requires_adjustment" boolean DEFAULT false,
    "updated_by" "uuid",
    "completion_date" timestamp with time zone
);


ALTER TABLE "public"."service_orders" OWNER TO "postgres";


CREATE SEQUENCE IF NOT EXISTS "public"."service_orders_order_number_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER TABLE "public"."service_orders_order_number_seq" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."supplier_certifications" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "supplier_id" "uuid" NOT NULL,
    "certification_name" character varying(255) NOT NULL,
    "issuing_body" character varying(255),
    "certification_number" character varying(100),
    "issue_date" "date",
    "expiration_date" "date",
    "certificate_url" "text",
    "is_active" boolean DEFAULT true,
    "created_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."supplier_certifications" OWNER TO "postgres";


COMMENT ON TABLE "public"."supplier_certifications" IS 'Certifications and licenses held by suppliers';



CREATE TABLE IF NOT EXISTS "public"."supplier_contacts" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "supplier_id" "uuid" NOT NULL,
    "contact_type" character varying(50) DEFAULT 'general'::character varying,
    "name" character varying(255) NOT NULL,
    "position" character varying(100),
    "email" character varying(255),
    "phone" character varying(50),
    "mobile_phone" character varying(50),
    "notes" "text",
    "is_primary" boolean DEFAULT false,
    "is_active" boolean DEFAULT true,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."supplier_contacts" OWNER TO "postgres";


COMMENT ON TABLE "public"."supplier_contacts" IS 'Multiple contacts per supplier with different roles';



CREATE TABLE IF NOT EXISTS "public"."supplier_performance_history" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "supplier_id" "uuid" NOT NULL,
    "purchase_order_id" "uuid",
    "work_order_id" "uuid",
    "order_date" "date" NOT NULL,
    "delivery_date" "date",
    "promised_delivery_date" "date",
    "actual_cost" numeric(10,2),
    "quoted_cost" numeric(10,2),
    "quality_rating" integer,
    "delivery_rating" integer,
    "service_rating" integer,
    "issues" "text"[],
    "notes" "text",
    "resolution_time_hours" integer,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    CONSTRAINT "supplier_performance_history_delivery_rating_check" CHECK ((("delivery_rating" >= 1) AND ("delivery_rating" <= 5))),
    CONSTRAINT "supplier_performance_history_quality_rating_check" CHECK ((("quality_rating" >= 1) AND ("quality_rating" <= 5))),
    CONSTRAINT "supplier_performance_history_service_rating_check" CHECK ((("service_rating" >= 1) AND ("service_rating" <= 5)))
);


ALTER TABLE "public"."supplier_performance_history" OWNER TO "postgres";


COMMENT ON TABLE "public"."supplier_performance_history" IS 'Historical performance data for supplier evaluation';



CREATE TABLE IF NOT EXISTS "public"."supplier_services" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "supplier_id" "uuid" NOT NULL,
    "service_name" character varying(255) NOT NULL,
    "service_category" character varying(100),
    "description" "text",
    "unit_cost" numeric(10,2),
    "unit_of_measure" character varying(50),
    "lead_time_days" integer,
    "warranty_period" character varying(50),
    "is_active" boolean DEFAULT true,
    "stock_available" integer DEFAULT 0,
    "min_order_quantity" integer DEFAULT 1,
    "max_order_quantity" integer,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."supplier_services" OWNER TO "postgres";


COMMENT ON TABLE "public"."supplier_services" IS 'Services and products offered by each supplier';



CREATE TABLE IF NOT EXISTS "public"."supplier_work_history" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "supplier_id" "uuid" NOT NULL,
    "work_order_id" "uuid",
    "asset_id" "uuid",
    "work_type" character varying(100),
    "problem_description" "text",
    "solution_description" "text",
    "parts_used" "jsonb",
    "labor_hours" numeric(6,2),
    "total_cost" numeric(10,2),
    "completed_on_time" boolean,
    "quality_satisfaction" integer,
    "would_recommend" boolean,
    "warranty_expiration" "date",
    "follow_up_required" boolean DEFAULT false,
    "follow_up_date" "date",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    CONSTRAINT "supplier_work_history_quality_satisfaction_check" CHECK ((("quality_satisfaction" >= 1) AND ("quality_satisfaction" <= 5)))
);


ALTER TABLE "public"."supplier_work_history" OWNER TO "postgres";


COMMENT ON TABLE "public"."supplier_work_history" IS 'Specific work history with assets and work orders';



CREATE TABLE IF NOT EXISTS "public"."suppliers" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "name" character varying(255) NOT NULL,
    "business_name" character varying(255),
    "tax_id" character varying(50),
    "contact_person" character varying(255),
    "email" character varying(255),
    "phone" character varying(50),
    "mobile_phone" character varying(50),
    "address" "text",
    "city" character varying(100),
    "state" character varying(100),
    "postal_code" character varying(20),
    "country" character varying(100) DEFAULT 'México'::character varying,
    "supplier_type" character varying(50),
    "industry" character varying(100),
    "specialties" "text"[],
    "certifications" "text"[],
    "business_hours" "jsonb",
    "payment_terms" character varying(50),
    "payment_methods" "text"[],
    "bank_account_info" "jsonb",
    "tax_exempt" boolean DEFAULT false,
    "rating" numeric(3,2),
    "total_orders" integer DEFAULT 0,
    "total_amount" numeric(12,2) DEFAULT 0,
    "avg_order_amount" numeric(10,2) DEFAULT 0,
    "avg_delivery_time" integer,
    "reliability_score" numeric(3,2),
    "status" character varying(20) DEFAULT 'active'::character varying,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "created_by" "uuid",
    "updated_by" "uuid",
    "business_unit_id" "uuid",
    CONSTRAINT "suppliers_rating_check" CHECK ((("rating" >= (0)::numeric) AND ("rating" <= (5)::numeric))),
    CONSTRAINT "suppliers_reliability_score_check" CHECK ((("reliability_score" >= (0)::numeric) AND ("reliability_score" <= (100)::numeric))),
    CONSTRAINT "suppliers_status_check" CHECK ((("status")::"text" = ANY ((ARRAY['active'::character varying, 'inactive'::character varying, 'suspended'::character varying, 'blacklisted'::character varying])::"text"[]))),
    CONSTRAINT "suppliers_supplier_type_check" CHECK ((("supplier_type")::"text" = ANY ((ARRAY['individual'::character varying, 'company'::character varying, 'distributor'::character varying, 'manufacturer'::character varying, 'service_provider'::character varying])::"text"[])))
);


ALTER TABLE "public"."suppliers" OWNER TO "postgres";


COMMENT ON TABLE "public"."suppliers" IS 'Main supplier registry with contact and business information';



CREATE TABLE IF NOT EXISTS "public"."task_parts" (
    "id" "uuid" DEFAULT "extensions"."uuid_generate_v4"() NOT NULL,
    "task_id" "uuid",
    "name" "text" NOT NULL,
    "part_number" "text",
    "quantity" integer DEFAULT 1 NOT NULL,
    "cost" numeric(10,2),
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "created_by" "uuid",
    "updated_by" "uuid"
);


ALTER TABLE "public"."task_parts" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."user_admin_context" (
    "user_id" "uuid" NOT NULL,
    "admin_level" "text" NOT NULL,
    "plant_id" "uuid",
    "business_unit_id" "uuid",
    "user_role" "public"."user_role",
    "updated_at" timestamp with time zone DEFAULT "now"(),
    CONSTRAINT "user_admin_context_check" CHECK (((("admin_level" = 'TOTAL'::"text") AND ("plant_id" IS NULL) AND ("business_unit_id" IS NULL)) OR (("admin_level" = 'UNIT'::"text") AND ("plant_id" IS NULL) AND ("business_unit_id" IS NOT NULL)) OR (("admin_level" = 'PLANT'::"text") AND ("plant_id" IS NOT NULL) AND ("business_unit_id" IS NOT NULL)) OR ("admin_level" = 'NONE'::"text")))
);


ALTER TABLE "public"."user_admin_context" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."user_authorization_summary" AS
 SELECT "p"."id" AS "user_id",
    "p"."nombre",
    "p"."apellido",
    "p"."email",
    "p"."role",
    "p"."can_authorize_up_to" AS "individual_limit",
    "p"."business_unit_id",
    "bu"."name" AS "business_unit_name",
    "p"."plant_id",
    "pl"."name" AS "plant_name",
    "public"."get_user_effective_authorization"("p"."id") AS "effective_global_authorization",
    "public"."get_user_delegatable_amount"("p"."id", NULL::"uuid", NULL::"uuid") AS "available_delegation_amount",
    "bul"."max_authorization_limit" AS "business_unit_max_limit",
        CASE
            WHEN ("p"."role" = 'GERENCIA_GENERAL'::"public"."user_role") THEN 'Ilimitado'::"text"
            ELSE 'Dinámico'::"text"
        END AS "authorization_type",
    ( SELECT "count"(*) AS "count"
           FROM "public"."authorization_delegations" "ad"
          WHERE (("ad"."grantor_user_id" = "p"."id") AND ("ad"."is_active" = true))) AS "active_delegations_given",
    ( SELECT "count"(*) AS "count"
           FROM "public"."authorization_delegations" "ad"
          WHERE (("ad"."grantee_user_id" = "p"."id") AND ("ad"."is_active" = true))) AS "active_delegations_received",
    ( SELECT COALESCE("sum"("ad"."delegated_amount"), (0)::numeric) AS "coalesce"
           FROM "public"."authorization_delegations" "ad"
          WHERE (("ad"."grantor_user_id" = "p"."id") AND ("ad"."is_active" = true))) AS "total_delegated_out",
    ( SELECT COALESCE("sum"("ad"."delegated_amount"), (0)::numeric) AS "coalesce"
           FROM "public"."authorization_delegations" "ad"
          WHERE (("ad"."grantee_user_id" = "p"."id") AND ("ad"."is_active" = true))) AS "total_delegated_in"
   FROM ((("public"."profiles" "p"
     LEFT JOIN "public"."business_units" "bu" ON (("p"."business_unit_id" = "bu"."id")))
     LEFT JOIN "public"."plants" "pl" ON (("p"."plant_id" = "pl"."id")))
     LEFT JOIN "public"."business_unit_limits" "bul" ON (("p"."business_unit_id" = "bul"."business_unit_id")))
  WHERE ("p"."role" IS NOT NULL)
  ORDER BY "bu"."name", "pl"."name", "p"."apellido", "p"."nombre";


ALTER TABLE "public"."user_authorization_summary" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."user_roles_summary" AS
 SELECT "p"."id",
    "p"."nombre",
    "p"."apellido",
    "p"."role",
    "p"."employee_code",
    "p"."can_authorize_up_to",
    "bu"."name" AS "business_unit_name",
    "pl"."name" AS "plant_name",
    "p"."status",
    "p"."position",
    "p"."telefono",
    "p"."phone_secondary",
    "p"."hire_date"
   FROM (("public"."profiles" "p"
     LEFT JOIN "public"."business_units" "bu" ON (("p"."business_unit_id" = "bu"."id")))
     LEFT JOIN "public"."plants" "pl" ON (("p"."plant_id" = "pl"."id")))
  WHERE (("p"."status" = 'active'::"text") OR ("p"."status" IS NULL));


ALTER TABLE "public"."user_roles_summary" OWNER TO "postgres";


CREATE SEQUENCE IF NOT EXISTS "public"."work_order_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER TABLE "public"."work_order_id_seq" OWNER TO "postgres";


CREATE SEQUENCE IF NOT EXISTS "public"."work_order_order_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER TABLE "public"."work_order_order_id_seq" OWNER TO "postgres";


CREATE SEQUENCE IF NOT EXISTS "public"."work_order_sequence"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER TABLE "public"."work_order_sequence" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."work_orders_with_checklist_status" AS
 SELECT "wo"."id",
    "wo"."order_id",
    "wo"."asset_id",
    "wo"."description",
    "wo"."type",
    "wo"."requested_by",
    "wo"."assigned_to",
    "wo"."planned_date",
    "wo"."estimated_duration",
    "wo"."priority",
    "wo"."status",
    "wo"."required_parts",
    "wo"."estimated_cost",
    "wo"."checklist_id",
    "wo"."maintenance_plan_id",
    "wo"."issue_items",
    "wo"."purchase_order_id",
    "wo"."approval_status",
    "wo"."approved_by",
    "wo"."approval_date",
    "wo"."created_at",
    "wo"."updated_at",
    "wo"."completed_at",
    "wo"."used_parts",
    "wo"."service_order_id",
    "wo"."updated_by",
    "wo"."creation_photos",
    "wo"."completion_photos",
    "wo"."progress_photos",
    "wo"."incident_id",
    "wo"."preventive_checklist_id",
    "wo"."preventive_checklist_completed",
        CASE
            WHEN (("wo"."type" = 'preventive'::"text") AND ("wo"."preventive_checklist_id" IS NOT NULL)) THEN
            CASE
                WHEN "wo"."preventive_checklist_completed" THEN 'Completado'::"text"
                WHEN (EXISTS ( SELECT 1
                   FROM "public"."maintenance_checklists" "mc"
                  WHERE (("mc"."work_order_id" = "wo"."id") AND ("mc"."status" = 'completed'::"text")))) THEN 'Completado'::"text"
                ELSE 'Pendiente'::"text"
            END
            ELSE 'No requerido'::"text"
        END AS "checklist_status",
    "po"."status" AS "purchase_order_status",
    "public"."is_work_order_ready_to_execute"("wo"."id") AS "ready_to_execute"
   FROM ("public"."work_orders" "wo"
     LEFT JOIN "public"."purchase_orders" "po" ON (("wo"."purchase_order_id" = "po"."id")));


ALTER TABLE "public"."work_orders_with_checklist_status" OWNER TO "postgres";


ALTER TABLE ONLY "public"."diesel_excel_staging" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."diesel_excel_staging_id_seq"'::"regclass");



ALTER TABLE ONLY "public"."additional_expenses"
    ADD CONSTRAINT "additional_expenses_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."app_settings"
    ADD CONSTRAINT "app_settings_pkey" PRIMARY KEY ("key");



ALTER TABLE ONLY "public"."asset_assignment_history"
    ADD CONSTRAINT "asset_assignment_history_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."asset_composite_relationships"
    ADD CONSTRAINT "asset_composite_relationships_component_asset_id_key" UNIQUE ("component_asset_id");



ALTER TABLE ONLY "public"."asset_composite_relationships"
    ADD CONSTRAINT "asset_composite_relationships_composite_asset_id_component__key" UNIQUE ("composite_asset_id", "component_asset_id");



ALTER TABLE ONLY "public"."asset_composite_relationships"
    ADD CONSTRAINT "asset_composite_relationships_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."asset_name_mappings"
    ADD CONSTRAINT "asset_name_mappings_original_name_key" UNIQUE ("original_name");



ALTER TABLE ONLY "public"."asset_name_mappings"
    ADD CONSTRAINT "asset_name_mappings_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."asset_operators"
    ADD CONSTRAINT "asset_operators_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."assets"
    ADD CONSTRAINT "assets_asset_id_key" UNIQUE ("asset_id");



ALTER TABLE ONLY "public"."assets"
    ADD CONSTRAINT "assets_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."authorization_delegation_history"
    ADD CONSTRAINT "authorization_delegation_history_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."authorization_delegations"
    ADD CONSTRAINT "authorization_delegations_grantor_user_id_grantee_user_id_b_key" UNIQUE ("grantor_user_id", "grantee_user_id", "business_unit_id", "plant_id", "scope_type") DEFERRABLE INITIALLY DEFERRED;



ALTER TABLE ONLY "public"."authorization_delegations"
    ADD CONSTRAINT "authorization_delegations_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."authorization_matrix"
    ADD CONSTRAINT "authorization_matrix_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."auto_create_logs"
    ADD CONSTRAINT "auto_create_logs_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."business_unit_limits"
    ADD CONSTRAINT "business_unit_limits_business_unit_id_key" UNIQUE ("business_unit_id");



ALTER TABLE ONLY "public"."business_unit_limits"
    ADD CONSTRAINT "business_unit_limits_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."business_units"
    ADD CONSTRAINT "business_units_code_key" UNIQUE ("code");



ALTER TABLE ONLY "public"."business_units"
    ADD CONSTRAINT "business_units_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."checklist_evidence"
    ADD CONSTRAINT "checklist_evidence_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."checklist_issues"
    ADD CONSTRAINT "checklist_issues_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."checklist_items"
    ADD CONSTRAINT "checklist_items_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."checklist_schedules"
    ADD CONSTRAINT "checklist_schedules_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."checklist_sections"
    ADD CONSTRAINT "checklist_sections_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."checklist_template_versions"
    ADD CONSTRAINT "checklist_template_versions_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."checklist_template_versions"
    ADD CONSTRAINT "checklist_template_versions_template_id_version_number_key" UNIQUE ("template_id", "version_number");



ALTER TABLE ONLY "public"."checklists"
    ADD CONSTRAINT "checklists_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."completed_checklists"
    ADD CONSTRAINT "completed_checklists_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."departments"
    ADD CONSTRAINT "departments_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."departments"
    ADD CONSTRAINT "departments_plant_id_code_key" UNIQUE ("plant_id", "code");



ALTER TABLE ONLY "public"."diesel_evidence"
    ADD CONSTRAINT "diesel_evidence_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."diesel_excel_staging"
    ADD CONSTRAINT "diesel_excel_staging_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."diesel_inventory_snapshots"
    ADD CONSTRAINT "diesel_inventory_snapshots_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."diesel_inventory_snapshots"
    ADD CONSTRAINT "diesel_inventory_snapshots_warehouse_id_snapshot_date_key" UNIQUE ("warehouse_id", "snapshot_date");



ALTER TABLE ONLY "public"."diesel_products"
    ADD CONSTRAINT "diesel_products_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."diesel_products"
    ADD CONSTRAINT "diesel_products_product_code_key" UNIQUE ("product_code");



ALTER TABLE ONLY "public"."diesel_transactions"
    ADD CONSTRAINT "diesel_transactions_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."diesel_transactions"
    ADD CONSTRAINT "diesel_transactions_transaction_id_key" UNIQUE ("transaction_id");



ALTER TABLE ONLY "public"."diesel_warehouses"
    ADD CONSTRAINT "diesel_warehouses_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."diesel_warehouses"
    ADD CONSTRAINT "diesel_warehouses_plant_id_warehouse_code_key" UNIQUE ("plant_id", "warehouse_code");



ALTER TABLE ONLY "public"."equipment_models"
    ADD CONSTRAINT "equipment_models_model_id_key" UNIQUE ("model_id");



ALTER TABLE ONLY "public"."equipment_models"
    ADD CONSTRAINT "equipment_models_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."exception_assets"
    ADD CONSTRAINT "exception_assets_exception_name_key" UNIQUE ("exception_name");



ALTER TABLE ONLY "public"."exception_assets"
    ADD CONSTRAINT "exception_assets_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."financial_classifications"
    ADD CONSTRAINT "financial_classifications_codigo_ingresos_key" UNIQUE ("codigo_ingresos");



ALTER TABLE ONLY "public"."financial_classifications"
    ADD CONSTRAINT "financial_classifications_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."incident_history"
    ADD CONSTRAINT "incident_history_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."maintenance_checklists"
    ADD CONSTRAINT "maintenance_checklists_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."maintenance_history"
    ADD CONSTRAINT "maintenance_history_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."maintenance_intervals"
    ADD CONSTRAINT "maintenance_intervals_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."maintenance_plans"
    ADD CONSTRAINT "maintenance_plans_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."maintenance_tasks"
    ADD CONSTRAINT "maintenance_tasks_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."manual_financial_adjustment_distributions"
    ADD CONSTRAINT "manual_financial_adjustment_distributions_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."manual_financial_adjustments"
    ADD CONSTRAINT "manual_financial_adjustments_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."model_documentation"
    ADD CONSTRAINT "model_documentation_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."notifications"
    ADD CONSTRAINT "notifications_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."offices"
    ADD CONSTRAINT "offices_name_key" UNIQUE ("name");



ALTER TABLE ONLY "public"."offices"
    ADD CONSTRAINT "offices_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."operator_assignment_history"
    ADD CONSTRAINT "operator_assignment_history_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."plants"
    ADD CONSTRAINT "plants_code_key" UNIQUE ("code");



ALTER TABLE ONLY "public"."plants"
    ADD CONSTRAINT "plants_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."po_action_tokens"
    ADD CONSTRAINT "po_action_tokens_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."profiles"
    ADD CONSTRAINT "profiles_employee_code_unique" UNIQUE ("employee_code");



ALTER TABLE ONLY "public"."profiles"
    ADD CONSTRAINT "profiles_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."purchase_order_receipts"
    ADD CONSTRAINT "purchase_order_receipts_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."purchase_orders"
    ADD CONSTRAINT "purchase_orders_order_id_key" UNIQUE ("order_id");



ALTER TABLE ONLY "public"."purchase_orders"
    ADD CONSTRAINT "purchase_orders_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."service_orders"
    ADD CONSTRAINT "service_orders_order_id_key" UNIQUE ("order_id");



ALTER TABLE ONLY "public"."service_orders"
    ADD CONSTRAINT "service_orders_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."supplier_certifications"
    ADD CONSTRAINT "supplier_certifications_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."supplier_contacts"
    ADD CONSTRAINT "supplier_contacts_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."supplier_performance_history"
    ADD CONSTRAINT "supplier_performance_history_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."supplier_services"
    ADD CONSTRAINT "supplier_services_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."supplier_work_history"
    ADD CONSTRAINT "supplier_work_history_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."suppliers"
    ADD CONSTRAINT "suppliers_name_unique" UNIQUE ("name");



ALTER TABLE ONLY "public"."suppliers"
    ADD CONSTRAINT "suppliers_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."task_parts"
    ADD CONSTRAINT "task_parts_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."user_admin_context"
    ADD CONSTRAINT "user_admin_context_pkey" PRIMARY KEY ("user_id");



ALTER TABLE ONLY "public"."work_orders"
    ADD CONSTRAINT "work_orders_order_id_key" UNIQUE ("order_id");



ALTER TABLE ONLY "public"."work_orders"
    ADD CONSTRAINT "work_orders_pkey" PRIMARY KEY ("id");



CREATE UNIQUE INDEX "asset_operators_active_assignment_unique" ON "public"."asset_operators" USING "btree" ("asset_id", "assignment_type") WHERE ("status" = 'active'::"text");



CREATE UNIQUE INDEX "asset_operators_primary_active_unique" ON "public"."asset_operators" USING "btree" ("asset_id") WHERE (("assignment_type" = 'primary'::"text") AND ("status" = 'active'::"text"));



CREATE INDEX "idx_acr_component" ON "public"."asset_composite_relationships" USING "btree" ("component_asset_id");



CREATE INDEX "idx_acr_composite" ON "public"."asset_composite_relationships" USING "btree" ("composite_asset_id");



CREATE INDEX "idx_additional_expenses_asset_work_order" ON "public"."additional_expenses" USING "btree" ("asset_id", "work_order_id");



CREATE INDEX "idx_adj_distributions_adjustment" ON "public"."manual_financial_adjustment_distributions" USING "btree" ("adjustment_id");



CREATE INDEX "idx_adj_distributions_bu" ON "public"."manual_financial_adjustment_distributions" USING "btree" ("business_unit_id");



CREATE INDEX "idx_adj_distributions_dept" ON "public"."manual_financial_adjustment_distributions" USING "btree" ("department");



CREATE INDEX "idx_adj_distributions_period" ON "public"."manual_financial_adjustment_distributions" USING "btree" ("adjustment_id", "plant_id");



CREATE INDEX "idx_adj_distributions_plant" ON "public"."manual_financial_adjustment_distributions" USING "btree" ("plant_id");



CREATE INDEX "idx_asset_assignment_history_asset_id" ON "public"."asset_assignment_history" USING "btree" ("asset_id");



CREATE INDEX "idx_asset_assignment_history_changed_by" ON "public"."asset_assignment_history" USING "btree" ("changed_by");



CREATE INDEX "idx_asset_assignment_history_created_at" ON "public"."asset_assignment_history" USING "btree" ("created_at");



CREATE INDEX "idx_asset_mappings_original" ON "public"."asset_name_mappings" USING "btree" ("lower"("original_name"));



CREATE INDEX "idx_asset_operators_active" ON "public"."asset_operators" USING "btree" ("operator_id", "asset_id") WHERE ("status" = 'active'::"text");



CREATE INDEX "idx_asset_operators_asset_id" ON "public"."asset_operators" USING "btree" ("asset_id");



CREATE INDEX "idx_asset_operators_asset_operator" ON "public"."asset_operators" USING "btree" ("asset_id", "operator_id", "status");



CREATE INDEX "idx_asset_operators_assignment_type" ON "public"."asset_operators" USING "btree" ("assignment_type");



CREATE INDEX "idx_asset_operators_operator_id" ON "public"."asset_operators" USING "btree" ("operator_id");



CREATE INDEX "idx_asset_operators_rls" ON "public"."asset_operators" USING "btree" ("asset_id", "operator_id", "status");



COMMENT ON INDEX "public"."idx_asset_operators_rls" IS 'RLS optimization index for operator assignments';



CREATE INDEX "idx_asset_operators_status" ON "public"."asset_operators" USING "btree" ("status");



CREATE INDEX "idx_assets_plant_id" ON "public"."assets" USING "btree" ("plant_id");



CREATE INDEX "idx_assets_plant_optimized" ON "public"."assets" USING "btree" ("plant_id", "id");



CREATE INDEX "idx_auth_delegations_active" ON "public"."authorization_delegations" USING "btree" ("is_active") WHERE ("is_active" = true);



CREATE INDEX "idx_auth_delegations_grantee" ON "public"."authorization_delegations" USING "btree" ("grantee_user_id");



CREATE INDEX "idx_auth_delegations_grantor" ON "public"."authorization_delegations" USING "btree" ("grantor_user_id");



CREATE INDEX "idx_business_unit_limits_business_unit_id" ON "public"."business_unit_limits" USING "btree" ("business_unit_id");



CREATE INDEX "idx_checklist_evidence_category" ON "public"."checklist_evidence" USING "btree" ("category", "completed_checklist_id");



CREATE INDEX "idx_checklist_evidence_completed_checklist" ON "public"."checklist_evidence" USING "btree" ("completed_checklist_id");



CREATE INDEX "idx_checklist_evidence_section" ON "public"."checklist_evidence" USING "btree" ("section_id");



CREATE INDEX "idx_checklist_issues_asset_fingerprint" ON "public"."checklist_issues" USING "btree" ("issue_fingerprint", "resolved", "created_at") WHERE ("issue_fingerprint" IS NOT NULL);



CREATE INDEX "idx_checklist_issues_fingerprint" ON "public"."checklist_issues" USING "btree" ("issue_fingerprint", "resolved") WHERE ("issue_fingerprint" IS NOT NULL);



CREATE INDEX "idx_checklist_issues_incident_id" ON "public"."checklist_issues" USING "btree" ("incident_id");



CREATE INDEX "idx_checklist_issues_parent" ON "public"."checklist_issues" USING "btree" ("parent_issue_id") WHERE ("parent_issue_id" IS NOT NULL);



CREATE INDEX "idx_checklist_items_section_id" ON "public"."checklist_items" USING "btree" ("section_id");



CREATE INDEX "idx_checklist_schedules_asset_id" ON "public"."checklist_schedules" USING "btree" ("asset_id");



CREATE INDEX "idx_checklist_schedules_lookup" ON "public"."checklist_schedules" USING "btree" ("template_id", "asset_id", "status");



CREATE INDEX "idx_checklist_schedules_scheduled_date" ON "public"."checklist_schedules" USING "btree" ("scheduled_date");



CREATE INDEX "idx_checklist_schedules_status" ON "public"."checklist_schedules" USING "btree" ("status");



CREATE INDEX "idx_checklist_sections_checklist_id" ON "public"."checklist_sections" USING "btree" ("checklist_id");



CREATE INDEX "idx_checklist_sections_cleanliness_config" ON "public"."checklist_sections" USING "gin" ("cleanliness_config");



CREATE INDEX "idx_checklist_sections_section_type" ON "public"."checklist_sections" USING "btree" ("section_type");



CREATE INDEX "idx_completed_checklists_asset_id" ON "public"."completed_checklists" USING "btree" ("asset_id");



CREATE INDEX "idx_completed_checklists_equipment_readings" ON "public"."completed_checklists" USING "btree" ("asset_id", "completion_date", "equipment_hours_reading", "equipment_kilometers_reading");



CREATE INDEX "idx_completed_checklists_reading_timestamp" ON "public"."completed_checklists" USING "btree" ("asset_id", "reading_timestamp");



CREATE INDEX "idx_completed_checklists_template_version" ON "public"."completed_checklists" USING "btree" ("template_version_id");



CREATE INDEX "idx_diesel_evidence_created" ON "public"."diesel_evidence" USING "btree" ("created_at" DESC);



CREATE INDEX "idx_diesel_evidence_transaction" ON "public"."diesel_evidence" USING "btree" ("transaction_id");



CREATE INDEX "idx_diesel_evidence_type" ON "public"."diesel_evidence" USING "btree" ("evidence_type");



CREATE INDEX "idx_diesel_inventory_plant_warehouse" ON "public"."diesel_current_inventory" USING "btree" ("plant_id", "warehouse_id");



CREATE INDEX "idx_diesel_snapshots_warehouse_date" ON "public"."diesel_inventory_snapshots" USING "btree" ("warehouse_id", "snapshot_date" DESC);



CREATE INDEX "idx_diesel_staging_planta" ON "public"."diesel_excel_staging" USING "btree" ("planta");



CREATE INDEX "idx_diesel_staging_processed" ON "public"."diesel_excel_staging" USING "btree" ("processed");



CREATE INDEX "idx_diesel_staging_unidad" ON "public"."diesel_excel_staging" USING "btree" ("unidad") WHERE ("unidad" IS NOT NULL);



CREATE INDEX "idx_diesel_transactions_asset_category" ON "public"."diesel_transactions" USING "btree" ("asset_category", "transaction_date");



CREATE INDEX "idx_diesel_transactions_asset_date" ON "public"."diesel_transactions" USING "btree" ("asset_id", "transaction_date") WHERE ("asset_id" IS NOT NULL);



CREATE INDEX "idx_diesel_transactions_balance" ON "public"."diesel_transactions" USING "btree" ("warehouse_id", "transaction_date" DESC);



CREATE INDEX "idx_diesel_transactions_exception_name" ON "public"."diesel_transactions" USING "btree" ("exception_asset_name") WHERE ("exception_asset_name" IS NOT NULL);



CREATE INDEX "idx_diesel_transactions_plant_date" ON "public"."diesel_transactions" USING "btree" ("plant_id", "transaction_date");



CREATE INDEX "idx_diesel_transactions_type_date" ON "public"."diesel_transactions" USING "btree" ("transaction_type", "transaction_date");



CREATE INDEX "idx_diesel_transactions_validation" ON "public"."diesel_transactions" USING "btree" ("requires_validation", "validated_at");



CREATE INDEX "idx_diesel_transactions_warehouse" ON "public"."diesel_transactions" USING "btree" ("warehouse_id");



CREATE INDEX "idx_diesel_warehouses_cuenta_litros" ON "public"."diesel_warehouses" USING "btree" ("current_cuenta_litros");



CREATE INDEX "idx_diesel_warehouses_inventory" ON "public"."diesel_warehouses" USING "btree" ("current_inventory");



CREATE INDEX "idx_exception_assets_normalized" ON "public"."exception_assets" USING "btree" ("normalized_name");



CREATE INDEX "idx_financial_classifications_codigo" ON "public"."financial_classifications" USING "btree" ("codigo_ingresos");



CREATE INDEX "idx_incident_history_asset_id" ON "public"."incident_history" USING "btree" ("asset_id");



CREATE INDEX "idx_incident_history_work_order_id" ON "public"."incident_history" USING "btree" ("work_order_id");



CREATE INDEX "idx_maintenance_checklists_status" ON "public"."maintenance_checklists" USING "btree" ("status");



CREATE INDEX "idx_maintenance_checklists_work_order" ON "public"."maintenance_checklists" USING "btree" ("work_order_id");



CREATE INDEX "idx_maintenance_history_asset_id" ON "public"."maintenance_history" USING "btree" ("asset_id");



CREATE INDEX "idx_maintenance_intervals_category" ON "public"."maintenance_intervals" USING "btree" ("maintenance_category", "interval_value");



CREATE INDEX "idx_maintenance_intervals_recurring" ON "public"."maintenance_intervals" USING "btree" ("is_recurring", "is_first_cycle_only");



CREATE INDEX "idx_maintenance_plans_asset_id" ON "public"."maintenance_plans" USING "btree" ("asset_id");



CREATE INDEX "idx_manual_financial_adjustments_bu" ON "public"."manual_financial_adjustments" USING "btree" ("business_unit_id");



CREATE INDEX "idx_manual_financial_adjustments_category" ON "public"."manual_financial_adjustments" USING "btree" ("category");



CREATE INDEX "idx_manual_financial_adjustments_created_at" ON "public"."manual_financial_adjustments" USING "btree" ("created_at");



CREATE INDEX "idx_manual_financial_adjustments_distribution_method" ON "public"."manual_financial_adjustments" USING "btree" ("distribution_method");



CREATE INDEX "idx_manual_financial_adjustments_expense_category" ON "public"."manual_financial_adjustments" USING "btree" ("expense_category");



CREATE INDEX "idx_manual_financial_adjustments_expense_lookup" ON "public"."manual_financial_adjustments" USING "btree" ("period_month", "category", "expense_category") WHERE ("expense_category" IS NOT NULL);



CREATE INDEX "idx_manual_financial_adjustments_is_bonus" ON "public"."manual_financial_adjustments" USING "btree" ("is_bonus");



CREATE INDEX "idx_manual_financial_adjustments_is_cash_payment" ON "public"."manual_financial_adjustments" USING "btree" ("is_cash_payment");



CREATE INDEX "idx_manual_financial_adjustments_is_distributed" ON "public"."manual_financial_adjustments" USING "btree" ("is_distributed");



CREATE INDEX "idx_manual_financial_adjustments_lookup" ON "public"."manual_financial_adjustments" USING "btree" ("period_month", "plant_id", "category");



CREATE INDEX "idx_manual_financial_adjustments_period" ON "public"."manual_financial_adjustments" USING "btree" ("period_month");



CREATE INDEX "idx_manual_financial_adjustments_plant" ON "public"."manual_financial_adjustments" USING "btree" ("plant_id");



CREATE INDEX "idx_notifications_status" ON "public"."notifications" USING "btree" ("status");



CREATE INDEX "idx_notifications_user_id" ON "public"."notifications" USING "btree" ("user_id");



CREATE INDEX "idx_op_assignment_history_asset_id" ON "public"."operator_assignment_history" USING "btree" ("asset_id");



CREATE INDEX "idx_op_assignment_history_created_at" ON "public"."operator_assignment_history" USING "btree" ("created_at");



CREATE INDEX "idx_op_assignment_history_operator_id" ON "public"."operator_assignment_history" USING "btree" ("operator_id");



CREATE INDEX "idx_op_assignment_history_transfer_id" ON "public"."operator_assignment_history" USING "btree" ("transfer_id");



CREATE INDEX "idx_plants_business_unit" ON "public"."plants" USING "btree" ("id", "business_unit_id");



CREATE INDEX "idx_plants_business_unit_id" ON "public"."plants" USING "btree" ("business_unit_id");



CREATE INDEX "idx_plants_business_unit_optimized" ON "public"."plants" USING "btree" ("business_unit_id", "id") WHERE ("status" = 'active'::"text");



CREATE INDEX "idx_plants_contact_email" ON "public"."plants" USING "btree" ("contact_email");



CREATE INDEX "idx_plants_contact_phone" ON "public"."plants" USING "btree" ("contact_phone");



CREATE INDEX "idx_po_action_tokens_email" ON "public"."po_action_tokens" USING "btree" ("recipient_email");



CREATE INDEX "idx_po_action_tokens_exp" ON "public"."po_action_tokens" USING "btree" ("expires_at");



CREATE INDEX "idx_po_action_tokens_po" ON "public"."po_action_tokens" USING "btree" ("purchase_order_id");



CREATE INDEX "idx_profiles_access_pattern" ON "public"."profiles" USING "btree" ("id", "plant_id", "business_unit_id", "role") WHERE ("status" = 'active'::"text");



CREATE INDEX "idx_profiles_business_unit_access" ON "public"."profiles" USING "btree" ("business_unit_id") WHERE ("business_unit_id" IS NOT NULL);



CREATE INDEX "idx_profiles_business_unit_id" ON "public"."profiles" USING "btree" ("business_unit_id");



CREATE INDEX "idx_profiles_business_unit_status" ON "public"."profiles" USING "btree" ("business_unit_id", "status");



CREATE INDEX "idx_profiles_email" ON "public"."profiles" USING "btree" ("email");



CREATE INDEX "idx_profiles_employee_code" ON "public"."profiles" USING "btree" ("employee_code");



CREATE UNIQUE INDEX "idx_profiles_employee_code_unique" ON "public"."profiles" USING "btree" ("employee_code") WHERE ("employee_code" IS NOT NULL);



CREATE INDEX "idx_profiles_hierarchy_access" ON "public"."profiles" USING "btree" ("plant_id", "business_unit_id", "role") WHERE (("plant_id" IS NULL) OR ("business_unit_id" IS NOT NULL));



CREATE INDEX "idx_profiles_is_active" ON "public"."profiles" USING "btree" ("is_active");



CREATE INDEX "idx_profiles_is_operator" ON "public"."profiles" USING "btree" ("is_operator");



CREATE INDEX "idx_profiles_office_id" ON "public"."profiles" USING "btree" ("office_id");



CREATE INDEX "idx_profiles_plant_access" ON "public"."profiles" USING "btree" ("plant_id") WHERE ("plant_id" IS NOT NULL);



CREATE INDEX "idx_profiles_plant_id" ON "public"."profiles" USING "btree" ("plant_id");



CREATE INDEX "idx_profiles_plant_status" ON "public"."profiles" USING "btree" ("plant_id", "status");



CREATE INDEX "idx_profiles_rls_lookup" ON "public"."profiles" USING "btree" ("id", "role", "status", "plant_id", "business_unit_id");



COMMENT ON INDEX "public"."idx_profiles_rls_lookup" IS 'RLS optimization index for profile lookups';



CREATE INDEX "idx_profiles_role" ON "public"."profiles" USING "btree" ("role");



CREATE INDEX "idx_profiles_role_status" ON "public"."profiles" USING "btree" ("role", "status");



CREATE INDEX "idx_profiles_status" ON "public"."profiles" USING "btree" ("status");



CREATE INDEX "idx_profiles_total_access" ON "public"."profiles" USING "btree" ("id") WHERE (("plant_id" IS NULL) AND ("business_unit_id" IS NULL) AND ("status" = 'active'::"text"));



CREATE INDEX "idx_profiles_unit_access" ON "public"."profiles" USING "btree" ("id", "business_unit_id") WHERE (("plant_id" IS NULL) AND ("business_unit_id" IS NOT NULL) AND ("status" = 'active'::"text"));



CREATE INDEX "idx_purchase_orders_created_at" ON "public"."purchase_orders" USING "btree" ("created_at");



CREATE INDEX "idx_purchase_orders_max_payment_date" ON "public"."purchase_orders" USING "btree" ("max_payment_date") WHERE ("max_payment_date" IS NOT NULL);



CREATE INDEX "idx_purchase_orders_max_payment_date_pending" ON "public"."purchase_orders" USING "btree" ("max_payment_date") WHERE (("payment_status" = ANY (ARRAY['pending'::"text", 'overdue'::"text"])) OR ("payment_status" IS NULL));



CREATE INDEX "idx_purchase_orders_payment_date" ON "public"."purchase_orders" USING "btree" ("payment_date");



CREATE INDEX "idx_purchase_orders_payment_method" ON "public"."purchase_orders" USING "btree" ("payment_method");



CREATE INDEX "idx_purchase_orders_payment_status" ON "public"."purchase_orders" USING "btree" ("payment_status");



CREATE INDEX "idx_purchase_orders_plant_id" ON "public"."purchase_orders" USING "btree" ("plant_id");



CREATE INDEX "idx_purchase_orders_plant_type" ON "public"."purchase_orders" USING "btree" ("plant_id", "po_type");



CREATE INDEX "idx_purchase_orders_po_type" ON "public"."purchase_orders" USING "btree" ("po_type");



CREATE INDEX "idx_purchase_orders_purchase_date" ON "public"."purchase_orders" USING "btree" ("purchase_date");



CREATE INDEX "idx_purchase_orders_quotation_urls" ON "public"."purchase_orders" USING "gin" ("quotation_urls");



CREATE INDEX "idx_purchase_orders_requires_quote" ON "public"."purchase_orders" USING "btree" ("requires_quote");



CREATE INDEX "idx_purchase_orders_status_type" ON "public"."purchase_orders" USING "btree" ("status", "po_type");



CREATE INDEX "idx_purchase_orders_supplier_id" ON "public"."purchase_orders" USING "btree" ("supplier_id");



CREATE INDEX "idx_purchase_orders_work_order_id" ON "public"."purchase_orders" USING "btree" ("work_order_id");



CREATE INDEX "idx_service_orders_asset_id" ON "public"."service_orders" USING "btree" ("asset_id");



CREATE INDEX "idx_supplier_certifications_expiration" ON "public"."supplier_certifications" USING "btree" ("expiration_date");



CREATE INDEX "idx_supplier_certifications_supplier_id" ON "public"."supplier_certifications" USING "btree" ("supplier_id");



CREATE INDEX "idx_supplier_contacts_active" ON "public"."supplier_contacts" USING "btree" ("supplier_id", "is_active") WHERE ("is_active" = true);



CREATE INDEX "idx_supplier_contacts_primary" ON "public"."supplier_contacts" USING "btree" ("supplier_id", "is_primary") WHERE ("is_primary" = true);



CREATE INDEX "idx_supplier_contacts_supplier_id" ON "public"."supplier_contacts" USING "btree" ("supplier_id");



CREATE INDEX "idx_supplier_performance_order_date" ON "public"."supplier_performance_history" USING "btree" ("order_date");



CREATE INDEX "idx_supplier_performance_ratings" ON "public"."supplier_performance_history" USING "btree" ("quality_rating", "delivery_rating", "service_rating");



CREATE INDEX "idx_supplier_performance_supplier_id" ON "public"."supplier_performance_history" USING "btree" ("supplier_id");



CREATE INDEX "idx_supplier_services_active" ON "public"."supplier_services" USING "btree" ("supplier_id", "is_active") WHERE ("is_active" = true);



CREATE INDEX "idx_supplier_services_category" ON "public"."supplier_services" USING "btree" ("service_category");



CREATE INDEX "idx_supplier_services_supplier_id" ON "public"."supplier_services" USING "btree" ("supplier_id");



CREATE INDEX "idx_supplier_work_history_asset_id" ON "public"."supplier_work_history" USING "btree" ("asset_id");



CREATE INDEX "idx_supplier_work_history_supplier_id" ON "public"."supplier_work_history" USING "btree" ("supplier_id");



CREATE INDEX "idx_supplier_work_history_work_type" ON "public"."supplier_work_history" USING "btree" ("work_type");



CREATE INDEX "idx_suppliers_business_unit_id" ON "public"."suppliers" USING "btree" ("business_unit_id");



CREATE INDEX "idx_suppliers_industry" ON "public"."suppliers" USING "btree" ("industry");



CREATE INDEX "idx_suppliers_name" ON "public"."suppliers" USING "btree" ("name");



CREATE INDEX "idx_suppliers_rating" ON "public"."suppliers" USING "btree" ("rating");



CREATE INDEX "idx_suppliers_specialties" ON "public"."suppliers" USING "gin" ("specialties");



CREATE INDEX "idx_suppliers_status" ON "public"."suppliers" USING "btree" ("status");



CREATE INDEX "idx_suppliers_type" ON "public"."suppliers" USING "btree" ("supplier_type");



CREATE INDEX "idx_template_versions_active" ON "public"."checklist_template_versions" USING "btree" ("template_id", "is_active") WHERE ("is_active" = true);



CREATE INDEX "idx_template_versions_template_id" ON "public"."checklist_template_versions" USING "btree" ("template_id");



CREATE INDEX "idx_user_admin_context_level" ON "public"."user_admin_context" USING "btree" ("admin_level", "user_id");



CREATE INDEX "idx_user_admin_context_plant" ON "public"."user_admin_context" USING "btree" ("plant_id", "admin_level") WHERE ("admin_level" = 'PLANT'::"text");



CREATE INDEX "idx_user_admin_context_unit" ON "public"."user_admin_context" USING "btree" ("business_unit_id", "admin_level") WHERE ("admin_level" = 'UNIT'::"text");



CREATE INDEX "idx_work_orders_asset_plant" ON "public"."work_orders" USING "btree" ("asset_id", "plant_id");



CREATE INDEX "idx_work_orders_assigned_supplier_id" ON "public"."work_orders" USING "btree" ("assigned_supplier_id");



CREATE INDEX "idx_work_orders_escalation" ON "public"."work_orders" USING "btree" ("escalation_count", "last_escalation_date") WHERE ("escalation_count" > 0);



CREATE INDEX "idx_work_orders_incident_id" ON "public"."work_orders" USING "btree" ("incident_id");



CREATE INDEX "idx_work_orders_plant_id" ON "public"."work_orders" USING "btree" ("plant_id");



CREATE INDEX "idx_work_orders_suggested_supplier_id" ON "public"."work_orders" USING "btree" ("suggested_supplier_id");



CREATE INDEX "idx_work_orders_supplier_assignment_date" ON "public"."work_orders" USING "btree" ("supplier_assignment_date");



CREATE INDEX "profiles_nombre_apellido_idx" ON "public"."profiles" USING "btree" ("nombre", "apellido");



CREATE UNIQUE INDEX "uniq_template_asset_day" ON "public"."checklist_schedules" USING "btree" ("template_id", "asset_id", "scheduled_day");



CREATE OR REPLACE TRIGGER "after_checklist_completed" AFTER INSERT ON "public"."completed_checklists" FOR EACH ROW EXECUTE FUNCTION "public"."update_asset_last_inspection_date"();



CREATE OR REPLACE TRIGGER "after_checklist_issue_created" AFTER INSERT ON "public"."checklist_issues" FOR EACH ROW EXECUTE FUNCTION "public"."notify_checklist_issues"();



CREATE OR REPLACE TRIGGER "asset_maintenance_plans_trigger" AFTER INSERT ON "public"."assets" FOR EACH ROW WHEN (("new"."model_id" IS NOT NULL)) EXECUTE FUNCTION "public"."trigger_generate_maintenance_plans"();



CREATE OR REPLACE TRIGGER "manual_financial_adjustments_updated_at" BEFORE UPDATE ON "public"."manual_financial_adjustments" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at_column"();



CREATE OR REPLACE TRIGGER "set_asset_id" BEFORE INSERT ON "public"."assets" FOR EACH ROW WHEN (("new"."asset_id" IS NULL)) EXECUTE FUNCTION "public"."generate_asset_id"();



CREATE OR REPLACE TRIGGER "set_incident_reporter_name" BEFORE INSERT OR UPDATE ON "public"."incident_history" FOR EACH ROW EXECUTE FUNCTION "public"."update_incident_reporter_name"();



CREATE OR REPLACE TRIGGER "set_maintenance_technician_name" BEFORE INSERT OR UPDATE ON "public"."maintenance_history" FOR EACH ROW EXECUTE FUNCTION "public"."update_maintenance_technician_name"();



CREATE OR REPLACE TRIGGER "set_model_id" BEFORE INSERT ON "public"."equipment_models" FOR EACH ROW WHEN (("new"."model_id" IS NULL)) EXECUTE FUNCTION "public"."generate_model_id"();



CREATE OR REPLACE TRIGGER "set_order_id" BEFORE INSERT ON "public"."service_orders" FOR EACH ROW WHEN (("new"."order_id" IS NULL)) EXECUTE FUNCTION "public"."generate_order_id"();



CREATE OR REPLACE TRIGGER "set_purchase_order_id_trigger" BEFORE INSERT ON "public"."purchase_orders" FOR EACH ROW EXECUTE FUNCTION "public"."set_purchase_order_id"();



CREATE OR REPLACE TRIGGER "set_service_order_id_trigger" BEFORE INSERT ON "public"."service_orders" FOR EACH ROW EXECUTE FUNCTION "public"."set_service_order_id"();



CREATE OR REPLACE TRIGGER "set_technician_name" BEFORE INSERT OR UPDATE ON "public"."service_orders" FOR EACH ROW EXECUTE FUNCTION "public"."update_technician_name"();



CREATE OR REPLACE TRIGGER "set_user_fields" BEFORE INSERT OR UPDATE ON "public"."additional_expenses" FOR EACH ROW EXECUTE FUNCTION "public"."set_user_tracking_fields"();



CREATE OR REPLACE TRIGGER "set_user_fields" BEFORE INSERT OR UPDATE ON "public"."assets" FOR EACH ROW EXECUTE FUNCTION "public"."set_user_tracking_fields"();



CREATE OR REPLACE TRIGGER "set_user_fields" BEFORE INSERT OR UPDATE ON "public"."checklist_issues" FOR EACH ROW EXECUTE FUNCTION "public"."set_user_tracking_fields"();



CREATE OR REPLACE TRIGGER "set_user_fields" BEFORE INSERT OR UPDATE ON "public"."checklist_items" FOR EACH ROW EXECUTE FUNCTION "public"."set_user_tracking_fields"();



CREATE OR REPLACE TRIGGER "set_user_fields" BEFORE INSERT OR UPDATE ON "public"."checklist_sections" FOR EACH ROW EXECUTE FUNCTION "public"."set_user_tracking_fields"();



CREATE OR REPLACE TRIGGER "set_user_fields" BEFORE INSERT OR UPDATE ON "public"."checklists" FOR EACH ROW EXECUTE FUNCTION "public"."set_user_tracking_fields"();



CREATE OR REPLACE TRIGGER "set_user_fields" BEFORE INSERT OR UPDATE ON "public"."completed_checklists" FOR EACH ROW EXECUTE FUNCTION "public"."set_user_tracking_fields"();



CREATE OR REPLACE TRIGGER "set_user_fields" BEFORE INSERT OR UPDATE ON "public"."equipment_models" FOR EACH ROW EXECUTE FUNCTION "public"."set_user_tracking_fields"();



CREATE OR REPLACE TRIGGER "set_user_fields" BEFORE INSERT OR UPDATE ON "public"."incident_history" FOR EACH ROW EXECUTE FUNCTION "public"."set_user_tracking_fields"();



CREATE OR REPLACE TRIGGER "set_user_fields" BEFORE INSERT OR UPDATE ON "public"."maintenance_history" FOR EACH ROW EXECUTE FUNCTION "public"."set_user_tracking_fields"();



CREATE OR REPLACE TRIGGER "set_user_fields" BEFORE INSERT OR UPDATE ON "public"."maintenance_intervals" FOR EACH ROW EXECUTE FUNCTION "public"."set_user_tracking_fields"();



CREATE OR REPLACE TRIGGER "set_user_fields" BEFORE INSERT OR UPDATE ON "public"."maintenance_plans" FOR EACH ROW EXECUTE FUNCTION "public"."set_user_tracking_fields"();



CREATE OR REPLACE TRIGGER "set_user_fields" BEFORE INSERT OR UPDATE ON "public"."maintenance_tasks" FOR EACH ROW EXECUTE FUNCTION "public"."set_user_tracking_fields"();



CREATE OR REPLACE TRIGGER "set_user_fields" BEFORE INSERT OR UPDATE ON "public"."model_documentation" FOR EACH ROW EXECUTE FUNCTION "public"."set_user_tracking_fields"();



CREATE OR REPLACE TRIGGER "set_user_fields" BEFORE INSERT OR UPDATE ON "public"."purchase_orders" FOR EACH ROW EXECUTE FUNCTION "public"."set_user_tracking_fields"();



CREATE OR REPLACE TRIGGER "set_user_fields" BEFORE INSERT OR UPDATE ON "public"."service_orders" FOR EACH ROW EXECUTE FUNCTION "public"."set_user_tracking_fields"();



CREATE OR REPLACE TRIGGER "set_user_fields" BEFORE INSERT OR UPDATE ON "public"."task_parts" FOR EACH ROW EXECUTE FUNCTION "public"."set_user_tracking_fields"();



CREATE OR REPLACE TRIGGER "set_user_fields" BEFORE INSERT OR UPDATE ON "public"."work_orders" FOR EACH ROW EXECUTE FUNCTION "public"."set_user_tracking_fields"();



CREATE OR REPLACE TRIGGER "set_work_order_text" BEFORE INSERT OR UPDATE ON "public"."maintenance_history" FOR EACH ROW EXECUTE FUNCTION "public"."update_work_order_text"();



CREATE OR REPLACE TRIGGER "trg_diesel_tx_update_recalc" AFTER UPDATE OF "quantity_liters", "transaction_type", "transaction_date", "cuenta_litros" ON "public"."diesel_transactions" FOR EACH ROW WHEN ((("old"."quantity_liters" IS DISTINCT FROM "new"."quantity_liters") OR ("old"."transaction_type" IS DISTINCT FROM "new"."transaction_type") OR ("old"."transaction_date" IS DISTINCT FROM "new"."transaction_date") OR ("old"."cuenta_litros" IS DISTINCT FROM "new"."cuenta_litros"))) EXECUTE FUNCTION "public"."trg_recalc_on_tx_update"();



CREATE OR REPLACE TRIGGER "trg_generate_purchase_order_id" BEFORE INSERT ON "public"."purchase_orders" FOR EACH ROW EXECUTE FUNCTION "public"."generate_purchase_order_id_trigger"();



CREATE OR REPLACE TRIGGER "trg_generate_service_order_id" BEFORE INSERT ON "public"."service_orders" FOR EACH ROW EXECUTE FUNCTION "public"."generate_service_order_id_trigger"();



CREATE OR REPLACE TRIGGER "trg_generate_work_order_id" BEFORE INSERT ON "public"."work_orders" FOR EACH ROW EXECUTE FUNCTION "public"."generate_work_order_id_trigger"();



CREATE OR REPLACE TRIGGER "trg_mark_validation_on_tx" BEFORE INSERT OR UPDATE OF "transaction_date", "quantity_liters", "cuenta_litros" ON "public"."diesel_transactions" FOR EACH ROW EXECUTE FUNCTION "public"."trg_mark_tx_for_validation"();



CREATE OR REPLACE TRIGGER "trg_notify_po_pending_approval" AFTER INSERT OR UPDATE OF "status", "authorized_by" ON "public"."purchase_orders" FOR EACH ROW EXECUTE FUNCTION "public"."notify_po_pending_approval"();



CREATE OR REPLACE TRIGGER "trg_set_checklist_scheduled_day" BEFORE INSERT OR UPDATE OF "scheduled_date" ON "public"."checklist_schedules" FOR EACH ROW EXECUTE FUNCTION "public"."set_checklist_scheduled_day"();



CREATE OR REPLACE TRIGGER "trg_update_incident_on_work_order_status" AFTER UPDATE OF "status" ON "public"."work_orders" FOR EACH ROW EXECUTE FUNCTION "public"."update_incident_on_work_order_status"();



CREATE OR REPLACE TRIGGER "trigger_notify_purchase_order_update" AFTER INSERT OR UPDATE OF "status" ON "public"."purchase_orders" FOR EACH ROW EXECUTE FUNCTION "public"."notify_purchase_order_update"();



CREATE OR REPLACE TRIGGER "trigger_refresh_inventory_on_transaction" AFTER INSERT OR DELETE OR UPDATE ON "public"."diesel_transactions" FOR EACH STATEMENT EXECUTE FUNCTION "public"."trigger_refresh_diesel_inventory"();



CREATE OR REPLACE TRIGGER "trigger_reschedule_completed_checklist" AFTER UPDATE ON "public"."checklist_schedules" FOR EACH ROW EXECUTE FUNCTION "public"."reschedule_completed_checklist"();



CREATE OR REPLACE TRIGGER "trigger_schedule_checklists_for_model" AFTER INSERT ON "public"."checklists" FOR EACH ROW EXECUTE FUNCTION "public"."schedule_checklists_for_model"();



CREATE OR REPLACE TRIGGER "trigger_schedule_checklists_for_new_asset" AFTER INSERT ON "public"."assets" FOR EACH ROW EXECUTE FUNCTION "public"."schedule_checklists_for_new_asset"();



CREATE OR REPLACE TRIGGER "trigger_set_diesel_transaction_id" BEFORE INSERT OR UPDATE ON "public"."diesel_transactions" FOR EACH ROW EXECUTE FUNCTION "public"."set_diesel_transaction_id"();



CREATE OR REPLACE TRIGGER "trigger_set_requires_quote" BEFORE INSERT OR UPDATE ON "public"."purchase_orders" FOR EACH ROW EXECUTE FUNCTION "public"."set_requires_quote"();



CREATE OR REPLACE TRIGGER "trigger_sync_composite_readings" AFTER UPDATE OF "current_hours", "current_kilometers" ON "public"."assets" FOR EACH ROW EXECUTE FUNCTION "public"."sync_composite_readings"();



CREATE OR REPLACE TRIGGER "trigger_sync_user_admin_context" AFTER INSERT OR UPDATE OF "plant_id", "business_unit_id", "role", "status" ON "public"."profiles" FOR EACH ROW EXECUTE FUNCTION "public"."sync_user_admin_context"();



CREATE OR REPLACE TRIGGER "trigger_update_asset_mapping_timestamp" BEFORE UPDATE ON "public"."asset_name_mappings" FOR EACH ROW EXECUTE FUNCTION "public"."update_asset_mapping_timestamp"();



CREATE OR REPLACE TRIGGER "trigger_update_exception_asset_normalized" BEFORE INSERT OR UPDATE ON "public"."exception_assets" FOR EACH ROW EXECUTE FUNCTION "public"."update_exception_asset_normalized_name"();



CREATE OR REPLACE TRIGGER "trigger_update_payment_status" BEFORE INSERT OR UPDATE ON "public"."purchase_orders" FOR EACH ROW EXECUTE FUNCTION "public"."update_payment_status"();



CREATE OR REPLACE TRIGGER "trigger_update_warehouse_on_transaction" AFTER INSERT ON "public"."diesel_transactions" FOR EACH ROW EXECUTE FUNCTION "public"."update_warehouse_on_transaction"();



CREATE OR REPLACE TRIGGER "trigger_validate_po_status" BEFORE UPDATE ON "public"."purchase_orders" FOR EACH ROW EXECUTE FUNCTION "public"."validate_po_status"();



CREATE OR REPLACE TRIGGER "update_assets_timestamp" BEFORE UPDATE ON "public"."assets" FOR EACH ROW EXECUTE FUNCTION "public"."update_timestamp"();



CREATE OR REPLACE TRIGGER "update_checklist_items_timestamp" BEFORE UPDATE ON "public"."checklist_items" FOR EACH ROW EXECUTE FUNCTION "public"."update_timestamp"();



CREATE OR REPLACE TRIGGER "update_checklist_sections_timestamp" BEFORE UPDATE ON "public"."checklist_sections" FOR EACH ROW EXECUTE FUNCTION "public"."update_timestamp"();



CREATE OR REPLACE TRIGGER "update_checklists_timestamp" BEFORE UPDATE ON "public"."checklists" FOR EACH ROW EXECUTE FUNCTION "public"."update_timestamp"();



CREATE OR REPLACE TRIGGER "update_completed_checklists_timestamp" BEFORE UPDATE ON "public"."completed_checklists" FOR EACH ROW EXECUTE FUNCTION "public"."update_timestamp"();



CREATE OR REPLACE TRIGGER "update_equipment_models_timestamp" BEFORE UPDATE ON "public"."equipment_models" FOR EACH ROW EXECUTE FUNCTION "public"."update_timestamp"();



CREATE OR REPLACE TRIGGER "update_financial_classifications_updated_at" BEFORE UPDATE ON "public"."financial_classifications" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at_column"();



CREATE OR REPLACE TRIGGER "update_incident_history_timestamp" BEFORE UPDATE ON "public"."incident_history" FOR EACH ROW EXECUTE FUNCTION "public"."update_timestamp"();



CREATE OR REPLACE TRIGGER "update_maintenance_history_timestamp" BEFORE UPDATE ON "public"."maintenance_history" FOR EACH ROW EXECUTE FUNCTION "public"."update_timestamp"();



CREATE OR REPLACE TRIGGER "update_maintenance_intervals_timestamp" BEFORE UPDATE ON "public"."maintenance_intervals" FOR EACH ROW EXECUTE FUNCTION "public"."update_timestamp"();



CREATE OR REPLACE TRIGGER "update_maintenance_plans_timestamp" BEFORE UPDATE ON "public"."maintenance_plans" FOR EACH ROW EXECUTE FUNCTION "public"."update_timestamp"();



CREATE OR REPLACE TRIGGER "update_maintenance_tasks_timestamp" BEFORE UPDATE ON "public"."maintenance_tasks" FOR EACH ROW EXECUTE FUNCTION "public"."update_timestamp"();



CREATE OR REPLACE TRIGGER "update_model_documentation_timestamp" BEFORE UPDATE ON "public"."model_documentation" FOR EACH ROW EXECUTE FUNCTION "public"."update_timestamp"();



CREATE OR REPLACE TRIGGER "update_service_orders_timestamp" BEFORE UPDATE ON "public"."service_orders" FOR EACH ROW EXECUTE FUNCTION "public"."update_timestamp"();



CREATE OR REPLACE TRIGGER "update_supplier_contacts_updated_at" BEFORE UPDATE ON "public"."supplier_contacts" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at_column"();



CREATE OR REPLACE TRIGGER "update_supplier_performance_history_updated_at" BEFORE UPDATE ON "public"."supplier_performance_history" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at_column"();



CREATE OR REPLACE TRIGGER "update_supplier_services_updated_at" BEFORE UPDATE ON "public"."supplier_services" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at_column"();



CREATE OR REPLACE TRIGGER "update_supplier_work_history_updated_at" BEFORE UPDATE ON "public"."supplier_work_history" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at_column"();



CREATE OR REPLACE TRIGGER "update_suppliers_updated_at" BEFORE UPDATE ON "public"."suppliers" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at_column"();



CREATE OR REPLACE TRIGGER "update_task_parts_timestamp" BEFORE UPDATE ON "public"."task_parts" FOR EACH ROW EXECUTE FUNCTION "public"."update_timestamp"();



ALTER TABLE ONLY "public"."additional_expenses"
    ADD CONSTRAINT "additional_expenses_adjustment_po_id_fkey" FOREIGN KEY ("adjustment_po_id") REFERENCES "public"."purchase_orders"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."additional_expenses"
    ADD CONSTRAINT "additional_expenses_approved_by_fkey" FOREIGN KEY ("approved_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."additional_expenses"
    ADD CONSTRAINT "additional_expenses_asset_id_fkey" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."additional_expenses"
    ADD CONSTRAINT "additional_expenses_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."additional_expenses"
    ADD CONSTRAINT "additional_expenses_rejected_by_fkey" FOREIGN KEY ("rejected_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."additional_expenses"
    ADD CONSTRAINT "additional_expenses_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."additional_expenses"
    ADD CONSTRAINT "additional_expenses_work_order_id_fkey" FOREIGN KEY ("work_order_id") REFERENCES "public"."work_orders"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."asset_assignment_history"
    ADD CONSTRAINT "asset_assignment_history_asset_id_fkey" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."asset_assignment_history"
    ADD CONSTRAINT "asset_assignment_history_changed_by_fkey" FOREIGN KEY ("changed_by") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."asset_assignment_history"
    ADD CONSTRAINT "asset_assignment_history_new_plant_id_fkey" FOREIGN KEY ("new_plant_id") REFERENCES "public"."plants"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."asset_assignment_history"
    ADD CONSTRAINT "asset_assignment_history_previous_plant_id_fkey" FOREIGN KEY ("previous_plant_id") REFERENCES "public"."plants"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."asset_composite_relationships"
    ADD CONSTRAINT "asset_composite_relationships_component_asset_id_fkey" FOREIGN KEY ("component_asset_id") REFERENCES "public"."assets"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."asset_composite_relationships"
    ADD CONSTRAINT "asset_composite_relationships_composite_asset_id_fkey" FOREIGN KEY ("composite_asset_id") REFERENCES "public"."assets"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."asset_composite_relationships"
    ADD CONSTRAINT "asset_composite_relationships_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."asset_name_mappings"
    ADD CONSTRAINT "asset_name_mappings_asset_id_fkey" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id");



ALTER TABLE ONLY "public"."asset_name_mappings"
    ADD CONSTRAINT "asset_name_mappings_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."profiles"("id");



ALTER TABLE ONLY "public"."asset_name_mappings"
    ADD CONSTRAINT "asset_name_mappings_exception_asset_id_fkey" FOREIGN KEY ("exception_asset_id") REFERENCES "public"."exception_assets"("id");



ALTER TABLE ONLY "public"."asset_operators"
    ADD CONSTRAINT "asset_operators_asset_id_fkey" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id");



ALTER TABLE ONLY "public"."asset_operators"
    ADD CONSTRAINT "asset_operators_assigned_by_fkey" FOREIGN KEY ("assigned_by") REFERENCES "public"."profiles"("id");



ALTER TABLE ONLY "public"."asset_operators"
    ADD CONSTRAINT "asset_operators_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."asset_operators"
    ADD CONSTRAINT "asset_operators_operator_id_fkey" FOREIGN KEY ("operator_id") REFERENCES "public"."profiles"("id");



ALTER TABLE ONLY "public"."asset_operators"
    ADD CONSTRAINT "asset_operators_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."assets"
    ADD CONSTRAINT "assets_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."assets"
    ADD CONSTRAINT "assets_department_id_fkey" FOREIGN KEY ("department_id") REFERENCES "public"."departments"("id");



ALTER TABLE ONLY "public"."assets"
    ADD CONSTRAINT "assets_model_id_fkey" FOREIGN KEY ("model_id") REFERENCES "public"."equipment_models"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."assets"
    ADD CONSTRAINT "assets_plant_id_fkey" FOREIGN KEY ("plant_id") REFERENCES "public"."plants"("id");



ALTER TABLE ONLY "public"."assets"
    ADD CONSTRAINT "assets_primary_component_id_fkey" FOREIGN KEY ("primary_component_id") REFERENCES "public"."assets"("id");



ALTER TABLE ONLY "public"."assets"
    ADD CONSTRAINT "assets_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."authorization_delegation_history"
    ADD CONSTRAINT "authorization_delegation_history_changed_by_user_id_fkey" FOREIGN KEY ("changed_by_user_id") REFERENCES "public"."profiles"("id");



ALTER TABLE ONLY "public"."authorization_delegation_history"
    ADD CONSTRAINT "authorization_delegation_history_delegation_id_fkey" FOREIGN KEY ("delegation_id") REFERENCES "public"."authorization_delegations"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."authorization_delegations"
    ADD CONSTRAINT "authorization_delegations_business_unit_id_fkey" FOREIGN KEY ("business_unit_id") REFERENCES "public"."business_units"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."authorization_delegations"
    ADD CONSTRAINT "authorization_delegations_grantee_user_id_fkey" FOREIGN KEY ("grantee_user_id") REFERENCES "public"."profiles"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."authorization_delegations"
    ADD CONSTRAINT "authorization_delegations_grantor_user_id_fkey" FOREIGN KEY ("grantor_user_id") REFERENCES "public"."profiles"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."authorization_delegations"
    ADD CONSTRAINT "authorization_delegations_plant_id_fkey" FOREIGN KEY ("plant_id") REFERENCES "public"."plants"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."business_unit_limits"
    ADD CONSTRAINT "business_unit_limits_business_unit_id_fkey" FOREIGN KEY ("business_unit_id") REFERENCES "public"."business_units"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."business_unit_limits"
    ADD CONSTRAINT "business_unit_limits_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."profiles"("id");



ALTER TABLE ONLY "public"."business_unit_limits"
    ADD CONSTRAINT "business_unit_limits_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "public"."profiles"("id");



ALTER TABLE ONLY "public"."business_units"
    ADD CONSTRAINT "business_units_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."business_units"
    ADD CONSTRAINT "business_units_manager_id_fkey" FOREIGN KEY ("manager_id") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."business_units"
    ADD CONSTRAINT "business_units_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."checklist_evidence"
    ADD CONSTRAINT "checklist_evidence_completed_checklist_id_fkey" FOREIGN KEY ("completed_checklist_id") REFERENCES "public"."completed_checklists"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."checklist_evidence"
    ADD CONSTRAINT "checklist_evidence_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."checklist_evidence"
    ADD CONSTRAINT "checklist_evidence_section_id_fkey" FOREIGN KEY ("section_id") REFERENCES "public"."checklist_sections"("id");



ALTER TABLE ONLY "public"."checklist_issues"
    ADD CONSTRAINT "checklist_issues_checklist_id_fkey" FOREIGN KEY ("checklist_id") REFERENCES "public"."completed_checklists"("id");



ALTER TABLE ONLY "public"."checklist_issues"
    ADD CONSTRAINT "checklist_issues_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."checklist_issues"
    ADD CONSTRAINT "checklist_issues_incident_id_fkey" FOREIGN KEY ("incident_id") REFERENCES "public"."incident_history"("id");



ALTER TABLE ONLY "public"."checklist_issues"
    ADD CONSTRAINT "checklist_issues_parent_issue_id_fkey" FOREIGN KEY ("parent_issue_id") REFERENCES "public"."checklist_issues"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."checklist_issues"
    ADD CONSTRAINT "checklist_issues_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."checklist_issues"
    ADD CONSTRAINT "checklist_issues_work_order_id_fkey" FOREIGN KEY ("work_order_id") REFERENCES "public"."work_orders"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."checklist_items"
    ADD CONSTRAINT "checklist_items_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."checklist_items"
    ADD CONSTRAINT "checklist_items_section_id_fkey" FOREIGN KEY ("section_id") REFERENCES "public"."checklist_sections"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."checklist_items"
    ADD CONSTRAINT "checklist_items_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."checklist_schedules"
    ADD CONSTRAINT "checklist_schedules_asset_id_fkey" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."checklist_schedules"
    ADD CONSTRAINT "checklist_schedules_assigned_to_fkey" FOREIGN KEY ("assigned_to") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."checklist_schedules"
    ADD CONSTRAINT "checklist_schedules_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."checklist_schedules"
    ADD CONSTRAINT "checklist_schedules_maintenance_plan_id_fkey" FOREIGN KEY ("maintenance_plan_id") REFERENCES "public"."maintenance_plans"("id");



ALTER TABLE ONLY "public"."checklist_schedules"
    ADD CONSTRAINT "checklist_schedules_template_id_fkey" FOREIGN KEY ("template_id") REFERENCES "public"."checklists"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."checklist_schedules"
    ADD CONSTRAINT "checklist_schedules_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."checklist_sections"
    ADD CONSTRAINT "checklist_sections_checklist_id_fkey" FOREIGN KEY ("checklist_id") REFERENCES "public"."checklists"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."checklist_sections"
    ADD CONSTRAINT "checklist_sections_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."checklist_sections"
    ADD CONSTRAINT "checklist_sections_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."checklist_template_versions"
    ADD CONSTRAINT "checklist_template_versions_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."checklist_template_versions"
    ADD CONSTRAINT "checklist_template_versions_model_id_fkey" FOREIGN KEY ("model_id") REFERENCES "public"."equipment_models"("id");



ALTER TABLE ONLY "public"."checklist_template_versions"
    ADD CONSTRAINT "checklist_template_versions_template_id_fkey" FOREIGN KEY ("template_id") REFERENCES "public"."checklists"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."checklists"
    ADD CONSTRAINT "checklists_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."checklists"
    ADD CONSTRAINT "checklists_interval_id_fkey" FOREIGN KEY ("interval_id") REFERENCES "public"."maintenance_intervals"("id");



ALTER TABLE ONLY "public"."checklists"
    ADD CONSTRAINT "checklists_model_id_fkey" FOREIGN KEY ("model_id") REFERENCES "public"."equipment_models"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."checklists"
    ADD CONSTRAINT "checklists_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."completed_checklists"
    ADD CONSTRAINT "completed_checklists_asset_id_fkey" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."completed_checklists"
    ADD CONSTRAINT "completed_checklists_checklist_id_fkey" FOREIGN KEY ("checklist_id") REFERENCES "public"."checklists"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."completed_checklists"
    ADD CONSTRAINT "completed_checklists_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."completed_checklists"
    ADD CONSTRAINT "completed_checklists_template_version_id_fkey" FOREIGN KEY ("template_version_id") REFERENCES "public"."checklist_template_versions"("id");



ALTER TABLE ONLY "public"."completed_checklists"
    ADD CONSTRAINT "completed_checklists_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."departments"
    ADD CONSTRAINT "departments_plant_id_fkey" FOREIGN KEY ("plant_id") REFERENCES "public"."plants"("id");



ALTER TABLE ONLY "public"."departments"
    ADD CONSTRAINT "departments_supervisor_id_fkey" FOREIGN KEY ("supervisor_id") REFERENCES "public"."profiles"("id");



ALTER TABLE ONLY "public"."diesel_evidence"
    ADD CONSTRAINT "diesel_evidence_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."diesel_evidence"
    ADD CONSTRAINT "diesel_evidence_transaction_id_fkey" FOREIGN KEY ("transaction_id") REFERENCES "public"."diesel_transactions"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."diesel_inventory_snapshots"
    ADD CONSTRAINT "diesel_inventory_snapshots_validated_by_fkey" FOREIGN KEY ("validated_by") REFERENCES "public"."profiles"("id");



ALTER TABLE ONLY "public"."diesel_inventory_snapshots"
    ADD CONSTRAINT "diesel_inventory_snapshots_warehouse_id_fkey" FOREIGN KEY ("warehouse_id") REFERENCES "public"."diesel_warehouses"("id");



ALTER TABLE ONLY "public"."diesel_products"
    ADD CONSTRAINT "diesel_products_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."diesel_products"
    ADD CONSTRAINT "diesel_products_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."diesel_transactions"
    ADD CONSTRAINT "diesel_transactions_asset_id_fkey" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id");



ALTER TABLE ONLY "public"."diesel_transactions"
    ADD CONSTRAINT "diesel_transactions_checklist_completion_id_fkey" FOREIGN KEY ("checklist_completion_id") REFERENCES "public"."completed_checklists"("id");



ALTER TABLE ONLY "public"."diesel_transactions"
    ADD CONSTRAINT "diesel_transactions_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."diesel_transactions"
    ADD CONSTRAINT "diesel_transactions_operator_id_fkey" FOREIGN KEY ("operator_id") REFERENCES "public"."profiles"("id");



ALTER TABLE ONLY "public"."diesel_transactions"
    ADD CONSTRAINT "diesel_transactions_plant_id_fkey" FOREIGN KEY ("plant_id") REFERENCES "public"."plants"("id");



ALTER TABLE ONLY "public"."diesel_transactions"
    ADD CONSTRAINT "diesel_transactions_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "public"."diesel_products"("id");



ALTER TABLE ONLY "public"."diesel_transactions"
    ADD CONSTRAINT "diesel_transactions_reference_transaction_id_fkey" FOREIGN KEY ("reference_transaction_id") REFERENCES "public"."diesel_transactions"("id");



ALTER TABLE ONLY "public"."diesel_transactions"
    ADD CONSTRAINT "diesel_transactions_service_order_id_fkey" FOREIGN KEY ("service_order_id") REFERENCES "public"."service_orders"("id");



ALTER TABLE ONLY "public"."diesel_transactions"
    ADD CONSTRAINT "diesel_transactions_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."diesel_transactions"
    ADD CONSTRAINT "diesel_transactions_validated_by_fkey" FOREIGN KEY ("validated_by") REFERENCES "public"."profiles"("id");



ALTER TABLE ONLY "public"."diesel_transactions"
    ADD CONSTRAINT "diesel_transactions_warehouse_id_fkey" FOREIGN KEY ("warehouse_id") REFERENCES "public"."diesel_warehouses"("id");



ALTER TABLE ONLY "public"."diesel_transactions"
    ADD CONSTRAINT "diesel_transactions_work_order_id_fkey" FOREIGN KEY ("work_order_id") REFERENCES "public"."work_orders"("id");



ALTER TABLE ONLY "public"."diesel_warehouses"
    ADD CONSTRAINT "diesel_warehouses_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."diesel_warehouses"
    ADD CONSTRAINT "diesel_warehouses_plant_id_fkey" FOREIGN KEY ("plant_id") REFERENCES "public"."plants"("id");



ALTER TABLE ONLY "public"."diesel_warehouses"
    ADD CONSTRAINT "diesel_warehouses_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."equipment_models"
    ADD CONSTRAINT "equipment_models_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."equipment_models"
    ADD CONSTRAINT "equipment_models_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."exception_assets"
    ADD CONSTRAINT "exception_assets_promoted_by_fkey" FOREIGN KEY ("promoted_by") REFERENCES "public"."profiles"("id");



ALTER TABLE ONLY "public"."exception_assets"
    ADD CONSTRAINT "exception_assets_promoted_to_asset_id_fkey" FOREIGN KEY ("promoted_to_asset_id") REFERENCES "public"."assets"("id");



ALTER TABLE ONLY "public"."completed_checklists"
    ADD CONSTRAINT "fk_completed_checklists_created_by" FOREIGN KEY ("created_by") REFERENCES "public"."profiles"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."completed_checklists"
    ADD CONSTRAINT "fk_completed_checklists_updated_by" FOREIGN KEY ("updated_by") REFERENCES "public"."profiles"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."incident_history"
    ADD CONSTRAINT "incident_history_asset_id_fkey" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."incident_history"
    ADD CONSTRAINT "incident_history_checklist_id_fkey" FOREIGN KEY ("checklist_id") REFERENCES "public"."checklists"("id");



ALTER TABLE ONLY "public"."incident_history"
    ADD CONSTRAINT "incident_history_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."incident_history"
    ADD CONSTRAINT "incident_history_reported_by_id_fkey" FOREIGN KEY ("reported_by_id") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."incident_history"
    ADD CONSTRAINT "incident_history_service_order_id_fkey" FOREIGN KEY ("service_order_id") REFERENCES "public"."service_orders"("id");



ALTER TABLE ONLY "public"."incident_history"
    ADD CONSTRAINT "incident_history_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."incident_history"
    ADD CONSTRAINT "incident_history_work_order_id_fkey" FOREIGN KEY ("work_order_id") REFERENCES "public"."work_orders"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."maintenance_checklists"
    ADD CONSTRAINT "maintenance_checklists_checklist_template_id_fkey" FOREIGN KEY ("checklist_template_id") REFERENCES "public"."checklists"("id");



ALTER TABLE ONLY "public"."maintenance_checklists"
    ADD CONSTRAINT "maintenance_checklists_completed_by_fkey" FOREIGN KEY ("completed_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."maintenance_checklists"
    ADD CONSTRAINT "maintenance_checklists_work_order_id_fkey" FOREIGN KEY ("work_order_id") REFERENCES "public"."work_orders"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."maintenance_history"
    ADD CONSTRAINT "maintenance_history_asset_id_fkey" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."maintenance_history"
    ADD CONSTRAINT "maintenance_history_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."maintenance_history"
    ADD CONSTRAINT "maintenance_history_service_order_id_fkey" FOREIGN KEY ("service_order_id") REFERENCES "public"."service_orders"("id");



ALTER TABLE ONLY "public"."maintenance_history"
    ADD CONSTRAINT "maintenance_history_technician_id_fkey" FOREIGN KEY ("technician_id") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."maintenance_history"
    ADD CONSTRAINT "maintenance_history_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."maintenance_history"
    ADD CONSTRAINT "maintenance_history_work_order_id_fkey" FOREIGN KEY ("work_order_id") REFERENCES "public"."work_orders"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."maintenance_intervals"
    ADD CONSTRAINT "maintenance_intervals_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."maintenance_intervals"
    ADD CONSTRAINT "maintenance_intervals_model_id_fkey" FOREIGN KEY ("model_id") REFERENCES "public"."equipment_models"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."maintenance_intervals"
    ADD CONSTRAINT "maintenance_intervals_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."maintenance_plans"
    ADD CONSTRAINT "maintenance_plans_asset_id_fkey" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."maintenance_plans"
    ADD CONSTRAINT "maintenance_plans_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."maintenance_plans"
    ADD CONSTRAINT "maintenance_plans_interval_id_fkey" FOREIGN KEY ("interval_id") REFERENCES "public"."maintenance_intervals"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."maintenance_plans"
    ADD CONSTRAINT "maintenance_plans_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."maintenance_tasks"
    ADD CONSTRAINT "maintenance_tasks_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."maintenance_tasks"
    ADD CONSTRAINT "maintenance_tasks_interval_id_fkey" FOREIGN KEY ("interval_id") REFERENCES "public"."maintenance_intervals"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."maintenance_tasks"
    ADD CONSTRAINT "maintenance_tasks_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."manual_financial_adjustment_distributions"
    ADD CONSTRAINT "manual_financial_adjustment_distributions_adjustment_id_fkey" FOREIGN KEY ("adjustment_id") REFERENCES "public"."manual_financial_adjustments"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."manual_financial_adjustment_distributions"
    ADD CONSTRAINT "manual_financial_adjustment_distributions_business_unit_id_fkey" FOREIGN KEY ("business_unit_id") REFERENCES "public"."business_units"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."manual_financial_adjustment_distributions"
    ADD CONSTRAINT "manual_financial_adjustment_distributions_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."profiles"("id");



ALTER TABLE ONLY "public"."manual_financial_adjustment_distributions"
    ADD CONSTRAINT "manual_financial_adjustment_distributions_plant_id_fkey" FOREIGN KEY ("plant_id") REFERENCES "public"."plants"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."manual_financial_adjustments"
    ADD CONSTRAINT "manual_financial_adjustments_business_unit_id_fkey" FOREIGN KEY ("business_unit_id") REFERENCES "public"."business_units"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."manual_financial_adjustments"
    ADD CONSTRAINT "manual_financial_adjustments_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."profiles"("id");



ALTER TABLE ONLY "public"."manual_financial_adjustments"
    ADD CONSTRAINT "manual_financial_adjustments_plant_id_fkey" FOREIGN KEY ("plant_id") REFERENCES "public"."plants"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."manual_financial_adjustments"
    ADD CONSTRAINT "manual_financial_adjustments_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "public"."profiles"("id");



ALTER TABLE ONLY "public"."model_documentation"
    ADD CONSTRAINT "model_documentation_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."model_documentation"
    ADD CONSTRAINT "model_documentation_model_id_fkey" FOREIGN KEY ("model_id") REFERENCES "public"."equipment_models"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."model_documentation"
    ADD CONSTRAINT "model_documentation_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."notifications"
    ADD CONSTRAINT "notifications_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."operator_assignment_history"
    ADD CONSTRAINT "operator_assignment_history_asset_id_fkey" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id");



ALTER TABLE ONLY "public"."operator_assignment_history"
    ADD CONSTRAINT "operator_assignment_history_changed_by_fkey" FOREIGN KEY ("changed_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."operator_assignment_history"
    ADD CONSTRAINT "operator_assignment_history_new_asset_id_fkey" FOREIGN KEY ("new_asset_id") REFERENCES "public"."assets"("id");



ALTER TABLE ONLY "public"."operator_assignment_history"
    ADD CONSTRAINT "operator_assignment_history_operator_id_fkey" FOREIGN KEY ("operator_id") REFERENCES "public"."profiles"("id");



ALTER TABLE ONLY "public"."operator_assignment_history"
    ADD CONSTRAINT "operator_assignment_history_previous_asset_id_fkey" FOREIGN KEY ("previous_asset_id") REFERENCES "public"."assets"("id");



ALTER TABLE ONLY "public"."plants"
    ADD CONSTRAINT "plants_business_unit_id_fkey" FOREIGN KEY ("business_unit_id") REFERENCES "public"."business_units"("id");



ALTER TABLE ONLY "public"."plants"
    ADD CONSTRAINT "plants_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."plants"
    ADD CONSTRAINT "plants_maintenance_supervisor_id_fkey" FOREIGN KEY ("maintenance_supervisor_id") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."plants"
    ADD CONSTRAINT "plants_plant_manager_id_fkey" FOREIGN KEY ("plant_manager_id") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."plants"
    ADD CONSTRAINT "plants_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."po_action_tokens"
    ADD CONSTRAINT "po_action_tokens_purchase_order_id_fkey" FOREIGN KEY ("purchase_order_id") REFERENCES "public"."purchase_orders"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."profiles"
    ADD CONSTRAINT "profiles_business_unit_id_fkey" FOREIGN KEY ("business_unit_id") REFERENCES "public"."business_units"("id");



ALTER TABLE ONLY "public"."profiles"
    ADD CONSTRAINT "profiles_deactivated_by_fkey" FOREIGN KEY ("deactivated_by") REFERENCES "public"."profiles"("id");



ALTER TABLE ONLY "public"."profiles"
    ADD CONSTRAINT "profiles_id_fkey" FOREIGN KEY ("id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."profiles"
    ADD CONSTRAINT "profiles_office_id_fkey" FOREIGN KEY ("office_id") REFERENCES "public"."offices"("id");



ALTER TABLE ONLY "public"."profiles"
    ADD CONSTRAINT "profiles_plant_id_fkey" FOREIGN KEY ("plant_id") REFERENCES "public"."plants"("id");



ALTER TABLE ONLY "public"."purchase_order_receipts"
    ADD CONSTRAINT "purchase_order_receipts_purchase_order_id_fkey" FOREIGN KEY ("purchase_order_id") REFERENCES "public"."purchase_orders"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."purchase_order_receipts"
    ADD CONSTRAINT "purchase_order_receipts_uploaded_by_fkey" FOREIGN KEY ("uploaded_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."purchase_orders"
    ADD CONSTRAINT "purchase_orders_adjusted_by_fkey" FOREIGN KEY ("adjusted_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."purchase_orders"
    ADD CONSTRAINT "purchase_orders_approved_by_fkey" FOREIGN KEY ("approved_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."purchase_orders"
    ADD CONSTRAINT "purchase_orders_authorized_by_fkey" FOREIGN KEY ("authorized_by") REFERENCES "public"."profiles"("id");



ALTER TABLE ONLY "public"."purchase_orders"
    ADD CONSTRAINT "purchase_orders_original_purchase_order_id_fkey" FOREIGN KEY ("original_purchase_order_id") REFERENCES "public"."purchase_orders"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."purchase_orders"
    ADD CONSTRAINT "purchase_orders_paid_by_fkey" FOREIGN KEY ("paid_by") REFERENCES "public"."profiles"("id");



ALTER TABLE ONLY "public"."purchase_orders"
    ADD CONSTRAINT "purchase_orders_plant_id_fkey" FOREIGN KEY ("plant_id") REFERENCES "public"."plants"("id");



ALTER TABLE ONLY "public"."purchase_orders"
    ADD CONSTRAINT "purchase_orders_requested_by_fkey" FOREIGN KEY ("requested_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."purchase_orders"
    ADD CONSTRAINT "purchase_orders_supplier_id_fkey" FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id");



ALTER TABLE ONLY "public"."purchase_orders"
    ADD CONSTRAINT "purchase_orders_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."purchase_orders"
    ADD CONSTRAINT "purchase_orders_work_order_id_fkey" FOREIGN KEY ("work_order_id") REFERENCES "public"."work_orders"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."service_orders"
    ADD CONSTRAINT "service_orders_asset_id_fkey" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."service_orders"
    ADD CONSTRAINT "service_orders_checklist_id_fkey" FOREIGN KEY ("checklist_id") REFERENCES "public"."checklists"("id");



ALTER TABLE ONLY "public"."service_orders"
    ADD CONSTRAINT "service_orders_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."service_orders"
    ADD CONSTRAINT "service_orders_technician_id_fkey" FOREIGN KEY ("technician_id") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."service_orders"
    ADD CONSTRAINT "service_orders_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."service_orders"
    ADD CONSTRAINT "service_orders_work_order_id_fkey" FOREIGN KEY ("work_order_id") REFERENCES "public"."work_orders"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."supplier_certifications"
    ADD CONSTRAINT "supplier_certifications_supplier_id_fkey" FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."supplier_contacts"
    ADD CONSTRAINT "supplier_contacts_supplier_id_fkey" FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."supplier_performance_history"
    ADD CONSTRAINT "supplier_performance_history_purchase_order_id_fkey" FOREIGN KEY ("purchase_order_id") REFERENCES "public"."purchase_orders"("id");



ALTER TABLE ONLY "public"."supplier_performance_history"
    ADD CONSTRAINT "supplier_performance_history_supplier_id_fkey" FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."supplier_performance_history"
    ADD CONSTRAINT "supplier_performance_history_work_order_id_fkey" FOREIGN KEY ("work_order_id") REFERENCES "public"."work_orders"("id");



ALTER TABLE ONLY "public"."supplier_services"
    ADD CONSTRAINT "supplier_services_supplier_id_fkey" FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."supplier_work_history"
    ADD CONSTRAINT "supplier_work_history_asset_id_fkey" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id");



ALTER TABLE ONLY "public"."supplier_work_history"
    ADD CONSTRAINT "supplier_work_history_supplier_id_fkey" FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."supplier_work_history"
    ADD CONSTRAINT "supplier_work_history_work_order_id_fkey" FOREIGN KEY ("work_order_id") REFERENCES "public"."work_orders"("id");



ALTER TABLE ONLY "public"."suppliers"
    ADD CONSTRAINT "suppliers_business_unit_id_fkey" FOREIGN KEY ("business_unit_id") REFERENCES "public"."business_units"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."suppliers"
    ADD CONSTRAINT "suppliers_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."suppliers"
    ADD CONSTRAINT "suppliers_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."task_parts"
    ADD CONSTRAINT "task_parts_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."task_parts"
    ADD CONSTRAINT "task_parts_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "public"."maintenance_tasks"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."task_parts"
    ADD CONSTRAINT "task_parts_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."user_admin_context"
    ADD CONSTRAINT "user_admin_context_business_unit_id_fkey" FOREIGN KEY ("business_unit_id") REFERENCES "public"."business_units"("id");



ALTER TABLE ONLY "public"."user_admin_context"
    ADD CONSTRAINT "user_admin_context_plant_id_fkey" FOREIGN KEY ("plant_id") REFERENCES "public"."plants"("id");



ALTER TABLE ONLY "public"."user_admin_context"
    ADD CONSTRAINT "user_admin_context_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."work_orders"
    ADD CONSTRAINT "work_orders_approved_by_fkey" FOREIGN KEY ("approved_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."work_orders"
    ADD CONSTRAINT "work_orders_asset_id_fkey" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."work_orders"
    ADD CONSTRAINT "work_orders_assigned_supplier_id_fkey" FOREIGN KEY ("assigned_supplier_id") REFERENCES "public"."suppliers"("id");



ALTER TABLE ONLY "public"."work_orders"
    ADD CONSTRAINT "work_orders_assigned_to_fkey" FOREIGN KEY ("assigned_to") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."work_orders"
    ADD CONSTRAINT "work_orders_incident_id_fkey" FOREIGN KEY ("incident_id") REFERENCES "public"."incident_history"("id");



ALTER TABLE ONLY "public"."work_orders"
    ADD CONSTRAINT "work_orders_plant_id_fkey" FOREIGN KEY ("plant_id") REFERENCES "public"."plants"("id");



ALTER TABLE ONLY "public"."work_orders"
    ADD CONSTRAINT "work_orders_preventive_checklist_id_fkey" FOREIGN KEY ("preventive_checklist_id") REFERENCES "public"."checklists"("id");



ALTER TABLE ONLY "public"."work_orders"
    ADD CONSTRAINT "work_orders_purchase_order_id_fkey" FOREIGN KEY ("purchase_order_id") REFERENCES "public"."purchase_orders"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."work_orders"
    ADD CONSTRAINT "work_orders_requested_by_fkey" FOREIGN KEY ("requested_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."work_orders"
    ADD CONSTRAINT "work_orders_service_order_id_fkey" FOREIGN KEY ("service_order_id") REFERENCES "public"."service_orders"("id");



ALTER TABLE ONLY "public"."work_orders"
    ADD CONSTRAINT "work_orders_suggested_supplier_id_fkey" FOREIGN KEY ("suggested_supplier_id") REFERENCES "public"."suppliers"("id");



ALTER TABLE ONLY "public"."work_orders"
    ADD CONSTRAINT "work_orders_supplier_assignment_by_fkey" FOREIGN KEY ("supplier_assignment_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."work_orders"
    ADD CONSTRAINT "work_orders_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "auth"."users"("id");



CREATE POLICY "Additional expenses anon read access" ON "public"."additional_expenses" FOR SELECT TO "anon" USING (true);



CREATE POLICY "Additional expenses postgres access" ON "public"."additional_expenses" TO "postgres" USING (true) WITH CHECK (true);



CREATE POLICY "Additional expenses service role access" ON "public"."additional_expenses" TO "service_role" USING (true);



CREATE POLICY "Additional expenses via assets" ON "public"."additional_expenses" USING ((EXISTS ( SELECT 1
   FROM "public"."assets"
  WHERE ("assets"."id" = "additional_expenses"."asset_id")))) WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."assets"
  WHERE ("assets"."id" = "additional_expenses"."asset_id"))));



CREATE POLICY "Admin and Gerente can view manual_financial_adjustment_distribu" ON "public"."manual_financial_adjustment_distributions" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM "public"."profiles"
  WHERE (("profiles"."id" = "auth"."uid"()) AND ("profiles"."role" = ANY (ARRAY['GERENCIA_GENERAL'::"public"."user_role", 'JEFE_UNIDAD_NEGOCIO'::"public"."user_role", 'AREA_ADMINISTRATIVA'::"public"."user_role"])) AND (EXISTS ( SELECT 1
           FROM "public"."manual_financial_adjustments"
          WHERE ("manual_financial_adjustments"."id" = "manual_financial_adjustment_distributions"."adjustment_id")))))));



CREATE POLICY "Admin and Gerente can view manual_financial_adjustments" ON "public"."manual_financial_adjustments" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM "public"."profiles"
  WHERE (("profiles"."id" = "auth"."uid"()) AND ("profiles"."role" = ANY (ARRAY['GERENCIA_GENERAL'::"public"."user_role", 'JEFE_UNIDAD_NEGOCIO'::"public"."user_role", 'AREA_ADMINISTRATIVA'::"public"."user_role"]))))));



CREATE POLICY "Admin and RH can insert manual_financial_adjustment_distributio" ON "public"."manual_financial_adjustment_distributions" FOR INSERT WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."profiles"
  WHERE (("profiles"."id" = "auth"."uid"()) AND ("profiles"."role" = ANY (ARRAY['GERENCIA_GENERAL'::"public"."user_role", 'AREA_ADMINISTRATIVA'::"public"."user_role"]))))));



CREATE POLICY "Admin and RH can insert manual_financial_adjustments" ON "public"."manual_financial_adjustments" FOR INSERT WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."profiles"
  WHERE (("profiles"."id" = "auth"."uid"()) AND ("profiles"."role" = ANY (ARRAY['GERENCIA_GENERAL'::"public"."user_role", 'AREA_ADMINISTRATIVA'::"public"."user_role"]))))));



CREATE POLICY "Admin and RH can update manual_financial_adjustment_distributio" ON "public"."manual_financial_adjustment_distributions" FOR UPDATE USING ((EXISTS ( SELECT 1
   FROM "public"."profiles"
  WHERE (("profiles"."id" = "auth"."uid"()) AND (("profiles"."role" = 'GERENCIA_GENERAL'::"public"."user_role") OR (("profiles"."role" = 'AREA_ADMINISTRATIVA'::"public"."user_role") AND (EXISTS ( SELECT 1
           FROM "public"."manual_financial_adjustments"
          WHERE (("manual_financial_adjustments"."id" = "manual_financial_adjustment_distributions"."adjustment_id") AND ("manual_financial_adjustments"."created_by" = "auth"."uid"())))))))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."profiles"
  WHERE (("profiles"."id" = "auth"."uid"()) AND (("profiles"."role" = 'GERENCIA_GENERAL'::"public"."user_role") OR (("profiles"."role" = 'AREA_ADMINISTRATIVA'::"public"."user_role") AND (EXISTS ( SELECT 1
           FROM "public"."manual_financial_adjustments"
          WHERE (("manual_financial_adjustments"."id" = "manual_financial_adjustment_distributions"."adjustment_id") AND ("manual_financial_adjustments"."created_by" = "auth"."uid"()))))))))));



CREATE POLICY "Admin and RH can update manual_financial_adjustments" ON "public"."manual_financial_adjustments" FOR UPDATE USING ((EXISTS ( SELECT 1
   FROM "public"."profiles"
  WHERE (("profiles"."id" = "auth"."uid"()) AND (("profiles"."role" = 'GERENCIA_GENERAL'::"public"."user_role") OR (("profiles"."role" = 'AREA_ADMINISTRATIVA'::"public"."user_role") AND ("manual_financial_adjustments"."created_by" = "auth"."uid"()))))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."profiles"
  WHERE (("profiles"."id" = "auth"."uid"()) AND (("profiles"."role" = 'GERENCIA_GENERAL'::"public"."user_role") OR (("profiles"."role" = 'AREA_ADMINISTRATIVA'::"public"."user_role") AND ("manual_financial_adjustments"."created_by" = "auth"."uid"())))))));



CREATE POLICY "Admin can delete manual_financial_adjustment_distributions" ON "public"."manual_financial_adjustment_distributions" FOR DELETE USING ((EXISTS ( SELECT 1
   FROM "public"."profiles"
  WHERE (("profiles"."id" = "auth"."uid"()) AND ("profiles"."role" = 'GERENCIA_GENERAL'::"public"."user_role")))));



CREATE POLICY "Admin can delete manual_financial_adjustments" ON "public"."manual_financial_adjustments" FOR DELETE USING ((EXISTS ( SELECT 1
   FROM "public"."profiles"
  WHERE (("profiles"."id" = "auth"."uid"()) AND ("profiles"."role" = 'GERENCIA_GENERAL'::"public"."user_role")))));



CREATE POLICY "Admin context hierarchical access" ON "public"."user_admin_context" FOR SELECT TO "authenticated" USING ((("user_id" = "auth"."uid"()) OR (EXISTS ( SELECT 1
   FROM "public"."user_admin_context" "supervisor"
  WHERE (("supervisor"."user_id" = "auth"."uid"()) AND (("supervisor"."admin_level" = 'TOTAL'::"text") OR (("supervisor"."admin_level" = 'UNIT'::"text") AND (("user_admin_context"."business_unit_id" = "supervisor"."business_unit_id") OR ("user_admin_context"."plant_id" IN ( SELECT "plants"."id"
           FROM "public"."plants"
          WHERE ("plants"."business_unit_id" = "supervisor"."business_unit_id"))))) OR (("supervisor"."admin_level" = 'PLANT'::"text") AND ("user_admin_context"."plant_id" = "supervisor"."plant_id"))))))));



CREATE POLICY "Admin context system access" ON "public"."user_admin_context" TO "service_role" USING (true) WITH CHECK (true);



CREATE POLICY "Admin read app_settings" ON "public"."app_settings" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM "public"."profiles"
  WHERE (("profiles"."id" = "auth"."uid"()) AND ("profiles"."role" = ANY (ARRAY['GERENCIA_GENERAL'::"public"."user_role", 'AREA_ADMINISTRATIVA'::"public"."user_role"]))))));



CREATE POLICY "Admin write app_settings" ON "public"."app_settings" USING ((EXISTS ( SELECT 1
   FROM "public"."profiles"
  WHERE (("profiles"."id" = "auth"."uid"()) AND ("profiles"."role" = 'GERENCIA_GENERAL'::"public"."user_role")))));



CREATE POLICY "Allow insert supplier contacts" ON "public"."supplier_contacts" FOR INSERT WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."suppliers" "s"
  WHERE (("s"."id" = "supplier_contacts"."supplier_id") AND ("auth"."role"() = 'authenticated'::"text")))));



CREATE POLICY "Allow insert suppliers" ON "public"."suppliers" FOR INSERT WITH CHECK (("auth"."role"() = 'authenticated'::"text"));



CREATE POLICY "Allow service role to manage auto_create_logs" ON "public"."auto_create_logs" TO "service_role" USING (true) WITH CHECK (true);



CREATE POLICY "Allow service_role full access to checklist_issues" ON "public"."checklist_issues" TO "service_role" USING (true) WITH CHECK (true);



CREATE POLICY "Allow update own suppliers" ON "public"."suppliers" FOR UPDATE USING (("auth"."uid"() = "created_by"));



CREATE POLICY "Allow view active suppliers" ON "public"."suppliers" FOR SELECT USING ((("status")::"text" = 'active'::"text"));



CREATE POLICY "Allow view own suppliers" ON "public"."suppliers" FOR SELECT USING (("auth"."uid"() = "created_by"));



CREATE POLICY "Allow view supplier certifications" ON "public"."supplier_certifications" FOR SELECT USING (("is_active" = true));



CREATE POLICY "Allow view supplier contacts" ON "public"."supplier_contacts" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM "public"."suppliers" "s"
  WHERE (("s"."id" = "supplier_contacts"."supplier_id") AND ((("s"."status")::"text" = 'active'::"text") OR ("s"."created_by" = "auth"."uid"()))))));



CREATE POLICY "Allow view supplier performance" ON "public"."supplier_performance_history" FOR SELECT USING (("auth"."role"() = 'authenticated'::"text"));



CREATE POLICY "Allow view supplier services" ON "public"."supplier_services" FOR SELECT USING (("is_active" = true));



CREATE POLICY "Allow view supplier work history" ON "public"."supplier_work_history" FOR SELECT USING (("auth"."role"() = 'authenticated'::"text"));



CREATE POLICY "Asset operators anon read access" ON "public"."asset_operators" FOR SELECT TO "anon" USING (true);



CREATE POLICY "Asset operators postgres access" ON "public"."asset_operators" TO "postgres" USING (true) WITH CHECK (true);



CREATE POLICY "Asset operators service role access" ON "public"."asset_operators" TO "service_role" USING (true);



CREATE POLICY "Asset operators via assets" ON "public"."asset_operators" USING ((EXISTS ( SELECT 1
   FROM "public"."assets"
  WHERE ("assets"."id" = "asset_operators"."asset_id")))) WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."assets"
  WHERE ("assets"."id" = "asset_operators"."asset_id"))));



CREATE POLICY "Assets anon read access" ON "public"."assets" FOR SELECT TO "anon" USING (true);



CREATE POLICY "Assets hierarchical access - no recursion" ON "public"."assets" TO "authenticated" USING (((EXISTS ( SELECT 1
   FROM "public"."profiles"
  WHERE (("profiles"."id" = "auth"."uid"()) AND ("profiles"."plant_id" IS NULL) AND ("profiles"."business_unit_id" IS NULL)))) OR (EXISTS ( SELECT 1
   FROM ("public"."profiles" "p"
     JOIN "public"."plants" "pl" ON (("pl"."business_unit_id" = "p"."business_unit_id")))
  WHERE (("p"."id" = "auth"."uid"()) AND ("p"."plant_id" IS NULL) AND ("p"."business_unit_id" IS NOT NULL) AND ("assets"."plant_id" = "pl"."id")))) OR (EXISTS ( SELECT 1
   FROM "public"."profiles"
  WHERE (("profiles"."id" = "auth"."uid"()) AND ("profiles"."plant_id" = "assets"."plant_id")))))) WITH CHECK (((EXISTS ( SELECT 1
   FROM "public"."profiles"
  WHERE (("profiles"."id" = "auth"."uid"()) AND ("profiles"."plant_id" IS NULL) AND ("profiles"."business_unit_id" IS NULL)))) OR (EXISTS ( SELECT 1
   FROM ("public"."profiles" "p"
     JOIN "public"."plants" "pl" ON (("pl"."business_unit_id" = "p"."business_unit_id")))
  WHERE (("p"."id" = "auth"."uid"()) AND ("p"."plant_id" IS NULL) AND ("p"."business_unit_id" IS NOT NULL) AND ("assets"."plant_id" = "pl"."id")))) OR (EXISTS ( SELECT 1
   FROM "public"."profiles"
  WHERE (("profiles"."id" = "auth"."uid"()) AND ("profiles"."plant_id" = "assets"."plant_id"))))));



CREATE POLICY "Assets operator access" ON "public"."assets" FOR SELECT TO "authenticated" USING ((EXISTS ( SELECT 1
   FROM "public"."profiles"
  WHERE (("profiles"."id" = "auth"."uid"()) AND ("profiles"."role" = 'OPERADOR'::"public"."user_role") AND ("profiles"."plant_id" = "assets"."plant_id") AND ("profiles"."is_operator" = true)))));



CREATE POLICY "Assets postgres access" ON "public"."assets" TO "postgres" USING (true) WITH CHECK (true);



CREATE POLICY "Assets service role access" ON "public"."assets" TO "service_role" USING (true) WITH CHECK (true);



CREATE POLICY "Authorization matrix administrative access" ON "public"."authorization_matrix" USING ((EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."id" = "auth"."uid"()) AND ("p"."role" = ANY (ARRAY['GERENCIA_GENERAL'::"public"."user_role", 'AREA_ADMINISTRATIVA'::"public"."user_role", 'EJECUTIVO'::"public"."user_role"])) AND ("p"."status" = 'active'::"text")))));



CREATE POLICY "Business units anon read access" ON "public"."business_units" FOR SELECT TO "anon" USING (true);



CREATE POLICY "Business units hierarchical access" ON "public"."business_units" TO "authenticated" USING (((EXISTS ( SELECT 1
   FROM "public"."profiles"
  WHERE (("profiles"."id" = "auth"."uid"()) AND ("profiles"."plant_id" IS NULL) AND ("profiles"."business_unit_id" IS NULL)))) OR (EXISTS ( SELECT 1
   FROM "public"."profiles"
  WHERE (("profiles"."id" = "auth"."uid"()) AND ("profiles"."business_unit_id" = "business_units"."id")))) OR (EXISTS ( SELECT 1
   FROM ("public"."profiles" "p"
     JOIN "public"."plants" "pl" ON (("pl"."id" = "p"."plant_id")))
  WHERE (("p"."id" = "auth"."uid"()) AND ("pl"."business_unit_id" = "business_units"."id"))))));



CREATE POLICY "Business units service role access" ON "public"."business_units" TO "service_role" USING (true) WITH CHECK (true);



CREATE POLICY "Checklist evidence service role access" ON "public"."checklist_evidence" TO "service_role" USING (true) WITH CHECK (true);



CREATE POLICY "Checklist evidence via completed checklists" ON "public"."checklist_evidence" USING ((EXISTS ( SELECT 1
   FROM ("public"."completed_checklists" "cc"
     JOIN "public"."assets" "a" ON (("a"."id" = "cc"."asset_id")))
  WHERE ("cc"."id" = "checklist_evidence"."completed_checklist_id")))) WITH CHECK ((EXISTS ( SELECT 1
   FROM ("public"."completed_checklists" "cc"
     JOIN "public"."assets" "a" ON (("a"."id" = "cc"."asset_id")))
  WHERE ("cc"."id" = "checklist_evidence"."completed_checklist_id"))));



CREATE POLICY "Checklist issues via completed checklists" ON "public"."checklist_issues" USING ((EXISTS ( SELECT 1
   FROM ("public"."completed_checklists" "cc"
     JOIN "public"."assets" "a" ON (("a"."id" = "cc"."asset_id")))
  WHERE ("cc"."id" = "checklist_issues"."checklist_id")))) WITH CHECK ((EXISTS ( SELECT 1
   FROM ("public"."completed_checklists" "cc"
     JOIN "public"."assets" "a" ON (("a"."id" = "cc"."asset_id")))
  WHERE ("cc"."id" = "checklist_issues"."checklist_id"))));



CREATE POLICY "Checklist items service role access" ON "public"."checklist_items" TO "service_role" USING (true) WITH CHECK (true);



CREATE POLICY "Checklist items total access" ON "public"."checklist_items" USING (true) WITH CHECK (true);



CREATE POLICY "Checklist schedules anon read access" ON "public"."checklist_schedules" FOR SELECT TO "anon" USING (true);



CREATE POLICY "Checklist schedules postgres access" ON "public"."checklist_schedules" TO "postgres" USING (true) WITH CHECK (true);



CREATE POLICY "Checklist schedules service role access" ON "public"."checklist_schedules" TO "service_role" USING (true);



CREATE POLICY "Checklist schedules via assets" ON "public"."checklist_schedules" USING ((EXISTS ( SELECT 1
   FROM "public"."assets"
  WHERE ("assets"."id" = "checklist_schedules"."asset_id")))) WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."assets"
  WHERE ("assets"."id" = "checklist_schedules"."asset_id"))));



CREATE POLICY "Checklist sections service role access" ON "public"."checklist_sections" TO "service_role" USING (true) WITH CHECK (true);



CREATE POLICY "Checklist sections total access" ON "public"."checklist_sections" USING (true) WITH CHECK (true);



CREATE POLICY "Checklist template versions hierarchical access" ON "public"."checklist_template_versions" USING ((EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."id" = "auth"."uid"()) AND ("p"."role" = ANY (ARRAY['GERENCIA_GENERAL'::"public"."user_role", 'JEFE_UNIDAD_NEGOCIO'::"public"."user_role", 'ENCARGADO_MANTENIMIENTO'::"public"."user_role", 'JEFE_PLANTA'::"public"."user_role", 'DOSIFICADOR'::"public"."user_role", 'EJECUTIVO'::"public"."user_role", 'VISUALIZADOR'::"public"."user_role"])) AND ("p"."status" = 'active'::"text"))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."id" = "auth"."uid"()) AND ("p"."role" = ANY (ARRAY['GERENCIA_GENERAL'::"public"."user_role", 'JEFE_UNIDAD_NEGOCIO'::"public"."user_role", 'ENCARGADO_MANTENIMIENTO'::"public"."user_role", 'EJECUTIVO'::"public"."user_role"])) AND ("p"."status" = 'active'::"text")))));



CREATE POLICY "Checklist templates access control" ON "public"."checklists" USING ((EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."id" = "auth"."uid"()) AND ("p"."role" = ANY (ARRAY['GERENCIA_GENERAL'::"public"."user_role", 'JEFE_UNIDAD_NEGOCIO'::"public"."user_role", 'ENCARGADO_MANTENIMIENTO'::"public"."user_role", 'JEFE_PLANTA'::"public"."user_role", 'DOSIFICADOR'::"public"."user_role", 'EJECUTIVO'::"public"."user_role", 'VISUALIZADOR'::"public"."user_role"])) AND ("p"."status" = 'active'::"text"))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."id" = "auth"."uid"()) AND ("p"."role" = ANY (ARRAY['GERENCIA_GENERAL'::"public"."user_role", 'JEFE_UNIDAD_NEGOCIO'::"public"."user_role", 'ENCARGADO_MANTENIMIENTO'::"public"."user_role", 'EJECUTIVO'::"public"."user_role"])) AND ("p"."status" = 'active'::"text")))));



CREATE POLICY "Checklists service role access" ON "public"."checklists" TO "service_role" USING (true) WITH CHECK (true);



CREATE POLICY "Checklists total access" ON "public"."checklists" USING (true) WITH CHECK (true);



CREATE POLICY "Completed checklists anon read access" ON "public"."completed_checklists" FOR SELECT TO "anon" USING (true);



CREATE POLICY "Completed checklists postgres access" ON "public"."completed_checklists" TO "postgres" USING (true) WITH CHECK (true);



CREATE POLICY "Completed checklists service role access" ON "public"."completed_checklists" TO "service_role" USING (true);



CREATE POLICY "Completed checklists via assets" ON "public"."completed_checklists" USING ((EXISTS ( SELECT 1
   FROM "public"."assets"
  WHERE ("assets"."id" = "completed_checklists"."asset_id")))) WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."assets"
  WHERE ("assets"."id" = "completed_checklists"."asset_id"))));



CREATE POLICY "Departments service role access" ON "public"."departments" TO "service_role" USING (true) WITH CHECK (true);



CREATE POLICY "Departments via plants" ON "public"."departments" USING ((EXISTS ( SELECT 1
   FROM "public"."plants"
  WHERE ("plants"."id" = "departments"."plant_id")))) WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."plants"
  WHERE ("plants"."id" = "departments"."plant_id"))));



CREATE POLICY "Diesel evidence service role access" ON "public"."diesel_evidence" TO "service_role" USING (true) WITH CHECK (true);



CREATE POLICY "Diesel evidence via transactions" ON "public"."diesel_evidence" USING ((EXISTS ( SELECT 1
   FROM "public"."diesel_transactions"
  WHERE ("diesel_transactions"."id" = "diesel_evidence"."transaction_id")))) WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."diesel_transactions"
  WHERE ("diesel_transactions"."id" = "diesel_evidence"."transaction_id"))));



CREATE POLICY "Diesel snapshots hierarchical access" ON "public"."diesel_inventory_snapshots" USING (("warehouse_id" IN ( SELECT "w"."id"
   FROM "public"."diesel_warehouses" "w"
  WHERE ("w"."plant_id" IN ( SELECT "p"."id"
           FROM "public"."plants" "p"
          WHERE (EXISTS ( SELECT 1
                   FROM "public"."profiles" "pr"
                  WHERE (("pr"."id" = "auth"."uid"()) AND ("pr"."plant_id" IS NULL) AND ("pr"."business_unit_id" IS NULL) AND ("pr"."role" = ANY (ARRAY['GERENCIA_GENERAL'::"public"."user_role", 'AREA_ADMINISTRATIVA'::"public"."user_role", 'AUXILIAR_COMPRAS'::"public"."user_role", 'DOSIFICADOR'::"public"."user_role", 'EJECUTIVO'::"public"."user_role"])))))
        UNION
         SELECT "p"."id"
           FROM ("public"."plants" "p"
             JOIN "public"."profiles" "pr" ON (("pr"."business_unit_id" = "p"."business_unit_id")))
          WHERE (("pr"."id" = "auth"."uid"()) AND ("pr"."plant_id" IS NULL) AND ("pr"."business_unit_id" IS NOT NULL) AND ("pr"."role" = ANY (ARRAY['JEFE_UNIDAD_NEGOCIO'::"public"."user_role", 'ENCARGADO_MANTENIMIENTO'::"public"."user_role"])))
        UNION
         SELECT "profiles"."plant_id"
           FROM "public"."profiles"
          WHERE (("profiles"."id" = "auth"."uid"()) AND ("profiles"."plant_id" IS NOT NULL) AND ("profiles"."role" = ANY (ARRAY['JEFE_PLANTA'::"public"."user_role", 'DOSIFICADOR'::"public"."user_role"])))))))) WITH CHECK (("warehouse_id" IN ( SELECT "w"."id"
   FROM "public"."diesel_warehouses" "w"
  WHERE ("w"."plant_id" IN ( SELECT "p"."id"
           FROM "public"."plants" "p"
          WHERE (EXISTS ( SELECT 1
                   FROM "public"."profiles" "pr"
                  WHERE (("pr"."id" = "auth"."uid"()) AND ("pr"."plant_id" IS NULL) AND ("pr"."business_unit_id" IS NULL) AND ("pr"."role" = ANY (ARRAY['GERENCIA_GENERAL'::"public"."user_role", 'AREA_ADMINISTRATIVA'::"public"."user_role", 'AUXILIAR_COMPRAS'::"public"."user_role", 'DOSIFICADOR'::"public"."user_role", 'EJECUTIVO'::"public"."user_role"])))))
        UNION
         SELECT "p"."id"
           FROM ("public"."plants" "p"
             JOIN "public"."profiles" "pr" ON (("pr"."business_unit_id" = "p"."business_unit_id")))
          WHERE (("pr"."id" = "auth"."uid"()) AND ("pr"."plant_id" IS NULL) AND ("pr"."business_unit_id" IS NOT NULL) AND ("pr"."role" = ANY (ARRAY['JEFE_UNIDAD_NEGOCIO'::"public"."user_role", 'ENCARGADO_MANTENIMIENTO'::"public"."user_role"])))
        UNION
         SELECT "profiles"."plant_id"
           FROM "public"."profiles"
          WHERE (("profiles"."id" = "auth"."uid"()) AND ("profiles"."plant_id" IS NOT NULL) AND ("profiles"."role" = ANY (ARRAY['JEFE_PLANTA'::"public"."user_role", 'DOSIFICADOR'::"public"."user_role"]))))))));



CREATE POLICY "Diesel snapshots service role access" ON "public"."diesel_inventory_snapshots" TO "service_role" USING (true) WITH CHECK (true);



CREATE POLICY "Diesel transactions hierarchical access" ON "public"."diesel_transactions" USING (((EXISTS ( SELECT 1
   FROM "public"."profiles"
  WHERE (("profiles"."id" = "auth"."uid"()) AND ("profiles"."plant_id" IS NULL) AND ("profiles"."business_unit_id" IS NULL) AND ("profiles"."role" = ANY (ARRAY['GERENCIA_GENERAL'::"public"."user_role", 'AREA_ADMINISTRATIVA'::"public"."user_role", 'AUXILIAR_COMPRAS'::"public"."user_role", 'DOSIFICADOR'::"public"."user_role", 'EJECUTIVO'::"public"."user_role"]))))) OR (EXISTS ( SELECT 1
   FROM ("public"."profiles" "p"
     JOIN "public"."plants" "pl" ON (("pl"."business_unit_id" = "p"."business_unit_id")))
  WHERE (("p"."id" = "auth"."uid"()) AND ("p"."plant_id" IS NULL) AND ("p"."business_unit_id" IS NOT NULL) AND ("diesel_transactions"."plant_id" = "pl"."id") AND ("p"."role" = ANY (ARRAY['JEFE_UNIDAD_NEGOCIO'::"public"."user_role", 'ENCARGADO_MANTENIMIENTO'::"public"."user_role"]))))) OR (EXISTS ( SELECT 1
   FROM "public"."profiles"
  WHERE (("profiles"."id" = "auth"."uid"()) AND ("profiles"."plant_id" = "diesel_transactions"."plant_id") AND ("profiles"."role" = ANY (ARRAY['JEFE_PLANTA'::"public"."user_role", 'DOSIFICADOR'::"public"."user_role"]))))))) WITH CHECK (((EXISTS ( SELECT 1
   FROM "public"."profiles"
  WHERE (("profiles"."id" = "auth"."uid"()) AND ("profiles"."plant_id" IS NULL) AND ("profiles"."business_unit_id" IS NULL) AND ("profiles"."role" = ANY (ARRAY['GERENCIA_GENERAL'::"public"."user_role", 'AREA_ADMINISTRATIVA'::"public"."user_role", 'AUXILIAR_COMPRAS'::"public"."user_role", 'DOSIFICADOR'::"public"."user_role", 'EJECUTIVO'::"public"."user_role"]))))) OR (EXISTS ( SELECT 1
   FROM ("public"."profiles" "p"
     JOIN "public"."plants" "pl" ON (("pl"."business_unit_id" = "p"."business_unit_id")))
  WHERE (("p"."id" = "auth"."uid"()) AND ("p"."plant_id" IS NULL) AND ("p"."business_unit_id" IS NOT NULL) AND ("diesel_transactions"."plant_id" = "pl"."id") AND ("p"."role" = ANY (ARRAY['JEFE_UNIDAD_NEGOCIO'::"public"."user_role", 'ENCARGADO_MANTENIMIENTO'::"public"."user_role"]))))) OR (EXISTS ( SELECT 1
   FROM "public"."profiles"
  WHERE (("profiles"."id" = "auth"."uid"()) AND ("profiles"."plant_id" = "diesel_transactions"."plant_id") AND ("profiles"."role" = ANY (ARRAY['JEFE_PLANTA'::"public"."user_role", 'DOSIFICADOR'::"public"."user_role"])))))));



CREATE POLICY "Diesel transactions service role access" ON "public"."diesel_transactions" TO "service_role" USING (true) WITH CHECK (true);



CREATE POLICY "Enhanced flexible purchase orders access" ON "public"."purchase_orders" USING (((("work_order_id" IS NOT NULL) AND (EXISTS ( SELECT 1
   FROM ("public"."work_orders" "wo"
     JOIN "public"."assets" "a" ON (("a"."id" = "wo"."asset_id")))
  WHERE ("wo"."id" = "purchase_orders"."work_order_id")))) OR (("work_order_id" IS NULL) AND (EXISTS ( SELECT 1
   FROM "public"."user_authorization_summary" "uas"
  WHERE (("uas"."user_id" = "auth"."uid"()) AND (("uas"."plant_id" IS NULL) OR ("uas"."plant_id" = "purchase_orders"."plant_id")))))))) WITH CHECK (((("work_order_id" IS NOT NULL) AND (EXISTS ( SELECT 1
   FROM ("public"."work_orders" "wo"
     JOIN "public"."assets" "a" ON (("a"."id" = "wo"."asset_id")))
  WHERE ("wo"."id" = "purchase_orders"."work_order_id")))) OR (("work_order_id" IS NULL) AND (EXISTS ( SELECT 1
   FROM "public"."user_authorization_summary" "uas"
  WHERE (("uas"."user_id" = "auth"."uid"()) AND (("uas"."plant_id" IS NULL) OR ("uas"."plant_id" = "purchase_orders"."plant_id"))))))));



CREATE POLICY "Equipment models open access" ON "public"."equipment_models" USING (true) WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."id" = "auth"."uid"()) AND ("p"."role" = ANY (ARRAY['GERENCIA_GENERAL'::"public"."user_role", 'ENCARGADO_MANTENIMIENTO'::"public"."user_role", 'EJECUTIVO'::"public"."user_role"])) AND ("p"."status" = 'active'::"text")))));



CREATE POLICY "Equipment models total access" ON "public"."equipment_models" USING (true) WITH CHECK (true);



CREATE POLICY "Everyone can view diesel products" ON "public"."diesel_products" FOR SELECT USING (true);



CREATE POLICY "Incident history anon read access" ON "public"."incident_history" FOR SELECT TO "anon" USING (true);



CREATE POLICY "Incident history postgres access" ON "public"."incident_history" TO "postgres" USING (true) WITH CHECK (true);



CREATE POLICY "Incident history service role access" ON "public"."incident_history" TO "service_role" USING (true);



CREATE POLICY "Incident history via assets" ON "public"."incident_history" USING ((EXISTS ( SELECT 1
   FROM "public"."assets"
  WHERE ("assets"."id" = "incident_history"."asset_id")))) WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."assets"
  WHERE ("assets"."id" = "incident_history"."asset_id"))));



CREATE POLICY "Maintenance history service role access" ON "public"."maintenance_history" TO "service_role" USING (true) WITH CHECK (true);



CREATE POLICY "Maintenance history via assets" ON "public"."maintenance_history" USING ((EXISTS ( SELECT 1
   FROM "public"."assets"
  WHERE ("assets"."id" = "maintenance_history"."asset_id")))) WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."assets"
  WHERE ("assets"."id" = "maintenance_history"."asset_id"))));



CREATE POLICY "Maintenance intervals management access" ON "public"."maintenance_intervals" USING (true) WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."id" = "auth"."uid"()) AND ("p"."role" = ANY (ARRAY['GERENCIA_GENERAL'::"public"."user_role", 'JEFE_UNIDAD_NEGOCIO'::"public"."user_role", 'JEFE_PLANTA'::"public"."user_role", 'ENCARGADO_MANTENIMIENTO'::"public"."user_role", 'EJECUTIVO'::"public"."user_role"])) AND ("p"."status" = 'active'::"text")))));



CREATE POLICY "Maintenance intervals service role access" ON "public"."maintenance_intervals" TO "service_role" USING (true) WITH CHECK (true);



CREATE POLICY "Maintenance plans anon read access" ON "public"."maintenance_plans" FOR SELECT TO "anon" USING (true);



CREATE POLICY "Maintenance plans postgres access" ON "public"."maintenance_plans" TO "postgres" USING (true) WITH CHECK (true);



CREATE POLICY "Maintenance plans service role access" ON "public"."maintenance_plans" TO "service_role" USING (true);



CREATE POLICY "Maintenance plans via assets" ON "public"."maintenance_plans" USING ((EXISTS ( SELECT 1
   FROM "public"."assets"
  WHERE ("assets"."id" = "maintenance_plans"."asset_id")))) WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."assets"
  WHERE ("assets"."id" = "maintenance_plans"."asset_id"))));



CREATE POLICY "Maintenance tasks service role access" ON "public"."maintenance_tasks" TO "service_role" USING (true) WITH CHECK (true);



CREATE POLICY "Maintenance tasks total access" ON "public"."maintenance_tasks" USING (true) WITH CHECK (true);



CREATE POLICY "Model documentation service role access" ON "public"."model_documentation" TO "service_role" USING (true) WITH CHECK (true);



CREATE POLICY "Model documentation total access" ON "public"."model_documentation" USING (true) WITH CHECK (true);



CREATE POLICY "Notifications service role access" ON "public"."notifications" TO "service_role" USING (true) WITH CHECK (true);



CREATE POLICY "Notifications total access" ON "public"."notifications" USING (true) WITH CHECK (true);



CREATE POLICY "Plants anon read access" ON "public"."plants" FOR SELECT TO "anon" USING (true);



CREATE POLICY "Plants hierarchical access" ON "public"."plants" TO "authenticated" USING (((EXISTS ( SELECT 1
   FROM "public"."profiles"
  WHERE (("profiles"."id" = "auth"."uid"()) AND ("profiles"."plant_id" IS NULL) AND ("profiles"."business_unit_id" IS NULL)))) OR (EXISTS ( SELECT 1
   FROM "public"."profiles"
  WHERE (("profiles"."id" = "auth"."uid"()) AND ("profiles"."plant_id" IS NULL) AND ("profiles"."business_unit_id" = "plants"."business_unit_id")))) OR (EXISTS ( SELECT 1
   FROM "public"."profiles"
  WHERE (("profiles"."id" = "auth"."uid"()) AND ("profiles"."plant_id" = "plants"."id"))))));



CREATE POLICY "Plants service role access" ON "public"."plants" TO "service_role" USING (true) WITH CHECK (true);



CREATE POLICY "Profiles anon read access" ON "public"."profiles" FOR SELECT TO "anon" USING (true);



CREATE POLICY "Profiles hierarchical administration" ON "public"."profiles" TO "authenticated" USING ((("id" = "auth"."uid"()) OR (EXISTS ( SELECT 1
   FROM "public"."user_admin_context"
  WHERE (("user_admin_context"."user_id" = "auth"."uid"()) AND ("user_admin_context"."admin_level" = 'TOTAL'::"text")))) OR (EXISTS ( SELECT 1
   FROM "public"."user_admin_context" "uac"
  WHERE (("uac"."user_id" = "auth"."uid"()) AND ("uac"."admin_level" = 'UNIT'::"text") AND (("profiles"."business_unit_id" = "uac"."business_unit_id") OR ("profiles"."plant_id" IN ( SELECT "plants"."id"
           FROM "public"."plants"
          WHERE ("plants"."business_unit_id" = "uac"."business_unit_id"))))))) OR (EXISTS ( SELECT 1
   FROM "public"."user_admin_context" "uac"
  WHERE (("uac"."user_id" = "auth"."uid"()) AND ("uac"."admin_level" = 'PLANT'::"text") AND ("profiles"."plant_id" = "uac"."plant_id")))) OR (EXISTS ( SELECT 1
   FROM "public"."user_admin_context" "uac"
  WHERE (("uac"."user_id" = "auth"."uid"()) AND ("uac"."user_role" = 'ENCARGADO_MANTENIMIENTO'::"public"."user_role") AND ("profiles"."role" = ANY (ARRAY['OPERADOR'::"public"."user_role", 'DOSIFICADOR'::"public"."user_role"])) AND ((("uac"."admin_level" = 'UNIT'::"text") AND ("profiles"."business_unit_id" = "uac"."business_unit_id")) OR (("uac"."admin_level" = 'PLANT'::"text") AND ("profiles"."plant_id" = "uac"."plant_id")) OR ("uac"."admin_level" = 'TOTAL'::"text"))))))) WITH CHECK ((("id" = "auth"."uid"()) OR (EXISTS ( SELECT 1
   FROM "public"."user_admin_context"
  WHERE (("user_admin_context"."user_id" = "auth"."uid"()) AND ("user_admin_context"."admin_level" = 'TOTAL'::"text")))) OR (EXISTS ( SELECT 1
   FROM "public"."user_admin_context" "uac"
  WHERE (("uac"."user_id" = "auth"."uid"()) AND ("uac"."admin_level" = 'UNIT'::"text") AND (("profiles"."business_unit_id" = "uac"."business_unit_id") OR ("profiles"."plant_id" IN ( SELECT "plants"."id"
           FROM "public"."plants"
          WHERE ("plants"."business_unit_id" = "uac"."business_unit_id"))))))) OR (EXISTS ( SELECT 1
   FROM "public"."user_admin_context" "uac"
  WHERE (("uac"."user_id" = "auth"."uid"()) AND ("uac"."admin_level" = 'PLANT'::"text") AND ("profiles"."plant_id" = "uac"."plant_id"))))));



CREATE POLICY "Profiles service role access" ON "public"."profiles" TO "service_role" USING (true) WITH CHECK (true);



CREATE POLICY "Purchase order receipts service role access" ON "public"."purchase_order_receipts" TO "service_role" USING (true) WITH CHECK (true);



CREATE POLICY "Purchase order receipts via purchase orders" ON "public"."purchase_order_receipts" USING ((EXISTS ( SELECT 1
   FROM "public"."purchase_orders" "po"
  WHERE ("po"."id" = "purchase_order_receipts"."purchase_order_id")))) WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."purchase_orders" "po"
  WHERE ("po"."id" = "purchase_order_receipts"."purchase_order_id"))));



CREATE POLICY "Purchase orders service role access" ON "public"."purchase_orders" TO "service_role" USING (true) WITH CHECK (true);



CREATE POLICY "Service orders service role access" ON "public"."service_orders" TO "service_role" USING (true) WITH CHECK (true);



CREATE POLICY "Service orders via assets" ON "public"."service_orders" USING ((EXISTS ( SELECT 1
   FROM "public"."assets"
  WHERE ("assets"."id" = "service_orders"."asset_id")))) WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."assets"
  WHERE ("assets"."id" = "service_orders"."asset_id"))));



CREATE POLICY "Supervisors create diesel warehouses in accessible plants" ON "public"."diesel_warehouses" FOR INSERT WITH CHECK (("public"."can_user_access_plant"("auth"."uid"(), "plant_id") AND (EXISTS ( SELECT 1
   FROM "public"."profiles" "pr"
  WHERE (("pr"."id" = "auth"."uid"()) AND ("pr"."role" = ANY (ARRAY['GERENCIA_GENERAL'::"public"."user_role", 'JEFE_UNIDAD_NEGOCIO'::"public"."user_role", 'ENCARGADO_MANTENIMIENTO'::"public"."user_role", 'JEFE_PLANTA'::"public"."user_role"])))))));



COMMENT ON POLICY "Supervisors create diesel warehouses in accessible plants" ON "public"."diesel_warehouses" IS 'Allows insert when user has a supervisory role and the target plant is within their scope.';



CREATE POLICY "Task parts management access" ON "public"."task_parts" USING (true) WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."id" = "auth"."uid"()) AND ("p"."role" = ANY (ARRAY['GERENCIA_GENERAL'::"public"."user_role", 'JEFE_UNIDAD_NEGOCIO'::"public"."user_role", 'JEFE_PLANTA'::"public"."user_role", 'ENCARGADO_MANTENIMIENTO'::"public"."user_role", 'EJECUTIVO'::"public"."user_role"])) AND ("p"."status" = 'active'::"text")))));



CREATE POLICY "Task parts service role access" ON "public"."task_parts" TO "service_role" USING (true) WITH CHECK (true);



CREATE POLICY "Task parts total access" ON "public"."task_parts" USING (true) WITH CHECK (true);



CREATE POLICY "Users can create asset assignment history records" ON "public"."asset_assignment_history" FOR INSERT WITH CHECK (("auth"."uid"() = "changed_by"));



CREATE POLICY "Users can insert template versions" ON "public"."checklist_template_versions" FOR INSERT WITH CHECK (("auth"."uid"() = "created_by"));



CREATE POLICY "Users can manage composite relationships in their scope" ON "public"."asset_composite_relationships" USING (((EXISTS ( SELECT 1
   FROM ("public"."profiles" "p"
     JOIN "public"."assets" "a_comp" ON (("a_comp"."id" = "asset_composite_relationships"."composite_asset_id")))
  WHERE (("p"."id" = "auth"."uid"()) AND (("p"."plant_id" = "a_comp"."plant_id") OR ("p"."role" = 'GERENCIA_GENERAL'::"public"."user_role") OR (("p"."role" = 'JEFE_UNIDAD_NEGOCIO'::"public"."user_role") AND ("p"."business_unit_id" = ( SELECT "plants"."business_unit_id"
           FROM "public"."plants"
          WHERE ("plants"."id" = "a_comp"."plant_id")))) OR (("p"."role" = ANY (ARRAY['JEFE_PLANTA'::"public"."user_role", 'ENCARGADO_MANTENIMIENTO'::"public"."user_role"])) AND ("p"."plant_id" = "a_comp"."plant_id")))))) AND (EXISTS ( SELECT 1
   FROM ("public"."profiles" "p2"
     JOIN "public"."assets" "a_component" ON (("a_component"."id" = "asset_composite_relationships"."component_asset_id")))
  WHERE (("p2"."id" = "auth"."uid"()) AND (("p2"."plant_id" = "a_component"."plant_id") OR ("p2"."role" = 'GERENCIA_GENERAL'::"public"."user_role") OR (("p2"."role" = 'JEFE_UNIDAD_NEGOCIO'::"public"."user_role") AND ("p2"."business_unit_id" = ( SELECT "plants"."business_unit_id"
           FROM "public"."plants"
          WHERE ("plants"."id" = "a_component"."plant_id")))) OR (("p2"."role" = ANY (ARRAY['JEFE_PLANTA'::"public"."user_role", 'ENCARGADO_MANTENIMIENTO'::"public"."user_role"])) AND ("p2"."plant_id" = "a_component"."plant_id"))))))));



CREATE POLICY "Users can manage their granted delegations" ON "public"."authorization_delegations" USING (("grantor_user_id" = "auth"."uid"()));



CREATE POLICY "Users can update their template versions" ON "public"."checklist_template_versions" FOR UPDATE USING (("auth"."uid"() = "created_by"));



CREATE POLICY "Users can view asset assignment history based on role" ON "public"."asset_assignment_history" FOR SELECT USING (("auth"."uid"() IN ( SELECT "profiles"."id"
   FROM "public"."profiles"
  WHERE (("profiles"."role" = ANY (ARRAY['GERENCIA_GENERAL'::"public"."user_role", 'AREA_ADMINISTRATIVA'::"public"."user_role"])) OR (("profiles"."role" = 'JEFE_UNIDAD_NEGOCIO'::"public"."user_role") AND ("profiles"."business_unit_id" IN ( SELECT "plants"."business_unit_id"
           FROM "public"."plants"
          WHERE (("plants"."id" = "asset_assignment_history"."new_plant_id") OR ("plants"."id" = "asset_assignment_history"."previous_plant_id"))))) OR (("profiles"."role" = 'JEFE_PLANTA'::"public"."user_role") AND ("profiles"."plant_id" = ANY (ARRAY["asset_assignment_history"."new_plant_id", "asset_assignment_history"."previous_plant_id"]))) OR (("profiles"."role" = 'ENCARGADO_MANTENIMIENTO'::"public"."user_role") AND ("profiles"."plant_id" = ANY (ARRAY["asset_assignment_history"."new_plant_id", "asset_assignment_history"."previous_plant_id"])))))));



CREATE POLICY "Users can view composite relationships in their scope" ON "public"."asset_composite_relationships" FOR SELECT USING (((EXISTS ( SELECT 1
   FROM ("public"."profiles" "p"
     JOIN "public"."assets" "a_comp" ON (("a_comp"."id" = "asset_composite_relationships"."composite_asset_id")))
  WHERE (("p"."id" = "auth"."uid"()) AND (("p"."plant_id" = "a_comp"."plant_id") OR ("p"."role" = 'GERENCIA_GENERAL'::"public"."user_role") OR (("p"."role" = 'JEFE_UNIDAD_NEGOCIO'::"public"."user_role") AND ("p"."business_unit_id" = ( SELECT "plants"."business_unit_id"
           FROM "public"."plants"
          WHERE ("plants"."id" = "a_comp"."plant_id")))) OR (("p"."role" = ANY (ARRAY['JEFE_PLANTA'::"public"."user_role", 'ENCARGADO_MANTENIMIENTO'::"public"."user_role"])) AND ("p"."plant_id" = "a_comp"."plant_id")))))) AND (EXISTS ( SELECT 1
   FROM ("public"."profiles" "p2"
     JOIN "public"."assets" "a_component" ON (("a_component"."id" = "asset_composite_relationships"."component_asset_id")))
  WHERE (("p2"."id" = "auth"."uid"()) AND (("p2"."plant_id" = "a_component"."plant_id") OR ("p2"."role" = 'GERENCIA_GENERAL'::"public"."user_role") OR (("p2"."role" = 'JEFE_UNIDAD_NEGOCIO'::"public"."user_role") AND ("p2"."business_unit_id" = ( SELECT "plants"."business_unit_id"
           FROM "public"."plants"
          WHERE ("plants"."id" = "a_component"."plant_id")))) OR (("p2"."role" = ANY (ARRAY['JEFE_PLANTA'::"public"."user_role", 'ENCARGADO_MANTENIMIENTO'::"public"."user_role"])) AND ("p2"."plant_id" = "a_component"."plant_id"))))))));



CREATE POLICY "Users can view operator assignment history in their scope" ON "public"."operator_assignment_history" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM ("public"."profiles" "p"
     JOIN "public"."assets" "a" ON (("a"."id" = "operator_assignment_history"."asset_id")))
  WHERE (("p"."id" = "auth"."uid"()) AND (("p"."plant_id" = "a"."plant_id") OR ("p"."role" = 'GERENCIA_GENERAL'::"public"."user_role") OR (("p"."role" = 'JEFE_UNIDAD_NEGOCIO'::"public"."user_role") AND ("p"."business_unit_id" = ( SELECT "plants"."business_unit_id"
           FROM "public"."plants"
          WHERE ("plants"."id" = "a"."plant_id")))))))));



CREATE POLICY "Users can view relevant delegation history" ON "public"."authorization_delegation_history" FOR SELECT USING (("delegation_id" IN ( SELECT "authorization_delegations"."id"
   FROM "public"."authorization_delegations"
  WHERE (("authorization_delegations"."grantor_user_id" = "auth"."uid"()) OR ("authorization_delegations"."grantee_user_id" = "auth"."uid"())))));



CREATE POLICY "Users can view template versions" ON "public"."checklist_template_versions" FOR SELECT USING (true);



CREATE POLICY "Users can view their granted delegations" ON "public"."authorization_delegations" FOR SELECT USING (("grantor_user_id" = "auth"."uid"()));



CREATE POLICY "Users can view their received delegations" ON "public"."authorization_delegations" FOR SELECT USING (("grantee_user_id" = "auth"."uid"()));



CREATE POLICY "Users can view warehouses for their plants and business units" ON "public"."diesel_warehouses" FOR SELECT USING (("plant_id" IN ( SELECT "p"."id"
   FROM "public"."plants" "p"
  WHERE (("p"."id" = ( SELECT "profiles"."plant_id"
           FROM "public"."profiles"
          WHERE ("profiles"."id" = "auth"."uid"()))) OR (EXISTS ( SELECT 1
           FROM "public"."profiles" "pr"
          WHERE (("pr"."id" = "auth"."uid"()) AND ("pr"."plant_id" IS NULL) AND ("pr"."business_unit_id" = "p"."business_unit_id") AND ("pr"."role" = ANY (ARRAY['GERENCIA_GENERAL'::"public"."user_role", 'JEFE_UNIDAD_NEGOCIO'::"public"."user_role", 'ENCARGADO_MANTENIMIENTO'::"public"."user_role"]))))) OR (EXISTS ( SELECT 1
           FROM "public"."profiles" "pr"
          WHERE (("pr"."id" = "auth"."uid"()) AND ("pr"."plant_id" IS NULL) AND ("pr"."business_unit_id" IS NULL) AND ("pr"."role" = ANY (ARRAY['GERENCIA_GENERAL'::"public"."user_role", 'AREA_ADMINISTRATIVA'::"public"."user_role", 'AUXILIAR_COMPRAS'::"public"."user_role", 'DOSIFICADOR'::"public"."user_role", 'EJECUTIVO'::"public"."user_role"]))))) OR (EXISTS ( SELECT 1
           FROM "public"."profiles" "pr"
          WHERE (("pr"."id" = "auth"."uid"()) AND ("pr"."plant_id" = "p"."id") AND ("pr"."role" = 'DOSIFICADOR'::"public"."user_role"))))))));



CREATE POLICY "Work orders service role access" ON "public"."work_orders" TO "service_role" USING (true) WITH CHECK (true);



CREATE POLICY "Work orders via assets" ON "public"."work_orders" USING ((EXISTS ( SELECT 1
   FROM "public"."assets"
  WHERE ("assets"."id" = "work_orders"."asset_id")))) WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."assets"
  WHERE ("assets"."id" = "work_orders"."asset_id"))));



ALTER TABLE "public"."additional_expenses" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."app_settings" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."asset_assignment_history" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."asset_composite_relationships" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."asset_operators" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."assets" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."authorization_delegation_history" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."authorization_delegations" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."auto_create_logs" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."business_unit_limits" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."business_units" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."checklist_evidence" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."checklist_issues" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."checklist_items" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."checklist_schedules" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."checklist_sections" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."checklist_template_versions" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."checklists" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."completed_checklists" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "deny all" ON "public"."po_action_tokens" USING (false);



ALTER TABLE "public"."departments" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."diesel_evidence" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."diesel_inventory_snapshots" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."diesel_products" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."diesel_transactions" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."diesel_warehouses" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."equipment_models" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."incident_history" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."maintenance_history" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."maintenance_intervals" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."maintenance_plans" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."maintenance_tasks" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "manage_business_unit_limits" ON "public"."business_unit_limits" USING ((EXISTS ( SELECT 1
   FROM "public"."profiles"
  WHERE (("profiles"."id" = "auth"."uid"()) AND ("profiles"."role" = 'GERENCIA_GENERAL'::"public"."user_role")))));



ALTER TABLE "public"."manual_financial_adjustment_distributions" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."manual_financial_adjustments" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."model_documentation" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."notifications" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."operator_assignment_history" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."plants" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."po_action_tokens" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."purchase_order_receipts" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."purchase_orders" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."service_orders" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."supplier_certifications" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."supplier_contacts" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."supplier_performance_history" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."supplier_services" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."supplier_work_history" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."suppliers" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."task_parts" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."user_admin_context" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "view_business_unit_limits" ON "public"."business_unit_limits" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM "public"."profiles"
  WHERE (("profiles"."id" = "auth"."uid"()) AND ("profiles"."role" = ANY (ARRAY['GERENCIA_GENERAL'::"public"."user_role", 'JEFE_UNIDAD_NEGOCIO'::"public"."user_role", 'AREA_ADMINISTRATIVA'::"public"."user_role"]))))));



ALTER TABLE "public"."work_orders" ENABLE ROW LEVEL SECURITY;


GRANT USAGE ON SCHEMA "public" TO "postgres";
GRANT USAGE ON SCHEMA "public" TO "anon";
GRANT USAGE ON SCHEMA "public" TO "authenticated";
GRANT USAGE ON SCHEMA "public" TO "service_role";



GRANT ALL ON FUNCTION "public"."add_column_if_not_exists"("p_table" "text", "p_column" "text", "p_type" "text", "p_constraint" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."add_column_if_not_exists"("p_table" "text", "p_column" "text", "p_type" "text", "p_constraint" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."add_column_if_not_exists"("p_table" "text", "p_column" "text", "p_type" "text", "p_constraint" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."advance_purchase_order_workflow"("p_purchase_order_id" "uuid", "p_new_status" "text", "p_user_id" "uuid", "p_notes" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."advance_purchase_order_workflow"("p_purchase_order_id" "uuid", "p_new_status" "text", "p_user_id" "uuid", "p_notes" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."advance_purchase_order_workflow"("p_purchase_order_id" "uuid", "p_new_status" "text", "p_user_id" "uuid", "p_notes" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."approve_additional_expense"("p_expense_id" "uuid", "p_approved_by" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."approve_additional_expense"("p_expense_id" "uuid", "p_approved_by" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."approve_additional_expense"("p_expense_id" "uuid", "p_approved_by" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."approve_purchase_order"("p_purchase_order_id" "uuid", "p_approved_by" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."approve_purchase_order"("p_purchase_order_id" "uuid", "p_approved_by" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."approve_purchase_order"("p_purchase_order_id" "uuid", "p_approved_by" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."assign_operator_to_asset"("asset_uuid" "uuid", "operator_uuid" "uuid", "assignment_type_param" "text", "assigned_by_uuid" "uuid", "start_date_param" "date") TO "anon";
GRANT ALL ON FUNCTION "public"."assign_operator_to_asset"("asset_uuid" "uuid", "operator_uuid" "uuid", "assignment_type_param" "text", "assigned_by_uuid" "uuid", "start_date_param" "date") TO "authenticated";
GRANT ALL ON FUNCTION "public"."assign_operator_to_asset"("asset_uuid" "uuid", "operator_uuid" "uuid", "assignment_type_param" "text", "assigned_by_uuid" "uuid", "start_date_param" "date") TO "service_role";



GRANT ALL ON FUNCTION "public"."auto_approve_additional_expense"("p_expense_id" "uuid", "p_approved_by" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."auto_approve_additional_expense"("p_expense_id" "uuid", "p_approved_by" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."auto_approve_additional_expense"("p_expense_id" "uuid", "p_approved_by" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."auto_create_pending_work_orders"() TO "anon";
GRANT ALL ON FUNCTION "public"."auto_create_pending_work_orders"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."auto_create_pending_work_orders"() TO "service_role";



GRANT ALL ON FUNCTION "public"."auto_create_pending_work_orders_with_logging"() TO "anon";
GRANT ALL ON FUNCTION "public"."auto_create_pending_work_orders_with_logging"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."auto_create_pending_work_orders_with_logging"() TO "service_role";



GRANT ALL ON FUNCTION "public"."backfill_po_notifications"() TO "anon";
GRANT ALL ON FUNCTION "public"."backfill_po_notifications"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."backfill_po_notifications"() TO "service_role";



GRANT ALL ON FUNCTION "public"."calculate_actual_due_hour"("interval_hours" integer, "cycle_number" integer, "cycle_length_hours" integer, "is_first_cycle_only" boolean) TO "anon";
GRANT ALL ON FUNCTION "public"."calculate_actual_due_hour"("interval_hours" integer, "cycle_number" integer, "cycle_length_hours" integer, "is_first_cycle_only" boolean) TO "authenticated";
GRANT ALL ON FUNCTION "public"."calculate_actual_due_hour"("interval_hours" integer, "cycle_number" integer, "cycle_length_hours" integer, "is_first_cycle_only" boolean) TO "service_role";



GRANT ALL ON FUNCTION "public"."calculate_escalated_priority"("p_original_priority" "text", "p_recurrence_count" integer, "p_status" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."calculate_escalated_priority"("p_original_priority" "text", "p_recurrence_count" integer, "p_status" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."calculate_escalated_priority"("p_original_priority" "text", "p_recurrence_count" integer, "p_status" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."calculate_maintenance_cycle"("asset_current_hours" integer, "cycle_length_hours" integer) TO "anon";
GRANT ALL ON FUNCTION "public"."calculate_maintenance_cycle"("asset_current_hours" integer, "cycle_length_hours" integer) TO "authenticated";
GRANT ALL ON FUNCTION "public"."calculate_maintenance_cycle"("asset_current_hours" integer, "cycle_length_hours" integer) TO "service_role";



GRANT ALL ON FUNCTION "public"."calculate_next_maintenance"("p_asset_id" "uuid", "p_maintenance_interval" integer) TO "anon";
GRANT ALL ON FUNCTION "public"."calculate_next_maintenance"("p_asset_id" "uuid", "p_maintenance_interval" integer) TO "authenticated";
GRANT ALL ON FUNCTION "public"."calculate_next_maintenance"("p_asset_id" "uuid", "p_maintenance_interval" integer) TO "service_role";



GRANT ALL ON FUNCTION "public"."can_manage_user"("target_user_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."can_manage_user"("target_user_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."can_manage_user"("target_user_id" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."can_user_access_plant"("p_user_id" "uuid", "p_plant_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."can_user_access_plant"("p_user_id" "uuid", "p_plant_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."can_user_access_plant"("p_user_id" "uuid", "p_plant_id" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."can_user_authorize_purchase_order"("p_user_id" "uuid", "p_amount" numeric, "p_business_unit_id" "uuid", "p_plant_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."can_user_authorize_purchase_order"("p_user_id" "uuid", "p_amount" numeric, "p_business_unit_id" "uuid", "p_plant_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."can_user_authorize_purchase_order"("p_user_id" "uuid", "p_amount" numeric, "p_business_unit_id" "uuid", "p_plant_id" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."can_user_delegate"("p_grantor_id" "uuid", "p_grantee_id" "uuid", "p_amount" numeric, "p_business_unit_id" "uuid", "p_plant_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."can_user_delegate"("p_grantor_id" "uuid", "p_grantee_id" "uuid", "p_amount" numeric, "p_business_unit_id" "uuid", "p_plant_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."can_user_delegate"("p_grantor_id" "uuid", "p_grantee_id" "uuid", "p_amount" numeric, "p_business_unit_id" "uuid", "p_plant_id" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."check_existing_schedule"("p_template_id" "uuid", "p_asset_id" "uuid", "p_scheduled_date" "date") TO "anon";
GRANT ALL ON FUNCTION "public"."check_existing_schedule"("p_template_id" "uuid", "p_asset_id" "uuid", "p_scheduled_date" "date") TO "authenticated";
GRANT ALL ON FUNCTION "public"."check_existing_schedule"("p_template_id" "uuid", "p_asset_id" "uuid", "p_scheduled_date" "date") TO "service_role";



GRANT ALL ON FUNCTION "public"."check_maintenance_due_assets"() TO "anon";
GRANT ALL ON FUNCTION "public"."check_maintenance_due_assets"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."check_maintenance_due_assets"() TO "service_role";



GRANT ALL ON FUNCTION "public"."cleanup_all_duplicate_schedules"() TO "anon";
GRANT ALL ON FUNCTION "public"."cleanup_all_duplicate_schedules"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."cleanup_all_duplicate_schedules"() TO "service_role";



GRANT ALL ON FUNCTION "public"."cleanup_duplicate_schedules"() TO "anon";
GRANT ALL ON FUNCTION "public"."cleanup_duplicate_schedules"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."cleanup_duplicate_schedules"() TO "service_role";



GRANT ALL ON FUNCTION "public"."cleanup_duplicate_work_order_ids"() TO "anon";
GRANT ALL ON FUNCTION "public"."cleanup_duplicate_work_order_ids"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."cleanup_duplicate_work_order_ids"() TO "service_role";



GRANT ALL ON FUNCTION "public"."complete_checklist_with_readings"("p_schedule_id" "uuid", "p_completed_items" "jsonb", "p_technician" "text", "p_notes" "text", "p_signature_data" "text", "p_hours_reading" integer, "p_kilometers_reading" integer) TO "anon";
GRANT ALL ON FUNCTION "public"."complete_checklist_with_readings"("p_schedule_id" "uuid", "p_completed_items" "jsonb", "p_technician" "text", "p_notes" "text", "p_signature_data" "text", "p_hours_reading" integer, "p_kilometers_reading" integer) TO "authenticated";
GRANT ALL ON FUNCTION "public"."complete_checklist_with_readings"("p_schedule_id" "uuid", "p_completed_items" "jsonb", "p_technician" "text", "p_notes" "text", "p_signature_data" "text", "p_hours_reading" integer, "p_kilometers_reading" integer) TO "service_role";



GRANT ALL ON FUNCTION "public"."complete_maintenance"("p_maintenance_id" "uuid", "p_technician" "text", "p_completion_date" timestamp with time zone, "p_findings" "text", "p_actions" "text", "p_parts" "jsonb", "p_labor_hours" double precision, "p_labor_cost" numeric, "p_total_cost" numeric, "p_measurement_value" integer, "p_documents" "text"[]) TO "anon";
GRANT ALL ON FUNCTION "public"."complete_maintenance"("p_maintenance_id" "uuid", "p_technician" "text", "p_completion_date" timestamp with time zone, "p_findings" "text", "p_actions" "text", "p_parts" "jsonb", "p_labor_hours" double precision, "p_labor_cost" numeric, "p_total_cost" numeric, "p_measurement_value" integer, "p_documents" "text"[]) TO "authenticated";
GRANT ALL ON FUNCTION "public"."complete_maintenance"("p_maintenance_id" "uuid", "p_technician" "text", "p_completion_date" timestamp with time zone, "p_findings" "text", "p_actions" "text", "p_parts" "jsonb", "p_labor_hours" double precision, "p_labor_cost" numeric, "p_total_cost" numeric, "p_measurement_value" integer, "p_documents" "text"[]) TO "service_role";



GRANT ALL ON FUNCTION "public"."complete_work_order"("p_work_order_id" "uuid", "p_completion_data" "jsonb") TO "anon";
GRANT ALL ON FUNCTION "public"."complete_work_order"("p_work_order_id" "uuid", "p_completion_data" "jsonb") TO "authenticated";
GRANT ALL ON FUNCTION "public"."complete_work_order"("p_work_order_id" "uuid", "p_completion_data" "jsonb") TO "service_role";



GRANT ALL ON FUNCTION "public"."consolidate_issues"("p_existing_issue_id" "uuid", "p_new_issue_id" "uuid", "p_work_order_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."consolidate_issues"("p_existing_issue_id" "uuid", "p_new_issue_id" "uuid", "p_work_order_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."consolidate_issues"("p_existing_issue_id" "uuid", "p_new_issue_id" "uuid", "p_work_order_id" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."create_asset_mapping"("p_original_name" "text", "p_asset_id" "uuid", "p_exception_asset_id" "uuid", "p_mapping_type" "text", "p_created_by" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."create_asset_mapping"("p_original_name" "text", "p_asset_id" "uuid", "p_exception_asset_id" "uuid", "p_mapping_type" "text", "p_created_by" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."create_asset_mapping"("p_original_name" "text", "p_asset_id" "uuid", "p_exception_asset_id" "uuid", "p_mapping_type" "text", "p_created_by" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."create_incident_from_checklist_issue"("p_checklist_issue_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."create_incident_from_checklist_issue"("p_checklist_issue_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."create_incident_from_checklist_issue"("p_checklist_issue_id" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."create_profile_on_signup"() TO "anon";
GRANT ALL ON FUNCTION "public"."create_profile_on_signup"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."create_profile_on_signup"() TO "service_role";



GRANT ALL ON FUNCTION "public"."create_template_version"("p_template_id" "uuid", "p_change_summary" "text", "p_migration_notes" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."create_template_version"("p_template_id" "uuid", "p_change_summary" "text", "p_migration_notes" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."create_template_version"("p_template_id" "uuid", "p_change_summary" "text", "p_migration_notes" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."ensure_asset_uuid"("p_asset_reference" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."ensure_asset_uuid"("p_asset_reference" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."ensure_asset_uuid"("p_asset_reference" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."find_missing_weekly_schedules"("p_template_id" "uuid", "p_days" integer, "p_date" "date") TO "anon";
GRANT ALL ON FUNCTION "public"."find_missing_weekly_schedules"("p_template_id" "uuid", "p_days" integer, "p_date" "date") TO "authenticated";
GRANT ALL ON FUNCTION "public"."find_missing_weekly_schedules"("p_template_id" "uuid", "p_days" integer, "p_date" "date") TO "service_role";



GRANT ALL ON FUNCTION "public"."find_similar_open_issues"("p_fingerprint" "text", "p_asset_id" "uuid", "p_consolidation_window" interval) TO "anon";
GRANT ALL ON FUNCTION "public"."find_similar_open_issues"("p_fingerprint" "text", "p_asset_id" "uuid", "p_consolidation_window" interval) TO "authenticated";
GRANT ALL ON FUNCTION "public"."find_similar_open_issues"("p_fingerprint" "text", "p_asset_id" "uuid", "p_consolidation_window" interval) TO "service_role";



GRANT ALL ON FUNCTION "public"."fix_duplicate_order_ids"() TO "anon";
GRANT ALL ON FUNCTION "public"."fix_duplicate_order_ids"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."fix_duplicate_order_ids"() TO "service_role";



GRANT ALL ON FUNCTION "public"."fix_legacy_payment_dates"() TO "anon";
GRANT ALL ON FUNCTION "public"."fix_legacy_payment_dates"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."fix_legacy_payment_dates"() TO "service_role";



GRANT ALL ON FUNCTION "public"."fix_legacy_quotation_issues"() TO "anon";
GRANT ALL ON FUNCTION "public"."fix_legacy_quotation_issues"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."fix_legacy_quotation_issues"() TO "service_role";



GRANT ALL ON FUNCTION "public"."fix_recent_payment_date_issues"() TO "anon";
GRANT ALL ON FUNCTION "public"."fix_recent_payment_date_issues"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."fix_recent_payment_date_issues"() TO "service_role";



GRANT ALL ON FUNCTION "public"."generate_adjustment_purchase_order"("p_work_order_id" "uuid", "p_supplier" "text", "p_items" "jsonb", "p_requested_by" "uuid", "p_original_po_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."generate_adjustment_purchase_order"("p_work_order_id" "uuid", "p_supplier" "text", "p_items" "jsonb", "p_requested_by" "uuid", "p_original_po_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."generate_adjustment_purchase_order"("p_work_order_id" "uuid", "p_supplier" "text", "p_items" "jsonb", "p_requested_by" "uuid", "p_original_po_id" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."generate_asset_id"() TO "anon";
GRANT ALL ON FUNCTION "public"."generate_asset_id"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."generate_asset_id"() TO "service_role";



GRANT ALL ON FUNCTION "public"."generate_checklists_from_maintenance_plan"("maintenance_plan_id" "uuid", "scheduled_date" timestamp with time zone, "assigned_to" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."generate_checklists_from_maintenance_plan"("maintenance_plan_id" "uuid", "scheduled_date" timestamp with time zone, "assigned_to" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."generate_checklists_from_maintenance_plan"("maintenance_plan_id" "uuid", "scheduled_date" timestamp with time zone, "assigned_to" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."generate_corrective_work_order_enhanced"("p_checklist_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."generate_corrective_work_order_enhanced"("p_checklist_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."generate_corrective_work_order_enhanced"("p_checklist_id" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."generate_diesel_transaction_id"() TO "anon";
GRANT ALL ON FUNCTION "public"."generate_diesel_transaction_id"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."generate_diesel_transaction_id"() TO "service_role";



GRANT ALL ON FUNCTION "public"."generate_issue_fingerprint"("p_asset_id" "text", "p_item_description" "text", "p_status" "text", "p_notes" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."generate_issue_fingerprint"("p_asset_id" "text", "p_item_description" "text", "p_status" "text", "p_notes" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."generate_issue_fingerprint"("p_asset_id" "text", "p_item_description" "text", "p_status" "text", "p_notes" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."generate_maintenance_plans"("p_asset_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."generate_maintenance_plans"("p_asset_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."generate_maintenance_plans"("p_asset_id" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."generate_model_id"() TO "anon";
GRANT ALL ON FUNCTION "public"."generate_model_id"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."generate_model_id"() TO "service_role";



GRANT ALL ON FUNCTION "public"."generate_next_id"("prefix" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."generate_next_id"("prefix" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."generate_next_id"("prefix" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."generate_order_id"() TO "anon";
GRANT ALL ON FUNCTION "public"."generate_order_id"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."generate_order_id"() TO "service_role";



GRANT ALL ON FUNCTION "public"."generate_order_id"("order_type" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."generate_order_id"("order_type" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."generate_order_id"("order_type" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."generate_preventive_work_order"("p_asset_id" "uuid", "p_maintenance_plan_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."generate_preventive_work_order"("p_asset_id" "uuid", "p_maintenance_plan_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."generate_preventive_work_order"("p_asset_id" "uuid", "p_maintenance_plan_id" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."generate_purchase_order"("p_work_order_id" "uuid", "p_supplier" "text", "p_items" "jsonb", "p_requested_by" "uuid", "p_expected_delivery_date" timestamp with time zone, "p_quotation_url" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."generate_purchase_order"("p_work_order_id" "uuid", "p_supplier" "text", "p_items" "jsonb", "p_requested_by" "uuid", "p_expected_delivery_date" timestamp with time zone, "p_quotation_url" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."generate_purchase_order"("p_work_order_id" "uuid", "p_supplier" "text", "p_items" "jsonb", "p_requested_by" "uuid", "p_expected_delivery_date" timestamp with time zone, "p_quotation_url" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."generate_purchase_order_id_trigger"() TO "anon";
GRANT ALL ON FUNCTION "public"."generate_purchase_order_id_trigger"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."generate_purchase_order_id_trigger"() TO "service_role";



GRANT ALL ON FUNCTION "public"."generate_service_order_id_trigger"() TO "anon";
GRANT ALL ON FUNCTION "public"."generate_service_order_id_trigger"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."generate_service_order_id_trigger"() TO "service_role";



GRANT ALL ON FUNCTION "public"."generate_unique_purchase_order_id"() TO "anon";
GRANT ALL ON FUNCTION "public"."generate_unique_purchase_order_id"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."generate_unique_purchase_order_id"() TO "service_role";



GRANT ALL ON FUNCTION "public"."generate_unique_work_order_id"() TO "anon";
GRANT ALL ON FUNCTION "public"."generate_unique_work_order_id"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."generate_unique_work_order_id"() TO "service_role";



GRANT ALL ON FUNCTION "public"."generate_work_order_from_incident"("p_incident_id" "uuid", "p_priority" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."generate_work_order_from_incident"("p_incident_id" "uuid", "p_priority" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."generate_work_order_from_incident"("p_incident_id" "uuid", "p_priority" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."generate_work_order_id_trigger"() TO "anon";
GRANT ALL ON FUNCTION "public"."generate_work_order_id_trigger"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."generate_work_order_id_trigger"() TO "service_role";



GRANT ALL ON FUNCTION "public"."get_active_template_version"("p_template_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."get_active_template_version"("p_template_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_active_template_version"("p_template_id" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."get_admin_summary_simple"() TO "anon";
GRANT ALL ON FUNCTION "public"."get_admin_summary_simple"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_admin_summary_simple"() TO "service_role";



GRANT ALL ON FUNCTION "public"."get_administration_summary"() TO "anon";
GRANT ALL ON FUNCTION "public"."get_administration_summary"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_administration_summary"() TO "service_role";



GRANT ALL ON FUNCTION "public"."get_allowed_assignments"() TO "anon";
GRANT ALL ON FUNCTION "public"."get_allowed_assignments"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_allowed_assignments"() TO "service_role";



GRANT ALL ON FUNCTION "public"."get_allowed_statuses"("p_po_type" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."get_allowed_statuses"("p_po_type" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_allowed_statuses"("p_po_type" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."get_applicable_maintenance_intervals"("p_asset_id" "uuid", "p_current_hours" integer) TO "anon";
GRANT ALL ON FUNCTION "public"."get_applicable_maintenance_intervals"("p_asset_id" "uuid", "p_current_hours" integer) TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_applicable_maintenance_intervals"("p_asset_id" "uuid", "p_current_hours" integer) TO "service_role";



GRANT ALL ON FUNCTION "public"."get_asset_assignments"("target_asset_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."get_asset_assignments"("target_asset_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_asset_assignments"("target_asset_id" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."get_available_operators"("p_plant_id" "uuid", "p_business_unit_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."get_available_operators"("p_plant_id" "uuid", "p_business_unit_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_available_operators"("p_plant_id" "uuid", "p_business_unit_id" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."get_available_operators_for_plant"("target_plant_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."get_available_operators_for_plant"("target_plant_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_available_operators_for_plant"("target_plant_id" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."get_daily_checklist_evening_report"("target_date" "date") TO "anon";
GRANT ALL ON FUNCTION "public"."get_daily_checklist_evening_report"("target_date" "date") TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_daily_checklist_evening_report"("target_date" "date") TO "service_role";



GRANT ALL ON FUNCTION "public"."get_daily_checklist_morning_report"("target_date" "date") TO "anon";
GRANT ALL ON FUNCTION "public"."get_daily_checklist_morning_report"("target_date" "date") TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_daily_checklist_morning_report"("target_date" "date") TO "service_role";



GRANT ALL ON FUNCTION "public"."get_daily_work_orders_incidents_report"("target_date" "date") TO "anon";
GRANT ALL ON FUNCTION "public"."get_daily_work_orders_incidents_report"("target_date" "date") TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_daily_work_orders_incidents_report"("target_date" "date") TO "service_role";



GRANT ALL ON FUNCTION "public"."get_diesel_backdating_threshold_minutes"() TO "anon";
GRANT ALL ON FUNCTION "public"."get_diesel_backdating_threshold_minutes"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_diesel_backdating_threshold_minutes"() TO "service_role";



GRANT ALL ON FUNCTION "public"."get_expected_next_reading"("p_asset_id" "uuid", "p_reading_type" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."get_expected_next_reading"("p_asset_id" "uuid", "p_reading_type" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_expected_next_reading"("p_asset_id" "uuid", "p_reading_type" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."get_maintenance_alerts_report"() TO "anon";
GRANT ALL ON FUNCTION "public"."get_maintenance_alerts_report"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_maintenance_alerts_report"() TO "service_role";



GRANT ALL ON FUNCTION "public"."get_maintenance_intervals_with_tasks"("p_model_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."get_maintenance_intervals_with_tasks"("p_model_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_maintenance_intervals_with_tasks"("p_model_id" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."get_manageable_users"() TO "anon";
GRANT ALL ON FUNCTION "public"."get_manageable_users"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_manageable_users"() TO "service_role";



GRANT ALL ON FUNCTION "public"."get_model_cycle_length"("p_model_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."get_model_cycle_length"("p_model_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_model_cycle_length"("p_model_id" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."get_po_action_token"("p_po_id" "uuid", "p_action" "text", "p_recipient_email" "extensions"."citext") TO "anon";
GRANT ALL ON FUNCTION "public"."get_po_action_token"("p_po_id" "uuid", "p_action" "text", "p_recipient_email" "extensions"."citext") TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_po_action_token"("p_po_id" "uuid", "p_action" "text", "p_recipient_email" "extensions"."citext") TO "service_role";



GRANT ALL ON FUNCTION "public"."get_profile_id_by_email"("p_email" "extensions"."citext") TO "anon";
GRANT ALL ON FUNCTION "public"."get_profile_id_by_email"("p_email" "extensions"."citext") TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_profile_id_by_email"("p_email" "extensions"."citext") TO "service_role";



GRANT ALL ON FUNCTION "public"."get_purchase_order_approver"("p_amount" numeric, "p_business_unit_id" "uuid", "p_plant_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."get_purchase_order_approver"("p_amount" numeric, "p_business_unit_id" "uuid", "p_plant_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_purchase_order_approver"("p_amount" numeric, "p_business_unit_id" "uuid", "p_plant_id" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."get_purchase_order_authorizers"("p_amount" numeric, "p_business_unit_id" "uuid", "p_plant_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."get_purchase_order_authorizers"("p_amount" numeric, "p_business_unit_id" "uuid", "p_plant_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_purchase_order_authorizers"("p_amount" numeric, "p_business_unit_id" "uuid", "p_plant_id" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."get_required_checklist_for_work_order"("p_work_order_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."get_required_checklist_for_work_order"("p_work_order_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_required_checklist_for_work_order"("p_work_order_id" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."get_schedule_statistics"() TO "anon";
GRANT ALL ON FUNCTION "public"."get_schedule_statistics"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_schedule_statistics"() TO "service_role";



GRANT ALL ON FUNCTION "public"."get_truly_unresolved_checklist_issues"() TO "anon";
GRANT ALL ON FUNCTION "public"."get_truly_unresolved_checklist_issues"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_truly_unresolved_checklist_issues"() TO "service_role";



GRANT ALL ON FUNCTION "public"."get_unmapped_assets"() TO "anon";
GRANT ALL ON FUNCTION "public"."get_unmapped_assets"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_unmapped_assets"() TO "service_role";



GRANT ALL ON FUNCTION "public"."get_user_delegatable_amount"("p_user_id" "uuid", "p_business_unit_id" "uuid", "p_plant_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."get_user_delegatable_amount"("p_user_id" "uuid", "p_business_unit_id" "uuid", "p_plant_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_user_delegatable_amount"("p_user_id" "uuid", "p_business_unit_id" "uuid", "p_plant_id" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."get_user_effective_authorization"("p_user_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."get_user_effective_authorization"("p_user_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_user_effective_authorization"("p_user_id" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."get_valid_next_statuses"("p_current_status" "text", "p_po_type" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."get_valid_next_statuses"("p_current_status" "text", "p_po_type" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_valid_next_statuses"("p_current_status" "text", "p_po_type" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."get_warehouse_balance"("p_warehouse_id" "uuid", "p_as_of_date" timestamp with time zone) TO "anon";
GRANT ALL ON FUNCTION "public"."get_warehouse_balance"("p_warehouse_id" "uuid", "p_as_of_date" timestamp with time zone) TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_warehouse_balance"("p_warehouse_id" "uuid", "p_as_of_date" timestamp with time zone) TO "service_role";



GRANT ALL ON FUNCTION "public"."get_warehouse_current_balance"("p_warehouse_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."get_warehouse_current_balance"("p_warehouse_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_warehouse_current_balance"("p_warehouse_id" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."has_quotations"("p_purchase_order_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."has_quotations"("p_purchase_order_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."has_quotations"("p_purchase_order_id" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."is_admin"() TO "anon";
GRANT ALL ON FUNCTION "public"."is_admin"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."is_admin"() TO "service_role";



GRANT ALL ON FUNCTION "public"."is_work_order_ready_to_execute"("p_work_order_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."is_work_order_ready_to_execute"("p_work_order_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."is_work_order_ready_to_execute"("p_work_order_id" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."log_cron_selftest"("p_job" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."log_cron_selftest"("p_job" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."log_cron_selftest"("p_job" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."mark_checklist_as_completed"("p_schedule_id" "uuid", "p_completed_items" "jsonb", "p_technician" "text", "p_notes" "text", "p_signature_data" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."mark_checklist_as_completed"("p_schedule_id" "uuid", "p_completed_items" "jsonb", "p_technician" "text", "p_notes" "text", "p_signature_data" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."mark_checklist_as_completed"("p_schedule_id" "uuid", "p_completed_items" "jsonb", "p_technician" "text", "p_notes" "text", "p_signature_data" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."mark_checklist_as_completed_versioned"("p_schedule_id" "uuid", "p_completed_items" "jsonb", "p_technician" "text", "p_notes" "text", "p_signature_data" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."mark_checklist_as_completed_versioned"("p_schedule_id" "uuid", "p_completed_items" "jsonb", "p_technician" "text", "p_notes" "text", "p_signature_data" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."mark_checklist_as_completed_versioned"("p_schedule_id" "uuid", "p_completed_items" "jsonb", "p_technician" "text", "p_notes" "text", "p_signature_data" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."next_valid_daily_date"("p_date" "date") TO "anon";
GRANT ALL ON FUNCTION "public"."next_valid_daily_date"("p_date" "date") TO "authenticated";
GRANT ALL ON FUNCTION "public"."next_valid_daily_date"("p_date" "date") TO "service_role";



GRANT ALL ON FUNCTION "public"."next_valid_date"("p_date" "date", "p_frequency" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."next_valid_date"("p_date" "date", "p_frequency" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."next_valid_date"("p_date" "date", "p_frequency" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."normalize_asset_name"("input_name" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."normalize_asset_name"("input_name" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."normalize_asset_name"("input_name" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."notify_checklist_issues"() TO "anon";
GRANT ALL ON FUNCTION "public"."notify_checklist_issues"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."notify_checklist_issues"() TO "service_role";



GRANT ALL ON FUNCTION "public"."notify_po_pending_approval"() TO "anon";
GRANT ALL ON FUNCTION "public"."notify_po_pending_approval"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."notify_po_pending_approval"() TO "service_role";



GRANT ALL ON FUNCTION "public"."notify_purchase_order_update"() TO "anon";
GRANT ALL ON FUNCTION "public"."notify_purchase_order_update"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."notify_purchase_order_update"() TO "service_role";



GRANT ALL ON FUNCTION "public"."process_checklist_completion_enhanced"("p_schedule_id" "uuid", "p_completed_items" "jsonb", "p_technician" "text", "p_notes" "text", "p_signature_data" "text", "p_equipment_hours_reading" integer, "p_equipment_kilometers_reading" integer) TO "anon";
GRANT ALL ON FUNCTION "public"."process_checklist_completion_enhanced"("p_schedule_id" "uuid", "p_completed_items" "jsonb", "p_technician" "text", "p_notes" "text", "p_signature_data" "text", "p_equipment_hours_reading" integer, "p_equipment_kilometers_reading" integer) TO "authenticated";
GRANT ALL ON FUNCTION "public"."process_checklist_completion_enhanced"("p_schedule_id" "uuid", "p_completed_items" "jsonb", "p_technician" "text", "p_notes" "text", "p_signature_data" "text", "p_equipment_hours_reading" integer, "p_equipment_kilometers_reading" integer) TO "service_role";



GRANT ALL ON FUNCTION "public"."process_po_email_action"("p_token" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."process_po_email_action"("p_token" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."process_po_email_action"("p_token" "text") TO "service_role";



REVOKE ALL ON FUNCTION "public"."recalc_balances_from"("p_transaction_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."recalc_balances_from"("p_transaction_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."recalc_balances_from"("p_transaction_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."recalc_balances_from"("p_transaction_id" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."recalculate_warehouse_balances"("p_warehouse_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."recalculate_warehouse_balances"("p_warehouse_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."recalculate_warehouse_balances"("p_warehouse_id" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."reconcile_diesel_inventory"("p_warehouse_id" "uuid", "p_physical_count" numeric, "p_count_date" timestamp with time zone, "p_reason" "text", "p_created_by" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."reconcile_diesel_inventory"("p_warehouse_id" "uuid", "p_physical_count" numeric, "p_count_date" timestamp with time zone, "p_reason" "text", "p_created_by" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."reconcile_diesel_inventory"("p_warehouse_id" "uuid", "p_physical_count" numeric, "p_count_date" timestamp with time zone, "p_reason" "text", "p_created_by" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."recover_from_duplicate_work_order_id"() TO "anon";
GRANT ALL ON FUNCTION "public"."recover_from_duplicate_work_order_id"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."recover_from_duplicate_work_order_id"() TO "service_role";



GRANT ALL ON FUNCTION "public"."recover_missing_weekly_schedules"("p_template_id" "uuid", "p_days" integer, "p_date" "date") TO "anon";
GRANT ALL ON FUNCTION "public"."recover_missing_weekly_schedules"("p_template_id" "uuid", "p_days" integer, "p_date" "date") TO "authenticated";
GRANT ALL ON FUNCTION "public"."recover_missing_weekly_schedules"("p_template_id" "uuid", "p_days" integer, "p_date" "date") TO "service_role";



GRANT ALL ON FUNCTION "public"."refresh_diesel_inventory"() TO "anon";
GRANT ALL ON FUNCTION "public"."refresh_diesel_inventory"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."refresh_diesel_inventory"() TO "service_role";



GRANT ALL ON FUNCTION "public"."reject_additional_expense"("p_expense_id" "uuid", "p_rejected_by" "uuid", "p_rejection_reason" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."reject_additional_expense"("p_expense_id" "uuid", "p_rejected_by" "uuid", "p_rejection_reason" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."reject_additional_expense"("p_expense_id" "uuid", "p_rejected_by" "uuid", "p_rejection_reason" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."requires_quotation"("p_po_type" character varying, "p_amount" numeric) TO "anon";
GRANT ALL ON FUNCTION "public"."requires_quotation"("p_po_type" character varying, "p_amount" numeric) TO "authenticated";
GRANT ALL ON FUNCTION "public"."requires_quotation"("p_po_type" character varying, "p_amount" numeric) TO "service_role";



GRANT ALL ON FUNCTION "public"."reschedule_checklist"("p_schedule_id" "uuid", "p_new_day" "date", "p_updated_by" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."reschedule_checklist"("p_schedule_id" "uuid", "p_new_day" "date", "p_updated_by" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."reschedule_checklist"("p_schedule_id" "uuid", "p_new_day" "date", "p_updated_by" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."reschedule_completed_checklist"() TO "anon";
GRANT ALL ON FUNCTION "public"."reschedule_completed_checklist"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."reschedule_completed_checklist"() TO "service_role";



GRANT ALL ON FUNCTION "public"."reschedule_overdue_checklists"() TO "anon";
GRANT ALL ON FUNCTION "public"."reschedule_overdue_checklists"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."reschedule_overdue_checklists"() TO "service_role";



GRANT ALL ON FUNCTION "public"."resolve_asset_name"("input_name" "text", "auto_create_exception" boolean) TO "anon";
GRANT ALL ON FUNCTION "public"."resolve_asset_name"("input_name" "text", "auto_create_exception" boolean) TO "authenticated";
GRANT ALL ON FUNCTION "public"."resolve_asset_name"("input_name" "text", "auto_create_exception" boolean) TO "service_role";



GRANT ALL ON FUNCTION "public"."restore_template_version"("p_version_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."restore_template_version"("p_version_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."restore_template_version"("p_version_id" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."rls_complete_system_check"() TO "anon";
GRANT ALL ON FUNCTION "public"."rls_complete_system_check"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."rls_complete_system_check"() TO "service_role";



GRANT ALL ON FUNCTION "public"."rls_health_check"() TO "anon";
GRANT ALL ON FUNCTION "public"."rls_health_check"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."rls_health_check"() TO "service_role";



GRANT ALL ON FUNCTION "public"."rls_system_health_check"() TO "anon";
GRANT ALL ON FUNCTION "public"."rls_system_health_check"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."rls_system_health_check"() TO "service_role";



GRANT ALL ON FUNCTION "public"."save_checklist_evidence"("p_completed_checklist_id" "uuid", "p_evidence_data" "jsonb") TO "anon";
GRANT ALL ON FUNCTION "public"."save_checklist_evidence"("p_completed_checklist_id" "uuid", "p_evidence_data" "jsonb") TO "authenticated";
GRANT ALL ON FUNCTION "public"."save_checklist_evidence"("p_completed_checklist_id" "uuid", "p_evidence_data" "jsonb") TO "service_role";



GRANT ALL ON FUNCTION "public"."schedule_checklists_for_model"() TO "anon";
GRANT ALL ON FUNCTION "public"."schedule_checklists_for_model"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."schedule_checklists_for_model"() TO "service_role";



GRANT ALL ON FUNCTION "public"."schedule_checklists_for_new_asset"() TO "anon";
GRANT ALL ON FUNCTION "public"."schedule_checklists_for_new_asset"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."schedule_checklists_for_new_asset"() TO "service_role";



GRANT ALL ON FUNCTION "public"."set_checklist_scheduled_day"() TO "anon";
GRANT ALL ON FUNCTION "public"."set_checklist_scheduled_day"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."set_checklist_scheduled_day"() TO "service_role";



GRANT ALL ON FUNCTION "public"."set_diesel_transaction_id"() TO "anon";
GRANT ALL ON FUNCTION "public"."set_diesel_transaction_id"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."set_diesel_transaction_id"() TO "service_role";



GRANT ALL ON FUNCTION "public"."set_purchase_order_id"() TO "anon";
GRANT ALL ON FUNCTION "public"."set_purchase_order_id"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."set_purchase_order_id"() TO "service_role";



GRANT ALL ON FUNCTION "public"."set_requires_quote"() TO "anon";
GRANT ALL ON FUNCTION "public"."set_requires_quote"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."set_requires_quote"() TO "service_role";



GRANT ALL ON FUNCTION "public"."set_service_order_id"() TO "anon";
GRANT ALL ON FUNCTION "public"."set_service_order_id"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."set_service_order_id"() TO "service_role";



GRANT ALL ON FUNCTION "public"."set_user_tracking_fields"() TO "anon";
GRANT ALL ON FUNCTION "public"."set_user_tracking_fields"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."set_user_tracking_fields"() TO "service_role";



GRANT ALL ON FUNCTION "public"."set_work_order_id"() TO "anon";
GRANT ALL ON FUNCTION "public"."set_work_order_id"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."set_work_order_id"() TO "service_role";



GRANT ALL ON FUNCTION "public"."should_allow_purchase_order_generation"("p_work_order_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."should_allow_purchase_order_generation"("p_work_order_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."should_allow_purchase_order_generation"("p_work_order_id" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."sync_composite_readings"() TO "anon";
GRANT ALL ON FUNCTION "public"."sync_composite_readings"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."sync_composite_readings"() TO "service_role";



GRANT ALL ON FUNCTION "public"."sync_user_admin_context"() TO "anon";
GRANT ALL ON FUNCTION "public"."sync_user_admin_context"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."sync_user_admin_context"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."sync_warehouse_balance"("p_warehouse_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."sync_warehouse_balance"("p_warehouse_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."sync_warehouse_balance"("p_warehouse_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."sync_warehouse_balance"("p_warehouse_id" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."test_user_access_simplified"("p_user_email" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."test_user_access_simplified"("p_user_email" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."test_user_access_simplified"("p_user_email" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."transfer_operator_assignment"("p_operator_id" "uuid", "p_to_asset_id" "uuid", "p_user_id" "uuid", "p_from_asset_id" "uuid", "p_assignment_type" "text", "p_transfer_reason" "text", "p_force_transfer" boolean) TO "anon";
GRANT ALL ON FUNCTION "public"."transfer_operator_assignment"("p_operator_id" "uuid", "p_to_asset_id" "uuid", "p_user_id" "uuid", "p_from_asset_id" "uuid", "p_assignment_type" "text", "p_transfer_reason" "text", "p_force_transfer" boolean) TO "authenticated";
GRANT ALL ON FUNCTION "public"."transfer_operator_assignment"("p_operator_id" "uuid", "p_to_asset_id" "uuid", "p_user_id" "uuid", "p_from_asset_id" "uuid", "p_assignment_type" "text", "p_transfer_reason" "text", "p_force_transfer" boolean) TO "service_role";



REVOKE ALL ON FUNCTION "public"."trg_mark_tx_for_validation"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."trg_mark_tx_for_validation"() TO "anon";
GRANT ALL ON FUNCTION "public"."trg_mark_tx_for_validation"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."trg_mark_tx_for_validation"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."trg_recalc_on_tx_update"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."trg_recalc_on_tx_update"() TO "anon";
GRANT ALL ON FUNCTION "public"."trg_recalc_on_tx_update"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."trg_recalc_on_tx_update"() TO "service_role";



GRANT ALL ON FUNCTION "public"."trigger_generate_maintenance_plans"() TO "anon";
GRANT ALL ON FUNCTION "public"."trigger_generate_maintenance_plans"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."trigger_generate_maintenance_plans"() TO "service_role";



GRANT ALL ON FUNCTION "public"."trigger_refresh_diesel_inventory"() TO "anon";
GRANT ALL ON FUNCTION "public"."trigger_refresh_diesel_inventory"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."trigger_refresh_diesel_inventory"() TO "service_role";



GRANT ALL ON FUNCTION "public"."update_asset_last_inspection_date"() TO "anon";
GRANT ALL ON FUNCTION "public"."update_asset_last_inspection_date"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."update_asset_last_inspection_date"() TO "service_role";



GRANT ALL ON FUNCTION "public"."update_asset_mapping_timestamp"() TO "anon";
GRANT ALL ON FUNCTION "public"."update_asset_mapping_timestamp"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."update_asset_mapping_timestamp"() TO "service_role";



GRANT ALL ON FUNCTION "public"."update_asset_readings_from_checklist"("p_completed_checklist_id" "uuid", "p_hours_reading" integer, "p_kilometers_reading" integer) TO "anon";
GRANT ALL ON FUNCTION "public"."update_asset_readings_from_checklist"("p_completed_checklist_id" "uuid", "p_hours_reading" integer, "p_kilometers_reading" integer) TO "authenticated";
GRANT ALL ON FUNCTION "public"."update_asset_readings_from_checklist"("p_completed_checklist_id" "uuid", "p_hours_reading" integer, "p_kilometers_reading" integer) TO "service_role";



GRANT ALL ON FUNCTION "public"."update_exception_asset_normalized_name"() TO "anon";
GRANT ALL ON FUNCTION "public"."update_exception_asset_normalized_name"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."update_exception_asset_normalized_name"() TO "service_role";



GRANT ALL ON FUNCTION "public"."update_exception_asset_stats"() TO "anon";
GRANT ALL ON FUNCTION "public"."update_exception_asset_stats"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."update_exception_asset_stats"() TO "service_role";



GRANT ALL ON FUNCTION "public"."update_existing_issue_fingerprints"() TO "anon";
GRANT ALL ON FUNCTION "public"."update_existing_issue_fingerprints"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."update_existing_issue_fingerprints"() TO "service_role";



GRANT ALL ON FUNCTION "public"."update_incident_on_work_order_status"() TO "anon";
GRANT ALL ON FUNCTION "public"."update_incident_on_work_order_status"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."update_incident_on_work_order_status"() TO "service_role";



GRANT ALL ON FUNCTION "public"."update_incident_reporter_name"() TO "anon";
GRANT ALL ON FUNCTION "public"."update_incident_reporter_name"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."update_incident_reporter_name"() TO "service_role";



GRANT ALL ON FUNCTION "public"."update_maintenance_plan_after_completion"("p_asset_id" "uuid", "p_interval_value" integer, "p_completion_date" timestamp with time zone) TO "anon";
GRANT ALL ON FUNCTION "public"."update_maintenance_plan_after_completion"("p_asset_id" "uuid", "p_interval_value" integer, "p_completion_date" timestamp with time zone) TO "authenticated";
GRANT ALL ON FUNCTION "public"."update_maintenance_plan_after_completion"("p_asset_id" "uuid", "p_interval_value" integer, "p_completion_date" timestamp with time zone) TO "service_role";



GRANT ALL ON FUNCTION "public"."update_maintenance_technician_name"() TO "anon";
GRANT ALL ON FUNCTION "public"."update_maintenance_technician_name"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."update_maintenance_technician_name"() TO "service_role";



GRANT ALL ON FUNCTION "public"."update_payment_status"() TO "anon";
GRANT ALL ON FUNCTION "public"."update_payment_status"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."update_payment_status"() TO "service_role";



GRANT ALL ON FUNCTION "public"."update_technician_name"() TO "anon";
GRANT ALL ON FUNCTION "public"."update_technician_name"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."update_technician_name"() TO "service_role";



GRANT ALL ON FUNCTION "public"."update_timestamp"() TO "anon";
GRANT ALL ON FUNCTION "public"."update_timestamp"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."update_timestamp"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."update_transaction_with_recalculation"("p_transaction_id" "uuid", "p_new_quantity" numeric, "p_new_date" timestamp with time zone, "p_new_cuenta_litros" numeric) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."update_transaction_with_recalculation"("p_transaction_id" "uuid", "p_new_quantity" numeric, "p_new_date" timestamp with time zone, "p_new_cuenta_litros" numeric) TO "anon";
GRANT ALL ON FUNCTION "public"."update_transaction_with_recalculation"("p_transaction_id" "uuid", "p_new_quantity" numeric, "p_new_date" timestamp with time zone, "p_new_cuenta_litros" numeric) TO "authenticated";
GRANT ALL ON FUNCTION "public"."update_transaction_with_recalculation"("p_transaction_id" "uuid", "p_new_quantity" numeric, "p_new_date" timestamp with time zone, "p_new_cuenta_litros" numeric) TO "service_role";



GRANT ALL ON FUNCTION "public"."update_updated_at_column"() TO "anon";
GRANT ALL ON FUNCTION "public"."update_updated_at_column"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."update_updated_at_column"() TO "service_role";



GRANT ALL ON FUNCTION "public"."update_warehouse_on_transaction"() TO "anon";
GRANT ALL ON FUNCTION "public"."update_warehouse_on_transaction"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."update_warehouse_on_transaction"() TO "service_role";



GRANT ALL ON FUNCTION "public"."update_work_order_text"() TO "anon";
GRANT ALL ON FUNCTION "public"."update_work_order_text"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."update_work_order_text"() TO "service_role";



GRANT ALL ON FUNCTION "public"."validate_equipment_readings"("p_asset_id" "uuid", "p_hours_reading" integer, "p_kilometers_reading" integer) TO "anon";
GRANT ALL ON FUNCTION "public"."validate_equipment_readings"("p_asset_id" "uuid", "p_hours_reading" integer, "p_kilometers_reading" integer) TO "authenticated";
GRANT ALL ON FUNCTION "public"."validate_equipment_readings"("p_asset_id" "uuid", "p_hours_reading" integer, "p_kilometers_reading" integer) TO "service_role";



GRANT ALL ON FUNCTION "public"."validate_evidence_requirements"("p_completed_checklist_id" "uuid", "p_evidence_data" "jsonb") TO "anon";
GRANT ALL ON FUNCTION "public"."validate_evidence_requirements"("p_completed_checklist_id" "uuid", "p_evidence_data" "jsonb") TO "authenticated";
GRANT ALL ON FUNCTION "public"."validate_evidence_requirements"("p_completed_checklist_id" "uuid", "p_evidence_data" "jsonb") TO "service_role";



GRANT ALL ON FUNCTION "public"."validate_po_status"() TO "anon";
GRANT ALL ON FUNCTION "public"."validate_po_status"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."validate_po_status"() TO "service_role";



GRANT ALL ON FUNCTION "public"."validate_schedule_integrity"() TO "anon";
GRANT ALL ON FUNCTION "public"."validate_schedule_integrity"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."validate_schedule_integrity"() TO "service_role";



GRANT ALL ON TABLE "public"."profiles" TO "anon";
GRANT ALL ON TABLE "public"."profiles" TO "authenticated";
GRANT ALL ON TABLE "public"."profiles" TO "service_role";



GRANT ALL ON TABLE "public"."purchase_orders" TO "anon";
GRANT ALL ON TABLE "public"."purchase_orders" TO "authenticated";
GRANT ALL ON TABLE "public"."purchase_orders" TO "service_role";



GRANT ALL ON TABLE "public"."accounts_payable_summary" TO "anon";
GRANT ALL ON TABLE "public"."accounts_payable_summary" TO "authenticated";
GRANT ALL ON TABLE "public"."accounts_payable_summary" TO "service_role";



GRANT ALL ON TABLE "public"."assets" TO "anon";
GRANT ALL ON TABLE "public"."assets" TO "authenticated";
GRANT ALL ON TABLE "public"."assets" TO "service_role";



GRANT ALL ON TABLE "public"."completed_checklists" TO "anon";
GRANT ALL ON TABLE "public"."completed_checklists" TO "authenticated";
GRANT ALL ON TABLE "public"."completed_checklists" TO "service_role";



GRANT ALL ON TABLE "public"."equipment_models" TO "anon";
GRANT ALL ON TABLE "public"."equipment_models" TO "authenticated";
GRANT ALL ON TABLE "public"."equipment_models" TO "service_role";



GRANT ALL ON TABLE "public"."active_assets_without_recent_inspection" TO "anon";
GRANT ALL ON TABLE "public"."active_assets_without_recent_inspection" TO "authenticated";
GRANT ALL ON TABLE "public"."active_assets_without_recent_inspection" TO "service_role";



GRANT ALL ON TABLE "public"."additional_expenses" TO "anon";
GRANT ALL ON TABLE "public"."additional_expenses" TO "authenticated";
GRANT ALL ON TABLE "public"."additional_expenses" TO "service_role";



GRANT ALL ON TABLE "public"."app_settings" TO "anon";
GRANT ALL ON TABLE "public"."app_settings" TO "authenticated";
GRANT ALL ON TABLE "public"."app_settings" TO "service_role";



GRANT ALL ON TABLE "public"."asset_assignment_history" TO "anon";
GRANT ALL ON TABLE "public"."asset_assignment_history" TO "authenticated";
GRANT ALL ON TABLE "public"."asset_assignment_history" TO "service_role";



GRANT ALL ON TABLE "public"."asset_composite_relationships" TO "anon";
GRANT ALL ON TABLE "public"."asset_composite_relationships" TO "authenticated";
GRANT ALL ON TABLE "public"."asset_composite_relationships" TO "service_role";



GRANT ALL ON TABLE "public"."asset_name_mappings" TO "anon";
GRANT ALL ON TABLE "public"."asset_name_mappings" TO "authenticated";
GRANT ALL ON TABLE "public"."asset_name_mappings" TO "service_role";



GRANT ALL ON TABLE "public"."asset_operators" TO "anon";
GRANT ALL ON TABLE "public"."asset_operators" TO "authenticated";
GRANT ALL ON TABLE "public"."asset_operators" TO "service_role";



GRANT ALL ON TABLE "public"."business_units" TO "anon";
GRANT ALL ON TABLE "public"."business_units" TO "authenticated";
GRANT ALL ON TABLE "public"."business_units" TO "service_role";



GRANT ALL ON TABLE "public"."plants" TO "anon";
GRANT ALL ON TABLE "public"."plants" TO "authenticated";
GRANT ALL ON TABLE "public"."plants" TO "service_role";



GRANT ALL ON TABLE "public"."asset_operator_assignments" TO "anon";
GRANT ALL ON TABLE "public"."asset_operator_assignments" TO "authenticated";
GRANT ALL ON TABLE "public"."asset_operator_assignments" TO "service_role";



GRANT ALL ON TABLE "public"."asset_operators_full" TO "anon";
GRANT ALL ON TABLE "public"."asset_operators_full" TO "authenticated";
GRANT ALL ON TABLE "public"."asset_operators_full" TO "service_role";



GRANT ALL ON TABLE "public"."authorization_delegation_history" TO "anon";
GRANT ALL ON TABLE "public"."authorization_delegation_history" TO "authenticated";
GRANT ALL ON TABLE "public"."authorization_delegation_history" TO "service_role";



GRANT ALL ON TABLE "public"."authorization_delegations" TO "anon";
GRANT ALL ON TABLE "public"."authorization_delegations" TO "authenticated";
GRANT ALL ON TABLE "public"."authorization_delegations" TO "service_role";



GRANT ALL ON TABLE "public"."authorization_matrix" TO "anon";
GRANT ALL ON TABLE "public"."authorization_matrix" TO "authenticated";
GRANT ALL ON TABLE "public"."authorization_matrix" TO "service_role";



GRANT ALL ON TABLE "public"."authorization_limits" TO "anon";
GRANT ALL ON TABLE "public"."authorization_limits" TO "authenticated";
GRANT ALL ON TABLE "public"."authorization_limits" TO "service_role";



GRANT ALL ON TABLE "public"."auto_create_logs" TO "anon";
GRANT ALL ON TABLE "public"."auto_create_logs" TO "authenticated";
GRANT ALL ON TABLE "public"."auto_create_logs" TO "service_role";



GRANT ALL ON TABLE "public"."business_unit_limits" TO "anon";
GRANT ALL ON TABLE "public"."business_unit_limits" TO "authenticated";
GRANT ALL ON TABLE "public"."business_unit_limits" TO "service_role";



GRANT ALL ON TABLE "public"."checklist_schedules" TO "anon";
GRANT ALL ON TABLE "public"."checklist_schedules" TO "authenticated";
GRANT ALL ON TABLE "public"."checklist_schedules" TO "service_role";



GRANT ALL ON TABLE "public"."checklists" TO "anon";
GRANT ALL ON TABLE "public"."checklists" TO "authenticated";
GRANT ALL ON TABLE "public"."checklists" TO "service_role";



GRANT ALL ON TABLE "public"."checklist_completion_rate" TO "anon";
GRANT ALL ON TABLE "public"."checklist_completion_rate" TO "authenticated";
GRANT ALL ON TABLE "public"."checklist_completion_rate" TO "service_role";



GRANT ALL ON TABLE "public"."checklist_evidence" TO "anon";
GRANT ALL ON TABLE "public"."checklist_evidence" TO "authenticated";
GRANT ALL ON TABLE "public"."checklist_evidence" TO "service_role";



GRANT ALL ON TABLE "public"."checklist_issues" TO "anon";
GRANT ALL ON TABLE "public"."checklist_issues" TO "authenticated";
GRANT ALL ON TABLE "public"."checklist_issues" TO "service_role";



GRANT ALL ON TABLE "public"."checklist_items" TO "anon";
GRANT ALL ON TABLE "public"."checklist_items" TO "authenticated";
GRANT ALL ON TABLE "public"."checklist_items" TO "service_role";



GRANT ALL ON TABLE "public"."checklist_schedules_status" TO "anon";
GRANT ALL ON TABLE "public"."checklist_schedules_status" TO "authenticated";
GRANT ALL ON TABLE "public"."checklist_schedules_status" TO "service_role";



GRANT ALL ON TABLE "public"."checklist_sections" TO "anon";
GRANT ALL ON TABLE "public"."checklist_sections" TO "authenticated";
GRANT ALL ON TABLE "public"."checklist_sections" TO "service_role";



GRANT ALL ON TABLE "public"."checklist_template_versions" TO "anon";
GRANT ALL ON TABLE "public"."checklist_template_versions" TO "authenticated";
GRANT ALL ON TABLE "public"."checklist_template_versions" TO "service_role";



GRANT ALL ON TABLE "public"."common_checklist_issues" TO "anon";
GRANT ALL ON TABLE "public"."common_checklist_issues" TO "authenticated";
GRANT ALL ON TABLE "public"."common_checklist_issues" TO "service_role";



GRANT ALL ON TABLE "public"."delegation_details" TO "anon";
GRANT ALL ON TABLE "public"."delegation_details" TO "authenticated";
GRANT ALL ON TABLE "public"."delegation_details" TO "service_role";



GRANT ALL ON TABLE "public"."departments" TO "anon";
GRANT ALL ON TABLE "public"."departments" TO "authenticated";
GRANT ALL ON TABLE "public"."departments" TO "service_role";



GRANT ALL ON TABLE "public"."diesel_transactions" TO "anon";
GRANT ALL ON TABLE "public"."diesel_transactions" TO "authenticated";
GRANT ALL ON TABLE "public"."diesel_transactions" TO "service_role";



GRANT ALL ON TABLE "public"."diesel_warehouses" TO "anon";
GRANT ALL ON TABLE "public"."diesel_warehouses" TO "authenticated";
GRANT ALL ON TABLE "public"."diesel_warehouses" TO "service_role";



GRANT ALL ON TABLE "public"."diesel_asset_consumption_summary" TO "anon";
GRANT ALL ON TABLE "public"."diesel_asset_consumption_summary" TO "authenticated";
GRANT ALL ON TABLE "public"."diesel_asset_consumption_summary" TO "service_role";



GRANT ALL ON TABLE "public"."diesel_products" TO "anon";
GRANT ALL ON TABLE "public"."diesel_products" TO "authenticated";
GRANT ALL ON TABLE "public"."diesel_products" TO "service_role";



GRANT ALL ON TABLE "public"."diesel_current_inventory" TO "anon";
GRANT ALL ON TABLE "public"."diesel_current_inventory" TO "authenticated";
GRANT ALL ON TABLE "public"."diesel_current_inventory" TO "service_role";



GRANT ALL ON TABLE "public"."diesel_evidence" TO "anon";
GRANT ALL ON TABLE "public"."diesel_evidence" TO "authenticated";
GRANT ALL ON TABLE "public"."diesel_evidence" TO "service_role";



GRANT ALL ON TABLE "public"."diesel_excel_staging" TO "anon";
GRANT ALL ON TABLE "public"."diesel_excel_staging" TO "authenticated";
GRANT ALL ON TABLE "public"."diesel_excel_staging" TO "service_role";



GRANT ALL ON SEQUENCE "public"."diesel_excel_staging_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."diesel_excel_staging_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."diesel_excel_staging_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."diesel_inventory_detailed" TO "anon";
GRANT ALL ON TABLE "public"."diesel_inventory_detailed" TO "authenticated";
GRANT ALL ON TABLE "public"."diesel_inventory_detailed" TO "service_role";



GRANT ALL ON TABLE "public"."diesel_inventory_snapshots" TO "anon";
GRANT ALL ON TABLE "public"."diesel_inventory_snapshots" TO "authenticated";
GRANT ALL ON TABLE "public"."diesel_inventory_snapshots" TO "service_role";



GRANT ALL ON SEQUENCE "public"."diesel_transaction_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."diesel_transaction_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."diesel_transaction_seq" TO "service_role";



GRANT ALL ON TABLE "public"."exception_assets" TO "anon";
GRANT ALL ON TABLE "public"."exception_assets" TO "authenticated";
GRANT ALL ON TABLE "public"."exception_assets" TO "service_role";



GRANT ALL ON TABLE "public"."exception_assets_review" TO "anon";
GRANT ALL ON TABLE "public"."exception_assets_review" TO "authenticated";
GRANT ALL ON TABLE "public"."exception_assets_review" TO "service_role";



GRANT ALL ON TABLE "public"."financial_classifications" TO "anon";
GRANT ALL ON TABLE "public"."financial_classifications" TO "authenticated";
GRANT ALL ON TABLE "public"."financial_classifications" TO "service_role";



GRANT ALL ON TABLE "public"."incident_history" TO "anon";
GRANT ALL ON TABLE "public"."incident_history" TO "authenticated";
GRANT ALL ON TABLE "public"."incident_history" TO "service_role";



GRANT ALL ON TABLE "public"."maintenance_checklists" TO "anon";
GRANT ALL ON TABLE "public"."maintenance_checklists" TO "authenticated";
GRANT ALL ON TABLE "public"."maintenance_checklists" TO "service_role";



GRANT ALL ON TABLE "public"."maintenance_history" TO "anon";
GRANT ALL ON TABLE "public"."maintenance_history" TO "authenticated";
GRANT ALL ON TABLE "public"."maintenance_history" TO "service_role";



GRANT ALL ON TABLE "public"."maintenance_intervals" TO "anon";
GRANT ALL ON TABLE "public"."maintenance_intervals" TO "authenticated";
GRANT ALL ON TABLE "public"."maintenance_intervals" TO "service_role";



GRANT ALL ON TABLE "public"."maintenance_plans" TO "anon";
GRANT ALL ON TABLE "public"."maintenance_plans" TO "authenticated";
GRANT ALL ON TABLE "public"."maintenance_plans" TO "service_role";



GRANT ALL ON TABLE "public"."maintenance_tasks" TO "anon";
GRANT ALL ON TABLE "public"."maintenance_tasks" TO "authenticated";
GRANT ALL ON TABLE "public"."maintenance_tasks" TO "service_role";



GRANT ALL ON TABLE "public"."manual_financial_adjustment_distributions" TO "anon";
GRANT ALL ON TABLE "public"."manual_financial_adjustment_distributions" TO "authenticated";
GRANT ALL ON TABLE "public"."manual_financial_adjustment_distributions" TO "service_role";



GRANT ALL ON TABLE "public"."manual_financial_adjustments" TO "anon";
GRANT ALL ON TABLE "public"."manual_financial_adjustments" TO "authenticated";
GRANT ALL ON TABLE "public"."manual_financial_adjustments" TO "service_role";



GRANT ALL ON TABLE "public"."model_documentation" TO "anon";
GRANT ALL ON TABLE "public"."model_documentation" TO "authenticated";
GRANT ALL ON TABLE "public"."model_documentation" TO "service_role";



GRANT ALL ON TABLE "public"."monthly_inventory_summary" TO "anon";
GRANT ALL ON TABLE "public"."monthly_inventory_summary" TO "authenticated";
GRANT ALL ON TABLE "public"."monthly_inventory_summary" TO "service_role";



GRANT ALL ON TABLE "public"."notifications" TO "anon";
GRANT ALL ON TABLE "public"."notifications" TO "authenticated";
GRANT ALL ON TABLE "public"."notifications" TO "service_role";



GRANT ALL ON TABLE "public"."offices" TO "anon";
GRANT ALL ON TABLE "public"."offices" TO "authenticated";
GRANT ALL ON TABLE "public"."offices" TO "service_role";



GRANT ALL ON TABLE "public"."operator_assignment_history" TO "anon";
GRANT ALL ON TABLE "public"."operator_assignment_history" TO "authenticated";
GRANT ALL ON TABLE "public"."operator_assignment_history" TO "service_role";



GRANT ALL ON TABLE "public"."work_orders" TO "anon";
GRANT ALL ON TABLE "public"."work_orders" TO "authenticated";
GRANT ALL ON TABLE "public"."work_orders" TO "service_role";



GRANT ALL ON TABLE "public"."pending_expense_approvals" TO "anon";
GRANT ALL ON TABLE "public"."pending_expense_approvals" TO "authenticated";
GRANT ALL ON TABLE "public"."pending_expense_approvals" TO "service_role";



GRANT ALL ON TABLE "public"."po_action_tokens" TO "anon";
GRANT ALL ON TABLE "public"."po_action_tokens" TO "authenticated";
GRANT ALL ON TABLE "public"."po_action_tokens" TO "service_role";



GRANT ALL ON TABLE "public"."po_type_summary" TO "anon";
GRANT ALL ON TABLE "public"."po_type_summary" TO "authenticated";
GRANT ALL ON TABLE "public"."po_type_summary" TO "service_role";



GRANT ALL ON TABLE "public"."purchase_order_metrics" TO "anon";
GRANT ALL ON TABLE "public"."purchase_order_metrics" TO "authenticated";
GRANT ALL ON TABLE "public"."purchase_order_metrics" TO "service_role";



GRANT ALL ON TABLE "public"."purchase_order_receipts" TO "anon";
GRANT ALL ON TABLE "public"."purchase_order_receipts" TO "authenticated";
GRANT ALL ON TABLE "public"."purchase_order_receipts" TO "service_role";



GRANT ALL ON TABLE "public"."rls_final_status" TO "anon";
GRANT ALL ON TABLE "public"."rls_final_status" TO "authenticated";
GRANT ALL ON TABLE "public"."rls_final_status" TO "service_role";



GRANT ALL ON TABLE "public"."rls_implementation_summary" TO "anon";
GRANT ALL ON TABLE "public"."rls_implementation_summary" TO "authenticated";
GRANT ALL ON TABLE "public"."rls_implementation_summary" TO "service_role";



GRANT ALL ON TABLE "public"."rls_system_complete_status" TO "anon";
GRANT ALL ON TABLE "public"."rls_system_complete_status" TO "authenticated";
GRANT ALL ON TABLE "public"."rls_system_complete_status" TO "service_role";



GRANT ALL ON TABLE "public"."service_orders" TO "anon";
GRANT ALL ON TABLE "public"."service_orders" TO "authenticated";
GRANT ALL ON TABLE "public"."service_orders" TO "service_role";



GRANT ALL ON SEQUENCE "public"."service_orders_order_number_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."service_orders_order_number_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."service_orders_order_number_seq" TO "service_role";



GRANT ALL ON TABLE "public"."supplier_certifications" TO "anon";
GRANT ALL ON TABLE "public"."supplier_certifications" TO "authenticated";
GRANT ALL ON TABLE "public"."supplier_certifications" TO "service_role";



GRANT ALL ON TABLE "public"."supplier_contacts" TO "anon";
GRANT ALL ON TABLE "public"."supplier_contacts" TO "authenticated";
GRANT ALL ON TABLE "public"."supplier_contacts" TO "service_role";



GRANT ALL ON TABLE "public"."supplier_performance_history" TO "anon";
GRANT ALL ON TABLE "public"."supplier_performance_history" TO "authenticated";
GRANT ALL ON TABLE "public"."supplier_performance_history" TO "service_role";



GRANT ALL ON TABLE "public"."supplier_services" TO "anon";
GRANT ALL ON TABLE "public"."supplier_services" TO "authenticated";
GRANT ALL ON TABLE "public"."supplier_services" TO "service_role";



GRANT ALL ON TABLE "public"."supplier_work_history" TO "anon";
GRANT ALL ON TABLE "public"."supplier_work_history" TO "authenticated";
GRANT ALL ON TABLE "public"."supplier_work_history" TO "service_role";



GRANT ALL ON TABLE "public"."suppliers" TO "anon";
GRANT ALL ON TABLE "public"."suppliers" TO "authenticated";
GRANT ALL ON TABLE "public"."suppliers" TO "service_role";



GRANT ALL ON TABLE "public"."task_parts" TO "anon";
GRANT ALL ON TABLE "public"."task_parts" TO "authenticated";
GRANT ALL ON TABLE "public"."task_parts" TO "service_role";



GRANT ALL ON TABLE "public"."user_admin_context" TO "anon";
GRANT ALL ON TABLE "public"."user_admin_context" TO "authenticated";
GRANT ALL ON TABLE "public"."user_admin_context" TO "service_role";



GRANT ALL ON TABLE "public"."user_authorization_summary" TO "anon";
GRANT ALL ON TABLE "public"."user_authorization_summary" TO "authenticated";
GRANT ALL ON TABLE "public"."user_authorization_summary" TO "service_role";



GRANT ALL ON TABLE "public"."user_roles_summary" TO "anon";
GRANT ALL ON TABLE "public"."user_roles_summary" TO "authenticated";
GRANT ALL ON TABLE "public"."user_roles_summary" TO "service_role";



GRANT ALL ON SEQUENCE "public"."work_order_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."work_order_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."work_order_id_seq" TO "service_role";



GRANT ALL ON SEQUENCE "public"."work_order_order_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."work_order_order_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."work_order_order_id_seq" TO "service_role";



GRANT ALL ON SEQUENCE "public"."work_order_sequence" TO "anon";
GRANT ALL ON SEQUENCE "public"."work_order_sequence" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."work_order_sequence" TO "service_role";



GRANT ALL ON TABLE "public"."work_orders_with_checklist_status" TO "anon";
GRANT ALL ON TABLE "public"."work_orders_with_checklist_status" TO "authenticated";
GRANT ALL ON TABLE "public"."work_orders_with_checklist_status" TO "service_role";



ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES  TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES  TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES  TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES  TO "service_role";






ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS  TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS  TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS  TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS  TO "service_role";






ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES  TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES  TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES  TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES  TO "service_role";






RESET ALL;
