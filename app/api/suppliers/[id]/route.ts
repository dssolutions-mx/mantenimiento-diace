import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase-server'
import { UpdateSupplierRequest } from '@/types/suppliers'
import { normalizeIndustry, normalizeSpecialty } from '@/lib/suppliers/taxonomy'

interface RouteParams {
  params: Promise<{
    id: string
  }>
}

export async function GET(
  request: NextRequest,
  { params }: RouteParams
) {
  try {
    const supabase = await createClient()
    const { id } = await params

    const { data: supplier, error } = await supabase
      .from('suppliers')
      .select(`
        *,
        supplier_contacts(*),
        supplier_services(*),
        supplier_performance_history(*),
        supplier_work_history(*),
        supplier_certifications(*)
      `)
      .eq('id', id)
      .single()

    if (error) {
      if (error.code === 'PGRST116') {
        return NextResponse.json(
          { error: 'Supplier not found' },
          { status: 404 }
        )
      }

      console.error('Error fetching supplier:', error)
      return NextResponse.json(
        { error: 'Error fetching supplier', details: error.message },
        { status: 500 }
      )
    }

    return NextResponse.json({
      supplier
    })

  } catch (error) {
    console.error('Error in supplier detail API:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}

export async function PUT(
  request: NextRequest,
  { params }: RouteParams
) {
  try {
    const supabase = await createClient()
    const { id } = await params

    // Get the authenticated user
    const { data: { user }, error: authError } = await supabase.auth.getUser()

    if (authError || !user) {
      return NextResponse.json(
        { error: 'Authentication required' },
        { status: 401 }
      )
    }

    const body: UpdateSupplierRequest = await request.json()

    // Normalize specialties and industry if provided
    const normalized: UpdateSupplierRequest = { ...body }
    if (Array.isArray(body.specialties)) {
      normalized.specialties = body.specialties.map(s => normalizeSpecialty(String(s)))
    }
    if (typeof body.industry !== 'undefined') {
      const n = normalizeIndustry(body.industry as string)
      normalized.industry = n || body.industry
    }

    // Check if supplier exists and user has permission
    const { data: existingSupplier, error: fetchError } = await supabase
      .from('suppliers')
      .select('id, created_by')
      .eq('id', id)
      .single()

    if (fetchError) {
      if (fetchError.code === 'PGRST116') {
        return NextResponse.json(
          { error: 'Supplier not found' },
          { status: 404 }
        )
      }

      console.error('Error fetching supplier:', fetchError)
      return NextResponse.json(
        { error: 'Error fetching supplier' },
        { status: 500 }
      )
    }

    // Check permissions (user can only update suppliers they created)
    if (existingSupplier.created_by !== user.id) {
      return NextResponse.json(
        { error: 'Permission denied' },
        { status: 403 }
      )
    }

    // Update the supplier
    const { data: supplier, error } = await supabase
      .from('suppliers')
      .update({
        ...normalized,
        updated_by: user.id
      })
      .eq('id', id)
      .select()
      .single()

    if (error) {
      console.error('Error updating supplier:', error)
      return NextResponse.json(
        { error: 'Error updating supplier', details: error.message },
        { status: 500 }
      )
    }

    return NextResponse.json({
      success: true,
      supplier,
      message: 'Supplier updated successfully'
    })

  } catch (error) {
    console.error('Error in supplier PUT API:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: RouteParams
) {
  try {
    const supabase = await createClient()
    const { id } = await params

    // Get the authenticated user
    const { data: { user }, error: authError } = await supabase.auth.getUser()

    if (authError || !user) {
      return NextResponse.json(
        { error: 'Authentication required' },
        { status: 401 }
      )
    }

    // Check if supplier exists and user has permission
    const { data: existingSupplier, error: fetchError } = await supabase
      .from('suppliers')
      .select('id, created_by, status')
      .eq('id', id)
      .single()

    if (fetchError) {
      if (fetchError.code === 'PGRST116') {
        return NextResponse.json(
          { error: 'Supplier not found' },
          { status: 404 }
        )
      }

      console.error('Error fetching supplier:', fetchError)
      return NextResponse.json(
        { error: 'Error fetching supplier' },
        { status: 500 }
      )
    }

    // Check permissions (user can only update suppliers they created)
    if (existingSupplier.created_by !== user.id) {
      return NextResponse.json(
        { error: 'Permission denied' },
        { status: 403 }
      )
    }

    // Instead of deleting, set status to 'inactive' for audit purposes
    const { data: supplier, error } = await supabase
      .from('suppliers')
      .update({
        status: 'inactive',
        updated_by: user.id
      })
      .eq('id', id)
      .select()
      .single()

    if (error) {
      console.error('Error deactivating supplier:', error)
      return NextResponse.json(
        { error: 'Error deactivating supplier', details: error.message },
        { status: 500 }
      )
    }

    return NextResponse.json({
      success: true,
      supplier,
      message: 'Supplier deactivated successfully'
    })

  } catch (error) {
    console.error('Error in supplier DELETE API:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}
