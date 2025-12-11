import { create } from 'zustand'
import { devtools, subscribeWithSelector } from 'zustand/middleware'

// Import types from centralized type file
import type { PlantBatch, MeterConflict, MeterReconciliationPreferences, ProductType } from '@/types/diesel'

// Re-export for backward compatibility
export interface DieselExcelRow {
  creado: string;
  planta: string;
  clave_producto: string;
  almacen: string;
  tipo: 'Entrada' | 'Salida';
  unidad: string;
  identificador: string;
  fecha_: string;
  horario: string;
  horometro: number | null;
  kilometraje: number | null;
  litros_cantidad: number;
  cuenta_litros: number | null;
  responsable_unidad: string;
  responsable_suministro: string;
  validacion: string;
  inventario_inicial: number | null;
  inventario: number | null;
  original_row_index: number;
  validation_status: 'valid' | 'warning' | 'error';
  validation_messages: string[];
  asset_id: string | null;
  exception_asset_name: string | null;
  asset_category: 'formal' | 'exception' | 'general' | null;
  resolved_asset_name: string | null;
  resolved_asset_type: 'formal' | 'exception' | 'general' | 'unmapped' | null;
  resolved_asset_id: string | null;
  processing_status: 'pending' | 'staged' | 'processed' | 'error' | 'skipped';
  processing_notes: string | null;
}

export interface ImportBatch {
  batch_id: string;
  original_filename: string;
  total_rows: number;
  processed_rows: number;
  successful_rows: number;
  error_rows: number;
  status: 'uploading' | 'parsing' | 'mapping' | 'staging' | 'processing' | 'completed' | 'error';
  progress_percentage: number;
  created_at: string;
  completed_at: string | null;
  created_by: string;
  processing_summary: {
    total_processed: number;
    successful: number;
    errors: number;
    warnings: number;
    unmapped_assets: number;
    mapped_assets: number;
  } | null;
}

export interface AssetMappingEntry {
  original_name: string;
  suggested_formal_asset_id: string | null;
  suggested_formal_asset_name: string | null;
  suggested_exception_asset_id: string | null;
  suggested_exception_asset_name: string | null;
  confidence_level: number;
  status: 'unmapped' | 'mapped_formal' | 'mapped_exception' | 'ignored';
  selected_mapping_type: 'formal' | 'exception' | 'general' | 'ignore' | null;
  selected_asset_id: string | null;
  selected_exception_asset_name: string | null;
  manual_override: boolean;
  occurrences: number;
  first_seen: string;
  last_seen: string;
}

export interface AssetResolution {
  original_name: string;
  resolution_type: 'formal' | 'exception' | 'general' | 'unmapped';
  asset_id: string | null;
  exception_asset_id: string | null;
  asset_name: string | null;
  exception_asset_name: string | null;
  confidence: number;
  created_new: boolean;
  mapping_notes: string | null;
}

export interface ProcessingError {
  id: string;
  batch_id: string;
  row_number: number;
  error_type: 'validation' | 'mapping' | 'database' | 'processing';
  error_message: string;
  field_name: string | null;
  suggested_fix: string | null;
  severity: 'warning' | 'error' | 'critical';
  resolved: boolean;
  resolved_at: string | null;
  resolved_by: string | null;
}

export interface ProcessingNotification {
  id: string;
  type: 'info' | 'success' | 'warning' | 'error';
  title: string;
  message: string;
  timestamp: string;
  dismissed: boolean;
  action?: {
    label: string;
    callback: () => void;
  };
}

export interface ValidationResult {
  isValid: boolean;
  errors: Array<{
    field: string;
    message: string;
    value: any;
    rowNumber: number;
  }>;
  warnings: Array<{
    field: string;
    message: string;
    value: any;
    rowNumber: number;
    suggestion?: string;
  }>;
}

// Define the complete store interface
interface DieselStore {
  // State properties
  uploadedFile: File | null;
  uploadProgress: number;
  isUploading: boolean;
  parsedData: DieselExcelRow[];
  parsingErrors: string[];
  isParsing: boolean;
  currentBatch: ImportBatch | null;
  batchHistory: ImportBatch[];
  
  // Plant batch management (NEW)
  plantBatches: PlantBatch[];
  selectedPlantBatch: string | null; // batch_id
  
  // Meter reconciliation (NEW)
  meterConflicts: MeterConflict[];
  meterPreferences: MeterReconciliationPreferences;
  
