"use client"

import { useState, useEffect, useCallback, useMemo } from 'react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Badge } from "@/components/ui/badge"
import { Progress } from "@/components/ui/progress"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Separator } from "@/components/ui/separator"
import { Textarea } from "@/components/ui/textarea"
import { 
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { 
  Settings,
  Search,
  CheckCircle,
  AlertTriangle,
  ExternalLink,
  MapPin,
  Truck,
  Building,
  Plus,
  Save,
  RotateCcw,
  Zap,
  Target,
  Filter,
  Info
} from "lucide-react"
import { cn } from "@/lib/utils"
import { useDieselStore } from '@/store/diesel-store'
import { createClient } from '@/lib/supabase'
import { 
  AssetMappingEntry, 
  AssetResolution
} from '@/types/diesel'

// Local type definitions
interface AssetMappingSuggestion {
  asset_id: string
  asset_name: string
  similarity_score: number
  asset_type: string
  plant_name: string
  last_used: string | null
}

type AssetCategory = 'formal' | 'exception' | 'general' | 'ignore'

interface AssetMapperProps {
  onMappingComplete?: () => void
  onProceedToProcessing?: () => void
}

interface FormalAsset {
  id: string
  name: string
  code: string
  plant_name: string
  category: string
  status: string
}

interface MappingDecision {
  originalName: string
  decision: 'formal' | 'exception' | 'general' | 'ignore'
  targetAssetId?: string
  targetAssetName?: string
  exceptionDetails?: {
    assetType: 'partner' | 'rental' | 'utility' | 'unknown'
    description: string
    ownerInfo?: string
  }
  confidence: number
  notes?: string
}

export function AssetMapper({ onMappingComplete, onProceedToProcessing }: AssetMapperProps) {
  const {
    parsedData,
    unmappedAssets,
    pendingMappings,
    setUnmappedAssets,
    addPendingMapping,
    removePendingMapping,
    setMappingProgress,
    submitAssetMappings,
    addNotification,
    addError
  } = useDieselStore()

  // Local state
  const [isLoading, setIsLoading] = useState(false)
  const [formalAssets, setFormalAssets] = useState<FormalAsset[]>([])
  const [searchTerm, setSearchTerm] = useState('')
  const [filterStatus, setFilterStatus] = useState<'all' | 'pending' | 'mapped'>('all')
  const [selectedAsset, setSelectedAsset] = useState<string | null>(null)
  const [isDialogOpen, setIsDialogOpen] = useState(false)
  const [currentMapping, setCurrentMapping] = useState<MappingDecision | null>(null)
  const [assetListSearch, setAssetListSearch] = useState('')
  
  // Derive mappingDecisions from store's pendingMappings to avoid state sync issues
  const mappingDecisions = useMemo(() => {
    const decisions = new Map<string, MappingDecision>()
    for (const [name, resolution] of pendingMappings.entries()) {
      decisions.set(name, {
        originalName: name,
        decision: resolution.resolution_type === 'formal' ? 'formal' :
                 resolution.resolution_type === 'exception' ? 'exception' :
                 resolution.resolution_type === 'general' ? 'general' : 'ignore',
        targetAssetId: resolution.asset_id || undefined,
        targetAssetName: resolution.asset_name || undefined,
        exceptionDetails: resolution.exception_asset_name ? {
          assetType: 'unknown',
          description: resolution.exception_asset_name
        } : undefined,
        confidence: resolution.confidence,
        notes: resolution.mapping_notes || undefined
      })
    }
    return decisions
  }, [pendingMappings])
  
  // Manual list filter for formal assets in dialog
  const filteredFormalAssets = useMemo(() => {
    const term = assetListSearch.trim().toLowerCase()
    if (!term) return formalAssets
    return formalAssets.filter(a =>
      a.name.toLowerCase().includes(term) ||
      a.code.toLowerCase().includes(term) ||
      a.plant_name.toLowerCase().includes(term)
    )
  }, [formalAssets, assetListSearch])
  
  // Extract unique asset names from parsed data
  const uniqueAssetNames = useMemo(() => {
    const names = new Set<string>()
    parsedData.forEach(row => {
      if (row.unidad?.trim()) {
        names.add(row.unidad.trim())
      }
    })
    return Array.from(names).map(name => ({
      name,
      occurrences: parsedData.filter(row => row.unidad?.trim() === name).length,
      totalLiters: parsedData
        .filter(row => row.unidad?.trim() === name)
        .reduce((sum, row) => sum + (parseFloat(String(row.litros_cantidad)) || 0), 0)
    })).sort((a, b) => b.occurrences - a.occurrences)
  }, [parsedData])

  // Filter assets based on search and status
  const filteredAssets = useMemo(() => {
    let filtered = uniqueAssetNames

    if (searchTerm.trim()) {
      const term = searchTerm.toLowerCase()
      filtered = filtered.filter(asset => 
        asset.name.toLowerCase().includes(term)
      )
    }

    if (filterStatus !== 'all') {
      filtered = filtered.filter(asset => {
        const hasDecision = mappingDecisions.has(asset.name)
        return filterStatus === 'mapped' ? hasDecision : !hasDecision
      })
    }

    return filtered
  }, [uniqueAssetNames, searchTerm, filterStatus, mappingDecisions])

  // Load formal assets from database
  const loadFormalAssets = useCallback(async () => {
    try {
      setIsLoading(true)
      const supabase = createClient()
      
      const { data: assets, error } = await supabase
        .from('assets')
        .select('*')
        .or('status.eq.active,status.eq.operational,status.eq.operating,status.eq.operacional')
        .order('name')

      if (error) throw error

      const assetRows = assets || []

      let enrichedAssets = assetRows

      // Attempt to fetch plant information, but allow failure without blocking the list
      const plantIds = Array.from(new Set(assetRows.map(asset => asset.plant_id).filter(Boolean))) as string[]
      if (plantIds.length > 0) {
        const { data: plantData, error: plantError } = await supabase
          .from('plants')
          .select('id, name, code')
          .in('id', plantIds)

        if (plantError) {
          console.warn('AssetMapper: failed to load plants', plantError)
        } else {
          const plantLookup = new Map<string, { name: string; code: string }>()
          ;(plantData || []).forEach((plant: any) => {
            if (plant?.id) plantLookup.set(plant.id, { name: plant.name, code: plant.code })
          })
      enrichedAssets = enrichedAssets.map(asset => ({
        ...asset,
        plant_name: asset.plant_id ? plantLookup.get(asset.plant_id)?.name || 'Sin planta' : 'Sin planta'
      }))
        }
      }

      // Attempt to fetch model information, also optional
      const modelIds = Array.from(new Set(assetRows.map(asset => asset.model_id).filter(Boolean))) as string[]
      if (modelIds.length > 0) {
        const { data: modelData, error: modelError } = await supabase
          .from('equipment_models')
          .select('id, name, category')
          .in('id', modelIds)

        if (modelError) {
          console.warn('AssetMapper: failed to load equipment models', modelError)
        } else {
          const modelLookup = new Map<string, { name: string; category: string }>()
          ;(modelData || []).forEach((model: any) => {
            if (model?.id) modelLookup.set(model.id, { name: model.name, category: model.category })
          })
          enrichedAssets = enrichedAssets.map(asset => ({
            ...asset,
            category: asset.model_id ? modelLookup.get(asset.model_id)?.category || 'Sin categoría' : 'Sin categoría'
          }))
        }
      }

      const formattedAssets: FormalAsset[] = enrichedAssets.map(asset => ({
        id: asset.id,
        name: asset.name,
    // Use the correct column from DB: assets.asset_id is the formal code
    code: asset.asset_id || '',
        plant_name: (asset as any).plant_name || 'Sin planta',
        category: (asset as any).category || 'Sin categoría',
        status: asset.status || 'desconocido'
      }))
      
      setFormalAssets(formattedAssets)
      
    } catch (error) {
      addError({
        id: `load-assets-error-${Date.now()}`,
        batch_id: '',
        row_number: 0,
        error_type: 'database',
        error_message: error instanceof Error ? error.message : 'Failed to load formal assets',
        field_name: null,
        suggested_fix: 'Check database connection',
        severity: 'error',
        resolved: false,
        resolved_at: null,
        resolved_by: null
      })
    } finally {
      setIsLoading(false)
    }
  }, [addError])

  // Helper function to detect if an asset name is an adjustment entry
  const isAdjustmentEntry = useCallback((assetName: string): boolean => {
    const normalized = assetName.toLowerCase().trim()
    const adjustmentKeywords = [
      'ajuste',
      'ajustes',
      'adjustment',
      'validacion',
      'validación',
      'fisico',
      'físico',
      'corrección',
      'correccion',
      'inventario'
    ]
    return adjustmentKeywords.some(keyword => normalized.includes(keyword))
  }, [])

  // Get asset suggestions using fuzzy matching
  const getAssetSuggestions = useCallback((assetName: string): AssetMappingSuggestion[] => {
    if (!assetName.trim()) return []
    
    // Check if this is an adjustment entry - no suggestions needed
    if (isAdjustmentEntry(assetName)) {
      return []
    }
    
    const suggestions: AssetMappingSuggestion[] = []
    const searchTerm = assetName.toLowerCase()
    
    formalAssets.forEach(asset => {
      const assetNameLower = asset.name.toLowerCase()
      const assetCodeLower = asset.code.toLowerCase()
      
      // Simple similarity score calculation
      let score = 0
      
      // Exact match
      if (assetNameLower === searchTerm || assetCodeLower === searchTerm) {
        score = 1.0
      }
      // Contains match
      else if (assetNameLower.includes(searchTerm) || searchTerm.includes(assetNameLower)) {
        score = 0.8
      }
      // Word overlap
      else {
        const searchWords = searchTerm.split(/\s+/)
        const assetWords = assetNameLower.split(/\s+/)
        const commonWords = searchWords.filter(word => assetWords.some(assetWord => 
          assetWord.includes(word) || word.includes(assetWord)
        ))
        score = commonWords.length / Math.max(searchWords.length, assetWords.length) * 0.6
      }
      
      if (score > 0.3) { // Minimum threshold
        suggestions.push({
          asset_id: asset.id,
          asset_name: asset.name,
          similarity_score: score,
          asset_type: asset.category,
          plant_name: asset.plant_name,
          last_used: null // Would come from usage data
        })
      }
    })
    
    return suggestions
      .sort((a, b) => b.similarity_score - a.similarity_score)
      .slice(0, 5) // Top 5 suggestions
  }, [formalAssets, isAdjustmentEntry])

  // Open mapping dialog
  const openMappingDialog = useCallback((assetName: string) => {
    // Normalize the asset name (trim) to match how it's stored
    const normalizedName = assetName.trim()
    const existing = mappingDecisions.get(normalizedName)
    const suggestions = getAssetSuggestions(normalizedName)
    const isAdjustment = isAdjustmentEntry(normalizedName)
    
    // Auto-classify adjustments as "general" (inventory adjustments)
    if (isAdjustment && !existing) {
      setCurrentMapping({
        originalName: normalizedName, // Use normalized name
        decision: 'general',
        confidence: 0.95,
        notes: 'Ajuste de inventario detectado automáticamente',
        exceptionDetails: {
          assetType: 'utility',
          description: `Ajuste de inventario: ${normalizedName}`
        }
      })
    } else {
      setCurrentMapping(existing || {
        originalName: normalizedName, // Use normalized name
        decision: suggestions.length > 0 && suggestions[0].similarity_score > 0.8 ? 'formal' : 'exception',
        confidence: 0.7,
        targetAssetId: suggestions.length > 0 && suggestions[0].similarity_score > 0.8 ? suggestions[0].asset_id : undefined,
        targetAssetName: suggestions.length > 0 && suggestions[0].similarity_score > 0.8 ? suggestions[0].asset_name : undefined,
        exceptionDetails: {
          assetType: 'unknown',
          description: `Activo externo: ${normalizedName}`
        }
      })
    }
    setSelectedAsset(normalizedName)
    setIsDialogOpen(true)
  }, [mappingDecisions, getAssetSuggestions, isAdjustmentEntry])

  // Save mapping decision
  const saveMappingDecision = useCallback(() => {
    if (!currentMapping) return
    
    // Normalize the asset name (trim) to match how it's stored in uniqueAssetNames
    const normalizedName = currentMapping.originalName.trim()
    
    // Add to pending mappings in store (use normalized name)
    // The UI will automatically update since mappingDecisions is derived from pendingMappings
    const resolution: AssetResolution = {
      resolution_type: currentMapping.decision === 'general' ? 'general' : 
                      currentMapping.decision === 'formal' ? 'formal' : 
                      currentMapping.decision === 'ignore' ? 'unmapped' : 'exception',
      asset_id: currentMapping.targetAssetId || null,
      exception_asset_id: null, // Will be created during processing
      asset_name: currentMapping.targetAssetName || null,
      exception_asset_name: currentMapping.exceptionDetails?.description || null,
      confidence: currentMapping.confidence,
      created_new: false,
      mapping_notes: currentMapping.notes || null,
      original_name: normalizedName,
      asset_category: currentMapping.decision === 'formal' ? 'formal' :
                     currentMapping.decision === 'exception' ? 'exception' :
                     currentMapping.decision === 'general' ? 'general' : null
    }
    
    addPendingMapping(normalizedName, resolution)
    
    setIsDialogOpen(false)
    setCurrentMapping(null)
    setSelectedAsset(null)
    
    // Update progress based on store's pendingMappings (will be +1 after this save)
    const totalAssets = uniqueAssetNames.length
    const mappedAssets = pendingMappings.size + 1 // +1 for the one we just added
    setMappingProgress((mappedAssets / totalAssets) * 100)
  }, [currentMapping, addPendingMapping, uniqueAssetNames.length, setMappingProgress, pendingMappings.size])

  // Auto-map high confidence matches
  const autoMapHighConfidence = useCallback(async () => {
    setIsLoading(true)
    let autoMapped = 0
    
    try {
      for (const asset of uniqueAssetNames) {
        if (pendingMappings.has(asset.name)) continue // Already mapped
        
        const suggestions = getAssetSuggestions(asset.name)
        const bestMatch = suggestions[0]
        
        if (bestMatch && bestMatch.similarity_score >= 0.9) {
          const resolution: AssetResolution = {
            resolution_type: 'formal',
            asset_id: bestMatch.asset_id,
            exception_asset_id: null,
            asset_name: bestMatch.asset_name,
            exception_asset_name: null,
            confidence: bestMatch.similarity_score,
            created_new: false,
            mapping_notes: 'Auto-mapped based on high similarity',
            original_name: asset.name,
            asset_category: 'formal'
          }
          
          addPendingMapping(asset.name, resolution)
          autoMapped++
        }
      }
      
      // Update progress (UI will auto-update since mappingDecisions derives from pendingMappings)
      const totalAssets = uniqueAssetNames.length
      const mappedAssets = pendingMappings.size + autoMapped
      setMappingProgress((mappedAssets / totalAssets) * 100)
      
      if (autoMapped > 0) {
        addNotification({
          type: 'success',
          title: 'Auto-mapping Complete',
          message: `Automatically mapped ${autoMapped} high-confidence matches`
        })
      } else {
        addNotification({
          type: 'info',
          title: 'No Auto-mappings Found',
          message: 'No high-confidence automatic mappings available'
        })
      }
      
    } catch (error) {
      addError({
        id: `auto-map-error-${Date.now()}`,
        batch_id: '',
        row_number: 0,
        error_type: 'validation',
        error_message: error instanceof Error ? error.message : 'Auto-mapping failed',
        field_name: null,
        suggested_fix: 'Try manual mapping instead',
        severity: 'warning',
        resolved: false,
        resolved_at: null,
        resolved_by: null
      })
    } finally {
      setIsLoading(false)
    }
  }, [pendingMappings, uniqueAssetNames, getAssetSuggestions, addPendingMapping, setMappingProgress, addNotification, addError])

  // Submit all mappings
  const handleSubmitMappings = useCallback(async () => {
    if (mappingDecisions.size === 0) {
      addNotification({
        type: 'warning',
        title: 'No Mappings to Submit',
        message: 'Please map at least one asset before proceeding'
      })
      return
    }
    
    try {
      setIsLoading(true)
      const success = await submitAssetMappings()
      
      if (success) {
        addNotification({
          type: 'success',
          title: 'Mappings Submitted',
          message: 'Asset mappings have been saved successfully'
        })
        onMappingComplete?.()
      }
    } catch (error) {
      addError({
        id: `submit-error-${Date.now()}`,
        batch_id: '',
        row_number: 0,
        error_type: 'database',
        error_message: error instanceof Error ? error.message : 'Failed to submit mappings',
        field_name: null,
        suggested_fix: 'Check database connection and try again',
        severity: 'error',
        resolved: false,
        resolved_at: null,
        resolved_by: null
      })
    } finally {
      setIsLoading(false)
    }
  }, [mappingDecisions.size, submitAssetMappings, onMappingComplete, addNotification, addError])

  // Initialize data on mount
  useEffect(() => {
    loadFormalAssets()
  }, [loadFormalAssets])
  
  // Note: Mappings are managed in local state (mappingDecisions) and synced to store when saved
  // The store's pendingMappings is used during processing, not for UI state

  const mappingProgress = uniqueAssetNames.length > 0 ? (mappingDecisions.size / uniqueAssetNames.length) * 100 : 0
  const isComplete = mappingDecisions.size === uniqueAssetNames.length

  if (uniqueAssetNames.length === 0) {
    return (
      <Card>
        <CardContent className="flex items-center justify-center h-64">
          <div className="text-center space-y-2">
            <Settings className="h-12 w-12 text-muted-foreground mx-auto" />
            <p className="text-muted-foreground">No hay activos para mapear</p>
            <p className="text-sm text-muted-foreground">Sube y procesa un archivo Excel primero</p>
          </div>
        </CardContent>
      </Card>
    )
  }

  return (
    <div className="space-y-6">
      {/* Progress and Actions */}
      <Card>
        <CardContent className="pt-6">
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <h3 className="font-medium">Progreso de Mapeo</h3>
                <p className="text-sm text-muted-foreground">
                  {mappingDecisions.size} de {uniqueAssetNames.length} activos mapeados
                </p>
              </div>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  onClick={autoMapHighConfidence}
                  disabled={isLoading}
                >
                  <Zap className="mr-2 h-4 w-4" />
                  Auto-mapear
                </Button>
                <Button
                  onClick={handleSubmitMappings}
                  disabled={isLoading || mappingDecisions.size === 0}
                >
                  <Save className="mr-2 h-4 w-4" />
                  Guardar Mapeos
                </Button>
              </div>
            </div>
            
            <Progress value={mappingProgress} className="h-2" />
            
            {isComplete && (
              <Alert>
                <CheckCircle className="h-4 w-4" />
                <AlertTitle>Mapeo Completo</AlertTitle>
                <AlertDescription>
                  Todos los activos han sido mapeados. Procede al procesamiento de datos.
                </AlertDescription>
              </Alert>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Mapping Statistics */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {(['formal', 'exception', 'general', 'ignore'] as const).map((type) => {
          const count = Array.from(mappingDecisions.values()).filter(d => d.decision === type).length
          const icons = {
            formal: Target,
            exception: ExternalLink,
            general: Building,
            ignore: AlertTriangle
          }
          const colors = {
            formal: 'text-green-600',
            exception: 'text-blue-600',
            general: 'text-purple-600',
            ignore: 'text-gray-600'
          }
          const labels = {
            formal: 'Formales',
            exception: 'Excepciones',
            general: 'Generales',
            ignore: 'Ignorados'
          }
          
          const Icon = icons[type]
          
          return (
            <Card key={type}>
              <CardContent className="p-4">
                <div className="flex items-center gap-2">
                  <Icon className={`h-4 w-4 ${colors[type]}`} />
                  <div>
                    <div className="text-2xl font-bold">{count}</div>
                    <div className="text-xs text-muted-foreground">{labels[type]}</div>
                  </div>
                </div>
              </CardContent>
            </Card>
          )
        })}
      </div>

      {/* Filters and Search */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Filter className="h-5 w-5" />
            Filtros
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div className="space-y-2">
              <Label htmlFor="search">Buscar Activo</Label>
              <div className="relative">
                <Search className="absolute left-2 top-2.5 h-4 w-4 text-muted-foreground" />
                <Input
                  id="search"
                  placeholder="Nombre del activo..."
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                  className="pl-8"
                />
              </div>
            </div>
            
            <div className="space-y-2">
              <Label>Estado</Label>
              <Select value={filterStatus} onValueChange={(value: any) => setFilterStatus(value)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Todos</SelectItem>
                  <SelectItem value="pending">Pendientes</SelectItem>
                  <SelectItem value="mapped">Mapeados</SelectItem>
                </SelectContent>
              </Select>
            </div>
            
            <div className="flex items-end gap-2">
              <Button
                variant="outline"
                onClick={() => {
                  setSearchTerm('')
                  setFilterStatus('all')
                }}
              >
                <RotateCcw className="mr-2 h-4 w-4" />
                Limpiar
              </Button>
              <Button
                variant="secondary"
                onClick={() => {
                  // Auto-map all adjustments as "general"
                  let count = 0
                  filteredAssets.forEach(asset => {
                    if (isAdjustmentEntry(asset.name) && !pendingMappings.has(asset.name)) {
                      const resolution: AssetResolution = {
                        resolution_type: 'general',
                        asset_id: null,
                        exception_asset_id: null,
                        asset_name: null,
                        exception_asset_name: `Ajuste de inventario: ${asset.name}`,
                        confidence: 0.95,
                        created_new: false,
                        mapping_notes: 'Ajuste de inventario detectado automáticamente',
                        original_name: asset.name,
                        asset_category: 'general'
                      }
                      addPendingMapping(asset.name, resolution)
                      count++
                    }
                  })
                  // Update progress
                  const totalAssets = uniqueAssetNames.length
                  const mappedAssets = pendingMappings.size + count
                  setMappingProgress((mappedAssets / totalAssets) * 100)
                  addNotification({
                    title: 'Ajustes Mapeados',
                    message: `${count} ajustes de inventario clasificados automáticamente`,
                    type: 'info'
                  })
                }}
                className="bg-amber-100 hover:bg-amber-200 text-amber-800"
              >
                <Zap className="mr-2 h-4 w-4" />
                Mapear Ajustes
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Assets Table */}
      <Card>
        <CardHeader>
          <CardTitle>Activos para Mapear</CardTitle>
          <CardDescription>
            Haz clic en "Mapear" para asignar cada activo del archivo legacy
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Nombre del Activo</TableHead>
                  <TableHead>Ocurrencias</TableHead>
                  <TableHead>Total Litros</TableHead>
                  <TableHead>Estado</TableHead>
                  <TableHead>Acciones</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filteredAssets.map((asset) => {
                  const decision = mappingDecisions.get(asset.name)
                  const suggestions = getAssetSuggestions(asset.name)
                  const bestMatch = suggestions[0]
                  const isAdjustment = isAdjustmentEntry(asset.name)
                  
                  return (
                    <TableRow key={asset.name}>
                      <TableCell className="font-medium">
                        <div className="space-y-1">
                          <div className="flex items-center gap-2">
                            <span>{asset.name}</span>
                            {isAdjustment && (
                              <Badge variant="outline" className="bg-amber-50 text-amber-700 text-xs">
                                Ajuste
                              </Badge>
                            )}
                          </div>
                          {!isAdjustment && bestMatch && (
                            <div className="text-xs text-muted-foreground">
                              Sugerencia: {bestMatch.asset_name} ({Math.round(bestMatch.similarity_score * 100)}%)
                            </div>
                          )}
                          {isAdjustment && (
                            <div className="text-xs text-amber-600">
                              Se clasificará como activo general (ajuste de inventario)
                            </div>
                          )}
                        </div>
                      </TableCell>
                      
                      <TableCell>
                        <Badge variant="secondary">
                          {asset.occurrences}
                        </Badge>
                      </TableCell>
                      
                      <TableCell className="font-mono">
                        {asset.totalLiters.toFixed(2)} L
                      </TableCell>
                      
                      <TableCell>
                        {decision ? (
                          <Badge 
                            variant="secondary"
                            className={cn(
                              decision.decision === 'formal' && "bg-green-100 text-green-800",
                              decision.decision === 'exception' && "bg-blue-100 text-blue-800",
                              decision.decision === 'general' && "bg-purple-100 text-purple-800",
                              decision.decision === 'ignore' && "bg-gray-100 text-gray-800"
                            )}
                          >
                            <CheckCircle className="mr-1 h-3 w-3" />
                            {decision.decision === 'formal' && 'Formal'}
                            {decision.decision === 'exception' && 'Excepción'}
                            {decision.decision === 'general' && 'General'}
                            {decision.decision === 'ignore' && 'Ignorado'}
                          </Badge>
                        ) : (
                          <Badge variant="outline">
                            <AlertTriangle className="mr-1 h-3 w-3" />
                            Pendiente
                          </Badge>
                        )}
                      </TableCell>
                      
                      <TableCell>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => openMappingDialog(asset.name)}
                        >
                          <MapPin className="mr-1 h-3 w-3" />
                          {decision ? 'Editar' : 'Mapear'}
                        </Button>
                      </TableCell>
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
            
            {filteredAssets.length === 0 && (
              <div className="flex items-center justify-center h-32">
                <p className="text-muted-foreground">No se encontraron activos con los filtros actuales</p>
              </div>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Mapping Dialog */}
      <Dialog open={isDialogOpen} onOpenChange={setIsDialogOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Mapear Activo: {currentMapping?.originalName}</DialogTitle>
            <DialogDescription>
              Selecciona cómo manejar este activo en el sistema
            </DialogDescription>
          </DialogHeader>
          
          {currentMapping && (
            <div className="space-y-6">
              {/* Adjustment Detection Alert */}
              {currentMapping && isAdjustmentEntry(currentMapping.originalName) && (
                <Alert className="bg-amber-50 border-amber-200">
                  <Info className="h-4 w-4 text-amber-600" />
                  <AlertTitle className="text-amber-900">Ajuste de Inventario Detectado</AlertTitle>
                  <AlertDescription className="text-amber-700">
                    Este registro parece ser un ajuste de inventario y se clasificará automáticamente como "Activo General". 
                    No necesita mapeo a un activo formal del sistema.
                  </AlertDescription>
                </Alert>
              )}

              {/* Decision Type */}
              <div className="space-y-2">
                <Label>Tipo de Mapeo</Label>
                <Select 
                  value={currentMapping.decision} 
                  onValueChange={(value: any) => setCurrentMapping({
                    ...currentMapping,
                    decision: value
                  })}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="formal">
                      <div className="flex items-center gap-2">
                        <Target className="h-4 w-4 text-green-600" />
                        Activo Formal - Mapear a activo existente
                      </div>
                    </SelectItem>
                    <SelectItem value="exception">
                      <div className="flex items-center gap-2">
                        <ExternalLink className="h-4 w-4 text-blue-600" />
                        Activo Excepción - Equipo externo/rental
                      </div>
                    </SelectItem>
                    <SelectItem value="general">
                      <div className="flex items-center gap-2">
                        <Building className="h-4 w-4 text-purple-600" />
                        Consumo General - Operaciones de planta
                      </div>
                    </SelectItem>
                    <SelectItem value="ignore">
                      <div className="flex items-center gap-2">
                        <AlertTriangle className="h-4 w-4 text-gray-600" />
                        Ignorar - No procesar
                      </div>
                    </SelectItem>
                  </SelectContent>
                </Select>
              </div>
              
              {/* Formal Asset Selection */}
              {currentMapping.decision === 'formal' && (
                <div className="space-y-4">
                  <Label>Seleccionar Activo Formal</Label>
                  
                  {/* Suggestions */}
                  {(() => {
                    const suggestions = getAssetSuggestions(currentMapping.originalName)
                    return suggestions.length > 0 ? (
                      <div className="space-y-2">
                        <p className="text-sm text-muted-foreground">Sugerencias:</p>
                        {suggestions.map((suggestion) => (
                          <div 
                            key={suggestion.asset_id}
                            className={cn(
                              "p-3 border rounded cursor-pointer transition-colors",
                              currentMapping.targetAssetId === suggestion.asset_id 
                                ? "border-primary bg-primary/5" 
                                : "border-muted hover:border-muted-foreground/50"
                            )}
                            onClick={() => setCurrentMapping({
                              ...currentMapping,
                              targetAssetId: suggestion.asset_id,
                              targetAssetName: suggestion.asset_name,
                              confidence: suggestion.similarity_score
                            })}
                          >
                            <div className="flex items-center justify-between">
                              <div>
                                <div className="font-medium">
                                  {/* Show asset_id (code) first, then name for clarity */}
                                  {formalAssets.find(a => a.id === suggestion.asset_id)?.code || ''} — {suggestion.asset_name}
                                </div>
                                <div className="text-sm text-muted-foreground">
                                  {suggestion.plant_name} • {suggestion.asset_type}
                                </div>
                              </div>
                              <Badge variant="outline">
                                {Math.round(suggestion.similarity_score * 100)}%
                              </Badge>
                            </div>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <Alert>
                        <Info className="h-4 w-4" />
                        <AlertDescription>
                          No se encontraron sugerencias automáticas. Selecciona manualmente de la lista completa.
                        </AlertDescription>
                      </Alert>
                    )
                  })()}

                  {/* Manual full list selector */}
                  <div className="space-y-2">
                    <Label>Buscar en todos los activos</Label>
                    <Input
                      placeholder="Buscar por nombre, código o planta..."
                      value={assetListSearch}
                      onChange={(e) => setAssetListSearch(e.target.value)}
                    />
                    <div className="border rounded max-h-56 overflow-y-auto">
                      {filteredFormalAssets.length === 0 ? (
                        <div className="p-3 text-sm text-muted-foreground">No hay activos que coincidan con la búsqueda</div>
                      ) : (
                        filteredFormalAssets.slice(0, 300).map(asset => (
                          <div
                            key={asset.id}
                            className={cn(
                              "px-3 py-2 text-sm cursor-pointer flex items-center justify-between",
                              currentMapping.targetAssetId === asset.id ? "bg-primary/5" : "hover:bg-muted"
                            )}
                            onClick={() => setCurrentMapping({
                              ...currentMapping,
                              targetAssetId: asset.id,
                              targetAssetName: asset.name,
                              confidence: 0.6
                            })}
                          >
                            <div className="min-w-0">
                              <div className="font-medium truncate">
                                {asset.code} — {asset.name}
                              </div>
                              <div className="text-xs text-muted-foreground truncate">{asset.plant_name}</div>
                            </div>
                            {currentMapping.targetAssetId === asset.id && (
                              <Badge variant="secondary">Seleccionado</Badge>
                            )}
                          </div>
                        ))
                      )}
                    </div>
                  </div>
                </div>
              )}
              
              {/* Exception Asset Details */}
              {currentMapping.decision === 'exception' && (
                <div className="space-y-4">
                  <div className="space-y-2">
                    <Label>Tipo de Activo Excepción</Label>
                    <Select 
                      value={currentMapping.exceptionDetails?.assetType || 'unknown'} 
                      onValueChange={(value: any) => setCurrentMapping({
                        ...currentMapping,
                        exceptionDetails: {
                          ...currentMapping.exceptionDetails!,
                          assetType: value
                        }
                      })}
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="partner">Socio/Partner</SelectItem>
                        <SelectItem value="rental">Equipo Rentado</SelectItem>
                        <SelectItem value="utility">Servicios/Utilities</SelectItem>
                        <SelectItem value="unknown">Desconocido</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  
                  <div className="space-y-2">
                    <Label>Descripción</Label>
                    <Textarea
                      value={currentMapping.exceptionDetails?.description || ''}
                      onChange={(e) => setCurrentMapping({
                        ...currentMapping,
                        exceptionDetails: {
                          ...currentMapping.exceptionDetails!,
                          description: e.target.value
                        }
                      })}
                      placeholder="Describe el activo excepción..."
                    />
                  </div>
                  
                  <div className="space-y-2">
                    <Label>Información del Propietario (Opcional)</Label>
                    <Input
                      value={currentMapping.exceptionDetails?.ownerInfo || ''}
                      onChange={(e) => setCurrentMapping({
                        ...currentMapping,
                        exceptionDetails: {
                          ...currentMapping.exceptionDetails!,
                          ownerInfo: e.target.value
                        }
                      })}
                      placeholder="Empresa, contacto, etc..."
                    />
                  </div>
                </div>
              )}
              
              {/* Notes */}
              <div className="space-y-2">
                <Label>Notas (Opcional)</Label>
                <Textarea
                  value={currentMapping.notes || ''}
                  onChange={(e) => setCurrentMapping({
                    ...currentMapping,
                    notes: e.target.value
                  })}
                  placeholder="Notas adicionales sobre este mapeo..."
                />
              </div>
            </div>
          )}
          
          <DialogFooter>
            <Button variant="outline" onClick={() => setIsDialogOpen(false)}>
              Cancelar
            </Button>
            <Button onClick={saveMappingDecision}>
              <Save className="mr-2 h-4 w-4" />
              Guardar Mapeo
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Action Bar */}
      {isComplete && (
        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center justify-between">
              <div>
                <div className="font-medium text-green-900">
                  ✅ Mapeo completado
                </div>
                <div className="text-sm text-muted-foreground">
                  Todos los activos han sido mapeados y están listos para procesamiento
                </div>
              </div>
              <div className="flex gap-2">
                <Button variant="outline" onClick={onMappingComplete}>
                  <Settings className="mr-2 h-4 w-4" />
                  Volver a Importar
                </Button>
                <Button onClick={onProceedToProcessing}>
                  <Plus className="mr-2 h-4 w-4" />
                  Procesar Datos
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  )
}




