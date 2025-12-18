"use client"

import { useState, useEffect } from "react"
import { useSearchParams } from 'next/navigation'
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from "@/components/ui/card"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { 
  Check, CheckCircle, Edit, Eye, FileText, MoreHorizontal, Search, Trash, User, 
  AlertTriangle, Wrench, CalendarDays, ListChecks, Plus, ShoppingCart, Filter,
  ChevronRight, Calendar, Clock, Package
} from "lucide-react"
import { createClient } from "@/lib/supabase"
import { useIsMobile } from "@/hooks/use-mobile"
import Link from "next/link"
import { WorkOrder, WorkOrderWithAsset, WorkOrderStatus, MaintenanceType, ServiceOrderPriority, Asset, Profile, PurchaseOrderStatus } from "@/types"
import { 
  Select, 
  SelectContent, 
  SelectItem, 
  SelectTrigger, 
  SelectValue 
} from "@/components/ui/select"
import { cn } from "@/lib/utils"
import { PullToRefresh } from "@/components/ui/pull-to-refresh"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { useToast } from "@/hooks/use-toast"

function getPriorityVariant(priority: string | null) {
  switch (priority) {
    case ServiceOrderPriority.Critical:
      return "destructive"
    case ServiceOrderPriority.High:
      return "secondary" 
    default:
      return "outline"
  }
}

function getStatusVariant(status: string | null) {
  switch (status) {
    case WorkOrderStatus.Completed:
      return "default" 
    case WorkOrderStatus.InProgress:
      return "secondary" 
    case WorkOrderStatus.Pending:
    case WorkOrderStatus.Quoted:
    case WorkOrderStatus.Approved:
      return "outline" 
    default:
      return "outline"
  }
}

function getTypeVariant(type: string | null) {
  switch (type) {
    case MaintenanceType.Preventive:
      return "outline"
    case MaintenanceType.Corrective:
      return "destructive"
    default:
      return "secondary"
  }
}

function getPurchaseOrderStatusVariant(status: string) {
  switch (status) {
    case PurchaseOrderStatus.Pending:
      return "outline"
    case PurchaseOrderStatus.Approved:
      return "secondary"
    case PurchaseOrderStatus.Ordered:
      return "default"
    case PurchaseOrderStatus.Received:
      return "default"
    case PurchaseOrderStatus.Rejected:
      return "destructive"
    default:
      return "outline"
  }
}

function getPurchaseOrderStatusClass(status: string) {
  switch (status) {
    case PurchaseOrderStatus.Pending:
      return "bg-yellow-50 text-yellow-800"
    case PurchaseOrderStatus.Approved:
      return "bg-blue-50 text-blue-800"
    case PurchaseOrderStatus.Ordered:
      return "bg-indigo-50 text-indigo-800"
    case PurchaseOrderStatus.Received:
      return "bg-green-100 text-green-800"
    case PurchaseOrderStatus.Rejected:
      return "bg-red-50 text-red-800"
    default:
      return ""
  }
}

