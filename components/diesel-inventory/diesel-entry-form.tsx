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
import { Badge } from "@/components/ui/badge"
import { Separator } from "@/components/ui/separator"
import { 
  TruckIcon, 
  Loader2, 
  Camera,
  TrendingUp,
  Save,
  X,
  Wifi,
  WifiOff,
  AlertCircle
} from "lucide-react"
import { SmartPhotoUpload } from "@/components/checklists/smart-photo-upload"
import { toast } from "sonner"

interface DieselEntryFormProps {
  productType: 'diesel' | 'urea'
  warehouseId?: string
  plantId?: string
  onSuccess?: (transactionId: string) => void
  onCancel?: () => void
}

export function DieselEntryForm({
  productType,
  warehouseId,
  plantId,
  onSuccess,
  onCancel
}: DieselEntryFormProps) {
  const router = useRouter()
  const [loading, setLoading] = useState(false)
  const [isOnline, setIsOnline] = useState(typeof window !== 'undefined' ? navigator.onLine : true)

  // Form state
  const [businessUnits, setBusinessUnits] = useState<any[]>([])
  const [plants, setPlants] = useState<any[]>([])
  const [warehouses, setWarehouses] = useState<any[]>([])
  const [selectedBusinessUnit, setSelectedBusinessUnit] = useState<string | null>(null)
  const [selectedPlant, setSelectedPlant] = useState<string | null>(null)
  const [selectedWarehouse, setSelectedWarehouse] = useState<string | null>(null)
  const [productId, setProductId] = useState<string | null>(null)
  
  // Entry data
  const [quantityLiters, setQuantityLiters] = useState<string>("")
  const [unitCost, setUnitCost] = useState<string>("")
  const [supplierName, setSupplierName] = useState<string>("")
  const [invoiceNumber, setInvoiceNumber] = useState<string>("")
  const [deliveryDate, setDeliveryDate] = useState<string>(new Date().toISOString().split('T')[0])
  const [deliveryTime, setDeliveryTime] = useState<string>(new Date().toTimeString().slice(0, 5))
  const [notes, setNotes] = useState("")
  const [backdatingThresholdMinutes, setBackdatingThresholdMinutes] = useState<number>(120)
  
  // Evidence photos (at least 1 required)
  const [deliveryPhoto, setDeliveryPhoto] = useState<string | null>(null)
  const [invoicePhoto, setInvoicePhoto] = useState<string | null>(null)
  const [tankGaugePhoto, setTankGaugePhoto] = useState<string | null>(null)

  const supabase = createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  )

  // Monitor online status
  useEffect(() => {
    const handleOnline = () => setIsOnline(true)
    const handleOffline = () => setIsOnline(false)
    
    window.addEventListener('online', handleOnline)
    window.addEventListener('offline', handleOffline)
    
    return () => {
      window.removeEventListener('online', handleOnline)
      window.removeEventListener('offline', handleOffline)
    }
  }, [])

  // Load organizational structure and product on mount
  useEffect(() => {
    loadOrganizationalStructure()
    loadProduct()
    loadBackdatingThreshold()
  }, [productType])

  const loadProduct = async () => {
    try {
      const expectedProductCode = productType === 'diesel' ? '07DS01' : '07UR01'
      const { data, error } = await supabase
        .from('diesel_products')
        .select('id')
        .eq('product_code', expectedProductCode)
        .eq('product_type', productType)
        .single()

      if (error) {
        const { data: fallback } = await supabase
          .from('diesel_products')
          .select('id')
          .eq('product_type', productType)
          .limit(1)
          .single()
        
        if (fallback) {
          setProductId(fallback.id)
        }
      } else if (data) {
        setProductId(data.id)
      }
    } catch (error) {
      console.error(`Error loading ${productType} product:`, error)
    }
  }

  const loadBackdatingThreshold = async () => {
    try {
      const { data, error } = await supabase.rpc('get_diesel_backdating_threshold_minutes')
      if (!error && typeof data === 'number') {
        setBackdatingThresholdMinutes(data)
      }
    } catch (e) {
      console.warn('Using default backdating threshold (120m)')
    }
  }

  const loadOrganizationalStructure = async () => {
    try {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) return

      const { data: profile } = await supabase
        .from('profiles')
        .select('plant_id, business_unit_id, role')
        .eq('id', user.id)
        .single()

      if (!profile) return

      const { data: busUnits } = await supabase
        .from('business_units')
        .select('*')
        .order('name')

      setBusinessUnits(busUnits || [])

      if (profile.business_unit_id) {
        setSelectedBusinessUnit(profile.business_unit_id)
        loadPlantsForBusinessUnit(profile.business_unit_id)
        
        if (profile.plant_id) {
          setSelectedPlant(profile.plant_id)
          loadWarehousesForPlant(profile.plant_id)
        }
      } else if (!profile.plant_id && !profile.business_unit_id) {
        const { data: allPlants } = await supabase
          .from('plants')
          .select('*')
          .order('name')
        setPlants(allPlants || [])
      }
    } catch (error) {
      console.error('Error loading organizational structure:', error)
    }
  }

  const loadPlantsForBusinessUnit = async (businessUnitId: string) => {
    try {
      const { data } = await supabase
        .from('plants')
        .select('*')
        .eq('business_unit_id', businessUnitId)
        .order('name')

      setPlants(data || [])
    } catch (error) {
      console.error('Error loading plants:', error)
    }
  }

  const loadWarehousesForPlant = async (plantId: string) => {
    try {
      const { data, error } = await supabase
        .from('diesel_warehouses')
        .select('id, name, warehouse_code, capacity_liters, current_inventory, has_cuenta_litros, plant_id')
        .eq('plant_id', plantId)
        .eq('product_type', productType)
        .order('name')

      if (error) {
        console.error('Error loading warehouses:', error)
        toast.error("Error al cargar almacenes")
        return
      }

      setWarehouses(data || [])
      
      if (data && data.length === 1) {
        setSelectedWarehouse(data[0].id)
      }
    } catch (error) {
      console.error('Error loading warehouses:', error)
      toast.error("Error al cargar almacenes")
    }
  }

  const handleBusinessUnitChange = (buId: string) => {
    setSelectedBusinessUnit(buId)
    setSelectedPlant(null)
    setSelectedWarehouse(null)
    setPlants([])
    setWarehouses([])
    loadPlantsForBusinessUnit(buId)
  }

  const handlePlantChange = (plantId: string) => {
    setSelectedPlant(plantId)
    setSelectedWarehouse(null)
    setWarehouses([])
    loadWarehousesForPlant(plantId)
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    
    console.log('=== DIESEL ENTRY SUBMISSION STARTED ===')
    console.log('Warehouse:', selectedWarehouse)
    console.log('Quantity:', quantityLiters)
    console.log('Supplier:', supplierName)
    console.log('Photos:', { deliveryPhoto, invoicePhoto, tankGaugePhoto })

    // Validation
    if (!selectedWarehouse) {
      toast.error("Selecciona un almacén")
      return
    }

    if (!quantityLiters || parseFloat(quantityLiters) <= 0) {
      toast.error("Ingresa una cantidad válida de litros")
      return
    }

    if (!productId) {
      toast.error("Error: No se encontró el producto diesel")
      return
    }

    if (!deliveryPhoto && !invoicePhoto && !tankGaugePhoto) {
      toast.error("Sube al menos una foto de evidencia")
      return
    }

    if (!supplierName.trim()) {
      toast.error("Ingresa el nombre del proveedor")
      return
    }

    // Pre-submit policy warning for out-of-order/backdated entries
    try {
      if (selectedWarehouse) {
        const selectedIso = new Date(deliveryDate + 'T' + deliveryTime + ':00')
        const { data: latestTx } = await supabase
          .from('diesel_transactions')
          .select('transaction_date')
          .eq('warehouse_id', selectedWarehouse)
          .order('transaction_date', { ascending: false })
          .limit(1)
          .single()

        const now = new Date()
        const deltaMinutes = Math.floor((now.getTime() - selectedIso.getTime()) / 60000)
        const isBackdated = deltaMinutes > backdatingThresholdMinutes
        const isOutOfOrder = latestTx?.transaction_date
          ? selectedIso.getTime() < new Date(latestTx.transaction_date).getTime()
          : false

        if (isBackdated || isOutOfOrder) {
          const proceed = confirm(
            '⚠️ Este movimiento será marcado para validación.\n\n' +
            'No cumple la política de control de diésel (posible amonestación).\n' +
            (isOutOfOrder ? '\n• Fuera de orden respecto a movimientos previos.' : '') +
            (isBackdated ? `\n• Antidatado por ${deltaMinutes} min.` : '') +
            '\n\n¿Deseas continuar?'
          )
          if (!proceed) return
        }
      }
    } catch (warnErr) {
      console.warn('Pre-submit policy check failed', warnErr)
    }

    try {
      setLoading(true)
      console.log('Step 1: Getting user...')

      const { data: { user } } = await supabase.auth.getUser()
      if (!user) {
        toast.error("No hay sesión de usuario")
        return
      }
      console.log('Step 1 ✓: User:', user.id)

      // Get warehouse current inventory
      console.log('Step 2: Getting warehouse balance...')
      const { data: warehouseData, error: warehouseError } = await supabase
        .from('diesel_warehouses')
        .select('current_inventory')
        .eq('id', selectedWarehouse)
        .single()

      if (warehouseError) {
        console.error('Error getting warehouse balance:', warehouseError)
        toast.error("Error al obtener el balance del almacén")
        return
      }

      const previousBalance = warehouseData?.current_inventory || 0
      const currentBalance = previousBalance + parseFloat(quantityLiters)
      console.log('Step 2 ✓: Previous balance:', previousBalance, 'New balance:', currentBalance)

      // Create entry transaction
      console.log('Step 3: Building transaction data...')
      
      const totalCost = unitCost ? parseFloat(unitCost) * parseFloat(quantityLiters) : null
      
      const transactionData: any = {
        plant_id: selectedPlant,
        warehouse_id: selectedWarehouse,
        product_id: productId,
        transaction_type: 'entry',
        asset_category: 'general',  // Entries don't have asset
        asset_id: null,  // Entries cannot have asset_id per DB constraints
        quantity_liters: parseFloat(quantityLiters),
        unit_cost: unitCost ? parseFloat(unitCost) : null,
        total_cost: totalCost,
        previous_balance: previousBalance,
        current_balance: currentBalance,
        supplier_responsible: supplierName.trim(),
        transaction_date: new Date(deliveryDate + 'T' + deliveryTime + ':00').toISOString(),
        notes: notes || null,
        created_by: user.id,
        source_system: 'web_app'
      }
      
      // Add invoice number to notes if provided
      if (invoiceNumber) {
        transactionData.notes = `Factura: ${invoiceNumber}${notes ? ' | ' + notes : ''}`
      }
      
      console.log('Step 3 ✓: Transaction data built:', transactionData)

      console.log('Step 4: Inserting transaction...')
      const { data: transaction, error: transactionError } = await supabase
        .from('diesel_transactions')
        .insert([transactionData])
        .select()
        .single()

      if (transactionError) {
        console.error('Transaction insert error:', transactionError)
        throw transactionError
      }
      console.log('Step 4 ✓: Transaction created:', transaction.id)

      // Upload evidence photos
      console.log('Step 5: Inserting evidence...')
      const evidencePromises = []

      if (deliveryPhoto) {
        evidencePromises.push(
          supabase.from('diesel_evidence').insert({
            transaction_id: transaction.id,
            evidence_type: 'entry',
            category: 'delivery_truck',
            photo_url: deliveryPhoto,
            description: `Entrega de ${quantityLiters}L por ${supplierName}`,
            created_by: user.id
          })
        )
      }

      if (invoicePhoto) {
        evidencePromises.push(
          supabase.from('diesel_evidence').insert({
            transaction_id: transaction.id,
            evidence_type: 'invoice',
            category: 'invoice',
            photo_url: invoicePhoto,
            description: invoiceNumber ? `Factura ${invoiceNumber}` : 'Factura de entrega',
            created_by: user.id
          })
        )
      }

      if (tankGaugePhoto) {
        evidencePromises.push(
          supabase.from('diesel_evidence').insert({
            transaction_id: transaction.id,
            evidence_type: 'entry',
            category: 'tank_gauge',
            photo_url: tankGaugePhoto,
            description: 'Medidor del tanque después de la entrega',
            created_by: user.id
          })
        )
      }

      const evidenceResults = await Promise.all(evidencePromises)
      const evidenceErrors = evidenceResults.filter(r => r.error)
      
      if (evidenceErrors.length > 0) {
        console.error('Evidence insert errors:', evidenceErrors)
      }
      console.log('Step 5 ✓: Evidence inserted')

      toast.success("✅ Entrada registrada exitosamente", {
        description: `${quantityLiters}L recibidos. Nuevo balance: ${currentBalance.toFixed(1)}L`,
        duration: 4000
      })

      // Clear form
      setQuantityLiters("")
      setUnitCost("")
      setSupplierName("")
      setInvoiceNumber("")
      setDeliveryDate(new Date().toISOString().split('T')[0])
      setNotes("")
      setDeliveryPhoto(null)
      setInvoicePhoto(null)
      setTankGaugePhoto(null)

      if (onSuccess) {
        onSuccess(transaction.id)
      }
    } catch (error) {
      console.error('=== ERROR CREATING ENTRY ===')
      console.error('Error details:', error)
      
      toast.error("Error al registrar la entrada", {
        description: error instanceof Error ? error.message : "Error desconocido"
      })
    } finally {
      setLoading(false)
      console.log('=== ENTRY SUBMISSION ENDED ===')
    }
  }

  const totalCost = (quantityLiters && unitCost) 
    ? (parseFloat(quantityLiters) * parseFloat(unitCost)).toFixed(2)
    : null

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="flex items-center gap-2">
                <TruckIcon className="h-5 w-5 text-green-600" />
                Registrar Entrada de Diesel
              </CardTitle>
              <CardDescription>
                Registra la recepción de diesel con evidencia fotográfica
              </CardDescription>
            </div>
            <div className="flex items-center gap-2">
              {isOnline ? (
                <Badge variant="outline" className="text-green-600">
                  <Wifi className="h-3 w-3 mr-1" />
                  En línea
                </Badge>
              ) : (
                <Badge variant="outline" className="text-orange-600">
                  <WifiOff className="h-3 w-3 mr-1" />
                  Sin conexión
                </Badge>
              )}
            </div>
          </div>
        </CardHeader>

        <CardContent className="space-y-6">
          {/* Warehouse Selection */}
          <div className="space-y-4">
            <Label className="text-base">1. Seleccionar Almacén</Label>
            
            {businessUnits.length > 0 && (
              <div className="space-y-2">
                <Label htmlFor="business-unit" className="text-sm">Unidad de Negocio</Label>
                <select
                  id="business-unit"
                  value={selectedBusinessUnit || ''}
                  onChange={(e) => handleBusinessUnitChange(e.target.value)}
                  disabled={loading}
                  className="w-full h-12 px-3 border border-gray-300 rounded-md text-base"
                >
                  <option value="">Seleccionar...</option>
                  {businessUnits.map(bu => (
                    <option key={bu.id} value={bu.id}>{bu.name}</option>
                  ))}
                </select>
              </div>
            )}

            {plants.length > 0 && (
              <div className="space-y-2">
                <Label htmlFor="plant" className="text-sm">Planta</Label>
                <select
                  id="plant"
                  value={selectedPlant || ''}
                  onChange={(e) => handlePlantChange(e.target.value)}
                  disabled={loading || !selectedBusinessUnit}
                  className="w-full h-12 px-3 border border-gray-300 rounded-md text-base"
                >
                  <option value="">Seleccionar...</option>
                  {plants.map(plant => (
                    <option key={plant.id} value={plant.id}>{plant.name} ({plant.code})</option>
                  ))}
                </select>
              </div>
            )}

            {warehouses.length > 0 && (
              <div className="space-y-2">
                <Label htmlFor="warehouse" className="text-sm">Almacén de Diesel</Label>
                <select
                  id="warehouse"
                  value={selectedWarehouse || ''}
                  onChange={(e) => setSelectedWarehouse(e.target.value)}
                  disabled={loading || !selectedPlant}
                  className="w-full h-12 px-3 border border-gray-300 rounded-md text-base"
                >
                  <option value="">Seleccionar...</option>
                  {warehouses.map(wh => (
                    <option key={wh.id} value={wh.id}>
                      {wh.name} - {wh.current_inventory ? `${wh.current_inventory.toFixed(1)}L` : '0L'}
                    </option>
                  ))}
                </select>
              </div>
            )}
          </div>

          {selectedWarehouse && (
            <>
              <Separator />

              {/* Delivery Information */}
              <div className="space-y-4">
                <Label className="text-base">2. Información de la Entrega</Label>

                {/* Supplier */}
                <div className="space-y-2">
                  <Label htmlFor="supplier" className="text-sm">
                    Proveedor / Responsable <span className="text-red-600">*</span>
                  </Label>
                  <Input
                    id="supplier"
                    type="text"
                    placeholder="Ej: Gasolinera Shell, Pemex, etc."
                    value={supplierName}
                    onChange={(e) => setSupplierName(e.target.value)}
                    disabled={loading}
                    className="h-12 text-base"
                    required
                  />
                </div>

                {/* Delivery Date and Time */}
                <div className="space-y-2">
                  <Label className="text-sm">Fecha y Hora de Entrega <span className="text-red-600">*</span></Label>
                  <div className="grid grid-cols-2 gap-2">
                    <Input
                      id="delivery-date"
                      type="date"
                      value={deliveryDate}
                      onChange={(e) => setDeliveryDate(e.target.value)}
                      disabled={loading}
                      className="h-12 text-base"
                      required
                    />
                    <Input
                      id="delivery-time"
                      type="time"
                      value={deliveryTime}
                      onChange={(e) => setDeliveryTime(e.target.value)}
                      disabled={loading}
                      className="h-12 text-base"
                      required
                    />
                  </div>
                </div>

                {/* Invoice Number */}
                <div className="space-y-2">
                  <Label htmlFor="invoice" className="text-sm">
                    Número de Factura (Opcional)
                  </Label>
                  <Input
                    id="invoice"
                    type="text"
                    placeholder="Ej: F-2025-001234"
                    value={invoiceNumber}
                    onChange={(e) => setInvoiceNumber(e.target.value)}
                    disabled={loading}
                    className="h-12 text-base"
                  />
                </div>
              </div>

              <Separator />

              {/* Quantity and Cost */}
              <div className="space-y-4">
                <Label className="text-base">3. Cantidad y Costo</Label>

                {/* Quantity */}
                <div className="space-y-2">
                  <Label htmlFor="quantity" className="text-sm">
                    Cantidad de Litros <span className="text-red-600">*</span>
                  </Label>
                  <Input
                    id="quantity"
                    type="number"
                    step="0.1"
                    inputMode="decimal"
                    placeholder="Ej: 5000"
                    value={quantityLiters}
                    onChange={(e) => setQuantityLiters(e.target.value)}
                    disabled={loading}
                    className="h-12 text-lg font-semibold"
                    required
                  />
                  {quantityLiters && (
                    <div className="flex items-center gap-2 text-sm text-green-600">
                      <TrendingUp className="h-4 w-4" />
                      <span>{parseFloat(quantityLiters).toFixed(1)} litros serán agregados al inventario</span>
                    </div>
                  )}
                </div>

                {/* Unit Cost */}
                <div className="space-y-2">
                  <Label htmlFor="unit-cost" className="text-sm">
                    Costo por Litro (sin IVA, Opcional)
                  </Label>
                  <Input
                    id="unit-cost"
                    type="number"
                    step="0.01"
                    inputMode="decimal"
                    placeholder="Ej: 23.50"
                    value={unitCost}
                    onChange={(e) => setUnitCost(e.target.value)}
                    disabled={loading}
                    className="h-12 text-base"
                  />
                  {totalCost && (
                    <div className="text-sm text-muted-foreground">
                      Costo total (sin IVA): <span className="font-semibold">${totalCost} MXN</span>
                    </div>
                  )}
                </div>
              </div>

              <Separator />

              {/* Evidence Photos */}
              <div className="space-y-4">
                <Label className="text-base">4. Evidencia Fotográfica</Label>
                
                <Alert className="border-blue-200 bg-blue-50">
                  <AlertCircle className="h-4 w-4 text-blue-600" />
                  <AlertDescription className="text-sm text-blue-800">
                    <strong>Nota:</strong> Al menos una foto es requerida. Se recomienda tomar foto de la entrega y la factura.
                  </AlertDescription>
                </Alert>

                {/* Delivery Photo */}
                <div className="space-y-2">
                  <div className="flex items-center gap-2">
                    <Camera className="h-4 w-4 text-green-600" />
                    <Label className="text-sm">
                      Foto 1: Camión / Entrega {!invoicePhoto && !tankGaugePhoto && <span className="text-red-600">*</span>}
                    </Label>
                  </div>
                  <SmartPhotoUpload
                    checklistId={`diesel-entry-${selectedWarehouse}`}
                    itemId="delivery-truck"
                    currentPhotoUrl={deliveryPhoto}
                    onPhotoChange={(url) => setDeliveryPhoto(url)}
                    disabled={loading}
                    category="delivery_truck"
                  />
                  <p className="text-xs text-muted-foreground">
                    Captura el camión cisterna o la entrega de diesel
                  </p>
                </div>

                {/* Invoice Photo */}
                <div className="space-y-2">
                  <div className="flex items-center gap-2">
                    <Camera className="h-4 w-4 text-green-600" />
                    <Label className="text-sm">
                      Foto 2: Factura / Nota de Entrega (Recomendado)
                    </Label>
                  </div>
                  <SmartPhotoUpload
                    checklistId={`diesel-entry-${selectedWarehouse}`}
                    itemId="invoice"
                    currentPhotoUrl={invoicePhoto}
                    onPhotoChange={(url) => setInvoicePhoto(url)}
                    disabled={loading}
                    category="invoice"
                  />
                  <p className="text-xs text-muted-foreground">
                    Captura la factura o nota de entrega
                  </p>
                </div>

                {/* Tank Gauge Photo */}
                <div className="space-y-2">
                  <div className="flex items-center gap-2">
                    <Camera className="h-4 w-4 text-green-600" />
                    <Label className="text-sm">
                      Foto 3: Medidor del Tanque (Opcional)
                    </Label>
                  </div>
                  <SmartPhotoUpload
                    checklistId={`diesel-entry-${selectedWarehouse}`}
                    itemId="tank-gauge"
                    currentPhotoUrl={tankGaugePhoto}
                    onPhotoChange={(url) => setTankGaugePhoto(url)}
                    disabled={loading}
                    category="tank_gauge"
                  />
                  <p className="text-xs text-muted-foreground">
                    Captura el medidor del tanque después de la carga
                  </p>
                </div>
              </div>

              <Separator />

              {/* Notes */}
              <div className="space-y-2">
                <Label htmlFor="notes" className="text-base">
                  5. Notas u Observaciones (Opcional)
                </Label>
                <Textarea
                  id="notes"
                  placeholder="Agrega cualquier observación relevante..."
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  disabled={loading}
                  rows={3}
                  className="text-base"
                />
              </div>
            </>
          )}
        </CardContent>

        <CardFooter className="flex justify-between gap-4">
          <Button
            type="button"
            variant="outline"
            onClick={onCancel || (() => router.back())}
            disabled={loading}
          >
            <X className="h-4 w-4 mr-2" />
            Cancelar
          </Button>
          
          <Button
            type="submit"
            disabled={loading || !selectedWarehouse || !quantityLiters || !supplierName || (!deliveryPhoto && !invoicePhoto && !tankGaugePhoto)}
            className="flex-1 sm:flex-none"
          >
            {loading ? (
              <>
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                Guardando...
              </>
            ) : (
              <>
                <Save className="h-4 w-4 mr-2" />
                Registrar Entrada
              </>
            )}
          </Button>
        </CardFooter>
      </Card>
    </form>
  )
}

