import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Produce a self-contained server bundle in .next/standalone for Docker.
  // Drastically shrinks the production image (we don't ship node_modules).
  output: "standalone",
};

export default nextConfig;
