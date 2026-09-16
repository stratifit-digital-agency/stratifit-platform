import type { NextConfig } from "next";

// Only public-safe packages are transpiled here. The dependency boundary
// rules make it a lint error to import internal production packages
// (compute, ai, workflows, database, storage, production-engine).
const nextConfig: NextConfig = {
  transpilePackages: [
    "@stratifit/contracts",
    "@stratifit/auth",
    "@stratifit/ui",
    "@stratifit/publishing-engine",
  ],
};

export default nextConfig;
