"use client"

import { useCallback, useState, useRef, useEffect } from 'react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Progress } from "@/components/ui/progress"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Separator } from "@/components/ui/separator"
import { 
  Upload, 
  FileSpreadsheet, 
  AlertCircle, 
  CheckCircle, 
  X, 
  FileText,
  Download,
  Info
} from "lucide-react"
import { cn } from "@/lib/utils"
import { useDieselStore } from '@/store/diesel-store'
import { DieselExcelRow } from '@/types/diesel'
import * as XLSX from 'xlsx'
import DieselPreviewEnhanced from './DieselPreviewEnhanced'
import { buildEnhancedRow, groupIntoPlantBatches } from '@/lib/diesel-parser-utils'
import { useAuthZustand } from "@/hooks/use-auth-zustand"

interface ExcelUploaderProps {
  productType: 'diesel' | 'urea'
  onDataParsed?: (data: DieselExcelRow[]) => void
  onBatchCreated?: (batchId: string) => void
}

// Expected Excel/CSV column mapping
const EXPECTED_COLUMNS = [
  { key: 'creado', label: 'Creado', required: false },
  { key: 'planta', label: 'Planta', required: true },
  { key: 'clave_producto', label: 'CLAVE DE PRODUCTO', required: false },
  { key: 'almacen', label: 'Almacen', required: true },
  { key: 'tipo', label: 'Tipo', required: true },
  { key: 'unidad', label: 'Unidad', required: false },
  { key: 'identificador', label: 'Identificador', required: false },
  { key: 'fecha_', label: 'Fecha_', required: true },
  { key: 'horario', label: 'Horario', required: false },
  { key: 'horometro', label: 'Horómetro', required: false },
  { key: 'kilometraje', label: 'Kilometraje', required: false },
  { key: 'litros_cantidad', label: 'Litros (Cantidad)', required: true },
  { key: 'cuenta_litros', label: 'Cuenta litros', required: false },
  { key: 'responsable_unidad', label: 'Responsable de unidad', required: false },
  { key: 'responsable_suministro', label: 'Responsable de suministro', required: false },
  { key: 'validacion', label: 'Validación', required: false },
  { key: 'inventario_inicial', label: 'INVENTARIO INICIAL', required: false },
  { key: 'inventario', label: 'Inventario', required: false }
]

