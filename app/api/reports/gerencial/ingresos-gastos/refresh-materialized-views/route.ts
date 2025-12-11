import { NextRequest, NextResponse } from 'next/server'
import { createClient as createServerSupabase } from '@/lib/supabase-server'
import { createClient } from '@supabase/supabase-js'

/**
 * Refresh materialized views in the cotizador database
 * 
 * This endpoint manually triggers a refresh of the materialized views:
 * - mv_pumping_analysis_unified
 * - mv_sales_assets_daily
 * 
 * Note: These views refresh automatically every hour at :30 past the hour.
 * Use this endpoint only when you need real-time data immediately.
 * 
 * The views are aliased, so queries to vw_pumping_analysis_unified and 
 * sales_assets_daily will automatically use the refreshed materialized data.
 */
export async function POST(req: NextRequest) {
  try {
    // Check authentication against maintenance-dashboard database
    // (users don't have profiles in cotizador, so we only check here)
    const supabase = await createServerSupabase()
    const { data: { user }, error: authError } = await supabase.auth.getUser()
    
    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    // Check if COTIZADOR credentials are configured
    if (!process.env.COTIZADOR_SUPABASE_URL || !process.env.COTIZADOR_SUPABASE_SERVICE_ROLE_KEY) {
      console.error('COTIZADOR credentials not configured')
      return NextResponse.json(
        { error: 'Server configuration error: COTIZADOR credentials missing' },
        { status: 500 }
      )
    }

    // Connect to COTIZADOR database
    const cotizadorSupabase = createClient(
      process.env.COTIZADOR_SUPABASE_URL,
      process.env.COTIZADOR_SUPABASE_SERVICE_ROLE_KEY,
      { auth: { persistSession: false } }
    )

    // Call the refresh function via RPC
    console.log('[Refresh Materialized Views] Calling refresh_analytics_materialized_views')
    
    const { data, error } = await cotizadorSupabase.rpc('refresh_analytics_materialized_views')

    if (error) {
      console.error('[Refresh Materialized Views] RPC error:', error)
      return NextResponse.json(
        { 
          error: 'Failed to refresh materialized views',
          details: error.message 
        },
        { status: 500 }
      )
    }

    console.log('[Refresh Materialized Views] Success: Materialized views refreshed')

    return NextResponse.json({
      success: true,
      message: 'Materialized views refreshed successfully. Data is now up-to-date.',
      refreshedAt: new Date().toISOString()
    })
  } catch (e: any) {
    console.error('[Refresh Materialized Views] Unexpected error:', e)
    return NextResponse.json(
      { 
        error: 'Unexpected error occurred',
        details: e?.message || 'Unknown error'
      },
      { status: 500 }
    )
  }
}
