import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",

  // Transpile Monaco for SSR compatibility
  transpilePackages: ["@monaco-editor/react"],
};

export default nextConfig;
