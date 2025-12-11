import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase-server'
import { SupplierAnalytics } from '@/types/suppliers'

export async function GET(request: NextRequest) {
  try {
    const supabase = await createClient()

    // Get query parameters
    const { searchParams } = new URL(request.url)
    const timeRange = searchParams.get('time_range') || '1y'
    const supplierType = searchParams.get('supplier_type') || 'all'

    // Calculate date range
    const endDate = new Date()
    const startDate = new Date()

    switch (timeRange) {
      case '30d':
        startDate.setDate(endDate.getDate() - 30)
        break
      case '90d':
        startDate.setDate(endDate.getDate() - 90)
        break
      case '1y':
        startDate.setFullYear(endDate.getFullYear() - 1)
        break
      case 'all':
        startDate.setFullYear(2020) // Far back enough
        break
      default:
        startDate.setFullYear(endDate.getFullYear() - 1)
    }

    // Get suppliers data
    let suppliersQuery = supabase
      .from('suppliers')
      .select(`
        *,
        supplier_performance_history(*),
        supplier_work_history(*)
      `)
      .eq('status', 'active')

    if (supplierType !== 'all') {
      suppliersQuery = suppliersQuery.eq('supplier_type', supplierType)
    }

    const { data: suppliers, error: suppliersError } = await suppliersQuery

    if (suppliersError) {
      console.error('Error fetching suppliers for analytics:', suppliersError)
      return NextResponse.json(
        { error: 'Error fetching supplier data' },
        { status: 500 }
      )
    }

    // Get purchase orders data for cost analysis - need to get orders linked by supplier_id OR supplier name
    const { data: purchaseOrders, error: poError } = await supabase
      .from('purchase_orders')
      .select('id, order_id, supplier_id, supplier, total_amount, actual_amount, created_at, purchase_date, po_type, status')
      .gte('created_at', startDate.toISOString())
      .lte('created_at', endDate.toISOString())

    if (poError) {
      console.error('Error fetching purchase orders:', poError)
    }

    // Create a map of supplier names to supplier IDs for matching legacy purchase orders
    const supplierNameMap = new Map<string, string>()
    suppliers?.forEach(s => {
      if (s.name) supplierNameMap.set(s.name.toLowerCase().trim(), s.id)
      if (s.business_name) supplierNameMap.set(s.business_name.toLowerCase().trim(), s.id)
    })

    // Link purchase orders to suppliers
    const purchaseOrdersWithSuppliers = (purchaseOrders || []).map(po => {
      let linkedSupplierId = po.supplier_id
      
      // If no supplier_id but has supplier name, try to match
      if (!linkedSupplierId && po.supplier) {
        const matchedId = supplierNameMap.get(po.supplier.toLowerCase().trim())
        if (matchedId) {
          linkedSupplierId = matchedId
        }
      }
      
      return {
        ...po,
        linked_supplier_id: linkedSupplierId
      }
    })

    // Calculate analytics
    const analytics = await calculateSupplierAnalytics(suppliers || [], purchaseOrdersWithSuppliers || [])

    return NextResponse.json({
      analytics,
      metadata: {
        time_range: timeRange,
        supplier_type: supplierType,
        generated_at: new Date().toISOString(),
        supplier_count: suppliers?.length || 0,
        purchase_order_count: purchaseOrders?.length || 0
      }
    })

  } catch (error) {
    console.error('Error in supplier analytics API:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}

async function calculateSupplierAnalytics(suppliers: any[], purchaseOrders: any[]): Promise<SupplierAnalytics> {
  // Basic summary statistics
  const totalSuppliers = suppliers.length
  const activeSuppliers = suppliers.filter(s => s.status === 'active').length

  const totalOrdersThisYear = purchaseOrders.filter(po =>
    new Date(po.created_at).getFullYear() === new Date().getFullYear()
  ).length

  const totalAmountThisYear = purchaseOrders
    .filter(po => new Date(po.created_at).getFullYear() === new Date().getFullYear())
    .reduce((sum, po) => sum + (po.total_amount || 0), 0)

  const averageRating = suppliers.length > 0
    ? suppliers.reduce((sum, s) => sum + (s.rating || 0), 0) / suppliers.length
    : 0

  const averageReliability = suppliers.length > 0
    ? suppliers.reduce((sum, s) => sum + (s.reliability_score || 0), 0) / suppliers.length
    : 0

  // Performance distribution
  const excellent = suppliers.filter(s => (s.rating || 0) >= 4.5).length
  const good = suppliers.filter(s => (s.rating || 0) >= 3.5 && (s.rating || 0) < 4.5).length
  const average = suppliers.filter(s => (s.rating || 0) >= 2.5 && (s.rating || 0) < 3.5).length
  const poor = suppliers.filter(s => (s.rating || 0) < 2.5).length

  // Top performers (by rating and reliability)
  const topPerformers = suppliers
    .filter(s => s.rating && s.reliability_score)
    .sort((a, b) => {
      const scoreA = (a.rating || 0) * 0.6 + (a.reliability_score || 0) * 0.4
      const scoreB = (b.rating || 0) * 0.6 + (b.reliability_score || 0) * 0.4
      return scoreB - scoreA
    })
    .slice(0, 5)

  // Cost analysis by supplier type - also count purchase orders per supplier
  const suppliersByType = suppliers.reduce((acc, supplier) => {
    const type = supplier.supplier_type || 'unknown'
    if (!acc[type]) {
      acc[type] = {
        count: 0,
        total_orders: 0,
        total_amount: 0,
        average_rating: 0,
        suppliers: []
      }
    }
    acc[type].count++
    
    // Count purchase orders for this supplier
    const supplierPOs = purchaseOrders.filter(po => 
      po.linked_supplier_id === supplier.id
    )
    const supplierTotalAmount = supplierPOs.reduce((sum, po) => sum + (Number(po.total_amount) || Number(po.actual_amount) || 0), 0)
    
    acc[type].total_orders += supplierPOs.length
    acc[type].total_amount += supplierTotalAmount
    acc[type].suppliers.push({
      ...supplier,
      _po_count: supplierPOs.length,
      _po_amount: supplierTotalAmount
    })
    return acc
  }, {} as Record<string, any>)

  // Calculate averages for each type
  Object.keys(suppliersByType).forEach(type => {
    const typeData = suppliersByType[type]
    if (typeData.count > 0) {
      typeData.average_rating = typeData.suppliers.reduce((sum: number, s: any) => sum + (s.rating || 0), 0) / typeData.count
    }
  })

  // Cost analysis
  const costAnalysis = {
    average_cost_per_supplier: totalSuppliers > 0 ? totalAmountThisYear / totalSuppliers : 0,
    cost_variance_by_type: {} as Record<string, number>,
    most_economical_suppliers: suppliers
      .filter(s => s.avg_order_amount)
      .sort((a, b) => (a.avg_order_amount || 0) - (b.avg_order_amount || 0))
      .slice(0, 5)
  }

  // Calculate cost variance by type
  Object.keys(suppliersByType).forEach(type => {
    const typeSuppliers = suppliersByType[type].suppliers
    const avgCost = typeSuppliers.reduce((sum: number, s: any) => sum + (s.avg_order_amount || 0), 0) / typeSuppliers.length
    const variance = typeSuppliers.reduce((sum: number, s: any) => {
      const diff = (s.avg_order_amount || 0) - avgCost
      return sum + (diff * diff)
    }, 0) / typeSuppliers.length
    costAnalysis.cost_variance_by_type[type] = Math.sqrt(variance)
  })

  // Reliability trends (monthly)
  const reliabilityTrends = await calculateReliabilityTrends(suppliers)

  return {
    summary: {
      total_suppliers: totalSuppliers,
      active_suppliers: activeSuppliers,
      total_orders_this_year: totalOrdersThisYear,
      total_amount_this_year: totalAmountThisYear,
      average_rating: Math.round(averageRating * 10) / 10,
      average_reliability: Math.round(averageReliability)
    },
    by_type: suppliersByType,
    by_performance: {
      excellent,
      good,
      average,
      poor
    },
    top_performers: topPerformers,
    cost_analysis: costAnalysis,
    reliability_trends: {
      monthly_reliability_scores: reliabilityTrends
    }
  }
}

async function calculateReliabilityTrends(suppliers: any[]): Promise<Array<{ month: string; average_score: number; order_count: number }>> {
  // Calculate real reliability trends from supplier performance history
  const supabase = await createClient()
  const endDate = new Date()
  const startDate = new Date()
  startDate.setFullYear(endDate.getFullYear() - 1)
  
  // Get all performance history records for the last year
  const { data: performanceHistory, error } = await supabase
    .from('supplier_performance_history')
    .select('supplier_id, order_date, delivery_rating, quality_rating, service_rating')
    .gte('order_date', startDate.toISOString())
    .order('order_date', { ascending: true })

  if (error || !performanceHistory || performanceHistory.length === 0) {
    // Return empty structure if no data
    return []
  }

  // Group by month
  const monthlyData = new Map<string, { scores: number[], orderCount: number }>()
  
  performanceHistory.forEach(record => {
    const date = new Date(record.order_date)
    const monthKey = date.toLocaleDateString('es-MX', { month: 'short', year: '2-digit' })
    
    if (!monthlyData.has(monthKey)) {
      monthlyData.set(monthKey, { scores: [], orderCount: 0 })
    }
    
    const monthData = monthlyData.get(monthKey)!
    monthData.orderCount++
    
    // Calculate reliability score from delivery_rating (1-5 scale, convert to percentage)
    if (record.delivery_rating) {
      monthData.scores.push((record.delivery_rating / 5) * 100)
    } else if (record.quality_rating && record.service_rating) {
      // Fallback: use average of quality and service ratings
      const avgRating = (record.quality_rating + record.service_rating) / 2
      monthData.scores.push((avgRating / 5) * 100)
    }
  })

  // Convert to array format
  return Array.from(monthlyData.entries())
    .map(([month, data]) => ({
      month,
      average_score: data.scores.length > 0 
        ? Math.round(data.scores.reduce((a, b) => a + b, 0) / data.scores.length)
        : 0,
      order_count: data.orderCount
    }))
    .sort((a, b) => {
      // Sort by date
      const dateA = new Date(`01 ${a.month}`)
      const dateB = new Date(`01 ${b.month}`)
      return dateA.getTime() - dateB.getTime()
    })
}
