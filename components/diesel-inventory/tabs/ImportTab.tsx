"use client"

import { useState, useCallback } from 'react'
import { Card, CardContent } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Progress } from "@/components/ui/progress"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Separator } from "@/components/ui/separator"
import { 
  Upload, 
  Eye, 
  ArrowRight, 
  CheckCircle,
  AlertTriangle,
  Database,
  FileSpreadsheet,
  Settings,
  Play
} from "lucide-react"
import { ExcelUploader } from '../migration/ExcelUploader'
import { DataPreview } from '../migration/DataPreview'
import { useDieselStore } from '@/store/diesel-store'
import { DieselExcelRow } from '@/types/diesel'

interface ImportTabProps {
  productType: 'diesel' | 'urea'
  onProceedToMapping?: () => void
  onProceedToProcessing?: () => void
}

type ImportStep = 'upload' | 'preview' | 'ready'

export function ImportTab({ productType, onProceedToMapping, onProceedToProcessing }: ImportTabProps) {
  const {
    uploadedFile,
    parsedData,
    parsingErrors,
    isUploading,
    isParsing,
    processingStatus,
    currentBatch,
    validateExcelData
  } = useDieselStore()
  
  const [currentStep, setCurrentStep] = useState<ImportStep>('upload')

  // Determine current step based on state
  const determineStep = useCallback((): ImportStep => {
    if (parsedData.length > 0) {
      const validation = validateExcelData(parsedData)
      return validation.isValid ? 'ready' : 'preview'
    }
    if (uploadedFile) return 'preview'
    return 'upload'
  }, [parsedData, uploadedFile, validateExcelData])

  const actualStep = determineStep()

  // Step definitions
  const steps = [
    {
      id: 'upload',
      title: 'Subir Archivo',
      description: 'Selecciona el archivo Excel/CSV del sistema legacy',
      icon: Upload,
      status: uploadedFile ? 'completed' : actualStep === 'upload' ? 'active' : 'pending'
    },
    {
      id: 'preview',
      title: 'Revisar Datos',
      description: 'Verifica la información importada y corrige errores',
      icon: Eye,
      status: parsedData.length > 0 ? 'completed' : actualStep === 'preview' ? 'active' : 'pending'
    },
    {
      id: 'ready',
      title: 'Listo para Procesar',
      description: 'Datos validados y listos para mapeo de activos',
      icon: CheckCircle,
      status: actualStep === 'ready' ? 'completed' : 'pending'
    }
  ]

  // Handle file parsed
  const handleDataParsed = useCallback((data: DieselExcelRow[]) => {
    setCurrentStep('preview')
  }, [])

  // Handle batch created
  const handleBatchCreated = useCallback((batchId: string) => {
    console.log('Batch created:', batchId)
  }, [])

  // Handle proceed to mapping
  const handleProceedToMapping = useCallback(() => {
    onProceedToMapping?.()
  }, [onProceedToMapping])

  // Handle proceed to processing
  const handleProceedToProcessing = useCallback(() => {
    onProceedToProcessing?.()
  }, [onProceedToProcessing])

  // Validation summary
  const validationSummary = parsedData.length > 0 ? validateExcelData(parsedData) : null

  return (
    <div className="space-y-6">
      {/* Process Steps */}
      <Card>
        <CardContent className="pt-6">
          <div className="flex items-center justify-between">
            {steps.map((step, index) => {
              const StepIcon = step.icon
              const isActive = step.status === 'active'
              const isCompleted = step.status === 'completed'
              
              return (
                <div key={step.id} className="flex items-center">
                  {/* Step Icon */}
                  <div className={`
                    flex items-center justify-center w-10 h-10 rounded-full border-2 transition-colors
                    ${isCompleted ? 'bg-green-100 border-green-500' : 
                      isActive ? 'bg-blue-100 border-blue-500' : 
                      'bg-gray-100 border-gray-300'}
                  `}>
                    <StepIcon className={`
                      w-5 h-5
                      ${isCompleted ? 'text-green-600' :
                        isActive ? 'text-blue-600' :
                        'text-gray-400'}
                    `} />
                  </div>
                  
                  {/* Step Content */}
                  <div className="ml-3">
                    <div className={`
                      font-medium text-sm
                      ${isCompleted ? 'text-green-900' :
                        isActive ? 'text-blue-900' :
                        'text-gray-500'}
                    `}>
                      {step.title}
                    </div>
                    <div className="text-xs text-muted-foreground">
                      {step.description}
                    </div>
                  </div>
                  
                  {/* Arrow */}
                  {index < steps.length - 1 && (
                    <ArrowRight className="w-4 h-4 text-gray-400 mx-4" />
                  )}
                </div>
              )
            })}
          </div>
        </CardContent>
      </Card>

      {/* Progress Indicators */}
      {(isUploading || isParsing) && (
        <Card>
          <CardContent className="pt-6">
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <div className="animate-spin">
                    <FileSpreadsheet className="w-4 h-4" />
                  </div>
                  <span className="font-medium">
                    {isParsing ? 'Procesando datos...' : 'Subiendo archivo...'}
                  </span>
                </div>
                <Badge variant="secondary">
                  En progreso
                </Badge>
              </div>
              <Progress value={50} className="h-2" />
            </div>
          </CardContent>
        </Card>
      )}

      {/* Current Batch Status */}
      {currentBatch && (
        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center justify-between">
              <div>
                <div className="font-medium">Lote Actual: {currentBatch.batch_id}</div>
                <div className="text-sm text-muted-foreground">
                  Archivo: {currentBatch.original_filename} • {currentBatch.total_rows} registros
                </div>
              </div>
              <Badge 
                variant={
                  currentBatch.status === 'completed' ? 'default' :
                  currentBatch.status === 'uploading' ? 'secondary' :
                  currentBatch.status === 'failed' ? 'destructive' :
                  'secondary'
                }
              >
                {currentBatch.status}
              </Badge>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Validation Results Summary */}
      {validationSummary && (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <Card>
            <CardContent className="p-4">
              <div className="flex items-center gap-2">
                <CheckCircle className="h-4 w-4 text-green-600" />
                <div>
                  <div className="text-lg font-bold">
                    {parsedData.length - validationSummary.errors.length}
                  </div>
                  <div className="text-xs text-muted-foreground">Registros Válidos</div>
                </div>
              </div>
            </CardContent>
          </Card>
          
          {validationSummary.warnings.length > 0 && (
            <Card>
              <CardContent className="p-4">
                <div className="flex items-center gap-2">
                  <AlertTriangle className="h-4 w-4 text-yellow-600" />
                  <div>
                    <div className="text-lg font-bold text-yellow-600">
                      {validationSummary.warnings.length}
                    </div>
                    <div className="text-xs text-muted-foreground">Advertencias</div>
                  </div>
                </div>
              </CardContent>
            </Card>
          )}
          
          {validationSummary.errors.length > 0 && (
            <Card>
              <CardContent className="p-4">
                <div className="flex items-center gap-2">
                  <AlertTriangle className="h-4 w-4 text-red-600" />
                  <div>
                    <div className="text-lg font-bold text-red-600">
                      {validationSummary.errors.length}
                    </div>
                    <div className="text-xs text-muted-foreground">Errores</div>
                  </div>
                </div>
              </CardContent>
            </Card>
          )}
        </div>
      )}

      {/* Error Messages */}
      {parsingErrors.length > 0 && (
        <Alert variant="destructive">
          <AlertTriangle className="h-4 w-4" />
          <AlertTitle>Errores de Importación</AlertTitle>
          <AlertDescription>
            <div className="mt-2 space-y-1">
              {parsingErrors.slice(0, 3).map((error, index) => (
                <div key={index} className="text-sm">• {error}</div>
              ))}
              {parsingErrors.length > 3 && (
                <div className="text-sm text-muted-foreground">
                  ... y {parsingErrors.length - 3} errores más
                </div>
              )}
            </div>
          </AlertDescription>
        </Alert>
      )}

      <Separator />

      {/* Main Content Area */}
      <div className="space-y-6">
        {/* Step 1: File Upload */}
        {actualStep === 'upload' && (
          <ExcelUploader
            productType={productType}
            onDataParsed={handleDataParsed}
            onBatchCreated={handleBatchCreated}
          />
        )}

        {/* Step 2: Data Preview */}
        {(actualStep === 'preview' || actualStep === 'ready') && parsedData.length > 0 && (
          <DataPreview onProceedToMapping={handleProceedToMapping} />
        )}
      </div>

      {/* Action Buttons */}
      {actualStep === 'ready' && validationSummary?.isValid && (
        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center justify-between">
              <div>
                <div className="font-medium text-green-900">
                  Datos listos para procesamiento
                </div>
                <div className="text-sm text-muted-foreground">
                  {parsedData.length} registros validados correctamente
                </div>
              </div>
              <div className="flex gap-2">
                <Button variant="outline" onClick={handleProceedToMapping}>
                  <Settings className="mr-2 h-4 w-4" />
                  Mapear Activos
                </Button>
                <Button onClick={handleProceedToProcessing}>
                  <Play className="mr-2 h-4 w-4" />
                  Procesar Directamente
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Development Info */}
      {process.env.NODE_ENV === 'development' && (
        <Card className="border-dashed">
          <CardContent className="pt-6">
            <div className="text-xs text-muted-foreground space-y-2">
              <div><strong>Debug Info:</strong></div>
              <div>Step: {actualStep}</div>
              <div>File: {uploadedFile?.name || 'None'}</div>
              <div>Parsed rows: {parsedData.length}</div>
              <div>Errors: {parsingErrors.length}</div>
              <div>Processing status: {processingStatus}</div>
              {currentBatch && (
                <div>Batch: {currentBatch.batch_id} ({currentBatch.status})</div>
              )}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  )
}
