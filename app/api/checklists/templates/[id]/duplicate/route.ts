import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'
import { NextRequest, NextResponse } from 'next/server'

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const cookieStore = await cookies()
    
    const supabase = createServerClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      {
        cookies: {
          getAll() {
            return cookieStore.getAll()
          },
          setAll(cookiesToSet) {
            cookiesToSet.forEach(({ name, value, options }) => {
              cookieStore.set(name, value, options)
            })
          },
        },
      }
    )

    const { id: templateId } = await params
    const { name, description, frequency, model_id, interval_id } = await request.json()

    // Validate required fields
    if (!name || !frequency || !model_id) {
      return NextResponse.json(
        { error: 'Nombre, frecuencia y modelo son requeridos' },
        { status: 400 }
      )
    }

    // Get the original template with all its sections and items
    const { data: originalTemplate, error: fetchError } = await supabase
      .from('checklists')
      .select(`
        *,
        checklist_sections(
          *,
          checklist_items(*)
        )
      `)
      .eq('id', templateId)
      .single()

    if (fetchError || !originalTemplate) {
      console.error('Error fetching original template:', fetchError)
      return NextResponse.json(
        { error: 'Plantilla original no encontrada' },
        { status: 404 }
      )
    }

    // Get current user
    const { data: { user } } = await supabase.auth.getUser()
    const userId = user?.id

    // Create the new template
    const { data: newTemplate, error: createError } = await supabase
      .from('checklists')
      .insert({
        name,
        description: description || null,
        model_id,
        frequency,
        interval_id: interval_id || null,
        created_by: userId
      })
      .select('id')
      .single()

    if (createError) {
      console.error('Error creating new template:', createError)
      return NextResponse.json(
        { error: 'Error al crear la nueva plantilla' },
        { status: 500 }
      )
    }

    const newTemplateId = newTemplate.id

    // Copy all sections and their items
    if (originalTemplate.checklist_sections && originalTemplate.checklist_sections.length > 0) {
      for (const section of originalTemplate.checklist_sections) {
        // Create new section
        const { data: newSection, error: sectionError } = await supabase
          .from('checklist_sections')
          .insert({
            checklist_id: newTemplateId,
            title: section.title,
            order_index: section.order_index
          })
          .select('id')
          .single()

        if (sectionError) {
          console.error('Error creating section:', sectionError)
          continue
        }

        // Copy all items for this section
        if (section.checklist_items && section.checklist_items.length > 0) {
          const itemsToInsert = section.checklist_items.map((item: any) => ({
            section_id: newSection.id,
            description: item.description,
            required: item.required || false,
            item_type: item.item_type || 'check',
            expected_value: item.expected_value || null,
            tolerance: item.tolerance || null,
            order_index: item.order_index
          }))

          const { error: itemsError } = await supabase
            .from('checklist_items')
            .insert(itemsToInsert)

          if (itemsError) {
            console.error('Error creating items:', itemsError)
          }
        }
      }
    }

    return NextResponse.json({
      success: true,
      template_id: newTemplateId,
      message: 'Plantilla duplicada exitosamente'
    })

  } catch (error) {
    console.error('Error duplicating template:', error)
    return NextResponse.json(
      { error: 'Error interno del servidor' },
      { status: 500 }
    )
  }
} 