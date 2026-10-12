import Link from 'next/link';
import { connection } from 'next/server';
import { Suspense, type ReactNode } from 'react';
import { PageLoading } from '@/components/factory/page-loading';

import { memorySettingsAction } from '@/app/actions/memory';
import { AppShell } from '@/components/factory/app-shell';
import { MemoryList, ScopePicker, type MemoryGroup, type MemoryItem } from '@/components/factory/memory-list';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { getDb } from '@/lib/db';
import { listMemories, memoriesForTicket, memoryCounts, memoryHistory, type Memory } from '@/lib/memory-store';
import { ALL_PROJECTS, memoryInclusion, scopeOptions, selectionSize, statusCounts } from '@/lib/memory-view';
import { listProjects } from '@/lib/queries';
import { requireSession } from '@/lib/session';
import { cn } from '@/lib/utils';

export const metadata = { title: 'Memory' };

type Search = { project?: string; status?: string; q?: string };
const STATUSES = [
  { id: 'active', label: 'Active' },
  { id: 'suggested', label: 'Needs review' },
  { id: 'archived', label: 'Archived' },
] as const;
const panel = 'rounded-md border border-border bg-card p-3 text-[13px] shadow-[0_1px_2px_rgb(28_25_23/0.04)]';
const summary = 'cursor-pointer select-none font-medium marker:text-muted-foreground';

