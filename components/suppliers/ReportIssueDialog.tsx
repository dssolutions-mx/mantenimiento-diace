"use client"

import { useState } from "react"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { AlertCircle } from "lucide-react"
import { createClient } from "@/lib/supabase"
import { toast } from "sonner"

interface ReportIssueDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  purchaseOrderId: string
  supplierId: string
  purchaseOrderIdDisplay?: string
  onSuccess?: () => void
}

export function ReportIssueDialog({
  open,
  onOpenChange,
  purchaseOrderId,
  supplierId,
  purchaseOrderIdDisplay,
  onSuccess
}: ReportIssueDialogProps) {
  const [issueType, setIssueType] = useState<string>("")
  const [severity, setSeverity] = useState<string>("medium")
  const [description, setDescription] = useState("")
  const [loading, setLoading] = useState(false)

  const handleSubmit = async () => {
    if (!issueType || !description.trim()) {
      toast.error("Por favor completa todos los campos requeridos")
      return
    }

    setLoading(true)
    try {
      const supabase = createClient()

      // Check if performance history record exists for this purchase order
      const { data: existingRecord } = await supabase
        .from('supplier_performance_history')
        .select('id, issues, notes')
        .eq('purchase_order_id', purchaseOrderId)
        .eq('supplier_id', supplierId)
        .single()

      const issueText = `${issueType}: ${description}`
      const severityLabel = severity === 'low' ? 'Baja' : severity === 'medium' ? 'Media' : 'Alta'
      const fullNote = `[${severityLabel}] ${issueText}${existingRecord?.notes ? `\n\n${existingRecord.notes}` : ''}`

      if (existingRecord) {
        // Update existing record
        const existingIssues = existingRecord.issues || []
        const updatedIssues = [...existingIssues, issueText]

        const { error } = await supabase
          .from('supplier_performance_history')
          .update({
            issues: updatedIssues,
            notes: fullNote,
            updated_at: new Date().toISOString()
          })
          .eq('id', existingRecord.id)

        if (error) throw error
      } else {
        // Create new record
        const { error } = await supabase
          .from('supplier_performance_history')
          .insert({
            supplier_id: supplierId,
            purchase_order_id: purchaseOrderId,
            order_date: new Date().toISOString().split('T')[0],
            issues: [issueText],
            notes: fullNote
          })

        if (error) throw error
      }

      toast.success("Problema reportado exitosamente")
      setIssueType("")
      setSeverity("medium")
      setDescription("")
      onOpenChange(false)
      onSuccess?.()
    } catch (error: any) {
      console.error('Error reporting issue:', error)
      toast.error(`Error al reportar problema: ${error.message || 'Error desconocido'}`)
    } finally {
      setLoading(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[500px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <AlertCircle className="w-5 h-5 text-red-500" />
            Reportar Problema
          </DialogTitle>
          <DialogDescription>
            {purchaseOrderIdDisplay && (
              <span>Orden de Compra: <strong>{purchaseOrderIdDisplay}</strong></span>
            )}
            {!purchaseOrderIdDisplay && "Reporta un problema relacionado con esta orden de compra"}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4 py-4">
          <div className="space-y-2">
            <Label htmlFor="issue-type">Tipo de Problema *</Label>
            <Select value={issueType} onValueChange={setIssueType}>
              <SelectTrigger id="issue-type">
                <SelectValue placeholder="Selecciona el tipo de problema" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="delivery">Entrega (Retraso, daños, etc.)</SelectItem>
                <SelectItem value="quality">Calidad (Producto defectuoso, no cumple especificaciones)</SelectItem>
                <SelectItem value="service">Servicio (Atención al cliente, comunicación)</SelectItem>
                <SelectItem value="billing">Facturación (Errores en factura, precios)</SelectItem>
                <SelectItem value="other">Otro</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Label htmlFor="severity">Severidad</Label>
            <Select value={severity} onValueChange={setSeverity}>
              <SelectTrigger id="severity">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="low">Baja</SelectItem>
                <SelectItem value="medium">Media</SelectItem>
                <SelectItem value="high">Alta</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Label htmlFor="description">Descripción del Problema *</Label>
            <Textarea
              id="description"
              placeholder="Describe el problema en detalle..."
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={5}
              className="resize-none"
            />
            <p className="text-xs text-muted-foreground">
              Sé específico sobre qué salió mal y cómo afectó la operación
            </p>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={loading}>
            Cancelar
          </Button>
          <Button onClick={handleSubmit} disabled={loading || !issueType || !description.trim()}>
            {loading ? "Enviando..." : "Reportar Problema"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
