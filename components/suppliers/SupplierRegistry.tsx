"use client"

import { useState, useEffect, useMemo } from "react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  Plus,
  Search,
  Filter,
  MoreHorizontal,
  Edit,
  Eye,
  Star,
  MapPin,
  Phone,
  Mail,
  Building,
  Award,
  TrendingUp,
  AlertTriangle,
  CheckCircle,
  Clock,
  DollarSign
} from "lucide-react"
import { Supplier, SupplierService, SupplierContact } from "@/types/suppliers"
import { createClient } from "@/lib/supabase"
import { SupplierForm } from "./SupplierForm"
import { SupplierDetails } from "./SupplierDetails"
import { SupplierPerformanceChart } from "./SupplierPerformanceChart"

interface SupplierRegistryProps {
  onSupplierSelect?: (supplier: Supplier) => void
  selectedSupplierId?: string
  showSelection?: boolean
  filterByType?: string
}

type SortField = 'name' | 'rating' | 'total_orders' | 'reliability_score' | 'created_at'
type SortDirection = 'asc' | 'desc'

export function SupplierRegistry({
  onSupplierSelect,
  selectedSupplierId,
  showSelection = false,
  filterByType
}: SupplierRegistryProps) {
  const [suppliers, setSuppliers] = useState<Supplier[]>([])
  const [loading, setLoading] = useState(true)
  const [searchTerm, setSearchTerm] = useState("")
  const [statusFilter, setStatusFilter] = useState<string>("active")
  const [typeFilter, setTypeFilter] = useState<string>(filterByType || "all")
  const [sortField, setSortField] = useState<SortField>('name')
  const [sortDirection, setSortDirection] = useState<SortDirection>('asc')
  const [selectedSupplier, setSelectedSupplier] = useState<Supplier | null>(null)
  const [showCreateDialog, setShowCreateDialog] = useState(false)
  const [showDetailsDialog, setShowDetailsDialog] = useState(false)

  // Load suppliers
  useEffect(() => {
    loadSuppliers()
  }, [statusFilter, typeFilter])

  const loadSuppliers = async () => {
    setLoading(true)
    try {
      const supabase = createClient()

      let query = supabase
        .from('suppliers')
        .select(`
          id,
          name,
          business_name,
          contact_person,
          supplier_type,
          status,
          rating,
          total_orders,
          avg_order_amount,
          reliability_score,
          created_at
        `)

      if (statusFilter !== 'all') {
        query = query.eq('status', statusFilter)
      }

      if (typeFilter !== 'all') {
        query = query.eq('supplier_type', typeFilter)
      }

      const { data, error } = await query
        .order('rating', { ascending: false, nullsLast: false })
        .order('name', { ascending: true })

      if (error) {
        console.error('Error loading suppliers:', error)
        setSuppliers([])
        return
      }

      setSuppliers(data || [])
    } catch (error) {
      console.error('Error loading suppliers:', error)
      setSuppliers([])
    } finally {
      setLoading(false)
    }
  }

  // Filter and sort suppliers
  const filteredAndSortedSuppliers = useMemo(() => {
    let filtered = suppliers.filter(supplier => {
      const matchesSearch = supplier.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
                          supplier.business_name?.toLowerCase().includes(searchTerm.toLowerCase()) ||
                          supplier.contact_person?.toLowerCase().includes(searchTerm.toLowerCase())

      return matchesSearch
    })

    // Sort suppliers
    filtered.sort((a, b) => {
      let aValue, bValue

      switch (sortField) {
        case 'name':
          aValue = a.name.toLowerCase()
          bValue = b.name.toLowerCase()
          break
        case 'rating':
          aValue = a.rating || 0
          bValue = b.rating || 0
          break
        case 'total_orders':
          aValue = a.total_orders || 0
          bValue = b.total_orders || 0
          break
        case 'reliability_score':
          aValue = a.reliability_score || 0
          bValue = b.reliability_score || 0
          break
        case 'created_at':
          aValue = new Date(a.created_at).getTime()
          bValue = new Date(b.created_at).getTime()
          break
        default:
          return 0
      }

      if (sortDirection === 'asc') {
        return aValue > bValue ? 1 : -1
      } else {
        return aValue < bValue ? 1 : -1
      }
    })

    return filtered
  }, [suppliers, searchTerm, sortField, sortDirection])

  const getStatusBadge = (status: string) => {
    const statusConfig = {
      active: { variant: "default" as const, icon: CheckCircle, label: "Activo" },
      inactive: { variant: "secondary" as const, icon: Clock, label: "Inactivo" },
      suspended: { variant: "destructive" as const, icon: AlertTriangle, label: "Suspendido" },
      blacklisted: { variant: "destructive" as const, icon: AlertTriangle, label: "Bloqueado" }
    }

    const config = statusConfig[status as keyof typeof statusConfig] || statusConfig.active
    const Icon = config.icon

    return (
      <Badge variant={config.variant} className="flex items-center gap-1">
        <Icon className="w-3 h-3" />
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

  const handleSupplierClick = (supplier: Supplier) => {
    if (showSelection) {
      onSupplierSelect?.(supplier)
    } else {
      setSelectedSupplier(supplier)
      setShowDetailsDialog(true)
    }
  }

  const handleCreateSuccess = () => {
    setShowCreateDialog(false)
    loadSuppliers()
  }

  const toggleSort = (field: SortField) => {
    if (sortField === field) {
      setSortDirection(sortDirection === 'asc' ? 'desc' : 'asc')
    } else {
      setSortField(field)
      setSortDirection('asc')
    }
  }

  return (
    <div className="space-y-4 md:space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <div>
          <h1 className="text-2xl md:text-3xl font-bold tracking-tight">Padrón de Proveedores</h1>
          <p className="text-sm md:text-base text-muted-foreground">
            Gestiona y evalúa el rendimiento de tus proveedores
          </p>
        </div>
        <Button onClick={() => setShowCreateDialog(true)} className="w-full sm:w-auto">
          <Plus className="w-4 h-4 mr-2" />
          Agregar Proveedor
        </Button>
      </div>

      {/* Filters and Search */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base md:text-lg">
            <Filter className="w-4 h-4 md:w-5 md:h-5" />
            Filtros y Búsqueda
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-3">
            <div className="relative">
              <Search className="absolute left-3 top-3 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder="Buscar por nombre, razón social o contacto..."
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                className="pl-10"
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <Select value={statusFilter} onValueChange={setStatusFilter}>
                <SelectTrigger>
                  <SelectValue placeholder="Estado" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Todos</SelectItem>
                  <SelectItem value="active">Activos</SelectItem>
                  <SelectItem value="inactive">Inactivos</SelectItem>
                  <SelectItem value="suspended">Suspendidos</SelectItem>
                  <SelectItem value="blacklisted">Bloqueados</SelectItem>
                </SelectContent>
              </Select>
              <Select value={typeFilter} onValueChange={setTypeFilter}>
                <SelectTrigger>
                  <SelectValue placeholder="Tipo" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Todos</SelectItem>
                  <SelectItem value="individual">Individual</SelectItem>
                  <SelectItem value="company">Empresa</SelectItem>
                  <SelectItem value="distributor">Distribuidor</SelectItem>
                  <SelectItem value="manufacturer">Fabricante</SelectItem>
                  <SelectItem value="service_provider">Servicios</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Suppliers List */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg md:text-xl">Proveedores ({filteredAndSortedSuppliers.length})</CardTitle>
          <CardDescription>
            Lista de proveedores con métricas de rendimiento
          </CardDescription>
        </CardHeader>
        <CardContent>
          {loading ? (
            <div className="flex items-center justify-center py-8">
              <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
              <span className="ml-2">Cargando proveedores...</span>
            </div>
          ) : (
            <>
              {/* Desktop Table View */}
              <div className="hidden md:block overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead
                        className="cursor-pointer hover:bg-muted/50"
                        onClick={() => toggleSort('name')}
                      >
                        Proveedor {sortField === 'name' && (sortDirection === 'asc' ? '↑' : '↓')}
                      </TableHead>
                      <TableHead>Tipo</TableHead>
                      <TableHead>Estado</TableHead>
                      <TableHead
                        className="cursor-pointer hover:bg-muted/50"
                        onClick={() => toggleSort('rating')}
                      >
                        Calificación {sortField === 'rating' && (sortDirection === 'asc' ? '↑' : '↓')}
                      </TableHead>
                      <TableHead
                        className="cursor-pointer hover:bg-muted/50"
                        onClick={() => toggleSort('total_orders')}
                      >
                        Órdenes {sortField === 'total_orders' && (sortDirection === 'asc' ? '↑' : '↓')}
                      </TableHead>
                      <TableHead
                        className="cursor-pointer hover:bg-muted/50"
                        onClick={() => toggleSort('reliability_score')}
                      >
                        Confiabilidad {sortField === 'reliability_score' && (sortDirection === 'asc' ? '↑' : '↓')}
                      </TableHead>
                      <TableHead>Acciones</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {filteredAndSortedSuppliers.map((supplier) => (
                      <TableRow
                        key={supplier.id}
                        className={`cursor-pointer hover:bg-muted/50 ${
                          selectedSupplierId === supplier.id ? 'bg-primary/5' : ''
                        }`}
                        onClick={() => handleSupplierClick(supplier)}
                      >
                        <TableCell>
                          <div>
                            <div className="font-medium">{supplier.name}</div>
                            {supplier.business_name && (
                              <div className="text-sm text-muted-foreground">
                                {supplier.business_name}
                              </div>
                            )}
                            {supplier.contact_person && (
                              <div className="text-sm text-muted-foreground">
                                Contacto: {supplier.contact_person}
                              </div>
                            )}
                          </div>
                        </TableCell>
                        <TableCell>
                          {getTypeBadge(supplier.supplier_type)}
                        </TableCell>
                        <TableCell>
                          {getStatusBadge(supplier.status)}
                        </TableCell>
                        <TableCell>
                          <div className="flex items-center gap-1">
                            <Star className="w-4 h-4 fill-yellow-400 text-yellow-400" />
                            <span>{supplier.rating?.toFixed(1) || 'N/A'}</span>
                          </div>
                        </TableCell>
                        <TableCell>
                          <div className="flex items-center gap-1">
                            <span>{supplier.total_orders || 0}</span>
                            {supplier.avg_order_amount && (
                              <span className="text-sm text-muted-foreground">
                                (${supplier.avg_order_amount.toLocaleString()})
                              </span>
                            )}
                          </div>
                        </TableCell>
                        <TableCell>
                          <div className="flex items-center gap-1">
                            <TrendingUp className="w-4 h-4" />
                            <span>{supplier.reliability_score?.toFixed(0) || 'N/A'}%</span>
                          </div>
                        </TableCell>
                        <TableCell>
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <Button variant="ghost" className="h-8 w-8 p-0">
                                <MoreHorizontal className="h-4 w-4" />
                              </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end">
                              <DropdownMenuLabel>Acciones</DropdownMenuLabel>
                              <DropdownMenuItem onClick={() => handleSupplierClick(supplier)}>
                                <Eye className="mr-2 h-4 w-4" />
                                Ver detalles
                              </DropdownMenuItem>
                              <DropdownMenuItem>
                                <Edit className="mr-2 h-4 w-4" />
                                Editar
                              </DropdownMenuItem>
                              <DropdownMenuSeparator />
                              <DropdownMenuItem className="text-destructive">
                                Cambiar estado
                              </DropdownMenuItem>
                            </DropdownMenuContent>
                          </DropdownMenu>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>

              {/* Mobile Card View */}
              <div className="md:hidden space-y-3">
                {filteredAndSortedSuppliers.map((supplier) => (
                  <div
                    key={supplier.id}
                    className={`border rounded-lg p-4 cursor-pointer hover:bg-muted/50 transition-colors ${
                      selectedSupplierId === supplier.id ? 'ring-2 ring-primary' : ''
                    }`}
                    onClick={() => handleSupplierClick(supplier)}
                  >
                    <div className="flex items-start justify-between mb-3">
                      <div className="flex-1">
                        <div className="flex items-center gap-2 mb-1">
                          <h4 className="font-semibold">{supplier.name}</h4>
                          {getTypeBadge(supplier.supplier_type)}
                        </div>
                        {supplier.business_name && (
                          <p className="text-sm text-muted-foreground mb-2">
                            {supplier.business_name}
                          </p>
                        )}
                        {supplier.contact_person && (
                          <p className="text-sm text-muted-foreground">
                            Contacto: {supplier.contact_person}
                          </p>
                        )}
                      </div>
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button variant="ghost" className="h-8 w-8 p-0">
                            <MoreHorizontal className="h-4 w-4" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuLabel>Acciones</DropdownMenuLabel>
                          <DropdownMenuItem onClick={() => handleSupplierClick(supplier)}>
                            <Eye className="mr-2 h-4 w-4" />
                            Ver detalles
                          </DropdownMenuItem>
                          <DropdownMenuItem>
                            <Edit className="mr-2 h-4 w-4" />
                            Editar
                          </DropdownMenuItem>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem className="text-destructive">
                            Cambiar estado
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </div>

                    <div className="grid grid-cols-3 gap-4 text-sm">
                      <div className="text-center">
                        <div className="flex items-center justify-center gap-1 mb-1">
                          <Star className="w-3 h-3 fill-yellow-400 text-yellow-400" />
                          <span className="font-medium">{supplier.rating?.toFixed(1) || 'N/A'}</span>
                        </div>
                        <p className="text-xs text-muted-foreground">Calificación</p>
                      </div>
                      <div className="text-center">
                        <div className="flex items-center justify-center gap-1 mb-1">
                          <span className="font-medium">{supplier.total_orders || 0}</span>
                        </div>
                        <p className="text-xs text-muted-foreground">Órdenes</p>
                      </div>
                      <div className="text-center">
                        <div className="flex items-center justify-center gap-1 mb-1">
                          <TrendingUp className="w-3 h-3" />
                          <span className="font-medium">{supplier.reliability_score?.toFixed(0) || 'N/A'}%</span>
                        </div>
                        <p className="text-xs text-muted-foreground">Confiabilidad</p>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}
        </CardContent>
      </Card>

      {/* Create Supplier Dialog */}
      <Dialog open={showCreateDialog} onOpenChange={setShowCreateDialog}>
        <DialogContent className="max-w-4xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Agregar Nuevo Proveedor</DialogTitle>
            <DialogDescription>
              Registra un nuevo proveedor en el sistema
            </DialogDescription>
          </DialogHeader>
          <SupplierForm onSuccess={handleCreateSuccess} />
        </DialogContent>
      </Dialog>

      {/* Supplier Details Dialog */}
      <Dialog open={showDetailsDialog} onOpenChange={setShowDetailsDialog}>
        <DialogContent className="max-w-6xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Detalles del Proveedor</DialogTitle>
            <DialogDescription>
              Información completa y métricas de rendimiento
            </DialogDescription>
          </DialogHeader>
          {selectedSupplier && (
            <SupplierDetails
              supplier={selectedSupplier}
              onClose={() => setShowDetailsDialog(false)}
            />
          )}
        </DialogContent>
      </Dialog>
    </div>
  )
}
