import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // `web/` lives inside the aztrx repo (which has its own package-lock.json).
  // Pin the Turbopack workspace root to this directory so it doesn't try to
  // infer the root from the parent CLI package.
  turbopack: {
    root: process.cwd(),
  },
};

export default nextConfig;
