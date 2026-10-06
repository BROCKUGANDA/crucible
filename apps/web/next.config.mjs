/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  transpilePackages: ["@crucible/smith", "@crucible/indexer"],
};

export default nextConfig;
