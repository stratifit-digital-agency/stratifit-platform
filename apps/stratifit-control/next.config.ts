import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  transpilePackages: [
    "@stratifit/contracts",
    "@stratifit/auth",
    "@stratifit/permissions",
    "@stratifit/events",
    "@stratifit/ui",
    "@stratifit/production-engine",
    "@stratifit/publishing-engine",
    "@stratifit/compute",
    "@stratifit/storage",
    "@stratifit/database",
    "@stratifit/ai",
    "@stratifit/workflows",
  ],
};

export default nextConfig;
