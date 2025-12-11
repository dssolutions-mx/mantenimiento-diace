"use client"

import { DieselEntryForm } from "@/components/diesel-inventory/diesel-entry-form"
import { useRouter } from "next/navigation"

export default function UreaEntryPage() {
  const router = useRouter()

  return (
    <div className="container max-w-4xl mx-auto py-6 px-4">
      <DieselEntryForm
        productType="urea"
        onSuccess={(transactionId) => {
          console.log('Entry created:', transactionId)
          router.push('/urea')
        }}
        onCancel={() => router.back()}
      />
    </div>
  )
}

