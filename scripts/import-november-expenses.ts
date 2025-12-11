/**
 * Import November 2025 Expenses from CSV
 * 
 * This script reads GASTOS_NOVIEMBRE_CLASIFICADOS.csv and imports all expenses
 * as manual financial adjustments for November 2025.
 * 
 * Usage:
 *   npx tsx scripts/import-november-expenses.ts
 */

import { createClient } from '@supabase/supabase-js'
import * as fs from 'fs'
import * as path from 'path'

// Load environment variables
require('dotenv').config({ path: '.env.local' })

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!
const COTIZADOR_SUPABASE_URL = process.env.COTIZADOR_SUPABASE_URL!
const COTIZADOR_SUPABASE_SERVICE_ROLE_KEY = process.env.COTIZADOR_SUPABASE_SERVICE_ROLE_KEY!

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error('Missing Supabase environment variables')
}

if (!COTIZADOR_SUPABASE_URL || !COTIZADOR_SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error('Missing Cotizador Supabase environment variables')
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false }
})

const cotizadorSupabase = createClient(
  COTIZADOR_SUPABASE_URL,
  COTIZADOR_SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } }
)

interface ExpenseRow {
  CONCEPTO: string
  VALOR: string
  PLANTA_O_BU: string
  DEPARTAMENTO: string
  CATEGORIA_GASTO: string
  SUBCATEGORIA_GASTO: string
  TIPO_ASIGNACION: string
  NOTAS: string
}

const MONTH = '2025-11'
const PERIOD_MONTH = '2025-11-01'

async function getPlantMapping(): Promise<Map<string, string>> {
  const { data: plants, error } = await supabase
    .from('plants')
    .select('id, code, name')
    .eq('status', 'active')

  if (error) throw error

  const mapping = new Map<string, string>()
  plants?.forEach(plant => {
    const codeMatch = plant.code.match(/P0?(\d+)/i)
    if (codeMatch) {
      const num = codeMatch[1]
      const numInt = parseInt(num, 10)
      mapping.set(String(numInt), plant.id)
      mapping.set(`P${numInt}`, plant.id)
      mapping.set(`p${numInt}`, plant.id)
      mapping.set(plant.code, plant.id)
      mapping.set(plant.code.toLowerCase(), plant.id)
    }
  })

  return mapping
}

async function getBusinessUnitMapping(): Promise<Map<string, string>> {
  const { data: businessUnits, error } = await supabase
    .from('business_units')
    .select('id, code, name')

  if (error) throw error

  const mapping = new Map<string, string>()
  businessUnits?.forEach(bu => {
    const nameLower = bu.name.toLowerCase()
    if (nameLower.includes('tijuana')) {
      mapping.set('tj', bu.id)
      mapping.set('TJ', bu.id)
    }
    if (nameLower.includes('bajio') || nameLower.includes('baja california') || nameLower.includes('baja')) {
      mapping.set('bj', bu.id)
      mapping.set('BJ', bu.id)
    }
    if (bu.code) {
      mapping.set(bu.code.toLowerCase(), bu.id)
      mapping.set(bu.code, bu.id)
    }
    mapping.set(bu.name.toLowerCase(), bu.id)
  })

  return mapping
}

async function getPlantVolumes(): Promise<Map<string, number>> {
  const { data: viewData, error } = await cotizadorSupabase
    .from('vw_plant_financial_analysis_unified')
    .select('plant_code, volumen_concreto_m3')
    .eq('period_start', PERIOD_MONTH)

  if (error) {
    console.warn('Warning: Could not fetch volumes from cotizador:', error.message)
    return new Map()
  }

  const volumes = new Map<string, number>()
  viewData?.forEach((row: any) => {
    const code = row.plant_code
    const volume = Number(row.volumen_concreto_m3 || 0)
    if (code) {
      const existing = volumes.get(code) || 0
      volumes.set(code, existing + volume)
    }
  })

  return volumes
}

async function getPlantVolumesByPlantId(plantIds: string[]): Promise<Map<string, number>> {
  const { data: plants } = await supabase
    .from('plants')
    .select('id, code')
    .in('id', plantIds)

  if (!plants) return new Map()

  const plantIdToCode = new Map<string, string>()
  plants.forEach(p => {
    plantIdToCode.set(p.id, p.code)
  })

  const volumesByCode = await getPlantVolumes()
  const volumesByPlantId = new Map<string, number>()
  plantIdToCode.forEach((code, plantId) => {
    const volume = volumesByCode.get(code) || 0
    volumesByPlantId.set(plantId, volume)
  })

  return volumesByPlantId
}

