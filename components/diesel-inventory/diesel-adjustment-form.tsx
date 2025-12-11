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
  TrendingDown,
  TrendingUp,
  Loader2, 
  Camera,
  Save,
  X,
  Wifi,
  WifiOff,
  AlertTriangle,
  Info
} from "lucide-react"
import { SmartPhotoUpload } from "@/components/checklists/smart-photo-upload"
import { toast } from "sonner"

interface DieselAdjustmentFormProps {
  productType: 'diesel' | 'urea'
  warehouseId?: string
  plantId?: string
  onSuccess?: (transactionId: string) => void
  onCancel?: () => void
}

export function DieselAdjustmentForm({
  productType,
  warehouseId,
  plantId,
  onSuccess,
  onCancel
}: DieselAdjustmentFormProps) {
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
  const [currentInventory, setCurrentInventory] = useState<number>(0)
  
  // Adjustment data
  const [adjustmentType, setAdjustmentType] = useState<'positive' | 'negative'>('positive')
  const [quantityLiters, setQuantityLiters] = useState<string>("")
  const [transactionDate, setTransactionDate] = useState<string>(new Date().toISOString().split('T')[0])
  const [transactionTime, setTransactionTime] = useState<string>(new Date().toTimeString().slice(0, 5))
  const [reason, setReason] = useState<string>("")
  const [notes, setNotes] = useState("")
  const [backdatingThresholdMinutes, setBackdatingThresholdMinutes] = useState<number>(120)
  
  // Evidence photos (flexible - not always required)
  const [evidencePhoto1, setEvidencePhoto1] = useState<string | null>(null)
  const [evidencePhoto2, setEvidencePhoto2] = useState<string | null>(null)

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
        setCurrentInventory(data[0].current_inventory || 0)
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

  const handleWarehouseChange = (warehouseId: string) => {
    setSelectedWarehouse(warehouseId)
    const warehouse = warehouses.find(w => w.id === warehouseId)
    if (warehouse) {
      setCurrentInventory(warehouse.current_inventory || 0)
    }
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    
    console.log('=== DIESEL ADJUSTMENT SUBMISSION STARTED ===')
    console.log('Type:', adjustmentType)
    console.log('Warehouse:', selectedWarehouse)
    console.log('Quantity:', quantityLiters)
    console.log('Reason:', reason)

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

    if (!reason.trim()) {
      toast.error("Especifica la razón del ajuste")
      return
    }

    // Pre-submit policy warning for out-of-order/backdated adjustments
    try {
      if (selectedWarehouse) {
        const selectedIso = new Date(transactionDate + 'T' + transactionTime + ':00')
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
      const adjustmentValue = adjustmentType === 'positive' 
        ? parseFloat(quantityLiters) 
        : -parseFloat(quantityLiters)
      const currentBalance = previousBalance + adjustmentValue
      
      // Check if negative adjustment would make inventory negative
      if (currentBalance < 0) {
        toast.error(`Error: El ajuste resultaría en inventario negativo (${currentBalance.toFixed(1)}L)`)
        return
      }
      
      console.log('Step 2 ✓: Previous balance:', previousBalance, 'Adjustment:', adjustmentValue, 'New balance:', currentBalance)

      // Create adjustment transaction
      console.log('Step 3: Building transaction data...')
      
      const transactionData: any = {
        plant_id: selectedPlant,
        warehouse_id: selectedWarehouse,
        product_id: productId,
        transaction_type: adjustmentType === 'positive' ? 'entry' : 'consumption',
        asset_category: adjustmentType === 'positive' ? 'general' : 'exception',  // Different categories for different types
        asset_id: null,  // Adjustments cannot have asset_id
        quantity_liters: Math.abs(adjustmentValue),
        previous_balance: previousBalance,
        current_balance: currentBalance,
        supplier_responsible: null,
        transaction_date: new Date(transactionDate + 'T' + transactionTime + ':00').toISOString(),
        notes: `[${adjustmentType === 'positive' ? 'AJUSTE +' : 'AJUSTE -'}] ${reason}${notes ? ' | ' + notes : ''}`,
        adjustment_reason: reason,
        adjustment_category: 'manual',
        exception_asset_name: adjustmentType === 'negative' ? `Ajuste negativo: ${reason}` : null,  // Required for exception category
        created_by: user.id,
        source_system: 'web_app'
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

      // Upload evidence photos (if provided)
      if (evidencePhoto1 || evidencePhoto2) {
        console.log('Step 5: Inserting evidence...')
        const evidencePromises = []

        if (evidencePhoto1) {
          evidencePromises.push(
            supabase.from('diesel_evidence').insert({
              transaction_id: transaction.id,
              evidence_type: 'adjustment',
              category: adjustmentType === 'positive' ? 'before' : 'after',
              photo_url: evidencePhoto1,
              description: `Evidencia de ajuste ${adjustmentType === 'positive' ? 'positivo' : 'negativo'}`,
              created_by: user.id
            })
          )
        }

        if (evidencePhoto2) {
          evidencePromises.push(
            supabase.from('diesel_evidence').insert({
              transaction_id: transaction.id,
              evidence_type: 'adjustment',
              category: 'after',
              photo_url: evidencePhoto2,
              description: `Evidencia adicional de ajuste`,
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
      }

      toast.success(`✅ Ajuste ${adjustmentType === 'positive' ? 'positivo' : 'negativo'} registrado`, {
        description: `${Math.abs(adjustmentValue).toFixed(1)}L ${adjustmentType === 'positive' ? 'agregados' : 'removidos'}. Nuevo balance: ${currentBalance.toFixed(1)}L`,
        duration: 4000
      })

      // Clear form
      setQuantityLiters("")
      setReason("")
      setNotes("")
      setEvidencePhoto1(null)
      setEvidencePhoto2(null)

      if (onSuccess) {
        onSuccess(transaction.id)
      }
    } catch (error) {
      console.error('=== ERROR CREATING ADJUSTMENT ===')
      console.error('Error details:', error)
      
      toast.error("Error al registrar el ajuste", {
        description: error instanceof Error ? error.message : "Error desconocido"
      })
    } finally {
      setLoading(false)
      console.log('=== ADJUSTMENT SUBMISSION ENDED ===')
    }
  }

  const projectedBalance = quantityLiters && currentInventory !== undefined
    ? adjustmentType === 'positive'
      ? currentInventory + parseFloat(quantityLiters)
      : currentInventory - parseFloat(quantityLiters)
    : null

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="flex items-center gap-2">
                <AlertTriangle className="h-5 w-5 text-orange-600" />
                Ajuste de Inventario
              </CardTitle>
              <CardDescription>
                Registra correcciones por mermas, derrames, mediciones físicas, etc.
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
                  onChange={(e) => handleWarehouseChange(e.target.value)}
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

            {selectedWarehouse && (
              <Alert className="border-blue-200 bg-blue-50">
                <Info className="h-4 w-4 text-blue-600" />
                <AlertDescription className="text-sm text-blue-800">
                  <strong>Inventario actual:</strong> {currentInventory.toFixed(1)} litros
                </AlertDescription>
              </Alert>
            )}
          </div>

          {selectedWarehouse && (
            <>
              <Separator />

              {/* Adjustment Type */}
              <div className="space-y-4">
                <Label className="text-base">2. Tipo de Ajuste</Label>

                <div className="grid grid-cols-2 gap-4">
                  <button
                    type="button"
                    onClick={() => setAdjustmentType('positive')}
                    disabled={loading}
                    className={`h-20 rounded-lg border-2 transition-all ${
                      adjustmentType === 'positive'
                        ? 'border-green-600 bg-green-50 text-green-900'
                        : 'border-gray-300 bg-white text-gray-700 hover:border-green-300'
                    }`}
                  >
                    <div className="flex flex-col items-center gap-1">
                      <TrendingUp className="h-6 w-6" />
                      <span className="font-semibold">Ajuste Positivo</span>
                      <span className="text-xs">Agregar litros</span>
                    </div>
                  </button>

                  <button
                    type="button"
                    onClick={() => setAdjustmentType('negative')}
                    disabled={loading}
                    className={`h-20 rounded-lg border-2 transition-all ${
                      adjustmentType === 'negative'
                        ? 'border-red-600 bg-red-50 text-red-900'
                        : 'border-gray-300 bg-white text-gray-700 hover:border-red-300'
                    }`}
                  >
                    <div className="flex flex-col items-center gap-1">
                      <TrendingDown className="h-6 w-6" />
                      <span className="font-semibold">Ajuste Negativo</span>
                      <span className="text-xs">Remover litros</span>
                    </div>
                  </button>
                </div>
              </div>

              <Separator />

              {/* Transaction Date and Time */}
              <div className="space-y-4">
                <Label className="text-base">3. Fecha y Hora del Ajuste</Label>
                
                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label htmlFor="transaction-date" className="text-sm">Fecha</Label>
                    <Input
                      id="transaction-date"
                      type="date"
                      value={transactionDate}
                      onChange={(e) => setTransactionDate(e.target.value)}
                      disabled={loading}
                      max={new Date().toISOString().split('T')[0]}
                      className="h-12 text-base"
                      required
                    />
                  </div>
                  
                  <div className="space-y-2">
                    <Label htmlFor="transaction-time" className="text-sm">Hora</Label>
                    <Input
                      id="transaction-time"
                      type="time"
                      value={transactionTime}
                      onChange={(e) => setTransactionTime(e.target.value)}
                      disabled={loading}
                      className="h-12 text-base"
                      required
                    />
                  </div>
                </div>
                
                <p className="text-xs text-muted-foreground">
                  Fecha y hora en que se realizó el ajuste de inventario
                </p>
              </div>

              <Separator />

              {/* Quantity and Reason */}
              <div className="space-y-4">
                <Label className="text-base">4. Cantidad y Razón</Label>

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
                    placeholder="Ej: 50"
                    value={quantityLiters}
                    onChange={(e) => setQuantityLiters(e.target.value)}
                    disabled={loading}
                    className="h-12 text-lg font-semibold"
                    required
                  />
                  {projectedBalance !== null && (
                    <div className={`flex items-center gap-2 text-sm ${
                      adjustmentType === 'positive' ? 'text-green-600' : 'text-red-600'
                    }`}>
                      {adjustmentType === 'positive' ? (
                        <TrendingUp className="h-4 w-4" />
                      ) : (
                        <TrendingDown className="h-4 w-4" />
                      )}
                      <span>
                        Nuevo balance proyectado: <strong>{projectedBalance.toFixed(1)}L</strong>
                      </span>
                    </div>
                  )}
                  {projectedBalance !== null && projectedBalance < 0 && (
                    <Alert variant="destructive">
                      <AlertTriangle className="h-4 w-4" />
                      <AlertDescription className="text-sm">
                        El ajuste resultaría en inventario negativo. Revisa la cantidad.
                      </AlertDescription>
                    </Alert>
                  )}
                </div>

                {/* Reason */}
                <div className="space-y-2">
                  <Label htmlFor="reason" className="text-sm">
                    Razón del Ajuste <span className="text-red-600">*</span>
                  </Label>
                  <select
                    id="reason"
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                    disabled={loading}
                    className="w-full h-12 px-3 border border-gray-300 rounded-md text-base"
                    required
                  >
                    <option value="">Seleccionar razón...</option>
                    <option value="Merma por evaporación">Merma por evaporación</option>
                    <option value="Derrame o fuga">Derrame o fuga</option>
                    <option value="Medición física / Inventario real">Medición física / Inventario real</option>
                    <option value="Corrección de error de captura">Corrección de error de captura</option>
                    <option value="Diferencia en conteo">Diferencia en conteo</option>
                    <option value="Reconciliación mensual">Reconciliación mensual</option>
                    <option value="Otro">Otro</option>
                  </select>
                </div>
              </div>

              <Separator />

              {/* Evidence Photos (Optional) */}
              <div className="space-y-4">
                <Label className="text-base">5. Evidencia Fotográfica (Opcional)</Label>
                
                <Alert className="border-orange-200 bg-orange-50">
                  <Info className="h-4 w-4 text-orange-600" />
                  <AlertDescription className="text-sm text-orange-800">
                    <strong>Nota:</strong> Las fotos son opcionales para ajustes, pero recomendadas para ajustes grandes.
                  </AlertDescription>
                </Alert>

                {/* Evidence Photo 1 */}
                <div className="space-y-2">
                  <div className="flex items-center gap-2">
                    <Camera className="h-4 w-4 text-orange-600" />
                    <Label className="text-sm">Foto 1 (Opcional)</Label>
                  </div>
                  <SmartPhotoUpload
                    checklistId={`diesel-adjustment-${selectedWarehouse}`}
                    itemId="evidence-1"
                    currentPhotoUrl={evidencePhoto1}
                    onPhotoChange={(url) => setEvidencePhoto1(url)}
                    disabled={loading}
                    category="before"
                  />
                  <p className="text-xs text-muted-foreground">
                    Captura evidencia del estado antes del ajuste
                  </p>
                </div>

                {/* Evidence Photo 2 */}
                <div className="space-y-2">
                  <div className="flex items-center gap-2">
                    <Camera className="h-4 w-4 text-orange-600" />
                    <Label className="text-sm">Foto 2 (Opcional)</Label>
                  </div>
                  <SmartPhotoUpload
                    checklistId={`diesel-adjustment-${selectedWarehouse}`}
                    itemId="evidence-2"
                    currentPhotoUrl={evidencePhoto2}
                    onPhotoChange={(url) => setEvidencePhoto2(url)}
                    disabled={loading}
                    category="after"
                  />
                  <p className="text-xs text-muted-foreground">
                    Captura evidencia adicional si es necesario
                  </p>
                </div>
              </div>

              <Separator />

              {/* Notes */}
              <div className="space-y-2">
                <Label htmlFor="notes" className="text-base">
                  6. Notas u Observaciones (Opcional)
                </Label>
                <Textarea
                  id="notes"
                  placeholder="Agrega detalles adicionales sobre el ajuste..."
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
            disabled={loading || !selectedWarehouse || !quantityLiters || !reason || (projectedBalance !== null && projectedBalance < 0)}
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
                Registrar Ajuste
              </>
            )}
          </Button>
        </CardFooter>
      </Card>
    </form>
  )
}

