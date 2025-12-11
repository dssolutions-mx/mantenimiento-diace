"use client"

import { useState, useEffect, useMemo } from "react"
import { createBrowserClient } from "@supabase/ssr"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Separator } from "@/components/ui/separator"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { useToast } from "@/components/ui/use-toast"
import { 
  Fuel, 
  TruckIcon, 
  TrendingDown,
  TrendingUp,
  AlertTriangle,
  ChevronLeft,
  History,
  Loader2,
  Calendar,
  BarChart3,
  Activity,
  Filter,
  X,
  Edit,
  DollarSign,
  CheckCircle2
} from "lucide-react"
import { useRouter, useParams } from "next/navigation"
import Link from "next/link"
import { TransactionEditModal } from "@/components/diesel-inventory/transaction-edit-modal"
import { TransactionEvidenceModal } from "@/components/diesel-inventory/transaction-evidence-modal"

interface WarehouseDetails {
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

interface Transaction {
  id: string
  transaction_id: string
  transaction_type: string
  quantity_liters: number
  transaction_date: string
  created_at?: string
  updated_at?: string
  asset_name: string | null
  asset_id: string | null
  exception_asset_name: string | null
  created_by_name: string
  previous_balance: number | null
  current_balance: number | null
  notes: string | null
  cuenta_litros: number | null
  product_id?: string | null
  product_code?: string | null
  unit_cost?: number | null
  total_cost?: number | null
  supplier_responsible?: string | null
  requires_validation?: boolean
}

interface WarehouseStats {
  total_entries: number
  total_consumptions: number
  total_adjustments_positive: number
  total_adjustments_negative: number
  total_transactions: number
  entry_liters: number
  consumption_liters: number
  adjustment_positive_liters: number
  adjustment_negative_liters: number
  average_consumption: number
  largest_entry: number
  largest_consumption: number
}

export default function WarehouseDetailPage() {
  const router = useRouter()
  const params = useParams()
  const warehouseId = params.id as string
  const { toast } = useToast()

  const [loading, setLoading] = useState(true)
  const [warehouse, setWarehouse] = useState<WarehouseDetails | null>(null)
  const [transactions, setTransactions] = useState<Transaction[]>([])
  const [filteredTransactions, setFilteredTransactions] = useState<Transaction[]>([])
  const [stats, setStats] = useState<WarehouseStats | null>(null)
  const [balanceHistory, setBalanceHistory] = useState<Array<{date: string, balance: number}>>([])
  const [assetConsumption, setAssetConsumption] = useState<Array<{asset_id: string, asset_name: string, total_liters: number, count: number}>>([])
  
  // Edit modal state
  const [editingTransaction, setEditingTransaction] = useState<Transaction | null>(null)
  const [isEditModalOpen, setIsEditModalOpen] = useState(false)
  
  // Evidence modal state
  const [evidenceTransaction, setEvidenceTransaction] = useState<Transaction | null>(null)
  const [isEvidenceModalOpen, setIsEvidenceModalOpen] = useState(false)
  
  // Filters
  const [typeFilter, setTypeFilter] = useState<string>("all")
  const [dateFrom, setDateFrom] = useState<string>("")
  const [dateTo, setDateTo] = useState<string>("")
  const [validationOnly, setValidationOnly] = useState<boolean>(false)
  
  // Pagination
  const [currentPage, setCurrentPage] = useState(1)
  const [itemsPerPage] = useState(50)
  const totalPages = Math.ceil(filteredTransactions.length / itemsPerPage)
  const paginatedTransactions = filteredTransactions.slice(
    (currentPage - 1) * itemsPerPage,
    currentPage * itemsPerPage
  )

  // Precompute max balance for chart scaling (avoid division by zero)
  const maxBalanceForChart = balanceHistory.reduce((max, p) => Math.max(max, p.balance), 0) || 1

  const supabase = createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  )

  useEffect(() => {
    loadWarehouseData()
  }, [warehouseId])

  useEffect(() => {
    applyFilters()
  }, [transactions, typeFilter, dateFrom, dateTo, validationOnly])

