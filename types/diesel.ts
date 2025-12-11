// Diesel Inventory Types

// Product type for multi-product support
export type ProductType = 'diesel' | 'urea'

// Movement categories
export type MovementCategory = 
  | 'inventory_opening'      // Entrada, no unit, no liters, has INVENTARIO INICIAL
  | 'inventory_adjustment'   // Manual adjustment/correction
  | 'fuel_receipt'           // Entrada, no unit, large liters
  | 'asset_consumption'      // Salida, has unit, has liters
  | 'unassigned_consumption' // Salida, no unit, has liters

// Meter reading for an asset at a point in time
export interface MeterReading {
  asset_code: string
  reading_date: Date
  reading_time: string | null
  horometer: number | null
  kilometer: number | null
  fuel_consumed: number
  operator: string | null
  
  // Computed deltas (filled during processing)
  horometer_delta: number | null
  kilometer_delta: number | null
  days_since_last: number | null
  daily_hours_avg: number | null
  daily_km_avg: number | null
  fuel_efficiency_per_hour: number | null
  fuel_efficiency_per_km: number | null
  
  // Validation
  has_warnings: boolean
  has_errors: boolean
  validation_messages: string[]
  
  // Metadata
  original_row_number: number
  source_batch_id: string
}

// Enhanced parsed row with movement classification and meter tracking
export interface DieselExcelRow {
  // Raw fields from Excel
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
  
  // Metadata
  original_row_index: number;
  
  // Parsing & classification
  parsed_date: Date | null;
  sort_key: string; // For chronological sorting
  movement_category: MovementCategory;
  
  // Adjustment detection
  is_likely_adjustment: boolean;
  adjustment_reason: string | null;
  
  // Validation from discrepancies
  has_validation_discrepancy: boolean;
  validation_discrepancy_liters: number;
  
  // Asset resolution
  asset_id: string | null;
  exception_asset_name: string | null;
  asset_category: 'formal' | 'exception' | 'general' | null;
  resolved_asset_name: string | null;
  resolved_asset_type: 'formal' | 'exception' | 'general' | 'unmapped' | null;
  resolved_asset_id: string | null;
  requires_asset_mapping: boolean;
  
  // Meter reading tracking
  has_meter_readings: boolean;
  meter_reading: MeterReading | null;
  
  // Processing state
  validation_status: 'valid' | 'warning' | 'error';
  validation_messages: string[];
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
  asset_category?: 'formal' | 'exception' | 'general' | null;
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

// Plant-specific batch for processing
export interface PlantBatch {
  batch_id: string
  plant_code: string
  warehouse_number: string
  original_filename: string
  
  // Rows for this plant/warehouse
  rows: DieselExcelRow[]
  
  // Computed statistics
  total_rows: number
  inventory_opening_row: DieselExcelRow | null
  initial_inventory: number
  final_inventory_computed: number
  final_inventory_provided: number
  inventory_discrepancy: number
  
  // Movement counts
  fuel_receipts: number
  asset_consumptions: number
  unassigned_consumptions: number
  adjustments: number
  
  // Asset tracking
  unique_assets: string[]
  unmapped_assets: string[]
  assets_with_meters: string[]
  
  // Meter readings extracted
  meter_readings: MeterReading[]
  meter_conflicts: MeterConflict[]
  
  // Volume totals
  total_litros_in: number
  total_litros_out: number
  net_change: number
  
  // Validation summary
  validation_warnings: number
  validation_errors: number
  
  // Date range
  date_range: {
    start: Date | null
    end: Date | null
  }
  
  // Processing state
  status: 'pending' | 'ready' | 'processing' | 'completed' | 'error'
  created_at: string
}

// Meter reading conflict with checklist data
export interface MeterConflict {
  asset_code: string
  asset_id: string | null
  
  // From diesel import
  diesel_horometer: number | null
  diesel_kilometer: number | null
  diesel_date: Date
  diesel_row_number: number
  
  // From checklist (current system)
  checklist_horometer: number | null
  checklist_kilometer: number | null
  checklist_date: Date | null
  checklist_source: string // e.g., "Morning Checklist 2025-02-14"
  
  // Conflict analysis
  horometer_diff: number | null
  kilometer_diff: number | null
  is_diesel_newer: boolean
  is_diesel_higher: boolean
  
  // User decision
  resolution: 'pending' | 'use_diesel' | 'keep_checklist' | 'skip'
  resolved_by: string | null
  resolved_at: string | null
}

// User preferences for meter reconciliation
export interface MeterReconciliationPreferences {
  default_action: 'prompt' | 'use_diesel_if_newer' | 'always_keep_checklist' | 'always_use_diesel'
  update_threshold_days: number // Only update if diesel reading is N days newer
  prompt_if_discrepancy_gt: number // Prompt user if difference > N hours/km
}
