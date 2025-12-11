import { createClient } from "@/lib/supabase"
import { NextRequest, NextResponse } from "next/server"
import { createServerClient } from "@supabase/ssr"
import { cookies } from "next/headers"

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    // Initialize Supabase client
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
            try {
              cookiesToSet.forEach(({ name, value, options }) =>
                cookieStore.set(name, value, options)
              )
            } catch {
              // This can be ignored if you have middleware refreshing sessions
            }
          }
        }
      }
    )
    
    // Verify user authentication
    const { data: sessionData, error: sessionError } = await supabase.auth.getSession()
    
    if (sessionError) {
      console.error("API: Error al obtener la sesión:", sessionError)
      return NextResponse.json(
        { error: `Error de autenticación: ${sessionError.message}` },
        { status: 401 }
      )
    }

    if (!sessionData.session?.user) {
      console.error("API: Usuario no autenticado")
      return NextResponse.json(
        { error: "No autorizado" },
        { status: 401 }
      )
    }
    
    // Parse URL to get query parameters
    const url = new URL(request.url)
    const status = url.searchParams.get("status") || undefined
    const { id: workOrderId } = await params
    
    // Build the query
    let query = supabase
      .from("additional_expenses")
      .select("id, description, amount, justification, status, adjustment_po_id")
      .eq("work_order_id", workOrderId)
    
    // Add status filter if provided
    if (status) {
      query = query.eq("status", status)
    }
    
    // If looking for expenses to create a PO, filter out those already with a PO
    if (status === "aprobado") {
      query = query.is("adjustment_po_id", null)
    }
    
    // Execute the query
    const { data, error } = await query
    
    if (error) {
      console.error("Error al consultar gastos adicionales:", error)
      return NextResponse.json(
        { error: "Error al consultar gastos adicionales" },
        { status: 500 }
      )
    }
    
    return NextResponse.json(data || [])
  } catch (error) {
    console.error("Error al procesar la petición:", error)
    return NextResponse.json(
      { error: "Error interno al procesar la petición" },
      { status: 500 }
    )
  }
} 