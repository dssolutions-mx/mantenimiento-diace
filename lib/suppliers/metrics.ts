import { SupplierPurchaseOrder } from "@/components/suppliers/SupplierDetails"

export interface MonthlySpending {
  month: string
  year: number
  monthKey: string // "2025-01"
  amount: number
  orderCount: number
  averageOrderSize: number
}

export interface SpendingTrend {
  period: string
  amount: number
  orderCount: number
  trend: 'increasing' | 'decreasing' | 'stable'
  changePercent: number
}

export interface AssetFixed {
  assetId: string
  assetName: string
  modelName?: string
  manufacturer?: string
  orderCount: number
  totalSpending: number
  averageCost: number
  lastServiceDate: string | null
}

export interface WorkOrderTypeStats {
  type: string
  count: number
  totalSpending: number
  averageSpending: number
  percentage: number
}

export interface SupplierMetrics {
  totalSpending: number
  totalSpendingLast12Months: number
  spendingTrend: 'increasing' | 'decreasing' | 'stable'
  spendingChangePercent: number
  averageOrderSize: number
  averageOrderSizeTrend: 'increasing' | 'decreasing' | 'stable'
  totalOrders: number
  ordersLast12Months: number
  ordersPerMonth: number
  ordersGrowthRate: number
  uniqueUnitsFixed: number
  assetsFixed: AssetFixed[]
  averageDeliveryTime: number | null
  issuesCount: number
  unresolvedIssuesCount: number
  issuesPerOrderRatio: number
  monthlySpending: MonthlySpending[]
  spendingTrends: SpendingTrend[]
  workOrderTypes: WorkOrderTypeStats[]
}

/**
 * Get the posting date from a purchase order (posting_date → purchase_date → created_at)
 */
export function getPostingDate(po: SupplierPurchaseOrder): Date {
  if (po.posting_date) {
    return new Date(po.posting_date)
  }
  if (po.purchase_date) {
    return new Date(po.purchase_date)
  }
  return new Date(po.created_at)
}

/**
 * Calculate total spending metrics
 */
export function calculateTotalSpending(
  purchaseOrders: SupplierPurchaseOrder[],
  issuesCount: number = 0
): {
  totalSpending: number
  totalSpendingLast12Months: number
  spendingTrend: 'increasing' | 'decreasing' | 'stable'
  spendingChangePercent: number
} {
  const now = new Date()
  const twelveMonthsAgo = new Date(now.getFullYear(), now.getMonth() - 12, 1)
  const twentyFourMonthsAgo = new Date(now.getFullYear(), now.getMonth() - 24, 1)

  // Calculate spending for different periods
  const allTimeSpending = purchaseOrders.reduce((sum, po) => {
    const amount = po.actual_amount || po.total_amount || 0
    return sum + Number(amount)
  }, 0)

  const last12MonthsSpending = purchaseOrders
    .filter(po => {
      const date = getPostingDate(po)
      return date >= twelveMonthsAgo
    })
    .reduce((sum, po) => {
      const amount = po.actual_amount || po.total_amount || 0
      return sum + Number(amount)
    }, 0)

  const previous12MonthsSpending = purchaseOrders
    .filter(po => {
      const date = getPostingDate(po)
      return date >= twentyFourMonthsAgo && date < twelveMonthsAgo
    })
    .reduce((sum, po) => {
      const amount = po.actual_amount || po.total_amount || 0
      return sum + Number(amount)
    }, 0)

  // Calculate trend
  let spendingTrend: 'increasing' | 'decreasing' | 'stable' = 'stable'
  let spendingChangePercent = 0

  if (previous12MonthsSpending > 0) {
    spendingChangePercent = ((last12MonthsSpending - previous12MonthsSpending) / previous12MonthsSpending) * 100
    
    if (spendingChangePercent > 5) {
      spendingTrend = 'increasing'
    } else if (spendingChangePercent < -5) {
      spendingTrend = 'decreasing'
    }
  } else if (last12MonthsSpending > 0) {
    spendingTrend = 'increasing'
    spendingChangePercent = 100
  }

  return {
    totalSpending: allTimeSpending,
    totalSpendingLast12Months: last12MonthsSpending,
    spendingTrend,
    spendingChangePercent: Math.round(spendingChangePercent * 10) / 10
  }
}

