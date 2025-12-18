"use client"

import { useState, useEffect } from "react"
import { useRouter } from "next/navigation"
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Textarea } from "@/components/ui/textarea"
import { Label } from "@/components/ui/label"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { CheckCircle2, AlertTriangle, X, Camera, Loader2, Save, FileText, ClipboardCheck } from "lucide-react"
import { createBrowserClient } from '@supabase/ssr'
import { toast } from "sonner"
import { SignatureCanvas } from "./signature-canvas"
import { cn } from "@/lib/utils"

interface ChecklistItem {
  id: string
  description: string
  required: boolean
  item_type: string
  expected_value?: string
  tolerance?: string
}

interface ChecklistSection {
  id: string
  title: string
  items: ChecklistItem[]
}

interface MaintenanceChecklistExecutionProps {
  workOrderId: string
}

export function MaintenanceChecklistExecution({ workOrderId }: MaintenanceChecklistExecutionProps) {
  const router = useRouter()
  const [isLoading, setIsLoading] = useState(true)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [workOrder, setWorkOrder] = useState<any>(null)
  const [checklistData, setChecklistData] = useState<any>(null)
  const [sections, setSections] = useState<ChecklistSection[]>([])
  const [currentSection, setCurrentSection] = useState(0)
  const [responses, setResponses] = useState<{ [key: string]: { status: 'pass' | 'flag' | 'fail', notes?: string } }>({})
  const [signature, setSignature] = useState<string>("")
  const [notes, setNotes] = useState("")
  const [photos, setPhotos] = useState<{ [key: string]: string[] }>({})

  useEffect(() => {
    const fetchData = async () => {
      try {
        setIsLoading(true)
        
        const supabase = createBrowserClient(
          process.env.NEXT_PUBLIC_SUPABASE_URL!,
          process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
        )
        
        // Get work order details
        const { data: orderData, error: orderError } = await supabase
          .from('work_orders')
          .select(`
            *,
            assets (
              id,
              name,
              asset_id,
              location,
              model_id
            )
          `)
          .eq('id', workOrderId)
          .single()
        
        if (orderError || !orderData) {
          toast.error("No se pudo cargar la orden de trabajo")
          router.push(`/ordenes/${workOrderId}`)
          return
        }
        
        setWorkOrder(orderData)
        
        // Get required checklist for this work order
        // @ts-ignore - RPC function created in recent migration
        const { data: checklistId } = await supabase
          .rpc('get_required_checklist_for_work_order', { p_work_order_id: workOrderId })
        
        if (!checklistId) {
          toast.error("No se encontró un checklist para esta orden de trabajo")
          router.push(`/ordenes/${workOrderId}`)
          return
        }
        
        // Get checklist details
        const { data: checklist, error: checklistError } = await supabase
          .from('checklists')
          .select(`
            *,
            checklist_sections (
              *,
              checklist_items (*)
            )
          `)
          .eq('id', checklistId)
          .single()
        
        if (checklistError || !checklist) {
          toast.error("No se pudo cargar el checklist")
          return
        }
        
        setChecklistData(checklist)
        
        // Format sections and items
        const formattedSections = checklist.checklist_sections
          .sort((a: any, b: any) => a.order_index - b.order_index)
          .map((section: any) => ({
            id: section.id,
            title: section.title,
            items: section.checklist_items
              .sort((a: any, b: any) => a.order_index - b.order_index)
              .map((item: any) => ({
                id: item.id,
                description: item.description,
                required: item.required,
                item_type: item.item_type || 'check',
                expected_value: item.expected_value,
                tolerance: item.tolerance
              }))
          }))
        
        setSections(formattedSections)
        
      } catch (error) {
        console.error('Error loading data:', error)
        toast.error("Error al cargar los datos")
      } finally {
        setIsLoading(false)
      }
    }
    
    fetchData()
  }, [workOrderId, router])

  const handleResponseChange = (itemId: string, status: 'pass' | 'flag' | 'fail', notes?: string) => {
    setResponses(prev => ({
      ...prev,
      [itemId]: { status, notes }
    }))
  }

  const handlePhotoUpload = async (itemId: string, file: File) => {
    try {
      const supabase = createBrowserClient(
        process.env.NEXT_PUBLIC_SUPABASE_URL!,
        process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
      )
      
      const fileName = `${workOrderId}/${itemId}/${Date.now()}_${file.name}`
      const { error: uploadError } = await supabase.storage
        .from('checklist-photos')
        .upload(fileName, file)
      
      if (uploadError) {
        console.error('Upload error details:', uploadError)
        throw new Error(`Error al subir archivo: ${uploadError.message}`)
      }
      
      const { data: urlData } = supabase.storage
        .from('checklist-photos')
        .getPublicUrl(fileName)
      
      setPhotos(prev => ({
        ...prev,
        [itemId]: [...(prev[itemId] || []), urlData.publicUrl]
      }))
      
      toast.success('Foto subida exitosamente')
    } catch (error: any) {
      console.error('Error uploading photo:', error)
      const errorMessage = error?.message || 'Error desconocido al subir la foto'
      toast.error(`Error al subir la foto: ${errorMessage}`)
    }
  }

  const isChecklistComplete = () => {
    // Check if all required items have responses
    for (const section of sections) {
      for (const item of section.items) {
        if (item.required && !responses[item.id]) {
          return false
        }
      }
    }
    return signature !== ""
  }

  const handleSubmit = async () => {
    if (isSubmitting) return // Prevent double submission
    
    if (!isChecklistComplete()) {
      toast.error('Por favor complete todos los campos requeridos')
      return
    }
    
    setIsSubmitting(true)
    
    try {
      const supabase = createBrowserClient(
        process.env.NEXT_PUBLIC_SUPABASE_URL!,
        process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
      )
      
      // Get current user
      const { data: { user } } = await supabase.auth.getUser()
      
      // Prepare completion data
      const completionData = {
        work_order_id: workOrderId,
        checklist_template_id: checklistData.id,
        completed_by: user?.id,
        completion_data: {
          sections: sections.map(section => ({
            id: section.id,
            title: section.title,
            items: section.items.map(item => ({
              id: item.id,
              description: item.description,
              response: responses[item.id] || null,
              photos: photos[item.id] || []
            }))
          }))
        },
        signature,
        notes,
        status: 'completed'
      }
      
      // Save maintenance checklist
      // @ts-ignore - Table created in recent migration
      const { error: saveError } = await supabase
        .from('maintenance_checklists')
        .insert(completionData)
      
      if (saveError) throw saveError
      
      // Update work order to mark checklist as completed
      const { error: updateError } = await supabase
        .from('work_orders')
        .update({ preventive_checklist_completed: true })
        .eq('id', workOrderId)
      
      if (updateError) throw updateError
      
      toast.success('Checklist de mantenimiento completado exitosamente')
      router.push(`/ordenes/${workOrderId}/completar`)
      
    } catch (error) {
      console.error('Error submitting checklist:', error)
      toast.error('Error al guardar el checklist')
    } finally {
      setIsSubmitting(false)
    }
  }

  if (isLoading) {
    return (
      <div className="flex items-center justify-center min-h-[60vh]">
        <div className="text-center">
          <Loader2 className="h-8 w-8 animate-spin mx-auto mb-4 text-blue-500" />
          <p className="text-muted-foreground">Cargando checklist de mantenimiento...</p>
        </div>
      </div>
    )
  }

  if (!checklistData || sections.length === 0) {
    return (
      <div className="container mx-auto py-6">
        <Alert>
          <AlertTriangle className="h-4 w-4" />
          <AlertTitle>Error</AlertTitle>
          <AlertDescription>
            No se pudo cargar el checklist de mantenimiento.
          </AlertDescription>
        </Alert>
      </div>
    )
  }

  const currentSectionData = sections[currentSection]
  const progress = (Object.keys(responses).length / sections.reduce((acc, s) => acc + s.items.length, 0)) * 100

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader className="bg-primary text-primary-foreground">
          <div className="flex items-center gap-2">
            <ClipboardCheck className="h-6 w-6" />
            <div>
              <CardTitle className="text-2xl">Checklist de Mantenimiento Preventivo</CardTitle>
              <CardDescription className="text-primary-foreground/80">
                Orden de Trabajo: {workOrder?.order_id} | Activo: {workOrder?.assets?.name}
              </CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent className="pt-6">
          {/* Progress bar */}
          <div className="mb-6">
            <div className="flex justify-between text-sm mb-2">
              <span>Progreso</span>
              <span>{Math.round(progress)}% completado</span>
            </div>
            <div className="w-full bg-gray-200 rounded-full h-2">
              <div 
                className="bg-primary h-2 rounded-full transition-all"
                style={{ width: `${progress}%` }}
              />
            </div>
          </div>

          {/* Section navigation */}
          <div className="flex justify-between items-center mb-6">
            <h3 className="text-lg font-semibold">
              Sección {currentSection + 1} de {sections.length}: {currentSectionData.title}
            </h3>
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={(e) => {
                  e.preventDefault()
                  e.stopPropagation()
                  setCurrentSection(Math.max(0, currentSection - 1))
                }}
                disabled={currentSection === 0 || isSubmitting}
              >
                Anterior
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={(e) => {
                  e.preventDefault()
                  e.stopPropagation()
                  setCurrentSection(Math.min(sections.length - 1, currentSection + 1))
                }}
                disabled={currentSection === sections.length - 1 || isSubmitting}
              >
                Siguiente
              </Button>
            </div>
          </div>

          {/* Section items */}
          <div className="space-y-4">
            {currentSectionData.items.map((item) => (
              <Card key={item.id} className={cn(
                "border",
                responses[item.id]?.status === 'fail' && "border-red-500",
                responses[item.id]?.status === 'flag' && "border-orange-500",
                responses[item.id]?.status === 'pass' && "border-green-500"
              )}>
                <CardHeader className="pb-3">
                  <div className="flex items-start justify-between">
                    <CardTitle className="text-base">
                      {item.description}
                      {item.required && <span className="text-red-500 ml-1">*</span>}
                    </CardTitle>
                    {item.expected_value && (
                      <Badge variant="outline">
                        Esperado: {item.expected_value}
                        {item.tolerance && ` ± ${item.tolerance}`}
                      </Badge>
                    )}
                  </div>
                </CardHeader>
                <CardContent>
                  <RadioGroup
                    value={responses[item.id]?.status || ""}
                    onValueChange={(value) => handleResponseChange(item.id, value as any)}
                  >
                    <div className="grid grid-cols-3 gap-4">
                      <label className={cn(
                        "flex items-center space-x-2 border rounded-md p-3 cursor-pointer",
                        responses[item.id]?.status === 'pass' && "bg-green-50 border-green-500"
                      )}>
                        <RadioGroupItem value="pass" />
                        <CheckCircle2 className="h-4 w-4 text-green-600" />
                        <span>Correcto</span>
                      </label>
                      <label className={cn(
                        "flex items-center space-x-2 border rounded-md p-3 cursor-pointer",
                        responses[item.id]?.status === 'flag' && "bg-orange-50 border-orange-500"
                      )}>
                        <RadioGroupItem value="flag" />
                        <AlertTriangle className="h-4 w-4 text-orange-600" />
                        <span>Advertencia</span>
                      </label>
                      <label className={cn(
                        "flex items-center space-x-2 border rounded-md p-3 cursor-pointer",
                        responses[item.id]?.status === 'fail' && "bg-red-50 border-red-500"
                      )}>
                        <RadioGroupItem value="fail" />
                        <X className="h-4 w-4 text-red-600" />
                        <span>Falla</span>
                      </label>
                    </div>
                  </RadioGroup>

                  {(responses[item.id]?.status === 'flag' || responses[item.id]?.status === 'fail') && (
                    <div className="mt-4 space-y-4">
                      <div>
                        <Label>Notas sobre el problema</Label>
                        <Textarea
                          placeholder="Describa el problema encontrado..."
                          value={responses[item.id]?.notes || ""}
                          onChange={(e) => handleResponseChange(
                            item.id, 
                            responses[item.id].status, 
                            e.target.value
                          )}
                          className="mt-1"
                        />
                      </div>
                      <div>
                        <Label>Fotografía del problema</Label>
                        <div className="mt-1">
                          <input
                            type="file"
                            accept="image/*"
                            onChange={(e) => {
                              if (e.target.files?.[0]) {
                                handlePhotoUpload(item.id, e.target.files[0])
                              }
                            }}
                            className="hidden"
                            id={`photo-${item.id}`}
                          />
                          <label
                            htmlFor={`photo-${item.id}`}
                            className="flex items-center justify-center border-2 border-dashed rounded-md p-4 cursor-pointer hover:border-primary"
                          >
                            <Camera className="h-6 w-6 text-muted-foreground mr-2" />
                            <span className="text-sm text-muted-foreground">
                              Agregar foto
                            </span>
                          </label>
                        </div>
                        {photos[item.id]?.map((photo, idx) => (
                          <div key={idx} className="mt-2">
                            <img 
                              src={photo} 
                              alt="Evidencia" 
                              className="h-20 w-20 object-cover rounded"
                            />
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </CardContent>
              </Card>
            ))}
          </div>

          {/* Notes and signature - show only on last section */}
          {currentSection === sections.length - 1 && (
            <div className="mt-8 space-y-6 border-t pt-6">
              <div>
                <Label htmlFor="notes">Notas Generales del Mantenimiento</Label>
                <Textarea
                  id="notes"
                  placeholder="Agregue observaciones generales sobre el mantenimiento realizado..."
                  rows={4}
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  className="mt-1"
                />
              </div>

              <div>
                <Label>Firma del Técnico</Label>
                <div className="mt-1">
                  <SignatureCanvas onSave={(sig) => setSignature(sig || "")} />
                  {signature && (
                    <p className="text-sm text-green-600 mt-2">
                      ✓ Firma guardada
                    </p>
                  )}
                </div>
              </div>
            </div>
          )}
        </CardContent>
        <CardFooter className="flex justify-between">
          <Button
            variant="outline"
            onClick={(e) => {
              e.preventDefault()
              e.stopPropagation()
              router.push(`/ordenes/${workOrderId}`)
            }}
            disabled={isSubmitting}
          >
            Cancelar
          </Button>
          {currentSection === sections.length - 1 && (
            <Button
              onClick={(e) => {
                e.preventDefault()
                e.stopPropagation()
                handleSubmit()
              }}
              disabled={!isChecklistComplete() || isSubmitting}
            >
              {isSubmitting ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Guardando...
                </>
              ) : (
                <>
                  <Save className="mr-2 h-4 w-4" />
                  Completar Checklist
                </>
              )}
            </Button>
          )}
        </CardFooter>
      </Card>
    </div>
  )
} 