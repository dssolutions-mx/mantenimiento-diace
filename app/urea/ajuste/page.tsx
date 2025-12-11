"use client"

import { DieselAdjustmentForm } from "@/components/diesel-inventory/diesel-adjustment-form"
import { useRouter } from "next/navigation"

export default function UreaAdjustmentPage() {
  const router = useRouter()

  return (
    <div className="container max-w-4xl mx-auto py-6 px-4">
      <DieselAdjustmentForm
        productType="urea"
        onSuccess={(transactionId) => {
          console.log('Adjustment created:', transactionId)
          router.push('/urea')
        }}
        onCancel={() => router.back()}
      />
    </div>
  )
}