async function getAdminProfileId(): Promise<string> {
  const { data: profiles, error } = await supabase
    .from('profiles')
    .select('id')
    .limit(1)
    .order('created_at', { ascending: true })

  if (error || !profiles || profiles.length === 0) {
    throw new Error('No profile found for import - need at least one user profile')
  }

  return profiles[0].id
}

async function createManualCost(
  entry: {
    plantId?: string
    businessUnitId?: string
    department: string
    expenseCategory: string
    expenseSubcategory: string
    description: string
    amount: number
    notes?: string
    distributionMethod?: 'volume'
    distributions?: Array<{
      plantId: string
      percentage: number
      amount: number
      volumeM3?: number
    }>
  },
  adminProfileId: string
) {
  const adjustmentData: any = {
    business_unit_id: entry.businessUnitId || null,
    plant_id: entry.plantId || null,
    period_month: PERIOD_MONTH,
    category: 'otros_indirectos',
    department: entry.department || null,
    expense_category: entry.expenseCategory,
    expense_subcategory: entry.expenseSubcategory || null,
    description: entry.description,
    amount: entry.amount,
    notes: entry.notes || null,
    is_distributed: !!(entry.distributions && entry.distributions.length > 0),
    distribution_method: entry.distributionMethod || null,
    created_by: adminProfileId,
    updated_by: adminProfileId
  }

  const { data: adjustment, error: adjError } = await supabase
    .from('manual_financial_adjustments')
    .insert(adjustmentData)
    .select()
    .single()

  if (adjError) {
    throw new Error(`Failed to create adjustment: ${adjError.message}`)
  }

  if (entry.distributions && entry.distributions.length > 0) {
    const distributionRecords = entry.distributions.map(dist => ({
      adjustment_id: adjustment.id,
      plant_id: dist.plantId,
      percentage: dist.percentage,
      amount: dist.amount,
      volume_m3: dist.volumeM3 || null,
      created_by: adminProfileId
    }))

    const { error: distError } = await supabase
      .from('manual_financial_adjustment_distributions')
      .insert(distributionRecords)

    if (distError) {
      await supabase.from('manual_financial_adjustments').delete().eq('id', adjustment.id)
      throw new Error(`Failed to create distributions: ${distError.message}`)
    }
  }

  return adjustment
}

