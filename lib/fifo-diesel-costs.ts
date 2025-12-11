/**
 * FIFO Diesel Cost Calculation Utility
 * 
 * Calculates diesel costs using First-In-First-Out (FIFO) inventory costing.
 * Returns costs per plant code and per consumption transaction ID.
 */

export interface FIFOCostResult {
  plantCosts: Map<string, number> // plant_code -> total cost
  transactionCosts: Map<string, number> // consumption_transaction_id -> cost
}

/**
 * Calculate diesel costs using FIFO with weighted average fallback
 * Returns costs per plant and per consumption transaction
 */
export async function calculateDieselCostsFIFO(
  supabase: any,
  dateFromStr: string,
  dateToStr: string,
  plantCodes: string[],
  priceByProduct: Map<string, number>
): Promise<FIFOCostResult> {
  // Extend window to 45 days back to ensure we capture entries that might still be in inventory
  const entriesStartDate = new Date(dateFromStr)
  entriesStartDate.setDate(entriesStartDate.getDate() - 45) // 45 days back (when prices were added)
  entriesStartDate.setHours(0, 0, 0, 0)
  
  const dateToEnd = new Date(dateToStr)
  dateToEnd.setHours(23, 59, 59, 999) // End of day
  
  const entriesStartDateISO = entriesStartDate.toISOString()
  const dateToEndISO = dateToEnd.toISOString()
  
  const reportStartDateISO = `${dateFromStr}T00:00:00.000Z`
  const reportEndDateISO = `${dateToStr}T23:59:59.999Z`
  
  // Get warehouse IDs for target plants (only diesel warehouses)
  const { data: warehouses } = await supabase
    .from('diesel_warehouses')
    .select('id, plant_id, plants(code)')
    .eq('product_type', 'diesel')
  
  const warehouseToPlantCode = new Map<string, string>()
  const targetWarehouseIds: string[] = []
  ;(warehouses || []).forEach((wh: any) => {
    const code = (wh.plants as any)?.code
    if (code && plantCodes.includes(code)) {
      warehouseToPlantCode.set(wh.id, code)
      targetWarehouseIds.push(wh.id)
    }
  })

  if (targetWarehouseIds.length === 0) {
    return { plantCosts: new Map(), transactionCosts: new Map() }
  }

  // Fetch entries from last 45 days
  // Include both regular entries AND transfer-in entries (they carry forward cost basis)
  // Transfer-in entries preserve the cost basis from the source plant (e.g., Plant 4)
  // When diesel is consumed later at the receiving plant, it uses this preserved price
  const { data: allEntries } = await supabase
    .from('diesel_transactions')
    .select(`id, warehouse_id, product_id, quantity_liters, unit_cost, transaction_date, is_transfer`)
    .eq('transaction_type', 'entry')
    .gte('transaction_date', entriesStartDateISO)
    .lte('transaction_date', dateToEndISO)
    .in('warehouse_id', targetWarehouseIds)
    .not('unit_cost', 'is', null)
    .gt('unit_cost', 0)
    .order('transaction_date', { ascending: true })

  // Include both regular entries (is_transfer = false/null) and transfer-in entries (is_transfer = true)
  // Both types add to FIFO inventory lots with their unit_cost
  const entriesWithPrice = (allEntries || []).filter(tx => 
    tx.unit_cost && Number(tx.unit_cost) > 0
  )

  // Fetch consumptions from same date range as entries
  // Exclude transfer-out consumptions (they don't consume from FIFO inventory)
  // Transfer-out consumptions are inventory movements, not actual consumption
  const consumptionQueryStart = new Date(dateFromStr)
  consumptionQueryStart.setDate(consumptionQueryStart.getDate() - 45)
  consumptionQueryStart.setHours(0, 0, 0, 0)
  const consumptionQueryStartISO = consumptionQueryStart.toISOString()

  const { data: allConsumptions } = await supabase
    .from('diesel_transactions')
    .select(`id, warehouse_id, product_id, quantity_liters, transaction_date`)
    .eq('transaction_type', 'consumption')
    .eq('is_transfer', false) // Exclude transfer-out consumptions from FIFO
    .gte('transaction_date', consumptionQueryStartISO)
    .lte('transaction_date', reportEndDateISO)
    .in('warehouse_id', targetWarehouseIds)
    .order('transaction_date', { ascending: true })

  const allConsumptionsFetched = allConsumptions || []
  
  // Helper function to convert UTC timestamp to GMT-6
  const getLocalDateStr = (utcTimestamp: string): string => {
    const utcDate = new Date(utcTimestamp)
    const localTimeMs = utcDate.getTime() - (6 * 60 * 60 * 1000)
    const localDate = new Date(localTimeMs)
    const year = localDate.getUTCFullYear()
    const month = String(localDate.getUTCMonth() + 1).padStart(2, '0')
    const day = String(localDate.getUTCDate()).padStart(2, '0')
    return `${year}-${month}-${day}`
  }
  
  // Filter consumptions in period
  const consumptionsInPeriod = allConsumptionsFetched.filter(cons => {
    if (!cons.transaction_date) return false
    const consDateStr = getLocalDateStr(cons.transaction_date)
    return consDateStr >= dateFromStr && consDateStr <= dateToStr
  })

  // Group transactions by warehouse
  const transactionsByWarehouse = new Map<string, Array<{
    type: 'entry' | 'consumption'
    date: string
    liters: number
    unitCost?: number
    productId?: string
    transactionId?: string // For consumptions, track the transaction ID
  }>>()

  entriesWithPrice.forEach(entry => {
    const whId = entry.warehouse_id
    if (!whId || !warehouseToPlantCode.has(whId)) return
    
    if (!transactionsByWarehouse.has(whId)) {
      transactionsByWarehouse.set(whId, [])
    }
    
    transactionsByWarehouse.get(whId)!.push({
      type: 'entry',
      date: entry.transaction_date,
      liters: Number(entry.quantity_liters || 0),
      unitCost: Number(entry.unit_cost || 0),
      productId: entry.product_id
    })
  })

  allConsumptionsFetched.forEach(consumption => {
    const whId = consumption.warehouse_id
    if (!whId || !warehouseToPlantCode.has(whId)) return
    
    if (!transactionsByWarehouse.has(whId)) {
      transactionsByWarehouse.set(whId, [])
    }
    
    transactionsByWarehouse.get(whId)!.push({
      type: 'consumption',
      date: consumption.transaction_date,
      liters: Number(consumption.quantity_liters || 0),
      productId: consumption.product_id,
      transactionId: consumption.id // Track transaction ID for cost mapping
    })
  })

  // Calculate weighted average per warehouse for fallback
  const warehouseWeightedAvg = new Map<string, number>()
  transactionsByWarehouse.forEach((transactions, warehouseId) => {
    const entries = transactions.filter(t => t.type === 'entry' && t.unitCost && t.unitCost > 0)
    if (entries.length > 0) {
      const totalLiters = entries.reduce((sum, e) => sum + e.liters, 0)
      const totalCost = entries.reduce((sum, e) => sum + (e.liters * (e.unitCost || 0)), 0)
      if (totalLiters > 0) {
        warehouseWeightedAvg.set(warehouseId, totalCost / totalLiters)
      }
    }
  })

  const consumptionCosts = new Map<string, number>() // warehouse_id -> total cost
  const transactionCosts = new Map<string, number>() // transaction_id -> cost
  
  transactionsByWarehouse.forEach((transactions, warehouseId) => {
    // Sort chronologically (entries before consumptions on same timestamp)
    transactions.sort((a, b) => {
      const timeDiff = new Date(a.date).getTime() - new Date(b.date).getTime()
      if (timeDiff !== 0) return timeDiff
      if (a.type === 'entry' && b.type === 'consumption') return -1
      if (a.type === 'consumption' && b.type === 'entry') return 1
      return 0
    })
    
    const inventoryLots: Array<{ liters: number, unitCost: number, date: string }> = []
    let totalConsumptionCost = 0
    
    transactions.forEach(tx => {
      if (tx.type === 'entry') {
        if (tx.liters > 0 && tx.unitCost && tx.unitCost > 0) {
          inventoryLots.push({
            liters: tx.liters,
            unitCost: tx.unitCost,
            date: tx.date
          })
          inventoryLots.sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime())
        }
      } else if (tx.type === 'consumption') {
        const txDateStr = getLocalDateStr(tx.date)
        const isInPeriod = txDateStr >= dateFromStr && txDateStr <= dateToStr
        
        let remainingLiters = tx.liters
        let consumptionCost = 0

        // Consume from oldest inventory lots first (FIFO)
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
          const cost = consumeFromLot * lot.unitCost
          consumptionCost += cost
          remainingLiters -= consumeFromLot
          lot.liters -= consumeFromLot

          if (lot.liters <= 0.01) {
            inventoryLots.splice(lotIndex, 1)
          } else {
            lotIndex++
          }
        }

        // Fallback pricing if FIFO lots exhausted
        if (remainingLiters > 0) {
          const weightedAvgPrice = warehouseWeightedAvg.get(warehouseId) || 0
          if (weightedAvgPrice > 0) {
            consumptionCost += remainingLiters * weightedAvgPrice
          } else {
            const fallbackPrice = tx.productId ? (priceByProduct.get(tx.productId) || 0) : 0
            if (fallbackPrice > 0) {
              consumptionCost += remainingLiters * fallbackPrice
            }
          }
        }

        // Only count costs for consumptions in the report period
        if (isInPeriod && tx.transactionId) {
          totalConsumptionCost += consumptionCost
          transactionCosts.set(tx.transactionId, consumptionCost)
        }
      }
    })

    consumptionCosts.set(warehouseId, totalConsumptionCost)
  })

  // Aggregate costs by plant code
  const plantCosts = new Map<string, number>()
  consumptionCosts.forEach((cost, warehouseId) => {
    const plantCode = warehouseToPlantCode.get(warehouseId)
    if (plantCode) {
      plantCosts.set(plantCode, (plantCosts.get(plantCode) || 0) + cost)
    }
  })

  return { plantCosts, transactionCosts }
}

