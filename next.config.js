/** @type {import('next').NextConfig} */
const repositoryName = process.env.GITHUB_REPOSITORY?.split("/")[1] ?? "echarts-demo";
const isGithubPages = process.env.PUBLISH_TO_GITHUB_PAGES === "true";
const basePath = isGithubPages ? `/${repositoryName}` : "";

const nextConfig = {
  reactStrictMode: true,
  output: "export",
  basePath,
  assetPrefix: basePath ? `${basePath}/` : undefined,
  images: {
    unoptimized: true,
  },
  env: {
    NEXT_PUBLIC_BASE_PATH: basePath,
  },
};

module.exports = nextConfig;