export default function MemoryPage({ searchParams }: { searchParams: Promise<Search> }) {
  return (
    <Suspense fallback={<PageLoading label="Loading memory…" />}>
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
  const status = STATUSES.find((item) => item.id === search.status)?.id ?? 'active';
  const counts = await memoryCounts(db);
  const shared = statusCounts(counts, null);
  const tabs = statusCounts(counts, project?.id ?? null);
  const options = scopeOptions(projects, counts);
  const rows = await listMemories(db, { projectId: project?.id ?? null, status });
  const inherited = project && status === 'active' ? await listMemories(db, { projectId: null, status: 'active' }) : [];
  const events = await memoryHistory(db, rows.map((row) => row.id));
  // What a ticket with nothing relevant in it receives, ranked exactly as runs rank it.
  const typical = project ? await memoriesForTicket(db, project.id, '') : null;
  const preview = project && search.q !== undefined ? await memoriesForTicket(db, project.id, search.q) : null;
  const included = typical ? new Set(typical.selected.map((memory) => memory.id)) : undefined;
  const item = (memory: Memory): MemoryItem => ({
    ...memory,
    scope: memory.projectId ? project?.repoFullName ?? memory.projectId : ALL_PROJECTS,
    inclusion: memoryInclusion(memory, included),
    history: events.filter((event) => event.memoryId === memory.id),
  });
  const reviewing = options.filter((option) => option.review > 0);
  const scopeLabel = project?.repoFullName ?? ALL_PROJECTS;
  const href = (next: Partial<Search>) => {
    const params = new URLSearchParams();
    const merged = { project: project?.id, status, ...next };
    for (const [key, value] of Object.entries(merged)) if (value && !(key === 'status' && value === 'active')) params.set(key, value);
    return params.size ? `/memory?${params}` : '/memory';
  };
  const reviewLinks = reviewing.length ? <span className="mt-2 flex flex-wrap justify-center gap-x-3 gap-y-1">
    {reviewing.map((option) => <Link key={option.id} href={`/memory?project=${encodeURIComponent(option.id)}&status=suggested`} className="text-primary hover:underline">
      {option.name} ({option.review})</Link>)}
  </span> : null;

  const groups: MemoryGroup[] = status === 'active'
    ? project
      ? [
          { id: 'project', title: 'This project', hint: `Only runs on ${project.repoFullName} use these.`, items: rows.map(item),
            empty: `No memories for ${project.repoFullName} yet. Add one, or agents will propose learnings after their runs.` },
          { id: 'shared', title: 'From all projects', hint: <>Also applied here. Edit them in <Link href="/memory" className="underline hover:text-foreground">{ALL_PROJECTS}</Link>.</>,
            items: inherited.map(item), inherited: true, empty: 'No memories are shared by every project yet.' },
        ]
      : [{ id: 'shared', title: 'Shared by every project', hint: 'Runs on every project can use these, alongside the project\'s own memories.', items: rows.map(item),
          empty: 'Nothing applies to every project yet. Add conventions that hold across all repositories, such as the package manager or review rules.' }]
    : status === 'suggested'
      ? [{ id: 'review', title: 'Waiting for your review',
          hint: 'Agents proposed these after their runs. Runs ignore them until you accept one; dismissing archives it.', items: rows.map(item),
          empty: project
            ? project.autoLearn
              ? 'Nothing to review. This project uses agent learnings right away; turn that off in Project settings to review them first.'
              : 'Nothing to review. New agent learnings for this project will wait here.'
            : <>Agent learnings always belong to one project.{reviewLinks ? <> These projects have learnings waiting:{reviewLinks}</> : ' No project has learnings waiting.'}</> }]
      : [{ id: 'archived', title: 'Archived', hint: 'Never sent to agents. Restore one to use it again.', items: rows.map(item),
          empty: 'Nothing archived. Agent learnings that keep failing runs are archived here automatically.' }];

  return (
    <AppShell email={session.user.email}>
      <div className="mb-5 flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0 max-w-2xl">
          <h1 className="text-2xl font-semibold">Memory</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Notes agents read before each run. A run gets the memories shared by all projects plus its own project&apos;s:
            pinned ones always, the rest ranked by relevance until the project&apos;s memory budget is full.
          </p>
        </div>
        <ScopePicker current={project?.id ?? null} options={options} sharedCount={shared.active} />
      </div>

      <nav aria-label="Status" className="mb-4 flex gap-5 border-b border-border">
        {STATUSES.map((item) => {
          const count = tabs[item.id];
          const current = status === item.id;
          return <Link key={item.id} href={href({ status: item.id, q: undefined })} aria-current={current ? 'page' : undefined}
            className={cn('-mb-px flex items-center gap-1.5 border-b-2 pb-2 text-[13px] transition-colors',
              current ? 'border-foreground font-medium text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground')}>
            {item.label}
            {item.id === 'suggested' && count > 0
              ? <span className="rounded-full bg-primary px-1.5 text-[11px] font-medium leading-4 text-primary-foreground">{count}</span>
              : <span className="font-normal tabular-nums text-muted-foreground">{count}</span>}
          </Link>;
        })}
      </nav>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_18rem]">
        <MemoryList key={`${project?.id ?? 'global'}:${status}`} groups={groups} scope={{ projectId: project?.id ?? null, label: scopeLabel }} canAdd={status === 'active'} />

        <aside className="flex flex-col gap-3 self-start" aria-label={project ? 'Project memory' : 'About memory'}>
          {project && typical ? <>
            <section className={panel} aria-labelledby="run-gets">
              <h2 id="run-gets" className="font-medium">What a run gets</h2>
              <p className="mt-1 text-xs text-muted-foreground">
                A ticket with nothing specific in it gets <span className="font-medium text-foreground">{typical.selected.length} of {tabs.active + shared.active}</span> active
                memories, using {selectionSize(typical.selected).toLocaleString('en-AU')} of {project.memoryBudget.toLocaleString('en-AU')} characters.
              </p>
              <Meter used={selectionSize(typical.selected)} budget={project.memoryBudget} />
              <p className="mt-2 text-xs text-muted-foreground">
                Pinned memories go in first. The rest are ranked by priority, track record and how many words they share with the ticket.
              </p>
            </section>
            <details className={panel} open={!!preview}>
              <summary className={summary}>Test a ticket</summary>
              <p className="mt-1 text-xs text-muted-foreground">See which memories a ticket like this would get.</p>
              <form action="/memory" className="mt-2 flex flex-col gap-2">
                <input type="hidden" name="project" value={project.id} />
                {status !== 'active' && <input type="hidden" name="status" value={status} />}
                <Input name="q" aria-label="Ticket title or description" placeholder="Ticket title or description" defaultValue={search.q ?? ''} className="h-8 text-[13px]" />
                <Button type="submit" variant="outline" size="sm" className="h-8 rounded-md text-[13px]">Test ticket</Button>
              </form>
              {preview && <Preview selected={preview.selected} block={preview.block} />}
            </details>
            <details className={panel}>
              <summary className={summary}>Project settings</summary>
              <form action={memorySettingsAction} className="mt-2 flex flex-col gap-3 text-xs">
                <input type="hidden" name="projectId" value={project.id} />
                <label className="flex flex-col gap-1 text-muted-foreground">Memory budget per run (characters)
                  <Input name="memoryBudget" type="number" min={0} max={20000} step={500} defaultValue={project.memoryBudget} className="h-8 text-[13px] text-foreground" />
                </label>
                <label className="flex items-start gap-2">
                  <input type="checkbox" name="autoLearn" defaultChecked={project.autoLearn} className="mt-0.5" />
                  Use agent learnings right away (otherwise they wait in Needs review)
                </label>
                <label className="flex items-start gap-2">
                  <input type="checkbox" name="autoApprovePlans" defaultChecked={project.autoApprovePlans} className="mt-0.5" />
                  Apply planner breakdowns without approval
                </label>
                <div><Button type="submit" variant="outline" size="sm" className="h-8 rounded-md text-[13px]">Save settings</Button></div>
              </form>
            </details>
          </> : <>
            <Panel title="How memory is chosen">
              <p className="mt-1 text-xs text-muted-foreground">
                Memories here reach every project. Each project adds its own memories and sets its own budget.
                Pick a project with Scope to see exactly what its runs get, test a ticket, or change its settings.
              </p>
            </Panel>
            {reviewing.length > 0 && <Panel title="Waiting for review">
              <ul className="mt-1 flex flex-col gap-1 text-xs">
                {reviewing.map((option) => <li key={option.id} className="flex items-center gap-2">
                  <Link href={`/memory?project=${encodeURIComponent(option.id)}&status=suggested`} className="min-w-0 flex-1 truncate hover:underline">{option.name}</Link>
                  <span className="rounded-full bg-primary px-1.5 text-[11px] font-medium leading-4 text-primary-foreground">{option.review}</span>
                </li>)}
              </ul>
            </Panel>}
          </>}
        </aside>
      </div>
    </AppShell>
  );
}

