/** @type {import('next').NextConfig} */
const nextConfig = {
  outputFileTracingRoot: import.meta.dirname,
  serverExternalPackages: ["@spectrum-ts/core", "@spectrum-ts/imessage", "ffmpeg-static"],
  outputFileTracingIncludes: { "/*": ["./node_modules/ffmpeg-static/ffmpeg"] },
  output: process.env.BUILD_STANDALONE === "1" ? "standalone" : undefined,
};

export default nextConfig;
