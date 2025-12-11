import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase-server'

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params
    const supabase = await createClient()
    
    // Check if user is authenticated
    const { data: { user }, error: authError } = await supabase.auth.getUser()
    if (authError || !user) {
      return NextResponse.json({ error: 'No autorizado' }, { status: 401 })
    }

    // Get purchase order details
    const { data: purchaseOrder, error } = await supabase
      .from('purchase_orders')
      .select('*')
      .eq('id', id)
      .single()

    if (error) {
      console.error('Error fetching purchase order:', error)
      return NextResponse.json({ error: 'Purchase order not found' }, { status: 404 })
    }

    return NextResponse.json(purchaseOrder)

  } catch (error) {
    console.error('Error in GET /api/purchase-orders/[id]:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params
    const body = await request.json()
    const supabase = await createClient()
    
    // Check if user is authenticated
    const { data: { user }, error: authError } = await supabase.auth.getUser()
    if (authError || !user) {
      return NextResponse.json({ error: 'No autorizado' }, { status: 401 })
    }

    // Prepare update object for purchase order
    const updateData: any = {}
    
    if (body.actual_amount !== undefined) {
      updateData.actual_amount = body.actual_amount
      updateData.purchased_at = new Date().toISOString()
    }

    // Editable fields
    const editableFields = [
      'supplier',
      'total_amount',
      'payment_method',
      'notes',
      'store_location',
      'service_provider',
      'quotation_url',
      'quotation_urls',
      'purchase_date',
      'max_payment_date',
      'items'
    ] as const

    editableFields.forEach((field) => {
      if (Object.prototype.hasOwnProperty.call(body, field)) {
        // Ensure quotation_urls remains a JSONB array (do NOT stringify)
        if (field === 'quotation_urls') {
          const value = body[field]
          if (value === null) {
            updateData[field] = null
          } else if (Array.isArray(value)) {
            updateData[field] = value
          } else if (typeof value === 'string' && value.trim().length > 0) {
            updateData[field] = [value]
          } else {
            // fallback to empty array for invalid types
            updateData[field] = []
          }
        } else if (field === 'purchase_date' || field === 'max_payment_date') {
          // Handle date fields - convert empty strings to null, ensure proper format
          const value = body[field]
          if (value === null || value === '' || value === undefined) {
            updateData[field] = null
          } else {
            // Handle both YYYY-MM-DD format (from date inputs) and ISO format
            let dateValue: Date
            if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
              // YYYY-MM-DD format - create date at midnight UTC
              dateValue = new Date(value + 'T00:00:00.000Z')
            } else {
              // Try parsing as ISO or other date format
              dateValue = new Date(value)
            }
            
            if (isNaN(dateValue.getTime())) {
              console.warn(`Invalid date value for ${field}:`, value)
              // Skip invalid dates - don't include in updateData
            } else {
              updateData[field] = dateValue.toISOString()
            }
          }
        } else {
          updateData[field] = body[field]
        }
      }
    })

    // Remove posting_date if it was accidentally included (it's a generated column)
    if ('posting_date' in updateData) {
      delete updateData.posting_date
    }

    // Handle receipt upload separately - prevent duplicates
    if (body.receipt_url) {
      // Check if a receipt with this URL already exists
      const { data: existingReceipt, error: checkError } = await supabase
        .from('purchase_order_receipts')
        .select('id')
        .eq('purchase_order_id', id)
        .eq('file_url', body.receipt_url)
        .single()

      // Only insert if receipt doesn't exist
      if (!existingReceipt && !checkError) {
        const { error: receiptError } = await supabase
          .from('purchase_order_receipts')
          .insert({
            purchase_order_id: id,
            file_url: body.receipt_url,
            expense_type: 'purchase',
            description: 'Comprobante de compra',
            uploaded_by: user.id,
          })

        if (receiptError) {
          console.error('Error inserting receipt:', receiptError)
          return NextResponse.json({ error: 'Failed to save receipt' }, { status: 500 })
        }
      }
      // If receipt already exists, we just continue without error
    }

    // Update purchase order if there are changes
    let updatedOrder = null
    if (Object.keys(updateData).length > 0) {
      const { data, error } = await supabase
        .from('purchase_orders')
        .update(updateData)
        .eq('id', id)
        .select()
        .single()

      if (error) {
        console.error('Error updating purchase order:', error)
        console.error('Update data:', JSON.stringify(updateData, null, 2))
        console.error('Error details:', {
          message: error.message,
          details: error.details,
          hint: error.hint,
          code: error.code
        })
        // Map specific validation related to payment date when method is transfer
        if (
          typeof error.message === 'string' &&
          error.message.includes('max_payment_date cannot be in the past')
        ) {
          return NextResponse.json({
            success: false,
            error: 'Error de validación de fecha de pago',
            details: 'La fecha máxima de pago no puede estar en el pasado cuando el método de pago es transferencia.',
            requires_fix: true,
            fix_type: 'payment_date'
          }, { status: 400 })
        }
        // Check for generated column errors
        if (
          typeof error.message === 'string' &&
          (error.message.includes('posting_date') || error.message.includes('cannot be updated'))
        ) {
          return NextResponse.json({ 
            error: 'No se puede actualizar posting_date directamente', 
            details: 'La fecha de publicación se calcula automáticamente basada en purchase_date, actual_delivery_date, approval_date o created_at.' 
          }, { status: 400 })
        }
        return NextResponse.json({ 
          error: 'Failed to update purchase order', 
          details: error.message || 'Unknown error',
          code: error.code
        }, { status: 500 })
      }
      // Cascade: if actual_amount provided and PO is linked to a work order or service order, update related totals
      try {
        if (updateData.actual_amount !== undefined) {
          // Load linkage
          const { data: poLink } = await supabase
            .from('purchase_orders')
            .select('work_order_id')
            .eq('id', id)
            .single()

          // Update service order total_cost if linked through work order
          if (poLink?.work_order_id) {
            const { data: wo } = await supabase
              .from('work_orders')
              .select('id, service_order_id')
              .eq('id', poLink.work_order_id)
              .single()

            if (wo?.service_order_id) {
              // Increment service order total_cost by actual_amount (or set if null)
              const { data: so } = await supabase
                .from('service_orders')
                .select('total_cost')
                .eq('id', wo.service_order_id)
                .single()

              const currentTotal = Number(so?.total_cost || 0)
              const nextTotal = currentTotal + Number(updateData.actual_amount || 0)

              await supabase
                .from('service_orders')
                .update({ total_cost: nextTotal })
                .eq('id', wo.service_order_id)
            }
          }
        }
      } catch (cascadeError) {
        console.warn('Non-blocking: failed to cascade actual_amount to related orders', cascadeError)
      }

      updatedOrder = data
    }

    return NextResponse.json({
      success: true,
      data: updatedOrder,
      message: 'Purchase order updated successfully'
    })

  } catch (error: any) {
    console.error('Error in PATCH /api/purchase-orders/[id]:', error)
    console.error('Error stack:', error?.stack)
    console.error('Request body:', body)
    return NextResponse.json({ 
      error: 'Internal server error', 
      details: error?.message || 'Unknown error',
      type: error?.name || 'Error'
    }, { status: 500 })
  }
} 