import { createClient } from "@/lib/supabase-server"
import { PurchaseOrderType, EnhancedPOStatus } from "@/types/purchase-orders"
import { cn } from "@/lib/utils"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card"
import { Separator } from "@/components/ui/separator"
import { ArrowLeft, FileCheck, Package, ShoppingCart, Truck, FileText, Download, ExternalLink, Store, Wrench, Building2, Receipt, AlertCircle, DollarSign, Calendar, User } from "lucide-react"
import { Alert, AlertDescription } from "@/components/ui/alert"
import Link from "next/link"
import { notFound } from "next/navigation"
import { format } from "date-fns"
import { es } from "date-fns/locale"
import { ReactNode, use } from "react"
import { ReceiptSection } from "@/components/work-orders/receipt-section"
import { WorkflowStatusDisplay } from "@/components/purchase-orders/workflow/WorkflowStatusDisplay"
import { TypeBadge } from "@/components/purchase-orders/shared/TypeBadge"
import { ReceiptDisplaySection } from "@/components/purchase-orders/ReceiptDisplaySection"
import { PurchaseOrderDetailsMobile } from "@/components/purchase-orders/purchase-order-details-mobile"
import { PurchaseOrderWorkOrderLink } from "@/components/purchase-orders/purchase-order-work-order-link"
import { Suspense } from "react"
import { EditPOButton } from "@/components/purchase-orders/EditPOButton"
import { QuotationManager } from "@/components/purchase-orders/QuotationManager"
import { ReportIssueButton } from "@/components/purchase-orders/ReportIssueButton"

// Helper function to format currency
function formatCurrency(amount: string | null): string {
  if (!amount) return "$0.00"
  return new Intl.NumberFormat('es-MX', {
    style: 'currency',
    currency: 'MXN',
  }).format(Number(amount))
}

// Helper function to format date
function formatDate(dateString: string | null, formatStr: string = 'PP'): string {
  if (!dateString) return "N/A"
  try {
    const date = new Date(dateString)
    if (isNaN(date.getTime())) return dateString
    return format(date, formatStr, { locale: es })
  } catch (error) {
    return dateString
  }
}

// Helper function to get badge variant based on status
function getStatusVariant(status: string | null): "outline" | "secondary" | "default" | "destructive" | undefined {
  switch (status) {
    case EnhancedPOStatus.PENDING_APPROVAL:
      return "outline"
    case EnhancedPOStatus.APPROVED:
      return "secondary"
    case EnhancedPOStatus.ORDERED:
    case EnhancedPOStatus.PURCHASED:
    case EnhancedPOStatus.RECEIVED:
    case EnhancedPOStatus.RECEIPT_UPLOADED:
    case EnhancedPOStatus.VALIDATED:
      return "default"
    case EnhancedPOStatus.REJECTED:
      return "destructive"
    default:
      return "outline"
  }
}

// Helper function to get file extension from URL
function getFileExtension(url: string): string {
  if (!url) return '';
  return url.split('.').pop()?.toLowerCase() || '';
}

// Helper function to check if a file is an image
function isImageFile(url: string): boolean {
  const imageExtensions = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg'];
  const extension = getFileExtension(url);
  return imageExtensions.includes(extension);
}

// Helper function to check if a file is a PDF
function isPdfFile(url: string): boolean {
  return getFileExtension(url) === 'pdf';
}

export default function PurchaseOrderDetailsPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  // Unwrap params using React.use()
  const resolvedParams = use(params);
  const id = resolvedParams.id;
  
  // Return the content component with the id
  return <PurchaseOrderDetailsContent id={id} />;
}

// Client wrapper component for mobile detection
function PurchaseOrderDetailsClientWrapper({ 
  id, 
  order, 
  workOrder, 
  requesterName, 
  approverName,
  items 
}: { 
  id: string
  order: any
  workOrder: any
  requesterName: string
  approverName: string
  items: any[]
}) {
  return (
    <Suspense fallback={<div>Cargando...</div>}>
      <PurchaseOrderDetailsClient 
        id={id}
        order={order}
        workOrder={workOrder}
        requesterName={requesterName}
        approverName={approverName}
        items={items}
      />
    </Suspense>
  )
}

