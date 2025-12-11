"use client"

import { Button } from "@/components/ui/button"
import { SupplierRegistry } from "@/components/suppliers/SupplierRegistry"
import { Users, Search, Plus } from "lucide-react"
import { useRouter } from "next/navigation"

export default function SuppliersPage() {
  const router = useRouter()

  return (
    <div className="container mx-auto py-6 px-4 max-w-7xl space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Padrón de Proveedores</h1>
          <p className="text-muted-foreground">
            Administra el padrón de proveedores y visualiza información detallada
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" onClick={() => router.push("/suppliers/analytics")}>
            <Search className="w-4 h-4 mr-2" />
            Ver Análisis
          </Button>
          <Button variant="outline">
            <Search className="w-4 h-4 mr-2" />
            Buscar Proveedor
          </Button>
          <Button>
            <Plus className="w-4 h-4 mr-2" />
            Agregar Proveedor
          </Button>
        </div>
      </div>

      {/* Main Content - Registry Only */}
      <SupplierRegistry
        onSupplierSelect={(supplier) => {
          // Supplier selection handled within SupplierRegistry component
        }}
      />
    </div>
  )
}
