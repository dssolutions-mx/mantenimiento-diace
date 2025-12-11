"use client"

import React from "react"
import Link from "next/link"
import { usePathname, useRouter } from "next/navigation"
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
  BreadcrumbEllipsis,
} from "@/components/ui/breadcrumb"
import { Button } from "@/components/ui/button"
import { 
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Home, ChevronLeft, ChevronDown } from "lucide-react"
import { useBreadcrumbStore } from "@/hooks/use-breadcrumbs"

interface BreadcrumbNavProps {
  className?: string
}

interface BreadcrumbItemData {
  label: string
  href: string
  icon?: React.ReactNode
}

export function BreadcrumbNav({ className }: BreadcrumbNavProps) {
  const pathname = usePathname()
  const router = useRouter()
  const customItems = useBreadcrumbStore((state) => state.items)

  // Skip breadcrumbs for auth pages
  const authChromeLessPaths = [
    "/login",
    "/register",
    "/forgot-password",
    "/auth/reset-password",
    "/auth/confirm",
    "/auth/callback",
  ]
  if (authChromeLessPaths.some((p) => pathname?.startsWith(p))) {
    return null
  }

  const pathSegments = pathname.split("/").filter(Boolean)
  
  // Build breadcrumb items based on current navigation structure
  const getBreadcrumbItems = (): BreadcrumbItemData[] => {
    if (customItems.length > 0) {
      return customItems
    }

    const items: BreadcrumbItemData[] = [
      {
        label: "Dashboard",
        href: "/dashboard",
        icon: <Home className="h-4 w-4" />
      }
    ]

    if (pathSegments.length === 0 || pathSegments[0] === "dashboard") {
      return items
    }

    const firstSegment = pathSegments[0]
    
    // Equipment section
    if (["modelos", "activos", "preventivo"].includes(firstSegment)) {
      items.push({
        label: "Equipos",
        href: "#"
      })
      
      if (firstSegment === "modelos") {
        items.push({
          label: "Modelos",
          href: "/modelos"
        })
      } else if (firstSegment === "activos") {
        items.push({
          label: "Activos",
          href: "/activos"
        })
      } else if (firstSegment === "preventivo") {
        items.push({
          label: "Mantenimiento Preventivo",
          href: "/preventivo"
        })
      }
    }
    // Operations section
    else if (["checklists", "ordenes", "calendario"].includes(firstSegment)) {
      items.push({
        label: "Operaciones",
        href: "#"
      })
      
      if (firstSegment === "checklists") {
        items.push({
          label: "Checklists",
          href: "/checklists"
        })
      } else if (firstSegment === "ordenes") {
        items.push({
          label: "Órdenes de Trabajo",
          href: "/ordenes"
        })
      } else if (firstSegment === "calendario") {
        items.push({
          label: "Calendario",
          href: "/calendario"
        })
      }
    }
    // Procurement section
    else if (["compras", "inventario", "diesel"].includes(firstSegment)) {
      items.push({
        label: "Compras",
        href: "#"
      })
      
      if (firstSegment === "compras") {
        items.push({
          label: "Órdenes de Compra",
          href: "/compras"
        })
      } else if (firstSegment === "inventario") {
        items.push({
          label: "Inventario",
          href: "/inventario"
        })
      } else if (firstSegment === "diesel") {
        items.push({
          label: "Gestión de Diesel",
          href: "/diesel"
        })
        
        // Handle diesel sub-pages
        if (pathSegments.length > 1) {
          const secondSegment = pathSegments[1]
          
          if (secondSegment === "consumo") {
            items.push({
              label: "Registrar Consumo",
              href: "/diesel/consumo"
            })
          } else if (secondSegment === "entrada") {
            items.push({
              label: "Registrar Entrada",
              href: "/diesel/entrada"
            })
          } else if (secondSegment === "ajuste") {
            items.push({
              label: "Ajuste de Inventario",
              href: "/diesel/ajuste"
            })
          } else if (secondSegment === "historial") {
            items.push({
              label: "Historial de Transacciones",
              href: "/diesel/historial"
            })
          } else if (secondSegment === "analytics") {
            items.push({
              label: "Analíticas",
              href: "/diesel/analytics"
            })
          } else if (secondSegment === "almacen" && pathSegments.length > 2) {
            items.push({
              label: "Detalle de Almacén",
              href: `/diesel/almacen/${pathSegments[2]}`
            })
            
            // Handle asset detail within warehouse
            if (pathSegments.length > 4 && pathSegments[3] === "equipo") {
              items.push({
                label: "Detalle de Equipo",
                href: `/diesel/almacen/${pathSegments[2]}/equipo/${pathSegments[4]}`
              })
            }
          }
        }
      } else if (firstSegment === "urea") {
        items.push({
          label: "Gestión de UREA",
          href: "/urea"
        })
        
        // Handle UREA sub-pages
        if (pathSegments.length > 1) {
          const secondSegment = pathSegments[1]
          
          if (secondSegment === "consumo") {
            items.push({
              label: "Registrar Consumo",
              href: "/urea/consumo"
            })
          } else if (secondSegment === "entrada") {
            items.push({
              label: "Registrar Entrada",
              href: "/urea/entrada"
            })
          } else if (secondSegment === "ajuste") {
            items.push({
              label: "Ajuste de Inventario",
              href: "/urea/ajuste"
            })
          } else if (secondSegment === "historial") {
            items.push({
              label: "Historial de Transacciones",
              href: "/urea/historial"
            })
          } else if (secondSegment === "analytics") {
            items.push({
              label: "Analíticas",
              href: "/urea/analytics"
            })
          } else if (secondSegment === "almacen" && pathSegments.length > 2) {
            items.push({
              label: "Detalle de Almacén",
              href: `/urea/almacen/${pathSegments[2]}`
            })
            
            // Handle asset detail within warehouse
            if (pathSegments.length > 4 && pathSegments[3] === "equipo") {
              items.push({
                label: "Detalle de Equipo",
                href: `/urea/almacen/${pathSegments[2]}/equipo/${pathSegments[4]}`
              })
            }
          }
        }
      }
    }
    // Records section
    else if (["servicios", "reportes"].includes(firstSegment)) {
      items.push({
        label: "Históricos",
        href: "#"
      })
      
      if (firstSegment === "servicios") {
        items.push({
          label: "Órdenes de Servicio",
          href: "/servicios"
        })
      } else if (firstSegment === "reportes") {
        items.push({
          label: "Reportes",
          href: "/reportes"
        })
      }
    }

    // Add additional path segments for sub-pages
    if (pathSegments.length > 1) {
      const remainingSegments = pathSegments.slice(1)
      
      remainingSegments.forEach((segment, index) => {
        const segmentPath = "/" + pathSegments.slice(0, index + 2).join("/")
        
        // Handle specific sub-page labels
        let label = segment
        if (segment === "crear") label = "Crear"
        else if (segment === "editar") label = "Editar"
        else if (segment === "historial") label = "Historial"
        else if (segment === "historial-checklists") label = "Historial de Checklists"
        else if (segment === "incidentes") label = "Incidentes"
        else if (segment === "mantenimiento") label = "Mantenimiento"
        else if (segment === "reporte-produccion") label = "Reporte de Producción"
        else if (segment === "completar") label = "Completar"
        else if (segment === "aprobar") label = "Aprobar"
        else if (segment === "rechazar") label = "Rechazar"
        else if (segment === "ejecutar") label = "Ejecutar"
        else if (segment === "programar") label = "Programar"
        else if (segment === "diarios") label = "Diarios"
        else if (segment === "semanales") label = "Semanales"
        else if (segment === "mensuales") label = "Mensuales"
        else if (segment === "completado") label = "Completado"
        else if (segment === "nuevo") label = "Nuevo"
        else if (segment === "copiar") label = "Copiar"
        else if (segment === "eliminar") label = "Eliminar"
        else if (segment === "generar-oc") label = "Generar OC"
        else if (segment === "generar-oc-ajuste") label = "Generar OC Ajuste"
        else if (segment === "pedido") label = "Pedido"
        else if (segment === "recibido") label = "Recibido"
        else if (segment === "gastos-adicionales") label = "Gastos Adicionales"
        
        items.push({
          label,
          href: segmentPath
        })
      })
    }

    return items
  }

  const breadcrumbItems = getBreadcrumbItems()
  const currentPage = breadcrumbItems[breadcrumbItems.length - 1]
  const parentPage = breadcrumbItems.length > 1 ? breadcrumbItems[breadcrumbItems.length - 2] : null

  const handleBack = () => {
    if (parentPage && parentPage.href !== "#") {
      router.push(parentPage.href)
    } else {
      router.back()
    }
  }

  // Mobile view: Back button + current page + optional dropdown
  const MobileNav = () => (
    <div className="flex items-center gap-3 md:hidden">
      <Button 
        variant="ghost" 
        size="sm" 
        onClick={handleBack}
        className="p-2 h-auto"
      >
        <ChevronLeft className="h-4 w-4" />
        <span className="sr-only">Volver</span>
      </Button>
      
      <div className="flex items-center gap-2 min-w-0 flex-1">
        <div className="flex items-center gap-2 text-sm font-medium text-foreground truncate">
          {currentPage.icon}
          <span className="truncate">{currentPage.label}</span>
        </div>
        
        {breadcrumbItems.length > 2 && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="sm" className="p-1 h-auto flex-shrink-0">
                <ChevronDown className="h-3 w-3" />
                <span className="sr-only">Ver ruta completa</span>
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-56">
              {breadcrumbItems.slice(0, -1).map((item, index) => (
                <DropdownMenuItem key={`mobile-dropdown-${index}-${item.href}`} asChild>
                  <Link href={item.href} className="flex items-center gap-2">
                    {item.icon}
                    <span>{item.label}</span>
                  </Link>
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>
    </div>
  )

  // Desktop view: Full breadcrumbs with ellipsis for very long paths
  const DesktopNav = () => {
    const showEllipsis = breadcrumbItems.length > 4
    const visibleItems = showEllipsis 
      ? [breadcrumbItems[0], ...breadcrumbItems.slice(-2)]
      : breadcrumbItems

    return (
      <Breadcrumb className="hidden md:block">
        <BreadcrumbList>
          {showEllipsis ? (
            <>
              {/* First item (Dashboard) */}
              <BreadcrumbItem>
                <BreadcrumbLink asChild>
                  <Link href={visibleItems[0].href} className="flex items-center gap-2">
                    {visibleItems[0].icon}
                    {visibleItems[0].label}
                  </Link>
                </BreadcrumbLink>
              </BreadcrumbItem>
              <BreadcrumbSeparator />
              
              {/* Ellipsis with dropdown for hidden items */}
              <BreadcrumbItem>
                <DropdownMenu>
                  <DropdownMenuTrigger className="flex h-9 w-9 items-center justify-center">
                    <BreadcrumbEllipsis />
                    <span className="sr-only">Toggle menu</span>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="start">
                    {breadcrumbItems.slice(1, -2).map((item, index) => (
                      <DropdownMenuItem key={`dropdown-${index}-${item.href}`} asChild>
                        <Link href={item.href} className="flex items-center gap-2">
                          {item.icon}
                          <span>{item.label}</span>
                        </Link>
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuContent>
                </DropdownMenu>
              </BreadcrumbItem>
              <BreadcrumbSeparator />
              
              {/* Last two items */}
              {visibleItems.slice(1).map((item, index) => (
                <React.Fragment key={`visible-${index}-${item.href}`}>
                  <BreadcrumbItem>
                    {index === visibleItems.slice(1).length - 1 ? (
                      <BreadcrumbPage className="flex items-center gap-2">
                        {item.icon}
                        {item.label}
                      </BreadcrumbPage>
                    ) : (
                      <BreadcrumbLink asChild>
                        <Link href={item.href} className="flex items-center gap-2">
                          {item.icon}
                          {item.label}
                        </Link>
                      </BreadcrumbLink>
                    )}
                  </BreadcrumbItem>
                  {index < visibleItems.slice(1).length - 1 && <BreadcrumbSeparator />}
                </React.Fragment>
              ))}
            </>
          ) : (
            breadcrumbItems.map((item, index) => (
              <React.Fragment key={`breadcrumb-${index}-${item.href}`}>
                <BreadcrumbItem>
                  {index === breadcrumbItems.length - 1 ? (
                    <BreadcrumbPage className="flex items-center gap-2">
                      {item.icon}
                      {item.label}
                    </BreadcrumbPage>
                  ) : (
                    <BreadcrumbLink asChild>
                      <Link href={item.href} className="flex items-center gap-2">
                        {item.icon}
                        {item.label}
                      </Link>
                    </BreadcrumbLink>
                  )}
                </BreadcrumbItem>
                {index < breadcrumbItems.length - 1 && <BreadcrumbSeparator />}
              </React.Fragment>
            ))
          )}
        </BreadcrumbList>
      </Breadcrumb>
    )
  }

  return (
    <div className={className}>
      <MobileNav />
      <DesktopNav />
    </div>
  )
} 