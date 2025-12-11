import { NextRequest, NextResponse } from 'next/server'
import { createClient as createServerSupabase } from '@/lib/supabase-server'
import { createClient } from '@supabase/supabase-js'

/**
 * Refresh historical financial analysis data for a specific month
 * 
 * This endpoint calls backfill_financial_analysis_month to recalculate and backfill
 * historical financial data. This is different from refreshing materialized views.
 * 
 * Note: The views vw_pumping_analysis_unified and sales_assets_daily are now
 * materialized views that refresh automatically every hour at :30 past the hour.
 * If you need to refresh those materialized views immediately, use the
 * /refresh-materialized-views endpoint instead.
 */

type Body = {
  month: string // YYYY-MM format
}

export async function POST(req: NextRequest) {
  try {
    const { month } = (await req.json()) as Body

    if (!month) {
      return NextResponse.json({ error: 'Month parameter is required' }, { status: 400 })
    }

    // Validate month format (YYYY-MM)
    const monthRegex = /^\d{4}-\d{2}$/
    if (!monthRegex.test(month)) {
      return NextResponse.json(
        { error: 'Invalid month format. Expected YYYY-MM (e.g., 2025-10)' },
        { status: 400 }
      )
    }

    // Extract year and month
    const [year, monthNum] = month.split('-').map(Number)
    
    // Validate month range
    if (monthNum < 1 || monthNum > 12) {
      return NextResponse.json({ error: 'Invalid month. Must be between 01 and 12' }, { status: 400 })
    }

    // Validate year range (reasonable bounds)
    if (year < 2020 || year > 2100) {
      return NextResponse.json({ error: 'Invalid year. Must be between 2020 and 2100' }, { status: 400 })
    }

    // Check authentication
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

    // Call the backfill function via RPC
    // This refreshes historical financial analysis data, not the materialized views
    console.log(`[Refresh View] Calling backfill_financial_analysis_month for ${year}-${monthNum}`)
    
    const { data, error } = await cotizadorSupabase.rpc('backfill_financial_analysis_month', {
      p_year: year,
      p_month: monthNum
    })

    if (error) {
      console.error('[Refresh View] RPC error:', error)
      return NextResponse.json(
        { 
          error: 'Failed to refresh historical data',
          details: error.message 
        },
        { status: 500 }
      )
    }

    // The function returns a JSON object with success status
    const result = data as any
    
    if (!result || result.success === false) {
      return NextResponse.json(
        {
          error: result?.message || 'Refresh failed',
          details: result?.error || 'Unknown error'
        },
        { status: 500 }
      )
    }

    console.log(`[Refresh View] Success: ${result.message || 'Historical data refreshed'}`)

    return NextResponse.json({
      success: true,
      month,
      year,
      monthNum,
      plantsBackfilled: result.plants_backfilled || 0,
      periodStart: result.period_start,
      periodEnd: result.period_end,
      message: result.message || `Successfully refreshed historical data for ${month}`
    })
  } catch (e: any) {
    console.error('[Refresh View] Unexpected error:', e)
    return NextResponse.json(
      { 
        error: 'Unexpected error occurred',
        details: e?.message || 'Unknown error'
      },
      { status: 500 }
    )
  }
}





