/**
 * Export statique : aucun serveur Next.js à héberger (S3 + CloudFront).
 * Les routes dynamiques passent par la query string (/doc?id=…, /d?token=…)
 * car l'export statique ne connaît pas les identifiants à l'avance.
 */
/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'export',
  trailingSlash: true,
  images: { unoptimized: true },
  reactStrictMode: true,
  env: {
    NEXT_PUBLIC_API_BASE: process.env.NEXT_PUBLIC_API_BASE ?? '',
    NEXT_PUBLIC_WS_URL: process.env.NEXT_PUBLIC_WS_URL ?? '',
  },
};

export default nextConfig;
