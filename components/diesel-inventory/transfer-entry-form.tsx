"use client"

import { useState, useEffect } from "react"
import { createBrowserClient } from "@supabase/ssr"
import { useRouter } from "next/navigation"
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { 
  ArrowRightLeft, 
  Loader2, 
  AlertCircle,
  CheckCircle2
} from "lucide-react"
import { toast } from "sonner"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"

interface TransferEntryFormProps {
  productType?: 'diesel' | 'urea'
  onSuccess?: (transferOutId: string, transferInId: string) => void
  onCancel?: () => void
}

export function TransferEntryForm({
  productType = 'diesel',
  onSuccess,
  onCancel
}: TransferEntryFormProps) {
  const router = useRouter()
  const [loading, setLoading] = useState(false)

  // Form state
  const [businessUnits, setBusinessUnits] = useState<any[]>([])
  const [plants, setPlants] = useState<any[]>([])
  const [warehouses, setWarehouses] = useState<any[]>([])
  
  const [selectedFromBusinessUnit, setSelectedFromBusinessUnit] = useState<string | null>(null)
  const [selectedFromPlant, setSelectedFromPlant] = useState<string | null>(null)
  const [selectedFromWarehouse, setSelectedFromWarehouse] = useState<string | null>(null)
  
  const [selectedToBusinessUnit, setSelectedToBusinessUnit] = useState<string | null>(null)
  const [selectedToPlant, setSelectedToPlant] = useState<string | null>(null)
  const [selectedToWarehouse, setSelectedToWarehouse] = useState<string | null>(null)
  
  const [quantityLiters, setQuantityLiters] = useState<string>("")
  const [transactionDate, setTransactionDate] = useState<string>(new Date().toISOString().split('T')[0])
  const [transactionTime, setTransactionTime] = useState<string>(new Date().toTimeString().slice(0, 5))
  const [notes, setNotes] = useState("")
  
  const [fromWarehouseInventory, setFromWarehouseInventory] = useState<number | null>(null)

  const supabase = createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  )

  // Load organizational structure
  useEffect(() => {
    loadBusinessUnits()
  }, [])

  // Load warehouses when from plant changes
  useEffect(() => {
    if (selectedFromPlant) {
      loadWarehousesForPlant(selectedFromPlant, 'from')
    } else {
      setWarehouses([])
      setSelectedFromWarehouse(null)
    }
  }, [selectedFromPlant])

  // Load warehouses when to plant changes
  useEffect(() => {
    if (selectedToPlant) {
      loadWarehousesForPlant(selectedToPlant, 'to')
    }
  }, [selectedToPlant])

  // Load inventory when from warehouse changes
  useEffect(() => {
    if (selectedFromWarehouse) {
      loadWarehouseInventory(selectedFromWarehouse)
    } else {
      setFromWarehouseInventory(null)
    }
  }, [selectedFromWarehouse])

  const loadBusinessUnits = async () => {
    try {
      const { data, error } = await supabase
        .from('business_units')
        .select('id, name')
        .order('name')

      if (error) {
        console.error('Error loading business units:', error)
        toast.error("Error al cargar unidades de negocio")
        return
      }

      setBusinessUnits(data || [])
    } catch (error) {
      console.error('Error loading business units:', error)
      toast.error("Error al cargar unidades de negocio")
    }
  }

  const loadPlantsForBusinessUnit = async (buId: string, side: 'from' | 'to') => {
    try {
      const { data, error } = await supabase
        .from('plants')
        .select('id, name, code')
        .eq('business_unit_id', buId)
        .order('name')

      if (error) {
        console.error('Error loading plants:', error)
        toast.error("Error al cargar plantas")
        return
      }

      if (side === 'from') {
        setPlants(data || [])
      } else {
        // For 'to' side, we need separate plants list
        // For simplicity, we'll reuse the same list but clear selections
      }
    } catch (error) {
      console.error('Error loading plants:', error)
      toast.error("Error al cargar plantas")
    }
  }

  const loadWarehousesForPlant = async (plantId: string, side: 'from' | 'to') => {
    try {
      const { data, error } = await supabase
        .from('diesel_warehouses')
        .select('id, name, warehouse_code, current_inventory, product_type')
        .eq('plant_id', plantId)
        .eq('product_type', productType)
        .order('name')

      if (error) {
        console.error('Error loading warehouses:', error)
        toast.error("Error al cargar almacenes")
        return
      }

      if (side === 'from') {
        setWarehouses(data || [])
      }
      // For 'to' side, we'll need a separate state or handle differently
      // For now, we'll use the same warehouses list
    } catch (error) {
      console.error('Error loading warehouses:', error)
      toast.error("Error al cargar almacenes")
    }
  }

  const loadWarehouseInventory = async (warehouseId: string) => {
    try {
      const { data, error } = await supabase
        .from('diesel_warehouses')
        .select('current_inventory')
        .eq('id', warehouseId)
        .single()

      if (error) {
        console.error('Error loading warehouse inventory:', error)
        return
      }

      setFromWarehouseInventory(data?.current_inventory || 0)
    } catch (error) {
      console.error('Error loading warehouse inventory:', error)
    }
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()

    // Validation
    if (!selectedFromWarehouse || !selectedToWarehouse) {
      toast.error("Selecciona almacén de origen y destino")
      return
    }

    if (selectedFromWarehouse === selectedToWarehouse) {
      toast.error("El almacén de origen y destino deben ser diferentes")
      return
    }

    if (!quantityLiters || parseFloat(quantityLiters) <= 0) {
      toast.error("Ingresa una cantidad válida de litros")
      return
    }

    if (fromWarehouseInventory !== null && parseFloat(quantityLiters) > fromWarehouseInventory) {
      toast.error(`Inventario insuficiente. Disponible: ${fromWarehouseInventory}L`)
      return
    }

    try {
      setLoading(true)

      const response = await fetch('/api/diesel/transfer', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from_warehouse_id: selectedFromWarehouse,
          to_warehouse_id: selectedToWarehouse,
          quantity_liters: parseFloat(quantityLiters),
          transaction_date: new Date(transactionDate + 'T' + transactionTime + ':00').toISOString(),
          notes: notes.trim() || undefined
        }),
      })

      const result = await response.json()

      if (!response.ok) {
        throw new Error(result.error || 'Error al crear transferencia')
      }

      toast.success(`Transferencia de ${quantityLiters}L completada exitosamente`)
      
      if (onSuccess) {
        onSuccess(result.transfer_out.id, result.transfer_in.id)
      } else {
        router.push('/diesel')
      }
    } catch (error: any) {
      console.error('Transfer error:', error)
      toast.error(error.message || 'Error al crear transferencia')
    } finally {
      setLoading(false)
    }
  }

  // Get warehouse options for 'to' side (all warehouses except from warehouse)
  const toWarehouseOptions = warehouses.filter(w => w.id !== selectedFromWarehouse)

  return (
    <form onSubmit={handleSubmit}>
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <ArrowRightLeft className="h-5 w-5" />
            Transferir {productType === 'diesel' ? 'Diesel' : 'UREA'}
          </CardTitle>
          <CardDescription>
            Transfiere combustible entre plantas. Las transferencias no se cuentan como consumo.
          </CardDescription>
        </CardHeader>

        <CardContent className="space-y-6">
          {/* From Warehouse Selection */}
          <div className="space-y-4">
            <div>
              <Label className="text-base font-semibold">Almacén de Origen</Label>
            </div>
            
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div>
                <Label>Unidad de Negocio</Label>
                <Select
                  value={selectedFromBusinessUnit || ""}
                  onValueChange={(value) => {
                    setSelectedFromBusinessUnit(value)
                    setSelectedFromPlant(null)
                    setSelectedFromWarehouse(null)
                    loadPlantsForBusinessUnit(value, 'from')
                  }}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Selecciona unidad" />
                  </SelectTrigger>
                  <SelectContent>
                    {businessUnits.map((bu) => (
                      <SelectItem key={bu.id} value={bu.id}>
                        {bu.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div>
                <Label>Planta</Label>
                <Select
                  value={selectedFromPlant || ""}
                  onValueChange={(value) => {
                    setSelectedFromPlant(value)
                    setSelectedFromWarehouse(null)
                  }}
                  disabled={!selectedFromBusinessUnit}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Selecciona planta" />
                  </SelectTrigger>
                  <SelectContent>
                    {plants.map((plant) => (
                      <SelectItem key={plant.id} value={plant.id}>
                        {plant.name} ({plant.code})
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div>
                <Label>Almacén</Label>
                <Select
                  value={selectedFromWarehouse || ""}
                  onValueChange={setSelectedFromWarehouse}
                  disabled={!selectedFromPlant}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Selecciona almacén" />
                  </SelectTrigger>
                  <SelectContent>
                    {warehouses.map((wh) => (
                      <SelectItem key={wh.id} value={wh.id}>
                        {wh.name} {wh.current_inventory !== null && `(${wh.current_inventory.toFixed(1)}L)`}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            {fromWarehouseInventory !== null && (
              <Alert>
                <AlertCircle className="h-4 w-4" />
                <AlertDescription>
                  Inventario disponible: <strong>{fromWarehouseInventory.toFixed(1)}L</strong>
                </AlertDescription>
              </Alert>
            )}
          </div>

          {/* To Warehouse Selection */}
          <div className="space-y-4">
            <div>
              <Label className="text-base font-semibold">Almacén de Destino</Label>
            </div>
            
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div>
                <Label>Unidad de Negocio</Label>
                <Select
                  value={selectedToBusinessUnit || ""}
                  onValueChange={(value) => {
                    setSelectedToBusinessUnit(value)
                    setSelectedToPlant(null)
                    setSelectedToWarehouse(null)
                    loadPlantsForBusinessUnit(value, 'to')
                  }}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Selecciona unidad" />
                  </SelectTrigger>
                  <SelectContent>
                    {businessUnits.map((bu) => (
                      <SelectItem key={bu.id} value={bu.id}>
                        {bu.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div>
                <Label>Planta</Label>
                <Select
                  value={selectedToPlant || ""}
                  onValueChange={(value) => {
                    setSelectedToPlant(value)
                    setSelectedToWarehouse(null)
                  }}
                  disabled={!selectedToBusinessUnit}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Selecciona planta" />
                  </SelectTrigger>
                  <SelectContent>
                    {plants.map((plant) => (
                      <SelectItem key={plant.id} value={plant.id}>
                        {plant.name} ({plant.code})
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div>
                <Label>Almacén</Label>
                <Select
                  value={selectedToWarehouse || ""}
                  onValueChange={setSelectedToWarehouse}
                  disabled={!selectedToPlant}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Selecciona almacén" />
                  </SelectTrigger>
                  <SelectContent>
                    {toWarehouseOptions.map((wh) => (
                      <SelectItem key={wh.id} value={wh.id}>
                        {wh.name} {wh.current_inventory !== null && `(${wh.current_inventory.toFixed(1)}L)`}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
          </div>

          {/* Quantity and Date */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div>
              <Label htmlFor="quantity">Cantidad (Litros) *</Label>
              <Input
                id="quantity"
                type="number"
                step="0.01"
                min="0.01"
                value={quantityLiters}
                onChange={(e) => setQuantityLiters(e.target.value)}
                placeholder="0.00"
                required
              />
            </div>

            <div>
              <Label htmlFor="date">Fecha *</Label>
              <Input
                id="date"
                type="date"
                value={transactionDate}
                onChange={(e) => setTransactionDate(e.target.value)}
                required
              />
            </div>

            <div>
              <Label htmlFor="time">Hora *</Label>
              <Input
                id="time"
                type="time"
                value={transactionTime}
                onChange={(e) => setTransactionTime(e.target.value)}
                required
              />
            </div>
          </div>

          {/* Notes */}
          <div>
            <Label htmlFor="notes">Notas (Opcional)</Label>
            <Textarea
              id="notes"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Información adicional sobre la transferencia..."
              rows={3}
            />
          </div>

          {/* Validation Alert */}
          {fromWarehouseInventory !== null && quantityLiters && parseFloat(quantityLiters) > fromWarehouseInventory && (
            <Alert variant="destructive">
              <AlertCircle className="h-4 w-4" />
              <AlertDescription>
                La cantidad solicitada ({quantityLiters}L) excede el inventario disponible ({fromWarehouseInventory.toFixed(1)}L)
              </AlertDescription>
            </Alert>
          )}
        </CardContent>

        <CardFooter className="flex justify-between">
          <Button
            type="button"
            variant="outline"
            onClick={onCancel || (() => router.push('/diesel'))}
            disabled={loading}
          >
            Cancelar
          </Button>
          <Button
            type="submit"
            disabled={loading || !selectedFromWarehouse || !selectedToWarehouse || !quantityLiters}
          >
            {loading ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Procesando...
              </>
            ) : (
              <>
                <ArrowRightLeft className="mr-2 h-4 w-4" />
                Transferir
              </>
            )}
          </Button>
        </CardFooter>
      </Card>
    </form>
  )
}