  // Calculate stats from filtered transactions
  const filteredStats = useMemo(() => {
    if (filteredTransactions.length === 0 && transactions.length > 0) {
      // Return empty stats if all transactions are filtered out
      return {
        total_entries: 0,
        total_consumptions: 0,
        total_adjustments_positive: 0,
        total_adjustments_negative: 0,
        total_transactions: 0,
        entry_liters: 0,
        consumption_liters: 0,
        adjustment_positive_liters: 0,
        adjustment_negative_liters: 0,
        average_consumption: 0,
        largest_entry: 0,
        largest_consumption: 0
      }
    }

    const calculatedStats: WarehouseStats = {
      total_entries: 0,
      total_consumptions: 0,
      total_adjustments_positive: 0,
      total_adjustments_negative: 0,
      total_transactions: filteredTransactions.length,
      entry_liters: 0,
      consumption_liters: 0,
      adjustment_positive_liters: 0,
      adjustment_negative_liters: 0,
      average_consumption: 0,
      largest_entry: 0,
      largest_consumption: 0
    }

    filteredTransactions.forEach(t => {
      if (t.transaction_type === 'entry') {
        // Check if it's a positive adjustment by looking for adjustment metadata
        if (t.notes && t.notes.includes('[AJUSTE +]')) {
          calculatedStats.total_adjustments_positive++
          calculatedStats.adjustment_positive_liters += t.quantity_liters
        } else {
          calculatedStats.total_entries++
          calculatedStats.entry_liters += t.quantity_liters
          calculatedStats.largest_entry = Math.max(calculatedStats.largest_entry, t.quantity_liters)
        }
      } else if (t.transaction_type === 'consumption') {
        // Check if it's a negative adjustment by looking for adjustment metadata
        if (t.notes && t.notes.includes('[AJUSTE -]')) {
          calculatedStats.total_adjustments_negative++
          calculatedStats.adjustment_negative_liters += t.quantity_liters
        } else {
          calculatedStats.total_consumptions++
          calculatedStats.consumption_liters += t.quantity_liters
          calculatedStats.largest_consumption = Math.max(calculatedStats.largest_consumption, t.quantity_liters)
        }
      }
    })

    calculatedStats.average_consumption = calculatedStats.total_consumptions > 0 
      ? calculatedStats.consumption_liters / calculatedStats.total_consumptions 
      : 0

    return calculatedStats
  }, [filteredTransactions, transactions.length])

  // Calculate asset consumption from filtered transactions
  const filteredAssetConsumption = useMemo(() => {
    const assetMap = new Map<string, {asset_id: string, asset_name: string, total_liters: number, count: number}>()
    
    filteredTransactions.forEach(t => {
      if (t.transaction_type === 'consumption') {
        const assetKey = t.asset_id || t.exception_asset_name || 'unknown'
        const assetName = t.asset_name || t.exception_asset_name || 'Desconocido'
        
        if (assetMap.has(assetKey)) {
          const existing = assetMap.get(assetKey)!
          existing.total_liters += t.quantity_liters
          existing.count++
        } else {
          assetMap.set(assetKey, {
            asset_id: assetKey,
            asset_name: assetName,
            total_liters: t.quantity_liters,
            count: 1
          })
        }
      }
    })
    
    return Array.from(assetMap.values())
      .sort((a, b) => b.total_liters - a.total_liters)
  }, [filteredTransactions])

