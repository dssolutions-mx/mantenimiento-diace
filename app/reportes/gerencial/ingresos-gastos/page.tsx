'use client'

import React, { useState, useEffect } from 'react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { RefreshCw, Download, AlertCircle, Settings, ChevronRight, ChevronDown, Loader2, ArrowUpRight, ArrowDownRight, Minus } from 'lucide-react'
import { useRouter } from 'next/navigation'
import * as XLSX from 'xlsx'
import { useToast } from '@/hooks/use-toast'

type PlantData = {
  plant_id: string
  plant_name: string
  plant_code: string
  business_unit_id: string

  // Ingresos Concreto
  volumen_concreto: number
  fc_ponderada: number
  edad_ponderada: number
  pv_unitario: number
  ventas_total: number

  // Costo Materia Prima
  costo_mp_unitario: number
  consumo_cem_m3: number
  costo_cem_m3: number
  costo_cem_pct: number
  costo_mp_total: number
  costo_mp_pct: number

  // Spread
  spread_unitario: number
  spread_unitario_pct: number

  // Costo Operativo
  diesel_total: number
  diesel_unitario: number
  diesel_pct: number
  mantto_total: number
  mantto_unitario: number
  mantto_pct: number
  nomina_total: number
  nomina_unitario: number
  nomina_pct: number
  otros_indirectos_total: number
  otros_indirectos_unitario: number
  otros_indirectos_pct: number
  total_costo_op: number
  total_costo_op_pct: number

  // EBITDA
  ebitda: number
  ebitda_pct: number

  // Bombeo
  ingresos_bombeo_vol?: number
  ingresos_bombeo_unit?: number
  ingresos_bombeo_total?: number

  // EBITDA con bombeo
  ebitda_con_bombeo?: number
  ebitda_con_bombeo_pct?: number
}

type ReportData = {
  month: string
  plants: PlantData[]
  comparison?: {
    month: string
    plants: PlantData[]
  }
  deltas?: Record<string, Record<string, { current: number; previous: number; delta: number; deltaPct: number | null }>>
  comparisonMonth?: string
  filters: {
    businessUnits: Array<{ id: string; name: string; code: string }>
    plants: Array<{ id: string; name: string; code: string; business_unit_id: string }>
  }
}

type CostDetails = {
  departments: Array<{
    department: string
    expense_category?: string | null
    expense_subcategory?: string | null
    total: number
    entries: Array<{
      id: string
      description: string | null
      subcategory: string | null
      expense_category?: string | null
      expense_subcategory?: string | null
      amount: number
      is_distributed: boolean
      distribution_method: string | null
    }>
  }>
}

const formatCurrency = (amount: number) =>
  new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN', minimumFractionDigits: 0, maximumFractionDigits: 0 }).format(amount)

const formatNumber = (num: number, decimals: number = 2) =>
  new Intl.NumberFormat('es-MX', { minimumFractionDigits: decimals, maximumFractionDigits: decimals }).format(num)

const formatPercent = (pct: number) => `${formatNumber(pct, 2)}%`

