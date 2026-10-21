/** @type {import('next').NextConfig} */
const nextConfig = {
  serverExternalPackages: ["@spectrum-ts/core", "@spectrum-ts/imessage"],
  output: process.env.BUILD_STANDALONE === "1" ? "standalone" : undefined,
};

export default nextConfig;
