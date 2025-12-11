import { NextRequest, NextResponse } from 'next/server'
import { createClient as createServerSupabase } from '@/lib/supabase-server'
import { createClient } from '@supabase/supabase-js'

// Optional debug flag to trace Plant 4 warehouse transactions
const p004WarehouseDebug: string | undefined = process.env.P004_WAREHOUSE_DEBUG?.trim() || undefined

type Body = {
  month: string // YYYY-MM format
  businessUnitId?: string | null
  plantId?: string | null
}

/**
 * Calculate diesel costs using FIFO with weighted average fallback
 * Only entries from last 2 months typically have prices assigned
 */
async function calculateDieselCostsFIFO_IngresosGastos(
  supabase: any,
  dateFromStr: string,
  dateToStr: string,
  plantCodes: string[],
  priceByProduct: Map<string, number>
): Promise<Map<string, number>> {
  // Extend window to 3 months back to ensure we capture entries that might still be in inventory
  // This ensures FIFO can work properly even if entries occurred before the period
  const fifoStartDate = new Date(dateFromStr)
  fifoStartDate.setMonth(fifoStartDate.getMonth() - 3) // 3 months back for proper FIFO inventory tracking
  fifoStartDate.setHours(0, 0, 0, 0) // Start of day
  
  // Ensure end date includes full day (23:59:59.999)
  const dateToEnd = new Date(dateToStr)
  dateToEnd.setHours(23, 59, 59, 999) // End of day
  
  // Use full ISO strings for proper timestamptz comparison
  const fifoStartDateISO = fifoStartDate.toISOString()
  const dateToEndISO = dateToEnd.toISOString()
  
  // Get warehouse IDs for target plants (only diesel warehouses)
  const { data: warehouses, error: warehousesError } = await supabase
    .from('diesel_warehouses')
    .select('id, plant_id, plants(code)')
    .eq('product_type', 'diesel')
  
  if (warehousesError) {
    console.error('[FIFO] Error fetching warehouses:', warehousesError)
  }
  
  const warehouseToPlantCode = new Map<string, string>()
  const targetWarehouseIds: string[] = []
  ;(warehouses || []).forEach((wh: any) => {
    const code = (wh.plants as any)?.code
    if (code && plantCodes.includes(code)) {
      warehouseToPlantCode.set(wh.id, code)
      targetWarehouseIds.push(wh.id)
    }
  })

  // Early return if no warehouses found
  if (targetWarehouseIds.length === 0) {
    console.warn('[FIFO] No warehouses found for plant codes:', plantCodes)
    return new Map<string, number>()
  }

  // STEP 1: Fetch entries from last 45 days (when prices were added) to build FIFO inventory
  // FLEXIBLE APPROACH: We need entries from before AND during the period to build accurate inventory
  // However, only entries from last 45 days have prices, so we limit to that window
  const entriesStartDate = new Date(dateFromStr)
  entriesStartDate.setDate(entriesStartDate.getDate() - 45) // 45 days back (when prices were added)
  entriesStartDate.setHours(0, 0, 0, 0)
  const entriesStartDateISO = entriesStartDate.toISOString()
  
  // UPDATED: Include BOTH regular entries AND transfer-in entries
  // Transfer-in entries now have FIFO-calculated prices that should be used for costing
  // This ensures diesel transferred from Plant 4 to other plants carries its cost basis
  const { data: allEntries, error: entriesError } = await supabase
    .from('diesel_transactions')
    .select(`
      id, 
      warehouse_id, 
      product_id, 
      quantity_liters, 
      unit_cost, 
      transaction_date,
      is_transfer
    `)
    .eq('transaction_type', 'entry')
    // Include both regular entries (is_transfer = false) AND transfer-in entries (is_transfer = true)
    // Both contribute to FIFO inventory with their unit_cost
    .gte('transaction_date', entriesStartDateISO)
    .lte('transaction_date', dateToEndISO)
    .in('warehouse_id', targetWarehouseIds)
    .not('unit_cost', 'is', null)
    .gt('unit_cost', 0)
    .order('transaction_date', { ascending: true })

  if (entriesError) {
    console.error('[FIFO] Error fetching entries:', entriesError)
  }

  const entriesWithPrice = (allEntries || []).filter(tx => tx.unit_cost && Number(tx.unit_cost) > 0)
  
  // Debug: Log entries by plant
  const entriesByPlant = new Map<string, { count: number, liters: number, hasPrice: number }>()
  ;(allEntries || []).forEach(entry => {
    const plantCode = warehouseToPlantCode.get(entry.warehouse_id) || 'UNKNOWN'
    if (!entriesByPlant.has(plantCode)) {
      entriesByPlant.set(plantCode, { count: 0, liters: 0, hasPrice: 0 })
    }
    const stat = entriesByPlant.get(plantCode)!
    stat.count++
    stat.liters += Number(entry.quantity_liters || 0)
    if (entry.unit_cost && Number(entry.unit_cost) > 0) {
      stat.hasPrice++
    }
  })
  console.log('[FIFO] Entries by plant:', Object.fromEntries(entriesByPlant))

  // STEP 2: Fetch consumptions - FLEXIBLE for calculation, STRICT for cost counting
  // We fetch consumptions from the SAME date range as entries to ensure proper FIFO processing
  // All consumptions after entries start must be processed to maintain accurate inventory state
  // Use UTC explicitly to avoid timezone issues
  const reportStartDateISO = `${dateFromStr}T00:00:00.000Z` // Oct 1 00:00:00 UTC
  const reportEndDateISO = `${dateToStr}T23:59:59.999Z` // Oct 31 23:59:59 UTC
  
  // CRITICAL: Fetch consumptions from the SAME start date as entries (45 days back)
  // This ensures consumptions can properly consume from entries in chronological order
  // Example: Sep 8 entry must be consumed by Sep 8+ consumptions, not left unused
  const consumptionQueryStart = new Date(dateFromStr)
  consumptionQueryStart.setDate(consumptionQueryStart.getDate() - 45) // Same as entries: 45 days back
  consumptionQueryStart.setHours(0, 0, 0, 0)
  const consumptionQueryStartISO = consumptionQueryStart.toISOString()
  
  // First, let's see what's actually in the database WITHOUT any is_transfer filter
  // This helps debug whether transfers are properly marked
  const { data: allConsumptionsUnfiltered, error: consumptionsUnfilteredError } = await supabase
    .from('diesel_transactions')
    .select(`
      id, 
      warehouse_id, 
      product_id, 
      quantity_liters, 
      transaction_date,
      is_transfer
    `)
    .eq('transaction_type', 'consumption')
    .gte('transaction_date', consumptionQueryStartISO)
    .lte('transaction_date', reportEndDateISO)
    .in('warehouse_id', targetWarehouseIds)
    .order('transaction_date', { ascending: true })

  // Debug: Count transfers vs non-transfers in raw data
  const transferCounts = new Map<string, { total: number, isTransferTrue: number, isTransferFalse: number, isTransferNull: number, litersTransfer: number, litersNonTransfer: number }>()
  ;(allConsumptionsUnfiltered || []).forEach(cons => {
    const plantCode = warehouseToPlantCode.get(cons.warehouse_id) || 'UNKNOWN'
    if (!transferCounts.has(plantCode)) {
      transferCounts.set(plantCode, { total: 0, isTransferTrue: 0, isTransferFalse: 0, isTransferNull: 0, litersTransfer: 0, litersNonTransfer: 0 })
    }
    const stat = transferCounts.get(plantCode)!
    stat.total++
    const liters = Number(cons.quantity_liters || 0)
    if (cons.is_transfer === true) {
      stat.isTransferTrue++
      stat.litersTransfer += liters
    } else if (cons.is_transfer === false) {
      stat.isTransferFalse++
      stat.litersNonTransfer += liters
    } else {
      stat.isTransferNull++
      stat.litersNonTransfer += liters // Treat null as non-transfer
    }
  })
  console.log('[FIFO DEBUG] Raw consumption data (unfiltered) - transfer breakdown:', Object.fromEntries(transferCounts))

  // Now filter to exclude transfers
  // CRITICAL: Check for both boolean true and string "true" (PostgreSQL can return booleans as strings)
  const allConsumptions = (allConsumptionsUnfiltered || []).filter(cons => {
    const isTransfer = cons.is_transfer === true || cons.is_transfer === 'true' || cons.is_transfer === 1
    return !isTransfer
  })
  const consumptionsError = consumptionsUnfilteredError

  if (consumptionsError) {
    console.error('[FIFO] Error fetching consumptions:', consumptionsError)
  }

  const allConsumptionsFetched = allConsumptions || []
  const isTransferFlag = (value: unknown): boolean => {
    if (value === true || value === 1) return true
    if (typeof value === 'string') {
      const normalized = value.trim().toLowerCase()
      return normalized === 'true' || normalized === 't' || normalized === '1'
    }
    return false
  }
  
  // Helper function to convert UTC timestamp to GMT-6 (local timezone) and extract date
  const getLocalDateStr = (utcTimestamp: string): string => {
    // transaction_date is in UTC, convert to GMT-6 (UTC-6)
    const utcDate = new Date(utcTimestamp)
    // GMT-6 means subtract 6 hours from UTC
    // Example: 2025-10-02 23:31:00+00 UTC → 2025-10-02 17:31:00 GMT-6
    const localTimeMs = utcDate.getTime() - (6 * 60 * 60 * 1000)
    const localDate = new Date(localTimeMs)
    // Extract YYYY-MM-DD from the adjusted time using UTC methods
    // (since we've already adjusted the time, UTC methods give us the GMT-6 date)
    const year = localDate.getUTCFullYear()
    const month = String(localDate.getUTCMonth() + 1).padStart(2, '0')
    const day = String(localDate.getUTCDate()).padStart(2, '0')
    return `${year}-${month}-${day}`
  }
  
  // STRICTLY filter consumptions to only those in the report period for counting
  // CRITICAL: Use transaction_date (NOT created_at) - transaction_date is when the consumption occurred
  // IMPORTANT: Convert UTC to GMT-6 before comparing dates
  const consumptionsInPeriod = allConsumptionsFetched.filter(cons => {
    if (isTransferFlag(cons.is_transfer)) {
      console.warn('[FIFO] Unexpected transfer row reached consumptionsInPeriod:', cons.id)
      return false
    }
    // Ensure we're using transaction_date, not created_at
    if (!cons.transaction_date) {
      console.warn('[FIFO] Warning: Consumption missing transaction_date:', cons.id)
      return false
    }
    const consDateStr = getLocalDateStr(cons.transaction_date) // Convert UTC to GMT-6 and extract date
    return consDateStr >= dateFromStr && consDateStr <= dateToStr
  })
  
  // Debug: Log consumptions by plant (in period)
  const consumptionsByPlant = new Map<string, { count: number, liters: number, transfers: number }>()
  allConsumptionsFetched.forEach(cons => {
    const isTransfer = isTransferFlag(cons.is_transfer)
    const plantCode = warehouseToPlantCode.get(cons.warehouse_id) || 'UNKNOWN'
    if (!consumptionsByPlant.has(plantCode)) {
      consumptionsByPlant.set(plantCode, { count: 0, liters: 0, transfers: 0 })
    }
    const stat = consumptionsByPlant.get(plantCode)!
    if (isTransfer) {
      stat.transfers++
      return
    }
    stat.count++
    stat.liters += Number(cons.quantity_liters || 0)
  })
  console.log('[FIFO] Consumptions by plant (total fetched):', Object.fromEntries(consumptionsByPlant))
  
  // Debug: Log in-period consumptions (also check for transfers that might be in period)
  const consumptionsInPeriodByPlant = new Map<string, { count: number, liters: number }>()
  
  // Also check what's in period from the UNFILTERED data to see if transfers are in period
  const inPeriodUnfiltered = (allConsumptionsUnfiltered || []).filter(cons => {
    if (!cons.transaction_date) return false
    const consDateStr = getLocalDateStr(cons.transaction_date)
    return consDateStr >= dateFromStr && consDateStr <= dateToStr
  })
  
  const inPeriodTransferCheck = new Map<string, { total: number, transfers: number, transferLiters: number, nonTransferLiters: number }>()
  inPeriodUnfiltered.forEach(cons => {
    const plantCode = warehouseToPlantCode.get(cons.warehouse_id) || 'UNKNOWN'
    if (!inPeriodTransferCheck.has(plantCode)) {
      inPeriodTransferCheck.set(plantCode, { total: 0, transfers: 0, transferLiters: 0, nonTransferLiters: 0 })
    }
    const stat = inPeriodTransferCheck.get(plantCode)!
    stat.total++
    const liters = Number(cons.quantity_liters || 0)
    if (isTransferFlag(cons.is_transfer)) {
      stat.transfers++
      stat.transferLiters += liters
    } else {
      stat.nonTransferLiters += liters
    }
  })
  console.log('[FIFO DEBUG] IN-PERIOD transfer check (from unfiltered):', Object.fromEntries(inPeriodTransferCheck))
  
  // CRITICAL DEBUG: Check if consumptionsInPeriod still contains transfers
  const transfersInFilteredPeriod = consumptionsInPeriod.filter(c => isTransferFlag(c.is_transfer))
  if (transfersInFilteredPeriod.length > 0) {
    console.error('[FIFO ERROR] consumptionsInPeriod STILL CONTAINS TRANSFERS!', transfersInFilteredPeriod.map(c => ({
      id: c.id,
      date: c.transaction_date,
      liters: c.quantity_liters,
      is_transfer: c.is_transfer,
      is_transfer_type: typeof c.is_transfer
    })))
  }
  
  consumptionsInPeriod.forEach(cons => {
    if (isTransferFlag(cons.is_transfer)) return
    const plantCode = warehouseToPlantCode.get(cons.warehouse_id) || 'UNKNOWN'
    if (!consumptionsInPeriodByPlant.has(plantCode)) {
      consumptionsInPeriodByPlant.set(plantCode, { count: 0, liters: 0 })
    }
    const stat = consumptionsInPeriodByPlant.get(plantCode)!
    stat.count++
    stat.liters += Number(cons.quantity_liters || 0)
  })
  console.log('[FIFO] Consumptions by plant (in period - filtered):', Object.fromEntries(consumptionsInPeriodByPlant))


  // STEP 3: Process entries and consumptions chronologically together for proper FIFO
  // This ensures entries during the period add to inventory, and consumptions use oldest inventory first
  const consumptionCosts = new Map<string, number>() // warehouse_id -> total cost
  const plantDieselCosts = new Map<string, number>() // plant_code -> total cost

  // Group transactions by warehouse, then process chronologically
  const transactionsByWarehouse = new Map<string, Array<{
    type: 'entry' | 'consumption'
    date: string
    liters: number
    unitCost?: number
    productId?: string
  }>>()

  // Add entries - log details for debugging
  const entriesByWarehouse = new Map<string, number>()
  entriesWithPrice.forEach(entry => {
    const whId = entry.warehouse_id
    if (!whId || !warehouseToPlantCode.has(whId)) return
    
    if (!transactionsByWarehouse.has(whId)) {
      transactionsByWarehouse.set(whId, [])
    }
    
    entriesByWarehouse.set(whId, (entriesByWarehouse.get(whId) || 0) + 1)
    
    transactionsByWarehouse.get(whId)!.push({
      type: 'entry',
      date: entry.transaction_date,
      liters: Number(entry.quantity_liters || 0),
      unitCost: Number(entry.unit_cost || 0),
      productId: entry.product_id
    })
  })
  

  // Add consumptions - use ALL fetched consumptions for processing (to maintain inventory state)
  // But we'll STRICTLY filter costs to only October consumptions later
  // CRITICAL: Double-check to exclude transfers (defense in depth)
  let skippedTransfersCount = 0
  let skippedTransfersLiters = 0
  let p004AddedToTransactions = 0
  let p004AddedLiters = 0
  allConsumptionsFetched.forEach(consumption => {
    // Defense in depth: skip transfers even if they passed the query filter
    // Check for both boolean true and string "true" (PostgreSQL can return booleans as strings)
    const isTransfer = consumption.is_transfer === true || consumption.is_transfer === 'true' || consumption.is_transfer === 1
    if (isTransfer) {
      skippedTransfersCount++
      skippedTransfersLiters += Number(consumption.quantity_liters || 0)
      console.warn(`[Ingresos-Gastos FIFO] Skipping transfer consumption: ${consumption.id} (is_transfer=${consumption.is_transfer}, liters=${consumption.quantity_liters})`)
      return
    }
    
    const whId = consumption.warehouse_id
    if (!whId || !warehouseToPlantCode.has(whId)) return
    
    // Debug P004
    if (p004WarehouseDebug && whId === p004WarehouseDebug) {
      p004AddedToTransactions++
      p004AddedLiters += Number(consumption.quantity_liters || 0)
    }
    
    if (!transactionsByWarehouse.has(whId)) {
      transactionsByWarehouse.set(whId, [])
    }
    
    transactionsByWarehouse.get(whId)!.push({
      type: 'consumption',
      date: consumption.transaction_date,
      liters: Number(consumption.quantity_liters || 0),
      productId: consumption.product_id
    })
  })
  
  // Debug P004 transactions added
  if (p004WarehouseDebug) {
    const p004Transactions = transactionsByWarehouse.get(p004WarehouseDebug) || []
    const p004Consumptions = p004Transactions.filter(t => t.type === 'consumption')
    console.log(`[CRITICAL DEBUG] P004 transactions added to FIFO:`, {
      totalTransactions: p004Transactions.length,
      consumptions: p004Consumptions.length,
      consumptionLiters: p004Consumptions.reduce((sum, t) => sum + t.liters, 0),
      addedCount: p004AddedToTransactions,
      addedLiters: p004AddedLiters
    })
  }

  // Calculate weighted average price per warehouse for fallback (from all entries)
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

  transactionsByWarehouse.forEach((transactions, warehouseId) => {
    const plantCode = warehouseToPlantCode.get(warehouseId) || 'UNKNOWN'
    
    // Sort all transactions chronologically
    // CRITICAL: For identical timestamps, entries MUST come before consumptions
    // so that inventory is available when consumptions are processed
    transactions.sort((a, b) => {
      const timeDiff = new Date(a.date).getTime() - new Date(b.date).getTime()
      if (timeDiff !== 0) return timeDiff
      // Same timestamp: entries first (type 'entry' < 'consumption' alphabetically)
      if (a.type === 'entry' && b.type === 'consumption') return -1
      if (a.type === 'consumption' && b.type === 'entry') return 1
      return 0
    })
    
    // FIFO inventory: array of lots (oldest first)
    const inventoryLots: Array<{ liters: number, unitCost: number, date: string }> = []
    let totalConsumptionCost = 0

    // Process each transaction in chronological order
    transactions.forEach((tx) => {
      if (tx.type === 'entry') {
        // Add entry to inventory (add to end, but we'll maintain chronological order)
        if (tx.liters > 0 && tx.unitCost && tx.unitCost > 0) {
          inventoryLots.push({
            liters: tx.liters,
            unitCost: tx.unitCost,
            date: tx.date
          })
          // Keep inventory sorted by date (oldest first for FIFO)
          inventoryLots.sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime())
        }
      } else if (tx.type === 'consumption') {
        // FLEXIBLE: Process ALL consumptions chronologically to maintain accurate inventory state
        // STRICT: Only count costs for consumptions within the report period
        // Convert UTC to GMT-6 for date comparison
        const txDateStr = getLocalDateStr(tx.date)
        const isInPeriod = txDateStr >= dateFromStr && txDateStr <= dateToStr
        
        let remainingLiters = tx.liters
        let consumptionCost = 0

        // FLEXIBLE: Process consumption to maintain inventory state (even if outside period)
        // Consume from oldest inventory lots first (FIFO)
        // Only use lots that existed before this consumption
        let lotIndex = 0
        while (remainingLiters > 0 && lotIndex < inventoryLots.length) {
          const lot = inventoryLots[lotIndex]
          
          // Only use lots that existed before this consumption
          if (lot.date > tx.date) {
            lotIndex++
            continue
          }
          
          // Skip fully consumed lots
          if (lot.liters <= 0.01) {
            lotIndex++
            continue
          }
          
          const consumeFromLot = Math.min(remainingLiters, lot.liters)
          const cost = consumeFromLot * lot.unitCost
          consumptionCost += cost
          remainingLiters -= consumeFromLot
          lot.liters -= consumeFromLot

          // If lot is fully consumed, remove it
          if (lot.liters <= 0.01) {
            inventoryLots.splice(lotIndex, 1)
            // Don't increment lotIndex since we removed the current element
          } else {
            // Lot partially consumed, move to next lot
            lotIndex++
          }
        }

        // Fallback: If remaining liters and no priced lots available
        // This should ONLY happen if FIFO lots are exhausted and we still have liters to price
        if (remainingLiters > 0) {
          const weightedAvgPrice = warehouseWeightedAvg.get(warehouseId) || 0
          if (weightedAvgPrice > 0) {
            const fallbackCost = remainingLiters * weightedAvgPrice
            consumptionCost += fallbackCost
          } else {
            // Second fallback: product default price
            const fallbackPrice = tx.productId ? (priceByProduct.get(tx.productId) || 0) : 0
            if (fallbackPrice > 0) {
              const fallbackCost = remainingLiters * fallbackPrice
              consumptionCost += fallbackCost
            } else {
              // Third fallback: Use global average from ALL priceByProduct entries
              let globalAvgPrice = 0
              if (priceByProduct.size > 0) {
                const prices = Array.from(priceByProduct.values()).filter(p => p > 0)
                if (prices.length > 0) {
                  globalAvgPrice = prices.reduce((a, b) => a + b, 0) / prices.length
                }
              }
              
              if (globalAvgPrice > 0) {
                const fallbackCost = remainingLiters * globalAvgPrice
                consumptionCost += fallbackCost
                console.warn(`[FIFO] ${plantCode}: ${remainingLiters.toFixed(2)}L priced with global avg $${globalAvgPrice.toFixed(2)}/L`)
              } else if (remainingLiters > 0.01) {
                // No price available at all - log error for troubleshooting
                console.error(`[FIFO] ${plantCode}: ${remainingLiters.toFixed(2)}L could not be priced - no FIFO lots, no weighted avg, no product price`)
              }
            }
          }
        }

        // STRICT: Only count costs for consumptions within the report period
        // This ensures accurate monthly reporting while maintaining proper FIFO inventory state
        if (isInPeriod) {
          totalConsumptionCost += consumptionCost
        }
      }
    })

    consumptionCosts.set(warehouseId, totalConsumptionCost)
    
    // Debug P004 costs
    if (plantCode === 'P004') {
      console.log(`[FIFO DEBUG P004] Total consumption cost calculated: $${totalConsumptionCost.toFixed(2)}`)
    }
  })
  
  // Debug: Log skipped transfers summary
  if (skippedTransfersCount > 0) {
    console.log(`[FIFO] Skipped ${skippedTransfersCount} transfer consumptions totaling ${skippedTransfersLiters.toFixed(2)}L from FIFO processing`)
  }

  // Aggregate costs by plant code
  consumptionCosts.forEach((cost, warehouseId) => {
    const plantCode = warehouseToPlantCode.get(warehouseId)
    if (!plantCode) {
      console.warn(`[FIFO] Warehouse ${warehouseId} has no plant code mapping`)
      return
    }
    
    if (!plantDieselCosts.has(plantCode)) {
      plantDieselCosts.set(plantCode, 0)
    }
    plantDieselCosts.set(plantCode, plantDieselCosts.get(plantCode)! + cost)
  })

  return plantDieselCosts
}