/**
 * Calculate average order size metrics
 */
export function calculateAverageOrderSize(
  purchaseOrders: SupplierPurchaseOrder[]
): {
  averageOrderSize: number
  averageOrderSizeTrend: 'increasing' | 'decreasing' | 'stable'
} {
  if (purchaseOrders.length === 0) {
    return { averageOrderSize: 0, averageOrderSizeTrend: 'stable' }
  }

  const now = new Date()
  const sixMonthsAgo = new Date(now.getFullYear(), now.getMonth() - 6, 1)
  const twelveMonthsAgo = new Date(now.getFullYear(), now.getMonth() - 12, 1)

  // Calculate average for last 12 months
  const last12MonthsOrders = purchaseOrders.filter(po => {
    const date = getPostingDate(po)
    return date >= twelveMonthsAgo
  })

  const last12MonthsTotal = last12MonthsOrders.reduce((sum, po) => {
    const amount = po.actual_amount || po.total_amount || 0
    return sum + Number(amount)
  }, 0)

  const averageOrderSize = last12MonthsOrders.length > 0
    ? last12MonthsTotal / last12MonthsOrders.length
    : 0

  // Calculate trend (compare last 6 months vs previous 6 months)
  const last6MonthsOrders = purchaseOrders.filter(po => {
    const date = getPostingDate(po)
    return date >= sixMonthsAgo
  })

  const previous6MonthsOrders = purchaseOrders.filter(po => {
    const date = getPostingDate(po)
    return date >= twelveMonthsAgo && date < sixMonthsAgo
  })

  const last6MonthsAvg = last6MonthsOrders.length > 0
    ? last6MonthsOrders.reduce((sum, po) => sum + Number(po.actual_amount || po.total_amount || 0), 0) / last6MonthsOrders.length
    : 0

  const previous6MonthsAvg = previous6MonthsOrders.length > 0
    ? previous6MonthsOrders.reduce((sum, po) => sum + Number(po.actual_amount || po.total_amount || 0), 0) / previous6MonthsOrders.length
    : 0

  let averageOrderSizeTrend: 'increasing' | 'decreasing' | 'stable' = 'stable'
  if (previous6MonthsAvg > 0) {
    const change = ((last6MonthsAvg - previous6MonthsAvg) / previous6MonthsAvg) * 100
    if (change > 5) {
      averageOrderSizeTrend = 'increasing'
    } else if (change < -5) {
      averageOrderSizeTrend = 'decreasing'
    }
  } else if (last6MonthsAvg > 0) {
    averageOrderSizeTrend = 'increasing'
  }

  return {
    averageOrderSize: Math.round(averageOrderSize * 100) / 100,
    averageOrderSizeTrend
  }
}

/**
 * Calculate order count metrics
 */
export function calculateOrderCounts(
  purchaseOrders: SupplierPurchaseOrder[]
): {
  totalOrders: number
  ordersLast12Months: number
  ordersPerMonth: number
  ordersGrowthRate: number
} {
  const now = new Date()
  const twelveMonthsAgo = new Date(now.getFullYear(), now.getMonth() - 12, 1)
  const twentyFourMonthsAgo = new Date(now.getFullYear(), now.getMonth() - 24, 1)

  const totalOrders = purchaseOrders.length

  const ordersLast12Months = purchaseOrders.filter(po => {
    const date = getPostingDate(po)
    return date >= twelveMonthsAgo
  }).length

  const ordersPerMonth = ordersLast12Months / 12

  const previous12MonthsOrders = purchaseOrders.filter(po => {
    const date = getPostingDate(po)
    return date >= twentyFourMonthsAgo && date < twelveMonthsAgo
  }).length

  const ordersGrowthRate = previous12MonthsOrders > 0
    ? ((ordersLast12Months - previous12MonthsOrders) / previous12MonthsOrders) * 100
    : ordersLast12Months > 0 ? 100 : 0

  return {
    totalOrders,
    ordersLast12Months,
    ordersPerMonth: Math.round(ordersPerMonth * 10) / 10,
    ordersGrowthRate: Math.round(ordersGrowthRate * 10) / 10
  }
}

/**
 * Calculate unique units/assets fixed
 */
