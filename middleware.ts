import { NextRequest, NextResponse } from 'next/server'

export function middleware(request: NextRequest): NextResponse {
  const { pathname } = request.nextUrl

  // Skip Next.js internals and static assets — handled by the file system.
  if (
    pathname.startsWith('/_next/') ||
    pathname === '/favicon.ico' ||
    pathname.startsWith('/icons/')
  ) {
    return NextResponse.next()
  }

  // Trim to treat blank/whitespace-only values the same as unset.
  const configuredUser = (process.env.BASIC_AUTH_USER ?? '').trim()
  const configuredPass = (process.env.BASIC_AUTH_PASSWORD ?? '').trim()

  // Credentials not configured → return 401 so the browser shows its native
  // login prompt (a 503 body renders as a page, making the site appear "open").
  // No valid credentials exist in this state, so all attempts will fail.
  if (!configuredUser || !configuredPass) {
    return deny()
  }

  const authHeader = request.headers.get('authorization')
  if (!authHeader?.startsWith('Basic ')) return deny()

  // atob() is the correct API for Edge Runtime — Buffer is Node-only and
  // throws silently there, which lets every request through.
  let decoded: string
  try {
    decoded = atob(authHeader.slice(6))
  } catch {
    return deny()
  }

  const colonIdx = decoded.indexOf(':')
  if (colonIdx === -1) return deny()

  const inputUser = decoded.slice(0, colonIdx)
  const inputPass = decoded.slice(colonIdx + 1)

  if (!timingSafeEqual(inputUser, configuredUser) || !timingSafeEqual(inputPass, configuredPass)) {
    return deny()
  }

  return NextResponse.next()
}

function deny(): NextResponse {
  return new NextResponse('Unauthorized', {
    status: 401,
    headers: { 'WWW-Authenticate': 'Basic realm="Photo Match", charset="UTF-8"' },
  })
}

/** XOR constant-time comparison — avoids early-exit timing leaks. */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

export const config = {
  // Matches all paths. Static-asset exclusions are handled inside the function
  // so there is no risk of the regex failing to compile and silently allowing
  // all traffic through.
  matcher: '/:path*',
}
