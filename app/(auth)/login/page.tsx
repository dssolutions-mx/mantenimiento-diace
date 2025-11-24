import type { Metadata } from "next"
import { Suspense } from "react"
import { AuthForm } from "@/components/auth/auth-form"

export const metadata: Metadata = {
  title: "Iniciar Sesión | Sistema de Gestión de Mantenimiento",
  description: "Inicie sesión en el sistema de gestión de mantenimiento",
  robots: {
    index: false,
    follow: false,
  },
}

export default function LoginPage() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 py-12 px-4 sm:px-6 lg:px-8">
      <div className="max-w-md w-full space-y-8">
        <div className="text-center">
          <h1 className="text-2xl font-semibold tracking-tight">Iniciar Sesión</h1>
          <p className="text-sm text-muted-foreground mt-2">Ingrese sus credenciales para acceder al sistema</p>
        </div>
        <Suspense fallback={<div className="text-center">Cargando...</div>}>
          <AuthForm mode="login" />
        </Suspense>
      </div>
    </div>
  )
}