  // Product type selection (NEW)
  selectedProductType: ProductType;
  
  unmappedAssets: AssetMappingEntry[];
  pendingMappings: Map<string, AssetResolution>;
  mappingProgress: number;
  processingStatus: 'idle' | 'uploading' | 'parsing' | 'mapping' | 'staging' | 'processing' | 'completed' | 'error';
  currentStep: string;
  overallProgress: number;
  errors: ProcessingError[];
  notifications: ProcessingNotification[];
  user: { id: string } | null;

  // Actions
  setUser: (user: { id: string } | null) => void;
  setUploadedFile: (file: File | null) => void;
  setUploadProgress: (progress: number) => void;
  setUploading: (isUploading: boolean) => void;
  setParsedData: (data: DieselExcelRow[]) => void;
  setParsingErrors: (errors: string[]) => void;
  setParsing: (isParsing: boolean) => void;
  clearParsedData: () => void;
  createBatch: (filename: string, rowCount: number) => Promise<string>;
  updateBatch: (batch: Partial<ImportBatch>) => void;
  completeBatch: () => void;
  
  // Plant batch actions (NEW)
  setPlantBatches: (batches: PlantBatch[]) => void;
  selectPlantBatch: (batchId: string | null) => void;
  getSelectedPlantBatch: () => PlantBatch | null;
  updatePlantBatch: (batchId: string, updates: Partial<PlantBatch>) => void;
  
  // Meter reconciliation actions (NEW)
  setMeterConflicts: (conflicts: MeterConflict[]) => void;
  resolveMeterConflict: (assetCode: string, resolution: MeterConflict['resolution']) => void;
  setMeterPreferences: (prefs: Partial<MeterReconciliationPreferences>) => void;
  
  // Product type actions (NEW)
  setSelectedProductType: (productType: ProductType) => void;
  
  setUnmappedAssets: (assets: AssetMappingEntry[]) => void;
  addPendingMapping: (originalName: string, resolution: AssetResolution) => void;
  removePendingMapping: (originalName: string) => void;
  setMappingProgress: (progress: number) => void;
  submitAssetMappings: () => Promise<boolean>;
  setProcessingStatus: (status: DieselStore['processingStatus']) => void;
  setCurrentStep: (step: string) => void;
  setOverallProgress: (progress: number) => void;
  addError: (error: ProcessingError) => void;
  removeError: (errorId: string) => void;
  clearErrors: () => void;
  addNotification: (notification: Omit<ProcessingNotification, 'id' | 'timestamp' | 'dismissed'>) => void;
  dismissNotification: (notificationId: string) => void;
  clearNotifications: () => void;
  validateExcelData: (data: DieselExcelRow[]) => ValidationResult;
  processDataBatch: () => Promise<boolean>;
  reset: () => void;
  getProcessingSummary: () => {
    totalRows: number;
    processedRows: number;
    errorCount: number;
    successRate: number;
    currentBatch: ImportBatch | null;
  };
}