// Mobile-optimized WorkOrder Card Component
function WorkOrderCard({ 
  order, 
  getTechnicianName, 
  getPurchaseOrderStatus,
  onDeleteOrder
}: { 
  order: WorkOrderWithAsset
  getTechnicianName: (techId: string | null) => string
  getPurchaseOrderStatus: (poId: string | null) => string
  onDeleteOrder: (order: WorkOrderWithAsset) => void
}) {
  return (
    <Card className="w-full h-fit hover:shadow-md transition-shadow">
      <CardHeader className="pb-3">
        <div className="flex justify-between items-start">
          <div className="space-y-1 flex-1 min-w-0">
            <CardTitle className="text-lg font-semibold truncate">
              {order.order_id}
            </CardTitle>
            <p className="text-sm text-muted-foreground line-clamp-2">
              {order.description}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Badge variant={getStatusVariant(order.status)} className="shrink-0">
              {order.status || "Pendiente"}
            </Badge>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" className="h-8 w-8 p-0">
                  <span className="sr-only">Abrir menú</span>
                  <MoreHorizontal className="h-4 w-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuLabel>Acciones</DropdownMenuLabel>
                <DropdownMenuItem asChild>
                  <Link href={`/ordenes/${order.id}`}>
                    <Eye className="mr-2 h-4 w-4" />
                    <span>Ver Detalles</span>
                  </Link>
                </DropdownMenuItem>
                <DropdownMenuItem asChild>
                  <Link href={`/ordenes/${order.id}/editar`}>
                    <Edit className="mr-2 h-4 w-4" />
                    <span>Editar OT</span>
                  </Link>
                </DropdownMenuItem>
                {order.status !== WorkOrderStatus.Completed && (
                  <DropdownMenuItem asChild>
                    <Link href={`/ordenes/${order.id}/completar`}>
                      <CheckCircle className="mr-2 h-4 w-4" />
                      <span>Completar OT</span>
                    </Link>
                  </DropdownMenuItem>
                )}
                {order.purchase_order_id && (
                  <DropdownMenuItem asChild>
                    <Link href={`/compras/${order.purchase_order_id}`}>
                      <ShoppingCart className="mr-2 h-4 w-4" />
                      <span>Ver OC</span>
                    </Link>
                  </DropdownMenuItem>
                )}
                <DropdownMenuSeparator />
                <DropdownMenuItem 
                  className="text-red-600 hover:bg-red-50 hover:text-red-700"
                  onClick={() => onDeleteOrder(order)}
                >
                  <Trash className="mr-2 h-4 w-4" />
                  <span>Eliminar OT</span>
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
      </CardHeader>
      
      <CardContent className="space-y-4">
        {/* Asset Info */}
        <div className="flex items-center gap-2 text-sm">
          <Package className="h-4 w-4 text-muted-foreground shrink-0" />
          <div className="flex-1 min-w-0">
            <p className="font-medium truncate">
              {order.asset?.name || 'N/A'}
            </p>
            {order.asset?.asset_id && (
              <p className="text-xs text-muted-foreground">
                ID: {order.asset.asset_id}
              </p>
            )}
          </div>
        </div>
        
        {/* Type and Priority */}
        <div className="flex gap-2">
          <Badge variant={getTypeVariant(order.type)} className="text-xs">
            {order.type || 'N/A'}
          </Badge>
          <Badge variant={getPriorityVariant(order.priority)} className="text-xs">
            {order.priority || 'Normal'}
          </Badge>
        </div>
        
        {/* Technician */}
        <div className="flex items-center gap-2 text-sm">
          <User className="h-4 w-4 text-muted-foreground shrink-0" />
          <span className="truncate">{getTechnicianName(order.assigned_to)}</span>
        </div>
        
        {/* Date */}
        {order.planned_date && (
          <div className="flex items-center gap-2 text-sm">
            <Calendar className="h-4 w-4 text-muted-foreground shrink-0" />
            <span className="truncate">{formatDate(order.planned_date)}</span>
          </div>
        )}
        
        {/* Purchase Order Status */}
        {order.purchase_order_id && (
          <div className="flex items-center gap-2 text-sm">
            <ShoppingCart className="h-4 w-4 text-muted-foreground shrink-0" />
            <Badge 
              variant={getPurchaseOrderStatusVariant(getPurchaseOrderStatus(order.purchase_order_id))} 
              className={`text-xs ${getPurchaseOrderStatusClass(getPurchaseOrderStatus(order.purchase_order_id))}`}
            >
              OC: {getPurchaseOrderStatus(order.purchase_order_id)}
            </Badge>
          </div>
        )}
      </CardContent>
    </Card>
  )
}

// Utility function to properly cleanup modal state and focus
const cleanupModalState = (callback: () => void, delay: number = 100) => {
  setTimeout(() => {
    callback()
    // Force any modal overlays to be removed
    const modalOverlays = document.querySelectorAll('[data-radix-focus-guard], [data-radix-scroll-lock-wrapper]')
    modalOverlays.forEach(overlay => {
      if (overlay.parentNode) {
        overlay.parentNode.removeChild(overlay)
      }
    })
    // Clear any stuck focus states
    if (document.activeElement && document.activeElement !== document.body) {
      (document.activeElement as HTMLElement).blur()
    }
    document.body.focus()
    // Remove any aria-hidden attributes from the body that might be stuck
    document.body.removeAttribute('aria-hidden')
    document.body.style.removeProperty('pointer-events')
  }, delay)
}

