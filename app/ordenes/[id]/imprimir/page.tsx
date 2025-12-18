import { createClient } from "@/lib/supabase-server"
import { notFound } from "next/navigation"
import { WorkOrderPrintDocument } from "@/components/work-orders/work-order-print-document"
import type { WorkOrderComplete, Profile } from "@/types"

interface PrintPageProps {
  params: Promise<{
    id: string
  }>
}

export default async function WorkOrderPrintPage({
  params,
}: PrintPageProps) {
  const { id } = await params
  
  const supabase = await createClient()

  // Fetch work order with related data
  const { data: workOrder, error } = await supabase
    .from("work_orders")
    .select(`
      *,
      asset:assets (*)
    `)
    .eq("id", id)
    .single()
    
  // Fetch ALL purchase orders related to this work order (including adjustments)
  const { data: allPurchaseOrders } = await supabase
    .from("purchase_orders") 
    .select("*")
    .eq("work_order_id", id)
    .order("created_at", { ascending: true })

  if (error || !workOrder) {
    notFound()
  }
  
  const extendedWorkOrder = workOrder as unknown as WorkOrderComplete

  // Fetch technician and requester details
  const profiles: Record<string, Profile> = {}
  
  if (extendedWorkOrder.requested_by) {
    const { data: requester } = await supabase
      .from("profiles")
      .select("*")
      .eq("id", extendedWorkOrder.requested_by)
      .single()
      
    if (requester) {
      profiles[extendedWorkOrder.requested_by] = requester
    }
  }
  
  if (extendedWorkOrder.assigned_to) {
    const { data: technician } = await supabase
      .from("profiles")
      .select("*")
      .eq("id", extendedWorkOrder.assigned_to)
      .single()
      
    if (technician) {
      profiles[extendedWorkOrder.assigned_to] = technician
    }
  }

  // Parse required parts
  const originalRequiredParts = extendedWorkOrder.required_parts 
    ? typeof extendedWorkOrder.required_parts === 'string'
      ? JSON.parse(extendedWorkOrder.required_parts)
      : extendedWorkOrder.required_parts
    : []
  
  const sanitizedRequiredParts = originalRequiredParts.map((part: any) => ({
    ...part,
    quantity: Number(part.quantity) || 1,
    unit_price: Number(part.unit_price) || 0,
    total_price: Number(part.total_price) || (Number(part.quantity) || 1) * (Number(part.unit_price) || 0)
  }))

  // Calculate total parts cost
  const totalPartsCost = sanitizedRequiredParts.length > 0
    ? sanitizedRequiredParts.reduce((total: number, part: any) => total + (Number(part.total_price) || 0), 0)
    : 0

  // Parse required tasks
  const requiredTasks = extendedWorkOrder.required_tasks
    ? typeof extendedWorkOrder.required_tasks === 'string'
      ? JSON.parse(extendedWorkOrder.required_tasks)
      : extendedWorkOrder.required_tasks
    : []

  return (
    <WorkOrderPrintDocument
      workOrder={extendedWorkOrder}
      asset={extendedWorkOrder.asset}
      purchaseOrders={allPurchaseOrders || []}
      profiles={profiles}
      requiredParts={sanitizedRequiredParts}
      totalPartsCost={totalPartsCost}
      requiredTasks={requiredTasks}
    />
  )
}