// Create the diesel-specific store
export const useDieselStore = create<DieselStore>()(
  devtools(
    subscribeWithSelector(
      (set, get) => ({
        // Initial state
        uploadedFile: null,
        uploadProgress: 0,
        isUploading: false,
        parsedData: [],
        parsingErrors: [],
        isParsing: false,
        currentBatch: null,
        batchHistory: [],
        
        // Plant batches (NEW)
        plantBatches: [],
        selectedPlantBatch: null,
        
        // Meter reconciliation (NEW)
        meterConflicts: [],
        meterPreferences: {
          default_action: 'prompt',
          update_threshold_days: 7,
          prompt_if_discrepancy_gt: 10
        },
        
        // Product type (NEW)
        selectedProductType: 'diesel',
        
        unmappedAssets: [],
        pendingMappings: new Map(),
        mappingProgress: 0,
        processingStatus: 'idle',
        currentStep: '',
        overallProgress: 0,
        errors: [],
        notifications: [],
        user: null,

        // Actions
        setUser: (user: { id: string } | null) => set({ user }),
        setUploadedFile: (file: File | null) => set({ uploadedFile: file }),
        setUploadProgress: (progress: number) => set({ uploadProgress: Math.max(0, Math.min(100, progress)) }),
        setUploading: (isUploading: boolean) => set(state => ({
          isUploading,
          uploadProgress: isUploading ? 0 : state.uploadProgress
        })),
        setParsedData: (data: DieselExcelRow[]) => set({
          parsedData: data,
          parsingErrors: [],
          isParsing: false
        }),
        setParsingErrors: (errors: string[]) => set({ parsingErrors: errors }),
        setParsing: (isParsing: boolean) => set({ isParsing }),
        clearParsedData: () => set({
          parsedData: [],
          parsingErrors: [],
          isParsing: false
        }),
        createBatch: async (filename: string, rowCount: number) => {
          const batchId = `batch-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`
          const state = get()

          const newBatch: ImportBatch = {
            batch_id: batchId,
            original_filename: filename,
            total_rows: rowCount,
            processed_rows: 0,
            successful_rows: 0,
            error_rows: 0,
            status: 'uploading',
            progress_percentage: 0,
            created_at: new Date().toISOString(),
            completed_at: null,
            created_by: state.user?.id || 'unknown',
            processing_summary: null
          }

          set({ currentBatch: newBatch })

          // Add notification using the addNotification function directly
          const notification = {
            id: `notification-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`,
            type: 'info' as const,
            title: 'Batch Created',
            message: `New import batch created for ${filename}`,
            timestamp: new Date().toISOString(),
            dismissed: false
          }

          set(state => ({
            notifications: [...state.notifications, notification]
          }))

          return batchId
        },
        updateBatch: (batchUpdate: Partial<ImportBatch>) => {
          set(state => ({
            currentBatch: state.currentBatch
              ? { ...state.currentBatch, ...batchUpdate }
              : null
          }))
        },
        completeBatch: () => {
          const { currentBatch } = get()
          if (currentBatch) {
            const completedBatch: ImportBatch = {
              ...currentBatch,
              status: 'completed',
              completed_at: new Date().toISOString(),
              progress_percentage: 100
            }

            set(state => ({
              currentBatch: null,
              batchHistory: [completedBatch, ...state.batchHistory],
              processingStatus: 'completed'
            }))

            // Add notification using direct set
            const notification = {
              id: `notification-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`,
              type: 'success' as const,
              title: 'Batch Completed',
              message: `Successfully processed ${completedBatch.successful_rows}/${completedBatch.total_rows} rows`,
              timestamp: new Date().toISOString(),
              dismissed: false
            }

            set(state => ({
              notifications: [...state.notifications, notification]
            }))
          }
        },
        
        // Plant batch actions (NEW)
        setPlantBatches: (batches: PlantBatch[]) => set({ plantBatches: batches }),
        selectPlantBatch: (batchId: string | null) => set({ selectedPlantBatch: batchId }),
        getSelectedPlantBatch: () => {
          const { plantBatches, selectedPlantBatch } = get()
          return plantBatches.find(b => b.batch_id === selectedPlantBatch) || null
        },
        updatePlantBatch: (batchId: string, updates: Partial<PlantBatch>) => {
          set(state => ({
            plantBatches: state.plantBatches.map(batch =>
              batch.batch_id === batchId ? { ...batch, ...updates } : batch
            )
          }))
        },
        
        // Meter reconciliation actions (NEW)
        setMeterConflicts: (conflicts: MeterConflict[]) => set({ meterConflicts: conflicts }),
        resolveMeterConflict: (assetCode: string, resolution: MeterConflict['resolution']) => {
          const state = get()
          set({
            meterConflicts: state.meterConflicts.map(conflict =>
              conflict.asset_code === assetCode
                ? {
                    ...conflict,
                    resolution,
                    resolved_by: state.user?.id || 'unknown',
                    resolved_at: new Date().toISOString()
                  }
                : conflict
            )
          })
        },
        setMeterPreferences: (prefs: Partial<MeterReconciliationPreferences>) => {
          set(state => ({
            meterPreferences: { ...state.meterPreferences, ...prefs }
          }))
        },
        setSelectedProductType: (productType: ProductType) => set({ selectedProductType: productType }),
        setUnmappedAssets: (assets: AssetMappingEntry[]) => set({ unmappedAssets: assets }),
        addPendingMapping: (originalName: string, resolution: AssetResolution) => {
          set(state => {
            const newPendingMappings = new Map(state.pendingMappings)
            newPendingMappings.set(originalName, resolution)
            return { pendingMappings: newPendingMappings }
          })
        },
        removePendingMapping: (originalName: string) => {
          set(state => {
            const newPendingMappings = new Map(state.pendingMappings)
            newPendingMappings.delete(originalName)
            return { pendingMappings: newPendingMappings }
          })
        },
        setMappingProgress: (progress: number) => set({ mappingProgress: Math.max(0, Math.min(100, progress)) }),
        submitAssetMappings: async () => {
          const state = get()
          const { pendingMappings, user } = state
          
          if (pendingMappings.size === 0) {
            console.warn('[DieselStore] No mappings to submit')
            return true
          }
          
          if (!user?.id) {
            console.error('[DieselStore] Cannot submit mappings: no user')
            return false
          }
          
          try {
            // Check if we're in browser environment
            if (typeof window === 'undefined') {
              console.error('[DieselStore] Cannot submit mappings: not in browser environment')
              return false
            }
            
            // Dynamically import Supabase client to avoid SSR issues
            const { createBrowserClient } = await import('@supabase/ssr')
            const supabase = createBrowserClient(
              process.env.NEXT_PUBLIC_SUPABASE_URL!,
              process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
            )
            
            // Save each mapping to the database
            let successCount = 0
            let errorCount = 0
            
            for (const [originalName, resolution] of pendingMappings.entries()) {
              try {
                // Determine mapping type
                let mappingType: 'formal' | 'exception' | 'ignore' = 'ignore'
                let assetId: string | null = null
                let exceptionAssetId: string | null = null
                
                if (resolution.resolution_type === 'formal' && resolution.asset_id) {
                  mappingType = 'formal'
                  assetId = resolution.asset_id
                } else if (resolution.resolution_type === 'exception') {
                  mappingType = 'exception'
                  // For exceptions, we need to get or create the exception asset
                  // For now, we'll need to handle this during processing
                  // But we can still save the mapping with a placeholder
                  // The exception asset will be created during batch processing
                } else if (resolution.resolution_type === 'general') {
                  // General consumption doesn't need a mapping saved
                  continue
                } else {
                  mappingType = 'ignore'
                }
                
                // Only save formal and exception mappings (ignore general and unmapped)
                if (mappingType === 'ignore' && resolution.resolution_type !== 'exception') {
                  continue
                }
                
                // For exception mappings, we need to create/get the exception asset first
                if (mappingType === 'exception') {
                  // Check if exception asset exists
                  const { data: existingException } = await supabase
                    .from('exception_assets')
                    .select('id')
                    .eq('exception_name', originalName)
                    .single()
                  
                  if (existingException) {
                    exceptionAssetId = existingException.id
                  } else {
                    // Create exception asset
                    const { data: newException, error: createError } = await supabase
                      .from('exception_assets')
                      .insert({
                        exception_name: originalName,
                        normalized_name: originalName.toLowerCase().trim(),
                        asset_type: 'unknown'
                      })
                      .select('id')
                      .single()
                    
                    if (createError || !newException) {
                      console.error(`[DieselStore] Failed to create exception asset for ${originalName}:`, createError)
                      errorCount++
                      continue
                    }
                    
                    exceptionAssetId = newException.id
                  }
                }
                
                // Save the mapping using RPC function
                const { error: mappingError } = await supabase.rpc('create_asset_mapping', {
                  p_original_name: originalName,
                  p_asset_id: assetId,
                  p_exception_asset_id: exceptionAssetId,
                  p_mapping_type: mappingType,
                  p_created_by: user.id
                })
                
                if (mappingError) {
                  console.error(`[DieselStore] Failed to save mapping for ${originalName}:`, mappingError)
                  errorCount++
                } else {
                  successCount++
                }
              } catch (error) {
                console.error(`[DieselStore] Error processing mapping for ${originalName}:`, error)
                errorCount++
              }
            }
            
            console.log(`[DieselStore] Mappings saved: ${successCount} successful, ${errorCount} errors`)
            
            if (errorCount > 0 && successCount === 0) {
              return false
            }
            
            return true
          } catch (error) {
            console.error('[DieselStore] Error submitting asset mappings:', error)
            return false
          }
        },
        setProcessingStatus: (status: DieselStore['processingStatus']) => set({ processingStatus: status }),
        setCurrentStep: (step: string) => set({ currentStep: step }),
        setOverallProgress: (progress: number) => set({ overallProgress: Math.max(0, Math.min(100, progress)) }),
        addError: (error: ProcessingError) => {
          set(state => ({
            errors: [...state.errors, error]
          }))
        },
        removeError: (errorId: string) => {
          set(state => ({
            errors: state.errors.filter(error => error.id !== errorId)
          }))
        },
        clearErrors: () => set({ errors: [] }),
        addNotification: (notification: Omit<ProcessingNotification, 'id' | 'timestamp' | 'dismissed'>) => {
          const fullNotification: ProcessingNotification = {
            ...notification,
            id: `notification-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`,
            timestamp: new Date().toISOString(),
            dismissed: false
          }

          set(state => ({
            notifications: [...state.notifications, fullNotification]
          }))
        },
        dismissNotification: (notificationId: string) => {
          set(state => ({
            notifications: state.notifications.map(notification =>
              notification.id === notificationId
                ? { ...notification, dismissed: true }
                : notification
            )
          }))
        },
        clearNotifications: () => set({ notifications: [] }),
        validateExcelData: (data: DieselExcelRow[]) => {
          const errors: Array<{field: string; message: string; value: any; rowNumber: number}> = []
          const warnings: Array<{field: string; message: string; value: any; rowNumber: number; suggestion?: string}> = []

          data.forEach((row, index) => {
            const rowNumber = index + 1

            if (!row.planta?.trim()) {
              errors.push({
                field: 'planta',
                message: 'Plant code is required',
                value: row.planta,
                rowNumber
              })
            }

            // Inventory opening rows may have litros_cantidad = 0 but must have inventario_inicial
            const isInventoryOpening = row.movement_category === 'inventory_opening' || 
                                       (row.tipo === 'Entrada' && !row.unidad && row.inventario_inicial != null && row.inventario_inicial > 0)
            
            if (!isInventoryOpening) {
              // For non-inventory-opening rows, litros_cantidad is required and must be valid
              if (row.litros_cantidad == null || isNaN(Number(row.litros_cantidad)) || row.litros_cantidad < 0) {
                errors.push({
                  field: 'litros_cantidad',
                  message: 'Valid quantity in liters is required',
                  value: row.litros_cantidad,
                  rowNumber
                })
              }
            }

            if (!['Entrada', 'Salida'].includes(row.tipo)) {
              errors.push({
                field: 'tipo',
                message: 'Transaction type must be "Entrada" or "Salida"',
                value: row.tipo,
                rowNumber
              })
            }
          })

          return {
            isValid: errors.length === 0,
            errors,
            warnings
          }
        },
        processDataBatch: async () => {
          await new Promise(resolve => setTimeout(resolve, 2000))
          return true
        },
        reset: () => {
          set(state => ({
            uploadedFile: null,
            uploadProgress: 0,
            isUploading: false,
            parsedData: [],
            parsingErrors: [],
            isParsing: false,
            currentBatch: null,
            unmappedAssets: [],
            pendingMappings: new Map(),
            mappingProgress: 0,
            processingStatus: 'idle',
            currentStep: '',
            overallProgress: 0,
            errors: [],
            notifications: [],
            user: state.user,
            batchHistory: state.batchHistory
          }))
        },
        getProcessingSummary: () => {
          const state = get()
          return {
            totalRows: state.parsedData.length,
            processedRows: state.currentBatch?.processed_rows || 0,
            errorCount: state.errors.length,
            successRate: state.parsedData.length > 0
              ? ((state.parsedData.length - state.errors.length) / state.parsedData.length) * 100
              : 0,
            currentBatch: state.currentBatch
          }
        }
      })
    ),
    {
      name: 'DieselStore',
      trace: true,
      anonymousActionType: 'diesel-action',
    }
  )
)

// Store utilities for non-hook access
export const getDieselStore = () => useDieselStore.getState()
export const setDieselStore = (state: Partial<DieselStore>) => useDieselStore.setState(state)

// Diesel-specific utilities
export const dieselUtils = {
  initializeWithUser: (userId: string) => {
    setDieselStore({ user: { id: userId } })
  },

  resetAll: () => {
    const store = getDieselStore()
    store.reset()
    store.clearNotifications()
    store.clearErrors()
  },

  getProcessingStats: () => {
    const store = getDieselStore()
    return store.getProcessingSummary()
  },

  isReady: () => {
    const { user, processingStatus } = getDieselStore()
    return user !== null && processingStatus !== 'processing'
  }
}

// Development utilities
if (process.env.NODE_ENV === 'development') {
  if (typeof window !== 'undefined') {
    (window as any).dieselStore = useDieselStore
    ;(window as any).dieselUtils = dieselUtils
  }
}