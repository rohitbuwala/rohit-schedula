import type { NextConfig } from "next";

const authBackendUrl = (process.env.NEXT_PUBLIC_AUTH_URL || "http://localhost:5000").replace(/\/+$/, "");

const nextConfig: NextConfig = {
  distDir: process.env.ASSISTANT_E2E === "1" ? ".next-e2e" : ".next",
  poweredByHeader: false,
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          {
            key: "X-Content-Type-Options",
            value: "nosniff",
          },
          {
            key: "X-Frame-Options",
            value: "DENY",
          },
          {
            key: "Referrer-Policy",
            value: "strict-origin-when-cross-origin",
          },
          {
            key: "Permissions-Policy",
            value: 'camera=(), microphone=(self), geolocation=(), payment=(self "https://checkout.razorpay.com")',
          },
        ],
      },
    ];
  },
  async rewrites() {
    return [
      {
        source: "/api/:path*",
        destination: `${authBackendUrl}/api/:path*`,
      },
    ];
  },
  /* config options here */
  experimental: {
    agentFeedback: true,
  },
  cacheComponents: true,
  partialPrefetching: true,
};

export default nextConfig;
