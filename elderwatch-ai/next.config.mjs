/** @type {import('next').NextConfig} */
const nextConfig = {
  outputFileTracingRoot: import.meta.dirname,
  serverExternalPackages: ["@spectrum-ts/core", "@spectrum-ts/imessage", "ffmpeg-static"],
  outputFileTracingIncludes: { "/*": ["./node_modules/ffmpeg-static/ffmpeg"] },
  output: process.env.BUILD_STANDALONE === "1" ? "standalone" : undefined,
  async rewrites() {
    // Keep the supplied landing page's document and styles separate from the app.
    return [{ source: "/", destination: "/landing/index.html" }];
  },
};

export default nextConfig;
