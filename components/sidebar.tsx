"use client"

import React from "react"
import { useState, useEffect } from "react"

import Link from "next/link"
import { usePathname } from "next/navigation"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { useAuthZustand } from "@/hooks/use-auth-zustand"
import {
  BarChart3,
  Boxes,
  Calendar,
  ClipboardCheck,
  Home,
  Package,
  Settings,
  ShoppingCart,
  PenToolIcon as Tool,
  Truck,
  CreditCard,
  CheckCircle,
  Menu,
  X,
  Wrench,
  Activity,
  DollarSign,
  FileText,
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  Building2,
  Users,
  UserCheck,
  Sparkles,
  Shield,
  Fuel,
  Droplet,
  IdCard,
  Target,
} from "lucide-react"
import { UserNav } from "@/components/user-nav"
import { ModeToggle } from "@/components/mode-toggle"
import { Sheet, SheetContent, SheetTrigger } from "@/components/ui/sheet"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { BreadcrumbNav } from "@/components/breadcrumb-nav"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"
import { Badge } from "@/components/ui/badge"

interface SidebarProps extends React.HTMLAttributes<HTMLDivElement> {
  onLinkClick?: () => void
}

// Enhanced Logo Component that acts as toggle button
function AppLogo({ 
  isCollapsed = false, 
  className, 
  onClick 
}: { 
  isCollapsed?: boolean; 
  className?: string;
  onClick?: () => void;
}) {
  const LogoContent = () => (
    <div className={cn(
      "flex items-center gap-3 font-semibold transition-all duration-200 hover:opacity-80 group cursor-pointer",
      className
    )}>
      <div className="flex items-center justify-center w-8 h-8 bg-primary rounded-lg text-primary-foreground group-hover:scale-105 transition-transform">
        <Building2 className="h-5 w-5" />
      </div>
      {!isCollapsed && (
        <div className="flex flex-col">
          <span className="text-sm font-bold tracking-tight">MantenPro</span>
          <span className="text-xs text-muted-foreground -mt-0.5">Sistema de Gestión</span>
        </div>
      )}
    </div>
  )

  if (onClick) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <button onClick={onClick} className="text-left">
            <LogoContent />
          </button>
        </TooltipTrigger>
        <TooltipContent side="right" sideOffset={10} className="z-sidebar-tooltip">
          <p>{isCollapsed ? "Expandir sidebar" : "Colapsar sidebar"}</p>
        </TooltipContent>
      </Tooltip>
    )
  }

  return (
    <Link href="/dashboard">
      <LogoContent />
    </Link>
  )
}