function Panel({ title, children }: { title: string; children: ReactNode }) {
  return <section className={panel}><h2 className="font-medium">{title}</h2>{children}</section>;
}

function Meter({ used, budget }: { used: number; budget: number }) {
  const share = budget > 0 ? Math.min(1, used / budget) : 1;
  return <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-muted" role="img" aria-label={`${Math.round(share * 100)}% of the budget used`}>
    <div className="h-full rounded-full bg-primary/70" style={{ width: `${share * 100}%` }} />
  </div>;
}

function Preview({ selected, block }: { selected: Memory[]; block: string }) {
  if (!selected.length) return <p className="mt-2 text-xs text-muted-foreground">No memory would be sent with this ticket.</p>;
  return <div className="mt-2">
    <p className="text-xs text-muted-foreground">{selected.length} {selected.length === 1 ? 'memory' : 'memories'}, {selectionSize(selected).toLocaleString('en-AU')} characters:</p>
    <ol aria-label="Memories for this ticket" className="mt-1 flex flex-col gap-1 text-xs">
      {selected.map((memory) => <li key={memory.id} className="flex gap-1.5">
        <span className="shrink-0 text-muted-foreground">{memory.projectId ? 'Project' : 'Shared'} ·</span>
        <span className="line-clamp-2 wrap-anywhere">{memory.content}</span>
      </li>)}
    </ol>
    <details className="mt-2 text-xs">
      <summary className="cursor-pointer text-muted-foreground hover:text-foreground">Exact prompt text</summary>
      <pre className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap rounded-md bg-muted p-2 text-[11px]">{block}</pre>
    </details>
  </div>;
}
