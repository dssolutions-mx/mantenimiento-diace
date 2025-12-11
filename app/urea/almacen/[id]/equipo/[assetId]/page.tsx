"use client"

import { useState, useEffect } from "react"
import { createBrowserClient } from "@supabase/ssr"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { 
  Fuel, 
  TrendingDown,
  ChevronLeft,
  History,
  Loader2,
  Activity,
  BarChart3,
  Filter,
  X,
  Gauge,
  Calendar
} from "lucide-react"
import { useRouter, useParams } from "next/navigation"
import Link from "next/link"

interface AssetDetails {
  id: string
  asset_id: string
  name: string
  current_hours: number | null
  current_kilometers: number | null
  maintenance_unit: string | null
  model_name: string | null
}

interface Transaction {
  id: string
  transaction_type: string
  quantity_liters: number
  transaction_date: string
  created_by_name: string
  horometer_reading: number | null
  kilometer_reading: number | null
  previous_horometer: number | null
  previous_kilometer: number | null
  cuenta_litros: number | null
  notes: string | null
}

interface ConsumptionStats {
  total_liters: number
  total_consumptions: number
  average_per_consumption: number
  largest_consumption: number
  hours_progression: number | null
  kilometers_progression: number | null
  efficiency_per_hour: number | null
  efficiency_per_km: number | null
}