export function WorkOrdersList() {
  const isMobile = useIsMobile()
  const searchParams = useSearchParams()
  const [searchTerm, setSearchTerm] = useState("")
  const [workOrders, setWorkOrders] = useState<WorkOrderWithAsset[]>([]) 
  const [isLoading, setIsLoading] = useState(true)
  const [activeTab, setActiveTab] = useState<string>("all")
  const [typeFilter, setTypeFilter] = useState<string>("all")
  const [technicians, setTechnicians] = useState<Record<string, Profile>>({})
  const [purchaseOrderStatuses, setPurchaseOrderStatuses] = useState<Record<string, string>>({})
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false)
  const [orderToDelete, setOrderToDelete] = useState<WorkOrderWithAsset | null>(null)
  const [isDeleting, setIsDeleting] = useState(false)
  const { toast } = useToast()

  // Initialize search term from URL parameters
  useEffect(() => {
    const assetName = searchParams.get('asset')
    const assetId = searchParams.get('assetId')
    if (assetName) {
      setSearchTerm(assetName)
    } else if (assetId) {
      // If we have assetId but no asset name, we'll use it to filter
      setSearchTerm(assetId)
    }
  }, [searchParams])

  // Load work orders function
  const loadWorkOrders = async () => {
    try {
      setIsLoading(true)
      const supabase = createClient()
      
      // Load work orders with pagination first
      const { data, error } = await supabase
        .from("work_orders")
        .select(`
          *,
          asset:assets (
            id,
            name,
            asset_id
          )
        `)
        .order("created_at", { ascending: false })
        .limit(100) // Limit to prevent slow loads

      if (error) {
        console.error("Error al cargar órdenes de trabajo:", error)
        throw error
      }

      setWorkOrders(data as WorkOrderWithAsset[])
      
      // Get unique technician IDs from work orders
      const assignedIds = data
        .filter(order => order.assigned_to)
        .map(order => order.assigned_to as string)
      const uniqueAssignedIds = [...new Set(assignedIds)]
      
      console.log(`Work orders have ${uniqueAssignedIds.length} unique assigned technician IDs:`, uniqueAssignedIds.slice(0, 5))
      
      // Load technicians - load all active ones, plus any assigned to work orders (even if inactive)
      const techMap: Record<string, Profile> = {}
      
      // First, load all active technicians
      const { data: activeTechs, error: activeTechError } = await supabase
        .from("profiles")
        .select("id, nombre, apellido")
        .eq("is_active", true)
        .limit(500)
      
      if (!activeTechError && activeTechs) {
        activeTechs.forEach(tech => {
          techMap[tech.id] = tech
        })
      }
      
      // Then, load any assigned technicians that might not be active
      if (uniqueAssignedIds.length > 0) {
        const { data: assignedTechs, error: assignedTechError } = await supabase
          .from("profiles")
          .select("id, nombre, apellido")
          .in("id", uniqueAssignedIds)
        
        if (!assignedTechError && assignedTechs) {
          assignedTechs.forEach(tech => {
            techMap[tech.id] = tech
          })
        }
      }
      
      const techData = Object.values(techMap)
      
      console.log(`Loaded ${techData.length} technicians`, { 
        sample: Object.keys(techMap).slice(0, 3),
        assignedIds: uniqueAssignedIds.slice(0, 3),
        foundAssigned: uniqueAssignedIds.filter(id => techMap[id]).length
      })
      setTechnicians(techMap)

      // Load purchase order statuses
      const poIds = data
        .filter(order => order.purchase_order_id)
        .map(order => order.purchase_order_id as string)
      
      if (poIds.length > 0) {
        const { data: poData, error: poError } = await supabase
          .from("purchase_orders")
          .select("id, status")
          .in("id", poIds)
          
        if (poError) {
          console.error("Error al cargar estados de órdenes de compra:", poError)
        } else if (poData) {
          const statusMap: Record<string, string> = {}
          poData.forEach(po => {
            statusMap[po.id] = po.status
          })
          setPurchaseOrderStatuses(statusMap)
        }
      }

    } catch (error) {
      console.error("Error al cargar órdenes de trabajo:", error)
      setWorkOrders([]) 
    } finally {
      setIsLoading(false)
    }
  }

  useEffect(() => {
    loadWorkOrders()
  }, [])

  // Filter logic
  const filteredOrdersByTab = workOrders.filter(order => {
    if (activeTab === "all") return true
    if (activeTab === "pending") return order.status === WorkOrderStatus.Pending || order.status === WorkOrderStatus.Quoted
    if (activeTab === "approved") return order.status === WorkOrderStatus.Approved
    if (activeTab === "inprogress") return order.status === WorkOrderStatus.InProgress
    if (activeTab === "completed") return order.status === WorkOrderStatus.Completed
    return true
  }).filter(order => {
    if (typeFilter === "all") return true
    if (typeFilter === "preventive") return order.type === MaintenanceType.Preventive
    if (typeFilter === "corrective") return order.type === MaintenanceType.Corrective
    return true
  })

  const filteredOrders = filteredOrdersByTab.filter(
    (order) => {
      // If we have a specific assetId in URL params, filter by that first
      const assetIdParam = searchParams.get('assetId')
      if (assetIdParam && order.asset_id !== assetIdParam) {
        return false
      }
      
      // Then apply search term filter
      return (
        (order.asset?.name?.toLowerCase() || "").includes(searchTerm.toLowerCase()) ||
        (order.asset?.asset_id?.toLowerCase() || "").includes(searchTerm.toLowerCase()) ||
        (order.order_id?.toLowerCase() || "").includes(searchTerm.toLowerCase()) || 
        (order.assigned_to && technicians[order.assigned_to]?.nombre?.toLowerCase().includes(searchTerm.toLowerCase())) ||
        (order.description?.toLowerCase() || "").includes(searchTerm.toLowerCase())
      )
    }
  )

  // Helper functions
  const getTechnicianName = (techId: string | null) => {
    if (!techId) return 'No asignado'
    const tech = technicians[techId]
    if (!tech) {
      console.warn(`Technician not found for ID: ${techId}`, { techniciansCount: Object.keys(technicians).length, sampleIds: Object.keys(technicians).slice(0, 3) })
      return techId
    }
    return tech.nombre && tech.apellido 
      ? `${tech.nombre} ${tech.apellido}`
      : tech.nombre || techId
  }

  const getPurchaseOrderStatus = (poId: string | null): string => {
    if (!poId) return 'N/A'
    return purchaseOrderStatuses[poId] || 'N/A'
  }

  // Pull to refresh handler
  const handlePullToRefresh = async () => {
    await loadWorkOrders()
    await new Promise(resolve => setTimeout(resolve, 500))
  }

  // Delete work order function
  const handleDeleteWorkOrder = async (order: WorkOrderWithAsset) => {
    setOrderToDelete(order)
    setDeleteDialogOpen(true)
  }

  const confirmDelete = async () => {
    if (!orderToDelete) return

    setIsDeleting(true)
    try {
      const supabase = createClient()
      
      const { error } = await supabase
        .from("work_orders")
        .delete()
        .eq("id", orderToDelete.id)

      if (error) {
        console.error("Error al eliminar orden de trabajo:", error)
        toast({
          title: "Error",
          description: "No se pudo eliminar la orden de trabajo. Por favor, intente nuevamente.",
          variant: "destructive",
        })
        setIsDeleting(false)
      } else {
        toast({
          title: "Orden eliminada",
          description: `La orden de trabajo ${orderToDelete.order_id} ha sido eliminada exitosamente.`,
        })
        
        // Remove the deleted order from the list
        setWorkOrders(prev => prev.filter(wo => wo.id !== orderToDelete.id))
        
        // Close dialog with proper cleanup
        setIsDeleting(false)
        setDeleteDialogOpen(false)
        
        // Reset order state after a brief delay to ensure dialog closes properly
        cleanupModalState(() => {
          setOrderToDelete(null)
        }, 100)
      }
    } catch (error) {
      console.error("Error al eliminar orden de trabajo:", error)
      toast({
        title: "Error",
        description: "Ocurrió un error inesperado. Por favor, intente nuevamente.",
        variant: "destructive",
      })
      setIsDeleting(false)
    }
  }

  return (
    <>
      <PullToRefresh onRefresh={handlePullToRefresh} disabled={isLoading}>
        <Card>
          <CardContent className={cn("pt-6", isMobile && "px-4 pt-4")}>
            {/* Search and Filters */}
            <div className={cn(
              "flex gap-4 mb-6",
              isMobile ? "flex-col gap-3" : "flex-col md:flex-row md:items-center md:justify-between"
            )}>
              <div className={cn(
                "flex items-center gap-2",
                isMobile ? "flex-col gap-3" : "flex-col md:flex-row"
              )}>
                <div className={cn(
                  "relative",
                  isMobile ? "w-full" : "w-full md:w-64"
                )}>
                  <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
                  <Input
                    type="search"
                    placeholder="Buscar OT, activo, asignado..."
                    className={cn(
                      "pl-8",
                      isMobile && "h-11" // Better touch target
                    )}
                    value={searchTerm}
                    onChange={(e) => setSearchTerm(e.target.value)}
                  />
                </div>
                <Select value={typeFilter} onValueChange={setTypeFilter}>
                  <SelectTrigger className={cn(
                    isMobile ? "w-full h-11" : "w-full md:w-40"
                  )}>
                    <SelectValue placeholder="Filtrar por tipo" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">Todos los tipos</SelectItem>
                    <SelectItem value="preventive">Preventivos</SelectItem>
                    <SelectItem value="corrective">Correctivos</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            
            {/* Tabs */}
            <Tabs value={activeTab} onValueChange={setActiveTab} className="w-full">
              <TabsList className={cn(
                "mb-4 grid w-full",
                isMobile 
                  ? "grid-cols-2 h-auto gap-1" // Stack in 2 columns on mobile
                  : "grid-cols-2 sm:grid-cols-5"
              )}>
                <TabsTrigger 
                  value="all"
                  className={cn(isMobile && "text-xs px-2 py-2")}
                >
                  Todas
                </TabsTrigger>
                <TabsTrigger 
                  value="pending"
                  className={cn(isMobile && "text-xs px-2 py-2")}
                >
                  Pendientes
                </TabsTrigger>
                {!isMobile && (
                  <>
                    <TabsTrigger value="approved">Aprobadas</TabsTrigger>
                    <TabsTrigger value="inprogress">En Progreso</TabsTrigger>
                    <TabsTrigger value="completed">Completadas</TabsTrigger>
                  </>
                )}
              </TabsList>
              
              {/* Mobile: Additional tabs in second grid */}
              {isMobile && (
                <div className="grid grid-cols-3 gap-1 mb-4">
                  <Button
                    variant={activeTab === "approved" ? "default" : "outline"}
                    size="sm"
                    onClick={() => setActiveTab("approved")}
                    className="text-xs h-8"
                  >
                    Aprobadas
                  </Button>
                  <Button
                    variant={activeTab === "inprogress" ? "default" : "outline"}
                    size="sm"
                    onClick={() => setActiveTab("inprogress")}
                    className="text-xs h-8"
                  >
                    En Progreso
                  </Button>
                  <Button
                    variant={activeTab === "completed" ? "default" : "outline"}
                    size="sm"
                    onClick={() => setActiveTab("completed")}
                    className="text-xs h-8"
                  >
                    Completadas
                  </Button>
                </div>
              )}
              
              {/* Content for each tab */}
              <TabsContent value="all" className="mt-0">
                {isMobile ? (
                  <MobileView 
                    orders={filteredOrders} 
                    isLoading={isLoading} 
                    getTechnicianName={getTechnicianName}
                    getPurchaseOrderStatus={getPurchaseOrderStatus}
                    onDeleteOrder={handleDeleteWorkOrder}
                  />
                ) : (
                  <DesktopView 
                    orders={filteredOrders} 
                    isLoading={isLoading} 
                    getTechnicianName={getTechnicianName}
                    getPurchaseOrderStatus={getPurchaseOrderStatus}
                    onDeleteOrder={handleDeleteWorkOrder}
                  />
                )}
              </TabsContent>
              
              <TabsContent value="pending" className="mt-0">
                {isMobile ? (
                  <MobileView 
                    orders={filteredOrders} 
                    isLoading={isLoading} 
                    getTechnicianName={getTechnicianName}
                    getPurchaseOrderStatus={getPurchaseOrderStatus}
                    onDeleteOrder={handleDeleteWorkOrder}
                  />
                ) : (
                  <DesktopView 
                    orders={filteredOrders} 
                    isLoading={isLoading} 
                    getTechnicianName={getTechnicianName}
                    getPurchaseOrderStatus={getPurchaseOrderStatus}
                    onDeleteOrder={handleDeleteWorkOrder}
                  />
                )}
              </TabsContent>
              
              <TabsContent value="approved" className="mt-0">
                {isMobile ? (
                  <MobileView 
                    orders={filteredOrders} 
                    isLoading={isLoading} 
                    getTechnicianName={getTechnicianName}
                    getPurchaseOrderStatus={getPurchaseOrderStatus}
                    onDeleteOrder={handleDeleteWorkOrder}
                  />
                ) : (
                  <DesktopView 
                    orders={filteredOrders} 
                    isLoading={isLoading} 
                    getTechnicianName={getTechnicianName}
                    getPurchaseOrderStatus={getPurchaseOrderStatus}
                    onDeleteOrder={handleDeleteWorkOrder}
                  />
                )}
              </TabsContent>
              
              <TabsContent value="inprogress" className="mt-0">
                {isMobile ? (
                  <MobileView 
                    orders={filteredOrders} 
                    isLoading={isLoading} 
                    getTechnicianName={getTechnicianName}
                    getPurchaseOrderStatus={getPurchaseOrderStatus}
                    onDeleteOrder={handleDeleteWorkOrder}
                  />
                ) : (
                  <DesktopView 
                    orders={filteredOrders} 
                    isLoading={isLoading} 
                    getTechnicianName={getTechnicianName}
                    getPurchaseOrderStatus={getPurchaseOrderStatus}
                    onDeleteOrder={handleDeleteWorkOrder}
                  />
                )}
              </TabsContent>
              
              <TabsContent value="completed" className="mt-0">
                {isMobile ? (
                  <MobileView 
                    orders={filteredOrders} 
                    isLoading={isLoading} 
                    getTechnicianName={getTechnicianName}
                    getPurchaseOrderStatus={getPurchaseOrderStatus}
                    onDeleteOrder={handleDeleteWorkOrder}
                  />
                ) : (
                  <DesktopView 
                    orders={filteredOrders} 
                    isLoading={isLoading} 
                    getTechnicianName={getTechnicianName}
                    getPurchaseOrderStatus={getPurchaseOrderStatus}
                    onDeleteOrder={handleDeleteWorkOrder}
                  />
                )}
              </TabsContent>
            </Tabs>
          </CardContent>
          
          <CardFooter className={cn(isMobile && "px-4")}>
            <div className="text-xs text-muted-foreground">
              Mostrando <strong>{filteredOrders.length}</strong> de <strong>{workOrders.length}</strong> órdenes de trabajo.
            </div>
          </CardFooter>
        </Card>
      </PullToRefresh>

      {/* Delete confirmation dialog */}
      <AlertDialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>¿Está seguro de eliminar esta orden de trabajo?</AlertDialogTitle>
            <AlertDialogDescription>
              Esta acción eliminará permanentemente la orden de trabajo <strong>{orderToDelete?.order_id}</strong> y todos sus registros relacionados.
            </AlertDialogDescription>
            <div className="space-y-3 pt-2">
              <ul className="list-disc list-inside text-sm text-muted-foreground">
                <li>Historial de mantenimiento</li>
                <li>Problemas de checklist asociados</li>
                <li>Órdenes de servicio relacionadas</li>
                <li>Gastos adicionales</li>
                <li>Órdenes de compra vinculadas</li>
              </ul>
              <div className="font-semibold text-destructive text-sm">Esta acción no se puede deshacer.</div>
            </div>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isDeleting}>Cancelar</AlertDialogCancel>
            <AlertDialogAction
              onClick={confirmDelete}
              disabled={isDeleting}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {isDeleting ? "Eliminando..." : "Eliminar"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}

