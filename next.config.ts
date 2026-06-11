import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Produce a self-contained server bundle in .next/standalone for Docker.
  // Drastically shrinks the production image (we don't ship node_modules).
  output: "standalone",

  // onnxruntime-node ships native bindings (.node) that Webpack/Turbopack
  // must NOT try to bundle. Mark it external so it's loaded as a runtime
  // dependency from node_modules instead.
  serverExternalPackages: ["onnxruntime-node"],
};

export default nextConfig;
