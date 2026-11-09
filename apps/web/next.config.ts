import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  output: "standalone",
  transpilePackages: ["@sbos/db", "@sbos/contracts", "@sbos/core"],
  serverExternalPackages: ["pg", "pg-boss"],
  poweredByHeader: false,
  // Enables forbidden() / unauthorized() interrupts used by lib/request-context.ts (403 page).
  experimental: { authInterrupts: true }
};

export default nextConfig;
