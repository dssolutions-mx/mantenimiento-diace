"use client"

import React, { useState, useEffect, useMemo } from "react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Separator } from "@/components/ui/separator"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Label } from "@/components/ui/label"
import { ChevronDown, ChevronRight, Download, Filter, Search, X } from "lucide-react"
import {
  MapPin,
  Phone,
  Mail,
  Building,
  Star,
  Award,
  Clock,
  DollarSign,
  TrendingUp,
  Users,
  Package,
  CheckCircle,
  AlertTriangle,
  Calendar,
  ExternalLink,
  Edit,
  MessageSquare,
  History,
  BarChart3,
  Wrench
} from "lucide-react"
import { Supplier, SupplierContact, SupplierService, SupplierWorkHistory, SupplierPerformanceHistory } from "@/types/suppliers"
import { SupplierPerformanceChart } from "./SupplierPerformanceChart"
import { ReportIssueDialog } from "./ReportIssueDialog"
import { createClient } from "@/lib/supabase"
import { calculateAllMetrics, SupplierMetrics, getPostingDate } from "@/lib/suppliers/metrics"
import { ArrowUp, ArrowDown, Minus, TrendingUp as TrendingUpIcon, AlertCircle } from "lucide-react"
import {
  BarChart,
  Bar,
  LineChart,
  Line,
  PieChart,
  Pie,
  Cell,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer
} from "recharts"

interface SupplierDetailsProps {
  supplier: Supplier
  onClose?: () => void
  onEdit?: (supplier: Supplier) => void
  showWorkHistory?: boolean
  showPerformanceHistory?: boolean
}

interface SupplierPurchaseOrder {
  id: string
  order_id: string
  po_type?: string | null
  status?: string | null
  enhanced_status?: string | null
  total_amount?: number | null
  actual_amount?: number | null
  posting_date?: string | null
  purchase_date?: string | null
  created_at: string
  payment_method?: string | null
  supplier_id?: string | null
  supplier?: string | null
  work_order_id?: string | null
  work_orders?: {
    id: string
    type?: string | null
    asset_id?: string | null
    assets?: {
      id: string
      asset_id?: string | null
      name?: string | null
      equipment_models?: {
        name?: string | null
        manufacturer?: string | null
      } | null
    } | null
  } | null
}

