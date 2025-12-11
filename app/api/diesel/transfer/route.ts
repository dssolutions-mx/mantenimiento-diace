import { NextRequest, NextResponse } from 'next/server'
import { createClient as createServerSupabase } from '@/lib/supabase-server'

export async function POST(req: NextRequest) {
  try {
    const supabase = await createServerSupabase()
    const { data: { user } } = await supabase.auth.getUser()
    
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const body = await req.json()
    const {
      from_warehouse_id,
      to_warehouse_id,
      quantity_liters,
      transaction_date,
      notes
    } = body

    // Validation
    if (!from_warehouse_id || !to_warehouse_id) {
      return NextResponse.json({ error: 'Source and destination warehouses are required' }, { status: 400 })
    }

    if (from_warehouse_id === to_warehouse_id) {
      return NextResponse.json({ error: 'Source and destination warehouses must be different' }, { status: 400 })
    }

    if (!quantity_liters || parseFloat(quantity_liters) <= 0) {
      return NextResponse.json({ error: 'Quantity must be greater than 0' }, { status: 400 })
    }

    // Get warehouse details
    const { data: warehouses, error: warehousesError } = await supabase
      .from('diesel_warehouses')
      .select('id, plant_id, plants(code, name), current_inventory, product_type')
      .in('id', [from_warehouse_id, to_warehouse_id])

    if (warehousesError || !warehouses || warehouses.length !== 2) {
      return NextResponse.json({ error: 'Invalid warehouses' }, { status: 400 })
    }

    const fromWarehouse = warehouses.find(w => w.id === from_warehouse_id)
    const toWarehouse = warehouses.find(w => w.id === to_warehouse_id)

    if (!fromWarehouse || !toWarehouse) {
      return NextResponse.json({ error: 'Warehouses not found' }, { status: 404 })
    }

    // Check product type match
    if (fromWarehouse.product_type !== toWarehouse.product_type) {
      return NextResponse.json({ error: 'Warehouses must have the same product type' }, { status: 400 })
    }

    // Check sufficient inventory
    const currentInventory = fromWarehouse.current_inventory || 0
    if (currentInventory < parseFloat(quantity_liters)) {
      return NextResponse.json({ 
        error: `Insufficient inventory. Available: ${currentInventory}L, Requested: ${quantity_liters}L` 
      }, { status: 400 })
    }

    // Get product ID
    const productType = fromWarehouse.product_type
    const { data: product, error: productError } = await supabase
      .from('diesel_products')
      .select('id')
      .eq('product_type', productType)
      .single()

    if (productError || !product) {
      return NextResponse.json({ error: 'Product not found' }, { status: 404 })
    }

    // Generate transaction IDs
    const dateStr = transaction_date ? new Date(transaction_date).toISOString().split('T')[0].replace(/-/g, '') : new Date().toISOString().split('T')[0].replace(/-/g, '')
    const fromPlantCode = (fromWarehouse.plants as any)?.code || 'UNK'
    const toPlantCode = (toWarehouse.plants as any)?.code || 'UNK'
    
    const transferOutId = `DSL-${fromPlantCode}-${dateStr}-TRF-OUT`
    const transferInId = `DSL-${toPlantCode}-${dateStr}-TRF-IN`

    // Calculate balances
    const fromPreviousBalance = currentInventory
    const fromCurrentBalance = fromPreviousBalance - parseFloat(quantity_liters)
    const toPreviousBalance = toWarehouse.current_inventory || 0
    const toCurrentBalance = toPreviousBalance + parseFloat(quantity_liters)

    // Create transfer-out transaction (consumption)
    const transferOutData = {
      transaction_id: transferOutId,
      plant_id: fromWarehouse.plant_id,
      warehouse_id: from_warehouse_id,
      product_id: product.id,
      transaction_type: 'consumption',
      asset_category: 'general',
      asset_id: null,
      quantity_liters: parseFloat(quantity_liters),
      previous_balance: fromPreviousBalance,
      current_balance: fromCurrentBalance,
      transaction_date: transaction_date ? new Date(transaction_date).toISOString() : new Date().toISOString(),
      notes: notes || `[TRANSFER] To ${(toWarehouse.plants as any)?.name || 'Plant'} (${toPlantCode})`,
      is_transfer: true,
      created_by: user.id,
      source_system: 'web_app'
    }

    // Create transfer-in transaction (entry)
    const transferInData = {
      transaction_id: transferInId,
      plant_id: toWarehouse.plant_id,
      warehouse_id: to_warehouse_id,
      product_id: product.id,
      transaction_type: 'entry',
      asset_category: 'general',
      asset_id: null,
      quantity_liters: parseFloat(quantity_liters),
      previous_balance: toPreviousBalance,
      current_balance: toCurrentBalance,
      transaction_date: transaction_date ? new Date(transaction_date).toISOString() : new Date().toISOString(),
      notes: notes || `[TRANSFER] From ${(fromWarehouse.plants as any)?.name || 'Plant'} (${fromPlantCode})`,
      is_transfer: true,
      created_by: user.id,
      source_system: 'web_app'
    }

    // Insert transfer-out transaction first
    const { data: transferOut, error: transferOutError } = await supabase
      .from('diesel_transactions')
      .insert(transferOutData)
      .select()
      .single()

    if (transferOutError) {
      console.error('Error creating transfer-out:', transferOutError)
      return NextResponse.json({ error: 'Failed to create transfer-out transaction', details: transferOutError.message }, { status: 500 })
    }

    // Link transfer-in to transfer-out
    transferInData.reference_transaction_id = transferOut.id

    // Insert transfer-in transaction
    const { data: transferIn, error: transferInError } = await supabase
      .from('diesel_transactions')
      .insert(transferInData)
      .select()
      .single()

    if (transferInError) {
      // Rollback: delete transfer-out if transfer-in fails
      await supabase.from('diesel_transactions').delete().eq('id', transferOut.id)
      console.error('Error creating transfer-in:', transferInError)
      return NextResponse.json({ error: 'Failed to create transfer-in transaction', details: transferInError.message }, { status: 500 })
    }

    // Update reference_transaction_id on transfer-out to link back
    await supabase
      .from('diesel_transactions')
      .update({ reference_transaction_id: transferIn.id })
      .eq('id', transferOut.id)

    // Update warehouse inventories (triggers should handle this, but ensure consistency)
    await supabase
      .from('diesel_warehouses')
      .update({ 
        current_inventory: fromCurrentBalance,
        last_updated: new Date().toISOString()
      })
      .eq('id', from_warehouse_id)

    await supabase
      .from('diesel_warehouses')
      .update({ 
        current_inventory: toCurrentBalance,
        last_updated: new Date().toISOString()
      })
      .eq('id', to_warehouse_id)

    return NextResponse.json({
      success: true,
      transfer_out: transferOut,
      transfer_in: transferIn,
      message: `Transfer of ${quantity_liters}L completed successfully`
    })

  } catch (error: any) {
    console.error('Transfer API error:', error)
    return NextResponse.json({ 
      error: 'Internal server error', 
      details: error.message 
    }, { status: 500 })
  }
}