// Client component that uses hooks
function PurchaseOrderDetailsClient({ 
  id, 
  order, 
  workOrder, 
  requesterName, 
  approverName,
  items 
}: { 
  id: string
  order: any
  workOrder: any
  requesterName: string
  approverName: string
  items: any[]
}) {
  // We'll add mobile detection here but for now, let's focus on the server content
  // This would require 'use client' directive which we'll add in a follow-up
  
  // For now, return the mobile component based on a simple user agent check
  // We'll improve this in the next iteration
  // This would require client-side logic for mobile detection
  // For now, returning null since the main content is handled server-side
  return null;
}

// Create an async server component for the content
async function PurchaseOrderDetailsContent({ id }: { id: string }) {
  const supabase = await createClient();
  
  // Get the purchase order details
  const { data: order, error } = await supabase
    .from("purchase_orders")
    .select("*")
    .eq("id", id)
    .single();
    
  if (error || !order) {
    notFound();
  }
  
  // Get work order if it exists
  let workOrder = null;
  if (order.work_order_id) {
    const { data: workOrderData, error: workOrderError } = await supabase
      .from("work_orders")
      .select(`
        *,
        asset:assets (
          id,
          name,
          asset_id
        )
      `)
      .eq("id", order.work_order_id)
      .single();
      
    if (!workOrderError && workOrderData) {
      workOrder = workOrderData;
    }
  }
  
  // Parse JSON items if it's a string
  const items = typeof order.items === 'string' 
    ? JSON.parse(order.items) 
    : order.items
  
  // Get requestor information
  let requesterName = "No especificado"
  if (order.requested_by) {
    const { data: requesterData } = await supabase
      .from("profiles")
      .select("nombre, apellido")
      .eq("id", order.requested_by)
      .single()
      
    if (requesterData && requesterData.nombre) {
      requesterName = `${requesterData.nombre || ''} ${requesterData.apellido || ''}`.trim()
    }
  }
  
  // Get the approver name if available
  let approverName = "No aprobado"
  if (order.approved_by) {
    const { data: approverData } = await supabase
      .from("profiles")
      .select("nombre, apellido")
      .eq("id", order.approved_by)
      .single()
      
    if (approverData && approverData.nombre) {
      approverName = `${approverData.nombre || ''} ${approverData.apellido || ''}`.trim()
    }
  }
  
  // Get action buttons based on status
  function getActionButtons(order: any): ReactNode {
    if (!order) return null
    
    // Check if this is an enhanced purchase order with po_type
    if (order.po_type) {
      // For enhanced purchase orders, let the WorkflowStatusDisplay handle actions
      return null
    }
    
    // Legacy purchase order status handling (fallback for very old orders)
    switch (order.status) {
      case 'pending_approval':
        return (
          <>
            <Button asChild variant="secondary">
              <Link href={`/compras/${order.id}/aprobar`}>
                <FileCheck className="mr-2 h-4 w-4" />
                Aprobar Orden
              </Link>
            </Button>
            <Button asChild variant="destructive">
              <Link href={`/compras/${order.id}/rechazar`}>
                Rechazar Orden
              </Link>
            </Button>
          </>
        )
      case 'approved':
        return (
          <Button asChild>
            <Link href={`/compras/${order.id}/pedido`}>
              <ShoppingCart className="mr-2 h-4 w-4" />
              Marcar como Pedida
            </Link>
          </Button>
        )
      case 'ordered':
        return (
          <Button asChild>
            <Link href={`/compras/${order.id}/recibido`}>
              <Package className="mr-2 h-4 w-4" />
              Registrar Recepción
            </Link>
          </Button>
        )
      default:
        return null
    }
  }

  // Helper function to get purchase order type display info
  function getPurchaseOrderTypeInfo(poType: string | null) {
    switch (poType) {
      case PurchaseOrderType.DIRECT_PURCHASE:
        return {
          label: "Compra Directa",
          description: "Ferretería, tienda local",
          icon: Store,
          color: "bg-blue-100 text-blue-700"
        }
      case PurchaseOrderType.DIRECT_SERVICE:
        return {
          label: "Servicio Directo", 
          description: "Técnico especialista",
          icon: Wrench,
          color: "bg-green-100 text-green-700"
        }
      case PurchaseOrderType.SPECIAL_ORDER:
        return {
          label: "Pedido Especial",
          description: "Proveedor formal",
          icon: Building2,
          color: "bg-purple-100 text-purple-700"
        }
      default:
        return null
    }
  }

  return (
    <div className="container mx-auto px-6 py-4 md:py-8">
      {/* Escalation/Approval banners */}
      {order?.status === 'pending_approval' && order?.authorized_by && (
        <Alert className="mb-6 border-blue-200 bg-blue-50">
          <AlertDescription>
            Esta orden ya fue autorizada por el Jefe de Unidad y se ha escalado a Gerencia General para aprobación final.
          </AlertDescription>
        </Alert>
      )}
      {order?.status === 'approved' && (
        <Alert className="mb-6 border-green-200 bg-green-50">
          <AlertDescription>
            Orden aprobada. Puede proceder con la compra o el siguiente paso del flujo.
          </AlertDescription>
        </Alert>
      )}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold">Orden de Compra: {order.order_id}</h1>
                     {order.po_type && (
             <div className="mt-2">
               <TypeBadge type={order.po_type as PurchaseOrderType} />
             </div>
           )}
        </div>
        <div className="flex items-center gap-2">
          {/* Report Issue Button - only show if supplier_id exists */}
          {order.supplier_id && (
            <ReportIssueButton
              purchaseOrderId={order.id}
              purchaseOrderIdDisplay={order.order_id}
              supplierId={order.supplier_id}
              supplierName={order.supplier}
            />
          )}
          {/* Edit button only when order is not validated */}
          {order.status !== 'validated' && (
            <EditPOButton
              id={order.id}
              initialData={{
                supplier: order.supplier,
                total_amount: order.total_amount ? Number(order.total_amount) : 0,
                payment_method: order.payment_method,
                notes: order.notes,
                store_location: order.store_location,
                service_provider: order.service_provider,
                quotation_url: order.quotation_url,
                purchase_date: order.purchase_date,
                max_payment_date: order.max_payment_date,
                items: items
              }}
            />
          )}
          <Button variant="outline" size="icon" asChild>
            <Link href="/compras">
              <ArrowLeft className="h-4 w-4" />
            </Link>
          </Button>
        </div>
      </div>
      
      <div className="grid gap-8 md:grid-cols-2">
        {/* Order Information */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center justify-between">
              Información General
              <Badge variant={getStatusVariant(order.status)}>
                {order.status}
              </Badge>
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {/* Purchase Order Type - only show for enhanced orders */}
            {order.po_type && (
              <div>
                <dt className="font-medium text-sm text-muted-foreground">Tipo de Orden</dt>
                <dd className="mt-1">
                  <div className="flex items-center space-x-2">
                    {(() => {
                      const typeInfo = getPurchaseOrderTypeInfo(order.po_type)
                      if (!typeInfo) return <span>{order.po_type}</span>
                      
                      const Icon = typeInfo.icon
                      return (
                        <>
                          <div className={`p-1 rounded ${typeInfo.color.replace('text-', 'bg-').replace('-700', '-200')}`}>
                            <Icon className="h-4 w-4" />
                          </div>
                          <div>
                            <span className="font-medium">{typeInfo.label}</span>
                            <span className="text-sm text-muted-foreground ml-2">
                              {typeInfo.description}
                            </span>
                          </div>
                        </>
                      )
                    })()}
                  </div>
                </dd>
              </div>
            )}

            {/* Enhanced order specific fields */}
            {order.store_location && (
              <div>
                <dt className="font-medium text-sm text-muted-foreground">Tienda/Ubicación</dt>
                <dd className="mt-1">{order.store_location}</dd>
              </div>
            )}

            {order.service_provider && (
              <div>
                <dt className="font-medium text-sm text-muted-foreground">Proveedor de Servicio</dt>
                <dd className="mt-1">{order.service_provider}</dd>
              </div>
            )}

            {order.payment_method && (
              <div>
                <dt className="font-medium text-sm text-muted-foreground">Forma de Pago</dt>
                <dd className="mt-1 capitalize">{order.payment_method}</dd>
              </div>
            )}

            {order.requires_quote !== undefined && (
              <div>
                <dt className="font-medium text-sm text-muted-foreground">Requiere Cotización</dt>
                <dd className="mt-1">
                  <Badge variant={order.requires_quote ? "default" : "secondary"}>
                    {order.requires_quote ? "Sí" : "No"}
                  </Badge>
                </dd>
              </div>
            )}

            <div>
              <dt className="font-medium text-sm text-muted-foreground">Proveedor</dt>
              <dd className="mt-1">{order.supplier || "No especificado"}</dd>
            </div>

            <div>
              <dt className="font-medium text-sm text-muted-foreground">Monto Total</dt>
              <dd className="mt-1 text-lg font-semibold">{formatCurrency(order.total_amount)}</dd>
            </div>

            {order.actual_amount && (
              <div>
                <dt className="font-medium text-sm text-muted-foreground">Monto Real Gastado</dt>
                <dd className="mt-1 text-lg font-semibold text-green-600">{formatCurrency(order.actual_amount.toString())}</dd>
              </div>
            )}

            <div>
              <dt className="font-medium text-sm text-muted-foreground">Solicitado por</dt>
              <dd className="mt-1">{requesterName}</dd>
            </div>

            {order.approved_by && (
              <div>
                <dt className="font-medium text-sm text-muted-foreground">Aprobado por</dt>
                <dd className="mt-1">{approverName}</dd>
              </div>
            )}

            <div>
              <dt className="font-medium text-sm text-muted-foreground">Fecha de Creación</dt>
              <dd className="mt-1">{formatDate(order.created_at)}</dd>
            </div>

            {order.purchase_date && (
              <div>
                <dt className="font-medium text-sm text-muted-foreground">Fecha de Compra</dt>
                <dd className="mt-1 font-semibold text-blue-600">{formatDate(order.purchase_date)}</dd>
              </div>
            )}

            {order.approval_date && (
              <div>
                <dt className="font-medium text-sm text-muted-foreground">Fecha de Aprobación</dt>
                <dd className="mt-1">{formatDate(order.approval_date)}</dd>
              </div>
            )}

            {order.purchased_at && (
              <div>
                <dt className="font-medium text-sm text-muted-foreground">Fecha de Compra</dt>
                <dd className="mt-1">{formatDate(order.purchased_at)}</dd>
              </div>
            )}

            {order.notes && (
              <div>
                <dt className="font-medium text-sm text-muted-foreground">Notas</dt>
                <dd className="mt-1 break-words whitespace-pre-wrap">{order.notes}</dd>
              </div>
            )}

            {order.quotation_url && (
              <div>
                <dt className="font-medium text-sm text-muted-foreground">Cotización</dt>
                <dd className="mt-1">
                  <div className="flex items-center space-x-2">
                    <Badge variant="outline" className="text-green-600 border-green-200">
                      <FileText className="h-3 w-3 mr-1" />
                      Cotización Disponible
                    </Badge>
                    <Button asChild variant="outline" size="sm">
                      <a 
                        href={order.quotation_url} 
                        target="_blank" 
                        rel="noopener noreferrer"
                        className="flex items-center space-x-1"
                      >
                        <Download className="h-4 w-4" />
                        <span>Ver Cotización</span>
                        <ExternalLink className="h-3 w-3" />
                      </a>
                    </Button>
                  </div>
                </dd>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Receipt/Comprobante Section - Always show if exists */}
        <ReceiptDisplaySection purchaseOrderId={order.id} poType={order.po_type} />

        {/* Quotation Section - Always show for enhanced orders */}
        {order.po_type && (
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center space-x-2">
                <FileText className="h-5 w-5" />
                <span>Cotización</span>
                {order.requires_quote && (
                  <Badge variant={order.quotation_url ? "default" : "destructive"}>
                    {order.quotation_url ? "Completada" : "Requerida"}
                  </Badge>
                )}
              </CardTitle>
            {order.requires_quote && (
              <CardDescription>
                {order.po_type === PurchaseOrderType.DIRECT_SERVICE
                  ? `Esta orden de servicio por ${formatCurrency(order.total_amount)} requiere cotización por ser mayor a $10,000 MXN`
                  : "Esta orden requiere cotización antes de ser aprobada"
                }
              </CardDescription>
            )}
            </CardHeader>
            <CardContent className="space-y-4">
              <QuotationManager 
                purchaseOrderId={order.id}
                workOrderId={order.work_order_id}
                legacyUrl={order.quotation_url}
              />
            </CardContent>
          </Card>
        )}

        {/* Work Order Information */}
        <Card>
          <CardHeader>
            <CardTitle>Relación con Orden de Trabajo</CardTitle>
          </CardHeader>
          <CardContent>
            <PurchaseOrderWorkOrderLink 
              workOrder={workOrder}
              isAdjustment={order.is_adjustment || false}
            />
          </CardContent>
        </Card>
      </div>

      {/* Items/Services */}
      {items && items.length > 0 && (
        <Card className="mt-8">
          <CardHeader>
            <CardTitle>
              {order.po_type === PurchaseOrderType.DIRECT_SERVICE 
                ? "Servicios Solicitados" 
                : order.po_type === PurchaseOrderType.DIRECT_PURCHASE 
                ? "Productos Solicitados"
                : "Artículos Solicitados"
              }
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="overflow-x-auto">
              {/* Direct Service Display */}
              {order.po_type === PurchaseOrderType.DIRECT_SERVICE ? (
                <table className="w-full border-collapse">
                  <thead>
                    <tr className="border-b">
                      <th className="text-left p-2">Descripción del Servicio</th>
                      <th className="text-left p-2">Categoría</th>
                      <th className="text-right p-2">Horas Estimadas</th>
                      <th className="text-right p-2">Tarifa por Hora</th>
                      <th className="text-right p-2">Costo Total</th>
                    </tr>
                  </thead>
                  <tbody>
                    {items.map((service: any, index: number) => (
                      <tr key={index} className="border-b">
                        <td className="p-2">
                          <div>
                            <p className="font-medium">{service.description || "Sin descripción"}</p>
                            {service.specialist_required && (
                              <Badge variant="secondary" className="text-xs mt-1">
                                Especialista Requerido
                              </Badge>
                            )}
                          </div>
                        </td>
                        <td className="p-2">{service.category || "General"}</td>
                        <td className="p-2 text-right">
                          {service.estimated_hours ? `${Number(service.estimated_hours).toFixed(1)}h` : "N/A"}
                        </td>
                        <td className="p-2 text-right">
                          {formatCurrency(service.hourly_rate?.toString() || "0")}
                        </td>
                        <td className="p-2 text-right font-medium">
                          {formatCurrency(service.total_cost?.toString() || "0")}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : (
                /* Generic Items Display for other types */
                <table className="w-full border-collapse">
                  <thead>
                    <tr className="border-b">
                      <th className="text-left p-2">Descripción</th>
                      <th className="text-left p-2">Parte/Código</th>
                      <th className="text-right p-2">Cantidad</th>
                      <th className="text-right p-2">Precio Unitario</th>
                      <th className="text-right p-2">Total</th>
                    </tr>
                  </thead>
                  <tbody>
                    {items.map((item: any, index: number) => (
                      <tr key={index} className="border-b">
                        <td className="p-2">{item.description || item.item || item.name || "Sin descripción"}</td>
                        <td className="p-2">{item.part_number || item.code || "N/A"}</td>
                        <td className="p-2 text-right">{item.quantity || 1}</td>
                        <td className="p-2 text-right">{formatCurrency(item.unit_price?.toString() || item.price?.toString() || "0")}</td>
                        <td className="p-2 text-right">{formatCurrency(item.total_price?.toString() || (item.quantity * (item.unit_price || item.price || 0)).toString())}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Enhanced Workflow Status Display */}
      {order.po_type && (
        <div className="mt-8">
          <WorkflowStatusDisplay
            purchaseOrderId={order.id}
            poType={order.po_type as PurchaseOrderType}
            currentStatus={order.status}
          />
        </div>
      )}

      {/* Legacy Action Buttons and Receipt Section for old system */}
      {!order.po_type && (
        <>
          <Card className="mt-8">
            <CardHeader>
              <CardTitle>Acciones</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="flex gap-4">
                {getActionButtons(order)}
              </div>
            </CardContent>
          </Card>
          
          {/* Receipt Section - only for legacy orders */}
          <div className="mt-8">
            <ReceiptSection purchaseOrderId={order.id} isAdjustment={order.is_adjustment || false} />
          </div>
        </>
      )}
    </div>
  )
} 

// removed inline client bridge; using dedicated client component instead