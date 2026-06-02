import { NextRequest, NextResponse } from 'next/server'

export function middleware(request: NextRequest): NextResponse {
  const { pathname } = request.nextUrl

  // Pass through Next.js internals and static assets
  if (
    pathname.startsWith('/_next/') ||
    pathname.startsWith('/favicon.ico') ||
    pathname.startsWith('/icons/')
  ) {
    return NextResponse.next()
  }

  const configuredUser = process.env.BASIC_AUTH_USER
  const configuredPass = process.env.BASIC_AUTH_PASSWORD

  // If credentials are not configured, block all access rather than allowing
  // unrestricted entry — fail closed, never open.
  if (!configuredUser || !configuredPass) {
    return new NextResponse(
      'Service Unavailable: BASIC_AUTH_USER and BASIC_AUTH_PASSWORD must be set.',
      { status: 503, headers: { 'Content-Type': 'text/plain' } }
    )
  }

  const authHeader = request.headers.get('authorization')

  if (!authHeader?.startsWith('Basic ')) {
    return new NextResponse('Unauthorized', {
      status: 401,
      headers: { 'WWW-Authenticate': 'Basic realm="Photo Match", charset="UTF-8"' },
    })
  }

  let decoded: string
  try {
    decoded = Buffer.from(authHeader.slice(6), 'base64').toString('utf-8')
  } catch {
    return new NextResponse('Unauthorized', {
      status: 401,
      headers: { 'WWW-Authenticate': 'Basic realm="Photo Match", charset="UTF-8"' },
    })
  }

  const colonIdx = decoded.indexOf(':')
  if (colonIdx === -1) {
    return new NextResponse('Unauthorized', {
      status: 401,
      headers: { 'WWW-Authenticate': 'Basic realm="Photo Match", charset="UTF-8"' },
    })
  }

  const inputUser = decoded.slice(0, colonIdx)
  const inputPass = decoded.slice(colonIdx + 1)

  // Constant-time comparison to resist timing attacks
  const userMatch = timingSafeEqual(inputUser, configuredUser)
  const passMatch = timingSafeEqual(inputPass, configuredPass)

  if (!userMatch || !passMatch) {
    return new NextResponse('Unauthorized', {
      status: 401,
      headers: { 'WWW-Authenticate': 'Basic realm="Photo Match", charset="UTF-8"' },
    })
  }

  return NextResponse.next()
}

/** XOR-based constant-time string equality (avoids early-exit timing leaks). */
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
