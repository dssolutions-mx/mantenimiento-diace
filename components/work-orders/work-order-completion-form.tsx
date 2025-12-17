"use client"

import { useState, useEffect } from "react"
import { useRouter } from "next/navigation"
import { z } from "zod"
import { zodResolver } from "@hookform/resolvers/zod"
import { useForm } from "react-hook-form"
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card"
import { Form, FormControl, FormDescription, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { ArrowLeft, CalendarCheck, CheckCircle, Clock, CalendarIcon, Plus, Trash2, ShoppingCart, Camera, FileText, ClipboardCheck, AlertTriangle, ExternalLinkIcon } from "lucide-react"
import { createClient } from "@/lib/supabase"
import { Separator } from "@/components/ui/separator"
import { toast } from "@/components/ui/use-toast"
import Link from "next/link"
import { MaintenanceType, ServiceOrderPriority, WorkOrderStatus, WorkOrderComplete } from "@/types"
import { format } from "date-fns"
import { es } from "date-fns/locale"
import { Calendar } from "@/components/ui/calendar"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { cn } from "@/lib/utils"
import { Switch } from "@/components/ui/switch"
import { EvidenceUpload, type EvidencePhoto } from "@/components/ui/evidence-upload"
import { Badge } from "@/components/ui/badge"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { getMaintenanceUnit, getCurrentValue, getUnitLabel, getUnitDisplayName, type MaintenanceUnit } from "@/lib/utils/maintenance-units"

// Date picker component
function DatePicker({ date, setDate }: { date: Date | undefined, setDate: (date: Date | undefined) => void }) {
  return (
    <div className="grid gap-2">
      <Popover>
        <PopoverTrigger asChild>
          <Button
            variant={"outline"}
            className={cn(
              "w-full justify-start text-left font-normal",
              !date && "text-muted-foreground"
            )}
          >
            <CalendarIcon className="mr-2 h-4 w-4" />
            {date ? format(date, "PPP", { locale: es }) : <span>Seleccionar fecha</span>}
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-auto p-0" align="start">
          <Calendar
            mode="single"
            selected={date}
            onSelect={setDate}
            initialFocus
            locale={es}
          />
        </PopoverContent>
      </Popover>
    </div>
  )
}

// Schema for work order completion
const workOrderCompletionSchema = z.object({
  completion_date: z.date({
    required_error: "La fecha de finalización es requerida",
  }),
  completion_time: z.string().min(1, "La hora de finalización es requerida"),
  equipment_hours: z.coerce.number().min(0, "Las horas del equipo no pueden ser negativas").optional(),
  equipment_kilometers: z.coerce.number().min(0, "Los kilómetros del equipo no pueden ser negativos").optional(),
  downtime_hours: z.coerce.number().min(0, "Las horas de inactividad no pueden ser negativas"),
  technician_notes: z.string().optional(),
  resolution_details: z.string().min(1, "Los detalles de resolución son requeridos"),
  parts_used: z.array(
    z.object({
      part_id: z.string().optional(),
      id: z.string().optional(),
      name: z.string().optional(),
      part_name: z.string().optional(),
      description: z.string().optional(),
      quantity: z.coerce.number().int().min(1),
      unit_price: z.coerce.number().min(0),
      total_price: z.coerce.number().min(0),
    })
  ).optional(),
  labor_hours: z.coerce.number().min(0, "Las horas de trabajo no pueden ser negativas"),
  labor_cost: z.coerce.number().min(0, "El costo de mano de obra no puede ser negativo"),
  total_cost: z.coerce.number().min(0, "El costo total no puede ser negativo"),
  has_additional_expenses: z.boolean(),
  additional_expenses: z.array(
    z.object({
      description: z.string().min(1, "La descripción es requerida"),
      amount: z.coerce.number().min(0.01, "El monto debe ser mayor a cero"),
      justification: z.string().min(1, "La justificación es requerida")
    })
  ),
  additional_expenses_total: z.coerce.number().min(0, "El total de gastos adicionales no puede ser negativo")
})

type WorkOrderCompletionFormValues = z.infer<typeof workOrderCompletionSchema>

interface WorkOrderCompletionFormProps {
  workOrderId: string
  initialData?: Partial<WorkOrderComplete>
}

export function WorkOrderCompletionForm({ workOrderId, initialData }: WorkOrderCompletionFormProps) {
  const router = useRouter()
  const [isLoading, setIsLoading] = useState(false)
  const [workOrder, setWorkOrder] = useState<any>(null)
  const [requiredParts, setRequiredParts] = useState<any[]>([])
  const [requiredTasks, setRequiredTasks] = useState<any[]>([])
  const [completedTasks, setCompletedTasks] = useState<Record<string, boolean>>({})
  const [completionEvidence, setCompletionEvidence] = useState<EvidencePhoto[]>([])
  const [showEvidenceDialog, setShowEvidenceDialog] = useState(false)
  const [costSource, setCostSource] = useState<'estimated' | 'quoted' | 'confirmed'>('estimated')
  const [purchaseOrderId, setPurchaseOrderId] = useState<string | null>(null)
  const [checklistStatus, setChecklistStatus] = useState<{
    required: boolean
    completed: boolean
    checklistId: string | null
  }>({ required: false, completed: false, checklistId: null })
  const [maintenanceUnit, setMaintenanceUnit] = useState<MaintenanceUnit>('hours')

  // Default form values
  const defaultValues: Partial<WorkOrderCompletionFormValues> = {
    completion_date: initialData?.completion_date ? new Date(initialData.completion_date) : new Date(),
    completion_time: initialData?.completion_time || "",
    equipment_hours: 0, // Will be populated from asset data
    equipment_kilometers: 0, // Will be populated from asset data
    downtime_hours: initialData?.downtime_hours || 0,
    technician_notes: initialData?.technician_notes || "",
    resolution_details: initialData?.resolution_details || "",
    labor_hours: initialData?.labor_hours || 0,
    labor_cost: initialData?.labor_cost || 0,
    total_cost: initialData?.total_cost || 0,
    parts_used: [],
    has_additional_expenses: false,
    additional_expenses: [],
    additional_expenses_total: 0
  }

  const form = useForm<WorkOrderCompletionFormValues>({
    resolver: zodResolver(workOrderCompletionSchema),
    defaultValues,
    mode: "onChange",
  })

  // Load work order details
  useEffect(() => {
    async function loadWorkOrder() {
      try {
        setIsLoading(true)
        const supabase = createClient()

        // Get work order data
        const { data: orderData, error: orderError } = await supabase
          .from("work_orders")
          .select(`
            *,
            asset:assets (*),
            purchase_orders!purchase_order_id (
              id,
              status
            )
          `)
          .eq("id", workOrderId)
          .single()
          
        // Get ALL purchase orders related to this work order
        const { data: allPurchaseOrders } = await supabase
          .from("purchase_orders")
          .select("*")
          .eq("work_order_id", workOrderId)
          .order("created_at", { ascending: true })

        if (orderError) throw orderError
        setWorkOrder(orderData)
        
        // Detect maintenance unit from asset model
        const unit = getMaintenanceUnit(orderData.asset || {})
        setMaintenanceUnit(unit)
        
        // Set equipment value (hours or kilometers) from asset based on unit
        if (orderData.asset) {
          const currentValue = getCurrentValue(orderData.asset, unit)
          if (unit === 'kilometers') {
            form.setValue('equipment_kilometers', currentValue)
          } else {
            form.setValue('equipment_hours', currentValue)
          }
        }
        
        // Load required tasks from work order
        if (orderData.required_tasks) {
          try {
            const tasks = typeof orderData.required_tasks === "string" 
              ? JSON.parse(orderData.required_tasks) 
              : orderData.required_tasks;
            
            if (Array.isArray(tasks) && tasks.length > 0) {
              setRequiredTasks(tasks);
              // Initialize completed tasks state - all false by default
              const initialCompleted: Record<string, boolean> = {};
              tasks.forEach((task: any) => {
                if (task.id) {
                  initialCompleted[task.id] = false;
                }
              });
              setCompletedTasks(initialCompleted);
              console.log('Loaded required tasks:', tasks.length);
            }
          } catch (e) {
            console.error('Error parsing required tasks:', e);
          }
        }

        // Log maintenance_plan_id for debugging
        console.log('Work order data loaded:', {
          id: orderData.id,
          type: orderData.type,
          status: orderData.status,
          maintenance_plan_id: orderData.maintenance_plan_id || null,
          maintenance_unit: unit,
          asset_current_value: orderData.asset ? getCurrentValue(orderData.asset, unit) : 0,
          required_tasks_count: orderData.required_tasks ? (typeof orderData.required_tasks === "string" ? JSON.parse(orderData.required_tasks) : orderData.required_tasks).length : 0
        });
        
        // Check if this is a preventive order that requires checklist
        if (orderData.type === MaintenanceType.Preventive) {
          // Check if order is ready to execute (PO approved/received)
          // @ts-ignore - RPC function created in recent migration
          const { data: readyData } = await supabase
            .rpc('is_work_order_ready_to_execute', { p_work_order_id: workOrderId })
          
          if (readyData) {
            // Get required checklist
            // @ts-ignore - RPC function created in recent migration
            const { data: checklistId } = await supabase
              .rpc('get_required_checklist_for_work_order', { p_work_order_id: workOrderId })
            
            if (checklistId) {
              // Check if checklist is completed
              // @ts-ignore - Table created in recent migration
              const { data: maintenanceChecklist } = await supabase
                .from('maintenance_checklists')
                .select('*')
                .eq('work_order_id', workOrderId)
                .eq('status', 'completed')
                .single()
              
              setChecklistStatus({
                required: true,
                completed: !!maintenanceChecklist,
                checklistId: checklistId
              })
            }
          }
        }
        
        // Determine which parts and costs to use - Priority: PO Items > Required Parts
        let parts = [];
        let costSource = 'estimated';
        let totalCost = 0;
        
        // Try to use purchase order items first
        if (allPurchaseOrders && allPurchaseOrders.length > 0) {
          const mainPO = allPurchaseOrders.find(po => !po.is_adjustment);
          if (mainPO && mainPO.items) {
            try {
              const poItems = typeof mainPO.items === 'string' ? JSON.parse(mainPO.items) : mainPO.items;
              if (poItems && Array.isArray(poItems) && poItems.length > 0) {
                // Transform PO items to match our parts format
                parts = poItems.map((item: any) => ({
                  part_id: item.part_id || item.id || `po-item-${Math.random()}`,
                  name: item.name || item.description || item.item || "Repuesto cotizado",
                  part_name: item.name || item.description || item.item || "Repuesto cotizado",
                  description: item.description || item.name || item.item,
                  quantity: Number(item.quantity) || 1,
                  unit_price: Number(item.unit_price || item.price) || 0,
                  total_price: Number(item.total_price) || (Number(item.quantity || 1) * Number(item.unit_price || item.price || 0))
                }));
                
                                 // Use actual amount if available, otherwise total amount
                 totalCost = mainPO.actual_amount ? Number(mainPO.actual_amount) : Number(mainPO.total_amount || 0);
                 const currentCostSource = mainPO.actual_amount ? 'confirmed' : 'quoted';
                 
                 setCostSource(currentCostSource);
                 setPurchaseOrderId(mainPO.id);
                 
                 console.log('Using PO items for completion:', {
                   source: currentCostSource,
                   totalCost,
                   itemsCount: parts.length,
                   poId: mainPO.id
                 });
              }
            } catch (e) {
              console.error('Error parsing PO items:', e);
            }
          }
        }
        
        // Fallback to required parts if no PO items available
        if (parts.length === 0 && orderData.required_parts) {
          try {
            parts = typeof orderData.required_parts === "string" 
              ? JSON.parse(orderData.required_parts) 
              : orderData.required_parts;
            
            // Ensure parts is always an array
            parts = Array.isArray(parts) ? parts : [];
            
            console.log('Using estimated required_parts data:', JSON.stringify(parts));
            
            // Ensure all numeric properties are properly parsed as numbers
            parts = parts.map((part: any) => ({
              ...part,
              name: part.name,
              part_name: part.part_name || part.description || "Repuesto sin nombre",
              quantity: Number(part.quantity) || 0,
              unit_price: Number(part.unit_price) || 0,
              total_price: Number(part.total_price) || 0,
            }));
            
                         // Calculate total cost from parts
             totalCost = parts.reduce((sum: number, part: any) => {
               return sum + (Number(part.total_price) || 0);
             }, 0);
             
             setCostSource('estimated');
          } catch (e) {
            console.error('Error parsing required parts:', e);
            parts = [];
          }
        }
        
        // Set the parts and costs in the form
        if (parts.length > 0) {
          setRequiredParts(parts);
          
          // Set parts_used with the processed parts
          form.setValue("parts_used", parts.map((part: any) => ({
            part_id: part.part_id,
            name: part.name,
            part_name: part.part_name,
            description: part.description,
            quantity: Number(part.quantity) || 0,
            unit_price: Number(part.unit_price) || 0,
            total_price: Number(part.total_price) || 0
          })));
          
                     console.log(`Parts cost calculated from estimated/PO source:`, totalCost);
           form.setValue("total_cost", totalCost);
        }
      } catch (error) {
        console.error("Error loading work order:", error)
        toast({
          variant: "destructive",
          title: "Error",
          description: "No se pudo cargar la orden de trabajo",
        })
      } finally {
        setIsLoading(false)
      }
    }

    loadWorkOrder()
  }, [workOrderId, form])

  // Update total cost when labor cost or additional expenses change
  useEffect(() => {
    let isUpdating = false;

    // Iniciar con el cálculo correcto al montar el componente
    if (!isUpdating) {
      isUpdating = true;
      try {
        const partsCost = requiredParts.reduce((sum, part) => sum + (Number(part.total_price) || 0), 0);
        const formValues = form.getValues();
        const laborCost = Number(formValues.labor_cost) || 0;
        const additionalExpensesTotal = Number(formValues.additional_expenses_total) || 0;
        
        const totalCost = partsCost + laborCost + additionalExpensesTotal;
        console.log('Cálculo inicial del total:', {partsCost, laborCost, additionalExpensesTotal, totalCost});
        
        form.setValue("total_cost", totalCost, { shouldDirty: true });
      } finally {
        isUpdating = false;
      }
    }

    const subscription = form.watch((value, { name }) => {
      // Prevent recursive updates that cause infinite loops
      if (isUpdating) return;
      
      console.log('Watch triggered by:', name, 'with value:', value && typeof value === 'object' ? JSON.stringify(value) : value);
      
      if (name === "labor_cost" || name === "parts_used" || name?.startsWith("additional_expenses") || name === "has_additional_expenses") {
        isUpdating = true;
        
        try {
          // Ensure numeric values
          const partsCost = requiredParts.reduce((sum, part) => sum + (Number(part.total_price) || 0), 0);
          const laborCost = Number(value.labor_cost) || 0;
          
          // Calculate additional expenses total
          let additionalExpensesTotal = 0;
          if (value.has_additional_expenses && Array.isArray(value.additional_expenses) && value.additional_expenses.length > 0) {
            additionalExpensesTotal = value.additional_expenses.reduce(
              (sum, expense) => sum + (parseFloat(expense?.amount?.toString() || "0")), 
              0
            );
            // Update additional_expenses_total field
            form.setValue("additional_expenses_total", additionalExpensesTotal, { shouldDirty: true });
          } else {
            // Reset the additional expenses if has_additional_expenses is false
            if (name === "has_additional_expenses" && !value.has_additional_expenses) {
              form.setValue("additional_expenses", [], { shouldDirty: true });
              form.setValue("additional_expenses_total", 0, { shouldDirty: true });
              additionalExpensesTotal = 0;
            }
          }
          
          // Perform explicit addition to avoid string concatenation
          const totalCost = partsCost + laborCost + additionalExpensesTotal;
          console.log('Calculating total:', {
            partsCost: Number(partsCost), 
            laborCost: Number(laborCost), 
            additionalExpensesTotal: Number(additionalExpensesTotal), 
            totalCost: Number(totalCost),
            laborCostType: typeof laborCost,
            valueLabor: value.labor_cost
          });
          
          // Update total cost
          form.setValue("total_cost", totalCost, { shouldDirty: true });
        } finally {
          // Always reset the flag to allow future updates
          isUpdating = false;
        }
      }
    });
    
    return () => subscription.unsubscribe();
  }, [form, requiredParts]);

  // Add a new additional expense
  const addAdditionalExpense = () => {
    const currentExpenses = form.getValues("additional_expenses") || [];
    const newExpense = { description: "", amount: 0, justification: "" };
    form.setValue("additional_expenses", [...currentExpenses, newExpense], { shouldDirty: true });
    
    // Recalculate totals
    const additionalExpensesTotal = [...currentExpenses, newExpense].reduce(
      (sum, expense) => sum + (parseFloat(expense.amount.toString()) || 0), 
      0
    );
    form.setValue("additional_expenses_total", additionalExpensesTotal, { shouldDirty: true });
  }

  // Remove an additional expense
  const removeAdditionalExpense = (index: number) => {
    const currentExpenses = form.getValues("additional_expenses") || [];
    const updatedExpenses = currentExpenses.filter((_, i) => i !== index);
    
    form.setValue("additional_expenses", updatedExpenses, { shouldDirty: true });
    
    // Recalculate totals
    const additionalExpensesTotal = updatedExpenses.reduce(
      (sum, expense) => sum + (parseFloat(expense.amount.toString()) || 0), 
      0
    );
    form.setValue("additional_expenses_total", additionalExpensesTotal, { shouldDirty: true });
    
    // If no expenses left, reset has_additional_expenses if needed
    if (updatedExpenses.length === 0) {
      form.setValue("has_additional_expenses", false, { shouldDirty: true });
    }
  }

  // Handle form submission
  async function onSubmit(data: WorkOrderCompletionFormValues) {
    try {
      console.log("Iniciando envío del formulario con datos:", data);
      setIsLoading(true);
      
      // Asegurarnos de que requiredParts tenga el formato correcto
      const formattedParts = requiredParts.map(part => ({
        part_id: part.id || part.part_id || '',  // Asegurar que part_id siempre tiene un valor
        id: part.id || part.part_id || '',       // Incluir id también para compatibilidad
        name: part.name || part.part_name || part.description || "Repuesto sin nombre", 
        quantity: Number(part.quantity) || 0,
        partNumber: part.partNumber || '',
        unit_price: Number(part.unit_price) || 0,
        total_price: Number(part.total_price) || 0
      }));
      
      console.log("Repuestos formateados:", formattedParts);
      
      // Aquí vamos a asegurarnos que parts_used en data esté actualizado antes de enviarlo
      const updatedData = {
        ...data,
        parts_used: formattedParts
      };

      // Prepare completed tasks data
      const completedTasksData = requiredTasks
        .filter((task: any) => completedTasks[task.id])
        .map((task: any) => ({
          task_id: task.id,
          completed: true,
          completed_at: updatedData.completion_date.toISOString()
        }));
      
              // Preparar datos para la API - ajustar según lo que el backend realmente acepta
        const formattedData = {
          workOrderId,
          completionData: {
            resolution_details: updatedData.resolution_details,
            technician_notes: updatedData.technician_notes || '',
            equipment_hours: maintenanceUnit === 'hours' ? (updatedData.equipment_hours || getCurrentValue(workOrder?.asset || {}, maintenanceUnit) || null) : null,
            equipment_kilometers: maintenanceUnit === 'kilometers' ? (updatedData.equipment_kilometers || getCurrentValue(workOrder?.asset || {}, maintenanceUnit) || null) : null,
            downtime_hours: updatedData.downtime_hours || 0,
            labor_hours: updatedData.labor_hours || 0,
            labor_cost: updatedData.labor_cost || 0,
            completion_date: updatedData.completion_date.toISOString(),
            completion_time: updatedData.completion_time,
            parts_used: formattedParts, // Incluir los repuestos formateados
            completed_tasks: completedTasksData.length > 0 ? completedTasksData : undefined,
            completion_photos: completionEvidence.map(evidence => ({
              url: evidence.url,
              description: evidence.description,
              category: evidence.category,
              uploaded_at: evidence.uploaded_at,
              bucket_path: evidence.bucket_path
            }))
          },
        maintenanceHistoryData: workOrder?.asset?.id ? {
          asset_id: workOrder.asset.id,
          date: updatedData.completion_date.toISOString(),
          type: workOrder.type,
          hours: maintenanceUnit === 'hours' ? (updatedData.equipment_hours || getCurrentValue(workOrder.asset, maintenanceUnit) || null) : null,
          kilometers: maintenanceUnit === 'kilometers' ? (updatedData.equipment_kilometers || getCurrentValue(workOrder.asset, maintenanceUnit) || null) : null,
          description: workOrder.description,
          technician_id: workOrder.assigned_to,
          labor_hours: updatedData.labor_hours,
          labor_cost: updatedData.labor_cost.toString(),
          parts: formattedParts.length > 0 ? JSON.stringify(formattedParts) : null, // Convertir a cadena JSON
          total_cost: updatedData.total_cost.toString(),
          work_order_id: workOrderId,
          findings: updatedData.technician_notes || null,
          actions: updatedData.resolution_details,
          // Important: Include the maintenance_plan_id from the work order to properly mark the maintenance as completed
          maintenance_plan_id: workOrder.maintenance_plan_id || null,
          // Include completed tasks
          completed_tasks: completedTasksData.length > 0 ? completedTasksData : null,
          // Incluir todos los campos de completion que no van en work_orders
          downtime_hours: updatedData.downtime_hours,
          resolution_details: updatedData.resolution_details,
          technician_notes: updatedData.technician_notes || ''
        } : null,
        additionalExpenses: updatedData.has_additional_expenses && Array.isArray(updatedData.additional_expenses) && updatedData.additional_expenses.length > 0 
          ? updatedData.additional_expenses.filter(expense => 
              expense.description.trim() !== '' && 
              parseFloat(expense.amount.toString()) > 0 &&
              expense.justification.trim() !== ''
            )
          : null
      };
      
      console.log("Datos formateados para enviar a API:", JSON.stringify(formattedData));
      
      // Llamar a la API
      console.log("Realizando llamada a /api/maintenance/work-completions");
      const response = await fetch('/api/maintenance/work-completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        credentials: 'include',
        body: JSON.stringify(formattedData),
      });
      
      // Verificar los códigos de estado para errores comunes
      if (response.status === 401) {
        throw new Error("No autorizado. Por favor, vuelva a iniciar sesión.");
      } else if (response.status === 404) {
        throw new Error("El endpoint de API no existe.");
      } else if (response.status === 500) {
        throw new Error("Error interno del servidor al procesar la solicitud.");
      }
      
      // Capturar la respuesta como texto primero para analizarla
      const responseText = await response.text();
      console.log("Respuesta recibida (texto):", responseText);
      
      // Si la respuesta está vacía, manejar el caso especialmente
      if (!responseText) {
        throw new Error("La respuesta del servidor está vacía");
      }
      
      // Luego parseamos el texto a JSON
      let responseData;
      try {
        responseData = JSON.parse(responseText);
      } catch (e) {
        console.error("Error al parsear la respuesta como JSON:", e);
        throw new Error("La respuesta del servidor no es un JSON válido");
      }
      
      if (!response.ok) {
        console.error("Error en la respuesta de la API:", responseData);
        throw new Error(responseData.error || 'Error al completar la orden de trabajo');
      }
      
      console.log("Respuesta exitosa de la API:", responseData);
      
      // Guardar los IDs de gastos adicionales para posible generación de OC
      if (formattedData.additionalExpenses && 
          formattedData.additionalExpenses.length > 0 && 
          responseData.additionalExpenseIds && 
          responseData.additionalExpenseIds.length > 0) {
        
        // Generar automáticamente la orden de compra para gastos adicionales
        try {
          // Get purchase order ID from work order if exists
          let originalPurchaseOrderId = null;
          if (workOrder && workOrder.purchase_order_id) {
            originalPurchaseOrderId = workOrder.purchase_order_id;
          }
          
          console.log("Generando automáticamente orden de compra para gastos adicionales");
          const poResponse = await fetch('/api/maintenance/generate-adjustment-po', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
            },
            credentials: 'include',
            body: JSON.stringify({
              workOrderId,
              originalPurchaseOrderId,
              additionalExpenses: formattedData.additionalExpenses,
              supplier: "Gastos Adicionales"
            }),
          });
          
          if (!poResponse.ok) {
            const errorData = await poResponse.json();
            console.error("Error al generar orden de compra de ajuste:", errorData);
            // No interrumpimos el flujo principal si falla la generación de OC
          } else {
            const poData = await poResponse.json();
            toast({
              title: "Orden completada",
              description: `La orden de trabajo se ha marcado como completada y se ha generado la orden de compra ${poData.orderId} para los gastos adicionales.`,
            });
            
            // Almacenar el ID de la OC generada para posible redirección posterior
            sessionStorage.setItem('generatedAdjustmentPOId', poData.purchaseOrderId);
          }
        } catch (poError) {
          console.error("Error al generar orden de compra de ajuste:", poError);
          // No interrumpimos el flujo principal si falla la generación de OC
          toast({
            title: "Orden completada",
            description: "La orden de trabajo se ha marcado como completada. No se pudo generar automáticamente la orden de compra para gastos adicionales.",
          });
        }
      } else {
        toast({
          title: "Orden completada",
          description: "La orden de trabajo se ha marcado como completada",
        });
      }

      // Redirect to the work order details page
      console.log("Redirigiendo a la página de detalles de la orden");
      router.push(`/ordenes/${workOrderId}`);
      router.refresh();
    } catch (error) {
      console.error("Error completing work order:", error);
      toast({
        variant: "destructive",
        title: "Error",
        description: typeof error === 'object' && error instanceof Error 
          ? error.message 
          : "No se pudo completar la orden de trabajo",
      });
    } finally {
      setIsLoading(false);
    }
  }

  // Generate adjustment purchase order for additional expenses
  const generateAdjustmentPO = async () => {
    try {
      setIsLoading(true);
      
      // Get form data for additional expenses
      const formData = form.getValues();
      
      if (!formData.has_additional_expenses || !formData.additional_expenses || formData.additional_expenses.length === 0) {
        toast({
          variant: "destructive",
          title: "Error",
          description: "No hay gastos adicionales para generar una orden de compra"
        });
        return;
      }
      
      // Filter valid expenses
      const validExpenses = formData.additional_expenses.filter(expense => 
        expense.description.trim() !== '' && 
        parseFloat(expense.amount.toString()) > 0 &&
        expense.justification.trim() !== ''
      );
      
      if (validExpenses.length === 0) {
        toast({
          variant: "destructive",
          title: "Error", 
          description: "No hay gastos adicionales válidos para generar una orden de compra"
        });
        return;
      }
      
      // Get purchase order ID from work order if exists
      let originalPurchaseOrderId = null;
      if (workOrder && workOrder.purchase_order_id) {
        originalPurchaseOrderId = workOrder.purchase_order_id;
      }
      
      // Call API to generate adjustment PO
      const response = await fetch('/api/maintenance/generate-adjustment-po', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        credentials: 'include',
        body: JSON.stringify({
          workOrderId,
          originalPurchaseOrderId,
          additionalExpenses: validExpenses,
          supplier: "Gastos Adicionales"
        }),
      });
      
      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || "Error al generar orden de compra de ajuste");
      }
      
      const responseData = await response.json();
      
      toast({
        title: "Orden de compra generada",
        description: `Se ha generado la orden de compra de ajuste ${responseData.orderId} para los gastos adicionales`
      });
      
      // Redirect to the new purchase order
      router.push(`/compras/${responseData.purchaseOrderId}`);
      router.refresh();
      
    } catch (error) {
      console.error("Error generando orden de compra de ajuste:", error);
      toast({
        variant: "destructive",
        title: "Error",
        description: typeof error === 'object' && error instanceof Error 
          ? error.message 
          : "No se pudo generar la orden de compra de ajuste"
      });
    } finally {
      setIsLoading(false);
    }
  };

  if (isLoading && !workOrder) {
    return (
      <div className="flex justify-center items-center h-64">
        <div className="text-center">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary mx-auto"></div>
          <p className="mt-2 text-sm text-muted-foreground">Cargando orden de trabajo...</p>
        </div>
      </div>
    )
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div>
            <CardTitle>Completar Orden de Trabajo</CardTitle>
            <CardDescription>
              Registre los detalles de finalización para la orden {workOrder?.order_id}
            </CardDescription>
          </div>
          <Button variant="outline" size="icon" asChild>
            <Link href={`/ordenes/${workOrderId}`}>
              <ArrowLeft className="h-4 w-4" />
            </Link>
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        {/* Alert for preventive maintenance checklist requirement */}
        {workOrder?.type === MaintenanceType.Preventive && checklistStatus.required && (
          <Alert className={checklistStatus.completed ? "border-green-500" : "border-orange-500"}>
            {checklistStatus.completed ? (
              <CheckCircle className="h-4 w-4 text-green-600" />
            ) : (
              <AlertTriangle className="h-4 w-4 text-orange-600" />
            )}
            <AlertTitle>
              {checklistStatus.completed 
                ? "Checklist de Mantenimiento Completado" 
                : "Checklist de Mantenimiento Requerido"}
            </AlertTitle>
            <AlertDescription>
              {checklistStatus.completed ? (
                <span>El checklist de mantenimiento preventivo ha sido completado correctamente.</span>
              ) : (
                <div className="space-y-2">
                  <span>Esta orden de trabajo preventiva requiere completar un checklist de mantenimiento antes de marcarla como completada.</span>
                  <div className="flex gap-2 mt-2">
                    <Button size="sm" asChild>
                      <Link href={`/checklists/mantenimiento/${workOrderId}`}>
                        <ClipboardCheck className="h-4 w-4 mr-2" />
                        Completar Checklist
                      </Link>
                    </Button>
                  </div>
                </div>
              )}
            </AlertDescription>
          </Alert>
        )}

        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-6 mt-6">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <FormField
                control={form.control}
                name="completion_date"
                render={({ field }) => (
                  <FormItem className="flex flex-col">
                    <FormLabel>Fecha de finalización</FormLabel>
                    <DatePicker
                      date={field.value}
                      setDate={field.onChange}
                    />
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="completion_time"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Hora de finalización</FormLabel>
                    <FormControl>
                      <Input type="time" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>

            <Separator />

            <FormField
              control={form.control}
              name="resolution_details"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Detalles de resolución</FormLabel>
                  <FormControl>
                    <Textarea
                      placeholder="Detalle las acciones realizadas para resolver el problema"
                      className="min-h-[100px]"
                      {...field}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="technician_notes"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Notas del técnico</FormLabel>
                  <FormControl>
                    <Textarea
                      placeholder="Observaciones adicionales del técnico"
                      className="min-h-[80px]"
                      {...field}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
              {maintenanceUnit === 'kilometers' ? (
                <FormField
                  control={form.control}
                  name="equipment_kilometers"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Kilómetros del equipo</FormLabel>
                      <FormControl>
                        <Input 
                          type="number" 
                          min="0" 
                          step="1" 
                          placeholder="Ej: 50000"
                          {...field} 
                          value={field.value || ''}
                          onChange={(e) => field.onChange(e.target.value ? Number(e.target.value) : undefined)}
                        />
                      </FormControl>
                      <FormDescription className="text-xs">
                        Kilómetros registrados en el odómetro
                      </FormDescription>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              ) : (
                <FormField
                  control={form.control}
                  name="equipment_hours"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Horas del equipo</FormLabel>
                      <FormControl>
                        <Input 
                          type="number" 
                          min="0" 
                          step="1" 
                          placeholder="Ej: 1500"
                          {...field} 
                          value={field.value || ''}
                          onChange={(e) => field.onChange(e.target.value ? Number(e.target.value) : undefined)}
                        />
                      </FormControl>
                      <FormDescription className="text-xs">
                        Horas registradas en el horómetro
                      </FormDescription>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              )}

              <FormField
                control={form.control}
                name="downtime_hours"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Horas de inactividad</FormLabel>
                    <FormControl>
                      <Input type="number" min="0" step="0.5" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="labor_hours"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Horas de trabajo</FormLabel>
                    <FormControl>
                      <Input type="number" min="0" step="0.5" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="labor_cost"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Costo de mano de obra</FormLabel>
                    <FormControl>
                      <Input type="number" min="0" step="0.01" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>

            <Separator />

            <div className="space-y-4">
              <div className="flex justify-between items-center">
                <div className="flex items-center gap-3">
                  <h3 className="text-md font-medium">Repuestos utilizados</h3>
                  <Badge variant={
                    costSource === 'confirmed' ? 'default' : 
                    costSource === 'quoted' ? 'secondary' : 'outline'
                  }>
                    {costSource === 'confirmed' ? 'Costos Confirmados' : 
                     costSource === 'quoted' ? 'Costos Cotizados' : 'Costos Estimados'}
                  </Badge>
                  {purchaseOrderId && (
                    <Button variant="outline" size="sm" asChild>
                      <Link href={`/compras/${purchaseOrderId}`} target="_blank">
                        <ExternalLinkIcon className="h-3 w-3 mr-1" />
                        Ver OC
                      </Link>
                    </Button>
                  )}
                </div>
                <div className="text-right">
                  <p className="text-md font-medium">Costo total: ${(Number(form.watch("total_cost")) || 0).toFixed(2)}</p>
                  {costSource !== 'estimated' && (
                    <p className="text-xs text-muted-foreground">
                      {costSource === 'confirmed' ? 'Con comprobantes' : 'Según cotización'}
                    </p>
                  )}
                </div>
              </div>

              {requiredParts.length > 0 ? (
                <div className="border rounded-md p-4">
                  <div className="grid grid-cols-12 gap-2 font-medium text-sm mb-2">
                    <div className="col-span-5">Repuesto</div>
                    <div className="col-span-2">Cantidad</div>
                    <div className="col-span-2">Precio unit.</div>
                    <div className="col-span-3 text-right">Total</div>
                  </div>
                  
                  {requiredParts.map((part, index) => (
                    <div key={index} className="grid grid-cols-12 gap-2 text-sm py-2 border-t">
                      <div className="col-span-5">{part.name || "Repuesto sin nombre"}</div>
                      <div className="col-span-2">{part.quantity}</div>
                      <div className="col-span-2">${(Number(part.unit_price) || 0).toFixed(2)}</div>
                      <div className="col-span-3 text-right">${(Number(part.total_price) || 0).toFixed(2)}</div>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-muted-foreground text-sm">No hay repuestos registrados para esta orden</p>
              )}
            </div>
            
            <Separator />

            {/* Required Tasks Section */}
            {requiredTasks.length > 0 && (
              <div className="space-y-4">
                <div className="flex justify-between items-center">
                  <div>
                    <h3 className="text-md font-medium">Tareas de Mantenimiento</h3>
                    <p className="text-sm text-muted-foreground">
                      Marque las tareas que fueron completadas durante este mantenimiento
                    </p>
                  </div>
                  <Badge variant="outline">
                    {Object.values(completedTasks).filter(Boolean).length} de {requiredTasks.length} completadas
                  </Badge>
                </div>

                <div className="border rounded-md p-4 space-y-4">
                  {requiredTasks.map((task: any) => (
                    <div key={task.id} className="border rounded-md p-4 space-y-3">
                      <div className="flex items-start justify-between">
                        <div className="flex items-start gap-3 flex-1">
                          <Switch
                            checked={completedTasks[task.id] || false}
                            onCheckedChange={(checked) => {
                              setCompletedTasks(prev => ({
                                ...prev,
                                [task.id]: checked
                              }));
                            }}
                          />
                          <div className="flex-1">
                            <div className="flex items-center gap-2">
                              <h4 className="text-sm font-medium">{task.description}</h4>
                              {task.type && (
                                <Badge variant="secondary" className="text-xs">
                                  {task.type}
                                </Badge>
                              )}
                              {task.requires_specialist && (
                                <Badge variant="outline" className="text-xs">
                                  Requiere Especialista
                                </Badge>
                              )}
                            </div>
                            {task.estimated_time && (
                              <p className="text-xs text-muted-foreground mt-1">
                                Tiempo estimado: {task.estimated_time} horas
                              </p>
                            )}
                            {task.parts && task.parts.length > 0 && (
                              <div className="mt-2">
                                <p className="text-xs font-medium text-muted-foreground mb-1">
                                  Repuestos requeridos:
                                </p>
                                <div className="grid grid-cols-1 md:grid-cols-2 gap-1 text-xs text-muted-foreground">
                                  {task.parts.map((part: any, idx: number) => (
                                    <div key={idx} className="flex items-center gap-2">
                                      <span>• {part.name}</span>
                                      {part.part_number && (
                                        <span className="text-muted-foreground/70">
                                          ({part.part_number})
                                        </span>
                                      )}
                                      <span className="font-medium">x{part.quantity}</span>
                                    </div>
                                  ))}
                                </div>
                              </div>
                            )}
                          </div>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            <Separator />
            
            {/* Gastos adicionales */}
            <div className="space-y-4">
              <FormField
                control={form.control}
                name="has_additional_expenses"
                render={({ field }) => (
                  <FormItem className="flex flex-row items-center justify-between">
                    <div className="space-y-0.5">
                      <FormLabel>¿Hubo gastos adicionales?</FormLabel>
                      <FormDescription>
                        Registre gastos adicionales no contemplados en la orden original
                      </FormDescription>
                    </div>
                    <FormControl>
                      <Switch
                        checked={field.value}
                        onCheckedChange={field.onChange}
                      />
                    </FormControl>
                  </FormItem>
                )}
              />

              {form.watch("has_additional_expenses") && (
                <div className="space-y-4 border rounded-md p-4">
                  <div className="flex justify-between items-center">
                    <h3 className="text-md font-medium">Detalle de gastos adicionales</h3>
                    <div className="text-right">
                      <p className="text-sm">
                        Costo de repuestos: ${requiredParts.reduce((sum, part) => sum + (Number(part.total_price) || 0), 0).toFixed(2)}
                      </p>
                      <p className="text-sm">
                        Costo de mano de obra: ${(Number(form.watch("labor_cost")) || 0).toFixed(2)}
                      </p>
                      <p className="text-sm text-muted-foreground">
                        Total adicional: ${(Number(form.watch("additional_expenses_total")) || 0).toFixed(2)}
                      </p>
                    </div>
                  </div>
                  
                  {form.watch("additional_expenses")?.map((_, index) => (
                    <div key={index} className="grid grid-cols-1 gap-4 pt-4 border-t">
                      <div className="flex justify-between items-center">
                        <h4 className="text-sm font-medium">Gasto adicional #{index + 1}</h4>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          onClick={() => removeAdditionalExpense(index)}
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </div>
                      
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                        <FormField
                          control={form.control}
                          name={`additional_expenses.${index}.description`}
                          render={({ field }) => (
                            <FormItem>
                              <FormLabel>Descripción</FormLabel>
                              <FormControl>
                                <Input placeholder="Descripción del gasto" {...field} />
                              </FormControl>
                              <FormMessage />
                            </FormItem>
                          )}
                        />
                        
                        <FormField
                          control={form.control}
                          name={`additional_expenses.${index}.amount`}
                          render={({ field }) => (
                            <FormItem>
                              <FormLabel>Monto</FormLabel>
                              <FormControl>
                                <Input 
                                  type="number" 
                                  min="0.01" 
                                  step="0.01" 
                                  placeholder="0.00" 
                                  {...field} 
                                />
                              </FormControl>
                              <FormMessage />
                            </FormItem>
                          )}
                        />
                      </div>
                      
                      <FormField
                        control={form.control}
                        name={`additional_expenses.${index}.justification`}
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel>Justificación</FormLabel>
                            <FormControl>
                              <Textarea
                                placeholder="Explique por qué fue necesario este gasto adicional"
                                className="min-h-[80px]"
                                {...field}
                              />
                            </FormControl>
                            <FormMessage />
                          </FormItem>
                        )}
                      />
                    </div>
                  ))}
                  
                  <Button
                    type="button"
                    variant="outline"
                    className="w-full mt-2"
                    onClick={addAdditionalExpense}
                  >
                    <Plus className="h-4 w-4 mr-2" />
                    Agregar gasto adicional
                  </Button>
                </div>
              )}
            </div>

            <Separator />

            {/* Evidence Section */}
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <div>
                  <h3 className="text-md font-medium">Evidencia de Finalización</h3>
                  <p className="text-sm text-muted-foreground">
                    Suba fotografías y documentos que demuestren la finalización exitosa del trabajo
                  </p>
                </div>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => setShowEvidenceDialog(true)}
                  className="flex items-center gap-2"
                >
                  <Camera className="h-4 w-4" />
                  Agregar Evidencia
                </Button>
              </div>

              {completionEvidence.length > 0 && (
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                  {completionEvidence.map((evidence) => (
                    <Card key={evidence.id} className="overflow-hidden">
                      <div className="aspect-video relative bg-muted">
                        {evidence.url.includes('image') || evidence.url.match(/\.(jpeg|jpg|gif|png|webp)$/i) ? (
                          <img
                            src={evidence.url}
                            alt={evidence.description}
                            className="w-full h-full object-cover"
                          />
                        ) : (
                          <div className="w-full h-full flex items-center justify-center">
                            <FileText className="h-8 w-8 text-muted-foreground" />
                          </div>
                        )}
                        <Badge 
                          variant="secondary" 
                          className="absolute top-2 left-2 text-xs"
                        >
                          {evidence.category}
                        </Badge>
                      </div>
                      <CardContent className="p-3">
                        <p className="text-sm font-medium truncate">
                          {evidence.description}
                        </p>
                        <p className="text-xs text-muted-foreground mt-1">
                          {new Date(evidence.uploaded_at).toLocaleDateString()}
                        </p>
                      </CardContent>
                    </Card>
                  ))}
                </div>
              )}

              {completionEvidence.length === 0 && (
                <div className="border-2 border-dashed border-muted-foreground/25 rounded-lg p-8 text-center">
                  <Camera className="h-8 w-8 text-muted-foreground mx-auto mb-2" />
                  <p className="text-sm text-muted-foreground">
                    No se ha agregado evidencia de finalización
                  </p>
                  <p className="text-xs text-muted-foreground">
                    Se recomienda incluir fotos del trabajo completado
                  </p>
                </div>
              )}
            </div>
            
            <CardFooter className="px-0 pt-4 flex flex-col">
              <div className="flex justify-end gap-2 w-full">
                <Button variant="outline" asChild>
                  <Link href={`/ordenes/${workOrderId}`}>Cancelar</Link>
                </Button>
                <Button 
                  type="submit" 
                  disabled={isLoading || (checklistStatus.required && !checklistStatus.completed)}
                >
                  {isLoading ? (
                    <>
                      <Clock className="mr-2 h-4 w-4 animate-spin" />
                      Procesando...
                    </>
                  ) : (
                    <>
                      <CheckCircle className="mr-2 h-4 w-4" />
                      Marcar como completada
                    </>
                  )}
                </Button>
              </div>
              {checklistStatus.required && !checklistStatus.completed && (
                <p className="text-sm text-orange-600 mt-2">
                  * Debe completar el checklist de mantenimiento antes de finalizar la orden
                </p>
              )}
              {Object.keys(form.formState.errors).length > 0 && (
                <div className="mt-4 p-3 border border-destructive rounded-md bg-destructive/10 text-sm">
                  <p className="font-semibold mb-1">Por favor, corrige los siguientes errores:</p>
                  <ul className="list-disc list-inside">
                    {Object.entries(form.formState.errors).map(([field, error]) => (
                      <li key={field}>
                        {field}: {error?.message}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </CardFooter>
          </form>
        </Form>
      </CardContent>

      <EvidenceUpload
        open={showEvidenceDialog}
        onOpenChange={setShowEvidenceDialog}
        evidence={completionEvidence}
        setEvidence={setCompletionEvidence}
        context="completion"
        workOrderId={workOrderId}
        title="Evidencia de Finalización"
        description="Suba fotografías del trabajo completado, partes reemplazadas, recibos y cualquier documentación relevante"
      />
    </Card>
  )
} 