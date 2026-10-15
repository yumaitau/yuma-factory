import { connection } from 'next/server';
import { Suspense } from 'react';

import { ApiKeysPanel } from '@/components/factory/api-keys-panel';
import { AppShell } from '@/components/factory/app-shell';
import { PageLoading } from '@/components/factory/page-loading';
import { listApiKeys } from '@/lib/api-keys';
import { formatSydneyDateTime } from '@/lib/datetime';
import { getDb } from '@/lib/db';
import { appUrl } from '@/lib/env';
import { requireSession } from '@/lib/session';

export const metadata = { title: 'API keys' };

export default function ApiKeysPage() {
  return (
    <Suspense fallback={<PageLoading label="Loading API keys…" />}>
      <ApiKeys />
    </Suspense>
  );
}

async function ApiKeys() {
  await connection();
  const session = await requireSession();
  const keys = await listApiKeys(await getDb(), session.user.id);
  const when = (value: Date | null) => value ? formatSydneyDateTime(value) : null;
  const now = new Date();
  return (
    <AppShell>
      <div className="mb-6">
        <h1 className="text-2xl font-semibold">API keys</h1>
        <p className="text-sm text-muted-foreground">
          Control Factory from other agents over MCP at <code className="font-mono">/api/mcp</code> or HTTP at <code className="font-mono">/api/v1</code>.
        </p>
      </div>
      <ApiKeysPanel mcpUrl={`${appUrl()}/api/mcp`} keys={keys.map((key) => ({
        id: key.id, name: key.name, prefix: key.prefix, createdAt: formatSydneyDateTime(key.createdAt),
        lastUsedAt: when(key.lastUsedAt), expiresAt: formatSydneyDateTime(key.expiresAt), expired: key.expiresAt <= now,
        revokedAt: when(key.revokedAt),
      }))} />
    </AppShell>
  );
}
