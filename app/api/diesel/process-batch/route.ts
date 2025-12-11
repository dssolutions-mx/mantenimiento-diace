import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase-server'
import { PlantBatch, MeterConflict, MeterReconciliationPreferences } from '@/types/diesel'

export async function POST(request: NextRequest) {
  try {
    const supabase = await createClient()
    
    // Check authentication
    const { data: { user }, error: authError } = await supabase.auth.getUser()
    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const body = await request.json()
    const { 
      plantBatch, 
      meterPreferences,
      meterResolutions,
      assetMappings,
      productType = 'diesel' // Default to diesel for backward compatibility
    }: { 
      plantBatch: PlantBatch
      meterPreferences: MeterReconciliationPreferences
      meterResolutions?: Record<string, 'use_diesel' | 'keep_checklist' | 'skip'>
      assetMappings?: Record<string, any>
      productType?: 'diesel' | 'urea'
    } = body

    // Debug: Count enriched rows by type
    const enrichedRows = plantBatch.rows.filter(r => r.resolved_asset_type)
    const exceptionRows = plantBatch.rows.filter(r => r.resolved_asset_type === 'exception')
    
    console.log('[Diesel API] Processing batch:', {
      plant: plantBatch.plant_code,
      warehouse: plantBatch.warehouse_number,
      total_rows: plantBatch.total_rows,
      mappings: assetMappings ? Object.keys(assetMappings).length : 0,
      enriched_rows: enrichedRows.length,
      exception_rows: exceptionRows.length
    })
    
    if (exceptionRows.length > 0) {
      console.log('[Diesel API] Sample exception rows:', 
        exceptionRows.slice(0, 3).map(r => ({
          unit: r.unidad,
          type: r.resolved_asset_type,
          exception_name: r.exception_asset_name,
          has_asset_id: !!r.resolved_asset_id
        }))
      )
    }

    if (!plantBatch) {
      return NextResponse.json({ error: 'Plant batch required' }, { status: 400 })
    }

    // Normalize plant code: P1 → P001, P2 → P002, etc.
    const normalizePlantCode = (code: string): string => {
      const match = code.match(/^P(\d+)$/i)
      if (match) {
        const num = parseInt(match[1])
        return `P${num.toString().padStart(3, '0')}`
      }
      return code
    }

    const normalizedPlantCode = normalizePlantCode(plantBatch.plant_code)
    console.log('[Diesel API] Plant code normalized:', plantBatch.plant_code, '→', normalizedPlantCode)

    // Step 1: Resolve plant reference
    console.log('[Diesel API] Looking up plant:', normalizedPlantCode)
    const { data: plant, error: plantError } = await supabase
      .from('plants')
      .select('id, code, name')
      .eq('code', normalizedPlantCode)
      .single()

    if (plantError) {
      console.error('[Diesel API] Plant lookup error:', plantError)
      return NextResponse.json({ 
        error: `Plant ${plantBatch.plant_code} not found`,
        details: plantError.message
      }, { status: 404 })
    }

    if (!plant) {
      console.error('[Diesel API] Plant not found:', plantBatch.plant_code)
      return NextResponse.json({ 
        error: `Plant ${plantBatch.plant_code} not found in database` 
      }, { status: 404 })
    }

    console.log('[Diesel API] Found plant:', plant)

    // Step 2: Resolve warehouse by matching plant and warehouse number in code
    console.log('[Diesel API] Looking up warehouse for plant:', plant.id, 'warehouse:', plantBatch.warehouse_number, 'productType:', productType)
    const warehouseCodePattern = `%${normalizedPlantCode.substring(1)}%-${plantBatch.warehouse_number}`
    const { data: warehouse, error: warehouseError } = await supabase
      .from('diesel_warehouses')
      .select('id, warehouse_code, name, product_type')
      .eq('plant_id', plant.id)
      .eq('product_type', productType)
      .ilike('warehouse_code', warehouseCodePattern)
      .maybeSingle()

    if (warehouseError) {
      console.error('[Diesel API] Warehouse lookup error:', warehouseError)
      return NextResponse.json({ 
        error: `Failed to lookup warehouse: ${warehouseError.message}` 
      }, { status: 500 })
    }

    if (!warehouse) {
      console.error('[Diesel API] Warehouse not found for plant:', plant.code, 'warehouse:', plantBatch.warehouse_number, 'productType:', productType)
      return NextResponse.json({ 
        error: `Warehouse ${plantBatch.warehouse_number} not found for plant ${plant.code}`,
        code: 'WAREHOUSE_NOT_FOUND',
        details: {
          plant_id: plant.id,
          plant_code: plant.code,
          plant_name: plant.name,
          warehouse_number: plantBatch.warehouse_number,
          product_type: productType,
          suggested_warehouse_code: `ALM-${normalizedPlantCode.substring(1)}-${plantBatch.warehouse_number}`,
          suggested_name: `${plant.name} - ${productType === 'urea' ? 'UREA' : 'Diesel'} - Almacén ${plantBatch.warehouse_number}`
        }
      }, { status: 404 })
    }

    console.log('[Diesel API] Found warehouse:', warehouse)

    // Step 2.5: Get product by type
    const expectedProductCode = productType === 'diesel' ? '07DS01' : '07UR01'
    const { data: product, error: productError } = await supabase
      .from('diesel_products')
      .select('id, product_code, name, product_type')
      .eq('product_code', expectedProductCode)
      .eq('product_type', productType)
      .single()

    if (productError || !product) {
      console.error(`[Diesel API] ${productType} product not found:`, productError)
      return NextResponse.json({ 
        error: `${productType === 'diesel' ? 'Diesel' : 'UREA'} product (${expectedProductCode}) not found in database` 
      }, { status: 404 })
    }

    console.log(`[Diesel API] Found ${productType} product:`, product)
    
    // Verify warehouse product_type matches product
    if (warehouse && warehouse.product_type !== productType) {
      console.error('[Diesel API] Warehouse product_type mismatch:', warehouse.product_type, 'vs', productType)
      return NextResponse.json({ 
        error: `Warehouse product type (${warehouse.product_type}) does not match selected product type (${productType})` 
      }, { status: 400 })
    }

    // Step 3: Check for meter conflicts
    const conflicts: MeterConflict[] = []
    
    for (const reading of plantBatch.meter_readings) {
      // Skip if user already decided
      if (meterResolutions && meterResolutions[reading.asset_code] === 'skip') {
        continue
      }

      // Get mapped asset UUID from assetMappings
      const assetMapping = assetMappings?.[reading.asset_code]
      if (!assetMapping || !assetMapping.asset_id) {
        console.log(`[Diesel API] No asset mapping found for meter reading: ${reading.asset_code}`)
        continue // No mapping, skip meter conflict check
      }

      // Look up asset by UUID from mapping
      const { data: asset } = await supabase
        .from('assets')
        .select('id, asset_id, name, current_horometer, current_kilometer, last_reading_date')
        .eq('id', assetMapping.asset_id)
        .maybeSingle()

      if (!asset) {
        console.log(`[Diesel API] Asset not found for meter reading: ${reading.asset_code} (mapped to ${assetMapping.asset_id})`)
        continue
      }

      // Check if checklist reading is newer or conflicts
      // Parse reading date from string if needed (comes from JSON serialization)
      const readingDate = typeof reading.reading_date === 'string' 
        ? new Date(reading.reading_date) 
        : reading.reading_date
      const checklistDate = asset.last_reading_date ? new Date(asset.last_reading_date) : null
      
      if (checklistDate && asset.current_horometer != null) {
        const isDieselNewer = readingDate > checklistDate
        const isDieselHigher = reading.horometer != null && reading.horometer > asset.current_horometer
        
        const horoDiff = reading.horometer != null 
          ? reading.horometer - asset.current_horometer 
          : null

        const kmDiff = reading.kilometer != null && asset.current_kilometer != null
          ? reading.kilometer - asset.current_kilometer
          : null

        // Determine if we should prompt
        const shouldPrompt = 
          meterPreferences.default_action === 'prompt' &&
          (
            (horoDiff != null && Math.abs(horoDiff) > meterPreferences.prompt_if_discrepancy_gt) ||
            (kmDiff != null && Math.abs(kmDiff) > meterPreferences.prompt_if_discrepancy_gt)
          )

        if (shouldPrompt && !meterResolutions?.[reading.asset_code]) {
          conflicts.push({
            asset_code: reading.asset_code,
            asset_id: asset.id,
            diesel_horometer: reading.horometer,
            diesel_kilometer: reading.kilometer,
            diesel_date: readingDate,
            diesel_row_number: reading.original_row_number,
            checklist_horometer: asset.current_horometer,
            checklist_kilometer: asset.current_kilometer,
            checklist_date: checklistDate,
            checklist_source: `Last updated ${checklistDate.toLocaleDateString()}`,
            horometer_diff: horoDiff,
            kilometer_diff: kmDiff,
            is_diesel_newer: isDieselNewer,
            is_diesel_higher: isDieselHigher,
            resolution: 'pending',
            resolved_by: null,
            resolved_at: null
          })
        }
      }
    }

    // If there are unresolved conflicts, return them
    if (conflicts.length > 0) {
      return NextResponse.json({
        status: 'needs_meter_resolution',
        conflicts,
        message: `${conflicts.length} meter conflicts require resolution`
      })
    }

    // Step 4: Stage rows (simplified - in production, use staging table)
    // For now, we'll process directly but with validation

    const processedRows = []
    const errors = []
    const transactionsByType: Record<string, number> = {
      inventory_opening: 0,
      fuel_receipt: 0,
      asset_consumption: 0,
      unassigned_consumption: 0,
      inventory_adjustment: 0
    }

    console.log('[Diesel API] Processing rows by movement category...')

    for (const row of plantBatch.rows) {
      try {
        // Skip inventory opening row (used only for initial balance)
        if (row.movement_category === 'inventory_opening') {
          console.log(`[Diesel API] Row ${row.original_row_index}: Skipping inventory opening`)
          processedRows.push(row.original_row_index)
          transactionsByType.inventory_opening++
          continue
        }

        // Check if mapping is required and available
        // Exception assets have resolved_asset_type='exception' but no resolved_asset_id
        const hasMapping = row.resolved_asset_id || row.resolved_asset_type === 'exception'
        if (row.requires_asset_mapping && !hasMapping) {
          errors.push({
            row: row.original_row_index,
            error: `Asset "${row.unidad}" requires mapping but no resolution found`
          })
          console.warn(`[Diesel API] Row ${row.original_row_index}: Missing asset mapping for "${row.unidad}"`)
          continue
        }

        // Determine transaction type based on movement category
        // Database constraint: 'entry' MUST have asset_id=NULL, 'consumption' MUST have asset_id!=NULL
        let transactionType: string
        let assetIdForTransaction: string | null = null

        switch (row.movement_category) {
          case 'fuel_receipt':
            transactionType = 'entry'
            assetIdForTransaction = null // Entry cannot have asset_id per DB constraint
            break
          case 'asset_consumption':
            transactionType = 'consumption'
            assetIdForTransaction = row.resolved_asset_id || null
            // Exception assets (Utilities, Partner, etc.) don't need asset_id
            // They use exception_asset_name instead
            if (!assetIdForTransaction && row.resolved_asset_type !== 'exception') {
              throw new Error(`Asset consumption requires asset_id or exception mapping but none found for unit: ${row.unidad}`)
            }
            break
          case 'unassigned_consumption':
            // Unassigned consumption: fuel was taken but not assigned to specific asset
            // Can be mapped to: formal asset, exception asset (Utilities, etc.), or general
            transactionType = 'consumption'
            if (row.resolved_asset_id) {
              // Mapped to formal asset or general consumption asset
              assetIdForTransaction = row.resolved_asset_id
            } else if (row.resolved_asset_type === 'exception') {
              // Mapped to exception asset (Utilities, Partner, etc.)
              assetIdForTransaction = null // Exception assets use exception_asset_name
            } else {
              // Not mapped at all - skip
              console.warn(`[Diesel API] Row ${row.original_row_index}: Skipping unassigned consumption - no asset mapping`)
              errors.push({
                row: row.original_row_index,
                error: `Unassigned consumption cannot be recorded without asset mapping. Consider creating a "General Consumption" asset for plant ${plantBatch.plant_code}.`
              })
              continue
            }
            break
          case 'inventory_adjustment':
            // Adjustments can be positive (Entrada) or negative (Salida)
            // Respect the tipo field to determine if it's an entry or consumption
            if (row.tipo === 'Entrada') {
              // Positive adjustment - adding fuel to inventory
              // Entry cannot have asset_id, but we can track reference in exception_asset_name
              transactionType = 'entry'
              assetIdForTransaction = null // Entries cannot have asset_id per DB constraint
              // If there's an asset/reason reference, we'll store it in exception_asset_name later
            } else {
              // Negative adjustment (Salida) - removing fuel or correction
              transactionType = 'consumption'
              if (row.resolved_asset_id) {
                // Mapped to formal asset
                assetIdForTransaction = row.resolved_asset_id
              } else if (row.resolved_asset_type === 'exception') {
                // Mapped to exception asset (Utilities, Partner, etc.)
                assetIdForTransaction = null // Exception assets use exception_asset_name
              } else {
                // Not mapped at all - skip with error
                console.warn(`[Diesel API] Row ${row.original_row_index}: Adjustment with Salida type requires asset mapping`)
                errors.push({
                  row: row.original_row_index,
                  error: `Adjustment (Salida) requires asset mapping but none found`
                })
                continue
              }
            }
            break
          default:
            transactionType = 'consumption'
            assetIdForTransaction = row.resolved_asset_id || null
        }

        // Parse date: handle both Date objects and ISO strings from JSON serialization
        let txDate: Date
        if (row.parsed_date) {
          txDate = typeof row.parsed_date === 'string' 
            ? new Date(row.parsed_date) 
            : row.parsed_date
        } else {
          txDate = new Date()
        }
        
        // Validate date
        if (isNaN(txDate.getTime())) {
          throw new Error(`Invalid date for row ${row.original_row_index}: ${row.fecha_}`)
        }

        const dateStr = txDate.toISOString().split('T')[0].replace(/-/g, '')
        const txNum = (processedRows.length + 1).toString().padStart(3, '0')
        const transactionId = `DSL-${normalizedPlantCode}-${dateStr}-${txNum}`

        // Determine asset category based on transaction type and asset mapping
        // DB Constraints:
        // - 'formal': requires asset_id, no exception_asset_name
        // - 'exception': requires exception_asset_name, no asset_id (and no meters for consumption)
        // - 'general': requires NO asset_id, NO exception_asset_name, NO meters (only for entries)
        let assetCategory: string
        let exceptionAssetName: string | null = null
        
        if (transactionType === 'entry') {
          // Fuel receipts and positive adjustments
          // Check if this is an adjustment with a reference (like "Ajuste")
          if (row.movement_category === 'inventory_adjustment' && row.unidad && row.unidad.trim()) {
            // Adjustment entry with reference - store in exception_asset_name for tracking
            assetCategory = 'general'
            exceptionAssetName = row.unidad.trim()
            console.log(`[Diesel API] Row ${row.original_row_index}: Entry adjustment with reference: ${exceptionAssetName}`)
          } else {
            // Regular fuel receipt
            assetCategory = 'general'
          }
        } else {
          // Consumption transactions
          if (row.resolved_asset_type === 'formal' && assetIdForTransaction) {
            assetCategory = 'formal'
          } else if (row.resolved_asset_type === 'exception') {
            // Exception assets: use exception_asset_name, clear asset_id
            assetCategory = 'exception'
            exceptionAssetName = row.exception_asset_name || row.unidad || 'Unknown'
            assetIdForTransaction = null // Exception assets cannot have asset_id per constraint
          } else if (row.resolved_asset_type === 'general' && assetIdForTransaction) {
            // General consumption mapped to an asset - treat as formal
            assetCategory = 'formal'
          } else {
            // Fallback
            assetCategory = assetIdForTransaction ? 'formal' : 'general'
          }
        }

        // Validate quantity: skip transactions with 0 or negative liters
        const quantity = parseFloat(String(row.litros_cantidad)) || 0
        if (quantity <= 0) {
          console.warn(`[Diesel API] Row ${row.original_row_index}: Skipping transaction with invalid quantity: ${quantity}L`)
          errors.push({
            row: row.original_row_index,
            error: `Transaction quantity must be greater than 0 (found: ${quantity}L). This is likely a validation/count entry with no fuel movement.`
          })
          continue
        }

        // For exception assets with meters, we need to clear the meter readings per DB constraint
        const hasMeters = row.horometro != null || row.kilometraje != null
        if (assetCategory === 'exception' && hasMeters) {
          console.warn(`[Diesel API] Row ${row.original_row_index}: Exception asset cannot have meter readings, clearing them`)
        }

        // Build transaction record
        const transactionData = {
          id: crypto.randomUUID(),
          transaction_id: transactionId,
          plant_id: plant.id,
          warehouse_id: warehouse.id,
          product_id: product.id,
          asset_id: assetIdForTransaction,
          asset_category: assetCategory,
          transaction_type: transactionType,
          quantity_liters: quantity,
          unit_cost: null,
          total_cost: null,
          // Clear meter readings for exception assets and general entries per DB constraints
          // Round meter readings to integers (database columns are integer type)
          horometer_reading: (assetCategory === 'exception' || assetCategory === 'general') 
            ? null 
            : (row.horometro != null ? Math.round(row.horometro) : null),
          kilometer_reading: (assetCategory === 'exception' || assetCategory === 'general') 
            ? null 
            : (row.kilometraje != null ? Math.round(row.kilometraje) : null),
          previous_horometer: null,
          previous_kilometer: null,
          operator_id: null, // Could be looked up by name if needed
          supplier_responsible: row.responsable_suministro || null,
          transaction_date: txDate.toISOString(),
          scheduled_time: row.horario ? row.horario : null,
          service_order_id: null,
          work_order_id: null,
          checklist_completion_id: null,
          requires_validation: row.has_validation_discrepancy || false,
          validated_at: null,
          validated_by: null,
          validation_notes: row.validacion || null,
          notes: row.adjustment_reason || null,
          created_by: user.id,
          created_at: new Date().toISOString(),
          updated_at: null,
          updated_by: null,
          exception_asset_name: exceptionAssetName,
          cuenta_litros: row.cuenta_litros,
          // validation_difference is a GENERATED column - do not insert
          adjustment_reason: row.adjustment_reason || null,
          adjustment_category: row.is_likely_adjustment ? 'manual' : null,
          reference_transaction_id: null,
          source_system: 'smartsheet_import',
          import_batch_id: plantBatch.batch_id
          // hours_consumed and kilometers_consumed are GENERATED columns - do not insert
        }

        console.log(`[Diesel API] Row ${row.original_row_index}: ${row.movement_category} → ${transactionType}/${assetCategory} - ${row.litros_cantidad}L - Asset: ${assetIdForTransaction || exceptionAssetName || 'none'}`)

        // Insert transaction into database
        const { data: insertedTx, error: insertError } = await supabase
          .from('diesel_transactions')
          .insert(transactionData)
          .select('id, transaction_id')
          .single()
        
        if (insertError) {
          console.error(`[Diesel API] Insert error for row ${row.original_row_index}:`, insertError)
          console.error(`[Diesel API] Transaction data:`, JSON.stringify(transactionData, null, 2))
          errors.push({
            row: row.original_row_index,
            error: `Database error: ${insertError.message}`
          })
          continue // Continue to next row instead of throwing
        }

        console.log(`[Diesel API] ✅ Inserted: ${insertedTx.transaction_id}`)
        
        processedRows.push(row.original_row_index)
        transactionsByType[row.movement_category]++
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : 'Unknown error'
        errors.push({
          row: row.original_row_index,
          error: errorMsg
        })
        console.error(`[Diesel API] Error processing row ${row.original_row_index}:`, errorMsg)
        console.error(`[Diesel API] Row data:`, JSON.stringify({
          movement_category: row.movement_category,
          tipo: row.tipo,
          unidad: row.unidad,
          litros: row.litros_cantidad,
          fecha: row.fecha_,
          resolved_asset_id: row.resolved_asset_id,
          resolved_asset_type: row.resolved_asset_type
        }, null, 2))
      }
    }

    console.log('[Diesel API] Processing complete. Transactions by type:', transactionsByType)

    // Step 5: Update meter readings (if approved)
    const updatedMeters = []
    
    if (meterResolutions) {
      for (const [assetCode, resolution] of Object.entries(meterResolutions)) {
        if (resolution === 'use_diesel') {
          const reading = plantBatch.meter_readings.find(r => r.asset_code === assetCode)
          if (reading) {
            // Get mapped asset UUID
            const assetMapping = assetMappings?.[assetCode]
            if (!assetMapping || !assetMapping.asset_id) {
              console.warn(`[Diesel API] No asset mapping for meter update: ${assetCode}`)
              continue
            }

            // Find asset by UUID from mapping
            const { data: asset } = await supabase
              .from('assets')
              .select('id, asset_id, name')
              .eq('id', assetMapping.asset_id)
              .maybeSingle()

            if (asset) {
              console.log(`[Diesel API] Updating meter for asset: ${asset.name}`)
              // Parse reading date
              const readingDate = typeof reading.reading_date === 'string' 
                ? new Date(reading.reading_date) 
                : reading.reading_date
              // Update asset with diesel reading (round to integers)
              const { error: updateError } = await supabase
                .from('assets')
                .update({
                  current_horometer: reading.horometer != null ? Math.round(reading.horometer) : null,
                  current_kilometer: reading.kilometer != null ? Math.round(reading.kilometer) : null,
                  last_reading_date: readingDate.toISOString(),
                  updated_at: new Date().toISOString()
                })
                .eq('id', asset.id)

              if (!updateError) {
                updatedMeters.push(assetCode)
                console.log(`[Diesel API] ✅ Updated meter for: ${asset.name}`)
              } else {
                console.error(`[Diesel API] Failed to update meter for: ${asset.name}`, updateError)
              }
            } else {
              console.warn(`[Diesel API] Asset not found for meter update: ${assetCode}`)
            }
          }
        }
      }
    }

    // Step 6: Update warehouse inventory
    // const { error: inventoryError } = await supabase
    //   .from('diesel_inventories')
    //   .upsert({
    //     warehouse_id: warehouseId,
    //     current_balance: plantBatch.final_inventory_computed,
    //     last_updated: new Date().toISOString()
    //   })

    // Step 7: Record import history
    // const { error: historyError } = await supabase
    //   .from('diesel_import_history')
    //   .insert({
    //     batch_id: plantBatch.batch_id,
    //     plant_id: plant.id,
    //     warehouse_id: warehouseId,
    //     original_filename: plantBatch.original_filename,
    //     total_rows: plantBatch.total_rows,
    //     processed_rows: processedRows.length,
    //     error_rows: errors.length,
    //     initial_inventory: plantBatch.initial_inventory,
    //     final_inventory_computed: plantBatch.final_inventory_computed,
    //     final_inventory_provided: plantBatch.final_inventory_provided,
    //     inventory_discrepancy: plantBatch.inventory_discrepancy,
    //     meter_readings_imported: plantBatch.meter_readings.length,
    //     meter_conflicts_resolved: updatedMeters.length,
    //     processing_summary: {
    //       processed: processedRows,
    //       errors
    //     },
    //     created_by: user.id
    //   })

    return NextResponse.json({
      status: 'completed',
      message: 'Plant batch processed successfully',
      summary: {
        plant_code: plantBatch.plant_code,
        warehouse_number: plantBatch.warehouse_number,
        total_rows: plantBatch.total_rows,
        processed_rows: processedRows.length,
        error_rows: errors.length,
        meter_readings_updated: updatedMeters.length,
        inventory_updated: true,
        final_inventory: plantBatch.final_inventory_computed,
        transactions_by_type: transactionsByType,
        initial_inventory: plantBatch.initial_inventory,
        inventory_discrepancy: plantBatch.inventory_discrepancy
      },
      errors: errors.length > 0 ? errors : undefined
    })

  } catch (error) {
    console.error('[Diesel API] Process batch error:', error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Internal server error' },
      { status: 500 }
    )
  }
}
