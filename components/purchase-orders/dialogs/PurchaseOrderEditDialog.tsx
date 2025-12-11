"use client"

import { useEffect, useMemo, useState } from "react"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Plus, Trash2, Save, Loader2 } from "lucide-react"
import { toast } from "@/components/ui/use-toast"

type PurchaseOrderEditable = {
  supplier?: string | null
  total_amount?: number | null
  payment_method?: string | null
  notes?: string | null
  store_location?: string | null
  service_provider?: string | null
  purchase_date?: string | null
  max_payment_date?: string | null
  items?: any[] | null
}

interface PurchaseOrderEditDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  purchaseOrderId: string
  initialData: PurchaseOrderEditable
  onUpdated?: () => void
}

export function PurchaseOrderEditDialog({ open, onOpenChange, purchaseOrderId, initialData, onUpdated }: PurchaseOrderEditDialogProps) {
  const [form, setForm] = useState<PurchaseOrderEditable>({})
  const [items, setItems] = useState<any[]>([])
  const [isSaving, setIsSaving] = useState(false)

  useEffect(() => {
    if (open) {
      // Helper to convert ISO date string to YYYY-MM-DD format for date inputs
      const formatDateForInput = (dateValue: string | null | undefined): string => {
        if (!dateValue) return ""
        try {
          const date = new Date(dateValue)
          if (isNaN(date.getTime())) return ""
          return date.toISOString().slice(0, 10)
        } catch {
          return ""
        }
      }

      setForm({
        supplier: initialData.supplier ?? "",
        total_amount: initialData.total_amount ?? 0,
        payment_method: initialData.payment_method ?? "",
        notes: initialData.notes ?? "",
        store_location: initialData.store_location ?? "",
        service_provider: initialData.service_provider ?? "",
        purchase_date: formatDateForInput(initialData.purchase_date),
        max_payment_date: formatDateForInput(initialData.max_payment_date),
      })
      setItems(Array.isArray(initialData.items) ? initialData.items : [])
    }
  }, [open, initialData])

  const handleChange = (key: keyof PurchaseOrderEditable, value: any) => {
    setForm(prev => ({ ...prev, [key]: value }))
  }

  const addItem = () => {
    setItems(prev => [...prev, { description: "", part_number: "", quantity: 1, unit_price: 0, total_price: 0 }])
  }

  const updateItem = (index: number, key: string, value: any) => {
    setItems(prev => {
      const next = [...prev]
      const item = { ...next[index], [key]: value }
      const quantity = Number(item.quantity) || 0
      const unit = Number(item.unit_price) || 0
      item.total_price = Number((quantity * unit).toFixed(2))
      next[index] = item
      return next
    })
  }

  const removeItem = (index: number) => {
    setItems(prev => prev.filter((_, i) => i !== index))
  }

  const totalCalculated = useMemo(() => {
    return items.reduce((sum, it) => sum + (Number(it.total_price) || 0), 0)
  }, [items])

  const handleSave = async () => {
    try {
      setIsSaving(true)
      
      // Prepare payload, converting empty date strings to null
      const payload: PurchaseOrderEditable = {
        supplier: form.supplier || null,
        total_amount: typeof form.total_amount === 'number' && form.total_amount > 0 ? form.total_amount : totalCalculated,
        payment_method: form.payment_method || null,
        notes: form.notes || null,
        store_location: form.store_location || null,
        service_provider: form.service_provider || null,
        // Convert empty date strings to null, keep valid dates as-is (API will convert to ISO)
        purchase_date: form.purchase_date && form.purchase_date.trim() ? form.purchase_date : null,
        max_payment_date: form.max_payment_date && form.max_payment_date.trim() ? form.max_payment_date : null,
        items: items.length > 0 ? items : null
      }

      const res = await fetch(`/api/purchase-orders/${purchaseOrderId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      })
      const data = await res.json()
      if (!res.ok) {
        const errorMessage = data?.details || data?.error || 'Error al guardar cambios'
        throw new Error(errorMessage)
      }

      toast({ title: 'Orden actualizada', description: 'Los cambios se guardaron correctamente.' })
      onOpenChange(false)
      onUpdated?.()
    } catch (error: any) {
      toast({ title: 'Error', description: error.message || 'No se pudo actualizar la orden', variant: 'destructive' })
    } finally {
      setIsSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl max-h-[90vh] overflow-hidden flex flex-col">
        <DialogHeader>
          <DialogTitle>Editar Orden de Compra</DialogTitle>
          <DialogDescription>Actualiza la información general y los artículos.</DialogDescription>
        </DialogHeader>

        <div className="flex-1 overflow-y-auto min-h-0 pr-2">
          <div className="grid gap-4 grid-cols-1 md:grid-cols-2">
            <div className="space-y-2">
              <Label>Proveedor</Label>
              <Input value={form.supplier as string} onChange={e => handleChange('supplier', e.target.value)} />
            </div>

            <div className="space-y-2">
              <Label>Monto Total</Label>
              <Input type="number" value={form.total_amount ?? 0} onChange={e => handleChange('total_amount', Number(e.target.value))} />
            </div>

            <div className="space-y-2">
              <Label>Fecha de Compra *</Label>
              <Input type="date" value={form.purchase_date ? String(form.purchase_date).slice(0,10) : ''} onChange={e => handleChange('purchase_date', e.target.value)} />
            </div>

            <div className="space-y-2">
              <Label>Forma de pago</Label>
              <Input value={form.payment_method as string} onChange={e => handleChange('payment_method', e.target.value)} placeholder="cash | transfer | card" />
            </div>

            <div className="space-y-2">
              <Label>Fecha máxima de pago</Label>
              <Input type="date" value={form.max_payment_date ? String(form.max_payment_date).slice(0,10) : ''} onChange={e => handleChange('max_payment_date', e.target.value)} />
            </div>

            <div className="space-y-2 md:col-span-2">
              <Label>Notas</Label>
              <Textarea rows={3} value={form.notes as string} onChange={e => handleChange('notes', e.target.value)} />
            </div>

            <div className="space-y-2">
              <Label>Tienda/Ubicación</Label>
              <Input value={form.store_location as string} onChange={e => handleChange('store_location', e.target.value)} />
            </div>

            <div className="space-y-2">
              <Label>Proveedor de Servicio</Label>
              <Input value={form.service_provider as string} onChange={e => handleChange('service_provider', e.target.value)} />
            </div>

            {/* Quotation URL removed; quotations managed in separate manager */}
          </div>

          <div className="mt-4">
            <div className="flex items-center justify-between mb-2">
              <Label className="text-base">Artículos/Servicios</Label>
              <Button size="sm" variant="outline" onClick={addItem}><Plus className="h-4 w-4 mr-1" />Agregar</Button>
            </div>
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Descripción</TableHead>
                    <TableHead>Parte/Código</TableHead>
                    <TableHead className="text-right">Cantidad</TableHead>
                    <TableHead className="text-right">Precio Unitario</TableHead>
                    <TableHead className="text-right">Total</TableHead>
                    <TableHead></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {items.map((it, idx) => (
                    <TableRow key={idx}>
                      <TableCell>
                        <Input value={it.description || it.name || ''} onChange={e => updateItem(idx, 'description', e.target.value)} />
                      </TableCell>
                      <TableCell>
                        <Input value={it.part_number || it.partNumber || ''} onChange={e => updateItem(idx, 'part_number', e.target.value)} />
                      </TableCell>
                      <TableCell className="text-right">
                        <Input type="number" value={it.quantity ?? 1} onChange={e => updateItem(idx, 'quantity', Number(e.target.value))} />
                      </TableCell>
                      <TableCell className="text-right">
                        <Input type="number" value={it.unit_price ?? 0} onChange={e => updateItem(idx, 'unit_price', Number(e.target.value))} />
                      </TableCell>
                      <TableCell className="text-right">
                        {Number(it.total_price || 0).toFixed(2)}
                      </TableCell>
                      <TableCell className="text-right">
                        <Button variant="ghost" size="icon" onClick={() => removeItem(idx)}>
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
            <div className="text-right mt-2 font-medium">Total calculado: ${totalCalculated.toFixed(2)}</div>
          </div>
        </div>

        <DialogFooter className="mt-4 flex-shrink-0">
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancelar</Button>
          <Button onClick={handleSave} disabled={isSaving}>
            {isSaving ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Save className="h-4 w-4 mr-2" />}
            Guardar cambios
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}


