import Link from 'next/link';
import { connection } from 'next/server';
import { Suspense } from 'react';

import { createMemoryAction, memorySettingsAction, revertMemoryAction, updateMemoryAction } from '@/app/actions/memory';
import { AppShell } from '@/components/factory/app-shell';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { formatSydneyDateTime } from '@/lib/datetime';
import { getDb } from '@/lib/db';
import { MEMORY_KINDS, memoryScore } from '@/lib/memory';
import { listMemories, memoriesForTicket, memoryHistory } from '@/lib/memory-store';
import { listProjects } from '@/lib/queries';
import { requireSession } from '@/lib/session';

export const metadata = { title: 'Memory' };

type Search = { project?: string; status?: string; q?: string };
const STATUSES = [
  { id: 'active', label: 'Active' },
  { id: 'suggested', label: 'Suggested' },
  { id: 'archived', label: 'Archived' },
];
const field = 'rounded-md border border-border bg-background px-3 py-2 text-sm';

export default function MemoryPage({ searchParams }: { searchParams: Promise<Search> }) {
  return (
    <Suspense fallback={<p className="p-6 text-sm text-muted-foreground">Loading memory…</p>}>
      <MemoryView searchParams={searchParams} />
    </Suspense>
  );
}

async function MemoryView({ searchParams }: { searchParams: Promise<Search> }) {
  await connection();
  const session = await requireSession();
  const search = await searchParams;
  const db = await getDb();
  const projects = await listProjects();
  const project = projects.find((item) => item.id === search.project) ?? null;
  const status = STATUSES.some((item) => item.id === search.status) ? search.status! : 'active';
  const rows = await listMemories(db, { projectId: project?.id ?? null, status });
  const events = await memoryHistory(db, rows.map((row) => row.id));
  const preview = project && search.q !== undefined ? await memoriesForTicket(db, project.id, search.q) : null;
  const href = (next: Partial<Search>) => {
    const params = new URLSearchParams();
    const merged = { project: project?.id, status, ...next };
    for (const [key, value] of Object.entries(merged)) if (value) params.set(key, value);
    return `/memory?${params}`;
  };

  return (
    <AppShell email={session.user.email}>
      <div className="mb-6">
        <h1 className="text-2xl font-semibold">Memory</h1>
        <p className="text-sm text-muted-foreground">
          What agents know about your software. Relevant memories go into each run prompt, ranked by weight, outcomes and relevance.
          Agents add low-weight learnings after runs. Memories used by runs that reach green CI gain score, and memories used by failed runs lose it.
        </p>
      </div>

      <nav className="mb-4 flex flex-wrap gap-2" aria-label="Scope">
        <ScopeLink href={href({ project: undefined, q: undefined })} active={!project}>Global</ScopeLink>
        {projects.map((item) => (
          <ScopeLink key={item.id} href={href({ project: item.id, q: undefined })} active={project?.id === item.id}>{item.repoFullName}</ScopeLink>
        ))}
      </nav>

      {project ? (
        <div className="mb-6 grid grid-cols-1 gap-4 lg:grid-cols-2">
          <Card>
            <h2 className="mb-3 text-lg font-semibold">Tuning</h2>
            <form action={memorySettingsAction} className="flex flex-col gap-3">
              <input type="hidden" name="projectId" value={project.id} />
              <div className="flex flex-col gap-1">
                <Label htmlFor="memory-budget">Memory budget per run (characters)</Label>
                <Input id="memory-budget" name="memoryBudget" type="number" min={0} max={20000} step={500} defaultValue={project.memoryBudget} />
              </div>
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" name="autoLearn" defaultChecked={project.autoLearn} />
                Activate agent learnings automatically (otherwise they wait in Suggested)
              </label>
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" name="autoApprovePlans" defaultChecked={project.autoApprovePlans} />
                Apply planner breakdowns without approval
              </label>
              <div><Button type="submit" variant="outline" size="sm">Save tuning</Button></div>
            </form>
          </Card>
          <Card>
            <h2 className="mb-3 text-lg font-semibold">Preview</h2>
            <form action="/memory" className="flex gap-2">
              <input type="hidden" name="project" value={project.id} />
              <input type="hidden" name="status" value={status} />
              <Input name="q" placeholder="Ticket title or description" defaultValue={search.q ?? ''} />
              <Button type="submit" variant="outline" size="sm">Preview</Button>
            </form>
            {preview ? (
              <pre className="mt-3 max-h-64 overflow-auto whitespace-pre-wrap rounded-md bg-muted p-3 text-xs">
                {preview.block || 'No memory would be injected.'}
              </pre>
            ) : (
              <p className="mt-3 text-sm text-muted-foreground">Shows the exact memory block a ticket like this would receive, including global memory.</p>
            )}
          </Card>
        </div>
      ) : null}

      <Card className="mb-6">
        <h2 className="mb-3 text-lg font-semibold">Teach {project ? project.repoFullName : 'every project'}</h2>
        <form action={createMemoryAction} className="grid grid-cols-1 gap-3 sm:grid-cols-4">
          <input type="hidden" name="projectId" value={project?.id ?? 'global'} />
          <div className="flex flex-col gap-1 sm:col-span-4">
            <Label htmlFor="memory-content">Memory</Label>
            <textarea id="memory-content" name="content" rows={2} required minLength={3} maxLength={2000} className={field}
              placeholder="e.g. Run pnpm test:e2e only after pnpm d1:migrate:local; e2e fails on a fresh checkout otherwise." />
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="memory-kind">Kind</Label>
            <select id="memory-kind" name="kind" defaultValue="convention" className={field}>
              {MEMORY_KINDS.map((kind) => <option key={kind} value={kind}>{kind}</option>)}
            </select>
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="memory-weight">Weight (0-100)</Label>
            <Input id="memory-weight" name="weight" type="number" min={0} max={100} defaultValue={60} />
          </div>
          <label className="flex items-end gap-2 pb-2 text-sm">
            <input type="checkbox" name="pinned" /> Always include
          </label>
          <div className="flex items-end"><Button type="submit">Add memory</Button></div>
        </form>
      </Card>

      <nav className="mb-3 flex gap-2" aria-label="Status">
        {STATUSES.map((item) => (
          <ScopeLink key={item.id} href={href({ status: item.id })} active={status === item.id}>{item.label}</ScopeLink>
        ))}
      </nav>

      {rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">No {status} memories here yet.</p>
      ) : (
        <div className="flex flex-col gap-3">
          {rows.map((memory) => (
            <Card key={memory.id} className="p-4" role="article" aria-label={`${memory.kind} memory`}>
              <div className="mb-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                <span className="rounded-full bg-muted px-2 py-0.5 font-medium text-foreground">{memory.kind}</span>
                {memory.pinned ? <span className="rounded-full bg-primary/10 px-2 py-0.5 font-medium text-primary">pinned</span> : null}
                <span>{memory.source === 'human' ? 'from the team' : `learned by agent${memory.sourceRunId ? ' in ' : ''}`}
                  {memory.sourceRunId ? <Link className="underline" href={`/work/runs/${memory.sourceRunId}`}>this run</Link> : null}</span>
                <span>· score {memoryScore(memory)} (weight {memory.weight}, {memory.successes} green, {memory.failures} failed, used {memory.uses}×)</span>
                <span>· updated {formatSydneyDateTime(memory.updatedAt)}</span>
              </div>
              <form action={updateMemoryAction} className="flex flex-col gap-2">
                <input type="hidden" name="memoryId" value={memory.id} />
                <textarea name="content" rows={2} maxLength={2000} defaultValue={memory.content} className={field} aria-label="Memory content" />
                <div className="flex flex-wrap items-center gap-2">
                  <select name="kind" defaultValue={memory.kind} className={field} aria-label="Kind">
                    {MEMORY_KINDS.map((kind) => <option key={kind} value={kind}>{kind}</option>)}
                  </select>
                  <label className="flex items-center gap-2 text-sm">Weight
                    <input name="weight" type="range" min={0} max={100} defaultValue={memory.weight} aria-label="Weight" />
                  </label>
                  <Button type="submit" variant="outline" size="sm">Save</Button>
                  <Button type="submit" variant="ghost" size="sm" name="pinned" value={memory.pinned ? 'false' : 'true'}>
                    {memory.pinned ? 'Unpin' : 'Pin'}
                  </Button>
                  {memory.status !== 'active' ? (
                    <Button type="submit" variant="ghost" size="sm" name="status" value="active">
                      {memory.status === 'suggested' ? 'Accept' : 'Restore'}
                    </Button>
                  ) : null}
                  {memory.status !== 'archived' ? (
                    <Button type="submit" variant="ghost" size="sm" name="status" value="archived">Archive</Button>
                  ) : null}
                </div>
              </form>
              <History events={events.filter((event) => event.memoryId === memory.id)} />
            </Card>
          ))}
        </div>
      )}
    </AppShell>
  );
}

