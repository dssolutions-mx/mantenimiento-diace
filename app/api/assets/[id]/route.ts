import { createClient } from '@/lib/supabase-server'
import { NextRequest, NextResponse } from 'next/server'

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const supabase = await createClient()
    const { id } = await params
    
    const { data: asset, error } = await supabase
      .from('assets')
      .select(`
        id,
        name,
        asset_id,
        status,
        location,
        department,
        current_hours,
        serial_number,
        notes,
        equipment_models (
          id,
          name,
          manufacturer
        )
      `)
      .eq('id', id)
      .single()

    if (error) {
      console.error('Error fetching asset:', error)
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    if (!asset) {
      return NextResponse.json({ error: 'Asset not found' }, { status: 404 })
    }

    return NextResponse.json(asset)
  } catch (error: any) {
    console.error('Server error:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
} 