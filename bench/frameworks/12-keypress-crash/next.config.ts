import path from "path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Fixtures don't need the AI-agent rule files.
  agentRules: false,
  // next/react are hoisted to the shared parent node_modules, so the Turbopack
  // workspace root must be the parent, not this app dir.
  turbopack: { root: path.resolve(process.cwd(), "..") },
};

export default nextConfig;
