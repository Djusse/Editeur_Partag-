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
  // PAS de bloc `env` ici. Il réécrivait `NEXT_PUBLIC_API_BASE` avec une chaîne
  // vide quand la variable n'était pas définie, ce qui écrasait le défaut
  // `'/api'` appliqué dans `src/lib/api.ts` (`'' ?? '/api'` vaut `''`) : le
  // client appelait alors `/me/credit` sur l'origine du front (3000), donc 404.
  // Les variables `NEXT_PUBLIC_*` sont de toute façon inlinées par Next.
};

export default nextConfig;
