import { NextRequest, NextResponse } from 'next/server'
import { createClient as createServerSupabase } from '@/lib/supabase-server'
import { calculateTransferFIFOCost } from '@/lib/calculate-transfer-fifo-cost'

/**
 * API endpoint to mark existing transactions as transfers
 * 
 * This allows retroactively marking Plant 4 transactions (or any transactions)
 * as transfers. It will:
 * 1. Mark the consumption transaction as a transfer
 * 2. Find or create a matching entry transaction
 * 3. Link them via reference_transaction_id
 * 4. Preserve pricing from the source transaction
 */
export async function POST(req: NextRequest) {
  try {
    const supabase = await createServerSupabase()
    const { data: { user } } = await supabase.auth.getUser()
    
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const body = await req.json()
    const {
      consumption_transaction_id,
      entry_transaction_id, // Optional - if not provided, will try to find matching entry
      to_warehouse_id, // Required if entry_transaction_id not provided
      preserve_price = true // Whether to preserve unit_cost from consumption transaction
    } = body

    if (!consumption_transaction_id) {
      return NextResponse.json({ error: 'consumption_transaction_id is required' }, { status: 400 })
    }

    // Get the consumption transaction
    const { data: consumptionTx, error: consumptionError } = await supabase
      .from('diesel_transactions')
      .select(`
        *,
        diesel_warehouses!inner(id, plant_id, plants(code, name))
      `)
      .eq('id', consumption_transaction_id)
      .eq('transaction_type', 'consumption')
      .single()

    if (consumptionError || !consumptionTx) {
      return NextResponse.json({ 
        error: 'Consumption transaction not found or invalid',
        details: consumptionError?.message 
      }, { status: 404 })
    }

    // Check if already marked as transfer
    if (consumptionTx.is_transfer) {
      return NextResponse.json({ 
        error: 'Transaction is already marked as a transfer',
        transfer_out: consumptionTx,
        transfer_in: consumptionTx.reference_transaction_id ? await getTransferIn(supabase, consumptionTx.reference_transaction_id) : null
      }, { status: 400 })
    }

    let entryTx = null

    // If entry_transaction_id provided, use it
    if (entry_transaction_id) {
      const { data: entry, error: entryError } = await supabase
        .from('diesel_transactions')
        .select(`
          *,
          diesel_warehouses!inner(id, plant_id, plants(code, name))
        `)
        .eq('id', entry_transaction_id)
        .eq('transaction_type', 'entry')
        .single()

      if (entryError || !entry) {
        return NextResponse.json({ 
          error: 'Entry transaction not found or invalid',
          details: entryError?.message 
        }, { status: 404 })
      }

      // Validate they match
      if (Math.abs(entry.quantity_liters - consumptionTx.quantity_liters) > 0.01) {
        return NextResponse.json({ 
          error: 'Transaction quantities do not match',
          consumption_quantity: consumptionTx.quantity_liters,
          entry_quantity: entry.quantity_liters
        }, { status: 400 })
      }

      if (entry.product_id !== consumptionTx.product_id) {
        return NextResponse.json({ 
          error: 'Transactions must be for the same product'
        }, { status: 400 })
      }

      entryTx = entry
    } else if (to_warehouse_id) {
      // Try to find matching entry transaction
      const { data: matchingEntries, error: findError } = await supabase
        .from('diesel_transactions')
        .select(`
          *,
          diesel_warehouses!inner(id, plant_id, plants(code, name))
        `)
        .eq('transaction_type', 'entry')
        .eq('warehouse_id', to_warehouse_id)
        .eq('product_id', consumptionTx.product_id)
        .eq('is_transfer', false)
        .gte('quantity_liters', consumptionTx.quantity_liters - 0.01)
        .lte('quantity_liters', consumptionTx.quantity_liters + 0.01)
        .gte('transaction_date', new Date(consumptionTx.transaction_date).toISOString().split('T')[0])
        .order('transaction_date', { ascending: false })
        .limit(5)

      if (findError || !matchingEntries || matchingEntries.length === 0) {
        return NextResponse.json({ 
          error: 'No matching entry transaction found. Please provide entry_transaction_id or create the entry transaction first.',
          suggestion: 'Create the entry transaction first, then mark both as transfers together.'
        }, { status: 404 })
      }

      // Use the closest match by date
      entryTx = matchingEntries[0]
    } else {
      return NextResponse.json({ 
        error: 'Either entry_transaction_id or to_warehouse_id must be provided'
      }, { status: 400 })
    }

    // Check if entry is already marked as transfer
    if (entryTx.is_transfer) {
      return NextResponse.json({ 
        error: 'Entry transaction is already marked as a transfer',
        transfer_in: entryTx
      }, { status: 400 })
    }

    // Validate warehouses are different
    const fromWarehouse = consumptionTx.diesel_warehouses
    const toWarehouse = entryTx.diesel_warehouses
    
    if (fromWarehouse.id === toWarehouse.id) {
      return NextResponse.json({ 
        error: 'Source and destination warehouses must be different'
      }, { status: 400 })
    }

    // Calculate FIFO cost for the transfer if price is missing
    let transferPrice = consumptionTx.unit_cost
    
    if (!transferPrice && preserve_price) {
      // Calculate FIFO cost from source warehouse inventory
      const fifoCost = await calculateTransferFIFOCost(
        supabase,
        consumptionTx.warehouse_id,
        consumptionTx.product_id,
        consumptionTx.quantity_liters,
        consumptionTx.transaction_date
      )
      
      if (fifoCost && fifoCost > 0) {
        transferPrice = fifoCost
        console.log(`Calculated FIFO cost for transfer: $${fifoCost.toFixed(2)}/L`)
      }
    }

    // Update consumption transaction (transfer-out)
    const transferOutUpdate: any = {
      is_transfer: true,
      reference_transaction_id: entryTx.id,
      notes: consumptionTx.notes 
        ? `${consumptionTx.notes} | [TRANSFER] To ${(toWarehouse.plants as any)?.name || 'Plant'}`
        : `[TRANSFER] To ${(toWarehouse.plants as any)?.name || 'Plant'}`
    }

    // Update price on transfer-out if we calculated it
    if (transferPrice && !consumptionTx.unit_cost) {
      transferOutUpdate.unit_cost = transferPrice
      transferOutUpdate.total_cost = transferPrice * consumptionTx.quantity_liters
    }

    const { data: updatedConsumption, error: updateConsumptionError } = await supabase
      .from('diesel_transactions')
      .update(transferOutUpdate)
      .eq('id', consumption_transaction_id)
      .select()
      .single()

    if (updateConsumptionError) {
      return NextResponse.json({ 
        error: 'Failed to update consumption transaction',
        details: updateConsumptionError.message 
      }, { status: 500 })
    }

    // Update entry transaction (transfer-in)
    const transferInUpdate: any = {
      is_transfer: true,
      reference_transaction_id: consumption_transaction_id,
      notes: entryTx.notes 
        ? `${entryTx.notes} | [TRANSFER] From ${(fromWarehouse.plants as any)?.name || 'Plant'}`
        : `[TRANSFER] From ${(fromWarehouse.plants as any)?.name || 'Plant'}`
    }

    // For transfer-in, assign price from transfer-out (either existing or calculated FIFO)
    // This maintains cost basis continuity and ensures FIFO pricing is preserved
    if (preserve_price && transferPrice && transferPrice > 0 && !entryTx.unit_cost) {
      transferInUpdate.unit_cost = transferPrice
      transferInUpdate.total_cost = transferPrice * entryTx.quantity_liters
      console.log(`Assigned FIFO price to transfer-in: $${transferPrice.toFixed(2)}/L`)
    } else if (preserve_price && consumptionTx.unit_cost && !entryTx.unit_cost) {
      // Fallback to existing price if FIFO calculation didn't work
      transferInUpdate.unit_cost = consumptionTx.unit_cost
      transferInUpdate.total_cost = consumptionTx.unit_cost * entryTx.quantity_liters
    }

    const { data: updatedEntry, error: updateEntryError } = await supabase
      .from('diesel_transactions')
      .update(transferInUpdate)
      .eq('id', entryTx.id)
      .select()
      .single()

    if (updateEntryError) {
      // Rollback consumption update
      await supabase
        .from('diesel_transactions')
        .update({ 
          is_transfer: false, 
          reference_transaction_id: null 
        })
        .eq('id', consumption_transaction_id)

      return NextResponse.json({ 
        error: 'Failed to update entry transaction',
        details: updateEntryError.message 
      }, { status: 500 })
    }

    return NextResponse.json({
      success: true,
      transfer_out: updatedConsumption,
      transfer_in: updatedEntry,
      message: 'Transactions successfully marked as transfers'
    })

  } catch (error: any) {
    console.error('Mark transfer API error:', error)
    return NextResponse.json({ 
      error: 'Internal server error', 
      details: error.message 
    }, { status: 500 })
  }
}

async function getTransferIn(supabase: any, transactionId: string) {
  const { data } = await supabase
    .from('diesel_transactions')
    .select('*')
    .eq('id', transactionId)
    .single()
  return data
}
