import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  images: {
    // Supabase Storage images served via our own /api/thumbnail proxy
    unoptimized: true,
  },
}

export default nextConfig
