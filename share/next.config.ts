import type { NextConfig } from "next";
import path from "path";
import { fileURLToPath } from "url";

const shareRoot = path.dirname(fileURLToPath(import.meta.url));

const nextConfig: NextConfig = {
  reactStrictMode: true,
  outputFileTracingRoot: shareRoot,
  // The web office is the Vite app built into public/app (npm run build:office). It owns the home
  // page and project pages; /p/<slug>, /callback and /api stay with this Next app.
  async rewrites() {
    return {
      beforeFiles: [
        { source: "/", destination: "/app/index.html" },
        { source: "/project/:path*", destination: "/app/index.html" },
      ],
      afterFiles: [],
      fallback: [],
    };
  },
};

export default nextConfig;