export function calculateUnitsFixed(
  purchaseOrders: SupplierPurchaseOrder[]
): {
  uniqueUnitsFixed: number
  assetsFixed: AssetFixed[]
} {
  const assetMap = new Map<string, {
    assetId: string
    assetName: string
    modelName?: string
    manufacturer?: string
    orders: SupplierPurchaseOrder[]
    totalSpending: number
    lastServiceDate: Date | null
  }>()

  purchaseOrders.forEach(po => {
    const asset = po.work_orders?.assets
    if (asset?.id) {
      const assetId = asset.id
      const existing = assetMap.get(assetId) || {
        assetId,
        assetName: asset.asset_id || asset.name || 'Unknown',
        modelName: asset.equipment_models?.name,
        manufacturer: asset.equipment_models?.manufacturer,
        orders: [],
        totalSpending: 0,
        lastServiceDate: null
      }

      existing.orders.push(po)
      const amount = po.actual_amount || po.total_amount || 0
      existing.totalSpending += Number(amount)

      const poDate = getPostingDate(po)
      if (!existing.lastServiceDate || poDate > existing.lastServiceDate) {
        existing.lastServiceDate = poDate
      }

      assetMap.set(assetId, existing)
    }
  })

  const assetsFixed: AssetFixed[] = Array.from(assetMap.values()).map(asset => ({
    assetId: asset.assetId,
    assetName: asset.assetName,
    modelName: asset.modelName,
    manufacturer: asset.manufacturer,
    orderCount: asset.orders.length,
    totalSpending: Math.round(asset.totalSpending * 100) / 100,
    averageCost: asset.orders.length > 0
      ? Math.round((asset.totalSpending / asset.orders.length) * 100) / 100
      : 0,
    lastServiceDate: asset.lastServiceDate?.toISOString() || null
  }))

  return {
    uniqueUnitsFixed: assetsFixed.length,
    assetsFixed: assetsFixed.sort((a, b) => {
      // Sort by last service date (most recent first), then by total spending
      if (a.lastServiceDate && b.lastServiceDate) {
        return new Date(b.lastServiceDate).getTime() - new Date(a.lastServiceDate).getTime()
      }
      if (a.lastServiceDate) return -1
      if (b.lastServiceDate) return 1
      return b.totalSpending - a.totalSpending
    })
  }
}

/**
 * Calculate monthly spending breakdown
 */
