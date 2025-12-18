import { createClient } from "@/lib/supabase"
import { InsertMaintenanceHistory, WorkOrderStatus } from "@/types"
import { NextResponse } from "next/server"
import { SupabaseClient } from "@supabase/supabase-js"
import { cookies } from "next/headers"
import { createServerClient } from "@supabase/ssr"

// Define a type for any table access to bypass TypeScript checking
interface AnyTable {
  from(table: string): any;
}

export async function POST(request: Request) {
  try {
    console.log("API: Iniciando procesamiento de solicitud work-completions")
    
    // Usar createServerClient en lugar de createClient para rutas de API
    const cookieStore = await cookies()
    console.log("API: Cookie store obtenido")
    
    const supabase = createServerClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      {
        cookies: {
          getAll() {
            const allCookies = cookieStore.getAll()
            console.log("API: Cookies disponibles:", allCookies.map(c => c.name).join(", "))
            return allCookies
          },
          setAll(cookiesToSet) {
            try {
              cookiesToSet.forEach(({ name, value, options }) =>
                cookieStore.set(name, value, options)
              )
            } catch (error) {
              console.error("API: Error al establecer cookies:", error)
              // The `setAll` method was called from a Server Component.
              // This can be ignored if you have middleware refreshing
              // user sessions.
            }
          },
        },
      }
    )
    
    // Verificar si hay una sesión activa
    console.log("API: Verificando sesión de usuario")
    const { data: sessionData, error: sessionError } = await supabase.auth.getSession()
    
    if (sessionError) {
      console.error("API: Error al obtener la sesión:", sessionError)
      return NextResponse.json(
        { error: `Error de autenticación: ${sessionError.message}` },
        { status: 401 }
      )
    }
    
    console.log("API: Datos de sesión:", sessionData ? "Presente" : "Ausente", 
      "Usuario:", sessionData?.session?.user?.email || "No disponible")

    if (!sessionData.session?.user) {
      console.error("API: Usuario no autenticado en la API /api/maintenance/work-completions")
      return NextResponse.json(
        { error: "No autorizado" },
        { status: 401 }
      )
    }

    const data = await request.json()
    const { 
      workOrderId,
      completionData,
      maintenanceHistoryData,
      additionalExpenses,
      checklist_completion
    } = data

    console.log("API recibió los siguientes datos:", JSON.stringify({
      workOrderId,
      completionData: { 
        ...completionData, 
        parts_used: completionData.parts_used 
          ? `Array de ${completionData.parts_used.length} elementos: ${JSON.stringify(completionData.parts_used)}`
          : 'absent' 
      },
      maintenanceHistoryData: maintenanceHistoryData ? 'present' : 'absent',
      additionalExpenses: additionalExpenses ? additionalExpenses.length : 'absent'
    }, null, 2));

    if (!workOrderId || !completionData) {
      return NextResponse.json(
        { error: "Datos incompletos para completar la orden" },
        { status: 400 }
      )
    }
    
    // Verificar que la orden existe y no está ya completada
    const { data: existingOrder, error: checkError } = await supabase
      .from("work_orders")
      .select("id, status, asset_id, purchase_order_id, description, assigned_to")
      .eq("id", workOrderId)
      .single()
      
    if (checkError || !existingOrder) {
      return NextResponse.json(
        { error: "La orden de trabajo no existe" },
        { status: 404 }
      )
    }
    
    if (existingOrder.status === WorkOrderStatus.Completed) {
      return NextResponse.json(
        { error: "La orden de trabajo ya está completada" },
        { status: 400 }
      )
    }

    console.log("API: Procesando datos de la orden de trabajo y las partes usadas");
    
    // Verificar que tenemos acceso a existingOrder antes de continuar
    if (!existingOrder) {
      console.error("Error: No se pudo obtener la orden de trabajo existente");
      return NextResponse.json(
        { error: "No se pudo obtener la orden de trabajo existente" },
        { status: 500 }
      );
    }
    
    // Validar y procesar parts_used para evitar errores
    let formattedPartsUsed = null;
    if (completionData.parts_used) {
      try {
        if (!Array.isArray(completionData.parts_used)) {
          throw new Error("El formato de las partes usadas es incorrecto");
        }
        
        // Mostrar lo que estamos recibiendo para depuración
        console.log("API: Partes usadas recibidas:", 
          JSON.stringify(completionData.parts_used.map((p: any) => ({
            id: p.id || p.part_id,
            name: p.name
          })))
        );
        
        formattedPartsUsed = JSON.stringify(completionData.parts_used);
      } catch (error) {
        console.error("Error formateando parts_used:", error);
        formattedPartsUsed = null;
      }
    }
    
    // Registrar los datos que estamos a punto de insertar
    console.log("API: Actualizando work_order con los siguientes campos:", {
      status: WorkOrderStatus.Completed,
      completed_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      used_parts: formattedPartsUsed ? "present (string)" : "null"
    });
    
    // Actualizar solo los campos que realmente existen en la tabla work_orders
    const updateFields: any = {
      status: WorkOrderStatus.Completed,
      completed_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };
    
    // Intentar agregar used_parts si tenemos datos
    if (formattedPartsUsed) {
      updateFields.used_parts = formattedPartsUsed;
    }
    
    // Add completion photos if provided
    if (completionData.completion_photos && Array.isArray(completionData.completion_photos)) {
      updateFields.completion_photos = JSON.stringify(completionData.completion_photos);
    }
    
    console.log("API: Campos a actualizar en work_orders:", JSON.stringify(updateFields));
    
    try {
      // Actualizar la orden de trabajo
      const { error: updateError } = await supabase
        .from("work_orders")
        .update(updateFields)
        .eq("id", workOrderId);
  
      if (updateError) {
        console.error("Error al actualizar la orden de trabajo:", updateError);
        
        // Si el error es sobre una columna que no existe, intentamos actualizar sin esa columna
        if (updateError.message.includes("column") && updateError.message.toLowerCase().includes("used_parts")) {
          console.log("API: La columna used_parts no existe, intentando actualizar sin ella");
          
          // Eliminar el campo problemático y reintentar
          delete updateFields.used_parts;
          
          const { error: retryError } = await supabase
            .from("work_orders")
            .update(updateFields)
            .eq("id", workOrderId);
            
          if (retryError) {
            console.error("Error en el segundo intento de actualización:", retryError);
            return NextResponse.json(
              { error: `Error al actualizar la orden de trabajo: ${retryError.message}` },
              { status: 500 }
            );
          }
        } else {
          // Si es otro tipo de error, devolver error
          return NextResponse.json(
            { error: `Error al actualizar la orden de trabajo: ${updateError.message}` },
            { status: 500 }
          );
        }
      }
      
      console.log("API: Orden de trabajo actualizada correctamente");
    } catch (error) {
      console.error("Error inesperado al actualizar la orden:", error);
      return NextResponse.json(
        { error: "Error interno al actualizar la orden de trabajo" },
        { status: 500 }
      );
    }
    
    // If maintenance history data is provided, add it
    let maintenanceHistoryId = null;
    if (maintenanceHistoryData) {
      // Get asset to determine maintenance unit
      const { data: assetData } = await supabase
        .from('assets')
        .select('equipment_models(maintenance_unit)')
        .eq('id', existingOrder.asset_id)
        .single();
      
      const maintenanceUnit = (assetData as any)?.equipment_models?.maintenance_unit || 'hours';
      const isKilometers = maintenanceUnit === 'kilometers' || maintenanceUnit === 'kilometres';
      
      // Ensure all completion data is stored in the maintenance history
      const enhancedHistoryData: any = {
        ...maintenanceHistoryData,
        // Add these fields from completionData that aren't stored in work_orders
        downtime_hours: completionData.downtime_hours || 0,
        technician_notes: completionData.technician_notes || '',
        resolution_details: completionData.resolution_details,
        // Override hours/kilometers with equipment_hours/equipment_kilometers from completionData if available
        hours: isKilometers ? null : (completionData.equipment_hours || maintenanceHistoryData.hours || null),
        kilometers: isKilometers ? (completionData.equipment_kilometers || maintenanceHistoryData.kilometers || null) : null,
        // Include completed tasks if provided
        completed_tasks: completionData.completed_tasks || maintenanceHistoryData.completed_tasks || null,
      };

      // Derive required NOT NULL fields for maintenance_history
      // Description: prefer work order description, fallback to resolution details, then a generic text
      enhancedHistoryData.description = existingOrder.description
        || completionData.resolution_details
        || 'Trabajo completado';

      // Technician (NOT NULL): prefer explicit technician from payload; then assigned_to name; then session email
      let technicianName = (completionData.technician && String(completionData.technician).trim()) || '';
      if (!technicianName) {
        if (existingOrder.assigned_to) {
          try {
            const { data: techProfile } = await supabase
              .from("profiles")
              .select("nombre, apellido, full_name")
              .eq("id", existingOrder.assigned_to)
              .single();
            if (techProfile) {
              technicianName = (techProfile.full_name
                || `${techProfile.nombre || ''} ${techProfile.apellido || ''}`.trim()
              ) || '';
            }
          } catch (_) {
            // ignore and fallback
          }
        }
      }
      if (!technicianName) {
        technicianName = sessionData.session.user.email || 'Técnico';
      }
      enhancedHistoryData.technician = technicianName;
      // Optional: link technician_id and work_order_id when available
      if (existingOrder.assigned_to) {
        enhancedHistoryData.technician_id = existingOrder.assigned_to;
      }
      enhancedHistoryData.work_order_id = workOrderId;
      
      console.log("API: Guardando datos en maintenance_history:", JSON.stringify({
        asset_id: enhancedHistoryData.asset_id,
        date: enhancedHistoryData.date,
        type: enhancedHistoryData.type,
        maintenance_unit: maintenanceUnit,
        hours: enhancedHistoryData.hours || (isKilometers ? 'null (using kilometers)' : 'no_hours_provided'),
        kilometers: enhancedHistoryData.kilometers || (isKilometers ? 'no_kilometers_provided' : 'null (using hours)'),
        labor_hours: enhancedHistoryData.labor_hours,
        maintenance_plan_id: enhancedHistoryData.maintenance_plan_id || null,
        completed_tasks_count: enhancedHistoryData.completed_tasks ? (Array.isArray(enhancedHistoryData.completed_tasks) ? enhancedHistoryData.completed_tasks.length : 1) : 0
      }));
      
      const { data: historyData, error: historyError } = await supabase
        .from("maintenance_history")
        .insert(enhancedHistoryData)
        .select("id")
        .single()

      if (historyError) {
        console.error("Error al agregar historial de mantenimiento:", historyError)
        // We don't fail the entire process if history update fails
      } else {
        maintenanceHistoryId = historyData?.id;
      }
    }

    // Save checklist completion if provided
    if (checklist_completion) {
      try {
        // @ts-ignore - Table created in recent migration
        const { error: checklistError } = await supabase
          .from('maintenance_checklists')
          .upsert({
            ...checklist_completion,
            updated_at: new Date().toISOString()
          }, {
            onConflict: 'work_order_id'
          })

        if (checklistError) {
          console.error("Error al guardar checklist de mantenimiento:", checklistError)
          // Don't fail the entire process if checklist save fails
        } else {
          // Update work order to mark checklist as completed
          await supabase
            .from('work_orders')
            .update({ preventive_checklist_completed: true })
            .eq('id', workOrderId)
        }
      } catch (checklistErr) {
        console.error("Error procesando checklist:", checklistErr)
        // Don't fail the entire process
      }
    }

    // Process additional expenses if there are any
    let additionalExpenseIds = [];
    let requiresAdjustment = false;
    
    if (additionalExpenses && additionalExpenses.length > 0) {
      // Calculate total of additional expenses
      const totalAdditionalExpenses = additionalExpenses.reduce(
        (sum: number, expense: any) => sum + (parseFloat(expense.amount) || 0), 
        0
      );
      
      // Get a direct connection to any table to avoid TypeScript errors
      const anyDb = supabase as unknown as AnyTable;
      
      // Insert additional expenses records
      for (const expense of additionalExpenses) {
        const { data: expenseData, error: expenseError } = await anyDb
          .from('additional_expenses')
          .insert({
            work_order_id: workOrderId,
            description: expense.description,
            amount: expense.amount,
            justification: expense.justification,
            created_by: sessionData.session.user.id,
            created_at: new Date().toISOString(),
            asset_id: existingOrder.asset_id,
            status: "pendiente_aprobacion"  // Pending approval by default
          })
          .select("id")
          .single();
          
        if (expenseError) {
          console.error("Error al registrar gasto adicional:", expenseError);
        } else if (expenseData) {
          additionalExpenseIds.push(expenseData.id);
        }
      }
      
      // Flag that purchase order adjustment is required
      if (additionalExpenseIds.length > 0 && existingOrder.purchase_order_id) {
        requiresAdjustment = true;
        
        // Mark the purchase order as requiring adjustment
        const { error: poUpdateError } = await supabase
          .from("purchase_orders")
          .update({
            requires_adjustment: true,
            adjustment_amount: totalAdditionalExpenses,
            adjustment_reason: "Gastos adicionales en orden de trabajo",
            updated_at: new Date().toISOString(),
            adjustment_status: "pendiente"
          })
          .eq("id", existingOrder.purchase_order_id);
          
        if (poUpdateError) {
          console.error("Error al marcar orden de compra para ajuste:", poUpdateError);
        }
      }
    }

    // Create a service order (DB will assign order_id via trigger)
    let serviceOrderId = null;
    
    try {
      // First get the work order details to copy
      const { data: workOrder, error: getWorkOrderError } = await supabase
        .from("work_orders")
        .select("*, asset:assets(*)")
        .eq("id", workOrderId)
        .single();
        
      if (getWorkOrderError || !workOrder) {
        throw new Error("Error fetching work order details");
      }
      
      // order_id will be generated in DB trigger; do not generate in app
      
      // Calculate parts cost
      let partsCost = 0;
      if (workOrder.required_parts) {
        const parts = typeof workOrder.required_parts === 'string'
          ? JSON.parse(workOrder.required_parts)
          : workOrder.required_parts;
          
        partsCost = parts.reduce((sum: number, part: any) => {
          return sum + (parseFloat(part.total_price) || 0);
        }, 0);
      }
      
      // Calculate additional expenses cost
      let additionalExpensesCost = 0;
      if (additionalExpenses && additionalExpenses.length > 0) {
        additionalExpensesCost = additionalExpenses.reduce(
          (sum: number, expense: any) => sum + (parseFloat(expense.amount) || 0), 
          0
        );
      }
      
      // Calculate total cost
      const laborCost = parseFloat(completionData.labor_cost || '0');
      const totalCost = laborCost + partsCost + additionalExpensesCost;
      
      // Get technician name
      let technicianName = "No asignado";
      if (workOrder.assigned_to) {
        const { data: techData } = await supabase
          .from("profiles")
          .select("nombre, apellido")
          .eq("id", workOrder.assigned_to)
          .single();
          
        if (techData) {
          technicianName = `${techData.nombre || ''} ${techData.apellido || ''}`.trim();
        }
      }
      
      // Insert the service order
      try {
        const serviceOrderData: any = {
          asset_id: workOrder.asset_id,
          asset_name: workOrder.asset?.name || 'Activo sin nombre',
          description: `Servicio completado: ${workOrder.description}`,
          type: workOrder.type,
          priority: workOrder.priority,
          status: "Completado",
          work_order_id: workOrderId,
          date: new Date().toISOString(),
          completion_date: completionData.completion_date || new Date().toISOString(),
          technician_id: workOrder.assigned_to,
          technician: technicianName,
          labor_hours: completionData.labor_hours || 0,
          labor_cost: laborCost.toString(),
          parts_cost: partsCost.toString(),
          additional_expenses: additionalExpensesCost.toString(),
          total_cost: totalCost.toString(),
          findings: completionData.technician_notes || null,
          actions: completionData.resolution_details,
          created_by: sessionData.session.user.id,
          has_additional_expenses: additionalExpenses && additionalExpenses.length > 0,
          requires_adjustment: requiresAdjustment
        };
        
        // Si la tabla service_orders tiene un campo para almacenar partes usadas, incluir los datos
        if (formattedPartsUsed) {
          // @ts-ignore
          serviceOrderData.parts = formattedPartsUsed;
        }
        
        console.log("API: Creando orden de servicio con datos:", {
          asset_id: serviceOrderData.asset_id,
          description: serviceOrderData.description.substring(0, 30) + "..."
        });
        
        const { data: serviceOrder, error: insertError } = await supabase
          .from("service_orders")
          .insert(serviceOrderData)
          .select("id")
          .single();
          
        if (insertError) {
          // Si hay error en la inserción, podría ser por campos que no existen
          console.error("Error creating service order:", insertError);
          
          // Intentar determinar qué campo está causando el error
          if (insertError.message.includes("column") && insertError.message.includes("not exist")) {
            const errorMsg = insertError.message.toLowerCase();
            const essentialFields = {
              order_id: true,
              asset_id: true,
              description: true,
              status: true,
              work_order_id: true,
              date: true,
              created_by: true
            };
            
            // Crear un objeto con solo los campos esenciales
            const reducedData: any = {};
            for (const key in essentialFields) {
              // @ts-ignore
              reducedData[key] = serviceOrderData[key];
            }
            
            console.log("API: Reintentando crear orden de servicio con campos reducidos");
            
            // Reintentar con solo los campos esenciales
            const { data: retryServiceOrder, error: retryError } = await supabase
              .from("service_orders")
              .insert(reducedData)
              .select("id")
              .single();
              
            if (retryError) {
              throw new Error(`Error al reintentar: ${retryError.message}`);
            }
            
            serviceOrderId = retryServiceOrder.id;
          } else {
            throw new Error(`Error creating service order: ${insertError.message}`);
          }
        } else {
          serviceOrderId = serviceOrder.id;
        }
      } catch (error) {
        console.error("Error creating service order:", error);
        // Continue despite service order creation failure
      }
      
      // Link service order back to work order
      try {
        const { error: linkError } = await supabase
          .from("work_orders")
          .update({ 
            service_order_id: serviceOrderId,
            updated_at: new Date().toISOString()
          })
          .eq("id", workOrderId);
          
        if (linkError) {
          console.error("Error linking service order to work order:", linkError);
          // If the error is about missing column, log it but continue
          if (linkError.message.includes("column") && linkError.message.includes("not exist")) {
            console.log("API: El campo service_order_id no existe en la tabla work_orders. Es necesario ejecutar la migración.");
          }
        }
      } catch (error) {
        console.error("Error al intentar vincular la orden de servicio:", error);
        // Continue anyway
      }
    } catch (error) {
      console.error("Error creating service order:", error);
      // Continue despite service order creation failure
    }

    // ✅ SOLUCIÓN: Actualizar estado del incidente cuando se completa una orden de trabajo correctiva
    let incidentUpdateResult = null;
    try {
      // Obtener la orden de trabajo para verificar si es correctiva y tiene incidente asociado
      const { data: workOrderDetails, error: workOrderError } = await supabase
        .from("work_orders")
        .select("type, incident_id")
        .eq("id", workOrderId)
        .single();

      if (!workOrderError && workOrderDetails) {
        console.log("API: Verificando si necesita actualizar incidente:", {
          type: workOrderDetails.type,
          incident_id: workOrderDetails.incident_id
        });

        // Si es una orden correctiva, buscar incidentes asociados para actualizar
        if (workOrderDetails.type === 'corrective') {
          let incidentUpdateQuery;
          
          // Buscar por incident_id si existe, sino por work_order_id
          if (workOrderDetails.incident_id) {
            incidentUpdateQuery = supabase
              .from("incident_history")
              .update({ 
                status: 'Resuelto',
                resolution: completionData.resolution_details || 'Trabajo completado exitosamente',
                updated_at: new Date().toISOString(),
                updated_by: sessionData.session.user.id
              })
              .eq('id', workOrderDetails.incident_id);
          } else {
            // Buscar incidentes que tengan esta orden de trabajo asociada
            incidentUpdateQuery = supabase
              .from("incident_history")
              .update({ 
                status: 'Resuelto',
                resolution: completionData.resolution_details || 'Trabajo completado exitosamente',
                updated_at: new Date().toISOString(),
                updated_by: sessionData.session.user.id
              })
              .eq('work_order_id', workOrderId);
          }

          const { data: updatedIncidents, error: incidentError } = await incidentUpdateQuery
            .select('id, status');

          if (incidentError) {
            console.error("Error al actualizar estado del incidente:", incidentError);
            // No fallar todo el proceso por este error
          } else if (updatedIncidents && updatedIncidents.length > 0) {
            console.log("API: ✅ Incidentes actualizados a 'Cerrado':", updatedIncidents.map(i => i.id));
            incidentUpdateResult = {
              updated: true,
              count: updatedIncidents.length,
              incidents: updatedIncidents
            };
          } else {
            console.log("API: No se encontraron incidentes para actualizar");
            incidentUpdateResult = {
              updated: false,
              reason: "No incidents found"
            };
          }
        } else {
          console.log("API: Orden no es correctiva, no se actualiza incidente");
          incidentUpdateResult = {
            updated: false,
            reason: "Not corrective work order"
          };
        }
      }
    } catch (error) {
      console.error("Error al intentar actualizar incidente:", error);
      // No fallar todo el proceso por este error
      incidentUpdateResult = {
        updated: false,
        error: error instanceof Error ? error.message : String(error)
      };
    }
    
    return NextResponse.json({
      message: "Orden de trabajo completada con éxito",
      serviceOrderId,
      maintenanceHistoryId,
      additionalExpenseIds,
      requiresAdjustment,
      incidentUpdate: incidentUpdateResult
    })
  } catch (error) {
    console.error("Error al procesar la petición:", error)
    return NextResponse.json(
      { error: "Error interno al procesar la petición" },
      { status: 500 }
    )
  }
} 