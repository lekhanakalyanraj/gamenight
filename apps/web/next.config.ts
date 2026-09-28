import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  transpilePackages: ["@gamenight/db-types"],
};

export default nextConfig;