export function calculateMonthlySpending(
  purchaseOrders: SupplierPurchaseOrder[],
  months: number = 12
): MonthlySpending[] {
  const now = new Date()
  const startDate = new Date(now.getFullYear(), now.getMonth() - months + 1, 1)

  const monthlyMap = new Map<string, {
    month: string
    year: number
    monthKey: string
    orders: SupplierPurchaseOrder[]
    amount: number
  }>()

  purchaseOrders
    .filter(po => {
      const date = getPostingDate(po)
      return date >= startDate
    })
    .forEach(po => {
      const date = getPostingDate(po)
      const monthKey = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`
      const monthLabel = date.toLocaleDateString('es-MX', { month: 'short', year: 'numeric' })

      const existing = monthlyMap.get(monthKey) || {
        month: monthLabel,
        year: date.getFullYear(),
        monthKey,
        orders: [],
        amount: 0
      }

      existing.orders.push(po)
      const amount = po.actual_amount || po.total_amount || 0
      existing.amount += Number(amount)

      monthlyMap.set(monthKey, existing)
    })

  const monthlySpending: MonthlySpending[] = Array.from(monthlyMap.values())
    .map(data => ({
      month: data.month,
      year: data.year,
      monthKey: data.monthKey,
      amount: Math.round(data.amount * 100) / 100,
      orderCount: data.orders.length,
      averageOrderSize: data.orders.length > 0
        ? Math.round((data.amount / data.orders.length) * 100) / 100
        : 0
    }))
    .sort((a, b) => a.monthKey.localeCompare(b.monthKey))

  return monthlySpending
}

/**
 * Calculate spending trends
 */
export function calculateSpendingTrends(
  purchaseOrders: SupplierPurchaseOrder[],
  periods: number[] = [3, 6, 12]
): SpendingTrend[] {
  const now = new Date()
  
  return periods.map(periodMonths => {
    const periodStart = new Date(now.getFullYear(), now.getMonth() - periodMonths, 1)
    const previousPeriodStart = new Date(now.getFullYear(), now.getMonth() - (periodMonths * 2), 1)

    const periodOrders = purchaseOrders.filter(po => {
      const date = getPostingDate(po)
      return date >= periodStart
    })

    const previousPeriodOrders = purchaseOrders.filter(po => {
      const date = getPostingDate(po)
      return date >= previousPeriodStart && date < periodStart
    })

    const periodAmount = periodOrders.reduce((sum, po) => {
      return sum + Number(po.actual_amount || po.total_amount || 0)
    }, 0)

    const previousPeriodAmount = previousPeriodOrders.reduce((sum, po) => {
      return sum + Number(po.actual_amount || po.total_amount || 0)
    }, 0)

    let trend: 'increasing' | 'decreasing' | 'stable' = 'stable'
    let changePercent = 0

    if (previousPeriodAmount > 0) {
      changePercent = ((periodAmount - previousPeriodAmount) / previousPeriodAmount) * 100
      if (changePercent > 5) {
        trend = 'increasing'
      } else if (changePercent < -5) {
        trend = 'decreasing'
      }
    } else if (periodAmount > 0) {
      trend = 'increasing'
      changePercent = 100
    }

    return {
      period: `${periodMonths} meses`,
      amount: Math.round(periodAmount * 100) / 100,
      orderCount: periodOrders.length,
      trend,
      changePercent: Math.round(changePercent * 10) / 10
    }
  })
}

/**
 * Calculate work order types breakdown
 */
export function calculateWorkOrderTypes(
  purchaseOrders: SupplierPurchaseOrder[]
): WorkOrderTypeStats[] {
  const typeMap = new Map<string, {
    type: string
    orders: SupplierPurchaseOrder[]
    totalSpending: number
  }>()

  purchaseOrders.forEach(po => {
    const workOrderType = po.work_orders?.type || 'unknown'
    const existing = typeMap.get(workOrderType) || {
      type: workOrderType,
      orders: [],
      totalSpending: 0
    }

    existing.orders.push(po)
    const amount = po.actual_amount || po.total_amount || 0
    existing.totalSpending += Number(amount)

    typeMap.set(workOrderType, existing)
  })

  const totalSpending = Array.from(typeMap.values()).reduce((sum, data) => sum + data.totalSpending, 0)

  const workOrderTypes: WorkOrderTypeStats[] = Array.from(typeMap.values())
    .map(data => ({
      type: data.type,
      count: data.orders.length,
      totalSpending: Math.round(data.totalSpending * 100) / 100,
      averageSpending: data.orders.length > 0
        ? Math.round((data.totalSpending / data.orders.length) * 100) / 100
        : 0,
      percentage: totalSpending > 0
        ? Math.round((data.totalSpending / totalSpending) * 100 * 10) / 10
        : 0
    }))
    .sort((a, b) => b.totalSpending - a.totalSpending)

  return workOrderTypes
}

/**
 * Calculate all supplier metrics
 */
export function calculateAllMetrics(
  purchaseOrders: SupplierPurchaseOrder[],
  issuesCount: number = 0,
  unresolvedIssuesCount: number = 0
): SupplierMetrics {
  const spending = calculateTotalSpending(purchaseOrders, issuesCount)
  const orderSize = calculateAverageOrderSize(purchaseOrders)
  const orderCounts = calculateOrderCounts(purchaseOrders)
  const unitsFixed = calculateUnitsFixed(purchaseOrders)
  const monthlySpending = calculateMonthlySpending(purchaseOrders, 12)
  const spendingTrends = calculateSpendingTrends(purchaseOrders)
  const workOrderTypes = calculateWorkOrderTypes(purchaseOrders)

  const issuesPerOrderRatio = purchaseOrders.length > 0
    ? Math.round((issuesCount / purchaseOrders.length) * 100 * 10) / 10
    : 0

  return {
    ...spending,
    ...orderSize,
    ...orderCounts,
    ...unitsFixed,
    averageDeliveryTime: null, // TODO: Calculate from performance history if available
    issuesCount,
    unresolvedIssuesCount,
    issuesPerOrderRatio,
    monthlySpending,
    spendingTrends,
    workOrderTypes
  }
}
