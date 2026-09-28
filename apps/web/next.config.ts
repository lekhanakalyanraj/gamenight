import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  transpilePackages: ["@gamenight/db-types"],
  // `make lan` serves the dev server to phones on the Wi-Fi at the laptop's address.
  allowedDevOrigins: process.env.LAN_HOST ? [process.env.LAN_HOST] : [],
};

export default nextConfig;
