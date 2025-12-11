"use client"

import { Suspense } from "react"
import { useRouter } from "next/navigation"
import { DashboardHeader } from "@/components/dashboard/dashboard-header"
import { DashboardShell } from "@/components/dashboard/dashboard-shell"
import { TransferEntryForm } from "@/components/diesel-inventory/transfer-entry-form"
import { Loader2 } from "lucide-react"

function TransferPageContent() {
  const router = useRouter()

  const handleSuccess = (transferOutId: string, transferInId: string) => {
    // Navigate to diesel dashboard
    router.push('/diesel')
  }

  const handleCancel = () => {
    router.push('/diesel')
  }

  return (
    <DashboardShell>
      <DashboardHeader
        heading="Transferir Diesel"
        text="Transfiere diesel entre plantas. Las transferencias no se cuentan como consumo en los reportes."
      />
      
      <div className="max-w-4xl mx-auto">
        <TransferEntryForm
          productType="diesel"
          onSuccess={handleSuccess}
          onCancel={handleCancel}
        />
      </div>
    </DashboardShell>
  )
}

export default function TransferPage() {
  return (
    <Suspense fallback={
      <DashboardShell>
        <div className="flex items-center justify-center min-h-[400px]">
          <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
        </div>
      </DashboardShell>
    }>
      <TransferPageContent />
    </Suspense>
  )
}
