"use client"

import { useState, useEffect } from "react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Star, TrendingUp, TrendingDown, Minus } from "lucide-react"
import { createClient } from "@/lib/supabase"

interface SupplierPerformanceChartProps {
  supplierId: string
  timeRange?: '30d' | '90d' | '1y' | 'all'
  metrics?: ('rating' | 'reliability' | 'delivery_time' | 'cost_accuracy')[]
}

interface PerformanceData {
  period: string
  rating: number
  reliability: number
  delivery_time: number
  cost_accuracy: number
  order_count: number
}

type RawPerformanceRecord = {
  order_date: string
  delivery_date?: string | null
  promised_delivery_date?: string | null
  quality_rating?: number | null
  delivery_rating?: number | null
  service_rating?: number | null
  actual_cost?: number | string | null
  quoted_cost?: number | string | null
}

export function SupplierPerformanceChart({
  supplierId,
  timeRange = '90d',
  metrics = ['rating', 'reliability']
}: SupplierPerformanceChartProps) {
  const [data, setData] = useState<PerformanceData[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    loadPerformanceData()
  }, [supplierId, timeRange])

  const loadPerformanceData = async () => {
    setLoading(true)
    try {
      const supabase = createClient()
      const startDate = new Date()
      const endDate = new Date()

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
        default:
          startDate.setFullYear(endDate.getFullYear() - 3)
      }

      const { data: records, error } = await supabase
        .from('supplier_performance_history')
        .select('order_date, delivery_date, promised_delivery_date, quality_rating, delivery_rating, service_rating, actual_cost, quoted_cost, supplier_id')
        .eq('supplier_id', supplierId)
        .gte('order_date', startDate.toISOString())
        .order('order_date', { ascending: true })

      if (error) {
        console.error('Error loading performance data:', error)
        setData([])
        return
      }

      if (!records || records.length === 0) {
        setData([])
        return
      }

      type Bucket = {
        period: string
        dateKey: number
        ratingSum: number
        ratingCount: number
        reliabilitySum: number
        reliabilityCount: number
        deliveryTimeSum: number
        deliveryTimeCount: number
        costAccuracySum: number
        costAccuracyCount: number
        orderCount: number
      }

      const buckets = new Map<string, Bucket>()

      (records as RawPerformanceRecord[]).forEach((record) => {
        const orderDate = new Date(record.order_date)
        const periodLabel = orderDate.toLocaleDateString('es-MX', { month: 'short', year: '2-digit' })
        const bucket = buckets.get(periodLabel) || {
          period: periodLabel,
          dateKey: orderDate.getTime(),
          ratingSum: 0,
          ratingCount: 0,
          reliabilitySum: 0,
          reliabilityCount: 0,
          deliveryTimeSum: 0,
          deliveryTimeCount: 0,
          costAccuracySum: 0,
          costAccuracyCount: 0,
          orderCount: 0
        }

        const ratings = [record.quality_rating, record.service_rating].filter((v) => typeof v === 'number') as number[]
        if (ratings.length) {
          bucket.ratingSum += ratings.reduce((sum, r) => sum + r, 0) / ratings.length
          bucket.ratingCount += 1
        }

        if (typeof record.delivery_rating === 'number') {
          // delivery rating is 1-5, convert to percentage
          bucket.reliabilitySum += (record.delivery_rating / 5) * 100
          bucket.reliabilityCount += 1
        }

        if (record.delivery_date && record.promised_delivery_date) {
          const deliveryDate = new Date(record.delivery_date)
          const promisedDate = new Date(record.promised_delivery_date)
          const diffDays = Math.round((deliveryDate.getTime() - promisedDate.getTime()) / (1000 * 60 * 60 * 24))
          bucket.deliveryTimeSum += diffDays
          bucket.deliveryTimeCount += 1
        }

        if (record.actual_cost && record.quoted_cost) {
          const actualCost = typeof record.actual_cost === 'string' ? parseFloat(record.actual_cost) : record.actual_cost
          const quotedCost = typeof record.quoted_cost === 'string' ? parseFloat(record.quoted_cost) : record.quoted_cost

          if (actualCost && quotedCost) {
            const accuracy = Math.min(actualCost, quotedCost) / Math.max(actualCost, quotedCost) * 100
            bucket.costAccuracySum += accuracy
            bucket.costAccuracyCount += 1
          }
        }

        // If we only have actual cost, treat it as completed order for count
        if (record.actual_cost && !record.quoted_cost) {
          const actualCost = typeof record.actual_cost === 'string' ? parseFloat(record.actual_cost) : record.actual_cost
          if (actualCost) {
            bucket.costAccuracySum += 100
            bucket.costAccuracyCount += 1
          }
        }

        bucket.orderCount += 1
        buckets.set(periodLabel, bucket)
      })

      const aggregated: PerformanceData[] = Array.from(buckets.values())
        .sort((a, b) => a.dateKey - b.dateKey)
        .map((bucket) => ({
          period: bucket.period,
          rating: bucket.ratingCount ? Math.round((bucket.ratingSum / bucket.ratingCount) * 10) / 10 : 0,
          reliability: bucket.reliabilityCount ? Math.round(bucket.reliabilitySum / bucket.reliabilityCount) : 0,
          delivery_time: bucket.deliveryTimeCount ? Math.round(bucket.deliveryTimeSum / bucket.deliveryTimeCount) : 0,
          cost_accuracy: bucket.costAccuracyCount ? Math.round(bucket.costAccuracySum / bucket.costAccuracyCount) : 0,
          order_count: bucket.orderCount
        }))

      setData(aggregated)
    } catch (error) {
      console.error('Error loading performance data:', error)
      setData([])
    } finally {
      setLoading(false)
    }
  }

  const getTrendIcon = (current: number, previous: number) => {
    if (current > previous) return <TrendingUp className="w-4 h-4 text-green-500" />
    if (current < previous) return <TrendingDown className="w-4 h-4 text-red-500" />
    return <Minus className="w-4 h-4 text-gray-500" />
  }

  const getTrendColor = (current: number, previous: number) => {
    if (current > previous) return "text-green-600"
    if (current < previous) return "text-red-600"
    return "text-gray-600"
  }

  const formatMetricValue = (metric: string, value: number) => {
    switch (metric) {
      case 'rating':
        return `${value.toFixed(1)}/5`
      case 'reliability':
        return `${value}%`
      case 'delivery_time':
        return `${value} días`
      case 'cost_accuracy':
        return `${value}%`
      default:
        return value.toString()
    }
  }

  if (loading) {
    return (
      <Card>
        <CardContent className="p-6">
          <div className="flex items-center justify-center">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
            <span className="ml-2">Cargando datos de rendimiento...</span>
          </div>
        </CardContent>
      </Card>
    )
  }

  if (!data.length) {
    return (
      <Card>
        <CardContent className="p-6">
          <p className="text-center text-muted-foreground">
            No hay datos de rendimiento disponibles
          </p>
        </CardContent>
      </Card>
    )
  }

  const latestData = data[data.length - 1]
  const previousData = data.length > 1 ? data[data.length - 2] : latestData

  return (
    <div className="space-y-4">
      {/* Summary Cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {metrics.map(metric => {
          const currentValue = latestData[metric as keyof PerformanceData] as number
          const previousValue = previousData[metric as keyof PerformanceData] as number

          return (
            <Card key={metric}>
              <CardContent className="p-4">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-sm font-medium capitalize">
                      {metric === 'rating' ? 'Calificación' :
                       metric === 'reliability' ? 'Confiabilidad' :
                       metric === 'delivery_time' ? 'Tiempo Entrega' :
                       'Precisión Costo'}
                    </p>
                    <p className="text-2xl font-bold">
                      {formatMetricValue(metric, currentValue)}
                    </p>
                  </div>
                  <div className="flex items-center gap-1">
                    {getTrendIcon(currentValue, previousValue)}
                    <span className={`text-xs ${getTrendColor(currentValue, previousValue)}`}>
                      {currentValue !== previousValue && (
                        `${currentValue > previousValue ? '+' : ''}${((currentValue - previousValue) * (metric === 'delivery_time' ? -1 : 1)).toFixed(1)}`
                      )}
                    </span>
                  </div>
                </div>
              </CardContent>
            </Card>
          )
        })}
      </div>

      {/* Performance Trend */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Star className="w-5 h-5" />
            Tendencia de Rendimiento
          </CardTitle>
          <CardDescription>
            Evolución del rendimiento del proveedor en el tiempo
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="space-y-4">
            {data.slice(-6).map((period, index) => (
              <div key={period.period} className="flex items-center justify-between p-3 border rounded-lg">
                <div className="flex items-center gap-3">
                  <Badge variant="outline">{period.period}</Badge>
                  <span className="text-sm text-muted-foreground">
                    {period.order_count} órdenes
                  </span>
                </div>
                <div className="flex items-center gap-4">
                  {metrics.map(metric => {
                    const value = period[metric as keyof PerformanceData] as number
                    return (
                      <div key={metric} className="text-center">
                        <p className="text-xs text-muted-foreground">
                          {metric === 'rating' ? 'Calif.' :
                           metric === 'reliability' ? 'Conf.' :
                           metric === 'delivery_time' ? 'Entrega' :
                           'Costo'}
                        </p>
                        <p className="font-semibold text-sm">
                          {formatMetricValue(metric, value)}
                        </p>
                      </div>
                    )
                  })}
                </div>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* Performance Insights */}
      <Card>
        <CardHeader>
          <CardTitle>Insights de Rendimiento</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-2">
            {latestData.rating >= 4.5 && (
              <div className="flex items-center gap-2 text-green-600">
                <Star className="w-4 h-4 fill-current" />
                <span className="text-sm">Excelente calificación general</span>
              </div>
            )}
            {latestData.reliability >= 90 && (
              <div className="flex items-center gap-2 text-blue-600">
                <TrendingUp className="w-4 h-4" />
                <span className="text-sm">Alta confiabilidad en entregas</span>
              </div>
            )}
            {latestData.delivery_time <= 5 && (
              <div className="flex items-center gap-2 text-purple-600">
                <TrendingUp className="w-4 h-4" />
                <span className="text-sm">Entregas rápidas y consistentes</span>
              </div>
            )}
            {latestData.cost_accuracy >= 95 && (
              <div className="flex items-center gap-2 text-orange-600">
                <TrendingUp className="w-4 h-4" />
                <span className="text-sm">Excelente precisión en presupuestos</span>
              </div>
            )}
            {data.length < 3 && (
              <div className="flex items-center gap-2 text-yellow-600">
                <Minus className="w-4 h-4" />
                <span className="text-sm">Datos limitados - se necesita más historial</span>
              </div>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
