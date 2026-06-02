import { NextResponse } from 'next/server'

export async function GET(): Promise<NextResponse> {
  return NextResponse.json(
    { ok: true, version: process.env.npm_package_version ?? 'unknown' },
    { headers: { 'Cache-Control': 'no-store' } }
  )
}
