import { createClient } from '@/lib/supabase-server'
import { NextRequest, NextResponse } from 'next/server'

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const supabase = await createClient()
    
    // Get current user and verify permissions
    const { data: { user }, error: authError } = await supabase.auth.getUser()
    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    // Check if user has permission to update plants
    const { data: currentProfile, error: profileError } = await supabase
      .from('profiles')
      .select('role, plant_id, business_unit_id')
      .eq('id', user.id)
      .single()

    if (profileError || !currentProfile) {
      return NextResponse.json({ error: 'Profile not found' }, { status: 404 })
    }

    // Only certain roles can update plants
    const allowedRoles = ['GERENCIA_GENERAL', 'JEFE_UNIDAD_NEGOCIO', 'JEFE_PLANTA']
    if (!allowedRoles.includes(currentProfile.role)) {
      return NextResponse.json({ error: 'Insufficient permissions' }, { status: 403 })
    }

    const { id: plantId } = await params
    const updateData = await request.json()

    // Remove fields that shouldn't be updated directly
    const { created_by, created_at, ...allowedFields } = updateData

    // Add updated fields
    const fieldsToUpdate = {
      ...allowedFields,
      updated_by: user.id,
      updated_at: new Date().toISOString()
    }

    // Update the plant
    const { data: plant, error } = await supabase
      .from('plants')
      .update(fieldsToUpdate)
      .eq('id', plantId)
      .select(`
        id,
        name,
        code,
        location,
        status,
        business_unit_id,
        contact_phone,
        contact_email,
        address,
        business_units:business_unit_id(id, name)
      `)
      .single()

    if (error) {
      console.error('Error updating plant:', error)
      return NextResponse.json({ error: 'Error updating plant' }, { status: 500 })
    }

    if (!plant) {
      return NextResponse.json({ error: 'Plant not found' }, { status: 404 })
    }

    return NextResponse.json(plant)

  } catch (error) {
    console.error('Error in plants PATCH:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const supabase = await createClient()
    
    // Get current user and verify permissions
    const { data: { user }, error: authError } = await supabase.auth.getUser()
    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const { id: plantId } = await params

    const { data: plant, error } = await supabase
      .from('plants')
      .select(`
        id,
        name,
        code,
        location,
        status,
        business_unit_id,
        contact_phone,
        contact_email,
        address,
        business_units:business_unit_id(id, name)
      `)
      .eq('id', plantId)
      .single()

    if (error) {
      console.error('Error fetching plant:', error)
      return NextResponse.json({ error: 'Plant not found' }, { status: 404 })
    }

    return NextResponse.json(plant)

  } catch (error) {
    console.error('Error in plants GET:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
} 