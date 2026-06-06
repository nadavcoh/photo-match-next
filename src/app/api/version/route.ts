import { NextResponse } from 'next/server'
import { execSync } from 'child_process'

function getVersion(): string {
  // Vercel sets this automatically for every deployment
  const sha = process.env.VERCEL_GIT_COMMIT_SHA
  if (sha) return sha.slice(0, 7)

  // Local / self-hosted: try git
  try {
    const hash = execSync('git rev-parse --short HEAD', { stdio: ['pipe', 'pipe', 'pipe'] })
      .toString()
      .trim()
    const date = execSync('git log -1 --format=%cd --date=short', { stdio: ['pipe', 'pipe', 'pipe'] })
      .toString()
      .trim()
    return `${hash} (${date})`
  } catch {
    return process.env.npm_package_version ?? 'dev'
  }
}

// Compute once per cold start — version doesn't change mid-deployment
const VERSION = getVersion()

export async function GET(): Promise<NextResponse> {
  return NextResponse.json(
    { version: VERSION },
    { headers: { 'Cache-Control': 'public, max-age=60, s-maxage=60' } }
  )
}
