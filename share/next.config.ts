import type { NextConfig } from "next";
import path from "path";
import { fileURLToPath } from "url";

const shareRoot = path.dirname(fileURLToPath(import.meta.url));

const nextConfig: NextConfig = {
  reactStrictMode: true,
  outputFileTracingRoot: shareRoot,
};

export default nextConfig;