function ScopeLink({ href, active, children }: { href: string; active: boolean; children: React.ReactNode }) {
  return (
    <Link href={href} aria-current={active ? 'page' : undefined}
      className={`rounded-full border px-3 py-1 text-sm ${active ? 'border-primary bg-primary/10 text-primary' : 'border-border text-muted-foreground hover:bg-muted'}`}>
      {children}
    </Link>
  );
}

function History({ events }: { events: Awaited<ReturnType<typeof memoryHistory>> }) {
  if (!events.length) return null;
  return (
    <details className="mt-2 text-xs text-muted-foreground">
      <summary className="cursor-pointer">History ({events.length})</summary>
      <ul className="mt-2 flex flex-col gap-1">
        {events.map((event) => (
          <li key={event.id} className="flex flex-wrap items-center gap-2">
            <span>{formatSydneyDateTime(event.createdAt)}</span>
            <span className="font-medium text-foreground">{event.action}</span>
            <span>by {event.actor}</span>
            {event.after ? <code className="wrap-anywhere">{event.after}</code> : null}
            {event.before ? (
              <form action={revertMemoryAction}>
                <input type="hidden" name="eventId" value={event.id} />
                <button type="submit" className="underline">Revert</button>
              </form>
            ) : null}
          </li>
        ))}
      </ul>
    </details>
  );
}
