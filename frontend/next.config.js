/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Emit a self-contained server bundle (.next/standalone) so the production
  // image can run `node server.js` without the full node_modules tree.
  output: "standalone",
};

module.exports = nextConfig;
