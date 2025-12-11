"use client"

import { useState, useEffect } from "react"
import { createBrowserClient } from "@supabase/ssr"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Loader2, AlertTriangle, ArrowRightLeft, CheckCircle2, Info } from "lucide-react"
import { toast } from "sonner"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"

interface MarkTransferModalProps {
  transaction: {
    id: string
    transaction_id: string
    transaction_type: 'consumption' | 'entry'
    quantity_liters: number
    transaction_date: string
    warehouse_id: string
    product_id: string
    unit_cost?: number | null
    is_transfer?: boolean
    reference_transaction_id?: string | null
  } | null
  isOpen: boolean
  onClose: () => void
  onSuccess: () => void
}

export function MarkTransferModal({
  transaction,
  isOpen,
  onClose,
  onSuccess
}: MarkTransferModalProps) {
  const [loading, setLoading] = useState(false)
  const [searching, setSearching] = useState(false)
  const [matchingEntries, setMatchingEntries] = useState<Array<{
    id: string
    transaction_id: string
    transaction_date: string
    quantity_liters: number
    warehouse_name: string
    plant_name: string
  }>>([])
  const [selectedEntryId, setSelectedEntryId] = useState<string>("")
  const [toWarehouseId, setToWarehouseId] = useState<string>("")
  const [warehouses, setWarehouses] = useState<Array<{id: string, name: string, plant_name: string}>>([])
  const [preservePrice, setPreservePrice] = useState(true)

  const supabase = createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  )

  useEffect(() => {
    if (isOpen && transaction) {
      loadWarehouses()
      // Don't auto-search on open - user should select warehouse first
      // Reset state when modal opens
      setMatchingEntries([])
      setSelectedEntryId("")
      setToWarehouseId("")
    }
  }, [isOpen, transaction])

  const loadWarehouses = async () => {
    if (!transaction) return

    const { data, error } = await supabase
      .from('diesel_warehouses')
      .select(`
        id,
        name,
        plants!inner(name)
      `)
      .eq('product_type', 'diesel')
      .neq('id', transaction.warehouse_id)

    if (error) {
      console.error('Error loading warehouses:', error)
      return
    }

    setWarehouses((data || []).map((w: any) => ({
      id: w.id,
      name: w.name,
      plant_name: w.plants?.name || 'N/A'
    })))
  }

  const searchMatchingEntries = async () => {
    if (!transaction || transaction.transaction_type !== 'consumption') return
    if (!toWarehouseId) {
      toast.error('Por favor seleccione un almacén destino primero')
      return
    }

    setSearching(true)
    try {
      // Search for matching entry transactions in the selected warehouse
      // Expand date range to ±7 days to account for transfers that might happen on different days
      const txDate = new Date(transaction.transaction_date)
      const dateFrom = new Date(txDate)
      dateFrom.setDate(dateFrom.getDate() - 7)
      dateFrom.setHours(0, 0, 0, 0)
      
      const dateTo = new Date(txDate)
      dateTo.setDate(dateTo.getDate() + 7)
      dateTo.setHours(23, 59, 59, 999)

      // More flexible quantity matching - allow ±5% difference
      const quantityTolerance = Math.max(transaction.quantity_liters * 0.05, 10) // 5% or 10L, whichever is larger
      const minQuantity = transaction.quantity_liters - quantityTolerance
      const maxQuantity = transaction.quantity_liters + quantityTolerance

      console.log('Searching for entries:', {
        warehouse_id: toWarehouseId,
        product_id: transaction.product_id,
        date_range: { from: dateFrom.toISOString(), to: dateTo.toISOString() },
        quantity_range: { min: minQuantity, max: maxQuantity, original: transaction.quantity_liters }
      })

      let query = supabase
        .from('diesel_transactions')
        .select(`
          id,
          transaction_id,
          transaction_date,
          quantity_liters,
          diesel_warehouses!inner(name, plants!inner(name)),
          is_transfer
        `)
        .eq('transaction_type', 'entry')
        .eq('warehouse_id', toWarehouseId)
        .eq('product_id', transaction.product_id)
        .eq('is_transfer', false)
        .gte('quantity_liters', minQuantity)
        .lte('quantity_liters', maxQuantity)
        .gte('transaction_date', dateFrom.toISOString())
        .lte('transaction_date', dateTo.toISOString())
        .order('transaction_date', { ascending: false })
        .limit(20) // Increased limit

      const { data, error } = await query

      if (error) {
        console.error('Error searching entries:', error)
        toast.error(`Error al buscar transacciones: ${error.message}`)
        return
      }

      console.log('Search results:', { count: data?.length || 0, data })

      const formatted = (data || []).map((tx: any) => ({
        id: tx.id,
        transaction_id: tx.transaction_id,
        transaction_date: tx.transaction_date,
        quantity_liters: tx.quantity_liters,
        warehouse_name: tx.diesel_warehouses?.name || 'N/A',
        plant_name: tx.diesel_warehouses?.plants?.name || 'N/A'
      }))

      setMatchingEntries(formatted)
      
      if (formatted.length > 0) {
        setSelectedEntryId(formatted[0].id)
        toast.success(`Se encontraron ${formatted.length} transacción(es) de entrada`)
      } else {
        setSelectedEntryId("")
        // Try a broader search without quantity filter to show what's available
        const { data: allEntries } = await supabase
          .from('diesel_transactions')
          .select(`id, transaction_id, quantity_liters, transaction_date`)
          .eq('transaction_type', 'entry')
          .eq('warehouse_id', toWarehouseId)
          .eq('product_id', transaction.product_id)
          .eq('is_transfer', false)
          .gte('transaction_date', dateFrom.toISOString())
          .lte('transaction_date', dateTo.toISOString())
          .limit(5)
        
        if (allEntries && allEntries.length > 0) {
          toast.info(`No se encontraron coincidencias exactas. Hay ${allEntries.length} entrada(s) en ese rango de fechas pero con cantidades diferentes.`)
        } else {
          toast.info('No se encontraron transacciones de entrada en ese almacén en el rango de fechas (±7 días). Puede crear la transacción de entrada primero.')
        }
      }
    } catch (error: any) {
      console.error('Error searching entries:', error)
      toast.error(`Error al buscar transacciones: ${error.message}`)
    } finally {
      setSearching(false)
    }
  }

  const handleSubmit = async () => {
    if (!transaction) return

    if (transaction.transaction_type === 'consumption' && !selectedEntryId && !toWarehouseId) {
      toast.error('Debe seleccionar una transacción de entrada o un almacén destino')
      return
    }

    setLoading(true)
    try {
      const response = await fetch('/api/diesel/transactions/mark-transfer', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          consumption_transaction_id: transaction.transaction_type === 'consumption' 
            ? transaction.id 
            : transaction.reference_transaction_id,
          entry_transaction_id: transaction.transaction_type === 'entry' 
            ? transaction.id 
            : selectedEntryId || undefined,
          to_warehouse_id: toWarehouseId || undefined,
          preserve_price: preservePrice
        })
      })

      const result = await response.json()

      if (!response.ok) {
        throw new Error(result.error || 'Error al marcar como transferencia')
      }

      toast.success('Transacciones marcadas como transferencia exitosamente')
      onSuccess()
      onClose()
    } catch (error: any) {
      console.error('Error marking transfer:', error)
      toast.error(error.message || 'Error al marcar como transferencia')
    } finally {
      setLoading(false)
    }
  }

  if (!transaction) return null

  const isConsumption = transaction.transaction_type === 'consumption'
  const alreadyTransfer = transaction.is_transfer

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ArrowRightLeft className="h-5 w-5 text-orange-600" />
            Marcar como Transferencia
          </DialogTitle>
          <DialogDescription>
            Marca esta transacción como parte de una transferencia entre plantas.
            Las transferencias no se cuentan como consumo en los reportes.
          </DialogDescription>
        </DialogHeader>

        {alreadyTransfer && (
          <Alert>
            <AlertTriangle className="h-4 w-4" />
            <AlertDescription>
              Esta transacción ya está marcada como transferencia.
            </AlertDescription>
          </Alert>
        )}

        <div className="space-y-6 py-4">
          {/* Transaction Info */}
          <div className="space-y-2">
            <Label className="text-sm font-semibold">Transacción Actual</Label>
            <div className="p-3 bg-muted rounded-lg space-y-1">
              <div className="text-sm">
                <span className="text-muted-foreground">ID: </span>
                <span className="font-mono">{transaction.transaction_id}</span>
              </div>
              <div className="text-sm">
                <span className="text-muted-foreground">Tipo: </span>
                <span className="capitalize">{transaction.transaction_type === 'consumption' ? 'Consumo (Salida)' : 'Entrada'}</span>
              </div>
              <div className="text-sm">
                <span className="text-muted-foreground">Cantidad: </span>
                <span className="font-semibold">{transaction.quantity_liters.toFixed(2)}L</span>
              </div>
              {transaction.unit_cost && (
                <div className="text-sm">
                  <span className="text-muted-foreground">Precio unitario: </span>
                  <span className="font-semibold">${transaction.unit_cost.toFixed(2)}/L</span>
                </div>
              )}
            </div>
          </div>

          {isConsumption && (
            <>
              {/* Matching Entries */}
              {matchingEntries.length > 0 && (
                <div className="space-y-2">
                  <Label>Transacción de Entrada Correspondiente</Label>
                  <Select value={selectedEntryId} onValueChange={setSelectedEntryId}>
                    <SelectTrigger>
                      <SelectValue placeholder="Seleccione una transacción de entrada" />
                    </SelectTrigger>
                    <SelectContent>
                      {matchingEntries.map((entry) => (
                        <SelectItem key={entry.id} value={entry.id}>
                          <div className="flex flex-col">
                            <span className="font-mono text-xs">{entry.transaction_id}</span>
                            <span className="text-xs text-muted-foreground">
                              {entry.warehouse_name} - {entry.plant_name} | {entry.quantity_liters.toFixed(2)}L
                            </span>
                          </div>
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <p className="text-xs text-muted-foreground">
                    Se encontraron {matchingEntries.length} transacción(es) de entrada que coinciden por cantidad y fecha.
                  </p>
                </div>
              )}

              {/* Or select warehouse */}
              <div className="space-y-2">
                <Label>O seleccione almacén destino para buscar</Label>
                <Select value={toWarehouseId} onValueChange={(value) => {
                  setToWarehouseId(value)
                  setMatchingEntries([]) // Clear previous results
                  setSelectedEntryId("")
                }}>
                  <SelectTrigger>
                    <SelectValue placeholder="Seleccione almacén destino" />
                  </SelectTrigger>
                  <SelectContent>
                    {warehouses.map((wh) => (
                      <SelectItem key={wh.id} value={wh.id}>
                        {wh.name} - {wh.plant_name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {toWarehouseId && (
                  <div className="flex gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={(e) => {
                        e.preventDefault()
                        e.stopPropagation()
                        searchMatchingEntries()
                      }}
                      disabled={searching || !toWarehouseId}
                      className="flex-1"
                    >
                      {searching ? (
                        <>
                          <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                          Buscando...
                        </>
                      ) : (
                        'Buscar coincidencias (±7 días)'
                      )}
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={async (e) => {
                        e.preventDefault()
                        e.stopPropagation()
                        setSearching(true)
                        try {
                          // Show all entries in warehouse (last 30 days, any quantity)
                          const dateFrom = new Date()
                          dateFrom.setDate(dateFrom.getDate() - 30)
                          
                          const { data, error } = await supabase
                            .from('diesel_transactions')
                            .select(`
                              id,
                              transaction_id,
                              transaction_date,
                              quantity_liters,
                              diesel_warehouses!inner(name, plants!inner(name)),
                              is_transfer
                            `)
                            .eq('transaction_type', 'entry')
                            .eq('warehouse_id', toWarehouseId)
                            .eq('product_id', transaction.product_id)
                            .eq('is_transfer', false)
                            .gte('transaction_date', dateFrom.toISOString())
                            .order('transaction_date', { ascending: false })
                            .limit(50)

                          if (error) throw error

                          const formatted = (data || []).map((tx: any) => ({
                            id: tx.id,
                            transaction_id: tx.transaction_id,
                            transaction_date: tx.transaction_date,
                            quantity_liters: tx.quantity_liters,
                            warehouse_name: tx.diesel_warehouses?.name || 'N/A',
                            plant_name: tx.diesel_warehouses?.plants?.name || 'N/A'
                          }))

                          setMatchingEntries(formatted)
                          if (formatted.length > 0) {
                            setSelectedEntryId(formatted[0].id)
                            toast.success(`Mostrando ${formatted.length} entrada(s) disponibles`)
                          } else {
                            toast.info('No hay entradas disponibles en este almacén')
                          }
                        } catch (err: any) {
                          console.error('Error loading all entries:', err)
                          toast.error(`Error: ${err.message}`)
                        } finally {
                          setSearching(false)
                        }
                      }}
                      disabled={searching || !toWarehouseId}
                      className="flex-1"
                      title="Mostrar todas las entradas disponibles"
                    >
                      Ver todas
                    </Button>
                  </div>
                )}
              </div>
            </>
          )}

          {/* Price Preservation */}
          {transaction.unit_cost && (
            <div className="space-y-2">
              <div className="flex items-start space-x-2">
                <input
                  type="checkbox"
                  id="preservePrice"
                  checked={preservePrice}
                  onChange={(e) => setPreservePrice(e.target.checked)}
                  className="mt-1"
                />
                <Label htmlFor="preservePrice" className="cursor-pointer">
                  <div className="space-y-1">
                    <div className="font-medium">Preservar precio de Plant 4</div>
                    <div className="text-xs text-muted-foreground">
                      Mantiene el precio unitario (${transaction.unit_cost.toFixed(2)}/L) en la transacción de entrada.
                      Esto preserva el costo histórico para el sistema FIFO.
                    </div>
                  </div>
                </Label>
              </div>
            </div>
          )}

          {/* Info Alert */}
          <Alert>
            <Info className="h-4 w-4" />
            <AlertDescription className="text-xs">
              <strong>Comportamiento FIFO:</strong> Las transferencias de salida se excluyen de los cálculos de costo FIFO.
              Si preserva el precio, la transacción de entrada heredará el precio de Plant 4 y se incluirá en el inventario FIFO.
              Cuando ese diesel se consuma posteriormente en la planta receptora, usará el precio preservado de Plant 4.
              Esto mantiene la base de costo histórica y permite rastrear el costo correcto del consumo.
            </AlertDescription>
          </Alert>
        </div>

        <div className="flex justify-end gap-2 pt-4 border-t">
          <Button variant="outline" onClick={onClose} disabled={loading}>
            Cancelar
          </Button>
          <Button 
            onClick={handleSubmit} 
            disabled={loading || alreadyTransfer || (isConsumption && !selectedEntryId && !toWarehouseId)}
            className="bg-orange-600 hover:bg-orange-700"
          >
            {loading ? (
              <>
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                Procesando...
              </>
            ) : (
              <>
                <CheckCircle2 className="h-4 w-4 mr-2" />
                Marcar como Transferencia
              </>
            )}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
