-- =====================================================
-- Diesel Warehouses - RLS INSERT Policy
-- Migration: 20251029_diesel_warehouses_insert_policy
-- Description: Allow authorized users to insert diesel warehouses
-- =====================================================

-- Policy: Supervisors can create diesel warehouses in plants they can access
CREATE POLICY "Supervisors create diesel warehouses in accessible plants"
  ON diesel_warehouses FOR INSERT
  WITH CHECK (
    -- Must be within the user's accessible plant scope
    can_user_access_plant(auth.uid(), plant_id)
    AND
    -- And the user must hold an authorized supervisory role
    EXISTS (
      SELECT 1 FROM profiles pr
      WHERE pr.id = auth.uid()
        AND pr.role IN (
          'GERENCIA_GENERAL',
          'JEFE_UNIDAD_NEGOCIO',
          'ENCARGADO_MANTENIMIENTO',
          'JEFE_PLANTA'
        )
    )
  );

COMMENT ON POLICY "Supervisors create diesel warehouses in accessible plants" ON diesel_warehouses
IS 'Allows insert when user has a supervisory role and the target plant is within their scope.';












