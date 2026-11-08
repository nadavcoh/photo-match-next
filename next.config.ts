import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  images: {
    // Thumbnails are presigned IDrive e2 URLs rendered with plain <img>
    unoptimized: true,
  },
}

export default nextConfig
