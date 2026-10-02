import { defineCloudflareConfig } from '@opennextjs/cloudflare';
import r2IncrementalCache from '@opennextjs/cloudflare/overrides/incremental-cache/r2-incremental-cache';

// Next 16.3.8 looks up `/route-cache/<KIND>/<hash>/$<path>`, but OpenNext still uploads build
// entries under `<path>`. Every prerendered shell missed and pages hung rendering on workerd.
// Fall back to the old key, accepting only the entry Next built for this exact scoped key.
// Remove once https://github.com/opennextjs/opennextjs-aws/issues/1269 ships.
const ROUTE_CACHE_KEY = /^\/route-cache\/[A-Z_]+\/[0-9a-f]{64}\/\$(\/.*)$/;

type R2Cache = typeof r2IncrementalCache;

const routeCacheCompatible: Pick<R2Cache, 'name' | 'get' | 'set' | 'delete'> = {
  name: r2IncrementalCache.name,
  async get(key, cacheType) {
    const entry = await r2IncrementalCache.get(key, cacheType);
    const legacyPath = entry ? undefined : ROUTE_CACHE_KEY.exec(key)?.[1];
    if (!legacyPath) return entry;
    const legacy = await r2IncrementalCache.get(legacyPath, cacheType);
    const routeCache = (legacy?.value as { meta?: { routeCache?: { key?: string; isFallback?: boolean } } } | undefined)?.meta?.routeCache;
    return routeCache?.key === key && routeCache.isFallback === false ? legacy : null;
  },
  set: (key, value, cacheType) => r2IncrementalCache.set(key, value, cacheType),
  delete: (key) => r2IncrementalCache.delete(key),
};

export default defineCloudflareConfig({
  incrementalCache: routeCacheCompatible,
});
