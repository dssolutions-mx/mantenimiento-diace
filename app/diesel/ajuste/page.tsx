"use client"

import { DieselAdjustmentForm } from "@/components/diesel-inventory/diesel-adjustment-form"
import { useRouter } from "next/navigation"

export default function DieselAdjustmentPage() {
  const router = useRouter()

  return (
    <div className="container max-w-4xl mx-auto py-6 px-4">
      <DieselAdjustmentForm
        productType="diesel"
        onSuccess={(transactionId) => {
          console.log('Adjustment created:', transactionId)
          router.push('/diesel')
        }}
        onCancel={() => router.back()}
      />
    </div>
  )
}

