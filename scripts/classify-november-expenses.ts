/**
 * Classify November 2025 Expenses
 * 
 * This script reads GASTOS INDIRECTOS PROCESADOS.csv and classifies
 * each expense according to the 14 expense categories.
 */

import * as fs from 'fs'
import * as path from 'path'

interface ExpenseRow {
  CONCEPTO: string
  VALOR: string
  PLANTA: string
  DEPARTAMENTO: string
}

// Mapping function to classify expenses
function classifyExpense(concepto: string, departamento: string): {
  categoria: string
  subcategoria: string
} {
  const conceptoUpper = concepto.toUpperCase()
  const deptUpper = departamento.toUpperCase()

  // Category 9: PERSONAL - NOMINA - Obligaciones Patronales
  if (conceptoUpper.includes('IMSS') || 
      conceptoUpper.includes('RCV') || 
      conceptoUpper.includes('INFONAVIT') ||
      conceptoUpper.match(/\d+%\s*S\/?NOM/i) ||
      conceptoUpper.includes('COMISIONES')) {
    return { categoria: '9', subcategoria: 'NOMINA - Obligaciones Patronales' }
  }

  // Category 9: PERSONAL - Atención al Personal
  if (conceptoUpper.includes('COMIDA') || 
      conceptoUpper.includes('ALMUERZO') ||
      conceptoUpper.includes('ATENCION AL PERSONAL') ||
      conceptoUpper.includes('VALES DESPENSA') ||
      conceptoUpper.includes('ADORNOS NAVIDEÑOS')) {
    return { categoria: '9', subcategoria: 'Atención al Personal (Comidas, Almuerzo)' }
  }

  // Category 9: PERSONAL - Viáticos
  if (conceptoUpper.includes('VIATICOS') || conceptoUpper.includes('VIATICOS')) {
    return { categoria: '9', subcategoria: 'Viáticos' }
  }

  // Category 9: PERSONAL - Uniformes
  if (conceptoUpper.includes('UNIFORMES')) {
    return { categoria: '9', subcategoria: 'Uniformes de Trabajo' }
  }

  // Category 1: OPERACIÓN DE PLANTA - Materiales de Producción
  if (conceptoUpper.includes('UREA') || 
      conceptoUpper.includes('CONCRETO') ||
      conceptoUpper.includes('MATERIALES PETREOS')) {
    return { categoria: '1', subcategoria: 'Materiales de Producción (Urea, Concreto, Materiales Pétreos)' }
  }

  // Category 1: OPERACIÓN DE PLANTA - Servicios de Producción
  if (conceptoUpper.includes('BOMBEO') || conceptoUpper.includes('GRUA')) {
    return { categoria: '1', subcategoria: 'Servicios de Producción (Bombeo, Grúa)' }
  }

  // Category 1: OPERACIÓN DE PLANTA - Químicos y Aditivos
  if (conceptoUpper.includes('ANTIDOP') || conceptoUpper.includes('ANTIDOPING')) {
    return { categoria: '1', subcategoria: 'Químicos y Aditivos (Antidoping, Desincrustrante, Catalizadores)' }
  }

  // Category 2: COMBUSTIBLES Y TRANSPORTE - Combustible y Gasolina
  if (conceptoUpper.includes('GASOLINA') || 
      conceptoUpper.includes('COMBUSTIBLE') ||
      conceptoUpper.includes('COMBUSTIBLES')) {
    return { categoria: '2', subcategoria: 'Combustible y Gasolina' }
  }

  // Category 2: COMBUSTIBLES Y TRANSPORTE - Casetas Viales
  if (conceptoUpper.includes('CASETAS') || conceptoUpper.includes('CASETA')) {
    return { categoria: '2', subcategoria: 'Casetas Viales' }
  }

  // Category 2: COMBUSTIBLES Y TRANSPORTE - Transporte Ejecutivo
  if (conceptoUpper.includes('UBER') || conceptoUpper.includes('TAXI')) {
    return { categoria: '2', subcategoria: 'Transporte Ejecutivo (Uber, Taxis)' }
  }

  // Category 2: COMBUSTIBLES Y TRANSPORTE - Traslado de Equipos
  if (conceptoUpper.includes('TRASLADO') || conceptoUpper.includes('TRASALADO')) {
    return { categoria: '2', subcategoria: 'Traslado de Equipos' }
  }

  // Category 3: SERVICIOS GENERALES - Electricidad
  if (conceptoUpper.includes('ELECTRICIDAD')) {
    return { categoria: '3', subcategoria: 'Electricidad' }
  }

  // Category 3: SERVICIOS GENERALES - Agua
  if (conceptoUpper.includes('AGUA') && !conceptoUpper.includes('GARRAFON')) {
    return { categoria: '3', subcategoria: 'Agua' }
  }

  // Category 3: SERVICIOS GENERALES - Telefonía e Internet
  if (conceptoUpper.includes('TELEFONIA') || conceptoUpper.includes('TELEFONÍA') || conceptoUpper.includes('INTERNET')) {
    return { categoria: '3', subcategoria: 'Telefonía e Internet' }
  }

  // Category 4: ARRENDAMIENTOS - Renta de Terrenos
  if (conceptoUpper.includes('RENTA') && (conceptoUpper.includes('TERRENO') || conceptoUpper.includes('TERRENO'))) {
    return { categoria: '4', subcategoria: 'Renta de Terrenos' }
  }

  // Category 4: ARRENDAMIENTOS - Renta de Inmuebles
  if (conceptoUpper.includes('RENTA') && (conceptoUpper.includes('DEPARTAMENTO') || conceptoUpper.includes('CAMPAMENTO') || conceptoUpper.includes('CUARTO'))) {
    return { categoria: '4', subcategoria: 'Renta de Inmuebles' }
  }

  // Category 4: ARRENDAMIENTOS - Renta de Vehículos (Leasing)
  if (conceptoUpper.includes('LEASING') || conceptoUpper.includes('ARRENDAMIENTO LEASING')) {
    return { categoria: '4', subcategoria: 'Renta de Vehículos (Leasing)' }
  }

  // Category 4: ARRENDAMIENTOS - Renta de Maquinaria y Equipo
  if (conceptoUpper.includes('RENTA') && (conceptoUpper.includes('MAQUINARIA') || conceptoUpper.includes('CR') || conceptoUpper.includes('EQUIPO'))) {
    return { categoria: '4', subcategoria: 'Renta de Maquinaria y Equipo' }
  }

  // Category 4: ARRENDAMIENTOS - Renta de Baños y Otros
  if (conceptoUpper.includes('RENTA') && conceptoUpper.includes('BAÑOS')) {
    return { categoria: '4', subcategoria: 'Renta de Baños y Otros' }
  }

  // Category 4: ARRENDAMIENTOS - Arrendamientos (general)
  if (conceptoUpper.includes('ARRENDAMIENTOS') || conceptoUpper.includes('ARRENDAMIENTO')) {
    return { categoria: '4', subcategoria: 'Renta de Inmuebles' }
  }

  // Category 5: SERVICIOS PROFESIONALES - Honorarios y Asesorías
  if (conceptoUpper.includes('HONORARIOS') || conceptoUpper.includes('ASESORIAS') || conceptoUpper.includes('ASESORÍAS')) {
    return { categoria: '5', subcategoria: 'Honorarios y Asesorías' }
  }

  // Category 5: SERVICIOS PROFESIONALES - Soporte de Sistemas
  if (conceptoUpper.includes('SOPORTE') && conceptoUpper.includes('SISTEMAS')) {
    return { categoria: '5', subcategoria: 'Soporte de Sistemas' }
  }

  // Category 6: MATERIALES Y SUMINISTROS - Papelería y Artículos de Oficina
  if (conceptoUpper.includes('PAPELERIA') || 
      conceptoUpper.includes('PAPELERÍA') ||
      conceptoUpper.includes('ARTICULOS DE OFICINA') ||
      conceptoUpper.includes('ARTÍCULOS DE OFICINA')) {
    return { categoria: '6', subcategoria: 'Papelería y Artículos de Oficina' }
  }

  // Category 6: MATERIALES Y SUMINISTROS - Artículos de Limpieza
  if (conceptoUpper.includes('LIMPIEZA') || conceptoUpper.includes('ARTICULOS DE LIMPIEZA')) {
    return { categoria: '6', subcategoria: 'Artículos de Limpieza' }
  }

  // Category 6: MATERIALES Y SUMINISTROS - Agua de Garrafón
  if (conceptoUpper.includes('GARRAFON') || conceptoUpper.includes('GARRAFÓN')) {
    return { categoria: '6', subcategoria: 'Agua de Garrafón' }
  }

  // Category 6: MATERIALES Y SUMINISTROS - Material de Laboratorio
  if (conceptoUpper.includes('MEDICAMENTOS') || conceptoUpper.includes('BOTIQUIN')) {
    return { categoria: '6', subcategoria: 'Material de Laboratorio' }
  }

  // Category 7: TECNOLOGÍA - Licencias de Software
  if (conceptoUpper.includes('LICENCIAS') && conceptoUpper.includes('SISTEMAS')) {
    return { categoria: '7', subcategoria: 'Licencias de Software' }
  }

  // Category 7: TECNOLOGÍA - Dominios y Hosting
  if (conceptoUpper.includes('DOMINIO') || conceptoUpper.includes('HOSTING')) {
    return { categoria: '7', subcategoria: 'Dominios y Hosting' }
  }

  // Category 7: TECNOLOGÍA - Renta de Equipo de Impresión
  if (conceptoUpper.includes('RENTA') && conceptoUpper.includes('EQUIPO') && conceptoUpper.includes('IMPRESION')) {
    return { categoria: '7', subcategoria: 'Renta de Equipo de Impresión' }
  }

  // Category 8: VEHÍCULOS - Verificaciones Vehiculares
  if (conceptoUpper.includes('VERIFICACION') || conceptoUpper.includes('VERIFICACIÓN')) {
    return { categoria: '8', subcategoria: 'Verificaciones Vehiculares' }
  }

  // Category 8: VEHÍCULOS - Reparaciones y Mantenimiento
  if (conceptoUpper.includes('MANTO') || 
      conceptoUpper.includes('MANTENIMIENTO') ||
      conceptoUpper.includes('TALACHA') ||
      conceptoUpper.includes('RESCATE')) {
    return { categoria: '8', subcategoria: 'Reparaciones y Mantenimiento' }
  }

  // Category 10: COMERCIAL Y MARKETING - Publicidad
  if (conceptoUpper.includes('PUBLICIDAD')) {
    return { categoria: '10', subcategoria: 'Publicidad' }
  }

  // Category 11: GASTOS FINANCIEROS - Recargos
  if (conceptoUpper.includes('RECARGOS')) {
    return { categoria: '11', subcategoria: 'Recargos' }
  }

  // Category 12: SEGUROS Y FIANZAS - Seguros
  if (conceptoUpper.includes('SEGUROS') || conceptoUpper.includes('DEDUCIBLE')) {
    return { categoria: '12', subcategoria: 'Seguros' }
  }

  // Category 13: IMPUESTOS Y DERECHOS - Impuestos Locales
  if (conceptoUpper.includes('MULTA') || conceptoUpper.includes('MORDIDA')) {
    return { categoria: '13', subcategoria: 'Impuestos Locales' }
  }

  // Category 13: IMPUESTOS Y DERECHOS - Derechos
  if (conceptoUpper.includes('DERECHOS') || conceptoUpper.includes('IMPuestos')) {
    return { categoria: '13', subcategoria: 'Derechos' }
  }

  // Category 14: OTROS GASTOS - Gastos No Deducibles
  if (conceptoUpper.includes('NO DEDUCIBLES') || conceptoUpper.includes('NO DEDUCIBLE')) {
    return { categoria: '14', subcategoria: 'Gastos No Deducibles' }
  }

  // Category 14: OTROS GASTOS - Paquetería y Envíos
  if (conceptoUpper.includes('PAQUETERIA') || conceptoUpper.includes('ENVIOS') || conceptoUpper.includes('ENVÍOS')) {
    return { categoria: '14', subcategoria: 'Paquetería y Envíos' }
  }

  // Category 14: OTROS GASTOS - Otros Gastos Varios (default)
  return { categoria: '14', subcategoria: 'Otros Gastos Varios' }
}

