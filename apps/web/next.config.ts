import path from "node:path";

import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  transpilePackages: ["@gamenight/db-types"],
  // A self-contained server for the Docker image; tracing from the monorepo root picks up workspace packages.
  output: "standalone",
  outputFileTracingRoot: path.join(import.meta.dirname, "../.."),
  // `make lan` serves the dev server to phones on the Wi-Fi at the laptop's address.
  allowedDevOrigins: process.env.LAN_HOST ? [process.env.LAN_HOST] : [],
  // Don't advertise the framework.
  poweredByHeader: false,
  // Pages get their security headers from proxy.ts (with a per-request CSP nonce). Static assets skip
  // the proxy, so they get the headers that apply to them here.
  async headers() {
    const assetHeaders = [
      { key: "X-Content-Type-Options", value: "nosniff" },
      { key: "Cross-Origin-Resource-Policy", value: "same-origin" },
      { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=(), usb=()" },
    ];
    return [
      { source: "/_next/static/:path*", headers: assetHeaders },
      { source: "/favicon.ico", headers: assetHeaders },
    ];
  },
};

export default nextConfig;