// Mobile View Component
function MobileView({ 
  orders, 
  isLoading, 
  getTechnicianName, 
  getPurchaseOrderStatus,
  onDeleteOrder
}: {
  orders: WorkOrderWithAsset[]
  isLoading: boolean
  getTechnicianName: (techId: string | null) => string
  getPurchaseOrderStatus: (poId: string | null) => string
  onDeleteOrder: (order: WorkOrderWithAsset) => void
}) {
  if (isLoading) {
    return (
      <div className="flex justify-center items-center h-64">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
        <span className="ml-3 text-muted-foreground">Cargando órdenes...</span>
      </div>
    )
  }

  if (orders.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-64 rounded-md border border-dashed">
        <AlertTriangle className="h-12 w-12 text-muted-foreground mb-3" />
        <p className="text-center text-muted-foreground">No se encontraron órdenes de trabajo.</p>
        <p className="text-sm text-muted-foreground">Intenta ajustar los filtros.</p>
      </div>
    )
  }

  return (
    <div className="space-y-4">
      {orders.map((order) => (
        <WorkOrderCard 
          key={order.id}
          order={order}
          getTechnicianName={getTechnicianName}
          getPurchaseOrderStatus={getPurchaseOrderStatus}
          onDeleteOrder={onDeleteOrder}
        />
      ))}
    </div>
  )
}

