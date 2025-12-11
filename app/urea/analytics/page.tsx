"use client"

import { useState, useEffect } from "react"
import { createBrowserClient } from "@supabase/ssr"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Badge } from "@/components/ui/badge"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { useToast } from "@/components/ui/use-toast"
import { 
  BarChart3, 
  TrendingUp,
  Calendar,
  Fuel,
  ChevronLeft,
  Loader2,
  Download,
  Clock,
  MapPin,
  Activity,
  Eye,
  FileText,
  X
} from "lucide-react"
import { useRouter } from "next/navigation"
import Link from "next/link"

interface AssetConsumption {
  asset_id: string | null
  asset_name: string
  total_liters: number
  transaction_count: number
  avg_per_transaction: number
  last_consumption: string
  hours_progression?: number
  kilometers_progression?: number
  efficiency_per_hour?: number
  efficiency_per_km?: number
  monthly_breakdown: MonthlyConsumption[]
}

interface MonthlyConsumption {
  month: string
  year: number
  liters: number
  transactions: number
  avg_per_transaction: number
  hours_progression?: number
  kilometers_progression?: number
  efficiency_per_hour?: number
  efficiency_per_km?: number
}

interface WarehouseConsumption {
  warehouse_id: string
  warehouse_name: string
  total_consumption: number
  total_entries: number
  net_flow: number
}

interface TransactionDetail {
  id: string
  transaction_date: string
  quantity_liters: number
  warehouse_name: string
  created_by_name: string
  notes?: string
  horometer_reading?: number
  kilometer_reading?: number
  previous_horometer?: number
  previous_kilometer?: number
}

