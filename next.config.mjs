/** @type {import('next').NextConfig} */
const nextConfig = {
  // The MCP route talks to OpenAI + Vercel Blob from the server only.
  // Nothing needs the browser bundle, so keep the default (server) runtime.
};

export default nextConfig;
