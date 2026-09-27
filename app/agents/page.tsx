import { connection } from 'next/server';
import { Suspense } from 'react';

import { AppShell } from '@/components/factory/app-shell';
import { CreateAgentForm } from '@/components/factory/create-agent-form';
import { Card } from '@/components/ui/card';
import { listAgentsWithOwners } from '@/lib/queries';
import { requireSession } from '@/lib/session';

export const metadata = { title: 'Agents' };

export default function AgentsPage() {
  return (
    <Suspense fallback={<p className="p-6 text-sm text-muted-foreground">Loading agents…</p>}>
      <Agents />
    </Suspense>
  );
}

async function Agents() {
  await connection();
  const session = await requireSession();
  const agents = await listAgentsWithOwners();

  // Group by owner so "my agents vs my co-founder's agents" is explicit.
  const byOwner = new Map<
    string,
    { ownerName: string; ownerEmail: string; agents: typeof agents }
  >();
  for (const agent of agents) {
    const bucket = byOwner.get(agent.ownerUserId) ?? {
      ownerName: agent.ownerName,
      ownerEmail: agent.ownerEmail,
      agents: [] as typeof agents,
    };
    bucket.agents.push(agent);
    byOwner.set(agent.ownerUserId, bucket);
  }

  return (
    <AppShell email={session.user.email}>
      <div className="mb-6">
        <h1 className="text-2xl font-semibold">Agents</h1>
        <p className="text-sm text-muted-foreground">
          Agents are grouped by owner, so you can see who is working on what.
        </p>
      </div>

      <div className="mb-8">
        <CreateAgentForm />
      </div>

      {byOwner.size === 0 ? (
        <p className="text-sm text-muted-foreground">No agents yet. Create one above.</p>
      ) : (
        <div className="flex flex-col gap-8">
          {[...byOwner.entries()].map(([ownerId, bucket]) => (
            <section key={ownerId}>
              <div className="mb-3 flex items-center gap-2">
                <h2 className="text-lg font-semibold">{bucket.ownerName}</h2>
                {bucket.ownerEmail === session.user.email ? (
                  <span className="rounded-full bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary">
                    You
                  </span>
                ) : null}
                <span className="text-sm text-muted-foreground">
                  · {bucket.agents.length} agent{bucket.agents.length === 1 ? '' : 's'}
                </span>
              </div>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {bucket.agents.map((agent) => (
                  <Card key={agent.id} className="flex items-start gap-3 p-4">
                    <span
                      className="mt-1 inline-block h-3 w-3 shrink-0 rounded-full"
                      style={{ backgroundColor: agent.color }}
                      aria-hidden
                    />
                    <div className="min-w-0">
                      <p className="truncate font-medium">{agent.name}</p>
                      <p className="text-xs text-muted-foreground">
                        {agent.status} · {agent.modelId ?? 'pool default'}
                      </p>
                    </div>
                  </Card>
                ))}
              </div>
            </section>
          ))}
        </div>
      )}
    </AppShell>
  );
}
