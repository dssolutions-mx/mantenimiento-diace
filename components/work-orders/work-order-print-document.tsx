"use client"

import { format } from "date-fns"
import { es } from "date-fns/locale"
import { Button } from "@/components/ui/button"
import { Printer, X } from "lucide-react"
import { useRouter } from "next/navigation"

interface WorkOrderPrintDocumentProps {
  workOrder: any
  asset?: any
  purchaseOrders?: any[]
  profiles?: Record<string, any>
  requiredParts?: any[]
  totalPartsCost?: number
  requiredTasks?: any[]
}

export function WorkOrderPrintDocument({
  workOrder,
  asset,
  purchaseOrders = [],
  profiles = {},
  requiredParts = [],
  totalPartsCost = 0,
  requiredTasks = []
}: WorkOrderPrintDocumentProps) {
  const router = useRouter()
  
  const handlePrint = () => {
    window.print()
  }
  
  const handleClose = () => {
    router.back()
  }

  const formatDate = (dateString: string | null | undefined) => {
    if (!dateString) return "N/A"
    try {
      return format(new Date(dateString), "dd 'de' MMMM 'de' yyyy", { locale: es })
    } catch (error) {
      return dateString
    }
  }

  const formatCurrency = (amount: string | number | null | undefined) => {
    if (!amount) return "$0.00"
    const numAmount = typeof amount === 'string' ? parseFloat(amount) : amount
    return new Intl.NumberFormat("es-MX", {
      style: "currency",
      currency: "MXN"
    }).format(numAmount)
  }

  const getProfileName = (profileId: string | null) => {
    if (!profileId) return "No asignado"
    const profile = profiles[profileId]
    if (!profile) return "No asignado"
    return profile.nombre && profile.apellido 
      ? `${profile.nombre} ${profile.apellido}`
      : profile.nombre || "No asignado"
  }

  // Calculate costs
  const regularPOs = purchaseOrders.filter(po => !po.is_adjustment)
  const quotedCost = regularPOs.reduce((sum, po) => {
    const amount = typeof po.total_amount === 'string' ? parseFloat(po.total_amount) : po.total_amount
    return sum + (amount || 0)
  }, 0)

  const actualCost = regularPOs.reduce((sum, po) => {
    if (po.actual_amount) {
      const amount = typeof po.actual_amount === 'string' ? parseFloat(po.actual_amount) : po.actual_amount
      return sum + (amount || 0)
    }
    const amount = typeof po.total_amount === 'string' ? parseFloat(po.total_amount) : po.total_amount
    return sum + (amount || 0)
  }, 0)

  const estimatedCost = workOrder.estimated_cost 
    ? (typeof workOrder.estimated_cost === 'string' ? parseFloat(workOrder.estimated_cost) : workOrder.estimated_cost)
    : 0

  const hasReceipts = regularPOs.some(po => po.actual_amount || ['received', 'validated'].includes(po.status))
  const primaryCost = hasReceipts ? actualCost : (quotedCost || estimatedCost || totalPartsCost)

  // Get PO items if available
  let poItems: any[] = []
  if (regularPOs.length > 0 && regularPOs[0].items) {
    const items = typeof regularPOs[0].items === 'string' 
      ? JSON.parse(regularPOs[0].items) 
      : regularPOs[0].items
    if (Array.isArray(items)) {
      poItems = items
    }
  }

  const displayParts = poItems.length > 0 ? poItems : requiredParts

  return (
    <div className="print-document" style={{ 
      position: 'fixed',
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      overflow: 'auto',
      backgroundColor: 'white',
      width: '100%',
      height: '100%'
    }}>
      {/* Print Controls - Hidden when printing */}
      <div className="no-print fixed top-4 right-4 z-50 flex gap-2 bg-white p-2 rounded shadow-lg border">
        <Button onClick={handlePrint} className="bg-blue-600 hover:bg-blue-700">
          <Printer className="h-4 w-4 mr-2" />
          Imprimir
        </Button>
        <Button variant="outline" onClick={handleClose}>
          <X className="h-4 w-4 mr-2" />
          Cerrar
        </Button>
      </div>

      <style dangerouslySetInnerHTML={{__html: `
        /* Hide sidebar and header in screen view for print page */
        aside,
        header:not(.print-header),
        nav,
        [role="navigation"],
        [role="banner"] {
          display: none !important;
        }
        
        /* Remove scrollbars from body */
        html, body {
          overflow: hidden !important;
          height: 100% !important;
          margin: 0 !important;
          padding: 0 !important;
        }
        
        /* Ensure print document container takes full space */
        .print-document {
          position: relative;
          z-index: 1;
          width: 100%;
          height: 100%;
          overflow-y: auto;
          overflow-x: hidden;
        }
        
        @media print {
          @page {
            margin: 1cm;
            size: A4;
          }
          
          html, body {
            margin: 0 !important;
            padding: 0 !important;
            font-family: Arial, sans-serif;
            font-size: 9pt;
            line-height: 1.3;
            color: #000;
            overflow: visible !important;
            height: auto !important;
          }
          
          /* Hide sidebar and header when printing */
          aside,
          header,
          nav,
          [role="navigation"],
          [role="banner"],
          .no-print {
            display: none !important;
            visibility: hidden !important;
            width: 0 !important;
            height: 0 !important;
            margin: 0 !important;
            padding: 0 !important;
          }
          
          /* Remove all layout wrappers */
          body > div,
          body > div > div {
            margin: 0 !important;
            padding: 0 !important;
            width: 100% !important;
            max-width: 100% !important;
          }
        }
        
        .print-document {
          max-width: 21cm;
          margin: 0 auto;
          padding: 0.8cm;
          font-family: Arial, sans-serif;
          font-size: 9pt;
          line-height: 1.3;
          color: #000;
        }
        
        .print-header {
          border-bottom: 2px solid #000;
          padding-bottom: 8px;
          margin-bottom: 10px;
        }
        
        .print-header table {
          width: 100%;
          border-collapse: collapse;
        }
        
        .print-header td {
          padding: 2px 4px;
          vertical-align: top;
        }
        
        .print-title {
          font-size: 16pt;
          font-weight: bold;
          text-transform: uppercase;
          letter-spacing: 1px;
          margin: 0;
        }
        
        .print-subtitle {
          font-size: 8pt;
          color: #333;
          margin: 2px 0 0 0;
        }
        
        .print-order-id {
          font-size: 18pt;
          font-weight: bold;
          text-align: right;
          margin: 0;
        }
        
        .print-date {
          font-size: 8pt;
          text-align: right;
          margin: 2px 0 0 0;
        }
        
        .print-info-row {
          font-size: 8pt;
          padding: 2px 0;
        }
        
        .print-section {
          margin-top: 10px;
          page-break-inside: avoid;
        }
        
        .print-section-title {
          font-size: 10pt;
          font-weight: bold;
          text-transform: uppercase;
          border-bottom: 1px solid #000;
          padding-bottom: 3px;
          margin-bottom: 6px;
        }
        
        .print-table {
          width: 100%;
          border-collapse: collapse;
          margin: 6px 0;
          font-size: 8pt;
        }
        
        .print-table th {
          background-color: #e0e0e0;
          border: 1px solid #000;
          padding: 4px 6px;
          text-align: left;
          font-weight: bold;
          text-transform: uppercase;
        }
        
        .print-table td {
          border: 1px solid #000;
          padding: 3px 6px;
        }
        
        .print-table .text-right {
          text-align: right;
        }
        
        .print-table .text-center {
          text-align: center;
        }
        
        .print-info-table {
          width: 100%;
          border-collapse: collapse;
          margin: 4px 0;
          font-size: 8pt;
        }
        
        .print-info-table td {
          padding: 2px 4px;
          vertical-align: top;
        }
        
        .print-info-table .label {
          font-weight: bold;
          width: 35%;
        }
        
        .print-signature-section {
          margin-top: 15px;
          padding-top: 10px;
          border-top: 2px solid #000;
          page-break-inside: avoid;
        }
        
        .print-signature-box {
          display: inline-block;
          width: 32%;
          vertical-align: top;
          margin-right: 1%;
          border: 1px solid #000;
          padding: 6px;
          font-size: 8pt;
        }
        
        .print-signature-title {
          font-weight: bold;
          text-transform: uppercase;
          border-bottom: 1px solid #000;
          padding-bottom: 3px;
          margin-bottom: 6px;
          font-size: 8pt;
        }
        
        .print-signature-line {
          border-bottom: 1px solid #000;
          height: 40px;
          margin: 8px 0 4px 0;
        }
        
        .print-signature-field {
          margin: 3px 0;
          font-size: 7pt;
        }
      `}} />

      <div style={{ padding: '20px', maxWidth: '21cm', margin: '0 auto' }}>
        {/* Header */}
        <div className="print-header">
          <table>
            <tbody>
              <tr>
                <td style={{ width: '60%' }}>
                  <h1 className="print-title">Orden de Trabajo</h1>
                  <p className="print-subtitle">Sistema de Gestión de Mantenimiento Industrial</p>
                </td>
                <td style={{ width: '40%', textAlign: 'right', borderLeft: '2px solid #000', paddingLeft: '10px' }}>
                  <p className="print-order-id">{workOrder.order_id}</p>
                  <p className="print-date">Fecha: {formatDate(workOrder.created_at)}</p>
                </td>
              </tr>
            </tbody>
          </table>
          <table className="print-info-table" style={{ marginTop: '6px' }}>
            <tbody>
              <tr>
                <td className="label">Estado:</td>
                <td>{(workOrder.status || "Pendiente").toUpperCase()}</td>
                <td className="label" style={{ paddingLeft: '20px' }}>Tipo:</td>
                <td>{(workOrder.type || "N/A").toUpperCase()}</td>
                <td className="label" style={{ paddingLeft: '20px' }}>Prioridad:</td>
                <td>{(workOrder.priority || "Media").toUpperCase()}</td>
              </tr>
            </tbody>
          </table>
        </div>

        {/* General Information */}
        <div className="print-section">
          <div className="print-section-title">Información General</div>
          <table className="print-info-table">
            <tbody>
              <tr>
                <td className="label">Descripción:</td>
                <td colSpan={5}>{workOrder.description || "Sin descripción"}</td>
              </tr>
              <tr>
                <td className="label">Solicitado por:</td>
                <td>{getProfileName(workOrder.requested_by)}</td>
                <td className="label" style={{ paddingLeft: '20px' }}>Técnico asignado:</td>
                <td>{getProfileName(workOrder.assigned_to)}</td>
              </tr>
              <tr>
                <td className="label">Fecha de creación:</td>
                <td>{formatDate(workOrder.created_at)}</td>
                <td className="label" style={{ paddingLeft: '20px' }}>Fecha programada:</td>
                <td>{workOrder.planned_date ? formatDate(workOrder.planned_date) : "No planificada"}</td>
              </tr>
              {workOrder.estimated_duration && (
                <tr>
                  <td className="label">Duración estimada:</td>
                  <td>{workOrder.estimated_duration} horas</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        {/* Asset Information */}
        {asset && (
          <div className="print-section">
            <div className="print-section-title">Información del Activo</div>
            <table className="print-info-table">
              <tbody>
                <tr>
                  <td className="label">Nombre:</td>
                  <td>{asset.name || "N/A"}</td>
                  <td className="label" style={{ paddingLeft: '20px' }}>ID del Activo:</td>
                  <td>{asset.asset_id || "N/A"}</td>
                </tr>
                {asset.location && (
                  <tr>
                    <td className="label">Ubicación:</td>
                    <td>{asset.location}</td>
                    {asset.current_hours && (
                      <>
                        <td className="label" style={{ paddingLeft: '20px' }}>Horas actuales:</td>
                        <td>{Number(asset.current_hours).toLocaleString()} hrs</td>
                      </>
                    )}
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )}

        {/* Required Tasks Section */}
        {requiredTasks.length > 0 && (
          <div className="print-section">
            <div className="print-section-title">Tareas de Mantenimiento</div>
            <table className="print-table">
              <thead>
                <tr>
                  <th style={{ width: '5%' }}>#</th>
                  <th style={{ width: '50%' }}>Descripción</th>
                  <th style={{ width: '15%' }}>Tipo</th>
                  <th style={{ width: '10%' }}>Tiempo Est.</th>
                  <th style={{ width: '20%' }}>Repuestos</th>
                </tr>
              </thead>
              <tbody>
                {requiredTasks.map((task: any, index: number) => (
                  <tr key={task.id || index}>
                    <td className="text-center">{index + 1}</td>
                    <td>{task.description || 'N/A'}</td>
                    <td>{task.type || 'N/A'}</td>
                    <td className="text-center">{task.estimated_time ? `${task.estimated_time} hrs` : 'N/A'}</td>
                    <td>
                      {task.parts && task.parts.length > 0 ? (
                        <div style={{ fontSize: '7pt' }}>
                          {task.parts.map((part: any, idx: number) => (
                            <div key={idx}>
                              • {part.name} {part.part_number ? `(${part.part_number})` : ''} x{part.quantity}
                            </div>
                          ))}
                        </div>
                      ) : (
                        'N/A'
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {/* Parts/Materials Section */}
        {displayParts.length > 0 && (
          <div className="print-section">
            <div className="print-section-title">Repuestos y Materiales</div>
            <table className="print-table">
              <thead>
                <tr>
                  <th style={{ width: '40%' }}>Descripción</th>
                  <th style={{ width: '15%' }}>Parte #</th>
                  <th style={{ width: '10%' }} className="text-center">Cantidad</th>
                  <th style={{ width: '15%' }} className="text-right">Precio Unit.</th>
                  <th style={{ width: '20%' }} className="text-right">Total</th>
                </tr>
              </thead>
              <tbody>
                {displayParts.map((part: any, index: number) => {
                  const partName = part.name || part.description || part.item || 'N/A'
                  const partNumber = part.partNumber || part.part_number || part.code || 'N/A'
                  const quantity = Number(part.quantity) || 1
                  const unitPrice = Number(part.unit_price || part.price || 0)
                  const totalPrice = Number(part.total_price) || (quantity * unitPrice)
                  
                  return (
                    <tr key={index}>
                      <td>{partName}</td>
                      <td>{partNumber}</td>
                      <td className="text-center">{quantity}</td>
                      <td className="text-right">{formatCurrency(unitPrice)}</td>
                      <td className="text-right">{formatCurrency(totalPrice)}</td>
                    </tr>
                  )
                })}
                <tr style={{ fontWeight: 'bold', backgroundColor: '#f0f0f0' }}>
                  <td colSpan={4} className="text-right">Total:</td>
                  <td className="text-right">{formatCurrency(totalPartsCost || displayParts.reduce((sum: number, p: any) => sum + (Number(p.total_price) || 0), 0))}</td>
                </tr>
              </tbody>
            </table>
          </div>
        )}

        {/* Cost Section */}
        <div className="print-section">
          <div className="print-section-title">Información de Costos</div>
          <table className="print-info-table">
            <tbody>
              {estimatedCost > 0 && (
                <tr>
                  <td className="label">Costo estimado:</td>
                  <td>{formatCurrency(estimatedCost)}</td>
                </tr>
              )}
              {quotedCost > 0 && (
                <tr>
                  <td className="label">Costo cotizado:</td>
                  <td>{formatCurrency(quotedCost)}</td>
                </tr>
              )}
              {hasReceipts && actualCost > 0 && (
                <tr>
                  <td className="label">Costo real:</td>
                  <td>{formatCurrency(actualCost)}</td>
                </tr>
              )}
              <tr style={{ fontWeight: 'bold', borderTop: '1px solid #000', paddingTop: '4px' }}>
                <td className="label">Costo total:</td>
                <td>{formatCurrency(primaryCost)}</td>
              </tr>
            </tbody>
          </table>
        </div>

        {/* Purchase Order Section */}
        {regularPOs.length > 0 && (
          <div className="print-section">
            <div className="print-section-title">Orden de Compra</div>
            {regularPOs.map((po, index) => (
              <table key={index} className="print-info-table" style={{ marginBottom: '8px' }}>
                <tbody>
                  <tr>
                    <td className="label">Número de OC:</td>
                    <td>{po.order_id || "N/A"}</td>
                    <td className="label" style={{ paddingLeft: '20px' }}>Proveedor:</td>
                    <td>{po.supplier || po.service_provider || "N/A"}</td>
                  </tr>
                  <tr>
                    <td className="label">Estado:</td>
                    <td>{po.status || "N/A"}</td>
                    <td className="label" style={{ paddingLeft: '20px' }}>Monto:</td>
                    <td>{formatCurrency(po.actual_amount || po.total_amount)}</td>
                  </tr>
                </tbody>
              </table>
            ))}
          </div>
        )}

        {/* Signature Section */}
        <div className="print-signature-section">
          <div className="print-signature-box">
            <div className="print-signature-title">Quien Ejecuta los Trabajos</div>
            <div className="print-signature-line"></div>
            <div className="print-signature-field">
              <strong>Nombre:</strong> _______________________________
            </div>
            <div className="print-signature-field">
              <strong>Cédula/ID:</strong> _______________________________
            </div>
            <div className="print-signature-field">
              <strong>Fecha:</strong> _______________________________
            </div>
            <div className="print-signature-line" style={{ marginTop: '8px' }}></div>
            <div className="print-signature-field" style={{ textAlign: 'center', marginTop: '4px' }}>
              Firma
            </div>
            <div className="print-signature-field" style={{ fontSize: '7pt', fontStyle: 'italic', textAlign: 'center', marginTop: '4px' }}>
              Certifico que el trabajo fue realizado según especificaciones
            </div>
          </div>
          
          <div className="print-signature-box">
            <div className="print-signature-title">Quien Entrega la Orden</div>
            <div className="print-signature-line"></div>
            <div className="print-signature-field">
              <strong>Nombre:</strong> _______________________________
            </div>
            <div className="print-signature-field">
              <strong>Cargo:</strong> _______________________________
            </div>
            <div className="print-signature-field">
              <strong>Fecha:</strong> _______________________________
            </div>
            <div className="print-signature-line" style={{ marginTop: '8px' }}></div>
            <div className="print-signature-field" style={{ textAlign: 'center', marginTop: '4px' }}>
              Firma
            </div>
            <div className="print-signature-field" style={{ fontSize: '7pt', fontStyle: 'italic', textAlign: 'center', marginTop: '4px' }}>
              Entrego la orden de trabajo para su ejecución
            </div>
          </div>
          
          <div className="print-signature-box" style={{ marginRight: '0' }}>
            <div className="print-signature-title">Quien Recibe el Equipo</div>
            <div className="print-signature-line"></div>
            <div className="print-signature-field">
              <strong>Nombre:</strong> _______________________________
            </div>
            <div className="print-signature-field">
              <strong>Cargo:</strong> _______________________________
            </div>
            <div className="print-signature-field">
              <strong>Fecha:</strong> _______________________________
            </div>
            <div className="print-signature-line" style={{ marginTop: '8px' }}></div>
            <div className="print-signature-field" style={{ textAlign: 'center', marginTop: '4px' }}>
              Firma
            </div>
            <div className="print-signature-field" style={{ fontSize: '7pt', fontStyle: 'italic', textAlign: 'center', marginTop: '4px' }}>
              Recibo el equipo conforme después de la ejecución del trabajo
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

