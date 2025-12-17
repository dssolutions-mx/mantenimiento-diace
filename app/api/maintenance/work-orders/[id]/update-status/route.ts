import { createClient } from "@/lib/supabase";
import { NextRequest, NextResponse } from "next/server";
import { WorkOrderStatus, PurchaseOrderStatus } from "@/types";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const supabase = createClient();
    const { purchaseOrderStatus } = await request.json();
    const { id: workOrderId } = await params;

    // Verify that the work order exists
    const { data: workOrder, error: workOrderError } = await supabase
      .from("work_orders")
      .select("*")
      .eq("id", workOrderId)
      .single();

    if (workOrderError) {
      return NextResponse.json(
        { error: "Work order not found" },
        { status: 404 }
      );
    }

    // Map purchase order status to work order status
    let newWorkOrderStatus;
    
    switch (purchaseOrderStatus) {
      case PurchaseOrderStatus.Pending:
        newWorkOrderStatus = WorkOrderStatus.Quoted;
        break;
      case PurchaseOrderStatus.Approved:
        newWorkOrderStatus = WorkOrderStatus.Approved;
        break;
      case PurchaseOrderStatus.Ordered:
        newWorkOrderStatus = "Esperando Partes"; // Could be added to WorkOrderStatus enum
        break;
      case PurchaseOrderStatus.Received:
        newWorkOrderStatus = WorkOrderStatus.InProgress;
        break;
      case PurchaseOrderStatus.Rejected:
        // If PO is rejected, revert to Pending status
        newWorkOrderStatus = WorkOrderStatus.Pending;
        break;
      default:
        // Don't change status if PO status is unknown
        return NextResponse.json(
          { error: "Invalid purchase order status" },
          { status: 400 }
        );
    }

    // Update work order status
    const { data, error } = await supabase
      .from("work_orders")
      .update({ status: newWorkOrderStatus, updated_at: new Date().toISOString() })
      .eq("id", workOrderId)
      .select()
      .single();

    if (error) {
      console.error("Failed to update work order status:", error);
      return NextResponse.json(
        { error: "Failed to update work order status" },
        { status: 500 }
      );
    }

    // If the new status represents completion, update related incident to Resuelto
    const completedStatuses = ['Completada', WorkOrderStatus.Completed, 'Verified', 'Verificado'];
    if (completedStatuses.includes(newWorkOrderStatus as any)) {
      try {
        // Prefer updating by incident_id if present; fallback to work_order_id
        const { data: woDetails } = await supabase
          .from('work_orders')
          .select('incident_id')
          .eq('id', workOrderId)
          .single();

        const query = woDetails?.incident_id
          ? supabase.from('incident_history').update({ status: 'Resuelto', updated_at: new Date().toISOString() }).eq('id', woDetails.incident_id)
          : supabase.from('incident_history').update({ status: 'Resuelto', updated_at: new Date().toISOString() }).eq('work_order_id', workOrderId);

        await query;
      } catch (_) {
        // non-blocking
      }
    }

    return NextResponse.json({ 
      success: true, 
      data,
      message: `Work order status updated to ${newWorkOrderStatus}` 
    });
  } catch (error) {
    console.error("Error updating work order status:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
} 