function determineAssignmentType(planta: string): 'DIRECTO' | 'DISTRIBUIR_VOLUMEN' | 'DISTRIBUIR_BU' {
  const plantaUpper = planta.toUpperCase().trim()
  
  // Direct assignment to specific plant (1, 2, 3, 4, 5)
  if (/^[1-5]$/.test(plantaUpper)) {
    return 'DIRECTO'
  }
  
  // Distribute by volume across all plants
  if (plantaUpper === 'GEN' || plantaUpper === 'GENERAL') {
    return 'DISTRIBUIR_VOLUMEN'
  }
  
  // Distribute by volume within business unit
  if (plantaUpper.includes('TJ') || plantaUpper.includes('BJ')) {
    return 'DISTRIBUIR_BU'
  }
  
  // Handle "tj y 3" or similar - treat as BU distribution
  if (plantaUpper.includes('TJ') || plantaUpper.includes('BJ')) {
    return 'DISTRIBUIR_BU'
  }
  
  // Default to direct if it's a number
  if (/^\d+$/.test(plantaUpper)) {
    return 'DIRECTO'
  }
  
  // Default to volume distribution for unknown
  return 'DISTRIBUIR_VOLUMEN'
}

function normalizePlantCode(planta: string): string {
  const plantaUpper = planta.toUpperCase().trim()
  
  // Extract business unit code
  if (plantaUpper.includes('TJ')) return 'tj'
  if (plantaUpper.includes('BJ')) return 'bj'
  if (plantaUpper === 'GEN' || plantaUpper === 'GENERAL') return 'gen'
  
  // Return plant number as-is
  return plantaUpper
}

