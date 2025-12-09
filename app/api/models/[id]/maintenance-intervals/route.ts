import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase-server';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    // Obtener el ID del modelo de los parámetros de la ruta
    const { id: modelId } = await params;
    console.log("Fetching maintenance intervals for model ID:", modelId);
    
    // Crear cliente de Supabase
    const supabase = await createClient();
    
    // Intentar usar la función RPC primero
    console.log("Attempting to use RPC function...");
    const { data: rpcData, error: rpcError } = await supabase.rpc('get_maintenance_intervals_with_tasks', {
      p_model_id: modelId
    });
    
    // Si hay un error pero no es porque la función no existe, registrarlo
    if (rpcError) {
      console.error('RPC error:', rpcError.message);
      
      // Verificar si es porque la función no existe
      if (rpcError.message.includes('function get_maintenance_intervals_with_tasks() does not exist')) {
        console.log("RPC function doesn't exist, falling back to nested query...");
      } else {
        // Es otro tipo de error
        console.error('Unexpected RPC error:', rpcError);
        // Continuar con el método alternativo
      }
    } else {
      // La función RPC se ejecutó correctamente
      console.log("RPC function executed successfully, returning data:", rpcData);
      return NextResponse.json(rpcData);
    }
    
    // Caer en el método alternativo usando consultas anidadas
    console.log("Using nested query approach...");
    
    // Ejecutar consulta SQL directa
    const { data: sqlData, error: sqlError } = await supabase.from('maintenance_intervals')
      .select(`
        *,
        maintenance_tasks(
          *,
          task_parts(*)
        )
      `)
      .eq('model_id', modelId);
      
    if (sqlError) {
      console.error('SQL query error:', sqlError);
      return NextResponse.json(
        { message: 'Error al obtener intervalos de mantenimiento', error: sqlError },
        { status: 500 }
      );
    }
    
    console.log("SQL query executed successfully, returning data:", JSON.stringify(sqlData).slice(0, 200) + "...");
    return NextResponse.json(sqlData);
  } catch (error) {
    console.error('Error inesperado:', error);
    return NextResponse.json(
      { message: 'Error inesperado al obtener intervalos', error },
      { status: 500 }
    );
  }
} 