  const loadWarehouseData = async () => {
    try {
      setLoading(true)

      // Load warehouse details - verify it's a UREA warehouse
      const { data: warehouseData, error: warehouseError } = await supabase
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
          product_type,
          plants!inner(name)
        `)
        .eq('id', warehouseId)
        .eq('product_type', 'urea')
        .single()

      if (warehouseError) {
        console.error('Error loading warehouse:', warehouseError)
      } else {
        const plantsAny: any = (warehouseData as any).plants
        const plantName = Array.isArray(plantsAny)
          ? plantsAny[0]?.name
          : plantsAny?.name
        setWarehouse({
          ...warehouseData,
          plant_name: plantName || 'N/A'
        })
      }

      // Load warehouse transactions - filter by UREA product
      const { data: transactionsData, error: transactionsError } = await supabase
        .from('diesel_transactions')
        .select(`
          id,
          transaction_id,
          transaction_type,
          quantity_liters,
          transaction_date,
          created_at,
          updated_at,
          asset_id,
          exception_asset_name,
          created_by,
          previous_balance,
          current_balance,
          notes,
          cuenta_litros,
          requires_validation,
          product_id,
          unit_cost,
          total_cost,
          supplier_responsible,
          diesel_products!inner(product_code, product_type),
          assets(asset_id, name)
        `)
        .eq('warehouse_id', warehouseId)
        .eq('diesel_products.product_type', 'urea')
        .order('transaction_date', { ascending: false })

      if (transactionsError) {
        console.error('Error loading transactions:', transactionsError)
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
          transaction_id: t.transaction_id,
          transaction_type: t.transaction_type,
          quantity_liters: t.quantity_liters,
          transaction_date: t.transaction_date,
          created_at: t.created_at,
          updated_at: t.updated_at,
          asset_name: t.assets?.name || null,
          asset_id: t.assets?.asset_id || t.asset_id || null,
          exception_asset_name: t.exception_asset_name || null,
          created_by_name: userProfiles[t.created_by] || 'Usuario',
          previous_balance: t.previous_balance,
          current_balance: t.current_balance,
          notes: t.notes,
          cuenta_litros: t.cuenta_litros,
          requires_validation: t.requires_validation,
          product_id: t.product_id || null,
          product_code: t.diesel_products?.product_code || null,
          unit_cost: t.unit_cost ?? null,
          total_cost: t.total_cost ?? null,
          supplier_responsible: t.supplier_responsible ?? null
        })) || []

        setTransactions(formatted)
        
        // Calculate initial statistics (for when no filters are applied)
        const initialStats: WarehouseStats = {
          total_entries: 0,
          total_consumptions: 0,
          total_adjustments_positive: 0,
          total_adjustments_negative: 0,
          total_transactions: formatted.length,
          entry_liters: 0,
          consumption_liters: 0,
          adjustment_positive_liters: 0,
          adjustment_negative_liters: 0,
          average_consumption: 0,
          largest_entry: 0,
          largest_consumption: 0
        }

        formatted.forEach(t => {
          if (t.transaction_type === 'entry') {
            // Check if it's a positive adjustment by looking for adjustment metadata
            if (t.notes && t.notes.includes('[AJUSTE +]')) {
              initialStats.total_adjustments_positive++
              initialStats.adjustment_positive_liters += t.quantity_liters
            } else {
              initialStats.total_entries++
              initialStats.entry_liters += t.quantity_liters
              initialStats.largest_entry = Math.max(initialStats.largest_entry, t.quantity_liters)
            }
          } else if (t.transaction_type === 'consumption') {
            // Check if it's a negative adjustment by looking for adjustment metadata
            if (t.notes && t.notes.includes('[AJUSTE -]')) {
              initialStats.total_adjustments_negative++
              initialStats.adjustment_negative_liters += t.quantity_liters
            } else {
              initialStats.total_consumptions++
              initialStats.consumption_liters += t.quantity_liters
              initialStats.largest_consumption = Math.max(initialStats.largest_consumption, t.quantity_liters)
            }
          }
        })

        initialStats.average_consumption = initialStats.total_consumptions > 0 
          ? initialStats.consumption_liters / initialStats.total_consumptions 
          : 0

        setStats(initialStats)

        // Build balance history for chart (last 30 transactions)
        const history: Array<{date: string, balance: number}> = []
        const sortedTransactions = [...formatted].sort((a, b) => 
          new Date(a.transaction_date).getTime() - new Date(b.transaction_date).getTime()
        )
        
        sortedTransactions.slice(-30).forEach(t => {
          if (t.current_balance != null) {
            history.push({
              date: new Date(t.transaction_date).toLocaleDateString('es-MX', {
                month: 'short',
                day: 'numeric'
              }),
              balance: t.current_balance
            })
          }
        })
        
        setBalanceHistory(history)
        
        // Calculate asset consumption for this warehouse
        const assetMap = new Map<string, {asset_id: string, asset_name: string, total_liters: number, count: number}>()
        
        formatted.forEach(t => {
          if (t.transaction_type === 'consumption') {
            const assetKey = t.asset_id || t.exception_asset_name || 'unknown'
            const assetName = t.asset_name || t.exception_asset_name || 'Desconocido'
            
            if (assetMap.has(assetKey)) {
              const existing = assetMap.get(assetKey)!
              existing.total_liters += t.quantity_liters
              existing.count++
            } else {
              assetMap.set(assetKey, {
                asset_id: assetKey,
                asset_name: assetName,
                total_liters: t.quantity_liters,
                count: 1
              })
            }
          }
        })
        
        const assetConsumptionArray = Array.from(assetMap.values())
          .sort((a, b) => b.total_liters - a.total_liters)
        
        setAssetConsumption(assetConsumptionArray)
      }
    } catch (error) {
      console.error('Error loading warehouse data:', error)
    } finally {
      setLoading(false)
    }
  }

  const applyFilters = () => {
    let filtered = [...transactions]

    // Convert UTC timestamp to local date (GMT-6) and extract YYYY-MM-DD
    // This matches the timezone handling used in other diesel modules
    const toLocalYmd = (utcTimestamp: string) => {
      if (!utcTimestamp) return ''
      const utcDate = new Date(utcTimestamp)
      // GMT-6 means subtract 6 hours from UTC to get local date
      const localTimeMs = utcDate.getTime() - (6 * 60 * 60 * 1000)
      const localDate = new Date(localTimeMs)
      // Extract YYYY-MM-DD from the adjusted time
      const year = localDate.getUTCFullYear()
      const month = String(localDate.getUTCMonth() + 1).padStart(2, '0')
      const day = String(localDate.getUTCDate()).padStart(2, '0')
      return `${year}-${month}-${day}`
    }

    if (typeFilter !== "all") {
      if (typeFilter === "adjustment_positive") {
        filtered = filtered.filter(t => 
          t.transaction_type === 'entry' && t.notes && t.notes.includes('[AJUSTE +]')
        )
      } else if (typeFilter === "adjustment_negative") {
        filtered = filtered.filter(t => 
          t.transaction_type === 'consumption' && t.notes && t.notes.includes('[AJUSTE -]')
        )
      } else {
        filtered = filtered.filter(t => t.transaction_type === typeFilter)
      }
    }

    if (dateFrom) {
      filtered = filtered.filter(t => {
        const transactionDateStr = toLocalYmd(t.transaction_date)
        return transactionDateStr >= dateFrom
      })
    }

    if (dateTo) {
      filtered = filtered.filter(t => {
        const transactionDateStr = toLocalYmd(t.transaction_date)
        return transactionDateStr <= dateTo
      })
    }

    if (validationOnly) {
      filtered = filtered.filter(t => t.requires_validation)
    }

    setFilteredTransactions(filtered)
    setCurrentPage(1) // Reset to first page when filters change
  }

  const clearFilters = () => {
    setTypeFilter("all")
    setDateFrom("")
    setDateTo("")
    setCurrentPage(1)
    setValidationOnly(false)
  }

  const handleEditTransaction = (transaction: Transaction) => {
    setEditingTransaction(transaction)
    setIsEditModalOpen(true)
  }

  const handleOpenEvidence = (transaction: Transaction) => {
    setEvidenceTransaction(transaction)
    setIsEvidenceModalOpen(true)
  }

  const isLatestTransaction = (transaction: Transaction) => {
    if (transactions.length === 0) return false
    return transaction.id === transactions[0].id
  }

  const handleEditSuccess = () => {
    // Reload warehouse data to reflect changes
    loadWarehouseData()
  }

  const handleCloseEditModal = () => {
    setIsEditModalOpen(false)
    setEditingTransaction(null)
  }

  const getTransactionIcon = (transaction: Transaction) => {
    const isPositiveAdjustment = transaction.transaction_type === 'entry' && 
      transaction.notes && transaction.notes.includes('[AJUSTE +]')
    const isNegativeAdjustment = transaction.transaction_type === 'consumption' && 
      transaction.notes && transaction.notes.includes('[AJUSTE -]')
    
    if (isPositiveAdjustment) return <TrendingUp className="h-4 w-4 text-blue-600" />
    if (isNegativeAdjustment) return <TrendingDown className="h-4 w-4 text-orange-600" />
    if (transaction.transaction_type === 'consumption') return <TrendingDown className="h-4 w-4 text-red-600" />
    if (transaction.transaction_type === 'entry') return <TruckIcon className="h-4 w-4 text-green-600" />
    return <History className="h-4 w-4 text-gray-600" />
  }

  const getTransactionLabel = (transaction: Transaction) => {
    const isPositiveAdjustment = transaction.transaction_type === 'entry' && 
      transaction.notes && transaction.notes.includes('[AJUSTE +]')
    const isNegativeAdjustment = transaction.transaction_type === 'consumption' && 
      transaction.notes && transaction.notes.includes('[AJUSTE -]')
    
    if (isPositiveAdjustment) return 'Ajuste +'
    if (isNegativeAdjustment) return 'Ajuste -'
    if (transaction.transaction_type === 'consumption') return 'Consumo'
    if (transaction.transaction_type === 'entry') return 'Entrada'
    return transaction.transaction_type
  }

  const getCapacityPercentage = () => {
    if (!warehouse) return 0
    return (warehouse.current_inventory / warehouse.capacity_liters) * 100
  }

  const getCapacityColor = (percentage: number) => {
    if (percentage < 20) return 'bg-red-500'
    if (percentage < 50) return 'bg-orange-500'
    return 'bg-green-500'
  }

  // Helpers for copy-to-Excel (TSV) export
  const formatDateForAccounting = (dateStr: string): string => {
    if (!dateStr) return '-'
    try {
      const base = dateStr.split('T')[0]
      const [y, m, d] = base.split('-').map(n => parseInt(n, 10))
      if (!y || !m || !d) return '-'
      const dt = new Date(y, m - 1, d, 12, 0, 0)
      const dd = String(dt.getDate()).padStart(2, '0')
      const mm = String(dt.getMonth() + 1).padStart(2, '0')
      const yyyy = String(dt.getFullYear())
      return `${dd}/${mm}/${yyyy}`
    } catch {
      return '-'
    }
  }

  const getWarehouseNumberFromCode = (code: string): string => {
    if (!code) return '-'
    // Prefer the last digit as requested; fallback to last numeric group
    for (let i = code.length - 1; i >= 0; i--) {
      const ch = code[i]
      if (ch >= '0' && ch <= '9') return ch
    }
    const match = code.match(/(\d+)(?!.*\d)/)
    return match ? match[1] : '-'
  }

  const buildDieselTSV = (rows: Transaction[], warehouseCode: string) => {
    const headers = ['FECHA','CLAVE DE PRODUCTO','ALMACEN','LITROS','UNIDAD']
    const wh = getWarehouseNumberFromCode(warehouseCode)
    const formatRow = (t: Transaction) => [
      formatDateForAccounting(t.transaction_date),
      t.product_code || '07DS01',
      wh,
      t.quantity_liters.toFixed(2),
      t.asset_id || t.exception_asset_name || t.asset_name || '-'
    ].join('\t')
    return [headers.join('\t'), ...rows.map(formatRow)].join('\n')
  }

  const handleCopyToExcel = async () => {
    try {
      if (!warehouse) return
      const tsv = buildDieselTSV(filteredTransactions, warehouse.warehouse_code)
      if (!tsv) {
        toast({ title: 'Sin datos', description: 'No hay transacciones para copiar', variant: 'destructive' })
        return
      }
      if (navigator?.clipboard?.writeText) {
        await navigator.clipboard.writeText(tsv)
      } else {
        const textarea = document.createElement('textarea')
        textarea.value = tsv
        textarea.style.position = 'fixed'
        textarea.style.opacity = '0'
        document.body.appendChild(textarea)
        textarea.select()
        document.execCommand('copy')
        document.body.removeChild(textarea)
      }
      toast({ title: 'Copiado', description: 'Datos copiados al portapapeles' })
    } catch (err) {
      console.error('Copy to Excel failed:', err)
      toast({ title: 'Error', description: 'No se pudo copiar al portapapeles', variant: 'destructive' })
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    )
  }

  if (!warehouse) {
    return (
      <div className="container mx-auto py-6 px-4">
        <Card>
          <CardContent className="py-8 text-center">
            <p className="text-muted-foreground">Almacén no encontrado</p>
            <Button variant="outline" className="mt-4" asChild>
              <Link href="/urea">
                <ChevronLeft className="h-4 w-4 mr-2" />
                Volver
              </Link>
            </Button>
          </CardContent>
        </Card>
      </div>
    )
  }

  const percentage = getCapacityPercentage()

  return (
    <div className="container mx-auto py-6 px-4 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <div className="flex items-center gap-3">
            <h1 className="text-3xl font-bold flex items-center gap-2">
              <Fuel className="h-8 w-8 text-blue-600" />
              {warehouse.name}
            </h1>
            <Badge variant="outline">{warehouse.warehouse_code}</Badge>
          </div>
          <p className="text-muted-foreground mt-1">
            {warehouse.plant_name}
          </p>
        </div>
        <Button variant="outline" asChild>
          <Link href="/diesel">
            <ChevronLeft className="h-4 w-4 mr-2" />
            Volver
          </Link>
        </Button>
      </div>

      {/* Quick Stats Overview */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        {/* Total Transactions */}
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Total Transacciones</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{(dateFrom || dateTo || typeFilter !== "all" || validationOnly) ? filteredStats.total_transactions : (stats?.total_transactions || 0)}</div>
            <p className="text-xs text-muted-foreground mt-1">
              Movimientos registrados
            </p>
          </CardContent>
        </Card>

        {/* Total Entries */}
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Entradas</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-green-600">
              {((dateFrom || dateTo || typeFilter !== "all" || validationOnly) ? filteredStats.entry_liters : (stats?.entry_liters || 0)).toFixed(1)}L
            </div>
            <p className="text-xs text-muted-foreground mt-1">
              {((dateFrom || dateTo || typeFilter !== "all" || validationOnly) ? filteredStats.total_entries : (stats?.total_entries || 0))} entradas
            </p>
          </CardContent>
        </Card>

        {/* Total Consumptions */}
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Consumos</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-red-600">
              {((dateFrom || dateTo || typeFilter !== "all" || validationOnly) ? filteredStats.consumption_liters : (stats?.consumption_liters || 0)).toFixed(1)}L
            </div>
            <p className="text-xs text-muted-foreground mt-1">
              {((dateFrom || dateTo || typeFilter !== "all" || validationOnly) ? filteredStats.total_consumptions : (stats?.total_consumptions || 0))} consumos
            </p>
          </CardContent>
        </Card>

        {/* Average Consumption */}
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Promedio por Consumo</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-blue-600">
              {((dateFrom || dateTo || typeFilter !== "all" || validationOnly) ? filteredStats.average_consumption : (stats?.average_consumption || 0)).toFixed(1)}L
            </div>
            <p className="text-xs text-muted-foreground mt-1">
              Por transacción
            </p>
          </CardContent>
        </Card>
      </div>

      {/* Warehouse Details */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {/* Current Inventory */}
        <Card>
          <CardHeader className="pb-3">
            <CardDescription>Inventario Actual</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="text-3xl font-bold text-blue-600">
              {warehouse.current_inventory.toFixed(1)}L
            </div>
            <div className="text-sm text-muted-foreground">
              de {warehouse.capacity_liters.toFixed(0)}L capacidad
            </div>
            
            {/* Progress bar */}
            <div className="w-full bg-gray-200 rounded-full h-3">
              <div
                className={`h-3 rounded-full transition-all ${getCapacityColor(percentage)}`}
                style={{ width: `${Math.min(percentage, 100)}%` }}
              />
            </div>
            
            <p className="text-xs text-muted-foreground">
              {percentage.toFixed(1)}% de capacidad
            </p>
          </CardContent>
        </Card>

        {/* Cuenta Litros */}
        <Card>
          <CardHeader className="pb-3">
            <CardDescription>Cuenta Litros</CardDescription>
          </CardHeader>
          <CardContent>
            {warehouse.has_cuenta_litros ? (
              <>
                <div className="text-3xl font-bold">
                  {warehouse.current_cuenta_litros?.toFixed(0) || 'N/A'}
                </div>
                <p className="text-sm text-muted-foreground mt-2">
                  Lectura actual
                </p>
              </>
            ) : (
              <div className="text-muted-foreground">
                No disponible
              </div>
            )}
          </CardContent>
        </Card>

        {/* Last Updated */}
        <Card>
          <CardHeader className="pb-3">
            <CardDescription>Última Actualización</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="flex items-center gap-2">
              <Calendar className="h-5 w-5 text-muted-foreground" />
              <div>
                <div className="text-sm font-medium">
                  {new Date(warehouse.last_updated).toLocaleDateString('es-MX')}
                </div>
                <div className="text-xs text-muted-foreground">
                  {new Date(warehouse.last_updated).toLocaleTimeString('es-MX', {
                    hour: '2-digit',
                    minute: '2-digit'
                  })}
                </div>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Balance History Chart */}
      {balanceHistory.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Activity className="h-5 w-5" />
              Historial de Balance
            </CardTitle>
            <CardDescription>
              Evolución del inventario (últimas 30 transacciones)
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-4">
              {/* Simple line chart visualization */}
              <div className="relative h-48 flex items-end gap-1">
                {balanceHistory.map((point, index) => {
                  const height = (point.balance / maxBalanceForChart) * 100
                  return (
                    <div key={index} className="flex-1 h-full">
                      <div 
                        className="w-full bg-blue-500 rounded-t hover:bg-blue-600 transition-colors"
                        style={{ height: `${height}%` }}
                        title={`${point.date}: ${point.balance.toFixed(1)}L`}
                      />
                    </div>
                  )
                })}
              </div>
              
              {/* X-axis labels */}
              <div className="flex justify-between text-xs text-muted-foreground">
                <span>{balanceHistory[0]?.date}</span>
                <span>{balanceHistory[Math.floor(balanceHistory.length / 2)]?.date}</span>
                <span>{balanceHistory[balanceHistory.length - 1]?.date}</span>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Detailed Statistics */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <BarChart3 className="h-5 w-5" />
            Estadísticas Detalladas
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
            <div className="space-y-1">
              <p className="text-sm text-muted-foreground">Mayor Entrada</p>
              <p className="text-xl font-bold text-green-600">
                {((dateFrom || dateTo || typeFilter !== "all" || validationOnly) ? filteredStats.largest_entry : (stats?.largest_entry || 0)).toFixed(1)}L
              </p>
            </div>
            
            <div className="space-y-1">
              <p className="text-sm text-muted-foreground">Mayor Consumo</p>
              <p className="text-xl font-bold text-red-600">
                {((dateFrom || dateTo || typeFilter !== "all" || validationOnly) ? filteredStats.largest_consumption : (stats?.largest_consumption || 0)).toFixed(1)}L
              </p>
            </div>
            
            <div className="space-y-1">
              <p className="text-sm text-muted-foreground">Ajustes Positivos</p>
              <p className="text-xl font-bold text-blue-600">
                +{((dateFrom || dateTo || typeFilter !== "all" || validationOnly) ? filteredStats.adjustment_positive_liters : (stats?.adjustment_positive_liters || 0)).toFixed(1)}L
              </p>
              <p className="text-xs text-muted-foreground">
                {((dateFrom || dateTo || typeFilter !== "all" || validationOnly) ? filteredStats.total_adjustments_positive : (stats?.total_adjustments_positive || 0))} ajustes
              </p>
            </div>
            
            <div className="space-y-1">
              <p className="text-sm text-muted-foreground">Ajustes Negativos</p>
              <p className="text-xl font-bold text-orange-600">
                -{((dateFrom || dateTo || typeFilter !== "all" || validationOnly) ? filteredStats.adjustment_negative_liters : (stats?.adjustment_negative_liters || 0)).toFixed(1)}L
              </p>
              <p className="text-xs text-muted-foreground">
                {((dateFrom || dateTo || typeFilter !== "all" || validationOnly) ? filteredStats.total_adjustments_negative : (stats?.total_adjustments_negative || 0))} ajustes
              </p>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Transactions History with Filters */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="flex items-center gap-2">
                <History className="h-5 w-5" />
                Historial de Movimientos
              </CardTitle>
              <CardDescription>
                {filteredTransactions.length} de {transactions.length} transacciones
              </CardDescription>
            </div>
            <div>
              <Button size="sm" onClick={handleCopyToExcel} disabled={filteredTransactions.length === 0}>
                Copiar a Excel
              </Button>
            </div>
          </div>
        </CardHeader>
        
        {/* Filters */}
        <CardContent className="border-b pb-4">
          <div className="flex items-center gap-2 mb-3">
            <Filter className="h-4 w-4 text-muted-foreground" />
            <span className="text-sm font-medium">Filtros</span>
            {(typeFilter !== "all" || dateFrom || dateTo || validationOnly) && (
              <Button variant="ghost" size="sm" onClick={clearFilters}>
                <X className="h-3 w-3 mr-1" />
                Limpiar
              </Button>
            )}
          </div>
          
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <div className="space-y-2">
              <Label className="text-xs">Tipo</Label>
              <select
                value={typeFilter}
                onChange={(e) => setTypeFilter(e.target.value)}
                className="w-full h-9 px-3 border border-gray-300 rounded-md text-sm"
              >
                <option value="all">Todos</option>
                <option value="consumption">Consumos</option>
                <option value="entry">Entradas</option>
                <option value="adjustment_positive">Ajustes +</option>
                <option value="adjustment_negative">Ajustes -</option>
              </select>
            </div>
            
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

          {/* Validation-only toggle */}
          <div className="mt-3 flex items-center gap-2">
            <input
              id="validation-only"
              type="checkbox"
              checked={validationOnly}
              onChange={(e) => setValidationOnly(e.target.checked)}
              className="h-4 w-4"
            />
            <Label htmlFor="validation-only" className="text-sm">Solo marcadas para validación</Label>
          </div>
        </CardContent>
        
        <CardContent className="pt-4">
          <div className="space-y-2">
            {paginatedTransactions.map((transaction) => (
              <div
                key={transaction.id}
                className="flex items-center justify-between p-4 rounded-lg border hover:bg-gray-50 transition-colors cursor-pointer"
                onClick={() => handleOpenEvidence(transaction)}
              >
                <div className="flex items-center gap-4 flex-1">
                  {getTransactionIcon(transaction)}
                  
                  <div className="flex-1 space-y-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-semibold">
                        {getTransactionLabel(transaction)}
                      </span>
                      <Badge variant="outline" className="text-xs">
                        {transaction.quantity_liters.toFixed(1)}L
                      </Badge>
                      {transaction.transaction_type === 'entry' && (
                        transaction.unit_cost ? (
                          <Badge 
                            variant="outline" 
                            className="text-xs bg-green-50 text-green-700 border-green-300 flex items-center gap-1"
                            title={`Precio unitario: $${transaction.unit_cost.toFixed(2)}/L`}
                          >
                            <CheckCircle2 className="h-3 w-3" />
                            <DollarSign className="h-3 w-3" />
                            ${transaction.unit_cost.toFixed(2)}/L
                          </Badge>
                        ) : (
                          <Badge 
                            variant="outline" 
                            className="text-xs bg-yellow-50 text-yellow-700 border-yellow-300 flex items-center gap-1"
                            title="Falta precio unitario"
                          >
                            <AlertTriangle className="h-3 w-3" />
                            Sin precio
                          </Badge>
                        )
                      )}
                      {transaction.asset_name && (
                        <Badge variant="secondary" className="text-xs">
                          {transaction.asset_name}
                        </Badge>
                      )}
                      {transaction.asset_id && (
                        <Badge variant="outline" className="text-xs font-mono">
                          {transaction.asset_id}
                        </Badge>
                      )}
                      {transaction.exception_asset_name && (
                        <Badge variant="outline" className="text-xs bg-orange-50">
                          Externo: {transaction.exception_asset_name}
                        </Badge>
                      )}
                    </div>
                    <div className="text-xs text-muted-foreground flex items-center gap-2 flex-wrap">
                      <span>{transaction.created_by_name}</span>
                      <span>•</span>
                      <span>
                        {new Date(transaction.transaction_date).toLocaleString('es-MX', {
                          month: 'short',
                          day: 'numeric',
                          year: 'numeric',
                          hour: '2-digit',
                          minute: '2-digit'
                        })}
                      </span>
                      {transaction.created_at && (
                        <span className="ml-2">creada: {new Date(transaction.created_at).toLocaleString('es-MX', { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</span>
                      )}
                      {transaction.updated_at && (
                        <span>• modificada: {new Date(transaction.updated_at).toLocaleString('es-MX', { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</span>
                      )}
                      {transaction.requires_validation && (
                        <Badge title="Marcada para validación" variant="destructive" className="text-[10px]">Marcada para validación</Badge>
                      )}
                      {/* Client-computed hints */}
                      {transaction.created_at && (
                        (() => {
                          try {
                            const created = new Date(transaction.created_at).getTime()
                            const registered = new Date(transaction.transaction_date).getTime()
                            if (!isNaN(created) && !isNaN(registered)) {
                              const deltaMin = Math.floor((created - registered) / 60000)
                              if (deltaMin > 120) {
                                return (
                                  <Badge title={`Fuera de tiempo por ${deltaMin} min`} variant="outline" className="text-[10px] bg-yellow-50 text-yellow-800 border-yellow-300">
                                    Fuera de tiempo {deltaMin}m
                                  </Badge>
                                )
                              }
                            }
                          } catch {}
                        })()
                      )}
                      {/* Future-dated hint */}
                      {(() => {
                        try {
                          const registered = new Date(transaction.transaction_date).getTime()
                          const created = transaction.created_at ? new Date(transaction.created_at).getTime() : undefined
                          const refTime = created ?? Date.now()
                          const futureMin = Math.floor((registered - refTime) / 60000)
                          if (futureMin > 0) {
                            return (
                              <Badge title={`Fuera de tiempo por ${futureMin} min`} variant="outline" className="text-[10px] bg-blue-50 text-blue-800 border-blue-300">
                                Fuera de tiempo {futureMin}m
                              </Badge>
                            )
                          }
                        } catch {}
                      })()}
                    </div>
                    {transaction.notes && (
                      <div className="text-xs text-muted-foreground italic">
                        {transaction.notes}
                      </div>
                    )}
                  </div>
                </div>

                <div className="text-right space-y-1">
                  <div className="text-sm">
                    <span className="text-muted-foreground">Balance: </span>
                    <span className="font-semibold">
                      {transaction.current_balance != null ? transaction.current_balance.toFixed(1) : 'N/A'}L
                    </span>
                  </div>
                  <div className="text-xs text-muted-foreground">
                    Anterior: {transaction.previous_balance != null ? transaction.previous_balance.toFixed(1) : 'N/A'}L
                  </div>
                  
                  {/* Edit Button */}
                  <div className="pt-2">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={(e) => { e.stopPropagation(); handleEditTransaction(transaction) }}
                      className="h-8 px-2 text-xs"
                    >
                      <Edit className="h-3 w-3 mr-1" />
                      Editar
                    </Button>
                  </div>
                </div>
              </div>
            ))}

            {filteredTransactions.length === 0 && transactions.length > 0 && (
              <div className="text-center py-8 text-muted-foreground">
                No hay transacciones que coincidan con los filtros
              </div>
            )}
            
            {transactions.length === 0 && (
              <div className="text-center py-8 text-muted-foreground">
                No hay transacciones registradas para este almacén
              </div>
            )}
          </div>
          
          {/* Pagination Controls */}
          {filteredTransactions.length > itemsPerPage && (
            <div className="flex items-center justify-between border-t pt-4 mt-4">
              <div className="text-sm text-muted-foreground">
                Mostrando {((currentPage - 1) * itemsPerPage) + 1} - {Math.min(currentPage * itemsPerPage, filteredTransactions.length)} de {filteredTransactions.length}
              </div>
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setCurrentPage(p => Math.max(1, p - 1))}
                  disabled={currentPage === 1}
                >
                  <ChevronLeft className="h-4 w-4" />
                  Anterior
                </Button>
                <div className="text-sm">
                  Página {currentPage} de {totalPages}
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setCurrentPage(p => Math.min(totalPages, p + 1))}
                  disabled={currentPage === totalPages}
                >
                  Siguiente
                  <ChevronLeft className="h-4 w-4 rotate-180" />
                </Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Asset Consumption Analytics (Warehouse-Specific) */}
      {((dateFrom || dateTo || typeFilter !== "all" || validationOnly) ? filteredAssetConsumption : assetConsumption).length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <BarChart3 className="h-5 w-5" />
              Consumo por Equipo (Este Almacén)
            </CardTitle>
            <CardDescription>
              Top equipos consumidores en este almacén
              {(dateFrom || dateTo || typeFilter !== "all" || validationOnly) && " (filtrado)"}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-3">
              {((dateFrom || dateTo || typeFilter !== "all" || validationOnly) ? filteredAssetConsumption : assetConsumption).slice(0, 10).map((asset, index) => {
                const displayList = (dateFrom || dateTo || typeFilter !== "all" || validationOnly) ? filteredAssetConsumption : assetConsumption
                const maxLiters = displayList[0]?.total_liters || 1
                const percentage = (asset.total_liters / maxLiters) * 100
                const avgPerConsumption = asset.total_liters / asset.count
                // Determine if it's an external asset (contains spaces or special chars that aren't valid UUIDs)
                const isExternal = asset.asset_id.includes(' ') || !asset.asset_id.match(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)
                const assetLink = isExternal 
                  ? `/diesel/almacen/${warehouseId}/equipo/external:${encodeURIComponent(asset.asset_id)}`
                  : `/diesel/almacen/${warehouseId}/equipo/${asset.asset_id}`
                
                return (
                  <Link key={asset.asset_id} href={assetLink}>
                    <div className="space-y-2 hover:bg-gray-50 p-2 rounded-lg transition-colors cursor-pointer">
                      <div className="flex items-center justify-between text-sm">
                        <div className="flex items-center gap-2">
                          <span className="font-mono text-xs text-muted-foreground">
                            #{index + 1}
                          </span>
                          <span className="font-medium">{asset.asset_name}</span>
                          {asset.asset_id !== asset.asset_name && (
                            <Badge variant="outline" className="text-xs">
                              {asset.asset_id}
                            </Badge>
                          )}
                        </div>
                        <div className="text-right">
                          <span className="font-bold text-lg">{asset.total_liters.toFixed(1)}L</span>
                          <span className="text-xs text-muted-foreground ml-2">
                            ({asset.count} consumos)
                          </span>
                        </div>
                      </div>
                    
                    <div className="flex items-center gap-2">
                      <div className="flex-1 h-2 bg-gray-200 rounded-full overflow-hidden">
                        <div
                          className="h-full bg-gradient-to-r from-blue-500 to-blue-600 transition-all"
                          style={{ width: `${percentage}%` }}
                        />
                      </div>
                      <span className="text-xs text-muted-foreground whitespace-nowrap">
                        Promedio: {avgPerConsumption.toFixed(1)}L
                      </span>
                    </div>
                    </div>
                  </Link>
                )
              })}
            </div>
            
            {((dateFrom || dateTo || typeFilter !== "all" || validationOnly) ? filteredAssetConsumption : assetConsumption).length > 10 && (
              <p className="text-sm text-muted-foreground text-center mt-4">
                Y {((dateFrom || dateTo || typeFilter !== "all" || validationOnly) ? filteredAssetConsumption : assetConsumption).length - 10} equipos más...
              </p>
            )}
          </CardContent>
        </Card>
      )}

      {/* Transaction Edit Modal */}
      <TransactionEditModal
        transaction={editingTransaction}
        isOpen={isEditModalOpen}
        onClose={handleCloseEditModal}
        onSuccess={handleEditSuccess}
        isLatestTransaction={editingTransaction ? isLatestTransaction(editingTransaction) : false}
        warehouseHasMeter={warehouse?.has_cuenta_litros || false}
      />

      {/* Transaction Evidence Modal */}
      <TransactionEvidenceModal
        transactionId={evidenceTransaction?.id || null}
        isOpen={isEvidenceModalOpen}
        onClose={() => { setIsEvidenceModalOpen(false); setEvidenceTransaction(null) }}
        headerTitle={evidenceTransaction ? `Evidencia • ${getTransactionLabel(evidenceTransaction)} • ${evidenceTransaction.quantity_liters.toFixed(1)}L` : 'Evidencia'}
        subheader={evidenceTransaction ? new Date(evidenceTransaction.transaction_date).toLocaleString('es-MX', { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : undefined}
      />
    </div>
  )
}