export default function AssetWarehouseDetailPage() {
  const router = useRouter()
  const params = useParams()
  const warehouseId = params.id as string
  const assetId = params.assetId as string
  const isExternalAsset = assetId.startsWith('external:')

  const [loading, setLoading] = useState(true)
  const [asset, setAsset] = useState<AssetDetails | null>(null)
  const [externalAssetName, setExternalAssetName] = useState<string>("")
  const [transactions, setTransactions] = useState<Transaction[]>([])
  const [filteredTransactions, setFilteredTransactions] = useState<Transaction[]>([])
  const [stats, setStats] = useState<ConsumptionStats | null>(null)
  const [warehouseName, setWarehouseName] = useState<string>("")
  
  // Filters
  const [dateFrom, setDateFrom] = useState<string>("")
  const [dateTo, setDateTo] = useState<string>("")

  const supabase = createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  )

  useEffect(() => {
    loadAssetData()
  }, [warehouseId, assetId])

  useEffect(() => {
    applyFilters()
  }, [transactions, dateFrom, dateTo])

  const loadAssetData = async () => {
    try {
      setLoading(true)

      // Load warehouse info
      const { data: warehouseData } = await supabase
        .from('diesel_warehouses')
        .select('name')
        .eq('id', warehouseId)
        .single()

      if (warehouseData) {
        setWarehouseName(warehouseData.name)
      }

      // Load asset info (if not external)
      if (!isExternalAsset) {
        const { data: assetData, error: assetError } = await supabase
          .from('assets')
          .select(`
            id,
            asset_id,
            name,
            current_hours,
            current_kilometers,
            maintenance_unit,
            models(name)
          `)
          .eq('id', assetId)
          .single()

        if (assetError) {
          console.error('Error loading asset:', assetError?.message || JSON.stringify(assetError))
        } else if (assetData) {
          setAsset({
            id: assetData.id,
            asset_id: assetData.asset_id,
            name: assetData.name,
            current_hours: assetData.current_hours,
            current_kilometers: assetData.current_kilometers,
            maintenance_unit: assetData.maintenance_unit,
            model_name: (assetData.models as any)?.name || null
          })
        }
      } else {
        // External asset - extract name from assetId
        const name = assetId.replace('external:', '')
        setExternalAssetName(name)
      }

      // Load transactions for this asset at this warehouse
      let transactionsQuery = supabase
        .from('diesel_transactions')
        .select(`
          id,
          transaction_type,
          quantity_liters,
          transaction_date,
          created_by,
          horometer_reading,
          kilometer_reading,
          previous_horometer,
          previous_kilometer,
          cuenta_litros,
          notes
        `)
        .eq('warehouse_id', warehouseId)
        .eq('transaction_type', 'consumption')
        .order('transaction_date', { ascending: false })

      if (isExternalAsset) {
        transactionsQuery = transactionsQuery.eq('exception_asset_name', assetId.replace('external:', ''))
      } else {
        transactionsQuery = transactionsQuery.eq('asset_id', assetId)
      }

      const { data: transactionsData, error: transactionsError } = await transactionsQuery

      if (transactionsError) {
        console.error('Error loading transactions:', transactionsError?.message || JSON.stringify(transactionsError))
      } else {
        // Get unique user IDs
        const userIds = [...new Set(transactionsData?.map((t: any) => t.created_by).filter(Boolean))] as string[]
        
        // Fetch user profiles
        let userProfiles: Record<string, string> = {}
        if (userIds.length > 0) {
          const { data: profilesData, error: profilesError } = await supabase
            .from('profiles')
            .select('id, nombre, apellido')
            .in('id', userIds)
          
          if (profilesError) {
            console.error('Error loading profiles:', profilesError)
          }
          
          if (profilesData) {
            profilesData.forEach((p: any) => {
              userProfiles[p.id] = `${p.nombre || ''} ${p.apellido || ''}`.trim() || 'Usuario'
            })
          }
        }

        const formatted: Transaction[] = transactionsData?.map((t: any) => ({
          id: t.id,
          transaction_type: t.transaction_type,
          quantity_liters: t.quantity_liters,
          transaction_date: t.transaction_date,
          created_by_name: userProfiles[t.created_by] || 'Usuario',
          horometer_reading: t.horometer_reading,
          kilometer_reading: t.kilometer_reading,
          previous_horometer: t.previous_horometer,
          previous_kilometer: t.previous_kilometer,
          cuenta_litros: t.cuenta_litros,
          notes: t.notes
        })) || []

        setTransactions(formatted)

        // Calculate statistics
        if (formatted.length > 0) {
          const totalLiters = formatted.reduce((sum, t) => sum + t.quantity_liters, 0)
          const totalConsumptions = formatted.length
          const averagePerConsumption = totalLiters / totalConsumptions
          const largestConsumption = Math.max(...formatted.map(t => t.quantity_liters))

          // Calculate progression for formal assets
          let hoursProgression = null
          let kilometersProgression = null
          let efficiencyPerHour = null
          let efficiencyPerKm = null

          if (!isExternalAsset && formatted.length > 1) {
            const sortedByDate = [...formatted].sort((a, b) => 
              new Date(a.transaction_date).getTime() - new Date(b.transaction_date).getTime()
            )

            const oldest = sortedByDate[0]
            const newest = sortedByDate[sortedByDate.length - 1]

            if (oldest.previous_horometer && newest.horometer_reading) {
              hoursProgression = newest.horometer_reading - oldest.previous_horometer
              if (hoursProgression > 0) {
                efficiencyPerHour = totalLiters / hoursProgression
              }
            }

            if (oldest.previous_kilometer && newest.kilometer_reading) {
              kilometersProgression = newest.kilometer_reading - oldest.previous_kilometer
              if (kilometersProgression > 0) {
                efficiencyPerKm = totalLiters / kilometersProgression
              }
            }
          }

          setStats({
            total_liters: totalLiters,
            total_consumptions: totalConsumptions,
            average_per_consumption: averagePerConsumption,
            largest_consumption: largestConsumption,
            hours_progression: hoursProgression,
            kilometers_progression: kilometersProgression,
            efficiency_per_hour: efficiencyPerHour,
            efficiency_per_km: efficiencyPerKm
          })
        }
      }
    } catch (error) {
      console.error('Error loading asset data:', error)
    } finally {
      setLoading(false)
    }
  }

  const applyFilters = () => {
    let filtered = [...transactions]

    if (dateFrom) {
      filtered = filtered.filter(t => new Date(t.transaction_date) >= new Date(dateFrom))
    }

    if (dateTo) {
      filtered = filtered.filter(t => new Date(t.transaction_date) <= new Date(dateTo + 'T23:59:59'))
    }

    setFilteredTransactions(filtered)
  }

  const clearFilters = () => {
    setDateFrom("")
    setDateTo("")
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="text-center space-y-4">
          <Loader2 className="h-12 w-12 animate-spin mx-auto text-primary" />
          <p className="text-muted-foreground">Cargando datos del equipo...</p>
        </div>
      </div>
    )
  }

  const displayName = isExternalAsset ? externalAssetName : asset?.name || 'Equipo'
  const displayAssetId = isExternalAsset ? assetId.replace('external:', '') : asset?.asset_id || ''

  return (
    <div className="container mx-auto py-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="space-y-1">
          <div className="flex items-center gap-3">
            <h1 className="text-3xl font-bold">{displayName}</h1>
            {isExternalAsset ? (
              <Badge variant="outline" className="bg-orange-50">Equipo Externo</Badge>
            ) : (
              <Badge variant="outline" className="font-mono">{displayAssetId}</Badge>
            )}
          </div>
          <p className="text-muted-foreground">
            Consumos en: {warehouseName}
            {asset?.model_name && <span className="ml-2">• {asset.model_name}</span>}
          </p>
        </div>
        <Button variant="outline" asChild>
          <Link href={`/diesel/almacen/${warehouseId}`}>
            <ChevronLeft className="h-4 w-4 mr-2" />
            Volver al Almacén
          </Link>
        </Button>
      </div>

      {/* Statistics Cards */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Total Consumido</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-red-600">
              {stats?.total_liters.toFixed(1) || 0}L
            </div>
            <p className="text-xs text-muted-foreground mt-1">
              En este almacén
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Consumos Registrados</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">
              {stats?.total_consumptions || 0}
            </div>
            <p className="text-xs text-muted-foreground mt-1">
              Transacciones
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Promedio por Consumo</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-blue-600">
              {stats?.average_per_consumption.toFixed(1) || 0}L
            </div>
            <p className="text-xs text-muted-foreground mt-1">
              Por transacción
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Mayor Consumo</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-orange-600">
              {stats?.largest_consumption.toFixed(1) || 0}L
            </div>
            <p className="text-xs text-muted-foreground mt-1">
              Máximo registrado
            </p>
          </CardContent>
        </Card>
      </div>

      {/* Current Readings & Efficiency (Only for formal assets) */}
      {!isExternalAsset && asset && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Gauge className="h-5 w-5" />
                Lecturas Actuales
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-1">
                  <p className="text-sm text-muted-foreground">Horómetro</p>
                  <p className="text-2xl font-bold">
                    {asset.current_hours?.toLocaleString() || 0}
                  </p>
                  <p className="text-xs text-muted-foreground">horas</p>
                  {stats?.hours_progression && (
                    <p className="text-xs text-blue-600 mt-2">
                      +{stats.hours_progression.toFixed(0)} hrs en período
                    </p>
                  )}
                </div>
                
                <div className="space-y-1">
                  <p className="text-sm text-muted-foreground">Odómetro</p>
                  <p className="text-2xl font-bold">
                    {asset.current_kilometers?.toLocaleString() || 0}
                  </p>
                  <p className="text-xs text-muted-foreground">kilómetros</p>
                  {stats?.kilometers_progression && (
                    <p className="text-xs text-blue-600 mt-2">
                      +{stats.kilometers_progression.toFixed(0)} km en período
                    </p>
                  )}
                </div>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <BarChart3 className="h-5 w-5" />
                Eficiencia de Consumo
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="space-y-4">
                {stats?.efficiency_per_hour && (
                  <div>
                    <p className="text-sm text-muted-foreground">Por Hora de Uso</p>
                    <p className="text-2xl font-bold text-green-600">
                      {stats.efficiency_per_hour.toFixed(2)} L/hr
                    </p>
                    <p className="text-xs text-muted-foreground mt-1">
                      Basado en {stats.hours_progression?.toFixed(0)} horas trabajadas
                    </p>
                  </div>
                )}
                
                {stats?.efficiency_per_km && (
                  <div>
                    <p className="text-sm text-muted-foreground">Por Kilómetro</p>
                    <p className="text-2xl font-bold text-purple-600">
                      {stats.efficiency_per_km.toFixed(2)} L/km
                    </p>
                    <p className="text-xs text-muted-foreground mt-1">
                      Basado en {stats.kilometers_progression?.toFixed(0)} km recorridos
                    </p>
                  </div>
                )}

                {!stats?.efficiency_per_hour && !stats?.efficiency_per_km && (
                  <p className="text-sm text-muted-foreground">
                    Se necesitan al menos 2 consumos con lecturas para calcular eficiencia
                  </p>
                )}
              </div>
            </CardContent>
          </Card>
        </div>
      )}

      {/* Transaction History */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="flex items-center gap-2">
                <History className="h-5 w-5" />
                Historial de Consumos
              </CardTitle>
              <CardDescription>
                {filteredTransactions.length} de {transactions.length} consumos
              </CardDescription>
            </div>
          </div>
        </CardHeader>

        {/* Filters */}
        <CardContent className="border-b pb-4">
          <div className="flex items-center gap-2 mb-3">
            <Filter className="h-4 w-4 text-muted-foreground" />
            <span className="text-sm font-medium">Filtros por Fecha</span>
            {(dateFrom || dateTo) && (
              <Button variant="ghost" size="sm" onClick={clearFilters}>
                <X className="h-3 w-3 mr-1" />
                Limpiar
              </Button>
            )}
          </div>
          
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div className="space-y-2">
              <Label className="text-xs">Desde</Label>
              <Input
                type="date"
                value={dateFrom}
                onChange={(e) => setDateFrom(e.target.value)}
                className="h-9 text-sm"
              />
            </div>
            
            <div className="space-y-2">
              <Label className="text-xs">Hasta</Label>
              <Input
                type="date"
                value={dateTo}
                onChange={(e) => setDateTo(e.target.value)}
                className="h-9 text-sm"
              />
            </div>
          </div>
        </CardContent>

        <CardContent className="pt-4">
          <div className="space-y-2">
            {filteredTransactions.map((transaction) => (
              <div
                key={transaction.id}
                className="flex items-start justify-between p-4 rounded-lg border hover:bg-gray-50 transition-colors"
              >
                <div className="flex items-start gap-4 flex-1">
                  <TrendingDown className="h-4 w-4 text-red-600 mt-1" />
                  
                  <div className="flex-1 space-y-2">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-semibold text-lg">
                        {transaction.quantity_liters.toFixed(1)}L
                      </span>
                      <Badge variant="outline" className="text-xs">
                        <Calendar className="h-3 w-3 mr-1" />
                        {new Date(transaction.transaction_date).toLocaleString('es-MX', {
                          month: 'short',
                          day: 'numeric',
                          year: 'numeric',
                          hour: '2-digit',
                          minute: '2-digit'
                        })}
                      </Badge>
                    </div>

                    {/* Readings */}
                    {!isExternalAsset && (transaction.horometer_reading || transaction.kilometer_reading) && (
                      <div className="grid grid-cols-2 gap-4 text-sm">
                        {transaction.horometer_reading && (
                          <div>
                            <span className="text-muted-foreground">Horómetro: </span>
                            <span className="font-semibold">
                              {transaction.horometer_reading.toLocaleString()} hrs
                            </span>
                            {transaction.previous_horometer && (
                              <span className="text-xs text-blue-600 ml-2">
                                (+{(transaction.horometer_reading - transaction.previous_horometer).toFixed(0)})
                              </span>
                            )}
                          </div>
                        )}
                        
                        {transaction.kilometer_reading && (
                          <div>
                            <span className="text-muted-foreground">Odómetro: </span>
                            <span className="font-semibold">
                              {transaction.kilometer_reading.toLocaleString()} km
                            </span>
                            {transaction.previous_kilometer && (
                              <span className="text-xs text-blue-600 ml-2">
                                (+{(transaction.kilometer_reading - transaction.previous_kilometer).toFixed(0)})
                              </span>
                            )}
                          </div>
                        )}
                      </div>
                    )}

                    {/* Cuenta Litros */}
                    {transaction.cuenta_litros && (
                      <div className="text-sm">
                        <span className="text-muted-foreground">Cuenta Litros: </span>
                        <span className="font-semibold">{transaction.cuenta_litros.toFixed(1)}L</span>
                      </div>
                    )}

                    {/* Notes and User */}
                    <div className="flex items-center gap-2 text-xs text-muted-foreground">
                      <span>Por: {transaction.created_by_name}</span>
                      {transaction.notes && (
                        <>
                          <span>•</span>
                          <span className="italic">{transaction.notes}</span>
                        </>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            ))}

            {filteredTransactions.length === 0 && transactions.length > 0 && (
              <div className="text-center py-8 text-muted-foreground">
                No hay consumos que coincidan con los filtros
              </div>
            )}
            
            {transactions.length === 0 && (
              <div className="text-center py-8 text-muted-foreground">
                No hay consumos registrados para este equipo en este almacén
              </div>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  )
}

