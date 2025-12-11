"use client"

import { useEffect, useMemo, useState } from "react"
import { createBrowserClient } from "@supabase/ssr"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Loader2 } from "lucide-react"
import { toast } from "sonner"

interface CreateDieselWarehouseDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onCreated?: () => void
  defaultProductType?: 'diesel' | 'urea'
}

export function CreateDieselWarehouseDialog({ open, onOpenChange, onCreated, defaultProductType = 'diesel' }: CreateDieselWarehouseDialogProps) {
  const supabase = createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  )

  const [isSubmitting, setIsSubmitting] = useState(false)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)

  // Form state
  const [plants, setPlants] = useState<Array<{ id: string; name: string }>>([])
  const [selectedPlantId, setSelectedPlantId] = useState<string>("")
  const [productType, setProductType] = useState<'diesel' | 'urea'>(defaultProductType)
  const [warehouseCode, setWarehouseCode] = useState("")
  const [name, setName] = useState("")
  const [capacityLiters, setCapacityLiters] = useState("")
  const [minimumStockLevel, setMinimumStockLevel] = useState("500")
  const [hasCuentaLitros, setHasCuentaLitros] = useState(true)
  const [locationNotes, setLocationNotes] = useState("")

  const isValid = useMemo(() => {
    return (
      selectedPlantId &&
      name.trim().length > 0 &&
      warehouseCode.trim().length > 0 &&
      !Number.isNaN(parseFloat(capacityLiters)) &&
      parseFloat(capacityLiters) > 0 &&
      !Number.isNaN(parseFloat(minimumStockLevel)) &&
      parseFloat(minimumStockLevel) >= 0
    )
  }, [selectedPlantId, name, warehouseCode, capacityLiters, minimumStockLevel])

  useEffect(() => {
    if (!open) return

    let mounted = true

    const loadPlants = async () => {
      try {
        setErrorMessage(null)
        const { data, error } = await supabase
          .from('plants')
          .select('id, name')
          .order('name')
        if (error) {
          throw error
        }
        if (!mounted) return
        setPlants((data || []) as any)
        if (data && data.length === 1) {
          setSelectedPlantId(data[0].id)
        }
      } catch (e: any) {
        console.error('Error loading plants', e)
        setErrorMessage('No se pudieron cargar las plantas')
      }
    }

    loadPlants()

    return () => {
      mounted = false
    }
  }, [open, supabase])

  const resetForm = () => {
    setSelectedPlantId("")
    setProductType(defaultProductType)
    setWarehouseCode("")
    setName("")
    setCapacityLiters("")
    setMinimumStockLevel("500")
    setHasCuentaLitros(true)
    setLocationNotes("")
    setErrorMessage(null)
  }

  const handleCreate = async () => {
    if (!isValid) return
    try {
      setIsSubmitting(true)
      setErrorMessage(null)

      const { data: { user } } = await supabase.auth.getUser()
      if (!user) {
        setErrorMessage('Autenticación requerida')
        return
      }

      const { data, error } = await supabase
        .from('diesel_warehouses')
        .insert([
          {
            plant_id: selectedPlantId,
            product_type: productType,
            warehouse_code: warehouseCode.trim(),
            name: name.trim(),
            capacity_liters: parseFloat(capacityLiters),
            minimum_stock_level: parseFloat(minimumStockLevel),
            has_cuenta_litros: hasCuentaLitros,
            location_notes: locationNotes.trim() ? locationNotes.trim() : null,
            created_by: user.id,
            updated_by: user.id
          }
        ])
        .select('id')
        .single()

      if (error) {
        console.error('Error creating warehouse:', error)
        setErrorMessage(error.message || 'No se pudo crear el almacén')
        return
      }

      toast.success('Almacén creado correctamente')
      onOpenChange(false)
      resetForm()
      onCreated?.()
    } catch (e: any) {
      console.error('Create warehouse failed:', e)
      setErrorMessage('Ocurrió un error al crear el almacén')
    } finally {
      setIsSubmitting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) resetForm(); onOpenChange(o) }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Nuevo Almacén de {productType === 'diesel' ? 'Diesel' : 'UREA'}</DialogTitle>
          <DialogDescription>Registra un nuevo almacén asociado a una planta.</DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {errorMessage && (
            <Alert>
              <AlertDescription>{errorMessage}</AlertDescription>
            </Alert>
          )}

          <div className="space-y-2">
            <Label>Tipo de Producto</Label>
            <Select value={productType} onValueChange={(value) => setProductType(value as 'diesel' | 'urea')}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="diesel">Diesel</SelectItem>
                <SelectItem value="urea">UREA</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Label>Planta</Label>
            <Select value={selectedPlantId} onValueChange={setSelectedPlantId}>
              <SelectTrigger>
                <SelectValue placeholder="Selecciona una planta" />
              </SelectTrigger>
              <SelectContent>
                {plants.map((p) => (
                  <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label>Código de Almacén</Label>
              <Input value={warehouseCode} onChange={(e) => setWarehouseCode(e.target.value)} placeholder="ALM-XXX" />
            </div>
            <div className="space-y-2">
              <Label>Nombre</Label>
              <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Almacén Principal" />
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label>Capacidad (L)</Label>
              <Input type="number" inputMode="decimal" value={capacityLiters} onChange={(e) => setCapacityLiters(e.target.value)} placeholder="10000" />
            </div>
            <div className="space-y-2">
              <Label>Stock Mínimo (L)</Label>
              <Input type="number" inputMode="decimal" value={minimumStockLevel} onChange={(e) => setMinimumStockLevel(e.target.value)} placeholder="500" />
            </div>
          </div>

          <div className="flex items-center justify-between">
            <Label className="mr-4">Tiene Cuenta Litros</Label>
            <Switch checked={hasCuentaLitros} onCheckedChange={setHasCuentaLitros} />
          </div>

          <div className="space-y-2">
            <Label>Notas de Ubicación (opcional)</Label>
            <Input value={locationNotes} onChange={(e) => setLocationNotes(e.target.value)} placeholder="Junto a la báscula, tanque elevado, etc." />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => { resetForm(); onOpenChange(false) }}>Cancelar</Button>
          <Button onClick={handleCreate} disabled={!isValid || isSubmitting}>
            {isSubmitting ? <><Loader2 className="mr-2 h-4 w-4 animate-spin" /> Guardando...</> : 'Crear'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}