// Desktop View Component (existing table)
function DesktopView({ 
  orders, 
  isLoading, 
  getTechnicianName, 
  getPurchaseOrderStatus,
  onDeleteOrder
}: {
  orders: WorkOrderWithAsset[]
  isLoading: boolean
  getTechnicianName: (techId: string | null) => string
  getPurchaseOrderStatus: (poId: string | null) => string
  onDeleteOrder: (order: WorkOrderWithAsset) => void
}) {
  if (isLoading) {
    return (
      <div className="flex justify-center items-center h-64">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
        <span className="ml-3 text-muted-foreground">Cargando órdenes...</span>
      </div>
    )
  }

  if (orders.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-64 rounded-md border border-dashed">
        <AlertTriangle className="h-12 w-12 text-muted-foreground mb-3" />
        <p className="text-center text-muted-foreground">No se encontraron órdenes de trabajo para esta vista.</p>
        <p className="text-sm text-muted-foreground">Intenta ajustar los filtros o revisa más tarde.</p>
      </div>
    )
  }

  return (
    <div className="rounded-md border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-[100px]">OT ID</TableHead>
            <TableHead>Activo</TableHead>
            <TableHead>Tipo</TableHead>
            <TableHead>Prioridad</TableHead>
            <TableHead>Estado</TableHead>
            <TableHead>OC</TableHead>
            <TableHead>Fecha Planificada</TableHead>
            <TableHead>Asignado A</TableHead>
            <TableHead className="text-right w-[100px]">Acciones</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {orders.map((order) => (
            <TableRow key={order.id}>
              <TableCell className="font-medium">{order.order_id}</TableCell>
              <TableCell>
                {order.asset?.name || 'N/A'} 
                {order.asset?.asset_id && <span className="text-xs text-muted-foreground ml-1">({order.asset.asset_id})</span>}
              </TableCell>
              <TableCell>
                <Badge variant={getTypeVariant(order.type)} className="capitalize">
                  {order.type || 'N/A'}
                </Badge>
              </TableCell>
              <TableCell>
                <Badge variant={getPriorityVariant(order.priority)} className="capitalize">
                  {order.priority || 'N/A'}
                </Badge>
              </TableCell>
              <TableCell>
                <Badge variant={getStatusVariant(order.status)} className="capitalize">
                  {order.status || 'N/A'}
                </Badge>
              </TableCell>
              <TableCell>
                {order.purchase_order_id ? (
                  <Badge 
                    variant={getPurchaseOrderStatusVariant(getPurchaseOrderStatus(order.purchase_order_id))} 
                    className={getPurchaseOrderStatusClass(getPurchaseOrderStatus(order.purchase_order_id))}
                  >
                    {getPurchaseOrderStatus(order.purchase_order_id)}
                  </Badge>
                ) : (
                  order.type === MaintenanceType.Preventive && order.required_parts ? (
                    <Badge variant="outline" className="bg-yellow-50 text-yellow-800">Pendiente</Badge>
                  ) : (
                    <span className="text-xs text-muted-foreground">N/A</span>
                  )
                )}
              </TableCell>
              <TableCell>{order.planned_date ? formatDate(order.planned_date) : 'No planificada'}</TableCell>
              <TableCell>{getTechnicianName(order.assigned_to)}</TableCell> 
              <TableCell className="text-right">
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="ghost" className="h-8 w-8 p-0">
                      <span className="sr-only">Abrir menú</span>
                      <MoreHorizontal className="h-4 w-4" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuLabel>Acciones</DropdownMenuLabel>
                    <DropdownMenuItem asChild>
                      <Link href={`/ordenes/${order.id}`}>
                        <Eye className="mr-2 h-4 w-4" />
                        <span>Ver Detalles</span>
                      </Link>
                    </DropdownMenuItem>
                  {/* Link to Service Order if exists (client-side discovery) */}
                  <DropdownMenuItem asChild>
                    <Link href={`/servicios?workOrderId=${order.id}`}>
                      <FileText className="mr-2 h-4 w-4" />
                      <span>Ver Servicio</span>
                    </Link>
                  </DropdownMenuItem>
                  {/* Link to Incident if present on order */}
                  {order.incident_id && (
                    <DropdownMenuItem asChild>
                      <Link href={`/incidentes`}>
                        <AlertTriangle className="mr-2 h-4 w-4" />
                        <span>Incidente</span>
                      </Link>
                    </DropdownMenuItem>
                  )}
                    <DropdownMenuItem asChild>
                       <Link href={`/ordenes/${order.id}/editar`}> 
                        <Edit className="mr-2 h-4 w-4" />
                        <span>Editar OT</span>
                      </Link>
                    </DropdownMenuItem>
                    {!order.purchase_order_id && order.required_parts && (
                      <DropdownMenuItem asChild>
                        <Link href={`/ordenes/${order.id}/generar-oc`}>
                          <ShoppingCart className="mr-2 h-4 w-4" />
                          <span>Generar OC</span>
                        </Link>
                      </DropdownMenuItem>
                    )}
                    {order.purchase_order_id && (
                      <DropdownMenuItem asChild>
                        <Link href={`/compras/${order.purchase_order_id}`}>
                          <ShoppingCart className="mr-2 h-4 w-4" />
                          <span>Ver OC</span>
                        </Link>
                      </DropdownMenuItem>
                    )}
                    <DropdownMenuItem>
                      <ListChecks className="mr-2 h-4 w-4" />
                      <span>Ver Checklist</span> 
                    </DropdownMenuItem>
                    {order.status !== WorkOrderStatus.Completed && (
                      <DropdownMenuItem asChild>
                        <Link href={`/ordenes/${order.id}/completar`}>
                          <Wrench className="mr-2 h-4 w-4" />
                          <span>Registrar Mantenimiento</span>
                        </Link>
                      </DropdownMenuItem>
                    )}
                    <DropdownMenuItem>
                      <CalendarDays className="mr-2 h-4 w-4" />
                      <span>Re-Programar</span>
                    </DropdownMenuItem>
                    <DropdownMenuItem>
                      <CheckCircle className="mr-2 h-4 w-4" />
                      <span>Cambiar Estado</span>
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem 
                      className="text-red-600 hover:bg-red-50 hover:text-red-700"
                      onClick={() => onDeleteOrder(order)}
                    >
                      <Trash className="mr-2 h-4 w-4" />
                      <span>Eliminar OT</span>
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  )
}

function formatDate(dateString: string | null) {
  if (!dateString) return "N/A"
  try {
    const date = new Date(dateString)
    if (isNaN(date.getTime())) {
      return dateString
    }
    return new Intl.DateTimeFormat("es-ES", {
      year: "numeric",
      month: "short",
      day: "numeric",
    }).format(date)
  } catch (error) {
    console.warn("Error formatting date:", dateString, error)
    return dateString
  }
} 