async function main() {
  console.log('🚀 Classifying November 2025 Expenses...\n')

  // Load CSV
  const csvPath = path.join(process.cwd(), 'GASTOS INDIRECTOS PROCESADOS.csv')
  const csvContent = fs.readFileSync(csvPath, 'utf-8')
  
  // Parse CSV
  const lines = csvContent.split('\n').filter(line => line.trim())
  const headers = lines[0].split(',').map(h => h.trim())
  const records: ExpenseRow[] = []
  
  for (let i = 1; i < lines.length; i++) {
    const values = lines[i].split(',').map(v => v.trim())
    const record: any = {}
    headers.forEach((header, idx) => {
      record[header] = values[idx] || ''
    })
    records.push(record as ExpenseRow)
  }

  console.log(`📊 Loaded ${records.length} expense records\n`)

  // Classify each expense
  const classified: Array<ExpenseRow & {
    CATEGORIA_GASTO: string
    SUBCATEGORIA_GASTO: string
    TIPO_ASIGNACION: string
    PLANTA_O_BU: string
  }> = []

  for (const record of records) {
    const classification = classifyExpense(record.CONCEPTO, record.DEPARTAMENTO)
    const assignmentType = determineAssignmentType(record.PLANTA)
    const plantaNormalized = normalizePlantCode(record.PLANTA)

    classified.push({
      ...record,
      CATEGORIA_GASTO: classification.categoria,
      SUBCATEGORIA_GASTO: classification.subcategoria,
      TIPO_ASIGNACION: assignmentType,
      PLANTA_O_BU: plantaNormalized
    })
  }

  // Write classified CSV
  const outputPath = path.join(process.cwd(), 'GASTOS_NOVIEMBRE_CLASIFICADOS.csv')
  const outputLines = [
    'CONCEPTO,VALOR,PLANTA_O_BU,DEPARTAMENTO,CATEGORIA_GASTO,SUBCATEGORIA_GASTO,TIPO_ASIGNACION,NOTAS'
  ]

  for (const record of classified) {
    const line = [
      record.CONCEPTO,
      record.VALOR,
      record.PLANTA_O_BU,
      record.DEPARTAMENTO,
      record.CATEGORIA_GASTO,
      record.SUBCATEGORIA_GASTO,
      record.TIPO_ASIGNACION,
      '' // NOTES column
    ].join(',')
    outputLines.push(line)
  }

  fs.writeFileSync(outputPath, outputLines.join('\n'), 'utf-8')

  // Summary
  const byType = classified.reduce((acc, r) => {
    acc[r.TIPO_ASIGNACION] = (acc[r.TIPO_ASIGNACION] || 0) + 1
    return acc
  }, {} as Record<string, number>)

  const totalAmount = classified.reduce((sum, r) => sum + parseFloat(r.VALOR.replace(/,/g, '') || '0'), 0)

  console.log('📊 CLASSIFICATION SUMMARY')
  console.log('='.repeat(60))
  console.log(`Total expenses: ${classified.length}`)
  console.log(`Total amount: $${totalAmount.toFixed(2)}`)
  console.log('\nBy assignment type:')
  Object.entries(byType).forEach(([type, count]) => {
    console.log(`  ${type}: ${count} expenses`)
  })
  console.log(`\n✅ Classified CSV saved to: ${outputPath}`)
}

main().catch(console.error)

