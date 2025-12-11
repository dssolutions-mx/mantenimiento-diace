import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

type Body = {
  dateFrom: string
  dateTo: string
  plantIds?: string[]
  assetNames?: string[]
  includeVat?: boolean
}

export async function POST(req: NextRequest) {
  try {
    const { dateFrom, dateTo, plantIds, assetNames } = (await req.json()) as Body

    console.log('=== COTIZADOR SALES API ===')
    console.log('Request:', { dateFrom, dateTo, plantIds, assetNames })

    if (!process.env.COTIZADOR_SUPABASE_URL || !process.env.COTIZADOR_SUPABASE_SERVICE_ROLE_KEY) {
      return NextResponse.json({ error: 'Missing cotizador env configuration' }, { status: 500 })
    }

    const cotizador = createClient(
      process.env.COTIZADOR_SUPABASE_URL,
      process.env.COTIZADOR_SUPABASE_SERVICE_ROLE_KEY,
      { auth: { persistSession: false } }
    )

    // Query the new DAILY view - much simpler and more accurate!
    // Note: This view is now a materialized view (mv_sales_assets_daily) for performance.
    // It refreshes automatically every hour at :30 past the hour, so data may be up to 1 hour old.
    // The view name remains the same (aliased).
    let query = cotizador.from('sales_assets_daily').select('*')
      .gte('day', dateFrom)
      .lte('day', dateTo)

    if (plantIds && plantIds.length > 0) {
      query = query.in('plant_id', plantIds)
    }
    if (assetNames && assetNames.length > 0) {
      query = query.in('asset_name', assetNames)
    }

    const { data, error } = await query.order('day').order('asset_name')

    if (error) {
      console.error('Query failed:', error)
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    console.log(`Fetched ${data?.length || 0} daily rows`)

    // Aggregate by asset (plant_id + asset_name) across the date range
    const aggregated = new Map<string, any>()
    
    ;(data || []).forEach((row: any) => {
      const key = `${row.plant_id}_${row.asset_name}`
      if (!aggregated.has(key)) {
        aggregated.set(key, {
          plant_id: row.plant_id,
          asset_name: row.asset_name,
          remisiones_count: 0,
          remisiones_concrete_count: 0,
          concrete_m3: 0,
          total_m3: 0,
          subtotal_amount: 0,
          total_amount_with_vat: 0
        })
      }

      const agg = aggregated.get(key)
      agg.remisiones_count += Number(row.remisiones_count || 0)
      agg.remisiones_concrete_count += Number(row.remisiones_concrete_count || 0)
      agg.concrete_m3 += Number(row.concrete_m3 || 0)
      agg.total_m3 += Number(row.total_m3 || 0)
      agg.subtotal_amount += Number(row.subtotal_amount || 0)
      agg.total_amount_with_vat += Number(row.total_amount_with_vat || 0)
    })

    const filteredData = Array.from(aggregated.values())

    console.log(`After aggregation: ${filteredData.length} assets`)
    if (filteredData.length > 0) {
      const totalM3 = filteredData.reduce((sum: number, row: any) => sum + Number(row.concrete_m3 || 0), 0)
      const totalSales = filteredData.reduce((sum: number, row: any) => sum + Number(row.subtotal_amount || 0), 0)
      console.log(`Total m³: ${totalM3.toFixed(1)}, Sales: $${totalSales.toLocaleString()}`)
      
      const byPlant: Record<string, {m3: number, sales: number, assets: number}> = {}
      filteredData.forEach((row: any) => {
        const pid = row.plant_id
        if (!byPlant[pid]) byPlant[pid] = { m3: 0, sales: 0, assets: 0 }
        byPlant[pid].m3 += Number(row.concrete_m3 || 0)
        byPlant[pid].sales += Number(row.subtotal_amount || 0)
        byPlant[pid].assets++
      })
      console.log('By Plant:')
      Object.entries(byPlant).forEach(([pid, stats]) => {
        console.log(`  ${pid}: ${stats.m3.toFixed(1)} m³, $${stats.sales.toLocaleString()}, ${stats.assets} assets`)
      })
    }

    // Optional mapping to asset_id using local DB
    // Note: We cannot join cross-project here; we enrich by querying local maintenance DB only by asset_name
    try {
      const maint = createClient(
        process.env.NEXT_PUBLIC_SUPABASE_URL!,
        process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
        { auth: { persistSession: false } }
      )
      const uniqueUnits = Array.from(new Set((data || []).map((r: any) => r.asset_name).filter(Boolean)))
      let mapping: Record<string, string> = {}
      if (uniqueUnits.length > 0) {
        const { data: maps } = await maint
          .from('asset_name_mappings')
          .select('external_unit, asset_id, source_system')
          .in('external_unit', uniqueUnits)
        ;(maps || []).forEach((m: any) => {
          if (!m.source_system || m.source_system === 'cotizador') {
            mapping[m.external_unit] = m.asset_id
          }
        })
      }
      const enriched = filteredData.map((r: any) => ({ ...r, asset_id: mapping[r.asset_name] || null }))
      console.log('=== END COTIZADOR SALES API ===\n')
      return NextResponse.json(enriched)
    } catch {
      // If enrichment fails, still return filtered data
      console.log('=== END COTIZADOR SALES API ===\n')
      return NextResponse.json(filteredData)
    }
  } catch (e: any) {
    console.error('Cotizador sales API error:', e)
    return NextResponse.json({ error: e?.message || 'Unexpected error' }, { status: 500 })
  }
}