export default function DieselAnalyticsPage() {
  const router = useRouter()
  const { toast } = useToast()
  const [loading, setLoading] = useState(true)
  const [assetConsumptions, setAssetConsumptions] = useState<AssetConsumption[]>([])
  const [warehouseStats, setWarehouseStats] = useState<WarehouseConsumption[]>([])
  const [selectedAsset, setSelectedAsset] = useState<AssetConsumption | null>(null)
  const [assetTransactions, setAssetTransactions] = useState<TransactionDetail[]>([])
  const [showTransactions, setShowTransactions] = useState(false)
  
  // Filters
  const [dateFrom, setDateFrom] = useState<string>("")
  const [dateTo, setDateTo] = useState<string>("")
  
  // Summary stats
  const [totalConsumption, setTotalConsumption] = useState(0)
  const [totalEntries, setTotalEntries] = useState(0)
  const [uniqueAssets, setUniqueAssets] = useState(0)

  const supabase = createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  )

  useEffect(() => {
    loadAnalytics()
  }, [dateFrom, dateTo])

  const loadAnalytics = async () => {
    try {
      setLoading(true)

      // Build date filter - filter by UREA product
      let consumptionQuery = supabase
        .from('diesel_transactions')
        .select(`
          *,
          diesel_warehouses!inner(name, product_type),
          diesel_products!inner(product_type),
          assets(asset_id, name)
        `)
        .eq('transaction_type', 'consumption')
        .eq('diesel_warehouses.product_type', 'urea')
        .eq('diesel_products.product_type', 'urea')

      let entryQuery = supabase
        .from('diesel_transactions')
        .select(`
          *,
          diesel_products!inner(product_type)
        `)
        .eq('transaction_type', 'entry')
        .eq('diesel_products.product_type', 'urea')

      if (dateFrom) {
        consumptionQuery = consumptionQuery.gte('transaction_date', dateFrom)
        entryQuery = entryQuery.gte('transaction_date', dateFrom)
      }
      if (dateTo) {
        consumptionQuery = consumptionQuery.lte('transaction_date', dateTo + 'T23:59:59')
        entryQuery = entryQuery.lte('transaction_date', dateTo + 'T23:59:59')
      }

      // Get consumptions
      const { data: consumptions, error: consumptionsError } = await consumptionQuery

      // Get entries
      const { data: entries, error: entriesError } = await entryQuery

      if (consumptionsError || entriesError) {
        console.error('Error loading analytics:', consumptionsError || entriesError)
        toast({
          title: "Error",
          description: "No se pudieron cargar los datos de analíticas",
          variant: "destructive"
        })
        return
      }

      // Calculate asset consumption stats with monthly breakdown
      const assetMap = new Map<string, any>()
      
      for (const c of (consumptions || [])) {
        const key = c.asset_id || 'external'
        const transactionDate = new Date(c.transaction_date)
        const monthKey = `${transactionDate.getFullYear()}-${String(transactionDate.getMonth() + 1).padStart(2, '0')}`
        
        const existing = assetMap.get(key) || {
          asset_id: c.asset_id,
          asset_name: c.asset_id ? 'Loading...' : 'Equipos Externos',
          total_liters: 0,
          transaction_count: 0,
          last_consumption: c.transaction_date,
          monthly_breakdown: new Map(),
          transactions: []
        }

        existing.total_liters += parseFloat(c.quantity_liters)
        existing.transaction_count += 1
        existing.transactions.push(c)
        
        if (new Date(c.transaction_date) > new Date(existing.last_consumption)) {
          existing.last_consumption = c.transaction_date
        }

        // Monthly breakdown
        const monthlyData = existing.monthly_breakdown.get(monthKey) || {
          month: transactionDate.toLocaleDateString('es-MX', { month: 'long' }),
          year: transactionDate.getFullYear(),
          liters: 0,
          transactions: 0,
          avg_per_transaction: 0,
          hours_progression: null,
          kilometers_progression: null,
          efficiency_per_hour: null,
          efficiency_per_km: null
        }
        
        monthlyData.liters += parseFloat(c.quantity_liters)
        monthlyData.transactions += 1
        monthlyData.avg_per_transaction = monthlyData.liters / monthlyData.transactions
        
        existing.monthly_breakdown.set(monthKey, monthlyData)
        assetMap.set(key, existing)
      }

      // Fetch asset names and readings
      const assetIds = Array.from(assetMap.keys()).filter(id => id !== 'external')
      if (assetIds.length > 0) {
        const { data: assets } = await supabase
          .from('assets')
          .select('id, asset_id, name')
          .in('id', assetIds)

        if (assets) {
          assets.forEach(asset => {
            const stats = assetMap.get(asset.id)
            if (stats) {
              stats.asset_name = `${asset.name} (${asset.asset_id})`
            }
          })
        }

        // Try to fetch checklist readings if columns exist (they may not be in production yet)
        // Gracefully handle if columns don't exist
        try {
          const BATCH_SIZE = 10 // Process 10 assets at a time
          const allChecklistReadings: any[] = []
          
          for (let i = 0; i < assetIds.length; i += BATCH_SIZE) {
            const batch = assetIds.slice(i, i + BATCH_SIZE)
            
            // Apply date filter if provided to reduce data volume
            let checklistQuery = supabase
              .from('completed_checklists')
              .select(`
                asset_id,
                completion_date,
                equipment_hours_reading,
                equipment_kilometers_reading,
                previous_hours,
                previous_kilometers
              `)
              .in('asset_id', batch)
            
            // Apply date filters to limit dataset size
            if (dateFrom) {
              checklistQuery = checklistQuery.gte('completion_date', dateFrom)
            }
            if (dateTo) {
              checklistQuery = checklistQuery.lte('completion_date', dateTo + 'T23:59:59')
            }
            
            checklistQuery = checklistQuery.order('completion_date', { ascending: true })
            
            const { data: batchReadings, error: checklistError } = await checklistQuery
            
            // If columns don't exist, skip checklist readings gracefully
            if (checklistError) {
              console.warn('Checklist readings columns may not exist yet:', checklistError)
              break
            }
            
            if (batchReadings) {
              allChecklistReadings.push(...batchReadings)
            }
          }

          // Merge checklist readings with transaction data for each asset
          // Filter out null readings in JavaScript (more reliable than PostgREST filtering)
          assetIds.forEach(assetId => {
            const stats = assetMap.get(assetId)
            if (stats) {
              const assetChecklistReadings = allChecklistReadings
                .filter(cr => cr.asset_id === assetId)
                .filter(cr => cr.equipment_hours_reading !== null || cr.equipment_kilometers_reading !== null)
              stats.checklistReadings = assetChecklistReadings
            }
          })
        } catch (error) {
          console.warn('Could not fetch checklist readings, using transaction data only:', error)
          // Continue without checklist data
        }
      }

      // Calculate efficiency metrics for each asset
      const assetStats = Array.from(assetMap.values()).map(asset => {
        const monthlyBreakdown = Array.from(asset.monthly_breakdown.values())
          .sort((a, b) => `${b.year}-${b.month}`.localeCompare(`${a.year}-${a.month}`))

        // Merge hours and kilometers data from both transactions and checklists
        const allReadings: Array<{date: Date, hours: number | null, km: number | null, source: string}> = []
        
        // Add transaction readings
        asset.transactions.forEach(t => {
          if (t.horometer_reading || t.kilometer_reading) {
            allReadings.push({
              date: new Date(t.transaction_date),
              hours: t.horometer_reading,
              km: t.kilometer_reading,
              source: 'transaction'
            })
          }
          // Also add previous readings if this is the first transaction
          if (t.previous_horometer || t.previous_kilometer) {
            const prevDate = new Date(t.transaction_date)
            prevDate.setHours(prevDate.getHours() - 1) // Slightly earlier
            allReadings.push({
              date: prevDate,
              hours: t.previous_horometer,
              km: t.previous_kilometer,
              source: 'transaction_previous'
            })
          }
        })
        
        // Add checklist readings
        if (asset.checklistReadings) {
          asset.checklistReadings.forEach(cr => {
            if (cr.equipment_hours_reading || cr.equipment_kilometers_reading) {
              allReadings.push({
                date: new Date(cr.completion_date),
                hours: cr.equipment_hours_reading,
                km: cr.equipment_kilometers_reading,
                source: 'checklist'
              })
            }
          })
        }
        
        // Sort all readings by date
        allReadings.sort((a, b) => a.date.getTime() - b.date.getTime())
        
        // Calculate hours and kilometers progression from merged data
        let hoursProgression = null
        let kilometersProgression = null
        let efficiencyPerHour = null
        let efficiencyPerKm = null

        if (allReadings.length > 1) {
          // Get oldest and newest readings with hours data
          const readingsWithHours = allReadings.filter(r => r.hours !== null && r.hours !== undefined)
          if (readingsWithHours.length > 1) {
            const oldestHours = readingsWithHours[0].hours!
            const newestHours = readingsWithHours[readingsWithHours.length - 1].hours!
            hoursProgression = newestHours - oldestHours
            if (hoursProgression > 0) {
              efficiencyPerHour = asset.total_liters / hoursProgression
            }
          }
          
          // Get oldest and newest readings with km data
          const readingsWithKm = allReadings.filter(r => r.km !== null && r.km !== undefined)
          if (readingsWithKm.length > 1) {
            const oldestKm = readingsWithKm[0].km!
            const newestKm = readingsWithKm[readingsWithKm.length - 1].km!
            kilometersProgression = newestKm - oldestKm
            if (kilometersProgression > 0) {
              efficiencyPerKm = asset.total_liters / kilometersProgression
            }
          }
        }

        // Calculate monthly efficiency metrics from merged data (transactions + checklists)
        const monthlyBreakdownWithEfficiency = monthlyBreakdown.map(month => {
          const monthStart = new Date(month.year, new Date(`${month.month} 1, ${month.year}`).getMonth(), 1)
          const monthEnd = new Date(month.year, new Date(`${month.month} 1, ${month.year}`).getMonth() + 1, 0)
          
          let monthHoursProgression = null
          let monthKilometersProgression = null
          let monthEfficiencyPerHour = null
          let monthEfficiencyPerKm = null

          // Get all readings for this specific month (from both sources)
          const monthReadings = allReadings.filter(r => {
            return r.date >= monthStart && r.date <= monthEnd
          })

          if (monthReadings.length > 0) {
            // Get readings with hours data for this month
            const monthReadingsWithHours = monthReadings.filter(r => r.hours !== null && r.hours !== undefined)
            if (monthReadingsWithHours.length > 1) {
              const oldestHours = monthReadingsWithHours[0].hours!
              const newestHours = monthReadingsWithHours[monthReadingsWithHours.length - 1].hours!
              monthHoursProgression = newestHours - oldestHours
              if (monthHoursProgression > 0) {
                monthEfficiencyPerHour = month.liters / monthHoursProgression
              }
            }

            // Get readings with km data for this month
            const monthReadingsWithKm = monthReadings.filter(r => r.km !== null && r.km !== undefined)
            if (monthReadingsWithKm.length > 1) {
              const oldestKm = monthReadingsWithKm[0].km!
              const newestKm = monthReadingsWithKm[monthReadingsWithKm.length - 1].km!
              monthKilometersProgression = newestKm - oldestKm
              if (monthKilometersProgression > 0) {
                monthEfficiencyPerKm = month.liters / monthKilometersProgression
              }
            }
          }

          return {
            ...month,
            hours_progression: monthHoursProgression,
            kilometers_progression: monthKilometersProgression,
            efficiency_per_hour: monthEfficiencyPerHour,
            efficiency_per_km: monthEfficiencyPerKm
          }
        })

        return {
          ...asset,
          avg_per_transaction: asset.total_liters / asset.transaction_count,
          monthly_breakdown: monthlyBreakdownWithEfficiency,
          hours_progression: hoursProgression,
          kilometers_progression: kilometersProgression,
          efficiency_per_hour: efficiencyPerHour,
          efficiency_per_km: efficiencyPerKm
        }
      })

      assetStats.sort((a, b) => b.total_liters - a.total_liters)
      setAssetConsumptions(assetStats)

      // Calculate warehouse stats
      const warehouseMap = new Map<string, any>()

      for (const c of (consumptions || [])) {
        const key = c.warehouse_id
        const existing = warehouseMap.get(key) || {
          warehouse_id: key,
          warehouse_name: 'Loading...',
          total_consumption: 0,
          total_entries: 0
        }

        existing.total_consumption += parseFloat(c.quantity_liters)
        warehouseMap.set(key, existing)
      }

      for (const e of (entries || [])) {
        const key = e.warehouse_id
        const existing = warehouseMap.get(key) || {
          warehouse_id: key,
          warehouse_name: 'Loading...',
          total_consumption: 0,
          total_entries: 0
        }

        existing.total_entries += parseFloat(e.quantity_liters)
        warehouseMap.set(key, existing)
      }

      // Fetch warehouse names
      const warehouseIds = Array.from(warehouseMap.keys())
      if (warehouseIds.length > 0) {
        const { data: warehouses } = await supabase
          .from('diesel_warehouses')
          .select('id, name')
          .eq('product_type', 'urea')
          .in('id', warehouseIds)

        if (warehouses) {
          warehouses.forEach(warehouse => {
            const stats = warehouseMap.get(warehouse.id)
            if (stats) {
              stats.warehouse_name = warehouse.name
            }
          })
        }
      }

      const warehouseStatsArray = Array.from(warehouseMap.values()).map(w => ({
        ...w,
        net_flow: w.total_entries - w.total_consumption
      }))

      warehouseStatsArray.sort((a, b) => b.total_consumption - a.total_consumption)
      setWarehouseStats(warehouseStatsArray)

      // Calculate totals
      const totalCons = consumptions?.reduce((sum, c) => sum + parseFloat(c.quantity_liters), 0) || 0
      const totalEnt = entries?.reduce((sum, e) => sum + parseFloat(e.quantity_liters), 0) || 0
      const uniqueAst = new Set(consumptions?.map(c => c.asset_id).filter(Boolean)).size

      setTotalConsumption(totalCons)
      setTotalEntries(totalEnt)
      setUniqueAssets(uniqueAst)
    } catch (error) {
      console.error('Error loading analytics:', error)
    } finally {
      setLoading(false)
    }
  }

  const handleAssetSelect = async (asset: AssetConsumption) => {
    setSelectedAsset(asset)
    setShowTransactions(true)
    
    // Load detailed transactions for this asset
    try {
      let query = supabase
        .from('diesel_transactions')
        .select(`
          id,
          transaction_date,
          quantity_liters,
          notes,
          horometer_reading,
          kilometer_reading,
          previous_horometer,
          previous_kilometer,
          created_by,
          diesel_warehouses!inner(name, product_type),
          diesel_products!inner(product_type)
        `)
        .eq('transaction_type', 'consumption')
        .eq('diesel_warehouses.product_type', 'urea')
        .eq('diesel_products.product_type', 'urea')
      
      // Handle null asset_id (external assets) differently
      if (asset.asset_id === null || asset.asset_id === 'external') {
        query = query.is('asset_id', null)
      } else {
        query = query.eq('asset_id', asset.asset_id)
      }
      
      query = query.order('transaction_date', { ascending: false })

      if (dateFrom) {
        query = query.gte('transaction_date', dateFrom)
      }
      if (dateTo) {
        query = query.lte('transaction_date', dateTo + 'T23:59:59')
      }

      const { data: transactions, error } = await query

      if (error) {
        console.error('Error loading asset transactions:', error)
        toast({
          title: "Error",
          description: "No se pudieron cargar las transacciones del equipo",
          variant: "destructive"
        })
        return
      }

      const formattedTransactions: TransactionDetail[] = transactions?.map(t => ({
        id: t.id,
        transaction_date: t.transaction_date,
        quantity_liters: t.quantity_liters,
        warehouse_name: t.diesel_warehouses?.name || 'N/A',
        created_by_name: t.created_by || 'N/A', // Just show the user ID, no need to join profiles
        notes: t.notes,
        horometer_reading: t.horometer_reading,
        kilometer_reading: t.kilometer_reading,
        previous_horometer: t.previous_horometer,
        previous_kilometer: t.previous_kilometer
      })) || []

      setAssetTransactions(formattedTransactions)
    } catch (error) {
      console.error('Error loading asset transactions:', error)
    }
  }

  const handleCloseTransactions = () => {
    setShowTransactions(false)
    setSelectedAsset(null)
    setAssetTransactions([])
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    )
  }

  return (
    <div className="container mx-auto py-6 px-4 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold flex items-center gap-2">
            <BarChart3 className="h-8 w-8 text-blue-600" />
            Analíticas de Diesel
          </h1>
          <p className="text-muted-foreground mt-1">
            Consumos por equipo y estadísticas de almacenes
          </p>
        </div>
        <Button variant="outline" asChild>
          <Link href="/urea">
            <ChevronLeft className="h-4 w-4 mr-2" />
            Volver
          </Link>
        </Button>
      </div>

      {/* Filters */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Calendar className="h-5 w-5" />
            Periodo de Análisis
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label>Desde</Label>
              <Input
                type="date"
                value={dateFrom}
                onChange={(e) => setDateFrom(e.target.value)}
                className="h-10"
              />
            </div>
            <div className="space-y-2">
              <Label>Hasta</Label>
              <Input
                type="date"
                value={dateTo}
                onChange={(e) => setDateTo(e.target.value)}
                className="h-10"
              />
            </div>
          </div>
          {(dateFrom || dateTo) && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setDateFrom("")
                setDateTo("")
              }}
              className="mt-2"
            >
              Limpiar filtros
            </Button>
          )}
        </CardContent>
      </Card>

      {/* Summary Cards */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Consumo Total</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-bold text-red-600">
              {totalConsumption.toFixed(1)}L
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Entradas Totales</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-bold text-green-600">
              {totalEntries.toFixed(1)}L
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Equipos Activos</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-bold text-blue-600">
              {uniqueAssets}
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Asset Consumption Table */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Fuel className="h-5 w-5" />
            Análisis por Equipo
          </CardTitle>
          <CardDescription>
            Tabla detallada de consumo por equipo con métricas de eficiencia
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-12">#</TableHead>
                  <TableHead>Equipo</TableHead>
                  <TableHead className="text-right">Total Litros</TableHead>
                  <TableHead className="text-right">Transacciones</TableHead>
                  <TableHead className="text-right">Promedio</TableHead>
                  <TableHead className="text-right">Horas</TableHead>
                  <TableHead className="text-right">Km</TableHead>
                  <TableHead className="text-right">L/Hr</TableHead>
                  <TableHead className="text-right">L/Km</TableHead>
                  <TableHead className="text-right">Último Consumo</TableHead>
                  <TableHead className="w-20">Acciones</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(assetConsumptions || []).map((asset, index) => (
                  <TableRow key={asset.asset_id || 'external'} className="hover:bg-gray-50">
                    <TableCell className="font-bold text-blue-600">
                      #{index + 1}
                    </TableCell>
                    <TableCell>
                      <div>
                        <div className="font-semibold">{asset.asset_name}</div>
                        {asset.asset_id && (
                          <div className="text-xs text-muted-foreground font-mono">
                            {asset.asset_id}
                          </div>
                        )}
                      </div>
                    </TableCell>
                    <TableCell className="text-right font-bold text-red-600">
                      {asset.total_liters.toFixed(1)}L
                    </TableCell>
                    <TableCell className="text-right">
                      {asset.transaction_count}
                    </TableCell>
                    <TableCell className="text-right">
                      {asset.avg_per_transaction.toFixed(1)}L
                    </TableCell>
                    <TableCell className="text-right">
                      {asset.hours_progression ? (
                        <div className="flex items-center justify-end gap-1">
                          <Clock className="h-3 w-3 text-blue-500" />
                          <span>{asset.hours_progression.toFixed(0)}h</span>
                        </div>
                      ) : (
                        <span className="text-muted-foreground">-</span>
                      )}
                    </TableCell>
                    <TableCell className="text-right">
                      {asset.kilometers_progression ? (
                        <div className="flex items-center justify-end gap-1">
                          <MapPin className="h-3 w-3 text-green-500" />
                          <span>{asset.kilometers_progression.toFixed(0)}km</span>
                        </div>
                      ) : (
                        <span className="text-muted-foreground">-</span>
                      )}
                    </TableCell>
                    <TableCell className="text-right">
                      {asset.efficiency_per_hour ? (
                        <Badge variant="outline" className="text-xs">
                          {asset.efficiency_per_hour.toFixed(2)}L/h
                        </Badge>
                      ) : (
                        <span className="text-muted-foreground">-</span>
                      )}
                    </TableCell>
                    <TableCell className="text-right">
                      {asset.efficiency_per_km ? (
                        <Badge variant="outline" className="text-xs">
                          {asset.efficiency_per_km.toFixed(2)}L/km
                        </Badge>
                      ) : (
                        <span className="text-muted-foreground">-</span>
                      )}
                    </TableCell>
                    <TableCell className="text-right text-xs text-muted-foreground">
                      {new Date(asset.last_consumption).toLocaleDateString('es-MX')}
                    </TableCell>
                    <TableCell>
                      <div className="flex gap-1">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => handleAssetSelect(asset)}
                          className="h-8 px-2"
                        >
                          <Eye className="h-3 w-3" />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>

          {assetConsumptions.length === 0 && (
            <div className="text-center py-8 text-muted-foreground">
              No hay datos de consumo para el periodo seleccionado
            </div>
          )}
        </CardContent>
      </Card>

      {/* Warehouse Stats */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <TrendingUp className="h-5 w-5" />
            Estadísticas por Almacén
          </CardTitle>
          <CardDescription>
            Flujo de diesel por almacén (entradas vs consumos)
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="space-y-3">
            {(warehouseStats || []).map((warehouse) => (
              <div
                key={warehouse.warehouse_id}
                className="flex items-center justify-between p-4 rounded-lg border"
              >
                <div className="flex-1">
                  <div className="font-semibold">{warehouse.warehouse_name}</div>
                  <div className="text-sm text-muted-foreground space-x-4">
                    <span className="text-green-600">
                      ↑ {warehouse.total_entries.toFixed(1)}L entradas
                    </span>
                    <span className="text-red-600">
                      ↓ {warehouse.total_consumption.toFixed(1)}L consumos
                    </span>
                  </div>
                </div>

                <div className="text-right">
                  <Badge
                    variant={warehouse.net_flow >= 0 ? "default" : "destructive"}
                    className="text-lg px-3 py-1"
                  >
                    {warehouse.net_flow >= 0 ? '+' : ''}
                    {warehouse.net_flow.toFixed(1)}L
                  </Badge>
                  <div className="text-xs text-muted-foreground mt-1">
                    Flujo neto
                  </div>
                </div>
              </div>
            ))}

            {warehouseStats.length === 0 && (
              <div className="text-center py-8 text-muted-foreground">
                No hay datos de almacenes para el periodo seleccionado
              </div>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Asset Detail Modal */}
      {showTransactions && selectedAsset && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center p-4 z-50">
          <div className="bg-white rounded-lg max-w-6xl w-full max-h-[90vh] overflow-hidden">
            <div className="p-6 border-b">
              <div className="flex items-center justify-between">
                <div>
                  <h2 className="text-2xl font-bold flex items-center gap-2">
                    <Activity className="h-6 w-6 text-blue-600" />
                    {selectedAsset.asset_name}
                  </h2>
                  <p className="text-muted-foreground mt-1">
                    Análisis detallado de consumo y transacciones
                  </p>
                </div>
                <Button variant="ghost" onClick={handleCloseTransactions}>
                  <X className="h-4 w-4" />
                </Button>
              </div>
            </div>

            <div className="p-6 overflow-y-auto max-h-[calc(90vh-120px)]">
              {/* Asset Summary */}
              <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mb-6">
                <Card>
                  <CardContent className="pt-4">
                    <div className="text-2xl font-bold text-red-600">
                      {selectedAsset.total_liters.toFixed(1)}L
                    </div>
                    <p className="text-xs text-muted-foreground">Total Consumido</p>
                  </CardContent>
                </Card>
                <Card>
                  <CardContent className="pt-4">
                    <div className="text-2xl font-bold text-blue-600">
                      {selectedAsset.transaction_count}
                    </div>
                    <p className="text-xs text-muted-foreground">Transacciones</p>
                  </CardContent>
                </Card>
                <Card>
                  <CardContent className="pt-4">
                    <div className="text-2xl font-bold text-green-600">
                      {selectedAsset.efficiency_per_hour ? `${selectedAsset.efficiency_per_hour.toFixed(2)}L/h` : '-'}
                    </div>
                    <p className="text-xs text-muted-foreground">Eficiencia por Hora</p>
                  </CardContent>
                </Card>
                <Card>
                  <CardContent className="pt-4">
                    <div className="text-2xl font-bold text-purple-600">
                      {selectedAsset.efficiency_per_km ? `${selectedAsset.efficiency_per_km.toFixed(2)}L/km` : '-'}
                    </div>
                    <p className="text-xs text-muted-foreground">Eficiencia por Km</p>
                  </CardContent>
                </Card>
              </div>

              {/* Monthly Breakdown */}
              <Card className="mb-6">
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <Calendar className="h-5 w-5" />
                    Desglose Mensual
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="overflow-x-auto">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Mes</TableHead>
                          <TableHead className="text-right">Litros</TableHead>
                          <TableHead className="text-right">Transacciones</TableHead>
                          <TableHead className="text-right">Promedio</TableHead>
                          <TableHead className="text-right">Horas</TableHead>
                          <TableHead className="text-right">Km</TableHead>
                          <TableHead className="text-right">L/Hr</TableHead>
                          <TableHead className="text-right">L/Km</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {(selectedAsset.monthly_breakdown || []).map((month, index) => (
                          <TableRow key={`${month.year}-${month.month}`}>
                            <TableCell className="font-semibold">
                              {month.month} {month.year}
                            </TableCell>
                            <TableCell className="text-right font-bold text-red-600">
                              {month.liters.toFixed(1)}L
                            </TableCell>
                            <TableCell className="text-right">
                              {month.transactions}
                            </TableCell>
                            <TableCell className="text-right">
                              {month.avg_per_transaction.toFixed(1)}L
                            </TableCell>
                            <TableCell className="text-right">
                              {month.hours_progression ? (
                                <div className="flex items-center justify-end gap-1">
                                  <Clock className="h-3 w-3 text-blue-500" />
                                  <span>{month.hours_progression.toFixed(0)}h</span>
                                </div>
                              ) : (
                                <span className="text-muted-foreground">-</span>
                              )}
                            </TableCell>
                            <TableCell className="text-right">
                              {month.kilometers_progression ? (
                                <div className="flex items-center justify-end gap-1">
                                  <MapPin className="h-3 w-3 text-green-500" />
                                  <span>{month.kilometers_progression.toFixed(0)}km</span>
                                </div>
                              ) : (
                                <span className="text-muted-foreground">-</span>
                              )}
                            </TableCell>
                            <TableCell className="text-right">
                              {month.efficiency_per_hour ? (
                                <Badge variant="outline" className="text-xs">
                                  {month.efficiency_per_hour.toFixed(2)}L/h
                                </Badge>
                              ) : (
                                <span className="text-muted-foreground">-</span>
                              )}
                            </TableCell>
                            <TableCell className="text-right">
                              {month.efficiency_per_km ? (
                                <Badge variant="outline" className="text-xs">
                                  {month.efficiency_per_km.toFixed(2)}L/km
                                </Badge>
                              ) : (
                                <span className="text-muted-foreground">-</span>
                              )}
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                </CardContent>
              </Card>

              {/* Transaction Details */}
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <FileText className="h-5 w-5" />
                    Detalle de Transacciones
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="overflow-x-auto">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Fecha</TableHead>
                          <TableHead className="text-right">Litros</TableHead>
                          <TableHead>Almacén</TableHead>
                          <TableHead className="text-right">Horómetro</TableHead>
                          <TableHead className="text-right">Kilómetros</TableHead>
                          <TableHead>Notas</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {(assetTransactions || []).map((transaction) => (
                          <TableRow key={transaction.id}>
                            <TableCell>
                              {new Date(transaction.transaction_date).toLocaleString('es-MX', {
                                year: 'numeric',
                                month: 'short',
                                day: 'numeric',
                                hour: '2-digit',
                                minute: '2-digit'
                              })}
                            </TableCell>
                            <TableCell className="text-right font-bold text-red-600">
                              {transaction.quantity_liters.toFixed(1)}L
                            </TableCell>
                            <TableCell>
                              {transaction.warehouse_name}
                            </TableCell>
                            <TableCell>
                              {transaction.created_by_name}
                            </TableCell>
                            <TableCell className="text-right">
                              {transaction.horometer_reading ? (
                                <div className="flex items-center justify-end gap-1">
                                  <Clock className="h-3 w-3 text-blue-500" />
                                  <span>{transaction.horometer_reading.toFixed(0)}h</span>
                                </div>
                              ) : (
                                <span className="text-muted-foreground">-</span>
                              )}
                            </TableCell>
                            <TableCell className="text-right">
                              {transaction.kilometer_reading ? (
                                <div className="flex items-center justify-end gap-1">
                                  <MapPin className="h-3 w-3 text-green-500" />
                                  <span>{transaction.kilometer_reading.toFixed(0)}km</span>
                                </div>
                              ) : (
                                <span className="text-muted-foreground">-</span>
                              )}
                            </TableCell>
                            <TableCell className="text-xs text-muted-foreground max-w-xs truncate">
                              {transaction.notes || '-'}
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                </CardContent>
              </Card>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

