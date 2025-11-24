import { createServerClient } from "@supabase/ssr"
import { NextResponse, type NextRequest } from "next/server"

export async function middleware(request: NextRequest) {
  let supabaseResponse = NextResponse.next({
    request,
  })

  // Enforce host allowlist (set ALLOWED_HOSTS="domain.com,www.domain.com" in env)
  const forwardedHost = request.headers.get('x-forwarded-host') || ''
  const hostHeader = request.headers.get('host') || ''
  const requestHost = (forwardedHost || hostHeader).toLowerCase()

  const allowedHostsEnv = (process.env.ALLOWED_HOSTS || '').split(',')
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean)

  // Always allow local development
  const devHosts = new Set(["localhost:3000", "127.0.0.1:3000"]) as Set<string>
  const allowedHosts = new Set<string>([...allowedHostsEnv, ...Array.from(devHosts)])

  if (allowedHostsEnv.length > 0 && requestHost && !allowedHosts.has(requestHost)) {
    return new NextResponse('Forbidden host', { status: 403 })
  }

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll()
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value, options }) => request.cookies.set(name, value))
          supabaseResponse = NextResponse.next({
            request,
          })
          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, options)
          )
        },
      },
    }
  )

  let user = null
  let isOfflineMode = false
  
  try {
    // Enhanced mobile session handling with retry logic
    const firstAttempt = await supabase.auth.getUser()
    
    if (firstAttempt.data.user) {
      user = firstAttempt.data.user
      console.log('✅ Middleware: User authenticated via Supabase:', user?.email || user?.id || 'unknown')
    } else if (firstAttempt.error?.message?.includes('Auth session missing')) {
      console.log('🔄 Middleware: Mobile session recovery - attempting session refresh')
      
      // Try to refresh session for mobile devices
      const { data: { session }, error: sessionError } = await supabase.auth.getSession()
      if (session?.user && !sessionError) {
        console.log('✅ Middleware: Mobile session recovery successful')
        user = session.user
      } else {
        console.log('❌ Middleware: Mobile session recovery failed, checking offline mode')
        throw new Error('Session refresh failed')
      }
    } else {
      console.log('🔍 Middleware: Supabase auth failed:', firstAttempt.error?.message)
      throw firstAttempt.error || new Error('Authentication failed')
    }
  } catch (error: any) {
    console.log('🌐 Middleware: Auth failed, evaluating controlled offline access')

    // Define work routes that can operate in offline mode
    const offlineWorkRoutes = [
      '/checklists',
      '/ordenes',
      '/activos',
      '/dashboard',
      '/preventivo',
      '/reportes',
      '/incidentes',
      '/modelos',
      '/inventario',
      '/plantas',
      '/personal',
    ]

    const isWorkRoute = offlineWorkRoutes.some((route) =>
      request.nextUrl.pathname.startsWith(route)
    )

    if (isWorkRoute) {
      // Only allow offline access if we at least have Supabase cookies present.
      // This avoids letting completely unauthenticated users through, which
      // caused 401s in API route handlers on first load.
      const allCookies = request.cookies.getAll()
      const supabaseCookies = allCookies.filter(
        (cookie) => cookie.name.startsWith('sb-') && cookie.value && cookie.value.length > 10
      )

      if (supabaseCookies.length > 0) {
        console.log('🔑 Middleware: Session cookies present — enabling offline work mode')
        user = {
          id: 'offline-session',
          email: 'offline@session.local',
          aud: 'authenticated',
          role: 'authenticated',
        }
        isOfflineMode = true
        supabaseResponse.headers.set('X-Offline-Mode', 'true')
        supabaseResponse.headers.set('X-Auth-Required', 'true')
      } else {
        console.log('🛑 Middleware: No Supabase cookies — not enabling offline bypass')
      }
    } else {
      console.log('🔒 Middleware: Non-work route, requiring proper authentication')
    }
  }

  // Handle root path redirect
  if (request.nextUrl.pathname === "/") {
    const url = request.nextUrl.clone()
    url.pathname = user ? "/dashboard" : "/login"
    console.log(`🔄 Middleware: Root redirect to ${url.pathname} ${isOfflineMode ? '(offline)' : '(online)'}`)
    return NextResponse.redirect(url)
  }

  // Define public routes (pages that don't require authentication)
  const publicRoutes = [
    "/login",
    "/register",
    "/auth/callback",
    "/forgot-password",
    "/auth/reset-password",
    "/auth/confirm",
    "/compras/accion-po"
  ]
  const isPublicRoute = publicRoutes.some((route) => 
    request.nextUrl.pathname.startsWith(route)
  )

  // Skip authentication for API routes - they handle their own auth
  const isApiRoute = request.nextUrl.pathname.startsWith('/api/')

  // If user is not authenticated and trying to access protected route (excluding API routes)
  if (!user && !isPublicRoute && !isApiRoute) {
    const url = request.nextUrl.clone()
    url.pathname = "/login"
    url.searchParams.set("redirectedFrom", request.nextUrl.pathname)
    console.log(`🔒 Middleware: Redirecting unauthenticated user from ${request.nextUrl.pathname} to login`)
    return NextResponse.redirect(url)
  }

  // If user is authenticated and trying to access login/register pages
  if (user && 
      (request.nextUrl.pathname === "/login" || request.nextUrl.pathname === "/register")) {
    const url = request.nextUrl.clone()
    url.pathname = "/dashboard"
    console.log(`🏠 Middleware: Redirecting authenticated user from ${request.nextUrl.pathname} to dashboard ${isOfflineMode ? '(offline)' : '(online)'}`)
    return NextResponse.redirect(url)
  }

  // Log successful middleware pass-through
  if (user) {
    console.log(`✅ Middleware: Allowing authenticated access to ${request.nextUrl.pathname} ${isOfflineMode ? '(offline)' : '(online)'}`)
  } else if (isPublicRoute) {
    console.log(`🌐 Middleware: Allowing public access to ${request.nextUrl.pathname}`)
  } else if (isApiRoute) {
    console.log(`🔌 Middleware: Skipping auth for API route ${request.nextUrl.pathname}`)
  }

  // IMPORTANT: You must return the supabaseResponse object as it is.
  // Set X-Robots-Tag header to prevent indexing across the app
  supabaseResponse.headers.set('X-Robots-Tag', 'noindex, nofollow, noarchive')
  return supabaseResponse
}

export const config = {
  matcher: [
    /*
     * Match all request paths except for the ones starting with:
     * - _next/static (static files)
     * - _next/image (image optimization files)
     * - favicon.ico (favicon file)
     * - public files
     */
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
}
