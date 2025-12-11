import { NextRequest, NextResponse } from 'next/server'
import { createClient as createServerSupabase } from '@/lib/supabase-server'
import { calculateTransferFIFOCost } from '@/lib/calculate-transfer-fifo-cost'

/**
 * API endpoint to fix missing prices on existing transfer transactions
 * 
 * This retroactively calculates and assigns FIFO prices to transfer transactions
 * that were marked as transfers before the automatic price calculation was implemented.
 * 
 * Can fix:
 * 1. A specific transfer transaction (entry_transaction_id)
 * 2. All transfer transactions missing prices (if no ID provided)
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
      entry_transaction_id, // Optional - if provided, fixes only this transaction
      fix_all = false // If true and no ID provided, fixes all transfers missing prices
    } = body

    // If specific transaction ID provided, fix only that one
    if (entry_transaction_id) {
      return await fixSingleTransfer(supabase, entry_transaction_id)
    }

    // If fix_all is true, find and fix all transfers missing prices
    if (fix_all) {
      return await fixAllTransfersMissingPrices(supabase)
    }

    return NextResponse.json({ 
      error: 'Either entry_transaction_id or fix_all=true must be provided' 
    }, { status: 400 })

  } catch (error: any) {
    console.error('Fix transfer price API error:', error)
    return NextResponse.json({ 
      error: 'Internal server error', 
      details: error.message 
    }, { status: 500 })
  }
}

async function fixSingleTransfer(supabase: any, entryTransactionId: string) {
  // Get the entry transaction (transfer-in)
  const { data: entryTx, error: entryError } = await supabase
    .from('diesel_transactions')
    .select(`
      *,
      diesel_warehouses!inner(id, plant_id, plants(code, name))
    `)
    .eq('id', entryTransactionId)
    .eq('transaction_type', 'entry')
    .eq('is_transfer', true)
    .single()

  if (entryError || !entryTx) {
    return NextResponse.json({ 
      error: 'Transfer entry transaction not found or invalid',
      details: entryError?.message 
    }, { status: 404 })
  }

  // If it already has a price, no need to fix
  if (entryTx.unit_cost && Number(entryTx.unit_cost) > 0) {
    return NextResponse.json({
      success: true,
      message: 'Transaction already has a price',
      transaction: entryTx
    })
  }

  // Get the linked consumption transaction (transfer-out)
  if (!entryTx.reference_transaction_id) {
    return NextResponse.json({ 
      error: 'Transfer entry transaction is not linked to a transfer-out transaction',
      details: 'Missing reference_transaction_id'
    }, { status: 400 })
  }

  const { data: consumptionTx, error: consumptionError } = await supabase
    .from('diesel_transactions')
    .select(`
      *,
      diesel_warehouses!inner(id, plant_id, plants(code, name))
    `)
    .eq('id', entryTx.reference_transaction_id)
    .eq('transaction_type', 'consumption')
    .eq('is_transfer', true)
    .single()

  if (consumptionError || !consumptionTx) {
    return NextResponse.json({ 
      error: 'Linked transfer-out transaction not found',
      details: consumptionError?.message 
    }, { status: 404 })
  }

  // Calculate FIFO cost from source warehouse
  let transferPrice = consumptionTx.unit_cost

  if (!transferPrice || Number(transferPrice) <= 0) {
    // Calculate FIFO cost from source warehouse inventory
    const fifoCost = await calculateTransferFIFOCost(
      supabase,
      consumptionTx.warehouse_id,
      consumptionTx.product_id,
      consumptionTx.quantity_liters,
      consumptionTx.transaction_date
    )

    if (!fifoCost || fifoCost <= 0) {
      return NextResponse.json({ 
        error: 'Could not calculate FIFO cost for this transfer',
        details: 'No inventory lots available or insufficient data',
        source_warehouse: consumptionTx.diesel_warehouses,
        transaction_date: consumptionTx.transaction_date
      }, { status: 400 })
    }

    transferPrice = fifoCost
  }

  // Update both transactions with the price
  const updates: any[] = []

  // Update transfer-out if missing price
  if (!consumptionTx.unit_cost || Number(consumptionTx.unit_cost) <= 0) {
    const { error: updateOutError } = await supabase
      .from('diesel_transactions')
      .update({
        unit_cost: transferPrice,
        total_cost: transferPrice * consumptionTx.quantity_liters
      })
      .eq('id', consumptionTx.id)

    if (updateOutError) {
      return NextResponse.json({ 
        error: 'Failed to update transfer-out transaction',
        details: updateOutError.message 
      }, { status: 500 })
    }

    updates.push({ type: 'transfer-out', id: consumptionTx.id, price: transferPrice })
  }

  // Update transfer-in
  const { data: updatedEntry, error: updateEntryError } = await supabase
    .from('diesel_transactions')
    .update({
      unit_cost: transferPrice,
      total_cost: transferPrice * entryTx.quantity_liters
    })
    .eq('id', entryTx.id)
    .select()
    .single()

  if (updateEntryError) {
    return NextResponse.json({ 
      error: 'Failed to update transfer-in transaction',
      details: updateEntryError.message 
    }, { status: 500 })
  }

  updates.push({ type: 'transfer-in', id: entryTx.id, price: transferPrice })

  return NextResponse.json({
    success: true,
    message: 'Transfer price calculated and assigned successfully',
    price: transferPrice,
    updates,
    transfer_in: updatedEntry
  })
}

async function fixAllTransfersMissingPrices(supabase: any) {
  // Find all transfer entry transactions missing prices
  const { data: transfersMissingPrice, error: findError } = await supabase
    .from('diesel_transactions')
    .select(`
      id,
      reference_transaction_id,
      warehouse_id,
      product_id,
      quantity_liters,
      transaction_date
    `)
    .eq('transaction_type', 'entry')
    .eq('is_transfer', true)
    .or('unit_cost.is.null,unit_cost.lte.0')
    .not('reference_transaction_id', 'is', null)

  if (findError) {
    return NextResponse.json({ 
      error: 'Failed to find transfers missing prices',
      details: findError.message 
    }, { status: 500 })
  }

  if (!transfersMissingPrice || transfersMissingPrice.length === 0) {
    return NextResponse.json({
      success: true,
      message: 'No transfers found missing prices',
      fixed_count: 0
    })
  }

  const results = {
    fixed: [] as any[],
    failed: [] as any[],
    skipped: [] as any[]
  }

  // Process each transfer
  for (const entryTx of transfersMissingPrice) {
    try {
      // Get the linked consumption transaction
      const { data: consumptionTx } = await supabase
        .from('diesel_transactions')
        .select('warehouse_id, product_id, quantity_liters, transaction_date, unit_cost')
        .eq('id', entryTx.reference_transaction_id)
        .single()

      if (!consumptionTx) {
        results.failed.push({
          entry_id: entryTx.id,
          reason: 'Linked transfer-out transaction not found'
        })
        continue
      }

      // Calculate FIFO cost
      let transferPrice = consumptionTx.unit_cost

      if (!transferPrice || Number(transferPrice) <= 0) {
        const fifoCost = await calculateTransferFIFOCost(
          supabase,
          consumptionTx.warehouse_id,
          consumptionTx.product_id,
          consumptionTx.quantity_liters,
          consumptionTx.transaction_date
        )

        if (!fifoCost || fifoCost <= 0) {
          results.failed.push({
            entry_id: entryTx.id,
            reason: 'Could not calculate FIFO cost'
          })
          continue
        }

        transferPrice = fifoCost

        // Update transfer-out if needed
        if (!consumptionTx.unit_cost || Number(consumptionTx.unit_cost) <= 0) {
          await supabase
            .from('diesel_transactions')
            .update({
              unit_cost: transferPrice,
              total_cost: transferPrice * consumptionTx.quantity_liters
            })
            .eq('id', entryTx.reference_transaction_id)
        }
      }

      // Update transfer-in
      const { error: updateError } = await supabase
        .from('diesel_transactions')
        .update({
          unit_cost: transferPrice,
          total_cost: transferPrice * entryTx.quantity_liters
        })
        .eq('id', entryTx.id)

      if (updateError) {
        results.failed.push({
          entry_id: entryTx.id,
          reason: updateError.message
        })
      } else {
        results.fixed.push({
          entry_id: entryTx.id,
          price: transferPrice
        })
      }
    } catch (error: any) {
      results.failed.push({
        entry_id: entryTx.id,
        reason: error.message
      })
    }
  }

  return NextResponse.json({
    success: true,
    message: `Processed ${transfersMissingPrice.length} transfers`,
    fixed_count: results.fixed.length,
    failed_count: results.failed.length,
    skipped_count: results.skipped.length,
    results
  })
}