export default function IngresosGastosPage() {
  const router = useRouter()
  const { toast } = useToast()
  const [loading, setLoading] = useState(false)
  const [refreshingView, setRefreshingView] = useState(false)
  const [data, setData] = useState<ReportData | null>(null)
  
  const [selectedMonth, setSelectedMonth] = useState(() => {
    const now = new Date()
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
  })
  const [businessUnitId, setBusinessUnitId] = useState<string>('')
  const [plantId, setPlantId] = useState<string>('')
  const [groupByBusinessUnit, setGroupByBusinessUnit] = useState(false)
  
  // State for expandable costs: Map<`${plantId}-${category}`, boolean>
  const [expandedCosts, setExpandedCosts] = useState<Map<string, boolean>>(new Map())
  // State for expanded departments: Map<`${plantId}-${category}-${department}`, boolean>
  const [expandedDepartments, setExpandedDepartments] = useState<Map<string, boolean>>(new Map())
  // State for cost details: Map<`${plantId}-${category}`, CostDetails>
  const [costDetails, setCostDetails] = useState<Map<string, CostDetails>>(new Map())
  // State for loading cost details: Map<`${plantId}-${category}`, boolean>
  const [loadingCostDetails, setLoadingCostDetails] = useState<Map<string, boolean>>(new Map())

  useEffect(() => {
    if (selectedMonth) {
      loadData()
    }
  }, [selectedMonth, businessUnitId, plantId])

  const loadData = async () => {
    setLoading(true)
    try {
      const resp = await fetch('/api/reports/gerencial/ingresos-gastos', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          month: selectedMonth,
          businessUnitId: businessUnitId || null,
          plantId: plantId || null
        })
      })

      const result = await resp.json()
      if (!resp.ok) {
        throw new Error(result.error || 'Failed to load data')
      }

      setData(result)
    } catch (err: any) {
      console.error('Error loading ingresos-gastos:', err)
      setData({
        month: selectedMonth,
        plants: [],
        filters: { businessUnits: [], plants: [] }
      })
    } finally {
      setLoading(false)
    }
  }

  const handleBusinessUnitChange = (value: string) => {
    setBusinessUnitId(value === 'all' ? '' : value)
    setPlantId('')
  }

  const handlePlantChange = (value: string) => {
    setPlantId(value === 'all' ? '' : value)
  }

  const handleRefreshView = async () => {
    if (!selectedMonth) {
      toast({
        variant: 'destructive',
        title: 'Error',
        description: 'Por favor seleccione un mes antes de refrescar los datos históricos.'
      })
      return
    }

    setRefreshingView(true)
    try {
      const resp = await fetch('/api/reports/gerencial/ingresos-gastos/refresh-view', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ month: selectedMonth })
      })

      const result = await resp.json()

      if (!resp.ok) {
        throw new Error(result.error || result.details || 'Failed to refresh historical data')
      }

      toast({
        title: 'Éxito',
        description: result.message || `Datos históricos recalculados para ${selectedMonth}. ${result.plantsBackfilled || 0} plantas actualizadas.`
      })

      // Automatically reload report data after successful refresh
      await loadData()
    } catch (err: any) {
      console.error('Error refreshing view:', err)
      toast({
        variant: 'destructive',
        title: 'Error',
        description: err.message || 'No se pudo refrescar los datos históricos. Por favor intente nuevamente.'
      })
    } finally {
      setRefreshingView(false)
    }
  }

  const toggleCostExpansion = async (category: 'nomina' | 'otros_indirectos') => {
    const key = `all-${category}`
    const isExpanded = expandedCosts.get(key) || false
    
    if (!isExpanded) {
      // Fetch cost details for ALL plants when expanding
      setLoadingCostDetails(prev => new Map(prev).set(key, true))
      try {
        // Fetch details for all plants in parallel
        const detailPromises = plants.map(plant =>
          fetch(`/api/reports/gerencial/ingresos-gastos/details?month=${selectedMonth}&plantId=${plant.plant_id}&category=${category}`)
            .then(res => res.ok ? res.json() : null)
            .catch(() => null)
        )
        
        const allDetails = await Promise.all(detailPromises)
        
        // Aggregate departments across all plants
        const departmentMap = new Map<string, {
          department: string
          total: number
          entriesByPlant: Map<string, Array<{
            id: string
            description: string | null
            subcategory: string | null
            amount: number
            is_distributed: boolean
            distribution_method: string | null
          }>>
        }>()
        
        allDetails.forEach((details, plantIndex) => {
          if (!details?.departments) return
          const plant = plants[plantIndex]
          
          details.departments.forEach((dept: any) => {
            const deptKey = dept.department
            if (!departmentMap.has(deptKey)) {
              departmentMap.set(deptKey, {
                department: deptKey,
                total: 0,
                entriesByPlant: new Map()
              })
            }
            
            const deptData = departmentMap.get(deptKey)!
            deptData.total += dept.total
            deptData.entriesByPlant.set(plant.plant_id, dept.entries)
          })
        })
        
        // Convert to array format
        const aggregatedDetails: CostDetails = {
          departments: Array.from(departmentMap.values()).map(dept => ({
            department: dept.department,
            total: dept.total,
            entries: Array.from(dept.entriesByPlant.entries()).flatMap(([plantId, entries]) =>
              entries.map(entry => ({ ...entry, plantId }))
            )
          }))
        }
        
        setCostDetails(prev => new Map(prev).set(key, aggregatedDetails))
      } catch (err) {
        console.error('Error loading cost details:', err)
      } finally {
        setLoadingCostDetails(prev => {
          const newMap = new Map(prev)
          newMap.delete(key)
          return newMap
        })
      }
    }
    
    setExpandedCosts(prev => {
      const newMap = new Map(prev)
      newMap.set(key, !isExpanded)
      return newMap
    })
  }

  const toggleDepartmentExpansion = (category: 'nomina' | 'otros_indirectos', department: string) => {
    const key = `${category}-${department}`
    setExpandedDepartments(prev => {
      const newMap = new Map(prev)
      newMap.set(key, !(prev.get(key) || false))
      return newMap
    })
  }

  const exportToExcel = () => {
    if (!data || plants.length === 0) return

    const workbook = XLSX.utils.book_new()
    
    // Prepare data for export
    const exportData: any[] = []
    const hasComparison = previousPlants.length > 0
    
    // Build headers first to know column count
    const headers = ['Métrica']
    if (groupByBusinessUnit && groupedPlants) {
      Object.entries(groupedPlants).forEach(([buId, buPlants]) => {
        const buName = businessUnitNames.get(buId) || 'Sin Unidad'
        headers.push(buName)
      })
      headers.push('TOTAL')
    } else {
      plants.forEach(plant => {
        headers.push(plant.plant_code || plant.plant_name)
      })
      headers.push('TOTAL')
    }

    if (hasComparison) {
      headers.push(`Δ vs ${comparisonLabel}`)
      headers.push(`%Δ vs ${comparisonLabel}`)
    }
    
    // Title and metadata rows
    const reportTitle = 'REPORTE GERENCIAL - INGRESOS VS GASTOS'
    const monthDisplay = new Date(`${selectedMonth}-01`).toLocaleDateString('es-MX', { year: 'numeric', month: 'long' })
    exportData.push([reportTitle, ...Array(headers.length - 1).fill('')])
    exportData.push([`Período: ${monthDisplay}`, ...Array(headers.length - 1).fill('')])
    exportData.push([]) // Empty row
    
    // Header row
    exportData.push(headers)

    // Track row metadata for styling
    const rowMetadata: Array<{ type: 'title' | 'section' | 'metric' | 'total' | 'empty', rowIndex: number }> = [
      { type: 'title', rowIndex: 0 },
      { type: 'title', rowIndex: 1 },
      { type: 'empty', rowIndex: 2 },
      { type: 'metric', rowIndex: 3 } // Header row
    ]
    let currentRowIndex = 4

    // Helper to add a row with metadata tracking
    const addRow = (label: string, getValue: (plant: PlantData) => number, formatFn: (val: number) => string, metricKey: string, isTotalRow = false) => {
      const row: any[] = [label]
      if (groupByBusinessUnit && groupedPlants) {
        // Use calculateBUValue for correct aggregation
        const metricType = getMetricType(metricKey)
        Object.entries(groupedPlants).forEach(([buId, buPlants]) => {
          const buValue = calculateBUValue(buPlants, getValue, metricType, metricKey)
          row.push(buValue) // Store as number for proper Excel formatting
        })
        const grandTotal = calculateGrandTotal(getValue, metricKey)
        row.push(grandTotal)
        if (hasComparison) {
          const previousTotal = calculateGrandTotal(getValue, metricKey, previousPlants)
          const delta = grandTotal - previousTotal
          const deltaPct = previousTotal === 0 ? null : (delta / previousTotal) * 100
          row.push(delta)
          row.push(deltaPct === null ? null : deltaPct / 100)
        }
      } else {
        plants.forEach(plant => {
          row.push(getValue(plant)) // Store as number
        })
        const grandTotal = calculateGrandTotal(getValue, metricKey)
        row.push(grandTotal)

        if (hasComparison) {
          const previousTotal = calculateGrandTotal(getValue, metricKey, previousPlants)
          const delta = grandTotal - previousTotal
          const deltaPct = previousTotal === 0 ? null : (delta / previousTotal) * 100
          row.push(delta)
          row.push(deltaPct === null ? null : deltaPct / 100) // store as decimal for Excel percent
        }
      }
      exportData.push(row)
      rowMetadata.push({ 
        type: isTotalRow ? 'total' : 'metric', 
        rowIndex: currentRowIndex++ 
      })
    }

    // Ingresos Concreto Section
    exportData.push(['INGRESOS CONCRETO', ...Array(headers.length - 1).fill('')])
    rowMetadata.push({ type: 'section', rowIndex: currentRowIndex++ })
    addRow('Volumen Concreto (m³)', p => p.volumen_concreto, val => formatNumber(val, 2), 'volumen_concreto')
    addRow('f\'c Ponderada (kg/cm²)', p => p.fc_ponderada, val => formatNumber(val, 2), 'fc_ponderada')
    addRow('Edad Ponderada (días)', p => p.edad_ponderada, val => formatNumber(val, 2), 'edad_ponderada')
    addRow('PV Unitario', p => p.pv_unitario, formatCurrency, 'pv_unitario')
    addRow('Ventas Total Concreto', p => p.ventas_total, formatCurrency, 'ventas_total', true)
    exportData.push([])
    rowMetadata.push({ type: 'empty', rowIndex: currentRowIndex++ })

    // Costo Materia Prima Section
    exportData.push(['COSTO MATERIA PRIMA', ...Array(headers.length - 1).fill('')])
    rowMetadata.push({ type: 'section', rowIndex: currentRowIndex++ })
    addRow('Costo MP Unitario', p => p.costo_mp_unitario, formatCurrency, 'costo_mp_unitario')
    addRow('Consumo Cem / m3 (kg)', p => p.consumo_cem_m3, val => formatNumber(val, 2), 'consumo_cem_m3')
    addRow('Costo Cem / m3 ($ Unitario)', p => p.costo_cem_m3, formatCurrency, 'costo_cem_m3')
    addRow('Costo Cem %', p => p.costo_cem_pct, formatPercent, 'costo_cem_pct')
    addRow('Costo MP Total Concreto', p => p.costo_mp_total, formatCurrency, 'costo_mp_total', true)
    addRow('Costo MP %', p => p.costo_mp_pct, formatPercent, 'costo_mp_pct')
    exportData.push([])
    rowMetadata.push({ type: 'empty', rowIndex: currentRowIndex++ })

    // Spread Section
    exportData.push(['SPREAD', ...Array(headers.length - 1).fill('')])
    rowMetadata.push({ type: 'section', rowIndex: currentRowIndex++ })
    addRow('Spread Unitario', p => p.spread_unitario, formatCurrency, 'spread_unitario')
    addRow('Spread Unitario %', p => p.spread_unitario_pct, formatPercent, 'spread_unitario_pct')
    exportData.push([])
    rowMetadata.push({ type: 'empty', rowIndex: currentRowIndex++ })

    // Costo Operativo Section
    exportData.push(['COSTO OPERATIVO', ...Array(headers.length - 1).fill('')])
    rowMetadata.push({ type: 'section', rowIndex: currentRowIndex++ })
    addRow('Diesel (Todas las Unidades)', p => p.diesel_total, formatCurrency, 'diesel_total')
    addRow('Diesel Unitario (m3)', p => p.diesel_unitario, formatCurrency, 'diesel_unitario')
    addRow('Diesel %', p => p.diesel_pct, formatPercent, 'diesel_pct')
    addRow('MANTTO. (Todas las Unidades)', p => p.mantto_total, formatCurrency, 'mantto_total')
    addRow('Mantto. Unitario (m3)', p => p.mantto_unitario, formatCurrency, 'mantto_unitario')
    addRow('Mantenimiento %', p => p.mantto_pct, formatPercent, 'mantto_pct')
    addRow('Nómina Totales', p => p.nomina_total, formatCurrency, 'nomina_total')
    addRow('Nómina Unitario (m3)', p => p.nomina_unitario, formatCurrency, 'nomina_unitario')
    addRow('Nómina %', p => p.nomina_pct, formatPercent, 'nomina_pct')
    addRow('Otros Indirectos Totales', p => p.otros_indirectos_total, formatCurrency, 'otros_indirectos_total')
    addRow('Otros Indirectos Unitario (m3)', p => p.otros_indirectos_unitario, formatCurrency, 'otros_indirectos_unitario')
    addRow('Otros Indirectos %', p => p.otros_indirectos_pct, formatPercent, 'otros_indirectos_pct')
    addRow('TOTAL COSTO OP', p => p.total_costo_op, formatCurrency, 'total_costo_op', true)
    addRow('TOTAL COSTO OP %', p => p.total_costo_op_pct, formatPercent, 'total_costo_op_pct')
    exportData.push([])
    rowMetadata.push({ type: 'empty', rowIndex: currentRowIndex++ })

    // EBITDA Section
    exportData.push(['EBITDA', ...Array(headers.length - 1).fill('')])
    rowMetadata.push({ type: 'section', rowIndex: currentRowIndex++ })
    addRow('EBITDA', p => p.ebitda, formatCurrency, 'ebitda', true)
    addRow('EBITDA %', p => p.ebitda_pct, formatPercent, 'ebitda_pct')

    // Bombeo Section
    if (plants.some(p => p.ingresos_bombeo_vol && p.ingresos_bombeo_vol > 0)) {
      exportData.push([])
      rowMetadata.push({ type: 'empty', rowIndex: currentRowIndex++ })
      exportData.push(['INGRESOS BOMBEO', ...Array(headers.length - 1).fill('')])
      rowMetadata.push({ type: 'section', rowIndex: currentRowIndex++ })
      addRow('Ingresos Bombeo Vol', p => p.ingresos_bombeo_vol || 0, val => formatNumber(val, 2), 'ingresos_bombeo_vol')
      addRow('Ingresos Bombeo $ Unit', p => p.ingresos_bombeo_unit || 0, formatCurrency, 'ingresos_bombeo_unit')
      addRow('Ingreso Bombeo Total', p => p.ingresos_bombeo_total || 0, formatCurrency, 'ingresos_bombeo_total')
      
      exportData.push([])
      rowMetadata.push({ type: 'empty', rowIndex: currentRowIndex++ })
      exportData.push(['EBITDA CON BOMBEO', ...Array(headers.length - 1).fill('')])
      rowMetadata.push({ type: 'section', rowIndex: currentRowIndex++ })
      addRow('EBITDA con bombeo', p => p.ebitda_con_bombeo || 0, formatCurrency, 'ebitda_con_bombeo', true)
      addRow('EBITDA con bombeo %', p => p.ebitda_con_bombeo_pct || 0, formatPercent, 'ebitda_con_bombeo_pct')
    }

    // Create worksheet
    const worksheet = XLSX.utils.aoa_to_sheet(exportData)
    
    // Set column widths - wider for metric column, narrower for data columns
    const columnWidths = [
      { wch: 38 }, // Metric column
      ...Array(headers.length - 1).fill({ wch: 16 }) // Data columns
    ]
    worksheet['!cols'] = columnWidths

    // Freeze first row (header) and first column (metrics)
    worksheet['!freeze'] = { xSplit: 1, ySplit: 4, topLeftCell: 'B5', activePane: 'bottomRight', state: 'frozen' }

    // Default border style
    const defaultBorder = {
      top: { style: 'thin', color: { rgb: 'CCCCCC' } },
      bottom: { style: 'thin', color: { rgb: 'CCCCCC' } },
      left: { style: 'thin', color: { rgb: 'CCCCCC' } },
      right: { style: 'thin', color: { rgb: 'CCCCCC' } }
    }

    const thickBorder = {
      top: { style: 'medium', color: { rgb: '000000' } },
      bottom: { style: 'medium', color: { rgb: '000000' } },
      left: { style: 'medium', color: { rgb: '000000' } },
      right: { style: 'medium', color: { rgb: '000000' } }
    }

    // Apply comprehensive styling
    const range = XLSX.utils.decode_range(worksheet['!ref'] || 'A1')
    
    for (let row = 0; row <= range.e.r; row++) {
      for (let col = 0; col <= range.e.c; col++) {
        const cellAddress = XLSX.utils.encode_cell({ r: row, c: col })
        if (!worksheet[cellAddress]) continue

        const metadata = rowMetadata.find(m => m.rowIndex === row)
        const rowLabel = exportData[row]?.[0] || ''
        const isHeaderRow = row === 3
        const isTitleRow = row === 0 || row === 1
        const isSectionRow = metadata?.type === 'section'
        const isTotalRow = metadata?.type === 'total'
        const isMetricCol = col === 0
        const totalColIndex = hasComparison ? headers.length - 3 : headers.length - 1
        const deltaColIndex = hasComparison ? headers.length - 2 : -1
        const deltaPctColIndex = hasComparison ? headers.length - 1 : -1
        const isTotalCol = col === totalColIndex
        const isDeltaCol = col === deltaColIndex
        const isDeltaPctCol = col === deltaPctColIndex
        const isDataCell = col > 0 && col < headers.length

        let cellStyle: any = {
          border: defaultBorder,
          alignment: { 
            horizontal: isMetricCol ? 'left' : 'right', 
            vertical: 'center',
            wrapText: true
          }
        }

        // Title rows
        if (isTitleRow) {
          cellStyle.font = { bold: true, sz: row === 0 ? 16 : 12, color: { rgb: '1F497D' } }
          cellStyle.fill = { fgColor: { rgb: 'E7F3FF' } }
          cellStyle.alignment.horizontal = 'left'
          if (row === 0) {
            cellStyle.border = thickBorder
          }
        }
        // Header row
        else if (isHeaderRow) {
          cellStyle.font = { bold: true, sz: 11, color: { rgb: 'FFFFFF' } }
          cellStyle.fill = { fgColor: { rgb: '1F497D' } }
          cellStyle.alignment.horizontal = 'center'
          cellStyle.border = thickBorder
        }
        // Section headers
        else if (isSectionRow && isMetricCol) {
          cellStyle.font = { bold: true, sz: 11, color: { rgb: 'FFFFFF' } }
          cellStyle.fill = { fgColor: { rgb: '4472C4' } }
          cellStyle.alignment.horizontal = 'left'
          cellStyle.border = thickBorder
        }
        // Total rows
        else if (isTotalRow) {
          cellStyle.font = { bold: true, sz: 11 }
          if (isMetricCol) {
            cellStyle.fill = { fgColor: { rgb: 'E2EFDA' } }
          } else {
            cellStyle.fill = { fgColor: { rgb: 'FFF2CC' } }
          }
          cellStyle.border = thickBorder
        }
        // Regular metric rows
        else if (isMetricCol && metadata?.type === 'metric') {
          cellStyle.font = { sz: 10 }
          cellStyle.fill = { fgColor: { rgb: 'F8F9FA' } }
        }
        // Data cells
        else if (isDataCell && metadata?.type === 'metric') {
          cellStyle.font = { sz: 10 }
          cellStyle.numFmt = '#,##0.00' // Number format with thousands separator
        }
        // Total column cells
        else if ((isDeltaCol || isDeltaPctCol) && metadata?.type === 'metric') {
          cellStyle.font = { sz: 10, italic: true }
          cellStyle.fill = { fgColor: { rgb: 'F3F4F6' } }
          cellStyle.numFmt = rowLabel.includes('%') || isDeltaPctCol ? '0.00%' : '$#,##0.00'
        }
        else if (isTotalCol && metadata?.type === 'metric') {
          cellStyle.font = { bold: true, sz: 10 }
          cellStyle.fill = { fgColor: { rgb: 'E7F3FF' } }
          cellStyle.numFmt = '#,##0.00'
        }

        // Apply number formatting based on content
        const cellValue = worksheet[cellAddress].v
        if (typeof cellValue === 'number' && !isMetricCol) {
          if (rowLabel.includes('%')) {
            cellStyle.numFmt = '0.00%'
          } else if (rowLabel.includes('m³') || rowLabel.includes('kg') || rowLabel.includes('días') || rowLabel.includes('cm²')) {
            cellStyle.numFmt = '#,##0.00'
          } else {
            cellStyle.numFmt = '$#,##0.00'
          }
        }

        worksheet[cellAddress].s = cellStyle
      }
    }

    // Merge title cells
    const titleRange = XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: 0, c: headers.length - 1 } })
    if (!worksheet['!merges']) worksheet['!merges'] = []
    worksheet['!merges'].push({ s: { r: 0, c: 0 }, e: { r: 0, c: headers.length - 1 } })
    worksheet['!merges'].push({ s: { r: 1, c: 0 }, e: { r: 1, c: headers.length - 1 } })

    // Add worksheet to workbook
    XLSX.utils.book_append_sheet(workbook, worksheet, `Ingresos vs Gastos`)

    // Generate Excel file
    const excelBuffer = XLSX.write(workbook, { type: 'array', bookType: 'xlsx' })
    const blob = new Blob([excelBuffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })
    
    // Download
    const url = window.URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.style.display = 'none'
    a.href = url
    a.download = `Ingresos-vs-Gastos-${selectedMonth}.xlsx`
    document.body.appendChild(a)
    a.click()
    window.URL.revokeObjectURL(url)
    document.body.removeChild(a)
  }

  const availablePlants = data?.filters.plants.filter(p =>
    !businessUnitId || p.business_unit_id === businessUnitId
  ) || []

  // Filter plants with no data (already filtered in API, but ensure client-side too)
  const filteredPlants = (data?.plants || []).filter(plant => {
    return plant.ventas_total > 0 || 
      plant.diesel_total > 0 || 
      plant.mantto_total > 0 || 
      plant.nomina_total > 0 || 
      plant.otros_indirectos_total > 0
  })

  // Group plants by business unit if enabled
  const groupedPlants = groupByBusinessUnit 
    ? filteredPlants.reduce((acc, plant) => {
        const buId = plant.business_unit_id || 'unassigned'
        if (!acc[buId]) {
          acc[buId] = []
        }
        acc[buId].push(plant)
        return acc
      }, {} as Record<string, PlantData[]>)
    : null

  // Get business unit names
  const businessUnitNames = new Map<string, string>()
  data?.filters.businessUnits.forEach(bu => {
    businessUnitNames.set(bu.id, bu.name)
  })

  const plants = filteredPlants

  // Metric type mapping for correct aggregation
  const metricTypes: Record<string, 'total' | 'unit' | 'percent' | 'weighted_avg' | 'consumption'> = {
    // Totals
    'ventas_total': 'total',
    'diesel_total': 'total',
    'mantto_total': 'total',
    'nomina_total': 'total',
    'otros_indirectos_total': 'total',
    'total_costo_op': 'total',
    'ebitda': 'total',
    'costo_mp_total': 'total',
    'ingresos_bombeo_total': 'total',
    'ebitda_con_bombeo': 'total',
    
    // Unit costs
    'pv_unitario': 'unit',
    'costo_mp_unitario': 'unit',
    'costo_cem_m3': 'unit',
    'diesel_unitario': 'unit',
    'mantto_unitario': 'unit',
    'nomina_unitario': 'unit',
    'otros_indirectos_unitario': 'unit',
    'spread_unitario': 'unit',
    
    // Percentages
    'costo_cem_pct': 'percent',
    'costo_mp_pct': 'percent',
    'diesel_pct': 'percent',
    'mantto_pct': 'percent',
    'nomina_pct': 'percent',
    'otros_indirectos_pct': 'percent',
    'total_costo_op_pct': 'percent',
    'ebitda_pct': 'percent',
    'spread_unitario_pct': 'percent',
    'ebitda_con_bombeo_pct': 'percent',
    
    // Weighted averages (volume-weighted)
    'fc_ponderada': 'weighted_avg',
    'edad_ponderada': 'weighted_avg',
    
    // Consumption (recalculated from total consumption / total volume)
    'consumo_cem_m3': 'consumption',
    
    // Volumes (simple sum)
    'volumen_concreto': 'total',
    'ingresos_bombeo_vol': 'total',
    'ingresos_bombeo_unit': 'unit'
  }

  // Metrics that should render as currency for deltas
  const currencyMetrics = new Set<string>([
    'ventas_total',
    'diesel_total',
    'diesel_unitario',
    'mantto_total',
    'mantto_unitario',
    'nomina_total',
    'nomina_unitario',
    'otros_indirectos_total',
    'otros_indirectos_unitario',
    'total_costo_op',
    'pv_unitario',
    'costo_mp_unitario',
    'costo_cem_m3',
    'costo_mp_total',
    'spread_unitario',
    'ingresos_bombeo_total',
    'ingresos_bombeo_unit',
    'ebitda',
    'ebitda_con_bombeo'
  ])

  // Expense metrics where reduction is good (invert color logic)
  const expenseMetrics = new Set<string>([
    'diesel_total',
    'diesel_unitario',
    'diesel_pct',
    'mantto_total',
    'mantto_unitario',
    'mantto_pct',
    'nomina_total',
    'nomina_unitario',
    'nomina_pct',
    'otros_indirectos_total',
    'otros_indirectos_unitario',
    'otros_indirectos_pct',
    'costo_mp_total',
    'costo_mp_unitario',
    'costo_cem_m3',
    'costo_cem_pct',
    'costo_mp_pct',
    'total_costo_op',
    'total_costo_op_pct'
  ])

  // Helper function to get metric type from getter function
  // This requires passing a metric identifier along with the getter
  const getMetricType = (metricKey: string): 'total' | 'unit' | 'percent' | 'weighted_avg' | 'consumption' => {
    return metricTypes[metricKey] || 'total'
  }

  const isPercentMetric = (metricKey: string) => {
    const key = (metricKey || '').toLowerCase()
    return getMetricType(metricKey) === 'percent' || key.includes('_pct') || key.includes('percent') || key.includes('%')
  }

  const formatDeltaValue = (metricKey: string, value: number) => {
    if (isPercentMetric(metricKey)) {
      return formatPercent(value)
    }
    if (currencyMetrics.has(metricKey)) {
      return formatCurrency(value)
    }
    return formatNumber(value, 2)
  }

  // Helper function to calculate BU aggregated value based on metric type
  const calculateBUValue = (
    buPlants: PlantData[],
    getValue: (plant: PlantData) => number,
    metricType: 'total' | 'unit' | 'percent' | 'weighted_avg' | 'consumption',
    metricKey: string // Used to determine numerator/denominator for unit/percent calculations
  ): number => {
    if (buPlants.length === 0) return 0

    switch (metricType) {
      case 'total':
        return buPlants.reduce((sum, p) => sum + getValue(p), 0)
      
      case 'unit': {
        // For unit costs, we need to find the corresponding total and divide by volume
        // Map metric keys to their corresponding total metric keys
        const unitToTotalMap: Record<string, string> = {
          'pv_unitario': 'ventas_total',
          'costo_mp_unitario': 'costo_mp_total',
          'costo_cem_m3': 'costo_mp_total', // Approximate - uses MP total
          'diesel_unitario': 'diesel_total',
          'mantto_unitario': 'mantto_total',
          'nomina_unitario': 'nomina_total',
          'otros_indirectos_unitario': 'otros_indirectos_total',
          'spread_unitario': 'ventas_total', // Approximate - uses ventas
          'ingresos_bombeo_unit': 'ingresos_bombeo_vol'
        }
        
        const totalKey = unitToTotalMap[metricKey]
        if (!totalKey) {
          // Fallback: simple average if mapping not found
          const total = buPlants.reduce((sum, p) => sum + getValue(p), 0)
          return total / buPlants.length
        }
        
        const totalVolume = buPlants.reduce((sum, p) => sum + p.volumen_concreto, 0)
        if (totalVolume === 0) return 0
        
        if (metricKey === 'pv_unitario') {
          const totalSales = buPlants.reduce((sum, p) => sum + p.ventas_total, 0)
          return totalSales / totalVolume
        } else if (metricKey === 'costo_mp_unitario') {
          const totalMP = buPlants.reduce((sum, p) => sum + p.costo_mp_total, 0)
          return totalMP / totalVolume
        } else if (metricKey === 'costo_cem_m3') {
          // This is tricky - we'd need total cement cost, but we can approximate
          const totalMP = buPlants.reduce((sum, p) => sum + p.costo_mp_total, 0)
          return totalMP / totalVolume // Approximation
        } else if (metricKey === 'diesel_unitario') {
          const totalDiesel = buPlants.reduce((sum, p) => sum + p.diesel_total, 0)
          return totalDiesel / totalVolume
        } else if (metricKey === 'mantto_unitario') {
          const totalMantto = buPlants.reduce((sum, p) => sum + p.mantto_total, 0)
          return totalMantto / totalVolume
        } else if (metricKey === 'nomina_unitario') {
          const totalNomina = buPlants.reduce((sum, p) => sum + p.nomina_total, 0)
          return totalNomina / totalVolume
        } else if (metricKey === 'otros_indirectos_unitario') {
          const totalOtros = buPlants.reduce((sum, p) => sum + p.otros_indirectos_total, 0)
          return totalOtros / totalVolume
        } else if (metricKey === 'spread_unitario') {
          const totalVentas = buPlants.reduce((sum, p) => sum + p.ventas_total, 0)
          const totalMP = buPlants.reduce((sum, p) => sum + p.costo_mp_total, 0)
          return (totalVentas - totalMP) / totalVolume
        } else if (metricKey === 'ingresos_bombeo_unit') {
          const totalBombeoVol = buPlants.reduce((sum, p) => sum + (p.ingresos_bombeo_vol || 0), 0)
          if (totalBombeoVol === 0) return 0
          // Would need ingresos_bombeo_total, but it's not in the data structure
          // Fallback to weighted average
          const weightedSum = buPlants.reduce((sum, p) => {
            const val = p.ingresos_bombeo_unit || 0
            const vol = p.ingresos_bombeo_vol || 0
            return sum + (val * vol)
          }, 0)
          return weightedSum / totalBombeoVol
        }
        
        return 0
      }
      
      case 'percent': {
        // Special handling for ebitda_con_bombeo_pct
        if (metricKey === 'ebitda_con_bombeo_pct') {
          const totalEbitdaConBombeo = buPlants.reduce((sum, p) => sum + (p.ebitda_con_bombeo || 0), 0)
          const totalVentas = buPlants.reduce((sum, p) => sum + p.ventas_total, 0)
          const totalBombeo = buPlants.reduce((sum, p) => sum + (p.ingresos_bombeo_total || 0), 0)
          const totalIngresosConBombeo = totalVentas + totalBombeo
          if (totalIngresosConBombeo === 0) return 0
          return (totalEbitdaConBombeo / totalIngresosConBombeo) * 100
        }
        
        // Special handling for ebitda_pct - denominator is only ventas_total (concreto), NOT bombeo
        // EBITDA con bombeo uses totalIngresos (ventas + bombeo) as denominator
        if (metricKey === 'ebitda_pct') {
          const totalEbitda = buPlants.reduce((sum, p) => sum + p.ebitda, 0)
          const totalVentas = buPlants.reduce((sum, p) => sum + p.ventas_total, 0)
          // EBITDA % is calculated only on concreto sales, not bombeo income
          if (totalVentas === 0) return 0
          return (totalEbitda / totalVentas) * 100
        }
        
        // For percentages, we need the numerator (cost) and denominator (sales)
        const percentToNumeratorMap: Record<string, (p: PlantData) => number> = {
          'costo_cem_pct': p => p.costo_mp_total, // Approximation
          'costo_mp_pct': p => p.costo_mp_total,
          'diesel_pct': p => p.diesel_total,
          'mantto_pct': p => p.mantto_total,
          'nomina_pct': p => p.nomina_total,
          'otros_indirectos_pct': p => p.otros_indirectos_total,
          'total_costo_op_pct': p => p.total_costo_op,
          'spread_unitario_pct': p => p.ventas_total - p.costo_mp_total
        }
        
        const getNumerator = percentToNumeratorMap[metricKey]
        if (!getNumerator) return 0
        
        const totalNumerator = buPlants.reduce((sum, p) => sum + getNumerator(p), 0)
        const totalDenominator = buPlants.reduce((sum, p) => sum + p.ventas_total, 0)
        
        if (totalDenominator === 0) return 0
        return (totalNumerator / totalDenominator) * 100
      }
      
      case 'weighted_avg': {
        // Volume-weighted average
        const totalVolume = buPlants.reduce((sum, p) => sum + p.volumen_concreto, 0)
        if (totalVolume === 0) return 0
        
        const weightedSum = buPlants.reduce((sum, p) => {
          const value = getValue(p)
          const volume = p.volumen_concreto
          return sum + (value * volume)
        }, 0)
        
        return weightedSum / totalVolume
      }
      
      case 'consumption': {
        // Recalculate from total consumption / total volume
        // consumo_cem_m3 is already per m³, so we need: sum(consumo * volumen) / sum(volumen)
        const totalVolume = buPlants.reduce((sum, p) => sum + p.volumen_concreto, 0)
        if (totalVolume === 0) return 0
        
        const totalConsumption = buPlants.reduce((sum, p) => {
          const consumoPerM3 = getValue(p) // consumo_cem_m3
          const volumen = p.volumen_concreto
          return sum + (consumoPerM3 * volumen)
        }, 0)
        
        return totalConsumption / totalVolume
      }
      
      default:
        return buPlants.reduce((sum, p) => sum + getValue(p), 0)
    }
  }

  // Helper function to calculate grand total for a metric
  const calculateGrandTotal = (
    getValue: (plant: PlantData) => number,
    metricKey?: string,
    sourcePlants: PlantData[] = plants
  ): number => {
    // For unit costs, recalculate as total_cost / total_volume (not sum of unit costs)
    if (metricKey && getMetricType(metricKey) === 'unit') {
      const totalVolume = sourcePlants.reduce((sum, p) => sum + p.volumen_concreto, 0)
      if (totalVolume === 0) return 0

      // Map unit metrics to their corresponding total metrics
      const unitToTotalMap: Record<string, (p: PlantData) => number> = {
        'pv_unitario': p => p.ventas_total,
        'costo_mp_unitario': p => p.costo_mp_total,
        'costo_cem_m3': p => p.costo_mp_total, // Approximate - uses MP total
        'diesel_unitario': p => p.diesel_total,
        'mantto_unitario': p => p.mantto_total,
        'nomina_unitario': p => p.nomina_total,
        'otros_indirectos_unitario': p => p.otros_indirectos_total,
        'spread_unitario': p => p.ventas_total - p.costo_mp_total,
        'ingresos_bombeo_unit': p => p.ingresos_bombeo_total || 0
      }

      const getTotal = unitToTotalMap[metricKey]
      if (getTotal) {
        const totalCost = sourcePlants.reduce((sum, p) => sum + getTotal(p), 0)
        return totalCost / totalVolume
      }
    }

    // For percentages, ALWAYS recalculate from aggregated totals (not sum of percentages)
    if (metricKey && getMetricType(metricKey) === 'percent') {
      // Special handling for ebitda_con_bombeo_pct
      if (metricKey === 'ebitda_con_bombeo_pct') {
        const totalEbitdaConBombeo = sourcePlants.reduce((sum, p) => sum + (p.ebitda_con_bombeo || 0), 0)
        const totalVentas = sourcePlants.reduce((sum, p) => sum + p.ventas_total, 0)
        const totalBombeo = sourcePlants.reduce((sum, p) => sum + (p.ingresos_bombeo_total || 0), 0)
        const totalIngresosConBombeo = totalVentas + totalBombeo
        if (totalIngresosConBombeo === 0) return 0
        return (totalEbitdaConBombeo / totalIngresosConBombeo) * 100
      }
      
      // Special handling for ebitda_pct - denominator is only ventas_total (concreto), NOT bombeo
      // EBITDA con bombeo uses totalIngresos (ventas + bombeo) as denominator
      if (metricKey === 'ebitda_pct') {
        const totalEbitda = sourcePlants.reduce((sum, p) => sum + p.ebitda, 0)
        const totalVentas = sourcePlants.reduce((sum, p) => sum + p.ventas_total, 0)
        // EBITDA % is calculated only on concreto sales, not bombeo income
        if (totalVentas === 0) return 0
        return (totalEbitda / totalVentas) * 100
      }
      
      // For other percentages, recalculate from numerator/denominator
      const percentToNumeratorMap: Record<string, (p: PlantData) => number> = {
        'costo_cem_pct': p => p.costo_mp_total,
        'costo_mp_pct': p => p.costo_mp_total,
        'diesel_pct': p => p.diesel_total,
        'mantto_pct': p => p.mantto_total,
        'nomina_pct': p => p.nomina_total,
        'otros_indirectos_pct': p => p.otros_indirectos_total,
        'total_costo_op_pct': p => p.total_costo_op,
        'spread_unitario_pct': p => p.ventas_total - p.costo_mp_total
      }
      
      const getNumerator = percentToNumeratorMap[metricKey]
      if (getNumerator) {
        const totalNumerator = sourcePlants.reduce((sum, p) => sum + getNumerator(p), 0)
        const totalDenominator = sourcePlants.reduce((sum, p) => sum + p.ventas_total, 0)
        if (totalDenominator === 0) return 0
        return (totalNumerator / totalDenominator) * 100
      }
    }
    
    // For non-percentages, sum normally
    return sourcePlants.reduce((sum, plant) => sum + getValue(plant), 0)
  }

  // Helper function to render grand total cell
  const renderGrandTotalCell = (
    total: number,
    formatFn: (val: number) => string,
    isTotalRow = false,
    showDelta = false,
    previousTotal?: number,
    metricKey?: string
  ) => {
    const delta = previousTotal !== undefined ? total - previousTotal : 0
    const deltaPct = previousTotal ? (delta / previousTotal) * 100 : null
    const hasPrev = previousTotal !== undefined
    const deltaBadge = showDelta
      ? (() => {
          if (!hasPrev) {
            return (
              <span className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">
                <Minus className="w-3 h-3" />
                N/A
              </span>
            )
          }
          if (Math.abs(delta) < 0.0001) {
            return (
              <span className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">
                <Minus className="w-3 h-3" />
                0
              </span>
            )
          }
          // For expenses: reduction (negative delta) is good (green), increase (positive delta) is bad (red)
          // For spread/margin: increase (positive delta) is good (green), decrease (negative delta) is bad (red)
          const isExpense = expenseMetrics.has(metricKey || '')
          const isGood = isExpense ? delta < 0 : delta > 0
          // Arrow direction reflects actual change direction (up = increase, down = decrease)
          // Color reflects whether that change is favorable (green) or unfavorable (red)
          const Icon = delta > 0 ? ArrowUpRight : ArrowDownRight
          const colorClasses = isGood
            ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-200'
            : 'bg-rose-50 text-rose-700 dark:bg-rose-950/40 dark:text-rose-200'
          const showPct = deltaPct !== null && !isPercentMetric(metricKey || '')
          const pctText = showPct ? ` (${formatPercent(deltaPct!)})` : ''
          return (
            <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium ${colorClasses}`}>
              <Icon className="w-3 h-3" />
              {formatDeltaValue(metricKey || '', delta)}{pctText}
            </span>
          )
        })()
      : null

    return (
      <td className={`sticky right-0 z-10 bg-muted/30 text-right p-3 font-medium min-w-[140px] ${isTotalRow ? 'font-bold text-lg' : ''}`}>
        <div className="flex flex-col items-end gap-1">
          <span>{formatFn(total)}</span>
          {deltaBadge}
        </div>
      </td>
    )
  }

  // Render plants columns (handles grouping)
  const renderPlantColumns = (
    getValue: (plant: PlantData) => number, 
    formatFn: (val: number) => string, 
    metricKey: string,
    isTotalRow = false,
    showDelta = false
  ) => {
    const getDeltaBadge = (deltaValue: number, deltaPct: number | null, hasPrev: boolean) => {
      if (!hasPrev) {
        return (
          <span className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground" aria-label="Sin datos previos">
            <Minus className="w-3 h-3" />
            N/A
          </span>
        )
      }
      if (Math.abs(deltaValue) < 0.0001) {
        return (
          <span className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground" aria-label="Sin cambio">
            <Minus className="w-3 h-3" />
            0
          </span>
        )
      }

      // For expenses: reduction (negative delta) is good (green), increase (positive delta) is bad (red)
      // For spread/margin: increase (positive delta) is good (green), decrease (negative delta) is bad (red)
      const isExpense = expenseMetrics.has(metricKey)
      const isGood = isExpense ? deltaValue < 0 : deltaValue > 0
      // Arrow direction reflects actual change direction (up = increase, down = decrease)
      // Color reflects whether that change is favorable (green) or unfavorable (red)
      const Icon = deltaValue > 0 ? ArrowUpRight : ArrowDownRight
      const colorClasses = isGood
        ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-200'
        : 'bg-rose-50 text-rose-700 dark:bg-rose-950/40 dark:text-rose-200'
      const showPct = deltaPct !== null && !isPercentMetric(metricKey)
      const pctText = showPct ? ` (${formatPercent(deltaPct!)})` : ''

      return (
        <span
          className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium ${colorClasses}`}
          aria-label={`Cambio ${isGood ? 'favorable' : 'desfavorable'} ${formatDeltaValue(metricKey, deltaValue)}${pctText}`}
        >
          <Icon className="w-3 h-3" />
          {formatDeltaValue(metricKey, deltaValue)}{pctText}
        </span>
      )
    }

    const getDeltaForPlant = (plant: PlantData) => {
      const prev = previousPlantMap.get(plant.plant_code) || null
      const prevVal = prev ? (prev as any)[metricKey] ?? 0 : 0
      const currVal = getValue(plant)
      const delta = currVal - prevVal
      const deltaPct = prevVal === 0 ? null : (delta / prevVal) * 100
      return { delta, deltaPct, hasPrev: !!prev }
    }

    if (groupByBusinessUnit && groupedPlants) {
      // Render grouped by BU - use correct calculation based on metric type
      const metricType = getMetricType(metricKey)
      return (
        <>
          {Object.entries(groupedPlants).map(([buId, buPlants]) => {
            const buValue = calculateBUValue(buPlants, getValue, metricType, metricKey)
            const prevBuPlants = groupedPlantsPrevious?.[buId] || []
            const prevBuValue = calculateBUValue(prevBuPlants, getValue, metricType, metricKey)
            const delta = buValue - prevBuValue
            const deltaPct = prevBuValue === 0 ? null : (delta / prevBuValue) * 100
            return (
              <td key={buId} className={`text-right p-3 border-r ${isTotalRow ? 'font-bold text-lg' : ''}`}>
                <div className="flex flex-col items-end gap-1">
                  <span>{formatFn(buValue)}</span>
                  {showDelta && getDeltaBadge(delta, deltaPct, prevBuPlants.length > 0)}
                </div>
              </td>
            )
          })}
        </>
      )
    } else {
      // Render flat list
      return (
        <>
          {plants.map(plant => (
            <td key={plant.plant_id} className={`text-right p-3 border-r ${isTotalRow ? 'font-bold text-lg' : ''}`}>
              <div className="flex flex-col items-end gap-1">
                <span>{formatFn(getValue(plant))}</span>
                {showDelta && (() => {
                  const { delta, deltaPct, hasPrev } = getDeltaForPlant(plant)
                  return getDeltaBadge(delta, deltaPct, hasPrev)
                })()}
              </div>
            </td>
          ))}
        </>
      )
    }
  }

  const previousPlants = data?.comparison?.plants || []
  const previousPlantMap = React.useMemo(() => {
    const map = new Map<string, PlantData>()
    previousPlants.forEach(p => {
      if (p.plant_code) {
        map.set(p.plant_code, p)
      }
    })
    return map
  }, [previousPlants])

  const groupedPlantsPrevious = groupByBusinessUnit
    ? previousPlants.reduce((acc, plant) => {
        const buId = plant.business_unit_id || 'unassigned'
        if (!acc[buId]) acc[buId] = []
        acc[buId].push(plant)
        return acc
      }, {} as Record<string, PlantData[]>)
    : null

  const comparisonLabel = React.useMemo(() => {
    return data?.comparison?.month || data?.comparisonMonth || 'mes anterior'
  }, [data?.comparison?.month, data?.comparisonMonth])

  // Calculate plant column count (for colspan)
  const plantColumnCount: number = groupByBusinessUnit && groupedPlants
    ? Object.keys(groupedPlants).length // Only count BU columns when grouped (not including grand total)
    : plants.length

  return (
    <div className="container mx-auto py-6 px-4 max-w-[1600px] space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Ingresos vs Gastos</h1>
          <p className="text-muted-foreground">
            Análisis financiero mensual por planta: ingresos, costos y EBITDA
          </p>
        </div>
        <div className="flex gap-2">
          <Button
            variant="outline"
            onClick={() => router.push('/reportes/gerencial/manual-costs')}
          >
            <Settings className="w-4 h-4 mr-2" />
            Gestionar Costos Manuales
          </Button>
        </div>
      </div>

      {/* Filters */}
      <Card>
        <CardContent className="pt-6">
          <div className="grid grid-cols-1 md:grid-cols-5 gap-4">
            <div>
              <Label htmlFor="month">Mes</Label>
              <Input
                id="month"
                type="month"
                value={selectedMonth}
                onChange={(e) => setSelectedMonth(e.target.value)}
              />
            </div>

            <div>
              <Label>Unidad de Negocio</Label>
              <Select value={businessUnitId || 'all'} onValueChange={handleBusinessUnitChange}>
                <SelectTrigger>
                  <SelectValue placeholder="Todas" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Todas las unidades</SelectItem>
                  {data?.filters.businessUnits.map(bu => (
                    <SelectItem key={bu.id} value={bu.id}>{bu.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div>
              <Label>Planta</Label>
              <Select value={plantId || 'all'} onValueChange={handlePlantChange}>
                <SelectTrigger>
                  <SelectValue placeholder="Todas" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Todas las plantas</SelectItem>
                  {availablePlants.map(plant => (
                    <SelectItem key={plant.id} value={plant.id}>{plant.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="flex items-center gap-3">
              <div className="flex items-center gap-2">
                <Switch
                  id="group-by-bu"
                  checked={groupByBusinessUnit}
                  onCheckedChange={setGroupByBusinessUnit}
                />
                <Label htmlFor="group-by-bu" className="cursor-pointer">
                  Agrupar por Unidad de Negocio
                </Label>
              </div>
            </div>

            <div className="flex items-end gap-2">
              <Button onClick={loadData} disabled={loading || refreshingView} className="flex-1">
                <RefreshCw className={`w-4 h-4 mr-2 ${loading ? 'animate-spin' : ''}`} />
                {loading ? 'Cargando...' : 'Actualizar'}
              </Button>
              <Button 
                variant="outline" 
                disabled={!selectedMonth || loading || refreshingView}
                onClick={handleRefreshView}
                title="Recalcula los datos históricos del mes seleccionado usando los precios más recientes"
              >
                <RefreshCw className={`w-4 h-4 mr-2 ${refreshingView ? 'animate-spin' : ''}`} />
                {refreshingView ? 'Recalculando...' : 'Refrescar Datos'}
              </Button>
              <Button variant="outline" disabled={!data || loading || refreshingView || plants.length === 0} onClick={exportToExcel}>
                <Download className="w-4 h-4" />
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Main Table */}
      {plants.length === 0 ? (
        <Card>
          <CardContent className="py-12">
            <div className="flex flex-col items-center justify-center text-center gap-4">
              <AlertCircle className="w-12 h-12 text-muted-foreground opacity-50" />
              <div>
                <p className="text-lg font-medium">No hay datos disponibles</p>
                <p className="text-sm text-muted-foreground">
                  No se encontraron datos para el mes seleccionado. Verifica que existan registros en la vista financiera.
                </p>
              </div>
            </div>
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardHeader>
            <CardTitle>Tabla Financiera - {selectedMonth}</CardTitle>
            <CardDescription>
              Datos consolidados por planta con cálculos automáticos y manuales
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="overflow-x-auto">
              <table className="w-full text-sm border-collapse">
                <thead>
                  <tr className="border-b-2">
                    <th className="sticky left-0 z-10 bg-background text-left p-3 font-medium min-w-[200px] border-r-2">
                      Métrica
                    </th>
                    {groupByBusinessUnit && groupedPlants ? (
                      // Render grouped headers - only show BU totals, hide individual plants
                      <>
                        {Object.entries(groupedPlants).map(([buId, buPlants]) => (
                          <th key={buId} className="text-right p-3 font-medium min-w-[140px] border-r">
                            {businessUnitNames.get(buId) || 'Total'}
                          </th>
                        ))}
                        <th className="sticky right-0 z-10 bg-muted/30 text-right p-3 font-medium min-w-[140px] border-r-2">
                          TOTAL
                        </th>
                      </>
                    ) : (
                      // Render flat headers
                      <>
                        {plants.map(plant => (
                          <th key={plant.plant_id} className="text-right p-3 font-medium min-w-[140px] border-r">
                            {plant.plant_code || plant.plant_name}
                          </th>
                        ))}
                        <th className="sticky right-0 z-10 bg-muted/30 text-right p-3 font-medium min-w-[140px] border-r-2">
                          TOTAL
                        </th>
                      </>
                    )}
                  </tr>
                </thead>
                <tbody>
                  {/* INGRESOS CONCRETO SECTION */}
                  <tr className="bg-blue-50 dark:bg-blue-950/20">
                    <td colSpan={plantColumnCount + 1} className="p-2 font-semibold text-sm uppercase tracking-wide">
                      Ingresos Concreto
                    </td>
                  </tr>
                  <tr className="border-b hover:bg-muted/30">
                    <td className="sticky left-0 z-10 bg-background p-3 border-r-2">Volumen Concreto (m³)</td>
                    {renderPlantColumns(p => p.volumen_concreto, (val) => formatNumber(val, 2), 'volumen_concreto', false, true)}
                    {renderGrandTotalCell(
                      calculateGrandTotal(p => p.volumen_concreto),
                      (val) => formatNumber(val, 2),
                      false,
                      true,
                      calculateGrandTotal(p => p.volumen_concreto, 'volumen_concreto', previousPlants),
                      'volumen_concreto'
                    )}
                  </tr>
                  <tr className="border-b hover:bg-muted/30">
                    <td className="sticky left-0 z-10 bg-background p-3 border-r-2">f'c Ponderada (kg/cm²)</td>
                    {renderPlantColumns(p => p.fc_ponderada, (val) => formatNumber(val, 2), 'fc_ponderada')}
                    {renderGrandTotalCell(calculateGrandTotal(p => p.fc_ponderada), (val) => formatNumber(val, 2))}
                  </tr>
                  <tr className="border-b hover:bg-muted/30">
                    <td className="sticky left-0 z-10 bg-background p-3 border-r-2">Edad Ponderada (días)</td>
                    {renderPlantColumns(p => p.edad_ponderada, (val) => formatNumber(val, 2), 'edad_ponderada')}
                    {renderGrandTotalCell(calculateGrandTotal(p => p.edad_ponderada), (val) => formatNumber(val, 2))}
                  </tr>
                  <tr className="border-b hover:bg-muted/30">
                    <td className="sticky left-0 z-10 bg-background p-3 border-r-2">PV Unitario</td>
                    {renderPlantColumns(p => p.pv_unitario, formatCurrency, 'pv_unitario')}
                    {renderGrandTotalCell(calculateGrandTotal(p => p.pv_unitario), formatCurrency)}
                  </tr>
                  <tr className="border-b hover:bg-muted/30 bg-blue-100/50 dark:bg-blue-900/20">
                    <td className="sticky left-0 z-10 bg-blue-100 dark:bg-blue-900/30 p-3 border-r-2 font-bold">Ventas Total Concreto</td>
                    {renderPlantColumns(p => p.ventas_total, formatCurrency, 'ventas_total', true, true)}
                    {renderGrandTotalCell(
                      calculateGrandTotal(p => p.ventas_total),
                      formatCurrency,
                      true,
                      true,
                      calculateGrandTotal(p => p.ventas_total, 'ventas_total', previousPlants),
                      'ventas_total'
                    )}
                  </tr>

                  {/* COSTO MATERIA PRIMA SECTION */}
                  <tr className="bg-orange-50 dark:bg-orange-950/20">
                    <td colSpan={plantColumnCount + 1} className="p-2 font-semibold text-sm uppercase tracking-wide">
                      Costo Materia Prima
                    </td>
                  </tr>
                  <tr className="border-b hover:bg-muted/30">
                    <td className="sticky left-0 z-10 bg-background p-3 border-r-2">Costo MP Unitario</td>
                    {renderPlantColumns(p => p.costo_mp_unitario, formatCurrency, 'costo_mp_unitario')}
                    {renderGrandTotalCell(calculateGrandTotal(p => p.costo_mp_unitario), formatCurrency)}
                  </tr>
                  <tr className="border-b hover:bg-muted/30">
                    <td className="sticky left-0 z-10 bg-background p-3 border-r-2">Consumo Cem / m3 (kg)</td>
                    {renderPlantColumns(p => p.consumo_cem_m3, (val) => formatNumber(val, 2), 'consumo_cem_m3')}
                    {renderGrandTotalCell(calculateGrandTotal(p => p.consumo_cem_m3), (val) => formatNumber(val, 2))}
                  </tr>
                  <tr className="border-b hover:bg-muted/30">
                    <td className="sticky left-0 z-10 bg-background p-3 border-r-2">Costo Cem / m3 ($ Unitario)</td>
                    {renderPlantColumns(p => p.costo_cem_m3, formatCurrency, 'costo_cem_m3')}
                    {renderGrandTotalCell(calculateGrandTotal(p => p.costo_cem_m3), formatCurrency)}
                  </tr>
                  <tr className="border-b hover:bg-muted/30">
                    <td className="sticky left-0 z-10 bg-background p-3 border-r-2">Costo Cem %</td>
                    {renderPlantColumns(p => p.costo_cem_pct, formatPercent, 'costo_cem_pct')}
                    {renderGrandTotalCell(calculateGrandTotal(p => p.costo_cem_pct, 'costo_cem_pct'), formatPercent)}
                  </tr>
                  <tr className="border-b hover:bg-muted/30 bg-orange-100/50 dark:bg-orange-900/20">
                    <td className="sticky left-0 z-10 bg-orange-100 dark:bg-orange-900/30 p-3 border-r-2 font-bold">Costo MP Total Concreto</td>
                    {renderPlantColumns(p => p.costo_mp_total, formatCurrency, 'costo_mp_total', true, true)}
                    {renderGrandTotalCell(
                      calculateGrandTotal(p => p.costo_mp_total),
                      formatCurrency,
                      true,
                      true,
                      calculateGrandTotal(p => p.costo_mp_total, 'costo_mp_total', previousPlants),
                      'costo_mp_total'
                    )}
                  </tr>
                  <tr className="border-b hover:bg-muted/30">
                    <td className="sticky left-0 z-10 bg-background p-3 border-r-2">Costo MP %</td>
                    {renderPlantColumns(p => p.costo_mp_pct, formatPercent, 'costo_mp_pct')}
                    {renderGrandTotalCell(calculateGrandTotal(p => p.costo_mp_pct, 'costo_mp_pct'), formatPercent)}
                  </tr>

                  {/* SPREAD SECTION */}
                  <tr className="bg-green-50 dark:bg-green-950/20">
                    <td colSpan={plantColumnCount + 1} className="p-2 font-semibold text-sm uppercase tracking-wide">
                      Spread
                    </td>
                  </tr>
                  <tr className="border-b hover:bg-muted/30">
                    <td className="sticky left-0 z-10 bg-background p-3 border-r-2">Spread Unitario</td>
                    {renderPlantColumns(p => p.spread_unitario, formatCurrency, 'spread_unitario', false, true)}
                    {renderGrandTotalCell(
                      calculateGrandTotal(p => p.spread_unitario),
                      formatCurrency,
                      false,
                      true,
                      calculateGrandTotal(p => p.spread_unitario, 'spread_unitario', previousPlants),
                      'spread_unitario'
                    )}
                  </tr>
                  <tr className="border-b hover:bg-muted/30">
                    <td className="sticky left-0 z-10 bg-background p-3 border-r-2">Spread Unitario %</td>
                    {renderPlantColumns(p => p.spread_unitario_pct, formatPercent, 'spread_unitario_pct', false, true)}
                    {renderGrandTotalCell(
                      calculateGrandTotal(p => p.spread_unitario_pct, 'spread_unitario_pct'),
                      formatPercent,
                      false,
                      true,
                      calculateGrandTotal(p => p.spread_unitario_pct, 'spread_unitario_pct', previousPlants),
                      'spread_unitario_pct'
                    )}
                  </tr>

                  {/* COSTO OPERATIVO SECTION */}
                  <tr className="bg-purple-50 dark:bg-purple-950/20">
                    <td colSpan={plantColumnCount + 1} className="p-2 font-semibold text-sm uppercase tracking-wide">
                      Costo Operativo
                    </td>
                  </tr>
                  <tr className="border-b hover:bg-muted/30 bg-yellow-50/50 dark:bg-yellow-900/10">
                    <td className="sticky left-0 z-10 bg-yellow-50 dark:bg-yellow-900/20 p-3 border-r-2 font-semibold">Diesel (Todas las Unidades)</td>
                    {renderPlantColumns(p => p.diesel_total, formatCurrency, 'diesel_total', false, true)}
                    {renderGrandTotalCell(
                      calculateGrandTotal(p => p.diesel_total),
                      formatCurrency,
                      false,
                      true,
                      calculateGrandTotal(p => p.diesel_total, 'diesel_total', previousPlants),
                      'diesel_total'
                    )}
                  </tr>
                  <tr className="border-b hover:bg-muted/30">
                    <td className="sticky left-0 z-10 bg-background p-3 border-r-2">Diesel Unitario (m3)</td>
                    {renderPlantColumns(p => p.diesel_unitario, formatCurrency, 'diesel_unitario', false, true)}
                    {renderGrandTotalCell(
                      calculateGrandTotal(p => p.diesel_unitario),
                      formatCurrency,
                      false,
                      true,
                      calculateGrandTotal(p => p.diesel_unitario, 'diesel_unitario', previousPlants),
                      'diesel_unitario'
                    )}
                  </tr>
                  <tr className="border-b hover:bg-muted/30">
                    <td className="sticky left-0 z-10 bg-background p-3 border-r-2">Diesel %</td>
                    {renderPlantColumns(p => p.diesel_pct, formatPercent, 'diesel_pct', false, true)}
                    {renderGrandTotalCell(
                      calculateGrandTotal(p => p.diesel_pct, 'diesel_pct'),
                      formatPercent,
                      false,
                      true,
                      calculateGrandTotal(p => p.diesel_pct, 'diesel_pct', previousPlants),
                      'diesel_pct'
                    )}
                  </tr>
                  <tr className="border-b hover:bg-muted/30 bg-orange-50/50 dark:bg-orange-900/10">
                    <td className="sticky left-0 z-10 bg-orange-50 dark:bg-orange-900/20 p-3 border-r-2 font-semibold">MANTTO. (Todas las Unidades)</td>
                    {renderPlantColumns(p => p.mantto_total, formatCurrency, 'mantto_total', false, true)}
                    {renderGrandTotalCell(
                      calculateGrandTotal(p => p.mantto_total),
                      formatCurrency,
                      false,
                      true,
                      calculateGrandTotal(p => p.mantto_total, 'mantto_total', previousPlants),
                      'mantto_total'
                    )}
                  </tr>
                  <tr className="border-b hover:bg-muted/30">
                    <td className="sticky left-0 z-10 bg-background p-3 border-r-2">Mantto. Unitario (m3)</td>
                    {renderPlantColumns(p => p.mantto_unitario, formatCurrency, 'mantto_unitario')}
                    {renderGrandTotalCell(calculateGrandTotal(p => p.mantto_unitario), formatCurrency)}
                  </tr>
                  <tr className="border-b hover:bg-muted/30">
                    <td className="sticky left-0 z-10 bg-background p-3 border-r-2">Mantenimiento %</td>
                    {renderPlantColumns(p => p.mantto_pct, formatPercent, 'mantto_pct')}
                    {renderGrandTotalCell(calculateGrandTotal(p => p.mantto_pct, 'mantto_pct'), formatPercent)}
                  </tr>
                  {/* Nómina Totales - Expandable */}
                  <tr className="border-b hover:bg-muted/30 bg-amber-50/50 dark:bg-amber-900/10">
                    <td className="sticky left-0 z-10 bg-amber-50 dark:bg-amber-900/20 p-3 border-r-2 font-semibold">
                      <button
                        onClick={() => toggleCostExpansion('nomina')}
                        className="flex items-center gap-2 hover:opacity-70 transition-opacity"
                        disabled={groupByBusinessUnit}
                      >
                        {expandedCosts.get('all-nomina') ? (
                          <ChevronDown className="w-4 h-4" />
                        ) : (
                          <ChevronRight className="w-4 h-4" />
                        )}
                        Nómina Totales
                      </button>
                    </td>
                    {renderPlantColumns(p => p.nomina_total, formatCurrency, 'nomina_total', false, true)}
                    {renderGrandTotalCell(
                      calculateGrandTotal(p => p.nomina_total),
                      formatCurrency,
                      false,
                      true,
                      calculateGrandTotal(p => p.nomina_total, 'nomina_total', previousPlants),
                      'nomina_total'
                    )}
                  </tr>
                  {/* Expanded Nómina details - grouped by department across all plants */}
                  {!groupByBusinessUnit && (() => {
                    const key = 'all-nomina'
                    const isExpanded = expandedCosts.get(key) || false
                    const details = costDetails.get(key)
                    const isLoading = loadingCostDetails.get(key) || false
                    
                    if (!isExpanded) return null
                    
                    // Aggregate departments with plant-specific amounts
                    const departmentMap = new Map<string, {
                      department: string
                      totalsByPlant: Map<string, number>
                      entriesByPlant: Map<string, Array<{
                        id: string
                        description: string | null
                        subcategory: string | null
                        amount: number
                        plantId?: string
                      }>>
                    }>()
                    
                    if (details?.departments) {
                      details.departments.forEach(dept => {
                        if (!departmentMap.has(dept.department)) {
                          departmentMap.set(dept.department, {
                            department: dept.department,
                            totalsByPlant: new Map(),
                            entriesByPlant: new Map()
                          })
                        }
                        
                        const deptData = departmentMap.get(dept.department)!
                        // Group entries by plant
                        dept.entries.forEach(entry => {
                          const plantId = (entry as any).plantId || 'unknown'
                          if (!deptData.totalsByPlant.has(plantId)) {
                            deptData.totalsByPlant.set(plantId, 0)
                            deptData.entriesByPlant.set(plantId, [])
                          }
                          deptData.totalsByPlant.set(plantId, deptData.totalsByPlant.get(plantId)! + entry.amount)
                          deptData.entriesByPlant.get(plantId)!.push(entry)
                        })
                      })
                    }
                    
                    return (
                      <>
                        {isLoading ? (
                          <tr>
                            <td colSpan={plantColumnCount + 2} className="p-4 text-center">
                              <Loader2 className="w-4 h-4 animate-spin inline mr-2" />
                              Cargando detalles...
                            </td>
                          </tr>
                        ) : departmentMap.size > 0 ? (
                          Array.from(departmentMap.entries()).map(([deptName, deptData]) => {
                            const deptKey = `nomina-${deptName}`
                            const isDeptExpanded = expandedDepartments.get(deptKey) || false
                            const grandTotal = Array.from(deptData.totalsByPlant.values()).reduce((sum, val) => sum + val, 0)
                            
                            return (
                              <React.Fragment key={deptKey}>
                                <tr className="bg-muted/20">
                                  <td className="sticky left-0 z-10 bg-muted/30 pl-6 p-3 border-r-2 font-medium">
                                    <button
                                      onClick={() => toggleDepartmentExpansion('nomina', deptName)}
                                      className="flex items-center gap-2 hover:opacity-70 transition-opacity"
                                    >
                                      {isDeptExpanded ? (
                                        <ChevronDown className="w-4 h-4" />
                                      ) : (
                                        <ChevronRight className="w-4 h-4" />
                                      )}
                                      {deptName}
                                    </button>
                                  </td>
                                  {plants.map(plant => (
                                    <td key={plant.plant_id} className="text-right p-3 border-r">
                                      {formatCurrency(deptData.totalsByPlant.get(plant.plant_id) || 0)}
                                    </td>
                                  ))}
                                  {renderGrandTotalCell(grandTotal, formatCurrency)}
                                </tr>
                                {isDeptExpanded && Array.from(deptData.entriesByPlant.entries()).map(([plantId, entries]) => {
                                  const plant = plants.find(p => p.plant_id === plantId)
                                  if (!plant || entries.length === 0) return null
                                  
                                  return entries.map(entry => (
                                    <tr key={`${entry.id}-${plantId}`} className="bg-muted/10">
                                      <td className="sticky left-0 z-10 bg-background pl-10 p-3 border-r-2">
                                        {entry.description || entry.subcategory || 'Sin descripción'}
                                      </td>
                                      {plants.map(p => (
                                        <td key={p.plant_id} className="text-right p-3 border-r">
                                          {p.plant_id === plantId ? formatCurrency(entry.amount) : ''}
                                        </td>
                                      ))}
                                      {renderGrandTotalCell(entry.amount, formatCurrency)}
                                    </tr>
                                  ))
                                })}
                              </React.Fragment>
                            )
                          })
                        ) : (
                          <tr>
                            <td colSpan={plantColumnCount + 2} className="pl-6 p-3 text-muted-foreground">
                              No hay costos manuales registrados
                            </td>
                          </tr>
                        )}
                      </>
                    )
                  })()}
                  <tr className="border-b hover:bg-muted/30">
                    <td className="sticky left-0 z-10 bg-background p-3 border-r-2">Nómina Unitario (m3)</td>
                    {renderPlantColumns(p => p.nomina_unitario, formatCurrency, 'nomina_unitario', false, true)}
                    {renderGrandTotalCell(
                      calculateGrandTotal(p => p.nomina_unitario),
                      formatCurrency,
                      false,
                      true,
                      calculateGrandTotal(p => p.nomina_unitario, 'nomina_unitario', previousPlants),
                      'nomina_unitario'
                    )}
                  </tr>
                  <tr className="border-b hover:bg-muted/30">
                    <td className="sticky left-0 z-10 bg-background p-3 border-r-2">Nómina %</td>
                    {renderPlantColumns(p => p.nomina_pct, formatPercent, 'nomina_pct', false, true)}
                    {renderGrandTotalCell(
                      calculateGrandTotal(p => p.nomina_pct, 'nomina_pct'),
                      formatPercent,
                      false,
                      true,
                      calculateGrandTotal(p => p.nomina_pct, 'nomina_pct', previousPlants),
                      'nomina_pct'
                    )}
                  </tr>
                  {/* Otros Indirectos Totales - Expandable */}
                  <tr className="border-b hover:bg-muted/30 bg-cyan-50/50 dark:bg-cyan-900/10">
                    <td className="sticky left-0 z-10 bg-cyan-50 dark:bg-cyan-900/20 p-3 border-r-2 font-semibold">
                      <button
                        onClick={() => toggleCostExpansion('otros_indirectos')}
                        className="flex items-center gap-2 hover:opacity-70 transition-opacity"
                        disabled={groupByBusinessUnit}
                      >
                        {expandedCosts.get('all-otros_indirectos') ? (
                          <ChevronDown className="w-4 h-4" />
                        ) : (
                          <ChevronRight className="w-4 h-4" />
                        )}
                        Otros Indirectos Totales
                      </button>
                    </td>
                    {renderPlantColumns(p => p.otros_indirectos_total, formatCurrency, 'otros_indirectos_total', false, true)}
                    {renderGrandTotalCell(
                      calculateGrandTotal(p => p.otros_indirectos_total),
                      formatCurrency,
                      false,
                      true,
                      calculateGrandTotal(p => p.otros_indirectos_total, 'otros_indirectos_total', previousPlants),
                      'otros_indirectos_total'
                    )}
                  </tr>
                  {/* Expanded Otros Indirectos details - grouped by department across all plants */}
                  {!groupByBusinessUnit && (() => {
                    const key = 'all-otros_indirectos'
                    const isExpanded = expandedCosts.get(key) || false
                    const details = costDetails.get(key)
                    const isLoading = loadingCostDetails.get(key) || false
                    
                    if (!isExpanded) return null
                    
                    // Aggregate departments with plant-specific amounts
                    const departmentMap = new Map<string, {
                      department: string
                      totalsByPlant: Map<string, number>
                      entriesByPlant: Map<string, Array<{
                        id: string
                        description: string | null
                        subcategory: string | null
                        amount: number
                        plantId?: string
                      }>>
                    }>()
                    
                    if (details?.departments) {
                      details.departments.forEach(dept => {
                        if (!departmentMap.has(dept.department)) {
                          departmentMap.set(dept.department, {
                            department: dept.department,
                            totalsByPlant: new Map(),
                            entriesByPlant: new Map()
                          })
                        }
                        
                        const deptData = departmentMap.get(dept.department)!
                        // Group entries by plant
                        dept.entries.forEach(entry => {
                          const plantId = (entry as any).plantId || 'unknown'
                          if (!deptData.totalsByPlant.has(plantId)) {
                            deptData.totalsByPlant.set(plantId, 0)
                            deptData.entriesByPlant.set(plantId, [])
                          }
                          deptData.totalsByPlant.set(plantId, deptData.totalsByPlant.get(plantId)! + entry.amount)
                          deptData.entriesByPlant.get(plantId)!.push(entry)
                        })
                      })
                    }
                    
                    return (
                      <>
                        {isLoading ? (
                          <tr>
                            <td colSpan={plantColumnCount + 2} className="p-4 text-center">
                              <Loader2 className="w-4 h-4 animate-spin inline mr-2" />
                              Cargando detalles...
                            </td>
                          </tr>
                        ) : departmentMap.size > 0 ? (
                          Array.from(departmentMap.entries()).map(([deptName, deptData]) => {
                            const deptKey = `otros_indirectos-${deptName}`
                            const isDeptExpanded = expandedDepartments.get(deptKey) || false
                            const grandTotal = Array.from(deptData.totalsByPlant.values()).reduce((sum, val) => sum + val, 0)
                            
                            return (
                              <React.Fragment key={deptKey}>
                                <tr className="bg-muted/20">
                                  <td className="sticky left-0 z-10 bg-muted/30 pl-6 p-3 border-r-2 font-medium">
                                    <button
                                      onClick={() => toggleDepartmentExpansion('otros_indirectos', deptName)}
                                      className="flex items-center gap-2 hover:opacity-70 transition-opacity"
                                    >
                                      {isDeptExpanded ? (
                                        <ChevronDown className="w-4 h-4" />
                                      ) : (
                                        <ChevronRight className="w-4 h-4" />
                                      )}
                                      {deptName}
                                    </button>
                                  </td>
                                  {plants.map(plant => (
                                    <td key={plant.plant_id} className="text-right p-3 border-r">
                                      {formatCurrency(deptData.totalsByPlant.get(plant.plant_id) || 0)}
                                    </td>
                                  ))}
                                  {renderGrandTotalCell(grandTotal, formatCurrency)}
                                </tr>
                                {isDeptExpanded && Array.from(deptData.entriesByPlant.entries()).map(([plantId, entries]) => {
                                  const plant = plants.find(p => p.plant_id === plantId)
                                  if (!plant || entries.length === 0) return null
                                  
                                  return entries.map(entry => {
                                    // For otros_indirectos, prefer expense_subcategory, then description, then subcategory
                                    const displayText = (entry as any).expense_subcategory 
                                      || entry.description 
                                      || entry.subcategory 
                                      || 'Sin descripción'
                                    
                                    return (
                                      <tr key={`${entry.id}-${plantId}`} className="bg-muted/10">
                                        <td className="sticky left-0 z-10 bg-background pl-10 p-3 border-r-2">
                                          {displayText}
                                        </td>
                                        {plants.map(p => (
                                          <td key={p.plant_id} className="text-right p-3 border-r">
                                            {p.plant_id === plantId ? formatCurrency(entry.amount) : ''}
                                          </td>
                                        ))}
                                        {renderGrandTotalCell(entry.amount, formatCurrency)}
                                      </tr>
                                    )
                                  })
                                })}
                              </React.Fragment>
                            )
                          })
                        ) : (
                          <tr>
                            <td colSpan={plantColumnCount + 2} className="pl-6 p-3 text-muted-foreground">
                              No hay costos manuales registrados
                            </td>
                          </tr>
                        )}
                      </>
                    )
                  })()}
                  <tr className="border-b hover:bg-muted/30">
                    <td className="sticky left-0 z-10 bg-background p-3 border-r-2">Otros Indirectos Unitario (m3)</td>
                    {renderPlantColumns(p => p.otros_indirectos_unitario, formatCurrency, 'otros_indirectos_unitario', false, true)}
                    {renderGrandTotalCell(
                      calculateGrandTotal(p => p.otros_indirectos_unitario, 'otros_indirectos_unitario'),
                      formatCurrency,
                      false,
                      true,
                      calculateGrandTotal(p => p.otros_indirectos_unitario, 'otros_indirectos_unitario', previousPlants),
                      'otros_indirectos_unitario'
                    )}
                  </tr>
                  <tr className="border-b hover:bg-muted/30">
                    <td className="sticky left-0 z-10 bg-background p-3 border-r-2">Otros Indirectos %</td>
                    {renderPlantColumns(p => p.otros_indirectos_pct, formatPercent, 'otros_indirectos_pct', false, true)}
                    {renderGrandTotalCell(
                      calculateGrandTotal(p => p.otros_indirectos_pct, 'otros_indirectos_pct'),
                      formatPercent,
                      false,
                      true,
                      calculateGrandTotal(p => p.otros_indirectos_pct, 'otros_indirectos_pct', previousPlants),
                      'otros_indirectos_pct'
                    )}
                  </tr>
                  <tr className="border-b-2 hover:bg-muted/30 bg-purple-100/70 dark:bg-purple-900/30">
                    <td className="sticky left-0 z-10 bg-purple-100 dark:bg-purple-900/40 p-3 border-r-2 font-bold text-base">TOTAL COSTO OP</td>
                    {renderPlantColumns(p => p.total_costo_op, formatCurrency, 'total_costo_op', true, true)}
                    {renderGrandTotalCell(
                      calculateGrandTotal(p => p.total_costo_op),
                      formatCurrency,
                      true,
                      true,
                      calculateGrandTotal(p => p.total_costo_op, 'total_costo_op', previousPlants),
                      'total_costo_op'
                    )}
                  </tr>
                  <tr className="border-b-2 hover:bg-muted/30">
                    <td className="sticky left-0 z-10 bg-background p-3 border-r-2 font-bold">TOTAL COSTO OP %</td>
                    {renderPlantColumns(p => p.total_costo_op_pct, formatPercent, 'total_costo_op_pct')}
                    {renderGrandTotalCell(calculateGrandTotal(p => p.total_costo_op_pct, 'total_costo_op_pct'), formatPercent)}
                  </tr>

                  {/* EBITDA SECTION */}
                  <tr className="bg-emerald-50 dark:bg-emerald-950/20">
                    <td colSpan={plantColumnCount + 1} className="p-2 font-semibold text-sm uppercase tracking-wide">
                      EBITDA
                    </td>
                  </tr>
                  <tr className="border-b-2 hover:bg-muted/30 bg-emerald-100/70 dark:bg-emerald-900/30">
                    <td className="sticky left-0 z-10 bg-emerald-100 dark:bg-emerald-900/40 p-3 border-r-2 font-bold text-base">EBITDA</td>
                    {renderPlantColumns(p => p.ebitda, formatCurrency, 'ebitda', true, true)}
                    {renderGrandTotalCell(
                      calculateGrandTotal(p => p.ebitda),
                      formatCurrency,
                      true,
                      true,
                      calculateGrandTotal(p => p.ebitda, 'ebitda', previousPlants),
                      'ebitda'
                    )}
                  </tr>
                  <tr className="border-b-2 hover:bg-muted/30">
                    <td className="sticky left-0 z-10 bg-background p-3 border-r-2 font-bold">EBITDA %</td>
                    {renderPlantColumns(p => p.ebitda_pct, formatPercent, 'ebitda_pct')}
                    {renderGrandTotalCell(calculateGrandTotal(p => p.ebitda_pct, 'ebitda_pct'), formatPercent)}
                  </tr>

                </tbody>
              </table>

              {/* BOMBEO TABLE - Separate table below main table */}
              {plants.some(p => p.ingresos_bombeo_vol && p.ingresos_bombeo_vol > 0) && (
                <>
                  {/* Visual separator */}
                  <div className="border-t-2 border-dashed border-muted-foreground/30 my-4"></div>
                  
                  <table className="w-full border-collapse text-sm">
                    <thead>
                      <tr>
                        <th className="sticky left-0 z-20 bg-background p-3 border-r-2 border-b-2 text-left font-semibold min-w-[200px]">
                          Concepto
                        </th>
                        {groupByBusinessUnit && groupedPlants ? (
                          // Business Unit columns
                          Object.entries(groupedPlants).map(([buId, buPlants]) => (
                            <th
                              key={buId}
                              className="p-3 border-r border-b-2 text-right font-semibold bg-muted/50 min-w-[120px]"
                            >
                              {businessUnitNames.get(buId) || 'Sin Unidad'}
                            </th>
                          ))
                        ) : (
                          // Plant columns
                          plants.map(plant => (
                            <th
                              key={plant.plant_id}
                              className="p-3 border-r border-b-2 text-right font-semibold bg-muted/50 min-w-[120px]"
                            >
                              {plant.plant_name}
                            </th>
                          ))
                        )}
                        <th className="p-3 border-b-2 text-right font-semibold bg-muted/50 min-w-[120px]">
                          Total
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {/* Ingresos Bombeo Section */}
                      <tr className="bg-slate-50 dark:bg-slate-950/20">
                        <td colSpan={plantColumnCount + 1} className="p-2 font-semibold text-sm uppercase tracking-wide">
                          Ingresos Bombeo
                        </td>
                      </tr>
                      <tr className="border-b hover:bg-muted/30">
                        <td className="sticky left-0 z-10 bg-background p-3 border-r-2">Ingresos Bombeo Vol</td>
                        {renderPlantColumns(p => p.ingresos_bombeo_vol || 0, (val) => formatNumber(val, 2), 'ingresos_bombeo_vol', false, true)}
                        {renderGrandTotalCell(
                          calculateGrandTotal(p => p.ingresos_bombeo_vol || 0),
                          (val) => formatNumber(val, 2),
                          false,
                          true,
                          calculateGrandTotal(p => p.ingresos_bombeo_vol || 0, 'ingresos_bombeo_vol', previousPlants),
                          'ingresos_bombeo_vol'
                        )}
                      </tr>
                      <tr className="border-b hover:bg-muted/30">
                        <td className="sticky left-0 z-10 bg-background p-3 border-r-2">Ingresos Bombeo $ Unit</td>
                        {renderPlantColumns(p => p.ingresos_bombeo_unit || 0, formatCurrency, 'ingresos_bombeo_unit', false, true)}
                        {renderGrandTotalCell(
                          calculateGrandTotal(p => p.ingresos_bombeo_unit || 0),
                          formatCurrency,
                          false,
                          true,
                          calculateGrandTotal(p => p.ingresos_bombeo_unit || 0, 'ingresos_bombeo_unit', previousPlants),
                          'ingresos_bombeo_unit'
                        )}
                      </tr>
                      <tr className="border-b hover:bg-muted/30">
                        <td className="sticky left-0 z-10 bg-background p-3 border-r-2 font-semibold">Ingreso Bombeo Total</td>
                        {renderPlantColumns(p => p.ingresos_bombeo_total || 0, formatCurrency, 'ingresos_bombeo_total', false, true)}
                        {renderGrandTotalCell(
                          calculateGrandTotal(p => p.ingresos_bombeo_total || 0),
                          formatCurrency,
                          false,
                          true,
                          calculateGrandTotal(p => p.ingresos_bombeo_total || 0, 'ingresos_bombeo_total', previousPlants),
                          'ingresos_bombeo_total'
                        )}
                      </tr>

                      {/* EBITDA con bombeo Section */}
                      <tr className="bg-emerald-50 dark:bg-emerald-950/20">
                        <td colSpan={plantColumnCount + 1} className="p-2 font-semibold text-sm uppercase tracking-wide">
                          EBITDA con bombeo
                        </td>
                      </tr>
                      <tr className="border-b-2 hover:bg-muted/30 bg-emerald-100/70 dark:bg-emerald-900/30">
                        <td className="sticky left-0 z-10 bg-emerald-100 dark:bg-emerald-900/40 p-3 border-r-2 font-bold text-base">EBITDA con bombeo</td>
                        {renderPlantColumns(p => p.ebitda_con_bombeo || 0, formatCurrency, 'ebitda_con_bombeo', true, true)}
                        {renderGrandTotalCell(
                          calculateGrandTotal(p => p.ebitda_con_bombeo || 0),
                          formatCurrency,
                          true,
                          true,
                          calculateGrandTotal(p => p.ebitda_con_bombeo || 0, 'ebitda_con_bombeo', previousPlants),
                          'ebitda_con_bombeo'
                        )}
                      </tr>
                      <tr className="border-b-2 hover:bg-muted/30">
                        <td className="sticky left-0 z-10 bg-background p-3 border-r-2 font-bold">EBITDA con bombeo %</td>
                        {renderPlantColumns(p => p.ebitda_con_bombeo_pct || 0, formatPercent, 'ebitda_con_bombeo_pct', false, true)}
                        {renderGrandTotalCell(
                          calculateGrandTotal(p => p.ebitda_con_bombeo_pct || 0, 'ebitda_con_bombeo_pct'),
                          formatPercent,
                          false,
                          true,
                          calculateGrandTotal(p => p.ebitda_con_bombeo_pct || 0, 'ebitda_con_bombeo_pct', previousPlants),
                          'ebitda_con_bombeo_pct'
                        )}
                      </tr>
                    </tbody>
                  </table>
                </>
              )}
            </div>

            {previousPlants.length > 0 && (
              <div className="mt-4 flex flex-wrap items-center gap-3 text-xs text-muted-foreground bg-muted/30 rounded-lg px-3 py-2">
                <span className="font-medium text-foreground">Variación vs {comparisonLabel}</span>
                <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-[11px] text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-200">
                  <ArrowUpRight className="w-3 h-3" /> Favorable
                </span>
                <span className="inline-flex items-center gap-1 rounded-full bg-rose-50 px-2 py-0.5 text-[11px] text-rose-700 dark:bg-rose-950/40 dark:text-rose-200">
                  <ArrowDownRight className="w-3 h-3" /> Desfavorable
                </span>
                <span className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">
                  <Minus className="w-3 h-3" /> Sin cambio / N/A
                </span>
                <span className="text-[10px] text-muted-foreground/80 ml-2">
                  (Gastos: reducción favorable | Spread/Margen: aumento favorable)
                </span>
              </div>
            )}

            <div className="mt-6 p-4 bg-muted/30 rounded-lg text-xs text-muted-foreground space-y-2">
              <p><strong>Fuentes de datos:</strong></p>
              <ul className="list-disc list-inside space-y-1 ml-2">
                <li><strong>Ingresos y Materia Prima:</strong> Vista <code>vw_plant_financial_analysis_unified</code></li>
                <li><strong>Ingresos Bombeo:</strong> Vista <code>vw_pumping_analysis_unified</code> (materializada, se actualiza cada hora)</li>
                <li><strong>Diesel y Mantenimiento:</strong> Calculado automáticamente del sistema de mantenimiento</li>
                <li><strong>Nómina y Otros Indirectos:</strong> Ingreso manual por administradores</li>
              </ul>
              <p className="mt-4">
                <strong>Nota:</strong> Los datos mostrados corresponden exclusivamente al mes seleccionado. 
                Para gestionar costos manuales (nómina y otros indirectos), use el botón "Gestionar Costos Manuales" en la parte superior.
              </p>
              <p className="mt-2">
                <strong>Actualización de datos:</strong> Las vistas materializadas se actualizan automáticamente cada hora (a los :30 minutos). 
                El botón "Refrescar Datos" recalcula los datos históricos financieros, no las vistas materializadas.
              </p>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  )
}




