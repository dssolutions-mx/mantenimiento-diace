"use client"

import { useState, useEffect } from "react"
import { createBrowserClient } from "@supabase/ssr"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Separator } from "@/components/ui/separator"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { 
  Fuel, 
  TruckIcon, 
  TrendingDown,
  TrendingUp,
  AlertTriangle,
  Plus,
  Minus,
  History,
  BarChart3,
  Loader2,
  Info
} from "lucide-react"
import { useRouter } from "next/navigation"
import Link from "next/link"
import { DieselOfflineStatus } from "@/components/diesel-inventory/diesel-offline-status"
import { CreateDieselWarehouseDialog } from "@/components/diesel/dialogs/create-warehouse-dialog"

interface WarehouseSummary {
  id: string
  name: string
  warehouse_code: string
  current_inventory: number
  capacity_liters: number
  has_cuenta_litros: boolean
  current_cuenta_litros: number | null
  last_updated: string
  plant_name: string
}

interface RecentTransaction {
  id: string
  transaction_type: string
  quantity_liters: number
  asset_id: string | null
  exception_asset_name: string | null
  asset_name: string | null
  transaction_date: string
  created_by_name: string
  warehouse_name: string
}

export default function UreaDashboardPage() {
  const router = useRouter()
  const [loading, setLoading] = useState(true)
  const [warehouses, setWarehouses] = useState<WarehouseSummary[]>([])
  const [recentTransactions, setRecentTransactions] = useState<RecentTransaction[]>([])
  const [totalInventory, setTotalInventory] = useState(0)
  const [userProfile, setUserProfile] = useState<any>(null)
  const [createDialogOpen, setCreateDialogOpen] = useState(false)

  const supabase = createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  )

  useEffect(() => {
    loadDashboardData()
  }, [])

  const loadDashboardData = async () => {
    try {
      setLoading(true)

      // Get user profile for business unit filtering
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) return

      const { data: profile } = await supabase
        .from('profiles')
        .select('plant_id, business_unit_id, role')
        .eq('id', user.id)
        .single()

      setUserProfile(profile)

      // Load warehouses with filtering - ONLY UREA warehouses
      let warehouseQuery = supabase
        .from('diesel_warehouses')
        .select(`
          id,
          name,
          warehouse_code,
          current_inventory,
          capacity_liters,
          has_cuenta_litros,
          current_cuenta_litros,
          last_updated,
          plant_id,
          plants!inner(name, business_unit_id)
        `)
        .eq('product_type', 'urea')
        .order('name')

      // Apply business unit filtering if user has one
      if (profile?.business_unit_id) {
        warehouseQuery = warehouseQuery.eq('plants.business_unit_id', profile.business_unit_id)
      }

      const { data: warehousesData, error: warehousesError } = await warehouseQuery

      if (warehousesError) {
        console.error('Error loading warehouses:', warehousesError)
      } else {
        const formattedWarehouses = warehousesData?.map((w: any) => ({
          ...w,
          plant_name: w.plants?.name || 'N/A'
        })) || []
        
        setWarehouses(formattedWarehouses)
        
        const total = formattedWarehouses.reduce((sum, w) => sum + (w.current_inventory || 0), 0)
        setTotalInventory(total)
      }

      // Load recent transactions - ONLY UREA product transactions
      let transactionsQuery = supabase
        .from('diesel_transactions')
        .select(`
          id,
          transaction_type,
          quantity_liters,
          exception_asset_name,
          transaction_date,
          created_by,
          product_id,
          diesel_warehouses!inner(id, name, plant_id, product_type),
          assets!left(asset_id, name),
          diesel_products!inner(product_type)
        `)
        .eq('diesel_products.product_type', 'urea')
        .eq('diesel_warehouses.product_type', 'urea')
        .order('transaction_date', { ascending: false })
        .limit(10)

      // Apply business unit filtering if user has one
      if (profile?.plant_id) {
        transactionsQuery = transactionsQuery.eq('diesel_warehouses.plant_id', profile.plant_id)
      }

      const { data: transactionsData, error: transactionsError } = await transactionsQuery

      if (transactionsError) {
        console.error('Error loading transactions:', transactionsError)
      } else {
        // Get unique user IDs to fetch names
        const userIds = [...new Set(transactionsData?.map((t: any) => t.created_by).filter(Boolean))]
        
        // Fetch user profiles
        let userProfiles: Record<string, string> = {}
        if (userIds.length > 0) {
          const { data: profilesData } = await supabase
            .from('profiles')
            .select('id, nombre, apellido')
            .in('id', userIds)
          
          if (profilesData) {
            profilesData.forEach((p: any) => {
              userProfiles[p.id] = `${p.nombre || ''} ${p.apellido || ''}`.trim() || 'Usuario'
            })
          }
        }
        
        const formattedTransactions = transactionsData?.map((t: any) => ({
          id: t.id,
          transaction_type: t.transaction_type,
          quantity_liters: t.quantity_liters,
          asset_id: t.assets?.asset_id || null,
          exception_asset_name: t.exception_asset_name || null,
          asset_name: t.assets?.name || null,
          transaction_date: t.transaction_date,
          created_by_name: userProfiles[t.created_by] || 'Usuario',
          warehouse_name: t.diesel_warehouses?.name || 'N/A'
        })) || []
        
        setRecentTransactions(formattedTransactions)
      }
    } catch (error) {
      console.error('Error loading dashboard data:', error)
    } finally {
      setLoading(false)
    }
  }

  const getTransactionIcon = (type: string) => {
    if (type === 'consumption') return <TrendingDown className="h-4 w-4 text-red-600" />
    if (type === 'entry') return <TruckIcon className="h-4 w-4 text-green-600" />
    if (type === 'adjustment_positive') return <TrendingUp className="h-4 w-4 text-blue-600" />
    if (type === 'adjustment_negative') return <TrendingDown className="h-4 w-4 text-orange-600" />
    return <History className="h-4 w-4 text-gray-600" />
  }

  const getTransactionLabel = (type: string) => {
    if (type === 'consumption') return 'Consumo'
    if (type === 'entry') return 'Entrada'
    if (type === 'adjustment_positive') return 'Ajuste +'
    if (type === 'adjustment_negative') return 'Ajuste -'
    return type
  }

  const getCapacityPercentage = (current: number, capacity: number) => {
    return (current / capacity) * 100
  }

  const getCapacityColor = (percentage: number) => {
    if (percentage < 20) return 'bg-red-500'
    if (percentage < 50) return 'bg-orange-500'
    return 'bg-green-500'
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
      <div>
        <h1 className="text-3xl font-bold flex items-center gap-2">
          <Fuel className="h-8 w-8 text-purple-600" />
          Gestión de UREA
        </h1>
        <p className="text-muted-foreground mt-1">
          Control de inventario, consumos y movimientos de UREA
        </p>
      </div>

      {/* Offline Status */}
      <DieselOfflineStatus />

      {/* Quick Actions */}
      <div>
        <h2 className="text-lg font-semibold mb-3">Acciones Rápidas</h2>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <Button
            onClick={() => router.push('/urea/consumo')}
            className="h-20 text-lg"
            variant="default"
          >
            <TrendingDown className="h-6 w-6 mr-2" />
            Registrar Consumo
          </Button>
          
          <Button
            onClick={() => router.push('/urea/entrada')}
            className="h-20 text-lg"
            variant="outline"
          >
            <TruckIcon className="h-6 w-6 mr-2" />
            Registrar Entrada
          </Button>
          
          <Button
            onClick={() => router.push('/urea/ajuste')}
            className="h-20 text-lg"
            variant="outline"
          >
            <AlertTriangle className="h-6 w-6 mr-2" />
            Ajuste de Inventario
          </Button>
        </div>
      </div>

      {/* Analytics & Reports */}
      <div>
        <h2 className="text-lg font-semibold mb-3">Reportes y Analíticas</h2>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <Button
            onClick={() => router.push('/urea/historial')}
            className="h-16"
            variant="outline"
          >
            <History className="h-5 w-5 mr-2" />
            Historial de Transacciones
          </Button>
          
          <Button
            onClick={() => router.push('/urea/analytics')}
            className="h-16"
            variant="outline"
          >
            <BarChart3 className="h-5 w-5 mr-2" />
            Analíticas y Consumo por Equipo
          </Button>
        </div>
      </div>

      {/* Total Inventory Card */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <BarChart3 className="h-5 w-5 text-purple-600" />
            Inventario Total
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="text-4xl font-bold text-purple-600">
            {totalInventory.toFixed(1)} <span className="text-2xl text-muted-foreground">litros</span>
          </div>
          <p className="text-sm text-muted-foreground mt-2">
            Distribuidos en {warehouses.length} almacén(es)
          </p>
        </CardContent>
      </Card>

      {/* Warehouses Grid */}
      <div>
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-2xl font-semibold flex items-center gap-2">
            <Fuel className="h-6 w-6" />
            Almacenes
          </h2>
          <Button onClick={() => setCreateDialogOpen(true)}>
            <Plus className="h-4 w-4 mr-2" />
            Nuevo Almacén
          </Button>
        </div>
        
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {warehouses.map((warehouse) => {
            const percentage = getCapacityPercentage(warehouse.current_inventory, warehouse.capacity_liters)
            
            return (
              <Link key={warehouse.id} href={`/urea/almacen/${warehouse.id}`}>
                <Card className="hover:shadow-lg transition-shadow cursor-pointer">
                  <CardHeader className="pb-3">
                    <div className="flex items-start justify-between">
                      <div>
                        <CardTitle className="text-lg">{warehouse.name}</CardTitle>
                        <CardDescription className="text-xs">{warehouse.plant_name}</CardDescription>
                      </div>
                      <Badge variant="outline" className="text-xs">
                        {warehouse.warehouse_code}
                      </Badge>
                    </div>
                  </CardHeader>
                <CardContent className="space-y-3">
                  {/* Current Inventory */}
                  <div>
                    <div className="flex items-baseline justify-between mb-2">
                      <span className="text-2xl font-bold">
                        {warehouse.current_inventory.toFixed(1)}L
                      </span>
                      <span className="text-sm text-muted-foreground">
                        de {warehouse.capacity_liters.toFixed(0)}L
                      </span>
                    </div>
                    
                    {/* Progress bar */}
                    <div className="w-full bg-gray-200 rounded-full h-2">
                      <div
                        className={`h-2 rounded-full transition-all ${getCapacityColor(percentage)}`}
                        style={{ width: `${Math.min(percentage, 100)}%` }}
                      />
                    </div>
                    
                    <p className="text-xs text-muted-foreground mt-1">
                      {percentage.toFixed(1)}% de capacidad
                    </p>
                  </div>

                  {/* Cuenta Litros */}
                  {warehouse.has_cuenta_litros && (
                    <div className="pt-2 border-t">
                      <div className="flex items-center justify-between text-sm">
                        <span className="text-muted-foreground">Cuenta Litros:</span>
                        <span className="font-semibold">
                          {warehouse.current_cuenta_litros?.toFixed(0) || 'N/A'}
                        </span>
                      </div>
                    </div>
                  )}

                  {/* Last Updated */}
                  <div className="text-xs text-muted-foreground">
                    Actualizado: {new Date(warehouse.last_updated).toLocaleString('es-MX', {
                      month: 'short',
                      day: 'numeric',
                      hour: '2-digit',
                      minute: '2-digit'
                    })}
                  </div>
                </CardContent>
              </Card>
              </Link>
            )
          })}
        </div>
      </div>

      {/* Recent Transactions */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="flex items-center gap-2">
                <History className="h-5 w-5" />
                Transacciones Recientes
              </CardTitle>
              <CardDescription>Últimos 10 movimientos de UREA</CardDescription>
            </div>
            <Button variant="outline" size="sm" asChild>
              <Link href="/urea/historial">
                Ver todo
              </Link>
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          {recentTransactions.length === 0 ? (
            <Alert>
              <Info className="h-4 w-4" />
              <AlertDescription>
                No hay transacciones registradas todavía.
              </AlertDescription>
            </Alert>
          ) : (
            <div className="space-y-3">
              {recentTransactions.map((transaction) => (
                <div
                  key={transaction.id}
                  className="flex items-center justify-between p-3 rounded-lg border hover:bg-gray-50 transition-colors"
                >
                  <div className="flex items-center gap-3">
                    {getTransactionIcon(transaction.transaction_type)}
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="font-semibold">
                          {getTransactionLabel(transaction.transaction_type)}
                        </span>
                        <Badge variant="outline" className="text-xs">
                          {transaction.quantity_liters.toFixed(1)}L
                        </Badge>
                      </div>
                      <div className="text-xs text-muted-foreground">
                        {transaction.warehouse_name}
                        {transaction.asset_id && (
                          <span>
                            {' • '}
                            <span className="font-mono">{transaction.asset_id}</span>
                          </span>
                        )}
                        {transaction.exception_asset_name && (
                          <span>
                            {' • '}
                            <span className="italic">Externo: {transaction.exception_asset_name}</span>
                          </span>
                        )}
                      </div>
                    </div>
                  </div>
                  <div className="text-right">
                    <div className="text-xs text-muted-foreground">
                      {transaction.created_by_name}
                    </div>
                    <div className="text-xs text-muted-foreground">
                      {new Date(transaction.transaction_date).toLocaleString('es-MX', {
                        month: 'short',
                        day: 'numeric',
                        hour: '2-digit',
                        minute: '2-digit'
                      })}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <CreateDieselWarehouseDialog
        open={createDialogOpen}
        onOpenChange={setCreateDialogOpen}
        onCreated={() => {
          loadDashboardData()
        }}
        defaultProductType="urea"
      />
    </div>
  )
}

