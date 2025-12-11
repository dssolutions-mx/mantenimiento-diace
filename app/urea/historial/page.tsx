"use client"

import { useState, useEffect } from "react"
import { createBrowserClient } from "@supabase/ssr"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Badge } from "@/components/ui/badge"
import { 
  History, 
  TruckIcon, 
  TrendingDown,
  TrendingUp,
  AlertTriangle,
  Download,
  Filter,
  X,
  Search,
  Loader2,
  ChevronLeft,
  ChevronRight
} from "lucide-react"
import { useRouter } from "next/navigation"
import Link from "next/link"

interface Transaction {
  id: string
  transaction_type: string
  quantity_liters: number
  transaction_date: string
  asset_name: string | null
  warehouse_name: string
  created_by_name: string
  previous_balance: number
  current_balance: number
  notes: string | null
}

export default function DieselHistoryPage() {
  const router = useRouter()
  const [loading, setLoading] = useState(true)
  const [transactions, setTransactions] = useState<Transaction[]>([])
  const [filteredTransactions, setFilteredTransactions] = useState<Transaction[]>([])
  
  // Filters
  const [selectedType, setSelectedType] = useState<string>("all")
  const [selectedWarehouse, setSelectedWarehouse] = useState<string>("all")
  const [dateFrom, setDateFrom] = useState<string>("")
  const [dateTo, setDateTo] = useState<string>("")
  const [searchTerm, setSearchTerm] = useState<string>("")
  
  // Pagination
  const [currentPage, setCurrentPage] = useState(1)
  const itemsPerPage = 20
  
  // Available filters
  const [warehouses, setWarehouses] = useState<any[]>([])

  const supabase = createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  )

  useEffect(() => {
    loadData()
  }, [])

  useEffect(() => {
    applyFilters()
  }, [transactions, selectedType, selectedWarehouse, dateFrom, dateTo, searchTerm])

  const loadData = async () => {
    try {
      setLoading(true)

      // Load transactions - filter by UREA product
      const { data: transactionsData, error: transactionsError } = await supabase
        .from('diesel_transactions')
        .select(`
          id,
          transaction_type,
          quantity_liters,
          transaction_date,
          asset_id,
          created_by,
          previous_balance,
          current_balance,
          notes,
          diesel_warehouses!inner(id, name, product_type),
          diesel_products!inner(product_type),
          assets(asset_id, name)
        `)
        .eq('diesel_warehouses.product_type', 'urea')
        .eq('diesel_products.product_type', 'urea')
        .order('transaction_date', { ascending: false })
        .limit(500)

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

        const formatted = transactionsData?.map((t: any) => ({
          id: t.id,
          transaction_type: t.transaction_type,
          quantity_liters: t.quantity_liters,
          transaction_date: t.transaction_date,
          asset_name: t.assets?.name || null,
          warehouse_name: t.diesel_warehouses?.name || 'N/A',
          created_by_name: userProfiles[t.created_by] || 'Usuario',
          previous_balance: t.previous_balance,
          current_balance: t.current_balance,
          notes: t.notes
        })) || []

        setTransactions(formatted)
      }

      // Load warehouses for filter
      const { data: warehousesData } = await supabase
        .from('diesel_warehouses')
        .select('id, name')
        .eq('product_type', 'urea')
        .order('name')

      setWarehouses(warehousesData || [])
    } catch (error) {
      console.error('Error loading data:', error)
    } finally {
      setLoading(false)
    }
  }

  const applyFilters = () => {
    let filtered = [...transactions]

    // Type filter
    if (selectedType !== "all") {
      filtered = filtered.filter(t => t.transaction_type === selectedType)
    }

    // Warehouse filter
    if (selectedWarehouse !== "all") {
      filtered = filtered.filter(t => t.warehouse_name === warehouses.find(w => w.id === selectedWarehouse)?.name)
    }

    // Date range filter
    if (dateFrom) {
      filtered = filtered.filter(t => new Date(t.transaction_date) >= new Date(dateFrom))
    }
    if (dateTo) {
      filtered = filtered.filter(t => new Date(t.transaction_date) <= new Date(dateTo + 'T23:59:59'))
    }

    // Search filter
    if (searchTerm) {
      const term = searchTerm.toLowerCase()
      filtered = filtered.filter(t =>
        t.asset_name?.toLowerCase().includes(term) ||
        t.warehouse_name.toLowerCase().includes(term) ||
        t.created_by_name.toLowerCase().includes(term) ||
        t.notes?.toLowerCase().includes(term)
      )
    }

    setFilteredTransactions(filtered)
    setCurrentPage(1)
  }

  const clearFilters = () => {
    setSelectedType("all")
    setSelectedWarehouse("all")
    setDateFrom("")
    setDateTo("")
    setSearchTerm("")
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

  const getTransactionColor = (type: string) => {
    if (type === 'consumption') return 'text-red-600'
    if (type === 'entry') return 'text-green-600'
    if (type === 'adjustment_positive') return 'text-blue-600'
    if (type === 'adjustment_negative') return 'text-orange-600'
    return 'text-gray-600'
  }

  // Pagination
  const totalPages = Math.ceil(filteredTransactions.length / itemsPerPage)
  const paginatedTransactions = filteredTransactions.slice(
    (currentPage - 1) * itemsPerPage,
    currentPage * itemsPerPage
  )

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
            <History className="h-8 w-8 text-blue-600" />
            Historial de Transacciones
          </h1>
          <p className="text-muted-foreground mt-1">
            Registro completo de movimientos de diesel
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
          <div className="flex items-center justify-between">
            <CardTitle className="flex items-center gap-2">
              <Filter className="h-5 w-5" />
              Filtros
            </CardTitle>
            <Button variant="ghost" size="sm" onClick={clearFilters}>
              <X className="h-4 w-4 mr-1" />
              Limpiar
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
            {/* Type Filter */}
            <div className="space-y-2">
              <Label>Tipo de Transacción</Label>
              <select
                value={selectedType}
                onChange={(e) => setSelectedType(e.target.value)}
                className="w-full h-10 px-3 border border-gray-300 rounded-md"
              >
                <option value="all">Todos</option>
                <option value="consumption">Consumos</option>
                <option value="entry">Entradas</option>
                <option value="adjustment_positive">Ajustes Positivos</option>
                <option value="adjustment_negative">Ajustes Negativos</option>
              </select>
            </div>

            {/* Warehouse Filter */}
            <div className="space-y-2">
              <Label>Almacén</Label>
              <select
                value={selectedWarehouse}
                onChange={(e) => setSelectedWarehouse(e.target.value)}
                className="w-full h-10 px-3 border border-gray-300 rounded-md"
              >
                <option value="all">Todos</option>
                {warehouses.map(w => (
                  <option key={w.id} value={w.id}>{w.name}</option>
                ))}
              </select>
            </div>

            {/* Date From */}
            <div className="space-y-2">
              <Label>Desde</Label>
              <Input
                type="date"
                value={dateFrom}
                onChange={(e) => setDateFrom(e.target.value)}
                className="h-10"
              />
            </div>

            {/* Date To */}
            <div className="space-y-2">
              <Label>Hasta</Label>
              <Input
                type="date"
                value={dateTo}
                onChange={(e) => setDateTo(e.target.value)}
                className="h-10"
              />
            </div>

            {/* Search */}
            <div className="space-y-2 md:col-span-2">
              <Label>Buscar</Label>
              <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                <Input
                  placeholder="Buscar por equipo, almacén, usuario o notas..."
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                  className="pl-9 h-10"
                />
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Results */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardDescription>
              Mostrando {paginatedTransactions.length} de {filteredTransactions.length} transacciones
            </CardDescription>
          </div>
        </CardHeader>
        <CardContent>
          <div className="space-y-2">
            {paginatedTransactions.map((transaction) => (
              <div
                key={transaction.id}
                className="flex items-center justify-between p-4 rounded-lg border hover:bg-gray-50 transition-colors"
              >
                <div className="flex items-center gap-4 flex-1">
                  {getTransactionIcon(transaction.transaction_type)}
                  
                  <div className="flex-1 space-y-1">
                    <div className="flex items-center gap-2">
                      <span className="font-semibold">
                        {getTransactionLabel(transaction.transaction_type)}
                      </span>
                      <Badge variant="outline" className="text-xs">
                        <span className={getTransactionColor(transaction.transaction_type)}>
                          {transaction.quantity_liters.toFixed(1)}L
                        </span>
                      </Badge>
                      {transaction.asset_name && (
                        <Badge variant="secondary" className="text-xs">
                          {transaction.asset_name}
                        </Badge>
                      )}
                    </div>
                    <div className="text-xs text-muted-foreground flex items-center gap-2">
                      <span>{transaction.warehouse_name}</span>
                      <span>•</span>
                      <span>{transaction.created_by_name}</span>
                      <span>•</span>
                      <span>{new Date(transaction.transaction_date).toLocaleDateString('es-MX')}</span>
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
                </div>
              </div>
            ))}
          </div>

          {/* Pagination */}
          {totalPages > 1 && (
            <div className="flex items-center justify-between mt-6">
              <Button
                variant="outline"
                size="sm"
                onClick={() => setCurrentPage(p => Math.max(1, p - 1))}
                disabled={currentPage === 1}
              >
                <ChevronLeft className="h-4 w-4" />
                Anterior
              </Button>

              <div className="text-sm text-muted-foreground">
                Página {currentPage} de {totalPages}
              </div>

              <Button
                variant="outline"
                size="sm"
                onClick={() => setCurrentPage(p => Math.min(totalPages, p + 1))}
                disabled={currentPage === totalPages}
              >
                Siguiente
                <ChevronRight className="h-4 w-4" />
              </Button>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}

