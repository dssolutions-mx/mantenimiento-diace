/**
 * Calculate FIFO cost for a transfer transaction
 * 
 * This function calculates what the cost should be for a transfer-out transaction
 * based on the FIFO inventory lots available at the source warehouse.
 * This cost is then used to price the transfer-in entry transaction.
 */

export async function calculateTransferFIFOCost(
  supabase: any,
  warehouseId: string,
  productId: string,
  quantityLiters: number,
  transactionDate: string
): Promise<number | null> {
  try {
    // Get warehouse's plant code
    const { data: warehouse, error: warehouseError } = await supabase
      .from('diesel_warehouses')
      .select('plant_id, plants(code)')
      .eq('id', warehouseId)
      .single()

    if (warehouseError || !warehouse) {
      console.error('Error fetching warehouse:', warehouseError)
      return null
    }

    const plantCode = (warehouse.plants as any)?.code
    if (!plantCode) {
      console.error('Plant code not found for warehouse')
      return null
    }

    // Extend window to 45 days back to ensure we capture entries that might still be in inventory
    const txDate = new Date(transactionDate)
    const entriesStartDate = new Date(txDate)
    entriesStartDate.setDate(entriesStartDate.getDate() - 45)
    entriesStartDate.setHours(0, 0, 0, 0)

    const entriesStartDateISO = entriesStartDate.toISOString()
    const transactionDateISO = txDate.toISOString()

    // Fetch entries (both regular and transfer-in) with prices up to the transaction date
    const { data: allEntries, error: entriesError } = await supabase
      .from('diesel_transactions')
      .select(`id, warehouse_id, product_id, quantity_liters, unit_cost, transaction_date, is_transfer`)
      .eq('transaction_type', 'entry')
      .eq('warehouse_id', warehouseId)
      .eq('product_id', productId)
      .not('unit_cost', 'is', null)
      .gt('unit_cost', 0)
      .gte('transaction_date', entriesStartDateISO)
      .lte('transaction_date', transactionDateISO)
      .order('transaction_date', { ascending: true })

    if (entriesError) {
      console.error('Error fetching entries for FIFO:', entriesError)
      return null
    }

    // Fetch consumptions (excluding transfers) up to the transaction date
    const { data: allConsumptions, error: consumptionsError } = await supabase
      .from('diesel_transactions')
      .select(`id, warehouse_id, product_id, quantity_liters, transaction_date`)
      .eq('transaction_type', 'consumption')
      .eq('warehouse_id', warehouseId)
      .eq('product_id', productId)
      .eq('is_transfer', false) // Exclude transfer-out consumptions
      .gte('transaction_date', entriesStartDateISO)
      .lte('transaction_date', transactionDateISO)
      .order('transaction_date', { ascending: true })

    if (consumptionsError) {
      console.error('Error fetching consumptions for FIFO:', consumptionsError)
      return null
    }

    // Build inventory lots chronologically
    const inventoryLots: Array<{ liters: number, unitCost: number, date: string }> = []
    
    // Combine entries and consumptions, sort chronologically
    const allTransactions: Array<{
      type: 'entry' | 'consumption'
      date: string
      liters: number
      unitCost?: number
    }> = []

    ;(allEntries || []).forEach(entry => {
      allTransactions.push({
        type: 'entry',
        date: entry.transaction_date,
        liters: Number(entry.quantity_liters || 0),
        unitCost: Number(entry.unit_cost || 0)
      })
    })

    ;(allConsumptions || []).forEach(consumption => {
      allTransactions.push({
        type: 'consumption',
        date: consumption.transaction_date,
        liters: Number(consumption.quantity_liters || 0)
      })
    })

    // Sort chronologically (entries before consumptions on same timestamp)
    allTransactions.sort((a, b) => {
      const timeDiff = new Date(a.date).getTime() - new Date(b.date).getTime()
      if (timeDiff !== 0) return timeDiff
      if (a.type === 'entry' && b.type === 'consumption') return -1
      if (a.type === 'consumption' && b.type === 'entry') return 1
      return 0
    })

    // Process transactions to build inventory lots
    allTransactions.forEach(tx => {
      if (tx.type === 'entry') {
        if (tx.liters > 0 && tx.unitCost && tx.unitCost > 0) {
          inventoryLots.push({
            liters: tx.liters,
            unitCost: tx.unitCost,
            date: tx.date
          })
          // Keep lots sorted by date
          inventoryLots.sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime())
        }
      } else if (tx.type === 'consumption') {
        // Consume from oldest inventory lots first (FIFO)
        let remainingLiters = tx.liters
        let lotIndex = 0

        while (remainingLiters > 0 && lotIndex < inventoryLots.length) {
          const lot = inventoryLots[lotIndex]

          if (lot.date > tx.date) {
            lotIndex++
            continue
          }

          if (lot.liters <= 0.01) {
            lotIndex++
            continue
          }

          const consumeFromLot = Math.min(remainingLiters, lot.liters)
          remainingLiters -= consumeFromLot
          lot.liters -= consumeFromLot

          if (lot.liters <= 0.01) {
            inventoryLots.splice(lotIndex, 1)
          } else {
            lotIndex++
          }
        }
      }
    })

    // Calculate weighted average for fallback
    const entriesWithPrice = (allEntries || []).filter(tx => tx.unit_cost && Number(tx.unit_cost) > 0)
    let weightedAvgPrice = 0
    if (entriesWithPrice.length > 0) {
      const totalLiters = entriesWithPrice.reduce((sum, e) => sum + Number(e.quantity_liters || 0), 0)
      const totalCost = entriesWithPrice.reduce((sum, e) => sum + (Number(e.quantity_liters || 0) * Number(e.unit_cost || 0)), 0)
      if (totalLiters > 0) {
        weightedAvgPrice = totalCost / totalLiters
      }
    }

    // Now calculate cost for the transfer quantity using FIFO
    let remainingTransferLiters = quantityLiters
    let totalCost = 0
    let lotIndex = 0

    // Consume from oldest inventory lots first (FIFO)
    while (remainingTransferLiters > 0 && lotIndex < inventoryLots.length) {
      const lot = inventoryLots[lotIndex]

      if (lot.liters <= 0.01) {
        lotIndex++
        continue
      }

      const consumeFromLot = Math.min(remainingTransferLiters, lot.liters)
      const cost = consumeFromLot * lot.unitCost
      totalCost += cost
      remainingTransferLiters -= consumeFromLot
      lot.liters -= consumeFromLot

      if (lot.liters <= 0.01) {
        inventoryLots.splice(lotIndex, 1)
      } else {
        lotIndex++
      }
    }

    // If FIFO lots exhausted, use weighted average
    if (remainingTransferLiters > 0) {
      if (weightedAvgPrice > 0) {
        totalCost += remainingTransferLiters * weightedAvgPrice
      } else {
        // No price available
        return null
      }
    }

    // Calculate average unit cost
    if (quantityLiters > 0) {
      return totalCost / quantityLiters
    }

    return null
  } catch (error: any) {
    console.error('Error calculating transfer FIFO cost:', error)
    return null
  }
}