export async function POST(req: NextRequest) {
  try {
    const { month, businessUnitId, plantId } = (await req.json()) as Body

    // Helper to build YYYY-MM date ranges (inclusive) for a month string
    const getMonthRange = (monthStr: string) => {
      const [yr, mNum] = monthStr.split('-').map(Number)
      const from = new Date(yr, mNum - 1, 1)
      const to = new Date(yr, mNum, 0)
      return {
        year: yr,
        monthNum: mNum,
        dateFromStr: from.toISOString().slice(0, 10),
        dateToStr: to.toISOString().slice(0, 10),
        periodMonth: `${yr}-${String(mNum).padStart(2, '0')}-01`
      }
    }

    // Current and previous month ranges
    const currentRange = getMonthRange(month)
    const prevDate = new Date(currentRange.dateFromStr)
    prevDate.setMonth(prevDate.getMonth() - 1)
    const prevMonthStr = `${prevDate.getFullYear()}-${String(prevDate.getMonth() + 1).padStart(2, '0')}`
    const previousRange = getMonthRange(prevMonthStr)

    const supabase = await createServerSupabase()

    // Fetch business units and plants for filters
    const { data: businessUnits } = await supabase
      .from('business_units')
      .select('id, name, code')
      .order('name')

    let plantsQuery = supabase
      .from('plants')
      .select('id, name, code, business_unit_id')
      .order('name')
    
    if (businessUnitId) plantsQuery = plantsQuery.eq('business_unit_id', businessUnitId)
    const { data: plants } = await plantsQuery

    // Filter plants if specific plant requested
    const targetPlants = plantId 
      ? (plants || []).filter(p => p.id === plantId)
      : businessUnitId
        ? (plants || []).filter(p => p.business_unit_id === businessUnitId)
        : plants || []

    if (targetPlants.length === 0) {
      return NextResponse.json({
        error: 'No plants found for the selected filters',
        plants: []
      })
    }

    // Shared cotizador client across periods
    const cotizadorSupabase = createClient(
      process.env.COTIZADOR_SUPABASE_URL!,
      process.env.COTIZADOR_SUPABASE_SERVICE_ROLE_KEY!,
      { auth: { persistSession: false } }
    )

    // Internal helper to build a month snapshot (reuses shared clients and filters)
    const buildMonthSnapshot = async (range: ReturnType<typeof getMonthRange>) => {
      const { dateFromStr, dateToStr, periodMonth } = range

      // Fetch vw_plant_financial_analysis_unified for the month from COTIZADOR project
      let viewData: any[] | null = null
      try {
        const { data: viewRows, error: viewError } = await cotizadorSupabase
          .from('vw_plant_financial_analysis_unified')
          .select('*')
          .eq('period_start', periodMonth)

        if (viewError) {
          console.error('View fetch error (cotizador):', viewError)
        }
        viewData = viewRows || []
      } catch (err) {
        console.error('Error querying vw_plant_financial_analysis_unified from cotizador:', err)
        viewData = []
      }

      // Build view data map by plant code (the view uses plant codes)
      const viewDataByPlantCode = new Map<string, any>()
      ;(viewData || []).forEach(row => {
        if (row.plant_code) {
          viewDataByPlantCode.set(row.plant_code, row)
        }
      })

      // Fetch bombeo data from vw_pumping_analysis_unified for the month
      // Note: This view is now a materialized view (mv_pumping_analysis_unified) for performance.
      // It refreshes automatically every hour at :30 past the hour, so data may be up to 1 hour old.
      // For real-time data, call refresh_analytics_materialized_views() RPC or use the
      // /refresh-materialized-views endpoint. The view name remains the same (aliased).
      const plantCodes = targetPlants.map(p => p.code).filter(Boolean)
      let pumpingData: any[] | null = null
      
      if (plantCodes.length > 0) {
        try {
          const { data: pumpingRows, error: pumpingError } = await cotizadorSupabase
            .from('vw_pumping_analysis_unified')
            .select('plant_code, volumen_bombeo_m3, subtotal_total')
            .gte('period_start', dateFromStr)
            .lte('period_start', dateToStr)
            .in('plant_code', plantCodes)

          if (pumpingError) {
            console.error('Pumping view fetch error (cotizador):', pumpingError)
          }
          pumpingData = pumpingRows || []
        } catch (err) {
          console.error('Error querying vw_pumping_analysis_unified from cotizador:', err)
          pumpingData = []
        }
      } else {
        pumpingData = []
      }

      const pumpingDataByPlantCode = new Map<string, { volumen_bombeo_m3: number, subtotal_total: number }>()
      ;(pumpingData || []).forEach(row => {
        if (row.plant_code && plantCodes.includes(row.plant_code)) {
          const existing = pumpingDataByPlantCode.get(row.plant_code) || { volumen_bombeo_m3: 0, subtotal_total: 0 }
          pumpingDataByPlantCode.set(row.plant_code, {
            volumen_bombeo_m3: existing.volumen_bombeo_m3 + Number(row.volumen_bombeo_m3 || 0),
            subtotal_total: existing.subtotal_total + Number(row.subtotal_total || 0)
          })
        }
      })

      // Fetch diesel and maintenance costs using existing gerencial logic
      const host = req.headers.get('host') || ''
      const envBaseUrl = process.env.NEXT_PUBLIC_BASE_URL
      let base: string
      if (host.includes('localhost') || host.includes('127.0.0.1')) {
        const port = host.split(':')[1] || '3000'
        base = `http://127.0.0.1:${port}`
      } else {
        base = `https://${host}`
      }
      
      if (envBaseUrl && envBaseUrl !== base) {
        console.warn('[Ingresos Gastos Report] Base URL mismatch detected:', {
          envBaseUrl,
          actualBaseUrl: base,
          host,
          note: 'Using actual host for internal API calls'
        })
      }
      
      const gerencialApiUrl = `${base}/api/reports/gerencial`
      const gerencialRequestPayload = {
        dateFrom: dateFromStr,
        dateTo: dateToStr,
        businessUnitId,
        plantId,
        hideZeroActivity: false
      }
      
      let gerencialData: any = null
      try {
        const gerencialResp = await fetch(gerencialApiUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(gerencialRequestPayload)
        })
        
        if (!gerencialResp.ok) {
          const errorText = await gerencialResp.text()
          let errorJson: any = null
          try {
            errorJson = JSON.parse(errorText)
          } catch {
            // Not JSON, use text as-is
          }
          
          console.error('[Ingresos Gastos Report] Gerencial API fetch failed:', {
            status: gerencialResp.status,
            statusText: gerencialResp.statusText,
            url: gerencialApiUrl,
            errorBody: errorJson || errorText
          })
          
          gerencialData = null
        } else {
          try {
            gerencialData = await gerencialResp.json()
          } catch (parseError: any) {
            console.error('[Ingresos Gastos Report] Failed to parse gerencial API response:', {
              error: parseError?.message,
              status: gerencialResp.status,
              url: gerencialApiUrl
            })
            gerencialData = null
          }
        }
      } catch (fetchError: any) {
        console.error('[Ingresos Gastos Report] Gerencial API fetch exception:', {
          error: fetchError?.message,
          stack: fetchError?.stack,
          url: gerencialApiUrl,
          baseUrl: base,
          host: host
        })
        gerencialData = null
      }

      // Calculate diesel costs using FIFO (primary method)
      const { data: products } = await supabase
        .from('diesel_products')
        .select('id, price_per_liter')
      const priceByProduct = new Map<string, number>()
      ;(products || []).forEach(p => priceByProduct.set(p.id, Number(p.price_per_liter || 0)))

      const plantCodesForRange = targetPlants.map(p => p.code).filter(Boolean)
      const fifoDieselCosts = await calculateDieselCostsFIFO_IngresosGastos(
        supabase,
        dateFromStr,
        dateToStr,
        plantCodesForRange,
        priceByProduct
      )

      const gerencialPlantMapByCode = new Map<string, any>()
      ;(gerencialData?.plants || []).forEach((plant: any) => {
        const matchingPlant = (plants || []).find(p => p.id === plant.id)
        if (matchingPlant?.code) {
          gerencialPlantMapByCode.set(matchingPlant.code, {
            maintenance_cost: plant.maintenance_cost || 0
          })
        }
      })

      const maintenanceByCode = new Map<string, number>()
      ;(gerencialData?.assets || []).forEach((asset: any) => {
        const pcode = asset.plant_code
        if (!pcode) return
        
        const mantto = Number(asset.maintenance_cost || 0)
        if (!maintenanceByCode.has(pcode)) {
          maintenanceByCode.set(pcode, 0)
        }
        maintenanceByCode.set(pcode, maintenanceByCode.get(pcode)! + mantto)
      })

      const dieselManttoByCode = new Map<string, { diesel_cost: number, maintenance_cost: number }>()
      
      fifoDieselCosts.forEach((dieselCost, plantCode) => {
        if (!dieselManttoByCode.has(plantCode)) {
          dieselManttoByCode.set(plantCode, { diesel_cost: 0, maintenance_cost: 0 })
        }
        dieselManttoByCode.get(plantCode)!.diesel_cost = dieselCost
      })
      
      viewDataByPlantCode.forEach((_viewRow, plantCode) => {
        if (!dieselManttoByCode.has(plantCode)) {
          dieselManttoByCode.set(plantCode, { diesel_cost: 0, maintenance_cost: 0 })
        }
      })

      gerencialPlantMapByCode.forEach((plant, plantCode) => {
        if (!dieselManttoByCode.has(plantCode)) {
          dieselManttoByCode.set(plantCode, { diesel_cost: 0, maintenance_cost: 0 })
        }
        dieselManttoByCode.get(plantCode)!.maintenance_cost = plant.maintenance_cost || 0
      })

      maintenanceByCode.forEach((manttoCost, plantCode) => {
        if (!dieselManttoByCode.has(plantCode)) {
          dieselManttoByCode.set(plantCode, { diesel_cost: 0, maintenance_cost: 0 })
        }
        if (dieselManttoByCode.get(plantCode)!.maintenance_cost === 0) {
          dieselManttoByCode.get(plantCode)!.maintenance_cost = manttoCost
        }
      })

      const missingMaintenancePlants = plantCodesForRange.filter(code => 
        !dieselManttoByCode.has(code) || dieselManttoByCode.get(code)!.maintenance_cost === 0
      )
      
      if (missingMaintenancePlants.length > 0 && gerencialData == null) {
        const { data: assetsDirect } = await supabase
          .from('assets')
          .select('id, plant_id, plants(code)')

        const { data: purchaseOrders } = await supabase
          .from('purchase_orders')
          .select('id, total_amount, actual_amount, created_at, posting_date, purchase_date, work_order_id, status')
          .neq('status', 'pending_approval')
        const workOrderIds = (purchaseOrders || []).map(po => po.work_order_id).filter(Boolean)
        const { data: workOrders } = workOrderIds.length > 0 ? await supabase
          .from('work_orders')
          .select('id, asset_id, completed_at, planned_date, created_at, assets(plant_id, plants(code))')
          .in('id', workOrderIds) : { data: [] as any[] }
        const woById = new Map<string, any>((workOrders || []).map(w => [w.id, w]))

        const plantManttoFallback = new Map<string, number>()
        
        const extractDateOnly = (dateStr: string): string => {
          if (!dateStr) return ''
          if (dateStr.includes('T')) {
            return dateStr.split('T')[0]
          }
          return dateStr.slice(0, 10)
        }
        
        ;(purchaseOrders || []).forEach(po => {
          let dateToCheckStr: string
          
          if (po.purchase_date) {
            dateToCheckStr = po.purchase_date
          } else if (po.work_order_id) {
            const wo = woById.get(po.work_order_id)
            if (wo?.completed_at) {
              dateToCheckStr = wo.completed_at
            } else if (wo?.planned_date) {
              dateToCheckStr = wo.planned_date
            } else if (wo?.created_at) {
              dateToCheckStr = wo.created_at
            } else {
              dateToCheckStr = po.created_at
            }
          } else {
            dateToCheckStr = po.created_at
          }
          
          const checkDateOnly = extractDateOnly(dateToCheckStr)
          if (checkDateOnly < dateFromStr || checkDateOnly > dateToStr) return
          const finalAmount = po.actual_amount ? parseFloat(po.actual_amount) : parseFloat(po.total_amount || '0')
          const wo = po.work_order_id ? woById.get(po.work_order_id) : null
          const plantCode = (wo as any)?.assets?.plants?.code
          if (!plantCode || !missingMaintenancePlants.includes(plantCode)) return
          
          if (!plantManttoFallback.has(plantCode)) {
            plantManttoFallback.set(plantCode, 0)
          }
          plantManttoFallback.set(plantCode, plantManttoFallback.get(plantCode)! + finalAmount)
        })

        plantManttoFallback.forEach((manttoCost, plantCode) => {
          if (!dieselManttoByCode.has(plantCode)) {
            dieselManttoByCode.set(plantCode, { diesel_cost: 0, maintenance_cost: 0 })
          }
          if (dieselManttoByCode.get(plantCode)!.maintenance_cost === 0) {
            dieselManttoByCode.get(plantCode)!.maintenance_cost = manttoCost
          }
        })
      }

      const { data: manualAdjustments } = await supabase
        .from('manual_financial_adjustments')
        .select(`
          *,
          distributions:manual_financial_adjustment_distributions(
            id,
            plant_id,
            business_unit_id,
            department,
            amount
          )
        `)
        .eq('period_month', periodMonth)

      const manualByPlantCode = new Map<string, { nomina: number, otros_indirectos: number }>()
      const targetPlantIds = targetPlants.map(p => p.id)
      const targetPlantCodes = targetPlants.map(p => p.code).filter(Boolean) as string[]
      
      const plantCodeToBU = new Map<string, string>()
      ;(plants || []).forEach(p => {
        if (p.code && p.business_unit_id) {
          plantCodeToBU.set(p.code, p.business_unit_id)
        }
      })

      const { data: profilesData } = await supabase
        .from('profiles')
        .select('departamento, plant_id')
        .not('departamento', 'is', null)
        .not('plant_id', 'is', null)
      
      const departmentToPlants = new Map<string, string[]>()
      ;(profilesData || []).forEach(profile => {
        if (profile.departamento && profile.plant_id) {
          if (!departmentToPlants.has(profile.departamento)) {
            departmentToPlants.set(profile.departamento, [])
          }
          if (!departmentToPlants.get(profile.departamento)!.includes(profile.plant_id)) {
            departmentToPlants.get(profile.departamento)!.push(profile.plant_id)
          }
        }
      })

      ;(manualAdjustments || []).forEach(adj => {
        const category = adj.category
        const amount = Number(adj.amount || 0)

        if (adj.plant_id && targetPlantIds.includes(adj.plant_id)) {
          const matchingPlant = (plants || []).find(p => p.id === adj.plant_id)
          if (matchingPlant?.code) {
            if (!manualByPlantCode.has(matchingPlant.code)) {
              manualByPlantCode.set(matchingPlant.code, { nomina: 0, otros_indirectos: 0 })
            }
            const entry = manualByPlantCode.get(matchingPlant.code)!
            if (category === 'nomina') {
              entry.nomina += amount
            } else if (category === 'otros_indirectos') {
              entry.otros_indirectos += amount
            }
          }
        }

        if (adj.is_distributed && adj.distributions && Array.isArray(adj.distributions)) {
          adj.distributions.forEach((dist: any) => {
            const distAmount = Number(dist.amount || 0)
            
            if (dist.plant_id && targetPlantIds.includes(dist.plant_id)) {
              const matchingPlant = (plants || []).find(p => p.id === dist.plant_id)
              if (matchingPlant?.code) {
                if (!manualByPlantCode.has(matchingPlant.code)) {
                  manualByPlantCode.set(matchingPlant.code, { nomina: 0, otros_indirectos: 0 })
                }
                const entry = manualByPlantCode.get(matchingPlant.code)!
                if (category === 'nomina') {
                  entry.nomina += distAmount
                } else if (category === 'otros_indirectos') {
                  entry.otros_indirectos += distAmount
                }
              }
            }
            
            if (dist.business_unit_id) {
              const buPlants = (plants || []).filter(p => 
                p.business_unit_id === dist.business_unit_id && targetPlantIds.includes(p.id)
              )
              if (buPlants.length > 0) {
                const amountPerPlant = distAmount / buPlants.length
                buPlants.forEach(plant => {
                  if (plant.code) {
                    if (!manualByPlantCode.has(plant.code)) {
                      manualByPlantCode.set(plant.code, { nomina: 0, otros_indirectos: 0 })
                    }
                    const entry = manualByPlantCode.get(plant.code)!
                    if (category === 'nomina') {
                      entry.nomina += amountPerPlant
                    } else if (category === 'otros_indirectos') {
                      entry.otros_indirectos += amountPerPlant
                    }
                  }
                })
              }
            }
            
            if (dist.department) {
              const departmentPlants = departmentToPlants.get(dist.department) || []
              const targetDepartmentPlants = departmentPlants.filter(pid => targetPlantIds.includes(pid))
              if (targetDepartmentPlants.length > 0) {
                const amountPerPlant = distAmount / targetDepartmentPlants.length
                targetDepartmentPlants.forEach(plantId => {
                  const matchingPlant = (plants || []).find(p => p.id === plantId)
                  if (matchingPlant?.code) {
                    if (!manualByPlantCode.has(matchingPlant.code)) {
                      manualByPlantCode.set(matchingPlant.code, { nomina: 0, otros_indirectos: 0 })
                    }
                    const entry = manualByPlantCode.get(matchingPlant.code)!
                    if (category === 'nomina') {
                      entry.nomina += amountPerPlant
                    } else if (category === 'otros_indirectos') {
                      entry.otros_indirectos += amountPerPlant
                    }
                  }
                })
              }
            }
          })
        }
      })

      const plantData = targetPlants.map(plant => {
        const viewRow = viewDataByPlantCode.get(plant.code)
        let gerencialPlant = gerencialPlantMapByCode.get(plant.code)
        if (!gerencialPlant && dieselManttoByCode.has(plant.code)) {
          const agg = dieselManttoByCode.get(plant.code)!
          gerencialPlant = { diesel_cost: agg.diesel_cost, maintenance_cost: agg.maintenance_cost }
        }
        
        const manual = manualByPlantCode.get(plant.code) || { nomina: 0, otros_indirectos: 0 }

        const volumen_concreto = Number(viewRow?.volumen_concreto_m3 || 0)
        const fc_ponderada = Number(viewRow?.fc_ponderada_kg_cm2 || 0)
        const edad_ponderada = Number(viewRow?.edad_ponderada_dias || 0)
        const pv_unitario = Number(viewRow?.pv_unitario || 0)
        const ventas_total = Number(viewRow?.ventas_total_concreto || 0)

        const costo_mp_unitario = Number(viewRow?.costo_mp_unitario || 0)
        const consumo_cem_m3 = Number(viewRow?.consumo_cem_per_m3_kg || 0)
        const costo_cem_m3 = Number(viewRow?.costo_cem_per_m3 || 0)
        const costo_cem_pct = costo_mp_unitario > 0 ? (costo_cem_m3 / costo_mp_unitario) * 100 : 0
        const costo_mp_total = viewRow?.costo_mp_total_concreto != null
          ? Number(viewRow.costo_mp_total_concreto)
          : (costo_mp_unitario * volumen_concreto)
        const costo_mp_pct = viewRow?.costo_mp_percent != null
          ? Number(viewRow.costo_mp_percent)
          : (ventas_total > 0 ? (costo_mp_total / ventas_total) * 100 : 0)

        const spread_unitario = viewRow?.spread_unitario != null
          ? Number(viewRow.spread_unitario)
          : (pv_unitario - costo_mp_unitario)
        const spread_unitario_pct = viewRow?.spread_unitario_percent != null
          ? Number(viewRow.spread_unitario_percent)
          : (pv_unitario > 0 ? (spread_unitario / pv_unitario) * 100 : 0)

        const diesel_total = Number(dieselManttoByCode.get(plant.code)?.diesel_cost || 0)
        const diesel_unitario = volumen_concreto > 0 ? diesel_total / volumen_concreto : 0
        const diesel_pct = ventas_total > 0 ? (diesel_total / ventas_total) * 100 : 0

        const mantto_total = Number(gerencialPlant?.maintenance_cost || 0)
        const mantto_unitario = volumen_concreto > 0 ? mantto_total / volumen_concreto : 0
        const mantto_pct = ventas_total > 0 ? (mantto_total / ventas_total) * 100 : 0

        const nomina_total = manual.nomina
        const nomina_unitario = volumen_concreto > 0 ? nomina_total / volumen_concreto : 0
        const nomina_pct = ventas_total > 0 ? (nomina_total / ventas_total) * 100 : 0

        const otros_indirectos_total = manual.otros_indirectos
        const otros_indirectos_unitario = volumen_concreto > 0 ? otros_indirectos_total / volumen_concreto : 0
        const otros_indirectos_pct = ventas_total > 0 ? (otros_indirectos_total / ventas_total) * 100 : 0

        const total_costo_op = diesel_total + mantto_total + nomina_total + otros_indirectos_total
        const total_costo_op_pct = ventas_total > 0 ? (total_costo_op / ventas_total) * 100 : 0

        const ebitda = ventas_total - costo_mp_total - total_costo_op
        const ebitda_pct = ventas_total > 0 ? (ebitda / ventas_total) * 100 : 0

        const pumpingDataForPlant = pumpingDataByPlantCode.get(plant.code)
        const ingresos_bombeo_vol = pumpingDataForPlant ? pumpingDataForPlant.volumen_bombeo_m3 : 0
        const ingresos_bombeo_total = pumpingDataForPlant ? pumpingDataForPlant.subtotal_total : 0
        const ingresos_bombeo_unit = ingresos_bombeo_vol > 0 ? ingresos_bombeo_total / ingresos_bombeo_vol : 0

        const ebitda_con_bombeo = ebitda + ingresos_bombeo_total
        const total_ingresos_con_bombeo = ventas_total + ingresos_bombeo_total
        const ebitda_con_bombeo_pct = total_ingresos_con_bombeo > 0 ? (ebitda_con_bombeo / total_ingresos_con_bombeo) * 100 : 0

        return {
          plant_id: plant.id,
          plant_name: plant.name,
          plant_code: plant.code,
          business_unit_id: plant.business_unit_id,
          volumen_concreto,
          fc_ponderada,
          edad_ponderada,
          pv_unitario,
          ventas_total,
          costo_mp_unitario,
          consumo_cem_m3,
          costo_cem_m3,
          costo_cem_pct,
          costo_mp_total,
          costo_mp_pct,
          spread_unitario,
          spread_unitario_pct,
          diesel_total,
          diesel_unitario,
          diesel_pct,
          mantto_total,
          mantto_unitario,
          mantto_pct,
          nomina_total,
          nomina_unitario,
          nomina_pct,
          otros_indirectos_total,
          otros_indirectos_unitario,
          otros_indirectos_pct,
          total_costo_op,
          total_costo_op_pct,
          ebitda,
          ebitda_pct,
          ingresos_bombeo_vol,
          ingresos_bombeo_unit,
          ingresos_bombeo_total,
          ebitda_con_bombeo,
          ebitda_con_bombeo_pct
        }
      })

      const filteredPlantData = plantData.filter(plant => {
        const hasData = plant.ventas_total > 0 || 
          plant.diesel_total > 0 || 
          plant.mantto_total > 0 || 
          plant.nomina_total > 0 || 
          plant.otros_indirectos_total > 0
        return hasData
      })

      return filteredPlantData
    }

    const currentPlants = await buildMonthSnapshot(currentRange)
    const previousPlants = await buildMonthSnapshot(previousRange)

    const previousMap = new Map<string, any>()
    previousPlants.forEach(p => previousMap.set(p.plant_code, p))

    const deltaMetrics = [
      'volumen_concreto',
      'ventas_total',
      'diesel_total',
      'diesel_unitario',
      'diesel_pct',
      'total_costo_op',
      'ebitda',
      'otros_indirectos_total',
      'nomina_total',
      'mantto_total'
    ]

    const deltaByPlant: Record<string, Record<string, { current: number; previous: number; delta: number; deltaPct: number | null }>> = {}

    const calcDelta = (curr: number, prev: number) => {
      const delta = curr - prev
      const deltaPct = prev === 0 ? null : (delta / prev) * 100
      return { current: curr, previous: prev, delta, deltaPct }
    }

    currentPlants.forEach(plant => {
      const prev = previousMap.get(plant.plant_code) || {}
      deltaByPlant[plant.plant_code || plant.plant_id] = {}
      deltaMetrics.forEach(metric => {
        const currVal = Number((plant as any)[metric] || 0)
        const prevVal = Number((prev as any)[metric] || 0)
        deltaByPlant[plant.plant_code || plant.plant_id][metric] = calcDelta(currVal, prevVal)
      })
    })

    return NextResponse.json({
      month,
      comparisonMonth: previousRange.periodMonth.slice(0, 7),
      plants: currentPlants,
      comparison: {
        month: previousRange.periodMonth.slice(0, 7),
        plants: previousPlants
      },
      deltas: deltaByPlant,
      filters: {
        businessUnits: businessUnits || [],
        plants: plants || []
      }
    })
  } catch (e: any) {
    console.error('Ingresos-Gastos API error:', e)
    return NextResponse.json({ error: e?.message || 'Unexpected error' }, { status: 500 })
  }
}

