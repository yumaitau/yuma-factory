import type { NextConfig } from 'next';
import { initOpenNextCloudflareForDev } from '@opennextjs/cloudflare';

const nextConfig: NextConfig = {
  turbopack: { root: process.cwd() },
  allowedDevOrigins: ['127.0.0.1', 'localhost'],
  cacheComponents: true,
  partialPrefetching: true,
  serverExternalPackages: ['@react-pdf/renderer', 'docx'],
  experimental: {
    turbopackFileSystemCacheForDev: true,
    turbopackFileSystemCacheForBuild: true,
    instantInsights: { validationLevel: 'warning' },
    exposeTestingApiInProductionBuild: true,
  },
};

export default nextConfig;

initOpenNextCloudflareForDev();
