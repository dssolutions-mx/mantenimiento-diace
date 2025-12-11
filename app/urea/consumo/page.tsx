"use client"

import { Suspense } from "react"
import { useRouter } from "next/navigation"
import { DashboardHeader } from "@/components/dashboard/dashboard-header"
import { DashboardShell } from "@/components/dashboard/dashboard-shell"
import { ConsumptionEntryForm } from "@/components/diesel-inventory/consumption-entry-form"
import { Loader2 } from "lucide-react"

function ConsumptionPageContent() {
  const router = useRouter()

  const handleSuccess = (transactionId: string) => {
    // Navigate to urea dashboard
    router.push('/urea')
  }

  const handleCancel = () => {
    router.push('/urea')
  }

  // TODO: Get warehouse_id and plant_id from user context
  // For now, we'll need to fetch these from the user's profile
  const defaultWarehouseId = "warehouse-uuid-here" // Replace with actual logic
  const defaultPlantId = "plant-uuid-here" // Replace with actual logic

  return (
    <DashboardShell>
      <DashboardHeader
        heading="Registrar Consumo de UREA"
        text="Captura el consumo de UREA con evidencia fotográfica y validación automática"
      />
      
      <div className="max-w-2xl mx-auto">
        <ConsumptionEntryForm
          productType="urea"
          warehouseId={defaultWarehouseId}
          plantId={defaultPlantId}
          onSuccess={handleSuccess}
          onCancel={handleCancel}
        />
      </div>
    </DashboardShell>
  )
}

export default function ConsumptionPage() {
  return (
    <Suspense fallback={
      <DashboardShell>
        <DashboardHeader
          heading="Registrar Consumo de UREA"
          text="Cargando formulario..."
        />
        <div className="flex items-center justify-center h-64">
          <Loader2 className="h-8 w-8 animate-spin text-purple-600" />
        </div>
      </DashboardShell>
    }>
      <ConsumptionPageContent />
    </Suspense>
  )
}

