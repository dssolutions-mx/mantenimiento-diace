"use client"

import { useState, useEffect } from "react"
import { createBrowserClient } from "@supabase/ssr"
import { useRouter } from "next/navigation"
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Separator } from "@/components/ui/separator"
import { 
  Fuel, 
  AlertTriangle, 
  CheckCircle2, 
  Loader2, 
  Camera,
  TrendingDown,
  Save,
  X,
  Wifi,
  WifiOff
} from "lucide-react"
import { AssetSelectorMobile } from "./asset-selector-mobile"
import { ReadingCapture } from "./reading-capture"
import { SmartPhotoUpload } from "@/components/checklists/smart-photo-upload"
import { toast } from "sonner"

interface ConsumptionEntryFormProps {
  productType: 'diesel' | 'urea'
  warehouseId?: string
  plantId?: string
  onSuccess?: (transactionId: string) => void
  onCancel?: () => void
}

export function ConsumptionEntryForm({
  productType,
  warehouseId,
  plantId,
  onSuccess,
  onCancel
}: ConsumptionEntryFormProps) {
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
  const [assetType, setAssetType] = useState<'formal' | 'exception'>('formal')
  const [selectedAsset, setSelectedAsset] = useState<any>(null)
  const [exceptionAssetName, setExceptionAssetName] = useState<string>("")
  const [quantityLiters, setQuantityLiters] = useState<string>("")
  const [transactionDate, setTransactionDate] = useState<string>(new Date().toISOString().split('T')[0])
  const [transactionTime, setTransactionTime] = useState<string>(new Date().toTimeString().slice(0, 5))
  const [cuentaLitros, setCuentaLitros] = useState<string>("")
  const [previousCuentaLitros, setPreviousCuentaLitros] = useState<number | null>(null)
  const [readings, setReadings] = useState<any>({})
  const [notes, setNotes] = useState("")
  
  // Evidence photos
  const [machinePhoto, setMachinePhoto] = useState<string | null>(null)

  // Validation state
  const [cuentaLitrosValid, setCuentaLitrosValid] = useState<boolean | null>(null)
  const [cuentaLitrosVariance, setCuentaLitrosVariance] = useState<number | null>(null)
  const [backdatingThresholdMinutes, setBackdatingThresholdMinutes] = useState<number>(120)

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
      // Get the product by product type
      const expectedProductCode = productType === 'diesel' ? '07DS01' : '07UR01'
      const { data, error } = await supabase
        .from('diesel_products')
        .select('id')
        .eq('product_code', expectedProductCode)
        .eq('product_type', productType)
        .single()

      if (error) {
        console.error(`Error loading ${productType} product:`, error)
        // Fallback: get any product of this type
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
    } catch (error) {
      console.warn('Using default backdating threshold (120m)')
    }
  }

  const loadOrganizationalStructure = async () => {
    try {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) return

      // Get user profile to determine their access level
      const { data: profile } = await supabase
        .from('profiles')
        .select('plant_id, business_unit_id, role')
        .eq('id', user.id)
        .single()

      if (!profile) return

      // Load business units
      const { data: busUnits } = await supabase
        .from('business_units')
        .select('*')
        .order('name')

      setBusinessUnits(busUnits || [])

      // Auto-select based on user context
      if (profile.business_unit_id) {
        setSelectedBusinessUnit(profile.business_unit_id)
        loadPlantsForBusinessUnit(profile.business_unit_id)
        
        if (profile.plant_id) {
          setSelectedPlant(profile.plant_id)
          loadWarehousesForPlant(profile.plant_id)
        }
      } else if (!profile.plant_id && !profile.business_unit_id) {
        // Global user - load all plants
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
      // Load warehouses with current inventory - filter by product_type
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
      
      // Auto-select if only one warehouse
      if (data && data.length === 1) {
        setSelectedWarehouse(data[0].id)
      }
    } catch (error) {
      console.error('Error loading warehouses:', error)
      toast.error("Error al cargar almacenes")
    }
  }

  // Handle business unit change
  const handleBusinessUnitChange = (buId: string) => {
    setSelectedBusinessUnit(buId)
    setSelectedPlant(null)
    setSelectedWarehouse(null)
    setPlants([])
    setWarehouses([])
    loadPlantsForBusinessUnit(buId)
  }

  // Handle plant change
  const handlePlantChange = (plantId: string) => {
    setSelectedPlant(plantId)
    setSelectedWarehouse(null)
    setWarehouses([])
    loadWarehousesForPlant(plantId)
  }

  // Load cuenta litros from warehouse (not from last transaction)
  useEffect(() => {
    if (!selectedWarehouse) {
      setPreviousCuentaLitros(null)
      return
    }

    loadWarehouseCuentaLitros()
  }, [selectedWarehouse])

  const loadWarehouseCuentaLitros = async () => {
    if (!selectedWarehouse) return

    try {
      // Get current cuenta_litros from warehouse table
      const { data, error } = await supabase
        .from('diesel_warehouses')
        .select('current_cuenta_litros, has_cuenta_litros')
        .eq('id', selectedWarehouse)
        .single()

      if (error) {
        console.error('Error loading warehouse cuenta litros:', error)
        return
      }

      if (data) {
        // If warehouse doesn't have cuenta litros, set to null (no validation)
        if (!data.has_cuenta_litros) {
          setPreviousCuentaLitros(null)
          toast.info("Este almacén no tiene cuenta litros", {
            description: "No se validará el cuenta litros para este almacén"
          })
        } else if (data.current_cuenta_litros !== null) {
          setPreviousCuentaLitros(parseFloat(data.current_cuenta_litros))
        } else {
          // First transaction for this warehouse
          setPreviousCuentaLitros(null)
        }
      }
    } catch (error) {
      console.error('Error loading warehouse cuenta litros:', error)
    }
  }

  // Auto-fill cuenta litros when quantity changes
  useEffect(() => {
    if (quantityLiters && previousCuentaLitros !== null) {
      const quantity = parseFloat(quantityLiters)
      if (!isNaN(quantity)) {
        // Pre-fill as previous + quantity
        const suggested = previousCuentaLitros + quantity
        setCuentaLitros(suggested.toFixed(1))
      }
    }
  }, [quantityLiters, previousCuentaLitros])

  // Validate cuenta litros against quantity
  useEffect(() => {
    if (!quantityLiters || !cuentaLitros || previousCuentaLitros === null) {
      setCuentaLitrosValid(null)
      setCuentaLitrosVariance(null)
      return
    }

    const quantity = parseFloat(quantityLiters)
    const currentCuenta = parseFloat(cuentaLitros)

    if (isNaN(quantity) || isNaN(currentCuenta)) {
      setCuentaLitrosValid(null)
      setCuentaLitrosVariance(null)
      return
    }

    // Calculate movement
    const movement = currentCuenta - previousCuentaLitros
    const variance = Math.abs(movement - quantity)

    setCuentaLitrosVariance(variance)

    // Tolerance: ±2 liters
    if (variance <= 2) {
      setCuentaLitrosValid(true)
    } else {
      setCuentaLitrosValid(false)
    }
  }, [quantityLiters, cuentaLitros, previousCuentaLitros])

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    
    console.log('=== FORM SUBMISSION STARTED ===')
    console.log('Asset Type:', assetType)
    console.log('Selected Warehouse:', selectedWarehouse)
    console.log('Selected Asset:', selectedAsset)
    console.log('Exception Asset Name:', exceptionAssetName)
    console.log('Quantity:', quantityLiters)
    console.log('Cuenta Litros:', cuentaLitros)
    console.log('Machine Photo:', machinePhoto)

    // Validation
    if (assetType === 'formal' && !selectedAsset) {
      toast.error("Selecciona un activo")
      console.error('Validation failed: No asset selected')
      return
    }

      if (assetType === 'exception' && !exceptionAssetName.trim()) {
      toast.error("Ingresa el nombre del equipo externo")
      return
    }

    if (!quantityLiters || parseFloat(quantityLiters) <= 0) {
      toast.error("Ingresa una cantidad válida de litros")
      return
    }

    if (!productId) {
      toast.error(`Error: No se encontró el producto ${productType === 'diesel' ? 'diesel' : 'UREA'}`)
      return
    }

    // Only require cuenta litros if warehouse has a meter
    if (previousCuentaLitros !== null && !cuentaLitros) {
      toast.error("Ingresa la lectura del cuenta litros")
      return
    }

    if (!selectedWarehouse) {
      toast.error("Selecciona un almacén")
      return
    }

    if (!machinePhoto) {
      toast.error("Toma una foto del display de la máquina")
      return
    }

    // Pre-submit policy warning for out-of-order/backdated entries
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

    // Warning for cuenta litros variance (only if warehouse has meter)
    if (previousCuentaLitros !== null && cuentaLitrosValid === false && cuentaLitrosVariance && cuentaLitrosVariance > 2) {
      const proceed = confirm(
        `⚠️ La diferencia entre litros y cuenta litros es de ${cuentaLitrosVariance.toFixed(1)}L.\n\n` +
        `Cantidad: ${quantityLiters}L\n` +
        `Movimiento cuenta litros: ${(parseFloat(cuentaLitros) - (previousCuentaLitros || 0)).toFixed(1)}L\n\n` +
        `¿Deseas continuar? La transacción será marcada para validación.`
      )
      
      if (!proceed) return
    }

    try {
      setLoading(true)
      console.log('Step 1: Getting user...')

      const { data: { user } } = await supabase.auth.getUser()
      if (!user) {
        toast.error("No hay sesión de usuario")
        console.error('No user found')
        return
      }
      console.log('Step 1 ✓: User:', user.id)

      // Get warehouse current inventory (faster than RPC)
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
      const currentBalance = previousBalance - parseFloat(quantityLiters)
      console.log('Step 2 ✓: Previous balance:', previousBalance, 'New balance:', currentBalance)

      // Check if balance is sufficient
      if (currentBalance < -50) { // Allow 50L safety margin
        toast.error(`Balance insuficiente en el almacén. Balance actual: ${previousBalance.toFixed(1)}L`)
        return
      }

      // Create transaction (different structure for formal vs exception assets)
      console.log('Step 3: Building transaction data...')
      console.log('Selected Plant ID:', selectedPlant)
      console.log('Product ID:', productId)
      
      const transactionData: any = {
        plant_id: selectedPlant,
        warehouse_id: selectedWarehouse,
        product_id: productId,
        transaction_type: 'consumption',
        asset_category: assetType,
        quantity_liters: parseFloat(quantityLiters),
        cuenta_litros: cuentaLitros ? parseFloat(cuentaLitros) : null,
        previous_balance: previousBalance,
        current_balance: currentBalance,
        operator_id: user.id,
        transaction_date: new Date(transactionDate + 'T' + transactionTime + ':00').toISOString(),
        notes: notes || null,
        requires_validation: previousCuentaLitros !== null && cuentaLitrosValid === false,
        validation_notes: previousCuentaLitros !== null && cuentaLitrosValid === false 
          ? `Varianza cuenta litros: ${cuentaLitrosVariance?.toFixed(1)}L`
          : null,
        created_by: user.id,
        source_system: 'web_app'
      }
      console.log('Step 3 ✓: Transaction data built:', transactionData)

      // Add formal asset data
      if (assetType === 'formal' && selectedAsset) {
        transactionData.asset_id = selectedAsset.id
        transactionData.horometer_reading = readings.hours_reading || null
        transactionData.kilometer_reading = readings.kilometers_reading || null
        transactionData.previous_horometer = selectedAsset.current_hours
        transactionData.previous_kilometer = selectedAsset.current_kilometers
      }

      // Add exception asset data (no asset_id, no readings per DB constraints)
      if (assetType === 'exception') {
        transactionData.asset_id = null
        transactionData.exception_asset_name = exceptionAssetName.trim()
        transactionData.horometer_reading = null
        transactionData.kilometer_reading = null
        transactionData.previous_horometer = null
        transactionData.previous_kilometer = null
      }

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

      // Upload evidence photo (machine display only)
      console.log('Step 5: Inserting evidence...')
      if (machinePhoto) {
        const { error: evidenceError } = await supabase.from('diesel_evidence').insert({
          transaction_id: transaction.id,
          evidence_type: 'consumption',
          category: 'machine_display',
          photo_url: machinePhoto,
          description: `Display de la máquina - ${quantityLiters}L | Cuenta litros: ${cuentaLitros}L`,
          created_by: user.id
        })
        if (evidenceError) {
          console.error('Evidence insert error:', evidenceError)
          throw evidenceError
        }
        console.log('Step 5 ✓: Evidence inserted')
      }

      // Update asset readings if provided (only for formal assets)
      console.log('Step 6: Updating asset readings...')
      if (assetType === 'formal' && selectedAsset && (readings.hours_reading || readings.kilometers_reading)) {
        const updateData: any = {}
        if (readings.hours_reading) updateData.current_hours = readings.hours_reading
        if (readings.kilometers_reading) updateData.current_kilometers = readings.kilometers_reading

        const { error: updateError } = await supabase
          .from('assets')
          .update(updateData)
          .eq('id', selectedAsset.id)
        
        if (updateError) {
          console.error('Asset update error:', updateError)
          // Don't throw - readings update is not critical
        }
        console.log('Step 6 ✓: Asset readings updated')
      } else {
        console.log('Step 6: Skipped (no readings to update)')
      }

      const assetName = assetType === 'formal' 
        ? selectedAsset.name 
        : exceptionAssetName

      toast.success("✅ Consumo registrado exitosamente", {
        description: `${quantityLiters}L consumidos por ${assetName}. Nuevo balance: ${currentBalance.toFixed(1)}L`,
        duration: 4000
      })

      if (previousCuentaLitros !== null && cuentaLitrosValid === false) {
        toast.warning("⚠️ Transacción marcada para validación", {
          description: "La diferencia con cuenta litros requiere revisión",
          duration: 5000
        })
      }

      // Clear form
      setSelectedAsset(null)
      setExceptionAssetName("")
      setQuantityLiters("")
      setCuentaLitros("")
      setMachinePhoto(null)
      setNotes("")
      setReadings({})
      setPreviousCuentaLitros(null)

      if (onSuccess) {
        onSuccess(transaction.id)
      }
    } catch (error) {
      console.error('=== ERROR CREATING CONSUMPTION ===')
      console.error('Error details:', error)
      console.error('Error type:', typeof error)
      if (error instanceof Error) {
        console.error('Error message:', error.message)
        console.error('Error stack:', error.stack)
      }
      
      toast.error("Error al registrar el consumo", {
        description: error instanceof Error ? error.message : "Error desconocido"
      })
    } finally {
      setLoading(false)
      console.log('=== FORM SUBMISSION ENDED ===')
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="flex items-center gap-2">
                <Fuel className="h-5 w-5 text-orange-600" />
                Registrar Consumo de Diesel
              </CardTitle>
              <CardDescription>
                Registra el consumo de diesel y evidencia fotográfica
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
            
            {/* Business Unit Selection */}
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

            {/* Plant Selection */}
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

            {/* Warehouse Selection */}
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
                      {!wh.has_cuenta_litros ? ' (Sin cuenta litros)' : ''}
                    </option>
                  ))}
                </select>
              </div>
            )}
            
            {!selectedPlant && plants.length > 0 && (
              <p className="text-sm text-muted-foreground">
                Selecciona una planta para ver los almacenes disponibles
              </p>
            )}
            
            {selectedPlant && warehouses.length === 0 && (
              <p className="text-sm text-orange-600">
                No hay almacenes disponibles en esta planta
              </p>
            )}
          </div>

          {selectedWarehouse && (
            <>
              <Separator />

              {/* Asset Type Selection */}
              <div className="space-y-3">
                <Label className="text-base">2. Tipo de Equipo</Label>
                
                <div className="grid grid-cols-2 gap-3">
                  <button
                    type="button"
                    onClick={() => {
                      setAssetType('formal')
                      setExceptionAssetName("")
                    }}
                    className={`h-12 px-4 rounded-md border-2 font-medium transition-colors ${
                      assetType === 'formal'
                        ? 'border-blue-500 bg-blue-50 text-blue-700'
                        : 'border-gray-300 bg-white text-gray-700 hover:border-gray-400'
                    }`}
                  >
                    🏭 Equipo Propio
                  </button>
                  
                  <button
                    type="button"
                    onClick={() => {
                      setAssetType('exception')
                      setSelectedAsset(null)
                    }}
                    className={`h-12 px-4 rounded-md border-2 font-medium transition-colors ${
                      assetType === 'exception'
                        ? 'border-orange-500 bg-orange-50 text-orange-700'
                        : 'border-gray-300 bg-white text-gray-700 hover:border-gray-400'
                    }`}
                  >
                    🚚 Equipo Externo
                  </button>
                </div>

                <p className="text-xs text-muted-foreground">
                  {assetType === 'formal' 
                    ? 'Equipos registrados en el sistema (tractores, excavadoras, etc.)'
                    : 'Equipos externos (socios, rentados, servicios públicos, etc.)'}
                </p>
              </div>

              <Separator />

              {/* Asset Selection - Formal */}
              {assetType === 'formal' && (
                <div className="space-y-2">
                  <Label className="text-base">3. Seleccionar Equipo</Label>
                  <AssetSelectorMobile
                    onSelect={setSelectedAsset}
                    selectedAssetId={selectedAsset?.id}
                    plantFilter={selectedPlant}
                    businessUnitFilter={false}
                  />
                </div>
              )}

              {/* Exception Asset Input */}
              {assetType === 'exception' && (
                <div className="space-y-2">
                  <Label htmlFor="exception-asset" className="text-base">
                    3. Nombre del Equipo Externo <span className="text-red-600">*</span>
                  </Label>
                  <Input
                    id="exception-asset"
                    type="text"
                    placeholder="Ej: Camión de Socio ABC, Renta Equipo XYZ"
                    value={exceptionAssetName}
                    onChange={(e) => setExceptionAssetName(e.target.value)}
                    disabled={loading}
                    className="h-12 text-base"
                    required
                  />
                  <Alert className="border-orange-200 bg-orange-50">
                    <AlertDescription className="text-sm text-orange-800">
                      <strong>Nota:</strong> Los equipos externos no tienen lecturas de horómetro/odómetro.
                      Solo se registra la cantidad de litros y el cuenta litros.
                    </AlertDescription>
                  </Alert>
                </div>
              )}
            </>
          )}

          {(selectedAsset || exceptionAssetName) && (
            <>
              <Separator />

              {/* Transaction Date and Time */}
              <div className="space-y-4">
                <Label className="text-base">4. Fecha y Hora del Consumo</Label>
                
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
                  Fecha y hora en que se realizó el consumo de diesel
                </p>
              </div>

              <Separator />

              {/* Quantity Input */}
              <div className="space-y-2">
                <Label htmlFor="quantity" className="text-base">
                  5. Cantidad de Litros Consumidos
                </Label>
                <Input
                  id="quantity"
                  type="number"
                  step="0.1"
                  inputMode="decimal"
                  placeholder="Ej: 150.5"
                  value={quantityLiters}
                  onChange={(e) => setQuantityLiters(e.target.value)}
                  onWheel={(e) => e.currentTarget.blur()}
                  onKeyDown={(e) => {
                    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
                      e.preventDefault()
                    }
                  }}
                  disabled={loading}
                  className="h-12 text-lg font-semibold"
                  required
                />
                {quantityLiters && (
                  <div className="flex items-center gap-2 text-sm text-muted-foreground">
                    <TrendingDown className="h-4 w-4" />
                    <span>{parseFloat(quantityLiters).toFixed(1)} litros serán descontados del inventario</span>
                  </div>
                )}
              </div>

              <Separator />

              {/* Cuenta Litros Input */}
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <Label htmlFor="cuenta-litros" className="text-base">
                    6. Lectura Cuenta Litros {previousCuentaLitros === null ? "(No disponible)" : "(Auto-calculada)"}
                  </Label>
                  {previousCuentaLitros !== null && (
                    <Badge variant="outline" className="text-xs">
                      Anterior: {previousCuentaLitros.toFixed(1)}L
                    </Badge>
                  )}
                  {previousCuentaLitros === null && (
                    <Badge variant="secondary" className="text-xs">
                      Sin medidor
                    </Badge>
                  )}
                </div>
                
                <Input
                  id="cuenta-litros"
                  type="tel"
                  pattern="[0-9]*\.?[0-9]*"
                  inputMode="decimal"
                  placeholder={previousCuentaLitros !== null ? `Sugerido: ${(previousCuentaLitros + (parseFloat(quantityLiters) || 0)).toFixed(1)}` : "N/A - Este almacén no tiene cuenta litros"}
                  value={cuentaLitros}
                  onChange={(e) => {
                    // Only allow numbers and decimal point
                    const value = e.target.value.replace(/[^0-9.]/g, '')
                    setCuentaLitros(value)
                  }}
                  disabled={loading || previousCuentaLitros === null}
                  className={`h-12 text-base ${
                    previousCuentaLitros === null ? 'bg-gray-100 text-gray-500' :
                    cuentaLitrosValid === false ? 'border-red-500' : 
                    cuentaLitrosValid === true ? 'border-green-500' : ''
                  }`}
                  required={previousCuentaLitros !== null}
                />

                {/* Cuenta Litros Validation */}
                {cuentaLitros && previousCuentaLitros !== null && (
                  <div className="space-y-2">
                    <div className="flex items-center gap-2 text-sm">
                      <span className="text-muted-foreground">Movimiento cuenta litros:</span>
                      <span className="font-semibold">
                        {(parseFloat(cuentaLitros) - previousCuentaLitros).toFixed(1)}L
                      </span>
                    </div>

                    {cuentaLitrosVariance !== null && (
                      <Alert className={
                        cuentaLitrosValid === true ? 'border-green-500 bg-green-50' :
                        cuentaLitrosValid === false ? 'border-red-500 bg-red-50' : ''
                      }>
                        {cuentaLitrosValid === true ? (
                          <>
                            <CheckCircle2 className="h-4 w-4 text-green-600" />
                            <AlertDescription className="text-green-800 text-sm">
                              ✅ Validación correcta (varianza: {cuentaLitrosVariance.toFixed(1)}L)
                            </AlertDescription>
                          </>
                        ) : (
                          <>
                            <AlertTriangle className="h-4 w-4 text-red-600" />
                            <AlertTitle className="text-red-800">Advertencia de Validación</AlertTitle>
                            <AlertDescription className="text-red-800 text-sm">
                              La diferencia entre litros consumidos y movimiento del cuenta litros es de {cuentaLitrosVariance.toFixed(1)}L.
                              Esta transacción será marcada para validación manual.
                            </AlertDescription>
                          </>
                        )}
                      </Alert>
                    )}
                  </div>
                )}
              </div>

              <Separator />

              {/* Asset Readings - Only for formal assets */}
              {assetType === 'formal' && selectedAsset && (
                <div className="space-y-2">
                  <Label className="text-base">6. Lecturas del Activo</Label>
                  <ReadingCapture
                    assetId={selectedAsset.id}
                    assetName={selectedAsset.name}
                    maintenanceUnit={selectedAsset.equipment_models?.maintenance_unit || 'hours'}
                    currentHours={selectedAsset.current_hours}
                    currentKilometers={selectedAsset.current_kilometers}
                    onReadingsChange={setReadings}
                    disabled={loading}
                  />
                </div>
              )}

              <Separator />

              {/* Evidence Photo */}
              <div className="space-y-4">
                <Label className="text-base">{assetType === 'formal' ? '7' : '6'}. Evidencia Fotográfica (Obligatorio)</Label>

                {/* Machine Display Photo */}
                <div className="space-y-2">
                  <div className="flex items-center gap-2">
                    <Camera className="h-4 w-4 text-blue-600" />
                    <Label htmlFor="machine-photo" className="text-sm">
                      Foto: Display de la Máquina <span className="text-red-600">*</span>
                    </Label>
                  </div>
                  <SmartPhotoUpload
                    checklistId={`diesel-consumption-${assetType === 'formal' ? selectedAsset?.id : exceptionAssetName || 'exception'}`}
                    itemId="machine-display"
                    currentPhotoUrl={machinePhoto}
                    onPhotoChange={(url) => setMachinePhoto(url)}
                    disabled={loading}
                    category="machine_display"
                  />
                  <p className="text-xs text-muted-foreground">
                    Captura el display mostrando los litros despachados y el cuenta litros
                  </p>
                </div>
              </div>

              <Separator />

              {/* Notes */}
              <div className="space-y-2">
                <Label htmlFor="notes" className="text-base">
                  {assetType === 'formal' ? '8' : '7'}. Notas u Observaciones (Opcional)
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
            disabled={loading || !selectedWarehouse || (assetType === 'formal' && !selectedAsset) || (assetType === 'exception' && !exceptionAssetName) || !quantityLiters || (previousCuentaLitros !== null && !cuentaLitros) || !machinePhoto}
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
                Registrar Consumo
              </>
            )}
          </Button>
        </CardFooter>
      </Card>
    </form>
  )
}