async function main() {
  console.log('🚀 Starting November 2025 Expense Import...\n')

  // Load CSV
  const csvPath = path.join(process.cwd(), 'GASTOS_NOVIEMBRE_CLASIFICADOS.csv')
  const csvContent = fs.readFileSync(csvPath, 'utf-8')
  
  // Smart CSV parser - handles unquoted commas in SUBCATEGORIA_GASTO
  function parseCSVLine(line: string): string[] {
    const parts: string[] = []
    const allCommas = line.split(',')
    
    // If we have exactly 8 parts, simple case
    if (allCommas.length === 8) {
      return allCommas.map(p => p.trim())
    }
    
    // Otherwise, SUBCATEGORIA_GASTO contains commas
    // Parse first 5 fields from start
    let remaining = line
    for (let i = 0; i < 5; i++) {
      const commaIdx = remaining.indexOf(',')
      if (commaIdx === -1) break
      parts.push(remaining.substring(0, commaIdx).trim())
      remaining = remaining.substring(commaIdx + 1)
    }
    
    // Parse last 2 fields from end (TIPO_ASIGNACION and NOTAS)
    const lastCommaIdx = remaining.lastIndexOf(',')
    const secondLastCommaIdx = remaining.lastIndexOf(',', lastCommaIdx - 1)
    
    if (secondLastCommaIdx !== -1) {
      const subcategory = remaining.substring(0, secondLastCommaIdx).trim()
      parts.push(subcategory)
      
      const tipoAsignacion = remaining.substring(secondLastCommaIdx + 1, lastCommaIdx).trim()
      parts.push(tipoAsignacion)
      
      const notas = remaining.substring(lastCommaIdx + 1).trim()
      parts.push(notas)
    } else {
      return allCommas.map(p => p.trim())
    }
    
    return parts
  }
  
  const lines = csvContent.split('\n').filter(line => line.trim())
  const headers = parseCSVLine(lines[0])
  const records: ExpenseRow[] = []
  
  for (let i = 1; i < lines.length; i++) {
    const values = parseCSVLine(lines[i])
    const record: any = {}
    headers.forEach((header, idx) => {
      record[header] = values[idx] || ''
    })
    records.push(record as ExpenseRow)
  }

  console.log(`📊 Loaded ${records.length} expense records\n`)

  // Get mappings
  console.log('🔍 Loading plant and business unit mappings...')
  const plantMapping = await getPlantMapping()
  const buMapping = await getBusinessUnitMapping()
  const volumesByCode = await getPlantVolumes()
  
  console.log(`   Found ${plantMapping.size} plant mappings`)
  console.log(`   Found ${buMapping.size} business unit mappings`)
  console.log(`   Found ${volumesByCode.size} plant volumes`)

  console.log('👤 Getting admin profile for import attribution...')
  const adminProfileId = await getAdminProfileId()
  console.log(`   Using profile ID: ${adminProfileId}\n`)

  const { data: allPlants } = await supabase
    .from('plants')
    .select('id, code, business_unit_id')
    .eq('status', 'active')

  if (!allPlants) {
    throw new Error('Could not fetch plants')
  }

  // Process each expense
  let successCount = 0
  let errorCount = 0
  const errors: Array<{ row: ExpenseRow; error: string }> = []

  for (let i = 0; i < records.length; i++) {
    const row = records[i]
    const amount = parseFloat(row.VALOR.replace(/,/g, ''))
    
    if (isNaN(amount)) {
      console.log(`⚠️  Row ${i + 1}: Invalid amount "${row.VALOR}", skipping`)
      errorCount++
      errors.push({ row, error: 'Invalid amount' })
      continue
    }

    try {
      if (row.TIPO_ASIGNACION === 'DIRECTO') {
        const plantId = plantMapping.get(row.PLANTA_O_BU)
        if (!plantId) {
          throw new Error(`Plant not found: ${row.PLANTA_O_BU}`)
        }

        await createManualCost({
          plantId,
          department: row.DEPARTAMENTO,
          expenseCategory: row.CATEGORIA_GASTO,
          expenseSubcategory: row.SUBCATEGORIA_GASTO,
          description: row.CONCEPTO,
          amount,
          notes: row.NOTAS || undefined
        }, adminProfileId)

        successCount++
        console.log(`✅ ${i + 1}/${records.length}: ${row.CONCEPTO} → $${amount.toFixed(2)} (Plant ${row.PLANTA_O_BU})`)

      } else if (row.TIPO_ASIGNACION === 'DISTRIBUIR_VOLUMEN') {
        const plantsToDistribute = allPlants.filter(p => p.id)
        const plantIds = plantsToDistribute.map(p => p.id)
        
        const volumesByPlantId = await getPlantVolumesByPlantId(plantIds)
        const totalVolume = Array.from(volumesByPlantId.values()).reduce((sum, v) => sum + v, 0)

        if (totalVolume === 0) {
          const equalPercentage = 100 / plantsToDistribute.length
          const equalAmount = amount / plantsToDistribute.length
          
          const distributions = plantsToDistribute.map(p => ({
            plantId: p.id,
            percentage: equalPercentage,
            amount: equalAmount,
            volumeM3: 0
          }))

          await createManualCost({
            department: row.DEPARTAMENTO,
            expenseCategory: row.CATEGORIA_GASTO,
            expenseSubcategory: row.SUBCATEGORIA_GASTO,
            description: row.CONCEPTO,
            amount,
            notes: row.NOTAS || undefined,
            distributionMethod: 'volume',
            distributions
          }, adminProfileId)
        } else {
          const distributions = plantsToDistribute.map(p => {
            const volume = volumesByPlantId.get(p.id) || 0
            const percentage = (volume / totalVolume) * 100
            const distAmount = (amount * percentage) / 100
            
            return {
              plantId: p.id,
              percentage,
              amount: distAmount,
              volumeM3: volume
            }
          })

          await createManualCost({
            department: row.DEPARTAMENTO,
            expenseCategory: row.CATEGORIA_GASTO,
            expenseSubcategory: row.SUBCATEGORIA_GASTO,
            description: row.CONCEPTO,
            amount,
            notes: row.NOTAS || undefined,
            distributionMethod: 'volume',
            distributions
          }, adminProfileId)
        }

        successCount++
        console.log(`✅ ${i + 1}/${records.length}: ${row.CONCEPTO} → $${amount.toFixed(2)} (Distributed by volume across ${plantsToDistribute.length} plants)`)

      } else if (row.TIPO_ASIGNACION === 'DISTRIBUIR_BU') {
        // Handle special cases like "tj y 3" - need to extract BU and plant
        const plantaOriginal = row.PLANTA_O_BU.toLowerCase()
        let buId: string | null = null
        let specificPlantIds: string[] = []
        
        // Check if it's a simple BU code
        if (plantaOriginal === 'tj' || plantaOriginal === 'bj') {
          buId = buMapping.get(plantaOriginal)
          if (!buId) {
            throw new Error(`Business unit not found: ${row.PLANTA_O_BU}`)
          }
        } else {
          // Handle "tj y 3" format - extract BU and plant number
          if (plantaOriginal.includes('tj')) {
            buId = buMapping.get('tj')
            const plantMatch = plantaOriginal.match(/3/)
            if (plantMatch) {
              const plantId = plantMapping.get('3')
              if (plantId) specificPlantIds.push(plantId)
            }
          }
          if (plantaOriginal.includes('bj')) {
            buId = buMapping.get('bj')
          }
          
          if (!buId) {
            throw new Error(`Could not determine business unit from: ${row.PLANTA_O_BU}`)
          }
        }

        // Get plants for distribution
        let buPlants = allPlants.filter(p => p.business_unit_id === buId)
        
        // If specific plants are mentioned (like "tj y 3"), only use those
        if (specificPlantIds.length > 0) {
          buPlants = buPlants.filter(p => specificPlantIds.includes(p.id))
        }
        
        if (buPlants.length === 0) {
          throw new Error(`No plants found for business unit: ${row.PLANTA_O_BU}`)
        }

        const plantIds = buPlants.map(p => p.id)
        const volumesByPlantId = await getPlantVolumesByPlantId(plantIds)
        const totalVolume = Array.from(volumesByPlantId.values()).reduce((sum, v) => sum + v, 0)

        if (totalVolume === 0) {
          const equalPercentage = 100 / buPlants.length
          const equalAmount = amount / buPlants.length
          
          const distributions = buPlants.map(p => ({
            plantId: p.id,
            percentage: equalPercentage,
            amount: equalAmount,
            volumeM3: 0
          }))

          await createManualCost({
            businessUnitId: buId,
            department: row.DEPARTAMENTO,
            expenseCategory: row.CATEGORIA_GASTO,
            expenseSubcategory: row.SUBCATEGORIA_GASTO,
            description: row.CONCEPTO,
            amount,
            notes: row.NOTAS || undefined,
            distributionMethod: 'volume',
            distributions
          }, adminProfileId)
        } else {
          const distributions = buPlants.map(p => {
            const volume = volumesByPlantId.get(p.id) || 0
            const percentage = (volume / totalVolume) * 100
            const distAmount = (amount * percentage) / 100
            
            return {
              plantId: p.id,
              percentage,
              amount: distAmount,
              volumeM3: volume
            }
          })

          await createManualCost({
            businessUnitId: buId,
            department: row.DEPARTAMENTO,
            expenseCategory: row.CATEGORIA_GASTO,
            expenseSubcategory: row.SUBCATEGORIA_GASTO,
            description: row.CONCEPTO,
            amount,
            notes: row.NOTAS || undefined,
            distributionMethod: 'volume',
            distributions
          }, adminProfileId)
        }

        successCount++
        console.log(`✅ ${i + 1}/${records.length}: ${row.CONCEPTO} → $${amount.toFixed(2)} (Distributed by volume in BU ${row.PLANTA_O_BU}, ${buPlants.length} plants)`)

      } else {
        throw new Error(`Unknown assignment type: ${row.TIPO_ASIGNACION}`)
      }

    } catch (error: any) {
      errorCount++
      errors.push({ row, error: error.message })
      console.error(`❌ ${i + 1}/${records.length}: ${row.CONCEPTO} → ERROR: ${error.message}`)
    }
  }

  // Summary
  console.log('\n' + '='.repeat(60))
  console.log('📊 IMPORT SUMMARY')
  console.log('='.repeat(60))
  console.log(`✅ Successfully imported: ${successCount} expenses`)
  console.log(`❌ Failed: ${errorCount} expenses`)
  console.log(`📁 Total processed: ${records.length} expenses`)

  if (errors.length > 0) {
    console.log('\n❌ ERRORS:')
    errors.forEach(({ row, error }) => {
      console.log(`   - ${row.CONCEPTO}: ${error}`)
    })
  }

  console.log('\n✨ Import complete!')
}

main().catch(console.error)