export function ExcelUploader({ productType, onDataParsed, onBatchCreated }: ExcelUploaderProps) {
  // Zustand store
  const {
    uploadedFile,
    uploadProgress,
    isUploading,
    isParsing,
    parsedData,
    parsingErrors,
    setUploadedFile,
    setUploadProgress,
    setUploading,
    setParsing,
    setParsedData,
    setParsingErrors,
    createBatch,
    addNotification,
    addError,
    validateExcelData,
    user: storeUser,
    setUser,
    setPlantBatches,
    selectPlantBatch,
    plantBatches
  } = useDieselStore()
  
  const { profile, user } = useAuthZustand()
  
  // Initialize diesel store with user context - only update if different
  useEffect(() => {
    if (user?.id && storeUser?.id !== user.id) {
      setUser({ id: user.id })
    } else if (!user?.id && storeUser) {
      setUser(null)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id, storeUser?.id]) // Only update if user ID actually changed
  
  // Local state
  const [isDragOver, setIsDragOver] = useState(false)
  const [filePreview, setFilePreview] = useState<{
    name: string
    size: string
    type: string
  } | null>(null)
  
  const fileInputRef = useRef<HTMLInputElement>(null)
  const dropZoneRef = useRef<HTMLDivElement>(null)

  // Utilities
  const normalize = (s: string) => s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()

  const headerLookup: Record<string, string> = EXPECTED_COLUMNS
    .reduce((acc, col) => {
      acc[normalize(col.label)] = col.key
      return acc
    }, {} as Record<string, string>)

  const coerceNumber = (val: any): number | null => {
    if (val === null || val === undefined || val === '') return null
    const n = typeof val === 'number' ? val : Number(String(val).replace(/,/g, '.'))
    return isNaN(n) ? null : n
  }

  const coerceTipo = (val: any): 'Entrada' | 'Salida' => {
    const v = String(val || '').toLowerCase()
    if (v.includes('entrada')) return 'Entrada'
    return 'Salida'
  }

  // Generate batch ID
  const generateBatchId = () => `batch-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`

  const mapHeaderIndices = (headers: string[]) => {
    const indices: Record<string, number> = {}
    headers.forEach((h, i) => {
      const nh = normalize(h)
      // direct match or loose contains match on normalized strings
      if (headerLookup[nh]) {
        indices[headerLookup[nh]] = i
      } else {
        // try fuzzy contains against known labels
        const match = Object.entries(headerLookup).find(([k]) => nh.includes(k) || k.includes(nh))
        if (match) indices[match[1]] = i
      }
    })
    return indices
  }

  // Expected product codes by type
  const expectedProductCode = productType === 'diesel' ? '07DS01' : '07UR01'

  // Parse CSV content to DieselExcelRow format (robust, with type coercion)
  const parseCSVContent = useCallback((content: string, filename: string): DieselExcelRow[] => {
    const lines = content.split(/\r?\n/).filter(line => line.trim())
    if (lines.length < 2) {
      throw new Error('File must contain at least a header and one data row')
    }

    const batchId = generateBatchId()

    // naive CSV split; for complex CSVs we recommend uploading .xlsx
    const headerCells = lines[0].split(',').map(col => col.trim().replace(/"/g, ''))
    const columnMapping = mapHeaderIndices(headerCells)

    const missingColumns = EXPECTED_COLUMNS
      .filter(col => col.required && !(col.key in columnMapping))
      .map(col => col.label)
    if (missingColumns.length > 0) {
      throw new Error(`Missing required columns: ${missingColumns.join(', ')}`)
    }

    const parsedRows: DieselExcelRow[] = []
    for (let i = 1; i < lines.length; i++) {
      const cells = lines[i].split(',').map(cell => cell.trim().replace(/"/g, ''))
      const raw: Record<string, any> = {}
      Object.entries(columnMapping).forEach(([key, idx]) => {
        raw[key] = cells[idx as any] ?? ''
      })
      
      // Validate product code matches expected type
      const rowProductCode = String(raw.clave_producto || '').trim()
      if (rowProductCode && rowProductCode !== expectedProductCode) {
        // Skip rows that don't match the selected product type
        continue
      }
      
      parsedRows.push(buildEnhancedRow(raw, i, batchId))
    }
    return parsedRows
  }, [expectedProductCode])

  // Parse XLSX (.xlsx/.xls) using SheetJS
  const parseXLSXContent = useCallback(async (file: File): Promise<DieselExcelRow[]> => {
    const batchId = generateBatchId()
    const arrayBuffer = await file.arrayBuffer()
    const workbook = XLSX.read(arrayBuffer, { cellDates: true })
    // Prefer a sheet that mentions diesel, else take first
    const sheetName = workbook.SheetNames.find(n => normalize(n).includes('diesel')) || workbook.SheetNames[0]
    const worksheet = workbook.Sheets[sheetName]
    const rows: any[][] = XLSX.utils.sheet_to_json(worksheet, { header: 1, defval: '' }) as any[][]
    if (!rows || rows.length < 2) {
      throw new Error('Excel sheet appears to be empty')
    }
    const headerCells = rows[0].map(String)
    const columnMapping = mapHeaderIndices(headerCells)

    const missingColumns = EXPECTED_COLUMNS
      .filter(col => col.required && !(col.key in columnMapping))
      .map(col => col.label)
    if (missingColumns.length > 0) {
      throw new Error(`Missing required columns: ${missingColumns.join(', ')}`)
    }

    const parsedRows: DieselExcelRow[] = []
    for (let i = 1; i < rows.length; i++) {
      const cells = rows[i]
      if (!cells || cells.length === 0 || cells.every(v => (v === '' || v === null))) continue
      const raw: Record<string, any> = {}
      Object.entries(columnMapping).forEach(([key, idx]) => {
        raw[key] = cells[idx as any]
      })
      
      // Validate product code matches expected type
      const rowProductCode = String(raw.clave_producto || '').trim()
      if (rowProductCode && rowProductCode !== expectedProductCode) {
        // Skip rows that don't match the selected product type
        continue
      }
      
      parsedRows.push(buildEnhancedRow(raw, i, batchId))
    }
    return parsedRows
  }, [expectedProductCode])

  // Handle file upload and parsing
  const handleFileUpload = useCallback(async (file: File) => {
    if (!file) return
    
    // Validate file type
    const validTypes = [
      'text/csv',
      'application/vnd.ms-excel',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    ]
    
    if (!validTypes.includes(file.type) && !file.name.endsWith('.csv')) {
      addError({
        id: `file-error-${Date.now()}`,
        batch_id: '',
        row_number: 0,
        error_type: 'validation',
        error_message: 'Invalid file type. Please upload a CSV or Excel file.',
        field_name: 'file_type',
        suggested_fix: 'Convert your file to CSV format',
        severity: 'error',
        resolved: false,
        resolved_at: null,
        resolved_by: null
      })
      return
    }
    
    // Set file info
    setUploadedFile(file)
    setFilePreview({
      name: file.name,
      size: `${(file.size / 1024 / 1024).toFixed(2)} MB`,
      type: file.type || 'text/csv'
    })
    
    try {
      setUploading(true)
      setParsing(true)
      setUploadProgress(0)
      
      // Simulate upload progress
      for (let i = 0; i <= 50; i += 10) {
        setUploadProgress(i)
        await new Promise(resolve => setTimeout(resolve, 50))
      }
      
      // Parse by type
      const isExcel = file.type === 'application/vnd.ms-excel' || file.type === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' || /\.xlsx?$/.test(file.name)
      let parsed: DieselExcelRow[] = []
      if (isExcel) {
        parsed = await parseXLSXContent(file)
      } else {
        const content = await file.text()
        parsed = parseCSVContent(content, file.name)
      }
      setUploadProgress(70)
      
      // Group into plant batches
      const batches = groupIntoPlantBatches(parsed, file.name)
      setPlantBatches(batches)
      
      // Auto-select first batch
      if (batches.length > 0) {
        selectPlantBatch(batches[0].batch_id)
        console.log('[ExcelUploader] Auto-selected first batch:', batches[0].batch_id)
      }
      
      addNotification({
        type: 'info',
        title: 'Batches Created',
        message: `Separated into ${batches.length} plant batch(es)`
      })
      
      setUploadProgress(90)
      
      // Validate data
      const validation = validateExcelData(parsed)
      
      if (validation.warnings.length > 0) {
        addNotification({
          type: 'warning',
          title: 'Data Quality Warning',
          message: `${validation.warnings.length} warnings found in data. Review before processing.`
        })
      }
      
      if (!validation.isValid) {
        setParsingErrors(validation.errors.map(e => e.message))
        throw new Error(`Validation failed: ${validation.errors.length} errors found`)
      }
      
      // Set parsed data
      setParsedData(parsed)
      setParsingErrors([])
      setUploadProgress(100)
      
      // Create batch
      const batchId = await createBatch(file.name, parsed.length)
      
      // Callbacks
      onDataParsed?.(parsed)
      onBatchCreated?.(batchId)
      
      addNotification({
        type: 'success',
        title: 'File Parsed Successfully',
        message: `Processed ${parsed.length} rows from ${file.name}`
      })
      
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error'
      setParsingErrors([errorMessage])
      
      addError({
        id: `parse-error-${Date.now()}`,
        batch_id: '',
        row_number: 0,
        error_type: 'validation',
        error_message: errorMessage,
        field_name: null,
        suggested_fix: 'Check file format and data integrity',
        severity: 'error',
        resolved: false,
        resolved_at: null,
        resolved_by: null
      })
      
    } finally {
      setUploading(false)
      setParsing(false)
    }
  }, [parseCSVContent, validateExcelData, setUploadedFile, setUploading, setParsing, 
      setUploadProgress, setParsedData, setParsingErrors, createBatch, addNotification, 
      addError, onDataParsed, onBatchCreated])

  // Drag and drop handlers
  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setIsDragOver(true)
  }, [])

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setIsDragOver(false)
  }, [])

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setIsDragOver(false)
    
    const files = Array.from(e.dataTransfer.files)
    if (files.length > 0) {
      handleFileUpload(files[0])
    }
  }, [handleFileUpload])

  // File input handler
  const handleFileInputChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || [])
    if (files.length > 0) {
      handleFileUpload(files[0])
    }
  }, [handleFileUpload])

  // Clear uploaded file
  const clearFile = useCallback(() => {
    setUploadedFile(null)
    setFilePreview(null)
    setParsedData([])
    setParsingErrors([])
    setUploadProgress(0)
    if (fileInputRef.current) {
      fileInputRef.current.value = ''
    }
  }, [setUploadedFile, setParsedData, setParsingErrors, setUploadProgress])

  const hasData = parsedData.length > 0
  const hasErrors = parsingErrors.length > 0

  return (
    <div className="space-y-6">
      {/* Upload Area */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Upload className="h-5 w-5" />
            Subir Archivo Excel/CSV
          </CardTitle>
          <CardDescription>
            Selecciona el archivo exportado desde tu sistema legacy de control de diesel
          </CardDescription>
        </CardHeader>
        <CardContent>
          {!uploadedFile ? (
            <div
              ref={dropZoneRef}
              className={cn(
                "border-2 border-dashed rounded-lg p-8 text-center transition-colors",
                isDragOver 
                  ? "border-primary bg-primary/5" 
                  : "border-muted-foreground/25 hover:border-muted-foreground/50"
              )}
              onDragOver={handleDragOver}
              onDragLeave={handleDragLeave}
              onDrop={handleDrop}
            >
              <FileSpreadsheet className="mx-auto h-12 w-12 text-muted-foreground mb-4" />
              <div className="space-y-2">
                <p className="text-lg font-medium">
                  Arrastra tu archivo aquí o haz clic para seleccionar
                </p>
                <p className="text-sm text-muted-foreground">
                  Archivos soportados: CSV, Excel (.xlsx, .xls)
                </p>
                <Button 
                  onClick={() => fileInputRef.current?.click()}
                  disabled={isUploading}
                  className="mt-4"
                >
                  <Upload className="mr-2 h-4 w-4" />
                  Seleccionar Archivo
                </Button>
                <Input
                  ref={fileInputRef}
                  type="file"
                  accept=".csv,.xlsx,.xls"
                  onChange={handleFileInputChange}
                  className="hidden"
                />
              </div>
            </div>
          ) : (
            // File Preview
            <div className="space-y-4">
              <div className="flex items-center justify-between p-4 bg-muted rounded-lg">
                <div className="flex items-center gap-3">
                  <FileText className="h-8 w-8 text-blue-600" />
                  <div>
                    <p className="font-medium">{filePreview?.name}</p>
                    <p className="text-sm text-muted-foreground">
                      {filePreview?.size} • {filePreview?.type}
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  {hasData && (
                    <Badge variant="secondary" className="bg-green-100 text-green-800">
                      <CheckCircle className="mr-1 h-3 w-3" />
                      {parsedData.length} filas
                    </Badge>
                  )}
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={clearFile}
                    disabled={isUploading || isParsing}
                  >
                    <X className="h-4 w-4" />
                  </Button>
                </div>
              </div>
              
              {/* Upload Progress */}
              {(isUploading || isParsing) && (
                <div className="space-y-2">
                  <div className="flex justify-between text-sm">
                    <span>
                      {isParsing ? 'Procesando datos...' : 'Subiendo archivo...'}
                    </span>
                    <span>{uploadProgress}%</span>
                  </div>
                  <Progress value={uploadProgress} className="h-2" />
                </div>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Parsing Errors */}
      {hasErrors && (
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertTitle>Errores de Validación</AlertTitle>
          <AlertDescription>
            <div className="mt-2 space-y-1">
              {parsingErrors.map((error, index) => (
                <div key={index} className="text-sm">
                  • {error}
                </div>
              ))}
            </div>
          </AlertDescription>
        </Alert>
      )}

      {/* Success Summary */}
      {hasData && !hasErrors && (
        <div className="space-y-4">
          <Card>
            <CardContent className="pt-6">
              <div className="flex items-center gap-4">
                <div className="p-2 bg-green-100 rounded-full">
                  <CheckCircle className="h-6 w-6 text-green-600" />
                </div>
                <div className="flex-1">
                  <p className="font-medium text-green-900">
                    Archivo procesado exitosamente
                  </p>
                  <p className="text-sm text-green-700">
                    {parsedData.length} registros listos para procesamiento
                  </p>
                </div>
                <div className="text-right">
                  <div className="text-2xl font-bold text-green-600">
                    {parsedData.length}
                  </div>
                  <div className="text-xs text-muted-foreground">filas</div>
                </div>
              </div>
            </CardContent>
          </Card>

          <DieselPreviewEnhanced fileName={filePreview?.name || undefined} />
        </div>
      )}

      {/* Expected Format Info */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-sm">
            <Info className="h-4 w-4" />
            Formato Esperado
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 gap-4 text-xs">
            <div>
              <p className="font-medium mb-2">Columnas Obligatorias:</p>
              <ul className="space-y-1 text-muted-foreground">
                {EXPECTED_COLUMNS.filter(col => col.required).map(col => (
                  <li key={col.key}>• {col.label}</li>
                ))}
              </ul>
            </div>
            <div>
              <p className="font-medium mb-2">Columnas Opcionales:</p>
              <ul className="space-y-1 text-muted-foreground">
                {EXPECTED_COLUMNS.filter(col => !col.required).slice(0, 8).map(col => (
                  <li key={col.key}>• {col.label}</li>
                ))}
              </ul>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
