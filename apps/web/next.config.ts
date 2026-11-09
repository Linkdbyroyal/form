import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  transpilePackages: ["@sbos/db", "@sbos/contracts"],
  serverExternalPackages: ["pg"],
  poweredByHeader: false
};

export default nextConfig;
