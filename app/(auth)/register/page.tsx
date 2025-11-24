import type { Metadata } from "next"
import { AuthForm } from "@/components/auth/auth-form"

export const metadata: Metadata = {
  title: "Registro | Sistema de Gestión de Mantenimiento",
  description: "Cree una cuenta en el sistema de gestión de mantenimiento",
}

export default function RegisterPage() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 py-12 px-4 sm:px-6 lg:px-8">
      <div className="max-w-md w-full">
        <AuthForm mode="register" />
      </div>
    </div>
  )
}