export function Sidebar({ className, onLinkClick }: SidebarProps) {
  const pathname = usePathname()
  const { profile, ui } = useAuthZustand()
  const [equipmentOpen, setEquipmentOpen] = useState(false)
  const [operationsOpen, setOperationsOpen] = useState(false)
  const [procurementOpen, setProcurementOpen] = useState(profile?.role === 'AREA_ADMINISTRATIVA')
  const [recordsOpen, setRecordsOpen] = useState(false)
  const [organizationOpen, setOrganizationOpen] = useState(false)
  const [hrOpen, setHrOpen] = useState(false)

  // Auto-open procurement section for AREA_ADMINISTRATIVA
  useEffect(() => {
    if (profile?.role === 'AREA_ADMINISTRATIVA') {
      setProcurementOpen(true)
    }
  }, [profile])

  const handleLinkClick = () => {
    if (onLinkClick) {
      onLinkClick()
    }
  }

  const isPathActive = (path: string) => {
    // Special handling for /suppliers to avoid matching /suppliers/analytics
    if (path === "/suppliers") {
      return pathname === path || (pathname.startsWith(path + "/") && !pathname.startsWith("/suppliers/analytics"))
    }
    return pathname === path || pathname.startsWith(path + "/")
  }

  // Check if user is an operator
  const isOperator = profile?.role && ['OPERADOR', 'DOSIFICADOR'].includes(profile.role)

  // Return loading state if no profile yet
  if (!profile) {
    return (
      <div className={cn("pb-12", className)}>
        <div className="space-y-4 py-4">
          <div className="px-4 py-2">
            <div className="space-y-1">
              <Button
                variant="ghost"
                className="w-full justify-start"
                disabled
              >
                <Home className="mr-2 h-4 w-4" />
                Cargando...
              </Button>
            </div>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className={cn("pb-12", className)}>
      <div className="space-y-4 py-4">
        {/* Dashboard */}
        <div className="px-4 py-2">
          <div className="space-y-1">
            <Button
              variant={pathname === "/dashboard" ? "secondary" : "ghost"}
              className="w-full justify-start"
              asChild
              onClick={handleLinkClick}
            >
              <Link href={isOperator ? "/dashboard/operator" : "/dashboard"}>
                <Home className="mr-2 h-4 w-4" />
                Dashboard
              </Link>
            </Button>
          </div>
        </div>

        {/* Personal Credential - Available to all users */}
        <div className="px-4 py-2">
          <div className="space-y-1">
            <Button
              variant={pathname === "/credencial" ? "secondary" : "ghost"}
              className="w-full justify-start"
              asChild
              onClick={handleLinkClick}
            >
              <Link href="/credencial">
                <IdCard className="mr-2 h-4 w-4" />
                Mi Credencial
              </Link>
            </Button>
          </div>
        </div>

        {/* Simplified Navigation for Operators */}
        {isOperator && (
          <>
            {/* Checklists Section - Only section for operators */}
            <div className="px-4">
              <Collapsible open={operationsOpen} onOpenChange={setOperationsOpen}>
                <CollapsibleTrigger asChild>
                  <Button
                    variant="ghost"
                    className="w-full justify-between p-2 h-auto font-medium"
                  >
                    <div className="flex items-center">
                      <ClipboardCheck className="mr-2 h-4 w-4" />
                      Mis Checklists
                    </div>
                    {operationsOpen ? (
                      <ChevronDown className="h-4 w-4" />
                    ) : (
                      <ChevronRight className="h-4 w-4" />
                    )}
                  </Button>
                </CollapsibleTrigger>
                <CollapsibleContent className="space-y-1 mt-2">
                  <Button
                    variant={isPathActive("/checklists") ? "secondary" : "ghost"}
                    className="w-full justify-start pl-8"
                    asChild
                    onClick={handleLinkClick}
                  >
                    <Link href="/checklists">
                      <ClipboardCheck className="mr-2 h-4 w-4" />
                      Todos mis Checklists
                    </Link>
                  </Button>
                  <Button
                    variant={isPathActive("/checklists/assets") ? "secondary" : "ghost"}
                    className="w-full justify-start pl-8"
                    asChild
                    onClick={handleLinkClick}
                  >
                    <Link href="/checklists/assets">
                      <Truck className="mr-2 h-4 w-4" />
                      Vista por Activos
                    </Link>
                  </Button>
                  <Button
                    variant={isPathActive("/checklists/problemas-pendientes") ? "secondary" : "ghost"}
                    className="w-full justify-start pl-8"
                    asChild
                    onClick={handleLinkClick}
                  >
                    <Link href="/checklists/problemas-pendientes">
                      <AlertTriangle className="mr-2 h-4 w-4" />
                      Problemas Pendientes
                    </Link>
                  </Button>
                </CollapsibleContent>
              </Collapsible>
            </div>
          </>
        )}

        {/* For AREA_ADMINISTRATIVA: Show Procurement first, then Organization, then others */}
        {profile.role === 'AREA_ADMINISTRATIVA' ? (
          <>
            {/* Procurement Section - Priority for AREA_ADMINISTRATIVA */}
            {(ui.shouldShowInNavigation('purchases') || ui.shouldShowInNavigation('inventory')) && (
              <div className="px-4">
                <Collapsible open={procurementOpen} onOpenChange={setProcurementOpen}>
                  <CollapsibleTrigger asChild>
                    <Button
                      variant="ghost"
                      className="w-full justify-between p-2 h-auto font-medium"
                    >
                      <div className="flex items-center">
                        <ShoppingCart className="mr-2 h-4 w-4" />
                        Compras
                      </div>
                      {procurementOpen ? (
                        <ChevronDown className="h-4 w-4" />
                      ) : (
                        <ChevronRight className="h-4 w-4" />
                      )}
                    </Button>
                  </CollapsibleTrigger>
                  <CollapsibleContent className="space-y-1 mt-2">
                    {ui.shouldShowInNavigation('purchases') && (
                      <Button
                        variant={isPathActive("/compras") ? "secondary" : "ghost"}
                        className="w-full justify-start pl-8"
                        asChild
                        onClick={handleLinkClick}
                      >
                        <Link href="/compras">
                          <CreditCard className="mr-2 h-4 w-4" />
                          Órdenes de Compra
                        </Link>
                      </Button>
                    )}
                    {ui.shouldShowInNavigation('inventory') && (
                      <Button
                        variant={isPathActive("/inventario") ? "secondary" : "ghost"}
                        className="w-full justify-start pl-8"
                        asChild
                        onClick={handleLinkClick}
                      >
                        <Link href="/inventario">
                          <Boxes className="mr-2 h-4 w-4" />
                          Inventario
                        </Link>
                      </Button>
                    )}
                    <Button
                      variant={isPathActive("/diesel") ? "secondary" : "ghost"}
                      className="w-full justify-start pl-8"
                      asChild
                      onClick={handleLinkClick}
                    >
                      <Link href="/diesel">
                        <Fuel className="mr-2 h-4 w-4" />
                        Gestión de Diesel
                      </Link>
                    </Button>
                    <Button
                      variant={isPathActive("/urea") ? "secondary" : "ghost"}
                      className="w-full justify-start pl-8"
                      asChild
                      onClick={handleLinkClick}
                    >
                      <Link href="/urea">
                        <Droplet className="mr-2 h-4 w-4" />
                        Gestión de UREA
                      </Link>
                    </Button>
                    <Button
                      variant={isPathActive("/suppliers") ? "secondary" : "ghost"}
                      className="w-full justify-start pl-8"
                      asChild
                      onClick={handleLinkClick}
                    >
                      <Link href="/suppliers">
                        <Users className="mr-2 h-4 w-4" />
                        Padrón de Proveedores
                      </Link>
                    </Button>
                    <Button
                      variant={isPathActive("/suppliers/analytics") ? "secondary" : "ghost"}
                      className="w-full justify-start pl-8"
                      asChild
                      onClick={handleLinkClick}
                    >
                      <Link href="/suppliers/analytics">
                        <BarChart3 className="mr-2 h-4 w-4" />
                        Análisis de Proveedores
                      </Link>
                    </Button>
                  </CollapsibleContent>
                </Collapsible>
              </div>
            )}

            {/* Organization Section */}
            {ui.shouldShowInNavigation('personnel') && (
              <div className="px-4">
                <Collapsible open={organizationOpen} onOpenChange={setOrganizationOpen}>
                  <CollapsibleTrigger asChild>
                    <Button
                      variant="ghost"
                      className="w-full justify-between p-2 h-auto font-medium"
                    >
                      <div className="flex items-center">
                        <Building2 className="mr-2 h-4 w-4" />
                        Organización
                      </div>
                      {organizationOpen ? (
                        <ChevronDown className="h-4 w-4" />
                      ) : (
                        <ChevronRight className="h-4 w-4" />
                      )}
                    </Button>
                  </CollapsibleTrigger>
                  <CollapsibleContent className="space-y-1 mt-2">
                    <Button
                      variant={isPathActive("/gestion/asignaciones") ? "secondary" : "ghost"}
                      className="w-full justify-start pl-8 font-semibold"
                      asChild
                      onClick={handleLinkClick}
                    >
                      <Link href="/gestion/asignaciones">
                        <Target className="mr-2 h-4 w-4" />
                        Asignaciones Organizacionales
                        <Badge variant="secondary" className="ml-auto text-xs">Nuevo</Badge>
                      </Link>
                    </Button>
                    <div className="pl-8 pt-1 pb-2">
                      <p className="text-xs text-gray-500 mb-2">Páginas individuales:</p>
                    </div>
                    <Button
                      variant={isPathActive("/personal") ? "secondary" : "ghost"}
                      className="w-full justify-start pl-8"
                      asChild
                      onClick={handleLinkClick}
                    >
                      <Link href="/personal">
                        <Users className="mr-2 h-4 w-4" />
                        Gestión de Personal
                      </Link>
                    </Button>
                    {(ui.canShowEditButton('assets') || profile.role === 'AREA_ADMINISTRATIVA') && (
                      <>
                        <Button
                          variant={isPathActive("/gestion/activos/asignacion-plantas") ? "secondary" : "ghost"}
                          className="w-full justify-start pl-8"
                          asChild
                          onClick={handleLinkClick}
                        >
                          <Link href="/gestion/activos/asignacion-plantas">
                            <Package className="mr-2 h-4 w-4" />
                            Activos a Plantas
                          </Link>
                        </Button>
                        <Button
                          variant={isPathActive("/activos/asignacion") ? "secondary" : "ghost"}
                          className="w-full justify-start pl-8"
                          asChild
                          onClick={handleLinkClick}
                        >
                          <Link href="/activos/asignacion">
                            <UserCheck className="mr-2 h-4 w-4" />
                            Asignación de Activos
                          </Link>
                        </Button>
                      </>
                    )}
                    {['GERENCIA_GENERAL', 'AREA_ADMINISTRATIVA'].includes(profile.role) && (
                      <Button
                        variant={isPathActive("/plantas") ? "secondary" : "ghost"}
                        className="w-full justify-start pl-8"
                        asChild
                        onClick={handleLinkClick}
                      >
                        <Link href="/plantas">
                          <Building2 className="mr-2 h-4 w-4" />
                          Configuración de Plantas
                        </Link>
                      </Button>
                    )}
                  </CollapsibleContent>
                </Collapsible>
              </div>
            )}

            {/* Equipment Section - Lower priority for AREA_ADMINISTRATIVA */}
            {(ui.shouldShowInNavigation('assets') || ui.shouldShowInNavigation('maintenance')) && (
              <div className="px-4">
                <Collapsible open={equipmentOpen} onOpenChange={setEquipmentOpen}>
                  <CollapsibleTrigger asChild>
                    <Button
                      variant="ghost"
                      className="w-full justify-between p-2 h-auto font-medium"
                    >
                      <div className="flex items-center">
                        <Wrench className="mr-2 h-4 w-4" />
                        Equipos
                      </div>
                      {equipmentOpen ? (
                        <ChevronDown className="h-4 w-4" />
                      ) : (
                        <ChevronRight className="h-4 w-4" />
                      )}
                    </Button>
                  </CollapsibleTrigger>
                  <CollapsibleContent className="space-y-1 mt-2">
                    {ui.canShowCreateButton('maintenance') && (
                      <Button
                        variant={isPathActive("/modelos") ? "secondary" : "ghost"}
                        className="w-full justify-start pl-8"
                        asChild
                        onClick={handleLinkClick}
                      >
                        <Link href="/modelos">
                          <Settings className="mr-2 h-4 w-4" />
                          Modelos
                        </Link>
                      </Button>
                    )}
                    {ui.shouldShowInNavigation('assets') && (
                      <Button
                        variant={isPathActive("/activos") ? "secondary" : "ghost"}
                        className="w-full justify-start pl-8"
                        asChild
                        onClick={handleLinkClick}
                      >
                        <Link href="/activos">
                          <Package className="mr-2 h-4 w-4" />
                          Activos
                        </Link>
                      </Button>
                    )}
                  </CollapsibleContent>
                </Collapsible>
              </div>
            )}
          </>
        ) : (
          <>
            {/* Standard order for other roles */}
            {/* Equipment Section */}
            {(ui.shouldShowInNavigation('assets') || ui.shouldShowInNavigation('maintenance')) && (
              <div className="px-4">
                <Collapsible open={equipmentOpen} onOpenChange={setEquipmentOpen}>
                  <CollapsibleTrigger asChild>
                    <Button
                      variant="ghost"
                      className="w-full justify-between p-2 h-auto font-medium"
                    >
                      <div className="flex items-center">
                        <Wrench className="mr-2 h-4 w-4" />
                        Equipos
                      </div>
                      {equipmentOpen ? (
                        <ChevronDown className="h-4 w-4" />
                      ) : (
                        <ChevronRight className="h-4 w-4" />
                      )}
                    </Button>
                  </CollapsibleTrigger>
                  <CollapsibleContent className="space-y-1 mt-2">
                    {ui.canShowCreateButton('maintenance') && (
                      <Button
                        variant={isPathActive("/modelos") ? "secondary" : "ghost"}
                        className="w-full justify-start pl-8"
                        asChild
                        onClick={handleLinkClick}
                      >
                        <Link href="/modelos">
                          <Settings className="mr-2 h-4 w-4" />
                          Modelos
                        </Link>
                      </Button>
                    )}
                    {ui.shouldShowInNavigation('assets') && (
                      <Button
                        variant={isPathActive("/activos") ? "secondary" : "ghost"}
                        className="w-full justify-start pl-8"
                        asChild
                        onClick={handleLinkClick}
                      >
                        <Link href="/activos">
                          <Package className="mr-2 h-4 w-4" />
                          Activos
                        </Link>
                      </Button>
                    )}
                  </CollapsibleContent>
                </Collapsible>
              </div>
            )}

            {/* Operations Section */}
            {(ui.shouldShowInNavigation('work_orders') || ui.shouldShowInNavigation('checklists') || ui.shouldShowInNavigation('maintenance')) && (
              <div className="px-4">
                <Collapsible open={operationsOpen} onOpenChange={setOperationsOpen}>
                  <CollapsibleTrigger asChild>
                    <Button
                      variant="ghost"
                      className="w-full justify-between p-2 h-auto font-medium"
                    >
                      <div className="flex items-center">
                        <ClipboardCheck className="mr-2 h-4 w-4" />
                        Operaciones
                      </div>
                      {operationsOpen ? (
                        <ChevronDown className="h-4 w-4" />
                      ) : (
                        <ChevronRight className="h-4 w-4" />
                      )}
                    </Button>
                  </CollapsibleTrigger>
                  <CollapsibleContent className="space-y-1 mt-2">
                    {ui.shouldShowInNavigation('checklists') && (
                      <Button
                        variant={isPathActive("/checklists") ? "secondary" : "ghost"}
                        className="w-full justify-start pl-8"
                        asChild
                        onClick={handleLinkClick}
                      >
                        <Link href="/checklists">
                          <ClipboardCheck className="mr-2 h-4 w-4" />
                          Checklists
                        </Link>
                      </Button>
                    )}
                    {ui.shouldShowInNavigation('maintenance') && (
                      <Button
                        variant={isPathActive("/incidentes") ? "secondary" : "ghost"}
                        className="w-full justify-start pl-8"
                        asChild
                        onClick={handleLinkClick}
                      >
                        <Link href="/incidentes">
                          <AlertTriangle className="mr-2 h-4 w-4" />
                          Incidentes
                        </Link>
                      </Button>
                    )}
                    {ui.shouldShowInNavigation('work_orders') && (
                      <Button
                        variant={isPathActive("/ordenes") ? "secondary" : "ghost"}
                        className="w-full justify-start pl-8"
                        asChild
                        onClick={handleLinkClick}
                      >
                        <Link href="/ordenes">
                          <Tool className="mr-2 h-4 w-4" />
                          Órdenes de Trabajo
                        </Link>
                      </Button>
                    )}
                    {ui.shouldShowInNavigation('maintenance') && (
                      <Button
                        variant={isPathActive("/calendario") ? "secondary" : "ghost"}
                        className="w-full justify-start pl-8"
                        asChild
                        onClick={handleLinkClick}
                      >
                        <Link href="/calendario">
                          <Calendar className="mr-2 h-4 w-4" />
                          Calendario
                        </Link>
                      </Button>
                    )}
                  </CollapsibleContent>
                </Collapsible>
              </div>
            )}

            {/* Procurement Section */}
            {(ui.shouldShowInNavigation('purchases') || ui.shouldShowInNavigation('inventory')) && (
              <div className="px-4">
                <Collapsible open={procurementOpen} onOpenChange={setProcurementOpen}>
                  <CollapsibleTrigger asChild>
                    <Button
                      variant="ghost"
                      className="w-full justify-between p-2 h-auto font-medium"
                    >
                      <div className="flex items-center">
                        <ShoppingCart className="mr-2 h-4 w-4" />
                        Compras
                      </div>
                      {procurementOpen ? (
                        <ChevronDown className="h-4 w-4" />
                      ) : (
                        <ChevronRight className="h-4 w-4" />
                      )}
                    </Button>
                  </CollapsibleTrigger>
                  <CollapsibleContent className="space-y-1 mt-2">
                    {ui.shouldShowInNavigation('purchases') && (
                      <Button
                        variant={isPathActive("/compras") ? "secondary" : "ghost"}
                        className="w-full justify-start pl-8"
                        asChild
                        onClick={handleLinkClick}
                      >
                        <Link href="/compras">
                          <CreditCard className="mr-2 h-4 w-4" />
                          Órdenes de Compra
                        </Link>
                      </Button>
                    )}
                    {ui.shouldShowInNavigation('inventory') && (
                      <Button
                        variant={isPathActive("/inventario") ? "secondary" : "ghost"}
                        className="w-full justify-start pl-8"
                        asChild
                        onClick={handleLinkClick}
                      >
                        <Link href="/inventario">
                          <Boxes className="mr-2 h-4 w-4" />
                          Inventario
                        </Link>
                      </Button>
                    )}
                    <Button
                      variant={isPathActive("/diesel") ? "secondary" : "ghost"}
                      className="w-full justify-start pl-8"
                      asChild
                      onClick={handleLinkClick}
                    >
                      <Link href="/diesel">
                        <Fuel className="mr-2 h-4 w-4" />
                        Gestión de Diesel
                      </Link>
                    </Button>
                    <Button
                      variant={isPathActive("/urea") ? "secondary" : "ghost"}
                      className="w-full justify-start pl-8"
                      asChild
                      onClick={handleLinkClick}
                    >
                      <Link href="/urea">
                        <Droplet className="mr-2 h-4 w-4" />
                        Gestión de UREA
                      </Link>
                    </Button>
                    <Button
                      variant={isPathActive("/suppliers") ? "secondary" : "ghost"}
                      className="w-full justify-start pl-8"
                      asChild
                      onClick={handleLinkClick}
                    >
                      <Link href="/suppliers">
                        <Users className="mr-2 h-4 w-4" />
                        Padrón de Proveedores
                      </Link>
                    </Button>
                    <Button
                      variant={isPathActive("/suppliers/analytics") ? "secondary" : "ghost"}
                      className="w-full justify-start pl-8"
                      asChild
                      onClick={handleLinkClick}
                    >
                      <Link href="/suppliers/analytics">
                        <BarChart3 className="mr-2 h-4 w-4" />
                        Análisis de Proveedores
                      </Link>
                    </Button>
                  </CollapsibleContent>
                </Collapsible>
              </div>
            )}
          </>
        )}



        {/* Records Section */}
        {ui.shouldShowInNavigation('reports') && (
          <div className="px-4">
            <Collapsible open={recordsOpen} onOpenChange={setRecordsOpen}>
              <CollapsibleTrigger asChild>
                <Button
                  variant="ghost"
                  className="w-full justify-between p-2 h-auto font-medium"
                >
                  <div className="flex items-center">
                    <FileText className="mr-2 h-4 w-4" />
                    Históricos
                  </div>
                  {recordsOpen ? (
                    <ChevronDown className="h-4 w-4" />
                  ) : (
                    <ChevronRight className="h-4 w-4" />
                  )}
                </Button>
              </CollapsibleTrigger>
              <CollapsibleContent className="space-y-1 mt-2">
                {ui.shouldShowInNavigation('work_orders') && (
                  <Button
                    variant={isPathActive("/servicios") ? "secondary" : "ghost"}
                    className="w-full justify-start pl-8"
                    asChild
                    onClick={handleLinkClick}
                  >
                    <Link href="/servicios">
                      <CheckCircle className="mr-2 h-4 w-4" />
                      Órdenes de Servicio
                    </Link>
                  </Button>
                )}
                <Button
                  variant={isPathActive("/reportes") ? "secondary" : "ghost"}
                  className="w-full justify-start pl-8"
                  asChild
                  onClick={handleLinkClick}
                >
                  <Link href="/reportes">
                    <BarChart3 className="mr-2 h-4 w-4" />
                    Reportes
                  </Link>
                </Button>
              </CollapsibleContent>
            </Collapsible>
          </div>
        )}

        {/* Organization Section */}
        {ui.shouldShowInNavigation('personnel') && (
          <div className="px-4">
            <Collapsible open={organizationOpen} onOpenChange={setOrganizationOpen}>
              <CollapsibleTrigger asChild>
                <Button
                  variant="ghost"
                  className="w-full justify-between p-2 h-auto font-medium"
                >
                  <div className="flex items-center">
                    <Building2 className="mr-2 h-4 w-4" />
                    Organización
                  </div>
                  {organizationOpen ? (
                    <ChevronDown className="h-4 w-4" />
                  ) : (
                    <ChevronRight className="h-4 w-4" />
                  )}
                </Button>
              </CollapsibleTrigger>
              <CollapsibleContent className="space-y-1 mt-2">
                <Button
                  variant={isPathActive("/gestion/asignaciones") ? "secondary" : "ghost"}
                  className="w-full justify-start pl-8 font-semibold"
                  asChild
                  onClick={handleLinkClick}
                >
                  <Link href="/gestion/asignaciones">
                    <Target className="mr-2 h-4 w-4" />
                    Asignaciones Organizacionales
                    <Badge variant="secondary" className="ml-auto text-xs">Nuevo</Badge>
                  </Link>
                </Button>
                <div className="pl-8 pt-1 pb-2">
                  <p className="text-xs text-gray-500 mb-2">Páginas individuales:</p>
                </div>
                <Button
                  variant={isPathActive("/personal") ? "secondary" : "ghost"}
                  className="w-full justify-start pl-8"
                  asChild
                  onClick={handleLinkClick}
                >
                  <Link href="/personal">
                    <Users className="mr-2 h-4 w-4" />
                    Gestión de Personal
                  </Link>
                </Button>
                {(ui.canShowEditButton('assets') || profile.role === 'AREA_ADMINISTRATIVA') && (
                  <>
                    <Button
                      variant={isPathActive("/gestion/activos/asignacion-plantas") ? "secondary" : "ghost"}
                      className="w-full justify-start pl-8"
                      asChild
                      onClick={handleLinkClick}
                    >
                      <Link href="/gestion/activos/asignacion-plantas">
                        <Package className="mr-2 h-4 w-4" />
                        Activos a Plantas
                      </Link>
                    </Button>
                    <Button
                      variant={isPathActive("/activos/asignacion") ? "secondary" : "ghost"}
                      className="w-full justify-start pl-8"
                      asChild
                      onClick={handleLinkClick}
                    >
                      <Link href="/activos/asignacion">
                        <UserCheck className="mr-2 h-4 w-4" />
                        Asignación de Activos
                      </Link>
                    </Button>
                  </>
                )}
                {['GERENCIA_GENERAL', 'AREA_ADMINISTRATIVA'].includes(profile.role) && (
                  <Button
                    variant={isPathActive("/plantas") ? "secondary" : "ghost"}
                    className="w-full justify-start pl-8"
                    asChild
                    onClick={handleLinkClick}
                  >
                    <Link href="/plantas">
                      <Building2 className="mr-2 h-4 w-4" />
                      Configuración de Plantas
                    </Link>
                  </Button>
                )}
                {['GERENCIA_GENERAL', 'JEFE_UNIDAD_NEGOCIO', 'AREA_ADMINISTRATIVA'].includes(profile.role) && (
                  <Button
                    variant={isPathActive("/gestion/autorizaciones") ? "secondary" : "ghost"}
                    className="w-full justify-start pl-8"
                    asChild
                    onClick={handleLinkClick}
                  >
                    <Link href="/gestion/autorizaciones">
                      <Shield className="mr-2 h-4 w-4" />
                      Gestión de Autorizaciones
                    </Link>
                  </Button>
                )}
                {['GERENCIA_GENERAL', 'AREA_ADMINISTRATIVA', 'JEFE_UNIDAD_NEGOCIO'].includes(profile.role) && (
                  <Button
                    variant={isPathActive("/gestion/credenciales") ? "secondary" : "ghost"}
                    className="w-full justify-start pl-8"
                    asChild
                    onClick={handleLinkClick}
                  >
                    <Link href="/gestion/credenciales">
                      <IdCard className="mr-2 h-4 w-4" />
                      Credenciales de Empleados
                    </Link>
                  </Button>
                )}
              </CollapsibleContent>
            </Collapsible>
          </div>
        )}

        {/* HR Section */}
        <div className="px-4">
          <Collapsible open={hrOpen} onOpenChange={setHrOpen}>
            <CollapsibleTrigger asChild>
              <Button
                variant="ghost"
                className="w-full justify-between p-2 h-auto font-medium"
              >
                <div className="flex items-center">
                  <Users className="mr-2 h-4 w-4" />
                  Recursos Humanos
                </div>
                {hrOpen ? (
                  <ChevronDown className="h-4 w-4" />
                ) : (
                  <ChevronRight className="h-4 w-4" />
                )}
              </Button>
            </CollapsibleTrigger>
            <CollapsibleContent className="space-y-1 mt-2">
              <Button
                variant={isPathActive("/rh/limpieza") ? "secondary" : "ghost"}
                className="w-full justify-start pl-8"
                asChild
                onClick={handleLinkClick}
              >
                <Link href="/rh/limpieza">
                  <Sparkles className="mr-2 h-4 w-4" />
                  Reportes de Limpieza
                </Link>
              </Button>
              <Button
                variant={isPathActive("/rh/cumplimiento-checklists") ? "secondary" : "ghost"}
                className="w-full justify-start pl-8"
                asChild
                onClick={handleLinkClick}
              >
                <Link href="/rh/cumplimiento-checklists">
                  <ClipboardCheck className="mr-2 h-4 w-4" />
                  Cumplimiento de Checklists
                </Link>
              </Button>
            </CollapsibleContent>
          </Collapsible>
        </div>
      </div>
    </div>
  )
}

// Enhanced Collapsed Sidebar with better tooltips
export function CollapsedSidebar({ className, onLinkClick }: SidebarProps) {
  const pathname = usePathname()
  const { profile } = useAuthZustand()
  const [openTooltips, setOpenTooltips] = useState<Record<string, boolean>>({})

  const handleLinkClick = () => {
    if (onLinkClick) {
      onLinkClick()
    }
  }

  const toggleTooltip = (sectionId: string) => {
    setOpenTooltips(prev => ({
      ...prev,
      [sectionId]: !prev[sectionId]
    }))
  }

  const isPathActive = (path: string) => {
    // Special handling for /suppliers to avoid matching /suppliers/analytics
    if (path === "/suppliers") {
      return pathname === path || (pathname.startsWith(path + "/") && !pathname.startsWith("/suppliers/analytics"))
    }
    return pathname === path || pathname.startsWith(path + "/")
  }

  const isSectionActive = (paths: string[]) => {
    return paths.some(path => isPathActive(path))
  }

  // Return loading state if no profile yet
  if (!profile) {
    return (
      <div className={cn("pb-12", className)}>
        <div className="flex justify-center items-center h-32">
          <div className="text-xs text-muted-foreground">Cargando...</div>
        </div>
      </div>
    )
  }

  const baseNavigationSections = [
    {
      id: "dashboard",
      icon: Home,
      label: "Dashboard",
      href: "/dashboard",
      active: pathname === "/dashboard"
    },
    {
      id: "credential",
      icon: IdCard,
      label: "Mi Credencial",
      href: "/credencial",
      active: pathname === "/credencial"
    },
    {
      id: "equipment",
      icon: Wrench,
      label: "Equipos",
      active: isSectionActive(["/modelos", "/activos"]),
      items: [
        { href: "/modelos", icon: Settings, label: "Modelos", active: isPathActive("/modelos") },
        { href: "/activos", icon: Package, label: "Activos", active: isPathActive("/activos") }
      ]
    },
    {
      id: "operations",
      icon: ClipboardCheck,
      label: "Operaciones",
      active: isSectionActive(["/checklists", "/incidentes", "/ordenes", "/calendario"]),
      items: [
        { href: "/checklists", icon: ClipboardCheck, label: "Checklists", active: isPathActive("/checklists") },
        { href: "/incidentes", icon: AlertTriangle, label: "Incidentes", active: isPathActive("/incidentes") },
        { href: "/ordenes", icon: Tool, label: "Órdenes de Trabajo", active: isPathActive("/ordenes") },
        { href: "/calendario", icon: Calendar, label: "Calendario", active: isPathActive("/calendario") }
      ]
    },
    {
      id: "procurement",
      icon: ShoppingCart,
      label: "Compras",
      active: isSectionActive(["/compras", "/inventario", "/diesel", "/urea", "/suppliers"]),
      items: [
        { href: "/compras", icon: CreditCard, label: "Órdenes de Compra", active: isPathActive("/compras") },
        { href: "/inventario", icon: Boxes, label: "Inventario", active: isPathActive("/inventario") },
        { href: "/diesel", icon: Fuel, label: "Gestión de Diesel", active: isPathActive("/diesel") },
        { href: "/urea", icon: Droplet, label: "Gestión de UREA", active: isPathActive("/urea") },
        { href: "/suppliers", icon: Users, label: "Padrón de Proveedores", active: isPathActive("/suppliers") },
        { href: "/suppliers/analytics", icon: BarChart3, label: "Análisis de Proveedores", active: isPathActive("/suppliers/analytics") }
      ]
    },
    {
      id: "records",
      icon: FileText,
      label: "Históricos",
      active: isSectionActive(["/servicios", "/reportes"]),
      items: [
        { href: "/servicios", icon: CheckCircle, label: "Órdenes de Servicio", active: isPathActive("/servicios") },
        { href: "/reportes", icon: BarChart3, label: "Reportes", active: isPathActive("/reportes") }
      ]
    },
    {
      id: "organization",
      icon: Building2,
      label: "Organización",
      active: isSectionActive(["/gestion/asignaciones", "/personal", "/activos/asignacion", "/gestion/activos/asignacion-plantas", "/plantas", "/gestion/autorizaciones", "/gestion/credenciales"]),
      items: [
        { href: "/gestion/asignaciones", icon: Target, label: "Asignaciones Organizacionales", active: isPathActive("/gestion/asignaciones"), badge: "Nuevo" },
        { href: "/personal", icon: Users, label: "Gestión de Personal", active: isPathActive("/personal") },
        { href: "/activos/asignacion", icon: UserCheck, label: "Asignación de Activos", active: isPathActive("/activos/asignacion") },
        { href: "/gestion/activos/asignacion-plantas", icon: Package, label: "Activos a Plantas", active: isPathActive("/gestion/activos/asignacion-plantas") },
        { href: "/plantas", icon: Building2, label: "Configuración de Plantas", active: isPathActive("/plantas") },
        { href: "/gestion/autorizaciones", icon: Shield, label: "Gestión de Autorizaciones", active: isPathActive("/gestion/autorizaciones") },
        { href: "/gestion/credenciales", icon: IdCard, label: "Credenciales de Empleados", active: isPathActive("/gestion/credenciales") }
      ]
    },
    {
      id: "hr",
      icon: Users,
      label: "Recursos Humanos",
      active: isSectionActive(["/rh/limpieza", "/rh/cumplimiento-checklists"]),
      items: [
        { href: "/rh/limpieza", icon: Sparkles, label: "Reportes de Limpieza", active: isPathActive("/rh/limpieza") },
        { href: "/rh/cumplimiento-checklists", icon: ClipboardCheck, label: "Cumplimiento de Checklists", active: isPathActive("/rh/cumplimiento-checklists") }
      ]
    }
  ]

  // Filter and reorder sections based on user role
  let navigationSections = baseNavigationSections
  
  // Check if user is an operator
  const isOperator = profile.role && ['OPERADOR', 'DOSIFICADOR'].includes(profile.role)
  
  if (isOperator) {
    // For operators, only show checklists section
    navigationSections = [
      {
        id: "checklists",
        icon: ClipboardCheck,
        label: "Mis Checklists",
        href: "/checklists",
        active: isPathActive("/checklists")
      }
    ]
  } else if (profile.role === 'AREA_ADMINISTRATIVA') {
    // Remove operations section and reorder to prioritize procurement
    navigationSections = baseNavigationSections
      .filter(section => section.id !== 'operations')
      .sort((a, b) => {
        // Dashboard always first
        if (a.id === 'dashboard') return -1
        if (b.id === 'dashboard') return 1
        // Procurement second for AREA_ADMINISTRATIVA
        if (a.id === 'procurement') return -1
        if (b.id === 'procurement') return 1
        // Organization third for AREA_ADMINISTRATIVA  
        if (a.id === 'organization') return -1
        if (b.id === 'organization') return 1
        // Everything else maintains order
        return 0
      })
  }

  return (
    <div className={cn("pb-12", className)}>
      <TooltipProvider>
        <div className="space-y-1 py-4">
          {navigationSections.map((section, index) => {
            const Icon = section.icon
            
            if (section.href) {
              return (
                <div key={section.id}>
                  <div className="px-2">
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          variant={section.active ? "secondary" : "ghost"}
                          size="icon"
                          className="w-10 h-10 mx-auto"
                          asChild
                          onClick={handleLinkClick}
                        >
                          <Link href={section.href}>
                            <Icon className="h-4 w-4" />
                            <span className="sr-only">{section.label}</span>
                          </Link>
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent side="right" sideOffset={10} className="z-sidebar-tooltip">
                        <p>{section.label}</p>
                      </TooltipContent>
                    </Tooltip>
                  </div>
                  <div className="mx-4 my-2 border-b border-border"></div>
                </div>
              )
            }

            return (
              <div key={section.id}>
                <div className="px-2">
                  <Tooltip 
                    open={openTooltips[section.id]} 
                    onOpenChange={(open) => setOpenTooltips(prev => ({ ...prev, [section.id]: open }))}
                    delayDuration={0}
                  >
                    <TooltipTrigger asChild>
                      <Button
                        variant={section.active ? "secondary" : "ghost"}
                        size="icon"
                        className="w-10 h-10 mx-auto group relative hover:scale-105 transition-all duration-200"
                        onClick={(e) => {
                          e.preventDefault()
                          toggleTooltip(section.id)
                        }}
                        onMouseEnter={() => {}} // Disable hover
                        onMouseLeave={() => {}} // Disable hover
                      >
                        <Icon className="h-4 w-4" />
                        <span className="sr-only">{section.label}</span>
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent 
                      side="right" 
                      className="p-0" 
                      sideOffset={10}
                      style={{ zIndex: 9999999 }}
                      onPointerDownOutside={() => setOpenTooltips(prev => ({ ...prev, [section.id]: false }))}
                      onEscapeKeyDown={() => setOpenTooltips(prev => ({ ...prev, [section.id]: false }))}
                    >
                      <div className="bg-background border rounded-md shadow-lg py-1 min-w-[220px] max-w-[280px]" style={{ position: 'relative', zIndex: 9999999 }}>
                        <div className="px-3 py-2 text-sm font-medium text-muted-foreground border-b bg-muted/50">
                          <div className="flex items-center gap-2">
                            <Icon className="h-4 w-4" />
                            {section.label}
                          </div>
                          <div className="text-xs mt-1 text-muted-foreground/70">
                            Click any item to navigate
                          </div>
                        </div>
                        {section.items?.map((item) => {
                          const ItemIcon = item.icon
                          return (
                            <Button
                              key={item.href}
                              variant={item.active ? "secondary" : "ghost"}
                              className="w-full justify-start px-3 py-2 h-auto rounded-none hover:bg-accent/50 transition-colors"
                              asChild
                              onClick={handleLinkClick}
                            >
                              <Link href={item.href}>
                                <ItemIcon className="mr-2 h-4 w-4" />
                                {item.label}
                                {item.active && (
                                  <div className="ml-auto w-1.5 h-1.5 bg-primary rounded-full" />
                                )}
                              </Link>
                            </Button>
                          )
                        })}
                      </div>
                    </TooltipContent>
                  </Tooltip>
                </div>
                {index < navigationSections.length - 1 && (
                  <div className="mx-4 my-2 border-b border-border"></div>
                )}
              </div>
            )
          })}
        </div>
      </TooltipProvider>
    </div>
  )
}

// Enhanced Sidebar Wrapper with improved layout
export function SidebarWrapper({ children }: { children: React.ReactNode }) {
  const pathname = usePathname()
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false)
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(true) // Start collapsed by default

  useEffect(() => {
    setIsMobileMenuOpen(false)
  }, [pathname])

  const authChromeLessPaths = [
    "/login",
    "/register",
    "/forgot-password",
    "/auth/reset-password",
    "/auth/confirm",
    "/auth/callback",
  ]
  
  // Exclude print pages from sidebar/header layout
  if (pathname?.includes("/imprimir")) {
    return <>{children}</>
  }
  
  if (authChromeLessPaths.some((p) => pathname?.startsWith(p))) {
    return <>{children}</>
  }

  return (
    <TooltipProvider>
      <div className="min-h-screen flex">
        {/* Desktop Sidebar */}
        <aside className={cn(
          "hidden md:flex md:flex-col border-r bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60 transition-all duration-300 ease-in-out relative z-sidebar-panel",
          isSidebarCollapsed ? "md:w-16" : "md:w-64"
        )}>
          <div className="flex h-full max-h-screen flex-col">
            {/* Enhanced Header with logo as toggle */}
            <div className="flex h-16 items-center border-b px-4 lg:px-6">
              <AppLogo 
                isCollapsed={isSidebarCollapsed} 
                onClick={() => setIsSidebarCollapsed(!isSidebarCollapsed)}
              />
            </div>
            
            {/* Navigation Content */}
            <div className="flex-1 overflow-auto">
              {isSidebarCollapsed ? (
                <CollapsedSidebar 
                  className="px-1" 
                  onLinkClick={() => setIsMobileMenuOpen(false)} 
                />
              ) : (
                <Sidebar 
                  className="px-2" 
                  onLinkClick={() => setIsMobileMenuOpen(false)} 
                />
              )}
            </div>
          </div>
        </aside>

        {/* Main Content */}
        <div className="flex flex-1 flex-col min-w-0">
          {/* Enhanced Header */}
          <header className="flex h-16 items-center gap-4 border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60 px-4 lg:px-6">
            {/* Mobile Menu & Logo */}
            <div className="flex items-center gap-4 md:hidden">
              <Sheet open={isMobileMenuOpen} onOpenChange={setIsMobileMenuOpen}>
                <SheetTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="shrink-0"
                  >
                    <Menu className="h-5 w-5" />
                    <span className="sr-only">Abrir menú</span>
                  </Button>
                </SheetTrigger>
                <SheetContent side="left" className="flex flex-col p-0 w-64">
                  <div className="flex h-16 items-center border-b px-4">
                    <AppLogo />
                  </div>
                  <div className="flex-1 overflow-auto">
                    <Sidebar 
                      className="px-2" 
                      onLinkClick={() => setIsMobileMenuOpen(false)} 
                    />
                  </div>
                </SheetContent>
              </Sheet>
              <AppLogo className="md:hidden" />
            </div>

            {/* Breadcrumb - takes remaining space */}
            <div className="flex-1 min-w-0">
              <BreadcrumbNav />
            </div>

            {/* Header Actions */}
            <div className="flex items-center gap-2">
              <ModeToggle />
              <UserNav />
            </div>
          </header>

          {/* Page Content */}
          <main className="flex-1 overflow-auto relative z-page-content">{children}</main>
        </div>
      </div>
    </TooltipProvider>
  )
}
