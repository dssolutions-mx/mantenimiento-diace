"use client"

import { useState } from "react"
import { Button } from "@/components/ui/button"
import { AlertCircle } from "lucide-react"
import { ReportIssueDialog } from "@/components/suppliers/ReportIssueDialog"

interface ReportIssueButtonProps {
  purchaseOrderId: string
  purchaseOrderIdDisplay: string
  supplierId?: string | null
  supplierName?: string | null
}

export function ReportIssueButton({
  purchaseOrderId,
  purchaseOrderIdDisplay,
  supplierId,
  supplierName
}: ReportIssueButtonProps) {
  const [open, setOpen] = useState(false)

  if (!supplierId) {
    return null
  }

  return (
    <>
      <Button
        variant="outline"
        onClick={() => setOpen(true)}
        className="text-orange-600 border-orange-200 hover:bg-orange-50"
      >
        <AlertCircle className="w-4 h-4 mr-2" />
        Reportar Problema
      </Button>
      <ReportIssueDialog
        open={open}
        onOpenChange={setOpen}
        purchaseOrderId={purchaseOrderId}
        supplierId={supplierId}
        purchaseOrderIdDisplay={purchaseOrderIdDisplay}
      />
    </>
  )
}
