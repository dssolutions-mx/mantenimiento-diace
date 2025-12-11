import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase'

interface RouteParams {
  params: Promise<{
    id: string
  }>
}

export async function POST(
  request: NextRequest,
  { params }: RouteParams
) {
  try {
    const supabase = createClient()
    const { id: workOrderId } = await params

    // Get the authenticated user
    const { data: { user }, error: authError } = await supabase.auth.getUser()

    if (authError || !user) {
      return NextResponse.json(
        { error: 'Authentication required' },
        { status: 401 }
      )
    }

    const body = await request.json()
    const { supplier_id, notes } = body

    if (!supplier_id) {
      return NextResponse.json(
        { error: 'Supplier ID is required' },
        { status: 400 }
      )
    }

    // Verify the work order exists and user has permission to update it
    const { data: workOrder, error: workOrderError } = await supabase
      .from('work_orders')
      .select('id, assigned_to, requested_by, status')
      .eq('id', workOrderId)
      .single()

    if (workOrderError) {
      if (workOrderError.code === 'PGRST116') {
        return NextResponse.json(
          { error: 'Work order not found' },
          { status: 404 }
        )
      }

      console.error('Error fetching work order:', workOrderError)
      return NextResponse.json(
        { error: 'Error fetching work order' },
        { status: 500 }
      )
    }

    // Check permissions - user must be the requester or assigned technician
    if (workOrder.requested_by !== user.id && workOrder.assigned_to !== user.id) {
      return NextResponse.json(
        { error: 'Permission denied' },
        { status: 403 }
      )
    }

    // Update the work order with supplier assignment
    const { data: updatedWorkOrder, error } = await supabase
      .from('work_orders')
      .update({
        assigned_supplier_id: supplier_id,
        supplier_notes: notes,
        supplier_assignment_date: new Date().toISOString(),
        supplier_assignment_by: user.id,
        updated_by: user.id
      })
      .eq('id', workOrderId)
      .select(`
        *,
        assigned_supplier:suppliers(*)
      `)
      .single()

    if (error) {
      console.error('Error assigning supplier to work order:', error)
      return NextResponse.json(
        { error: 'Error assigning supplier', details: error.message },
        { status: 500 }
      )
    }

    // Log the supplier assignment in work history
    await supabase
      .from('supplier_work_history')
      .insert({
        supplier_id: supplier_id,
        work_order_id: workOrderId,
        work_type: workOrder.type || 'maintenance',
        total_cost: 0, // Will be updated when work is completed
        created_at: new Date().toISOString()
      })

    return NextResponse.json({
      success: true,
      work_order: updatedWorkOrder,
      message: 'Supplier assigned successfully'
    })

  } catch (error) {
    console.error('Error in work order supplier assignment API:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}
