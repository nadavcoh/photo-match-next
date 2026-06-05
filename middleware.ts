import { NextRequest, NextResponse } from "next/server";

export const config = {
  matcher: [
    /*
     * Match all request paths EXCEPT for the ones starting with:
     * - _next/static (static files)
     * - _next/image (image optimization files)
     * - favicon.ico (favicon file)
     */
    "/((?!_next/static|_next/image|favicon.ico).*)",
  ],
};

export function middleware(request: NextRequest) {
  const basicAuthUser = process.env.BASIC_AUTH_USER;
  const basicAuthPassword = process.env.BASIC_AUTH_PASSWORD;

  // If Basic Auth credentials are not configured, deny ALL access.
  // This prevents accidental open access on misconfigured deployments.
  if (!basicAuthUser || !basicAuthPassword) {
    return new NextResponse(
      "Service Unavailable: Authentication is not configured. Set BASIC_AUTH_USER and BASIC_AUTH_PASSWORD environment variables.",
      {
        status: 503,
        headers: { "Content-Type": "text/plain" },
      }
    );
  }

  const authHeader = request.headers.get("authorization");

  if (authHeader) {
    const authValue = authHeader.split(" ")[1];
    if (authValue) {
      try {
        const decoded = atob(authValue);
        // Split only on first colon — passwords may contain colons
        const colonIdx = decoded.indexOf(":");
        if (colonIdx !== -1) {
          const user = decoded.slice(0, colonIdx);
          const password = decoded.slice(colonIdx + 1);
          if (user === basicAuthUser && password === basicAuthPassword) {
            return NextResponse.next();
          }
        }
      } catch {
        // Invalid base64, fall through to 401
      }
    }
  }

  return new NextResponse("Unauthorized", {
    status: 401,
    headers: {
      "WWW-Authenticate": 'Basic realm="AI Coding Agent", charset="UTF-8"',
    },
  });
}
