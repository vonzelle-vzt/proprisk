/** @type {import('next').NextConfig} */
const nextConfig = {
  // Standalone output is what the Dockerfile copies into the runner stage
  // (.next/standalone + .next/static + public) — it has no effect on
  // `npm run dev` or `npm start` outside Docker.
  output: 'standalone',
  images: {
    // Per-client brand logos/favicons load from client-owned storage
    // (e.g. Supabase Storage) — allow any https host.
    remotePatterns: [{ protocol: 'https', hostname: '**' }],
  },
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'X-DNS-Prefetch-Control', value: 'on' },
          { key: 'Strict-Transport-Security', value: 'max-age=31536000; includeSubDomains' },
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
        ],
      },
    ];
  },
};

export default nextConfig;