export function SupplierDetails({
  supplier,
  onClose,
  onEdit,
  showWorkHistory = true,
  showPerformanceHistory = true
}: SupplierDetailsProps) {
  const [supplierData, setSupplierData] = useState<Supplier | null>(null)
  const [contacts, setContacts] = useState<SupplierContact[]>([])
  const [services, setServices] = useState<SupplierService[]>([])
  const [workHistory, setWorkHistory] = useState<SupplierWorkHistory[]>([])
  const [performanceHistory, setPerformanceHistory] = useState<SupplierPerformanceHistory[]>([])
  const [purchaseOrders, setPurchaseOrders] = useState<SupplierPurchaseOrder[]>([])
  const [metrics, setMetrics] = useState<SupplierMetrics | null>(null)
  const [loading, setLoading] = useState(false)
  const [expandedRows, setExpandedRows] = useState<Set<string>>(new Set())
  const [dateFilter, setDateFilter] = useState<'30d' | '3mo' | '1y' | 'all'>('1y')
  const [statusFilter, setStatusFilter] = useState<string[]>([])
  const [typeFilter, setTypeFilter] = useState<string[]>([])
  const [searchQuery, setSearchQuery] = useState('')
  const [minAmount, setMinAmount] = useState<number | null>(null)
  const [maxAmount, setMaxAmount] = useState<number | null>(null)
  const [reportIssueOpen, setReportIssueOpen] = useState(false)
  const [selectedPOForIssue, setSelectedPOForIssue] = useState<SupplierPurchaseOrder | null>(null)
  const [issues, setIssues] = useState<any[]>([])

  useEffect(() => {
    loadSupplierDetails()
  }, [supplier.id])

  const loadSupplierDetails = async () => {
    setLoading(true)
    try {
      const supabase = createClient()

      const supplierQuery = supabase
        .from('suppliers')
        .select(`
          *,
          supplier_contacts(*),
          supplier_services(*),
          supplier_work_history(*),
          supplier_performance_history(*)
        `)
        .eq('id', supplier.id)
        .single()

      // Query purchase orders by both supplier_id (if set) OR supplier name (for legacy records)
      // Include posting_date (used in reports) and work_orders/assets relationships
      // First try by supplier_id
      const { data: poById, error: poByIdError } = await supabase
        .from('purchase_orders')
        .select(`
          id, 
          order_id, 
          po_type, 
          status, 
          enhanced_status, 
          total_amount, 
          actual_amount, 
          posting_date,
          purchase_date, 
          created_at, 
          payment_method, 
          supplier_id, 
          supplier,
          work_order_id,
          work_orders!purchase_orders_work_order_id_fkey (
            id,
            type,
            asset_id,
            assets (
              id,
              asset_id,
              name,
              equipment_models (
                name,
                manufacturer
              )
            )
          )
        `)
        .eq('supplier_id', supplier.id)
        .order('posting_date', { ascending: false, nullsLast: true })
        .order('created_at', { ascending: false })
        .limit(100)

      // Also check by supplier name (for legacy records without supplier_id)
      // Check both name and business_name
      const supplierNames = [supplier.name]
      if (supplier.business_name) {
        supplierNames.push(supplier.business_name)
      }
      
      const poByNamePromises = supplierNames.map(name =>
        supabase
          .from('purchase_orders')
          .select(`
            id, 
            order_id, 
            po_type, 
            status, 
            enhanced_status, 
            total_amount, 
            actual_amount, 
            posting_date,
            purchase_date, 
            created_at, 
            payment_method, 
            supplier_id, 
            supplier,
            work_order_id,
            work_orders!purchase_orders_work_order_id_fkey (
              id,
              type,
              asset_id,
              assets (
                id,
                asset_id,
                name,
                equipment_models (
                  name,
                  manufacturer
                )
              )
            )
          `)
          .ilike('supplier', `%${name}%`)
          .is('supplier_id', null)
          .order('posting_date', { ascending: false, nullsLast: true })
          .order('created_at', { ascending: false })
          .limit(100)
      )
      
      const poByNameResults = await Promise.all(poByNamePromises)
      const poByName = poByNameResults.flatMap(result => result.data || [])
      const poByNameError = poByNameResults.find(result => result.error)?.error

      // Combine results, removing duplicates by id
      const allPOs = [...(poById || []), ...(poByName || [])]
      const uniquePOs = Array.from(
        new Map(allPOs.map(po => [po.id, po])).values()
      )
      // Sort by posting_date (most recent first), then by created_at
      uniquePOs.sort((a, b) => {
        const dateA = a.posting_date ? new Date(a.posting_date).getTime() : (a.purchase_date ? new Date(a.purchase_date).getTime() : new Date(a.created_at).getTime())
        const dateB = b.posting_date ? new Date(b.posting_date).getTime() : (b.purchase_date ? new Date(b.purchase_date).getTime() : new Date(b.created_at).getTime())
        return dateB - dateA
      })

      const { data: supplierRecord, error: supplierError } = await supplierQuery

      if (supplierError) {
        console.error('Error loading supplier details:', supplierError)
      } else if (supplierRecord) {
        setSupplierData(supplierRecord as Supplier)
        setContacts((supplierRecord as any).supplier_contacts || [])
        setServices((supplierRecord as any).supplier_services || [])
        if (showWorkHistory) {
          setWorkHistory((supplierRecord as any).supplier_work_history || [])
        }
        if (showPerformanceHistory) {
          setPerformanceHistory((supplierRecord as any).supplier_performance_history || [])
        }
      }

      // Handle purchase orders (already queried above)
      if (poByIdError || poByNameError) {
        console.error('Error loading supplier purchase orders:', poByIdError || poByNameError)
      }
      setPurchaseOrders(uniquePOs)

      // Calculate metrics from purchase orders and performance history
      const issuesCount = (supplierRecord as any)?.supplier_performance_history?.filter((ph: any) => ph.issues && ph.issues.length > 0).length || 0
      const unresolvedIssuesCount = (supplierRecord as any)?.supplier_performance_history?.filter((ph: any) => 
        ph.issues && ph.issues.length > 0 && !ph.notes?.toLowerCase().includes('resolved')
      ).length || 0
      
      const calculatedMetrics = calculateAllMetrics(uniquePOs, issuesCount, unresolvedIssuesCount)
      setMetrics(calculatedMetrics)

      // Load issues from performance history
      const issuesList = (supplierRecord as any)?.supplier_performance_history
        ?.filter((ph: any) => ph.issues && ph.issues.length > 0)
        .flatMap((ph: any) => 
          ph.issues.map((issue: string, index: number) => ({
            id: `${ph.id}-${index}`,
            performanceHistoryId: ph.id,
            purchaseOrderId: ph.purchase_order_id,
            issue,
            date: ph.order_date || ph.created_at,
            notes: ph.notes,
            resolved: ph.notes?.toLowerCase().includes('resolved') || false
          }))
        ) || []
      setIssues(issuesList)
    } catch (error) {
      console.error('Error loading supplier details:', error)
    } finally {
      setLoading(false)
    }
  }

  const displaySupplier = supplierData || supplier

  const formatAmount = (value?: number | null) => {
    if (value === null || value === undefined) return 'N/A'
    return new Intl.NumberFormat('es-MX', {
      style: 'currency',
      currency: 'MXN',
      minimumFractionDigits: 0
    }).format(value)
  }

  const getPurchaseOrderStatus = (status?: string | null, enhanced?: string | null) => {
    const value = enhanced || status || 'Desconocido'
    const normalized = value.toLowerCase()
    const config = {
      'pending_approval': { variant: 'outline' as const, label: 'Pendiente' },
      'approved': { variant: 'secondary' as const, label: 'Aprobado' },
      'validated': { variant: 'default' as const, label: 'Validado' },
      'received': { variant: 'default' as const, label: 'Recibido' },
      'purchased': { variant: 'default' as const, label: 'Comprado' },
      'rejected': { variant: 'destructive' as const, label: 'Rechazado' },
    }

    return config[normalized as keyof typeof config] || { variant: 'secondary' as const, label: value }
  }

  const getStatusBadge = (status: string) => {
    const statusConfig = {
      active: { variant: "default" as const, icon: CheckCircle, label: "Activo", color: "text-green-600" },
      inactive: { variant: "secondary" as const, icon: Clock, label: "Inactivo", color: "text-gray-600" },
      suspended: { variant: "destructive" as const, icon: AlertTriangle, label: "Suspendido", color: "text-red-600" },
      blacklisted: { variant: "destructive" as const, icon: AlertTriangle, label: "Bloqueado", color: "text-red-600" }
    }

    const config = statusConfig[status as keyof typeof statusConfig] || statusConfig.active
    const Icon = config.icon

    return (
      <Badge variant={config.variant} className="flex items-center gap-1">
        <Icon className={`w-3 h-3 ${config.color}`} />
        {config.label}
      </Badge>
    )
  }

  const getTypeBadge = (type: string) => {
    const typeConfig = {
      individual: { color: "bg-blue-50 text-blue-700 border-blue-200", label: "Individual" },
      company: { color: "bg-green-50 text-green-700 border-green-200", label: "Empresa" },
      distributor: { color: "bg-purple-50 text-purple-700 border-purple-200", label: "Distribuidor" },
      manufacturer: { color: "bg-orange-50 text-orange-700 border-orange-200", label: "Fabricante" },
      service_provider: { color: "bg-cyan-50 text-cyan-700 border-cyan-200", label: "Proveedor de Servicios" }
    }

    const config = typeConfig[type as keyof typeof typeConfig] || typeConfig.company

    return (
      <Badge className={config.color}>
        {config.label}
      </Badge>
    )
  }

  const primaryContact = contacts.find(contact => contact.is_primary)
  const activeServices = services.filter(service => service.is_active)

  const getTrendIcon = (trend: 'increasing' | 'decreasing' | 'stable') => {
    switch (trend) {
      case 'increasing':
        return <ArrowUp className="w-4 h-4 text-green-600" />
      case 'decreasing':
        return <ArrowDown className="w-4 h-4 text-red-600" />
      default:
        return <Minus className="w-4 h-4 text-gray-500" />
    }
  }

  const getTrendColor = (trend: 'increasing' | 'decreasing' | 'stable') => {
    switch (trend) {
      case 'increasing':
        return 'text-green-600'
      case 'decreasing':
        return 'text-red-600'
      default:
        return 'text-gray-600'
    }
  }

  // Filter purchase orders
  const getFilteredPurchaseOrders = () => {
    let filtered = [...purchaseOrders]

    // Date filter
    if (dateFilter !== 'all') {
      const now = new Date()
      const cutoffDate = new Date()
      switch (dateFilter) {
        case '30d':
          cutoffDate.setDate(now.getDate() - 30)
          break
        case '3mo':
          cutoffDate.setMonth(now.getMonth() - 3)
          break
        case '1y':
          cutoffDate.setFullYear(now.getFullYear() - 1)
          break
      }
      filtered = filtered.filter(po => {
        const date = getPostingDate(po)
        return date >= cutoffDate
      })
    }

    // Status filter
    if (statusFilter.length > 0) {
      filtered = filtered.filter(po => {
        const status = po.enhanced_status || po.status || ''
        return statusFilter.some(filter => 
          status.toLowerCase().includes(filter.toLowerCase())
        )
      })
    }

    // Type filter
    if (typeFilter.length > 0) {
      filtered = filtered.filter(po => {
        const type = po.po_type || ''
        return typeFilter.includes(type)
      })
    }

    // Amount filter
    if (minAmount !== null) {
      filtered = filtered.filter(po => {
        const amount = po.actual_amount || po.total_amount || 0
        return Number(amount) >= minAmount
      })
    }
    if (maxAmount !== null) {
      filtered = filtered.filter(po => {
        const amount = po.actual_amount || po.total_amount || 0
        return Number(amount) <= maxAmount
      })
    }

    // Search filter
    if (searchQuery.trim()) {
      const query = searchQuery.toLowerCase()
      filtered = filtered.filter(po => 
        po.order_id.toLowerCase().includes(query) ||
        (po.work_orders?.assets?.name?.toLowerCase().includes(query)) ||
        (po.work_orders?.assets?.asset_id?.toLowerCase().includes(query))
      )
    }

    return filtered
  }

  const filteredPurchaseOrders = useMemo(() => getFilteredPurchaseOrders(), [
    purchaseOrders,
    dateFilter,
    statusFilter,
    typeFilter,
    searchQuery,
    minAmount,
    maxAmount
  ])

  const toggleRowExpansion = (poId: string) => {
    setExpandedRows(prev => {
      const newSet = new Set(prev)
      if (newSet.has(poId)) {
        newSet.delete(poId)
      } else {
        newSet.add(poId)
      }
      return newSet
    })
  }

  const exportToCSV = () => {
    const headers = ['ID', 'Tipo', 'Estado', 'Monto', 'Real', 'Fecha', 'Método', 'Activo']
    const rows = filteredPurchaseOrders.map(po => [
      po.order_id,
      po.po_type || 'N/A',
      po.enhanced_status || po.status || 'N/A',
      po.total_amount || 0,
      po.actual_amount || '',
      po.posting_date || po.purchase_date || po.created_at,
      po.payment_method || '',
      po.work_orders?.assets?.asset_id || po.work_orders?.assets?.name || ''
    ])

    const csvContent = [
      headers.join(','),
      ...rows.map(row => row.map(cell => `"${cell}"`).join(','))
    ].join('\n')

    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' })
    const link = document.createElement('a')
    link.href = URL.createObjectURL(blob)
    link.download = `ordenes_${supplier.name}_${new Date().toISOString().split('T')[0]}.csv`
    link.click()
  }

  return (
    <div className="space-y-6">
      {/* Enhanced Header */}
      <div className="sticky top-0 z-10 bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60 pb-4 border-b">
        <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
          <div className="space-y-2 flex-1">
            <div className="flex items-center gap-3 flex-wrap">
              <h2 className="text-3xl font-bold tracking-tight">{displaySupplier.name}</h2>
              {getStatusBadge(displaySupplier.status)}
              {getTypeBadge(displaySupplier.supplier_type)}
            </div>
            {displaySupplier.business_name && (
              <p className="text-lg text-muted-foreground">{displaySupplier.business_name}</p>
            )}
            <div className="flex items-center gap-4 text-sm text-muted-foreground flex-wrap">
              {displaySupplier.industry && (
                <div className="flex items-center gap-1">
                  <Building className="w-4 h-4" />
                  {displaySupplier.industry}
                </div>
              )}
              {displaySupplier.city && displaySupplier.state && (
                <div className="flex items-center gap-1">
                  <MapPin className="w-4 h-4" />
                  {displaySupplier.city}, {displaySupplier.state}
                </div>
              )}
              {primaryContact && (
                <div className="flex items-center gap-1">
                  <Users className="w-4 h-4" />
                  {primaryContact.name}
                </div>
              )}
            </div>
          </div>
          <div className="flex gap-2 flex-shrink-0">
            <Button variant="outline" onClick={() => onEdit?.(supplier)}>
              <Edit className="w-4 h-4 mr-2" />
              Editar
            </Button>
            <Button variant="outline" onClick={() => window.open(`/suppliers/analytics`, '_blank')}>
              <BarChart3 className="w-4 h-4 mr-2" />
              Ver Análisis
            </Button>
            {onClose && (
              <Button variant="outline" onClick={onClose}>
                Cerrar
              </Button>
            )}
          </div>
        </div>
      </div>

      {/* Key Metrics Cards - 6 Cards with Trends */}
      {loading ? (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {[...Array(6)].map((_, i) => (
            <Card key={i} className="animate-pulse">
              <CardContent className="p-6">
                <div className="h-20 bg-muted rounded" />
              </CardContent>
            </Card>
          ))}
        </div>
      ) : metrics ? (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {/* Total Spending */}
          <Card className="hover:shadow-md transition-shadow">
            <CardContent className="p-6">
              <div className="flex items-start justify-between">
                <div className="space-y-1">
                  <p className="text-sm font-medium text-muted-foreground">Gasto Total</p>
                  <p className="text-3xl font-bold">{formatAmount(metrics.totalSpending)}</p>
                  <div className="flex items-center gap-2 text-xs">
                    <span className="text-muted-foreground">Últimos 12 meses:</span>
                    <span className="font-semibold">{formatAmount(metrics.totalSpendingLast12Months)}</span>
                  </div>
                </div>
                <DollarSign className="w-8 h-8 text-green-500 flex-shrink-0" />
              </div>
              {metrics.spendingChangePercent !== 0 && (
                <div className={`flex items-center gap-1 mt-3 text-sm ${getTrendColor(metrics.spendingTrend)}`}>
                  {getTrendIcon(metrics.spendingTrend)}
                  <span className="font-medium">
                    {metrics.spendingChangePercent > 0 ? '+' : ''}{metrics.spendingChangePercent}%
                  </span>
                  <span className="text-muted-foreground">vs período anterior</span>
                </div>
              )}
            </CardContent>
          </Card>

          {/* Average Order Size */}
          <Card className="hover:shadow-md transition-shadow">
            <CardContent className="p-6">
              <div className="flex items-start justify-between">
                <div className="space-y-1">
                  <p className="text-sm font-medium text-muted-foreground">Tamaño Promedio</p>
                  <p className="text-3xl font-bold">{formatAmount(metrics.averageOrderSize)}</p>
                  <p className="text-xs text-muted-foreground">Por orden</p>
                </div>
                <TrendingUpIcon className="w-8 h-8 text-blue-500 flex-shrink-0" />
              </div>
              {metrics.averageOrderSizeTrend !== 'stable' && (
                <div className={`flex items-center gap-1 mt-3 text-sm ${getTrendColor(metrics.averageOrderSizeTrend)}`}>
                  {getTrendIcon(metrics.averageOrderSizeTrend)}
                  <span className="font-medium">
                    {metrics.averageOrderSizeTrend === 'increasing' ? 'Aumentando' : 'Disminuyendo'}
                  </span>
                </div>
              )}
            </CardContent>
          </Card>

          {/* Total Orders */}
          <Card className="hover:shadow-md transition-shadow">
            <CardContent className="p-6">
              <div className="flex items-start justify-between">
                <div className="space-y-1">
                  <p className="text-sm font-medium text-muted-foreground">Total de Órdenes</p>
                  <p className="text-3xl font-bold">{metrics.totalOrders}</p>
                  <div className="flex items-center gap-2 text-xs">
                    <span className="text-muted-foreground">Últimos 12 meses:</span>
                    <span className="font-semibold">{metrics.ordersLast12Months}</span>
                  </div>
                </div>
                <Package className="w-8 h-8 text-purple-500 flex-shrink-0" />
              </div>
              <div className="flex items-center gap-2 mt-3 text-sm">
                <span className="text-muted-foreground">Promedio:</span>
                <span className="font-medium">{metrics.ordersPerMonth.toFixed(1)} órdenes/mes</span>
                {metrics.ordersGrowthRate !== 0 && (
                  <span className={`${getTrendColor(metrics.ordersGrowthRate > 0 ? 'increasing' : 'decreasing')}`}>
                    ({metrics.ordersGrowthRate > 0 ? '+' : ''}{metrics.ordersGrowthRate.toFixed(1)}%)
                  </span>
                )}
              </div>
            </CardContent>
          </Card>

          {/* Unique Units Fixed */}
          <Card className="hover:shadow-md transition-shadow">
            <CardContent className="p-6">
              <div className="flex items-start justify-between">
                <div className="space-y-1">
                  <p className="text-sm font-medium text-muted-foreground">Unidades Reparadas</p>
                  <p className="text-3xl font-bold">{metrics.uniqueUnitsFixed}</p>
                  <p className="text-xs text-muted-foreground">Activos únicos</p>
                </div>
                <Wrench className="w-8 h-8 text-orange-500 flex-shrink-0" />
              </div>
              {metrics.assetsFixed.length > 0 && (
                <div className="mt-3 text-xs text-muted-foreground">
                  {metrics.assetsFixed.slice(0, 3).map((asset, idx) => (
                    <span key={asset.assetId}>
                      {asset.assetName}
                      {idx < Math.min(2, metrics.assetsFixed.length - 1) && ', '}
                    </span>
                  ))}
                  {metrics.assetsFixed.length > 3 && ` +${metrics.assetsFixed.length - 3} más`}
                </div>
              )}
            </CardContent>
          </Card>

          {/* Average Delivery Time */}
          <Card className="hover:shadow-md transition-shadow">
            <CardContent className="p-6">
              <div className="flex items-start justify-between">
                <div className="space-y-1">
                  <p className="text-sm font-medium text-muted-foreground">Tiempo de Entrega</p>
                  <p className="text-3xl font-bold">
                    {metrics.averageDeliveryTime !== null ? `${metrics.averageDeliveryTime} días` : 'N/A'}
                  </p>
                  <p className="text-xs text-muted-foreground">Promedio</p>
                </div>
                <Clock className="w-8 h-8 text-cyan-500 flex-shrink-0" />
              </div>
            </CardContent>
          </Card>

          {/* Issues Count */}
          <Card className={`hover:shadow-md transition-shadow ${metrics.unresolvedIssuesCount > 0 ? 'border-red-200 bg-red-50/50' : ''}`}>
            <CardContent className="p-6">
              <div className="flex items-start justify-between">
                <div className="space-y-1">
                  <p className="text-sm font-medium text-muted-foreground">Problemas Reportados</p>
                  <p className="text-3xl font-bold">{metrics.issuesCount}</p>
                  {metrics.unresolvedIssuesCount > 0 && (
                    <div className="flex items-center gap-2 text-xs">
                      <Badge variant="destructive" className="text-xs">
                        {metrics.unresolvedIssuesCount} sin resolver
                      </Badge>
                    </div>
                  )}
                </div>
                <AlertCircle className={`w-8 h-8 flex-shrink-0 ${metrics.unresolvedIssuesCount > 0 ? 'text-red-500' : 'text-gray-400'}`} />
              </div>
              {metrics.issuesPerOrderRatio > 0 && (
                <div className="mt-3 text-xs text-muted-foreground">
                  {metrics.issuesPerOrderRatio}% de las órdenes
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {[...Array(6)].map((_, i) => (
            <Card key={i}>
              <CardContent className="p-6">
                <div className="text-center text-muted-foreground">
                  <p className="text-sm">Sin datos disponibles</p>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <Tabs defaultValue="overview" className="space-y-4">
        <TabsList>
          <TabsTrigger value="overview">Información General</TabsTrigger>
          <TabsTrigger value="contacts">Contactos</TabsTrigger>
          <TabsTrigger value="services">Servicios</TabsTrigger>
          <TabsTrigger value="orders">
            Órdenes de Compra
            {metrics && metrics.issuesCount > 0 && (
              <Badge variant="destructive" className="ml-2">
                {metrics.issuesCount}
              </Badge>
            )}
          </TabsTrigger>
          {showWorkHistory && <TabsTrigger value="work-history">Historial de Trabajo</TabsTrigger>}
          {showPerformanceHistory && <TabsTrigger value="performance">Rendimiento</TabsTrigger>}
          <TabsTrigger value="issues">
            Problemas
            {metrics && metrics.unresolvedIssuesCount > 0 && (
              <Badge variant="destructive" className="ml-2">
                {metrics.unresolvedIssuesCount}
              </Badge>
            )}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="overview" className="space-y-4">
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            {/* Contact Information */}
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Users className="w-5 h-5" />
                  Información de Contacto
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                {primaryContact ? (
                  <>
                    <div>
                      <p className="text-sm font-medium">Contacto Principal</p>
                      <p className="font-semibold">{primaryContact.name}</p>
                      {primaryContact.position && (
                        <p className="text-sm text-muted-foreground">{primaryContact.position}</p>
                      )}
                    </div>
                    <div className="space-y-2">
                      {primaryContact.email && (
                        <div className="flex items-center gap-2">
                          <Mail className="w-4 h-4 text-muted-foreground" />
                          <a href={`mailto:${primaryContact.email}`} className="text-blue-600 hover:underline">
                            {primaryContact.email}
                          </a>
                        </div>
                      )}
                      {primaryContact.phone && (
                        <div className="flex items-center gap-2">
                          <Phone className="w-4 h-4 text-muted-foreground" />
                          <a href={`tel:${primaryContact.phone}`} className="text-blue-600 hover:underline">
                            {primaryContact.phone}
                          </a>
                        </div>
                      )}
                      {primaryContact.mobile_phone && (
                        <div className="flex items-center gap-2">
                          <Phone className="w-4 h-4 text-muted-foreground" />
                          <a href={`tel:${primaryContact.mobile_phone}`} className="text-blue-600 hover:underline">
                            {primaryContact.mobile_phone}
                          </a>
                        </div>
                      )}
                    </div>
                  </>
                ) : (
                  <p className="text-muted-foreground">No hay contacto principal asignado</p>
                )}
              </CardContent>
            </Card>

            {/* Business Information */}
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Building className="w-5 h-5" />
                  Información Empresarial
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div>
                  <p className="text-sm font-medium">Tipo de Proveedor</p>
                  <p className="capitalize">{displaySupplier.supplier_type.replace('_', ' ')}</p>
                </div>
                {displaySupplier.industry && (
                  <div>
                    <p className="text-sm font-medium">Industria</p>
                    <p>{displaySupplier.industry}</p>
                  </div>
                )}
                {displaySupplier.specialties && displaySupplier.specialties.length > 0 && (
                  <div>
                    <p className="text-sm font-medium">Especialidades</p>
                    <div className="flex flex-wrap gap-1 mt-1">
                      {displaySupplier.specialties.map((specialty, index) => (
                        <Badge key={index} variant="outline" className="text-xs">
                          {specialty}
                        </Badge>
                      ))}
                    </div>
                  </div>
                )}
                {displaySupplier.payment_terms && (
                  <div>
                    <p className="text-sm font-medium">Términos de Pago</p>
                    <p className="capitalize">{displaySupplier.payment_terms.replace('_', ' ')}</p>
                  </div>
                )}
              </CardContent>
            </Card>
          </div>

          {/* Address */}
          {displaySupplier.address && (
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <MapPin className="w-5 h-5" />
                  Dirección
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="space-y-1">
                  <p>{displaySupplier.address}</p>
                  {displaySupplier.city && displaySupplier.state && (
                    <p>{displaySupplier.city}, {displaySupplier.state} {displaySupplier.postal_code}</p>
                  )}
                  {displaySupplier.country && displaySupplier.country !== 'México' && (
                    <p>{displaySupplier.country}</p>
                  )}
                </div>
              </CardContent>
            </Card>
          )}
        </TabsContent>

        <TabsContent value="contacts">
          <Card>
            <CardHeader>
              <CardTitle>Contactos</CardTitle>
              <CardDescription>
                Todos los contactos registrados para este proveedor
              </CardDescription>
            </CardHeader>
            <CardContent>
              {contacts.length > 0 ? (
                <div className="space-y-4">
                  {contacts.map((contact) => (
                    <div key={contact.id} className="border rounded-lg p-4">
                      <div className="flex items-start justify-between">
                        <div className="space-y-1">
                          <div className="flex items-center gap-2">
                            <h4 className="font-semibold">{contact.name}</h4>
                            {contact.is_primary && (
                              <Badge variant="default" className="text-xs">Principal</Badge>
                            )}
                            <Badge variant="outline" className="text-xs">
                              {contact.contact_type}
                            </Badge>
                          </div>
                          {contact.position && (
                            <p className="text-sm text-muted-foreground">{contact.position}</p>
                          )}
                          <div className="flex gap-4 text-sm">
                            {contact.email && (
                              <a href={`mailto:${contact.email}`} className="flex items-center gap-1 text-blue-600 hover:underline">
                                <Mail className="w-3 h-3" />
                                {contact.email}
                              </a>
                            )}
                            {contact.phone && (
                              <a href={`tel:${contact.phone}`} className="flex items-center gap-1 text-blue-600 hover:underline">
                                <Phone className="w-3 h-3" />
                                {contact.phone}
                              </a>
                            )}
                          </div>
                        </div>
                        <div className="flex gap-2">
                          <Button variant="outline" size="sm">
                            <MessageSquare className="w-3 h-3 mr-1" />
                            Contactar
                          </Button>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-muted-foreground text-center py-4">
                  No hay contactos registrados
                </p>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="services">
          <Card>
            <CardHeader>
              <CardTitle>Servicios Ofrecidos</CardTitle>
              <CardDescription>
                Servicios y productos disponibles de este proveedor
              </CardDescription>
            </CardHeader>
            <CardContent>
              {activeServices.length > 0 ? (
                <div className="space-y-4">
                  {activeServices.map((service) => (
                    <div key={service.id} className="border rounded-lg p-4">
                      <div className="flex items-start justify-between">
                        <div className="space-y-2">
                          <div className="flex items-center gap-2">
                            <h4 className="font-semibold">{service.service_name}</h4>
                            <Badge variant="outline">{service.service_category}</Badge>
                          </div>
                          {service.description && (
                            <p className="text-sm text-muted-foreground">{service.description}</p>
                          )}
                          <div className="flex gap-4 text-sm text-muted-foreground">
                            {service.unit_cost && (
                              <div className="flex items-center gap-1">
                                <DollarSign className="w-3 h-3" />
                                ${service.unit_cost} / {service.unit_of_measure}
                              </div>
                            )}
                            {service.lead_time_days && (
                              <div className="flex items-center gap-1">
                                <Clock className="w-3 h-3" />
                                {service.lead_time_days} días de entrega
                              </div>
                            )}
                            {service.warranty_period && (
                              <div className="flex items-center gap-1">
                                <Award className="w-3 h-3" />
                                Garantía: {service.warranty_period}
                              </div>
                            )}
                          </div>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-muted-foreground text-center py-4">
                  No hay servicios registrados
                </p>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="orders" className="space-y-6">
          {/* Charts Section */}
          {loading ? (
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              {[...Array(3)].map((_, i) => (
                <Card key={i} className="animate-pulse">
                  <CardHeader>
                    <div className="h-6 bg-muted rounded w-1/3" />
                    <div className="h-4 bg-muted rounded w-1/2 mt-2" />
                  </CardHeader>
                  <CardContent>
                    <div className="h-64 bg-muted rounded" />
                  </CardContent>
                </Card>
              ))}
            </div>
          ) : metrics && purchaseOrders.length > 0 ? (
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              {/* Monthly Spending Chart */}
              {metrics.monthlySpending.length > 0 && (
                <Card>
                  <CardHeader>
                    <CardTitle className="text-lg">Gasto Mensual</CardTitle>
                    <CardDescription>Últimos 12 meses</CardDescription>
                  </CardHeader>
                  <CardContent>
                    <ResponsiveContainer width="100%" height={300}>
                      <BarChart data={metrics.monthlySpending}>
                        <CartesianGrid strokeDasharray="3 3" />
                        <XAxis dataKey="month" />
                        <YAxis />
                        <Tooltip 
                          formatter={(value: number) => formatAmount(value)}
                          labelFormatter={(label) => `Mes: ${label}`}
                        />
                        <Bar dataKey="amount" fill="#10b981" name="Gasto" />
                      </BarChart>
                    </ResponsiveContainer>
                    {metrics.monthlySpending.length > 0 && (
                      <div className="mt-4 grid grid-cols-3 gap-4 text-sm">
                        <div>
                          <p className="text-muted-foreground">Mes más alto</p>
                          <p className="font-semibold">
                            {metrics.monthlySpending.reduce((max, m) => m.amount > max.amount ? m : max).month}
                          </p>
                        </div>
                        <div>
                          <p className="text-muted-foreground">Promedio mensual</p>
                          <p className="font-semibold">
                            {formatAmount(
                              metrics.monthlySpending.reduce((sum, m) => sum + m.amount, 0) / metrics.monthlySpending.length
                            )}
                          </p>
                        </div>
                        <div>
                          <p className="text-muted-foreground">Tendencia</p>
                          <p className={`font-semibold ${getTrendColor(metrics.spendingTrend)}`}>
                            {metrics.spendingTrend === 'increasing' ? '↑ Aumentando' : 
                             metrics.spendingTrend === 'decreasing' ? '↓ Disminuyendo' : '→ Estable'}
                          </p>
                        </div>
                      </div>
                    )}
                  </CardContent>
                </Card>
              )}

              {/* Spending Trends Line Chart */}
              {metrics.spendingTrends.length > 0 && (
                <Card>
                  <CardHeader>
                    <CardTitle className="text-lg">Tendencias de Gasto</CardTitle>
                    <CardDescription>Comparación por períodos</CardDescription>
                  </CardHeader>
                  <CardContent>
                    <ResponsiveContainer width="100%" height={300}>
                      <LineChart data={metrics.spendingTrends}>
                        <CartesianGrid strokeDasharray="3 3" />
                        <XAxis dataKey="period" />
                        <YAxis />
                        <Tooltip 
                          formatter={(value: number) => formatAmount(value)}
                          labelFormatter={(label) => `Período: ${label}`}
                        />
                        <Legend />
                        <Line 
                          type="monotone" 
                          dataKey="amount" 
                          stroke="#4f46e5" 
                          strokeWidth={2}
                          name="Gasto"
                          dot={{ r: 4 }}
                        />
                      </LineChart>
                    </ResponsiveContainer>
                    <div className="mt-4 space-y-2">
                      {metrics.spendingTrends.map((trend) => (
                        <div key={trend.period} className="flex items-center justify-between text-sm">
                          <span className="text-muted-foreground">{trend.period}:</span>
                          <div className="flex items-center gap-2">
                            <span className="font-semibold">{formatAmount(trend.amount)}</span>
                            {trend.changePercent !== 0 && (
                              <span className={getTrendColor(trend.trend)}>
                                ({trend.changePercent > 0 ? '+' : ''}{trend.changePercent}%)
                              </span>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                  </CardContent>
                </Card>
              )}

              {/* Work Order Types Breakdown */}
              {metrics.workOrderTypes.length > 0 && (
                <Card>
                  <CardHeader>
                    <CardTitle className="text-lg">Tipos de Trabajo</CardTitle>
                    <CardDescription>Distribución por tipo</CardDescription>
                  </CardHeader>
                  <CardContent>
                    <ResponsiveContainer width="100%" height={300}>
                      <PieChart>
                        <Pie
                          data={metrics.workOrderTypes}
                          dataKey="totalSpending"
                          nameKey="type"
                          cx="50%"
                          cy="50%"
                          outerRadius={80}
                          label={(entry) => `${entry.type}: ${formatAmount(entry.totalSpending)}`}
                        >
                          {metrics.workOrderTypes.map((entry, index) => (
                            <Cell key={`cell-${index}`} fill={['#4f46e5', '#f97316', '#10b981', '#6366f1', '#ec4899'][index % 5]} />
                          ))}
                        </Pie>
                        <Tooltip formatter={(value: number) => formatAmount(value)} />
                        <Legend />
                      </PieChart>
                    </ResponsiveContainer>
                    <div className="mt-4 space-y-2">
                      {metrics.workOrderTypes.slice(0, 3).map((type) => (
                        <div key={type.type} className="flex items-center justify-between text-sm">
                          <span className="capitalize">{type.type}:</span>
                          <div className="flex items-center gap-2">
                            <span className="font-semibold">{formatAmount(type.totalSpending)}</span>
                            <span className="text-muted-foreground">({type.count} órdenes)</span>
                          </div>
                        </div>
                      ))}
                    </div>
                  </CardContent>
                </Card>
              )}
            </div>
          ) : (
            <Card>
              <CardContent className="py-12">
                <div className="text-center">
                  <BarChart3 className="w-12 h-12 text-muted-foreground mx-auto mb-4" />
                  <p className="text-muted-foreground font-medium">No hay datos suficientes para mostrar gráficos</p>
                  <p className="text-sm text-muted-foreground mt-2">
                    Se necesitan al menos algunas órdenes de compra para generar análisis
                  </p>
                </div>
              </CardContent>
            </Card>
          )}

          {/* Filters and Search */}
          <Card>
            <CardHeader>
              <div className="flex items-center justify-between">
                <div>
                  <CardTitle>Órdenes de Compra</CardTitle>
                  <CardDescription>
                    {filteredPurchaseOrders.length} de {purchaseOrders.length} órdenes
                  </CardDescription>
                </div>
                <div className="flex gap-2">
                  <Button variant="outline" size="sm" onClick={exportToCSV}>
                    <Download className="w-4 h-4 mr-2" />
                    Exportar CSV
                  </Button>
                </div>
              </div>
            </CardHeader>
            <CardContent className="space-y-4">
              {/* Filters Row */}
              <div className="flex flex-wrap gap-4 items-end">
                <div className="flex-1 min-w-[200px]">
                  <Label htmlFor="search">Buscar</Label>
                  <div className="relative">
                    <Search className="absolute left-2 top-2.5 h-4 w-4 text-muted-foreground" />
                    <Input
                      id="search"
                      placeholder="Buscar por ID, activo..."
                      value={searchQuery}
                      onChange={(e) => setSearchQuery(e.target.value)}
                      className="pl-8"
                    />
                  </div>
                </div>
                <div className="min-w-[150px]">
                  <Label>Período</Label>
                  <Select value={dateFilter} onValueChange={(value: any) => setDateFilter(value)}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="30d">Últimos 30 días</SelectItem>
                      <SelectItem value="3mo">Últimos 3 meses</SelectItem>
                      <SelectItem value="1y">Último año</SelectItem>
                      <SelectItem value="all">Todo</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="flex gap-2">
                  <Input
                    type="number"
                    placeholder="Monto mín"
                    value={minAmount || ''}
                    onChange={(e) => setMinAmount(e.target.value ? Number(e.target.value) : null)}
                    className="w-32"
                  />
                  <Input
                    type="number"
                    placeholder="Monto máx"
                    value={maxAmount || ''}
                    onChange={(e) => setMaxAmount(e.target.value ? Number(e.target.value) : null)}
                    className="w-32"
                  />
                </div>
                {(dateFilter !== 'all' || statusFilter.length > 0 || typeFilter.length > 0 || searchQuery || minAmount !== null || maxAmount !== null) && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      setDateFilter('1y')
                      setStatusFilter([])
                      setTypeFilter([])
                      setSearchQuery('')
                      setMinAmount(null)
                      setMaxAmount(null)
                    }}
                  >
                    <X className="w-4 h-4 mr-2" />
                    Limpiar
                  </Button>
                )}
              </div>

              {/* Purchase Orders Table */}
              {loading ? (
                <div className="flex items-center justify-center py-12">
                  <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
                  <span className="ml-2 text-sm">Cargando órdenes...</span>
                </div>
              ) : filteredPurchaseOrders.length > 0 ? (
                <div className="overflow-x-auto -mx-4 px-4 md:mx-0 md:px-0">
                  <div className="min-w-full">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead className="w-12 hidden sm:table-cell"></TableHead>
                          <TableHead>ID</TableHead>
                          <TableHead className="hidden md:table-cell">Tipo</TableHead>
                          <TableHead>Estado</TableHead>
                          <TableHead className="text-right">Monto</TableHead>
                          <TableHead className="text-right hidden lg:table-cell">Real</TableHead>
                          <TableHead className="hidden md:table-cell">Fecha</TableHead>
                          <TableHead className="hidden lg:table-cell">Activo</TableHead>
                          <TableHead className="hidden xl:table-cell">Método</TableHead>
                          <TableHead className="w-24">Acciones</TableHead>
                        </TableRow>
                      </TableHeader>
                    <TableBody>
                      {filteredPurchaseOrders.map((po) => {
                        const status = getPurchaseOrderStatus(po.status, po.enhanced_status)
                        const isExpanded = expandedRows.has(po.id)
                        const asset = po.work_orders?.assets
                        return (
                          <React.Fragment key={po.id}>
                            <TableRow className="cursor-pointer hover:bg-muted/50" onClick={() => toggleRowExpansion(po.id)}>
                              <TableCell className="hidden sm:table-cell">
                                {isExpanded ? (
                                  <ChevronDown className="w-4 h-4" />
                                ) : (
                                  <ChevronRight className="w-4 h-4" />
                                )}
                              </TableCell>
                              <TableCell className="font-medium">
                                <div className="flex flex-col">
                                  <span>{po.order_id}</span>
                                  <span className="text-xs text-muted-foreground md:hidden">
                                    {po.posting_date
                                      ? new Date(po.posting_date).toLocaleDateString('es-MX', { 
                                          month: 'short', 
                                          day: 'numeric' 
                                        })
                                      : po.purchase_date
                                      ? new Date(po.purchase_date).toLocaleDateString('es-MX', { 
                                          month: 'short', 
                                          day: 'numeric' 
                                        })
                                      : new Date(po.created_at).toLocaleDateString('es-MX', { 
                                          month: 'short', 
                                          day: 'numeric' 
                                        })}
                                  </span>
                                </div>
                              </TableCell>
                              <TableCell className="capitalize text-sm hidden md:table-cell">
                                {po.po_type?.replace('_', ' ') || 'N/A'}
                              </TableCell>
                              <TableCell>
                                <Badge variant={status.variant}>{status.label}</Badge>
                              </TableCell>
                              <TableCell className="text-right font-medium">
                                {formatAmount(po.total_amount)}
                              </TableCell>
                              <TableCell className="text-right text-muted-foreground hidden lg:table-cell">
                                {po.actual_amount ? formatAmount(po.actual_amount) : '—'}
                              </TableCell>
                              <TableCell className="text-sm hidden md:table-cell">
                                {po.posting_date
                                  ? new Date(po.posting_date).toLocaleDateString('es-MX', { 
                                      year: 'numeric', 
                                      month: 'short', 
                                      day: 'numeric' 
                                    })
                                  : po.purchase_date
                                  ? new Date(po.purchase_date).toLocaleDateString('es-MX', { 
                                      year: 'numeric', 
                                      month: 'short', 
                                      day: 'numeric' 
                                    })
                                  : new Date(po.created_at).toLocaleDateString('es-MX', { 
                                      year: 'numeric', 
                                      month: 'short', 
                                      day: 'numeric' 
                                    })}
                              </TableCell>
                              <TableCell className="hidden lg:table-cell">
                                {asset ? (
                                  <div className="flex flex-col">
                                    <span className="font-medium text-sm">{asset.asset_id || asset.name || 'N/A'}</span>
                                    {asset.name && asset.name !== asset.asset_id && (
                                      <span className="text-xs text-muted-foreground">{asset.name}</span>
                                    )}
                                    {asset.equipment_models && (
                                      <span className="text-xs text-muted-foreground">
                                        {asset.equipment_models.manufacturer} {asset.equipment_models.name}
                                      </span>
                                    )}
                                  </div>
                                ) : (
                                  <span className="text-muted-foreground text-sm">—</span>
                                )}
                              </TableCell>
                              <TableCell className="capitalize text-sm text-muted-foreground hidden xl:table-cell">
                                {po.payment_method || '—'}
                              </TableCell>
                              <TableCell onClick={(e) => e.stopPropagation()}>
                                <div className="flex gap-1">
                                  <Button
                                    variant="ghost"
                                    size="sm"
                                    onClick={() => {
                                      setSelectedPOForIssue(po)
                                      setReportIssueOpen(true)
                                    }}
                                    title="Reportar Problema"
                                    aria-label="Reportar problema con esta orden"
                                  >
                                    <AlertCircle className="w-4 h-4 text-orange-500" />
                                  </Button>
                                  <Button
                                    variant="ghost"
                                    size="sm"
                                    onClick={() => window.open(`/compras/${po.id}`, '_blank')}
                                    title="Ver Detalles"
                                    aria-label="Ver detalles de la orden"
                                  >
                                    <ExternalLink className="w-4 h-4" />
                                  </Button>
                                </div>
                              </TableCell>
                            </TableRow>
                            {isExpanded && (
                              <TableRow>
                                <TableCell colSpan={10} className="bg-muted/30">
                                  <div className="p-4 space-y-3">
                                    <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
                                      <div>
                                        <p className="text-muted-foreground">Orden ID</p>
                                        <p className="font-medium">{po.order_id}</p>
                                      </div>
                                      <div>
                                        <p className="text-muted-foreground">Tipo</p>
                                        <p className="font-medium capitalize">{po.po_type?.replace('_', ' ') || 'N/A'}</p>
                                      </div>
                                      <div>
                                        <p className="text-muted-foreground">Estado</p>
                                        <Badge variant={status.variant}>{status.label}</Badge>
                                      </div>
                                      <div>
                                        <p className="text-muted-foreground">Método de Pago</p>
                                        <p className="font-medium capitalize">{po.payment_method || '—'}</p>
                                      </div>
                                    </div>
                                    {asset && (
                                      <div className="border-t pt-3">
                                        <p className="text-sm font-medium mb-2">Información del Activo</p>
                                        <div className="grid grid-cols-2 md:grid-cols-3 gap-4 text-sm">
                                          <div>
                                            <p className="text-muted-foreground">ID del Activo</p>
                                            <p className="font-medium">{asset.asset_id || asset.name || 'N/A'}</p>
                                          </div>
                                          {asset.name && asset.name !== asset.asset_id && (
                                            <div>
                                              <p className="text-muted-foreground">Nombre</p>
                                              <p className="font-medium">{asset.name}</p>
                                            </div>
                                          )}
                                          {asset.equipment_models && (
                                            <>
                                              <div>
                                                <p className="text-muted-foreground">Modelo</p>
                                                <p className="font-medium">{asset.equipment_models.name || 'N/A'}</p>
                                              </div>
                                              <div>
                                                <p className="text-muted-foreground">Fabricante</p>
                                                <p className="font-medium">{asset.equipment_models.manufacturer || 'N/A'}</p>
                                              </div>
                                            </>
                                          )}
                                        </div>
                                        <Button
                                          variant="outline"
                                          size="sm"
                                          className="mt-2"
                                          onClick={() => window.open(`/activos/${asset.id}`, '_blank')}
                                        >
                                          Ver Detalles del Activo
                                        </Button>
                                      </div>
                                    )}
                                    {po.work_orders && (
                                      <div className="border-t pt-3">
                                        <p className="text-sm font-medium mb-2">Información de la Orden de Trabajo</p>
                                        <div className="grid grid-cols-2 md:grid-cols-3 gap-4 text-sm">
                                          <div>
                                            <p className="text-muted-foreground">Tipo de Trabajo</p>
                                            <p className="font-medium capitalize">{po.work_orders.type || 'N/A'}</p>
                                          </div>
                                        </div>
                                        {po.work_orders.id && (
                                          <Button
                                            variant="outline"
                                            size="sm"
                                            className="mt-2"
                                            onClick={() => window.open(`/ordenes/${po.work_orders.id}`, '_blank')}
                                          >
                                            Ver Orden de Trabajo
                                          </Button>
                                        )}
                                      </div>
                                    )}
                                    <div className="flex gap-2 pt-2 border-t">
                                      <Button
                                        variant="outline"
                                        size="sm"
                                        onClick={() => window.open(`/compras/${po.id}`, '_blank')}
                                      >
                                        <ExternalLink className="w-4 h-4 mr-2" />
                                        Ver Detalles Completos
                                      </Button>
                                    </div>
                                  </div>
                                </TableCell>
                              </TableRow>
                            )}
                          </React.Fragment>
                        )
                      })}
                    </TableBody>
                    </Table>
                  </div>
                </div>
              ) : purchaseOrders.length > 0 ? (
                <div className="text-center py-12">
                  <Filter className="w-12 h-12 text-muted-foreground mx-auto mb-4" />
                  <p className="text-muted-foreground font-medium">No se encontraron órdenes con los filtros aplicados</p>
                  <Button
                    variant="outline"
                    size="sm"
                    className="mt-4"
                    onClick={() => {
                      setDateFilter('1y')
                      setStatusFilter([])
                      setTypeFilter([])
                      setSearchQuery('')
                      setMinAmount(null)
                      setMaxAmount(null)
                    }}
                  >
                    Limpiar Filtros
                  </Button>
                </div>
              ) : (
                <div className="text-center py-12">
                  <Package className="w-12 h-12 text-muted-foreground mx-auto mb-4" />
                  <p className="text-muted-foreground font-medium">No hay órdenes registradas para este proveedor</p>
                  <p className="text-sm text-muted-foreground mt-2">
                    Las órdenes de compra aparecerán aquí cuando se asocien a este proveedor
                  </p>
                </div>
              )}
            </CardContent>
          </Card>

          {/* Units Fixed Section */}
          {metrics && metrics.assetsFixed.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle>Unidades Reparadas</CardTitle>
                <CardDescription>
                  {metrics.uniqueUnitsFixed} activos únicos han sido reparados por este proveedor
                </CardDescription>
              </CardHeader>
              <CardContent>
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                  {metrics.assetsFixed.slice(0, 12).map((asset) => (
                    <Card key={asset.assetId} className="hover:shadow-md transition-shadow">
                      <CardContent className="p-4">
                        <div className="space-y-2">
                          <div className="flex items-start justify-between">
                            <div className="flex-1">
                              <p className="font-medium">{asset.assetName}</p>
                              {asset.modelName && (
                                <p className="text-sm text-muted-foreground">
                                  {asset.manufacturer} {asset.modelName}
                                </p>
                              )}
                            </div>
                            <Wrench className="w-5 h-5 text-orange-500 flex-shrink-0" />
                          </div>
                          <div className="grid grid-cols-2 gap-2 text-sm pt-2 border-t">
                            <div>
                              <p className="text-muted-foreground">Órdenes</p>
                              <p className="font-semibold">{asset.orderCount}</p>
                            </div>
                            <div>
                              <p className="text-muted-foreground">Total</p>
                              <p className="font-semibold">{formatAmount(asset.totalSpending)}</p>
                            </div>
                            <div>
                              <p className="text-muted-foreground">Promedio</p>
                              <p className="font-semibold">{formatAmount(asset.averageCost)}</p>
                            </div>
                            <div>
                              <p className="text-muted-foreground">Último Servicio</p>
                              <p className="font-semibold text-xs">
                                {asset.lastServiceDate
                                  ? new Date(asset.lastServiceDate).toLocaleDateString('es-MX', { 
                                      month: 'short', 
                                      day: 'numeric',
                                      year: 'numeric'
                                    })
                                  : 'N/A'}
                              </p>
                            </div>
                          </div>
                          <Button
                            variant="outline"
                            size="sm"
                            className="w-full mt-2"
                            onClick={() => {
                              const poWithAsset = purchaseOrders.find(po => po.work_orders?.assets?.id === asset.assetId)
                              if (poWithAsset?.work_orders?.assets?.id) {
                                window.open(`/activos/${poWithAsset.work_orders.assets.id}`, '_blank')
                              }
                            }}
                          >
                            Ver Activo
                          </Button>
                        </div>
                      </CardContent>
                    </Card>
                  ))}
                </div>
                {metrics.assetsFixed.length > 12 && (
                  <p className="text-sm text-muted-foreground text-center mt-4">
                    Mostrando 12 de {metrics.assetsFixed.length} activos
                  </p>
                )}
              </CardContent>
            </Card>
          )}
        </TabsContent>

        {showWorkHistory && (
          <TabsContent value="work-history">
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <History className="w-5 h-5" />
                  Historial de Trabajo
                </CardTitle>
                <CardDescription>
                  Trabajos realizados por este proveedor
                </CardDescription>
              </CardHeader>
              <CardContent>
                {workHistory.length > 0 ? (
                  <div className="space-y-4">
                    {workHistory.slice(0, 10).map((work) => (
                      <div key={work.id} className="border rounded-lg p-4">
                        <div className="flex items-start justify-between">
                          <div className="space-y-2">
                            <div className="flex items-center gap-2">
                              <Badge variant="outline">{work.work_type}</Badge>
                              <span className="text-sm text-muted-foreground">
                                {new Date(work.created_at).toLocaleDateString()}
                              </span>
                            </div>
                            {work.problem_description && (
                              <p className="text-sm">{work.problem_description}</p>
                            )}
                            {work.solution_description && (
                              <p className="text-sm text-green-600">{work.solution_description}</p>
                            )}
                            <div className="flex gap-4 text-sm text-muted-foreground">
                              {work.total_cost && (
                                <span>Costo: ${work.total_cost.toLocaleString()}</span>
                              )}
                              {work.labor_hours && (
                                <span>Horas: {work.labor_hours}</span>
                              )}
                            </div>
                          </div>
                          <div className="flex items-center gap-2">
                            {work.completed_on_time && (
                              <CheckCircle className="w-4 h-4 text-green-500" />
                            )}
                            {work.quality_satisfaction && (
                              <div className="flex items-center gap-1">
                                <Star className="w-4 h-4 text-yellow-500" />
                                <span className="text-sm">{work.quality_satisfaction}/5</span>
                              </div>
                            )}
                          </div>
                        </div>
                      </div>
                    ))}
                    {workHistory.length > 10 && (
                      <p className="text-center text-sm text-muted-foreground">
                        Mostrando 10 de {workHistory.length} trabajos
                      </p>
                    )}
                  </div>
                ) : (
                  <p className="text-muted-foreground text-center py-4">
                    No hay historial de trabajo registrado
                  </p>
                )}
              </CardContent>
            </Card>
          </TabsContent>
        )}

        <TabsContent value="issues">
          <Card>
            <CardHeader>
              <div className="flex items-center justify-between">
                <div>
                  <CardTitle>Problemas Reportados</CardTitle>
                  <CardDescription>
                    {metrics ? (
                      <>
                        {metrics.issuesCount} problema{metrics.issuesCount !== 1 ? 's' : ''} reportado{metrics.issuesCount !== 1 ? 's' : ''}
                        {metrics.unresolvedIssuesCount > 0 && (
                          <span className="text-red-600 font-medium">
                            {' '}({metrics.unresolvedIssuesCount} sin resolver)
                          </span>
                        )}
                      </>
                    ) : (
                      'Historial de problemas reportados'
                    )}
                  </CardDescription>
                </div>
                <Button
                  onClick={() => {
                    setSelectedPOForIssue(null)
                    setReportIssueOpen(true)
                  }}
                >
                  <AlertCircle className="w-4 h-4 mr-2" />
                  Reportar Problema
                </Button>
              </div>
            </CardHeader>
            <CardContent>
              {loading ? (
                <div className="flex items-center justify-center py-12">
                  <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
                  <span className="ml-2 text-sm">Cargando problemas...</span>
                </div>
              ) : issues.length > 0 ? (
                <div className="space-y-4">
                  {issues
                    .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())
                    .map((issue) => {
                      const po = purchaseOrders.find(p => p.id === issue.purchaseOrderId)
                      return (
                        <Card key={issue.id} className={issue.resolved ? 'opacity-75' : ''}>
                          <CardContent className="p-4">
                            <div className="flex items-start justify-between">
                              <div className="flex-1 space-y-2">
                                <div className="flex items-center gap-2">
                                  <Badge variant={issue.resolved ? 'secondary' : 'destructive'}>
                                    {issue.resolved ? 'Resuelto' : 'Abierto'}
                                  </Badge>
                                  <span className="text-sm text-muted-foreground">
                                    {new Date(issue.date).toLocaleDateString('es-MX', {
                                      year: 'numeric',
                                      month: 'long',
                                      day: 'numeric'
                                    })}
                                  </span>
                                </div>
                                <p className="font-medium">{issue.issue}</p>
                                {po && (
                                  <div className="flex items-center gap-2 text-sm text-muted-foreground">
                                    <span>Orden:</span>
                                    <Button
                                      variant="link"
                                      className="h-auto p-0 text-sm"
                                      onClick={() => window.open(`/compras/${po.id}`, '_blank')}
                                    >
                                      {po.order_id}
                                    </Button>
                                  </div>
                                )}
                                {issue.notes && issue.notes !== issue.issue && (
                                  <p className="text-sm text-muted-foreground mt-2">{issue.notes}</p>
                                )}
                              </div>
                            </div>
                          </CardContent>
                        </Card>
                      )
                    })}
                </div>
              ) : (
                <div className="text-center py-12">
                  <CheckCircle className="w-12 h-12 text-green-500 mx-auto mb-4" />
                  <p className="text-muted-foreground font-medium">No hay problemas reportados</p>
                  <p className="text-sm text-muted-foreground mt-2">
                    Este proveedor no tiene problemas registrados
                  </p>
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {showPerformanceHistory && (
          <TabsContent value="performance">
            <div className="space-y-6">
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <BarChart3 className="w-5 h-5" />
                    Métricas de Rendimiento
                  </CardTitle>
                  <CardDescription>
                    Análisis del rendimiento histórico del proveedor
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <SupplierPerformanceChart
                supplierId={supplier.id}
                    timeRange="1y"
                    metrics={['rating', 'reliability', 'delivery_time', 'cost_accuracy']}
                  />
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle>Historial de Rendimiento</CardTitle>
                  <CardDescription>
                    Evaluaciones individuales de cada orden completada
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  {performanceHistory.length > 0 ? (
                    <div className="space-y-4">
                      {performanceHistory.slice(0, 10).map((performance) => (
                        <div key={performance.id} className="border rounded-lg p-4">
                          <div className="flex items-start justify-between">
                            <div className="space-y-2">
                              <div className="flex items-center gap-2">
                                <Calendar className="w-4 h-4 text-muted-foreground" />
                                <span className="font-medium">
                                  {new Date(performance.order_date).toLocaleDateString()}
                                </span>
                              </div>
                              <div className="flex gap-4 text-sm">
                                {performance.quality_rating && (
                                  <div className="flex items-center gap-1">
                                    <Star className="w-3 h-3 text-yellow-500" />
                                    <span>Calidad: {performance.quality_rating}/5</span>
                                  </div>
                                )}
                                {performance.delivery_rating && (
                                  <div className="flex items-center gap-1">
                                    <Clock className="w-3 h-3 text-blue-500" />
                                    <span>Entrega: {performance.delivery_rating}/5</span>
                                  </div>
                                )}
                                {performance.service_rating && (
                                  <div className="flex items-center gap-1">
                                    <CheckCircle className="w-3 h-3 text-green-500" />
                                    <span>Servicio: {performance.service_rating}/5</span>
                                  </div>
                                )}
                              </div>
                              {performance.quoted_cost && performance.actual_cost && (
                                <div className="text-sm">
                                  <span className="text-muted-foreground">Presupuesto: </span>
                                  <span className="font-medium">
                                    ${performance.quoted_cost.toLocaleString()}
                                  </span>
                                  <span className="text-muted-foreground"> | Real: </span>
                                  <span className="font-medium">
                                    ${performance.actual_cost.toLocaleString()}
                                  </span>
                                </div>
                              )}
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className="text-muted-foreground text-center py-4">
                      No hay historial de rendimiento registrado
                    </p>
                  )}
                </CardContent>
              </Card>
            </div>
          </TabsContent>
        )}
      </Tabs>

      {/* Report Issue Dialog */}
      <ReportIssueDialog
        open={reportIssueOpen}
        onOpenChange={setReportIssueOpen}
        purchaseOrderId={selectedPOForIssue?.id || ''}
        supplierId={supplier.id}
        purchaseOrderIdDisplay={selectedPOForIssue?.order_id}
        onSuccess={() => {
          loadSupplierDetails()
        }}
      />
    </div>
  )
}
