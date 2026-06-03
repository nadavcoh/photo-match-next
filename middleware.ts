import { NextRequest, NextResponse } from 'next/server'

export function middleware(request: NextRequest): NextResponse {
  const { pathname } = request.nextUrl

  // Pass through Next.js internals and static assets
  if (
    pathname.startsWith('/_next/') ||
    pathname === '/favicon.ico' ||
    pathname.startsWith('/icons/')
  ) {
    return NextResponse.next()
  }

  const configuredUser = process.env.BASIC_AUTH_USER
  const configuredPass = process.env.BASIC_AUTH_PASSWORD

  // Fail CLOSED: if credentials are not configured, block all access.
  // Never fall through to an unprotected app.
  if (!configuredUser || !configuredPass) {
    return new NextResponse(
      'Service unavailable: BASIC_AUTH_USER and BASIC_AUTH_PASSWORD must be configured.',
      {
        status: 503,
        headers: { 'Content-Type': 'text/plain' },
      }
    )
  }

  const authHeader = request.headers.get('authorization')

  if (!authHeader?.startsWith('Basic ')) {
    return unauthorized()
  }

  // Use atob() — available in Edge Runtime. Buffer is Node-only and
  // throws silently in middleware, which would let requests through.
  let decoded: string
  try {
    decoded = atob(authHeader.slice(6))
  } catch {
    return unauthorized()
  }

  const colonIdx = decoded.indexOf(':')
  if (colonIdx === -1) return unauthorized()

  const inputUser = decoded.slice(0, colonIdx)
  const inputPass = decoded.slice(colonIdx + 1)

  // XOR constant-time comparison to resist timing attacks
  if (!timingSafeEqual(inputUser, configuredUser) || !timingSafeEqual(inputPass, configuredPass)) {
    return unauthorized()
  }

  return NextResponse.next()
}

function unauthorized(): NextResponse {
  return new NextResponse('Unauthorized', {
    status: 401,
    headers: { 'WWW-Authenticate': 'Basic realm="Photo Match", charset="UTF-8"' },
  })
}

/** XOR-based constant-time string equality — avoids early-exit timing leaks. */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  }
  return diff === 0
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon\\.ico).*)'],
}
