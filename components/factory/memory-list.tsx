'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useFormStatus } from 'react-dom';
import { Archive, ArchiveRestore, Check, ChevronDown, FolderGit2, Globe, Pencil, Pin, PinOff, Plus, Search, X } from 'lucide-react';
import { createMemoryAction, revertMemoryAction, updateMemoryAction } from '@/app/actions/memory';
import type { memoryEvents } from '@/db/schema';
import type { Memory } from '@/lib/memory-store';
import { MEMORY_KINDS } from '@/lib/memory';
import {
  ALL_PROJECTS, eventActor, eventSummary, filterMemories, scoreExplanation, sourceLabel, trackRecord, type Inclusion, type ScopeOption,
} from '@/lib/memory-view';
import { formatSydneyDateTime } from '@/lib/datetime';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

export type MemoryEvent = typeof memoryEvents.$inferSelect;
export type MemoryItem = Memory & { scope: string; inclusion: Inclusion; history: MemoryEvent[] };
export type MemoryGroup = { id: string; title: string; hint?: ReactNode; items: MemoryItem[]; inherited?: boolean; empty: ReactNode };

const chip = 'inline-flex h-5 max-w-full min-w-0 items-center gap-1 rounded border border-border bg-card px-1.5 text-[11px] leading-none text-muted-foreground';
const action = 'inline-flex h-6 items-center gap-1 rounded border border-border bg-card px-1.5 text-[11px] font-medium transition-colors duration-150 ease-out hover:bg-muted disabled:opacity-50';
const field = 'h-8 rounded-md border border-border bg-background px-2 text-[13px] outline-none focus-visible:ring-2 focus-visible:ring-ring';
const toneClass: Record<Inclusion['tone'], string> = {
  primary: 'border-primary/30 text-primary',
  done: 'border-status-done/40 text-status-done',
  attention: 'border-status-attention/40 text-status-attention',
  muted: '',
};

export function MemoryList({ groups, scope, canAdd }: { groups: MemoryGroup[]; scope: { projectId: string | null; label: string }; canAdd: boolean }) {
  const [text, setText] = useState('');
  const [kind, setKind] = useState('');
  const [adding, setAdding] = useState(false);
  const total = groups.reduce((sum, group) => sum + group.items.length, 0);
  return <div className="min-w-0">
    <div className="mb-4 flex flex-wrap items-center gap-2">
      {total > 0 && <>
        <label className="relative min-w-0 flex-1 basis-56">
          <span className="sr-only">Search memories</span>
          <Search aria-hidden className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <input type="search" className={cn(field, 'w-full bg-card pl-8 placeholder:text-muted-foreground')} placeholder="Search memories…"
            value={text} onChange={(event) => setText(event.target.value)} />
        </label>
        <select aria-label="Filter by kind" className={cn(field, 'bg-card')} value={kind} onChange={(event) => setKind(event.target.value)}>
          <option value="">All kinds</option>
          {MEMORY_KINDS.map((value) => <option key={value} value={value}>{value}</option>)}
        </select>
      </>}
      {canAdd && !adding && <Button type="button" size="sm" className="ml-auto h-8 gap-1.5 rounded-md px-3 text-[13px]" onClick={() => setAdding(true)}>
        <Plus aria-hidden className="size-3.5" />Add memory
      </Button>}
    </div>
    {adding && <AddMemory scope={scope} onClose={() => setAdding(false)} />}
    {groups.map((group) => {
      const items = filterMemories(group.items, { kind, text });
      return <section key={group.id} aria-labelledby={`group-${group.id}`} className="mb-6">
        <h2 id={`group-${group.id}`} className="flex items-baseline gap-2 text-[13px] font-medium">
          {group.title}<span className="font-normal tabular-nums text-muted-foreground">{group.items.length}</span>
        </h2>
        {group.hint && <p className="mt-0.5 text-xs text-muted-foreground">{group.hint}</p>}
        {items.length > 0 && <div className="mt-2 flex flex-col gap-1.5">
          {items.map((memory) => <MemoryRow key={memory.id} memory={memory} inherited={group.inherited} />)}
        </div>}
        {!items.length && <div className="mt-2 rounded-md border border-dashed border-border px-4 py-5 text-center text-[13px] text-muted-foreground">
          {group.items.length ? 'No memories match this search.' : group.empty}
        </div>}
      </section>;
    })}
  </div>;
}

function Submit({ children, className, name, value }: { children: ReactNode; className?: string; name?: string; value?: string }) {
  const { pending } = useFormStatus();
  return <button type="submit" name={name} value={value} disabled={pending} className={className}>{children}</button>;
}

function AddMemory({ scope, onClose }: { scope: { projectId: string | null; label: string }; onClose: () => void }) {
  const [error, setError] = useState('');
  return <form aria-label="Add memory" className="mb-6 rounded-md border border-border bg-card p-3 text-[13px] shadow-[0_1px_2px_rgb(28_25_23/0.04)]"
    action={async (data) => {
      setError('');
      try { await createMemoryAction(data); onClose(); }
      catch { setError('Could not add this memory. The same memory may already exist here.'); }
    }}>
    <input type="hidden" name="projectId" value={scope.projectId ?? 'global'} />
    <div className="mb-2 flex items-center justify-between gap-3">
      <label htmlFor="memory-content" className="font-medium">Memory</label>
      <span className="text-xs text-muted-foreground">Applies to: <span className="font-medium text-foreground">{scope.label}</span></span>
    </div>
    <textarea id="memory-content" name="content" rows={3} required minLength={3} maxLength={2000} autoFocus
      className="w-full rounded-md border border-border bg-background px-3 py-2 text-[13px] outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring"
      placeholder="e.g. Run pnpm d1:migrate:local before pnpm test:e2e; e2e fails on a fresh checkout otherwise." />
    <div className="mt-2 flex flex-wrap items-end gap-3">
      <label className="flex flex-col gap-1 text-xs text-muted-foreground">Kind
        <select name="kind" defaultValue="convention" className={cn(field, 'text-foreground')}>
          {MEMORY_KINDS.map((value) => <option key={value} value={value}>{value}</option>)}
        </select>
      </label>
      <PriorityField defaultValue={60} />
      <label className="flex h-8 items-center gap-2"><input type="checkbox" name="pinned" /> Always include</label>
      <div className="ml-auto flex gap-2">
        <button type="button" className={cn(action, 'h-8 px-3 text-[13px]')} onClick={onClose}>Cancel</button>
        <Submit className="inline-flex h-8 items-center rounded-md bg-primary px-3 text-[13px] font-semibold text-primary-foreground hover:bg-accent-dark disabled:opacity-50">Save memory</Submit>
      </div>
    </div>
    {error && <p role="alert" className="mt-2 text-xs text-status-attention">{error}</p>}
  </form>;
}

function PriorityField({ defaultValue }: { defaultValue: number }) {
  return <label className="flex flex-col gap-1 text-xs text-muted-foreground" title="Higher priority ranks first. Team memories start at 60, agent learnings at 20.">
    Priority (0–100)
    <input name="weight" type="number" min={0} max={100} defaultValue={defaultValue} className={cn(field, 'w-24 text-foreground')} />
  </label>;
}

function MemoryRow({ memory, inherited }: { memory: MemoryItem; inherited?: boolean }) {
  const [editing, setEditing] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [clamped, setClamped] = useState(false);
  const text = useRef<HTMLParagraphElement>(null);
  // Offer "Show more" only when the two-line clamp actually hides text at this width.
  useEffect(() => {
    const node = text.current;
    if (!node || expanded) return;
    const measure = () => setClamped(node.scrollHeight > node.clientHeight + 1);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [expanded, editing]);
  const [error, setError] = useState('');
  const update = async (data: FormData) => {
    setError('');
    try { await updateMemoryAction(data); }
    catch { setError('Could not update this memory. Try again.'); }
  };
  const global = memory.scope === ALL_PROJECTS;
  const ScopeIcon = global ? Globe : FolderGit2;
  return <article id={memory.id} aria-label={`${memory.kind} memory`}
    className="scroll-mt-6 rounded-md border border-border bg-card px-3 py-2.5 text-[13px] shadow-[0_1px_2px_rgb(28_25_23/0.04)] target:border-primary/50 target:ring-2 target:ring-primary/15">
    {editing ? <EditMemory memory={memory} onClose={() => setEditing(false)} /> : <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:gap-3">
      <div className="min-w-0 flex-1">
        <p ref={text} className={cn('wrap-anywhere leading-relaxed', !expanded && 'line-clamp-2')}>{memory.content}</p>
        {(clamped || expanded) && <button type="button" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}
          className="text-xs text-muted-foreground hover:text-foreground hover:underline">{expanded ? 'Show less' : 'Show more'}</button>}
      </div>
      <div className="flex shrink-0 flex-wrap gap-1 sm:justify-end">
        {inherited ? <Link href={`/memory#${memory.id}`} className={action}><Pencil aria-hidden className="size-3" />Edit in {ALL_PROJECTS}</Link> : <>
          {memory.status === 'suggested' && <RowAction memoryId={memory.id} name="status" value="active" onSubmit={update}
            className="border-primary bg-primary text-primary-foreground hover:bg-accent-dark"><Check aria-hidden className="size-3" />Accept</RowAction>}
          {memory.status === 'archived' && <RowAction memoryId={memory.id} name="status" value="active" onSubmit={update}><ArchiveRestore aria-hidden className="size-3" />Restore</RowAction>}
          <button type="button" className={action} onClick={() => setEditing(true)}><Pencil aria-hidden className="size-3" />Edit</button>
          {memory.status === 'active' && <RowAction memoryId={memory.id} name="pinned" value={memory.pinned ? 'false' : 'true'} onSubmit={update}
            title={memory.pinned ? 'Rank this memory like the others' : 'Include this memory in every run'}>
            {memory.pinned ? <><PinOff aria-hidden className="size-3" />Unpin</> : <><Pin aria-hidden className="size-3" />Pin</>}
          </RowAction>}
          {memory.status === 'suggested' && <RowAction memoryId={memory.id} name="status" value="archived" onSubmit={update}
            title="Archive this learning without using it"><X aria-hidden className="size-3" />Dismiss</RowAction>}
          {memory.status === 'active' && <RowAction memoryId={memory.id} name="status" value="archived" onSubmit={update}
            title="Stop sending this memory to agents"><Archive aria-hidden className="size-3" />Archive</RowAction>}
        </>}
      </div>
    </div>}
    <div className="mt-2 flex flex-wrap items-center gap-1">
      <span className={chip} title={global ? 'Applies to every project' : `Applies only to ${memory.scope}`}>
        <ScopeIcon aria-hidden className="size-3 shrink-0" /><span className="truncate">{memory.scope}</span>
      </span>
      <span className={cn(chip, toneClass[memory.inclusion.tone])} title={memory.inclusion.detail}>{memory.inclusion.label}</span>
      <span className={chip}>{memory.kind}</span>
      <span className="ml-1 flex min-w-0 flex-wrap items-center gap-x-1.5 text-[11px] text-muted-foreground">
        <span title="Higher priority ranks first among memories that are not pinned.">Priority {memory.weight}/100</span>
        <span aria-hidden>·</span>
        <span title={scoreExplanation(memory)}>{trackRecord(memory)}</span>
        <span aria-hidden>·</span>
        <span>{sourceLabel(memory.source)}{memory.sourceRunId &&
          <> in <Link href={`/work/runs/${memory.sourceRunId}`} className="underline hover:text-foreground">this run →</Link></>}</span>
      </span>
    </div>
    {error && <p role="alert" className="mt-1.5 text-xs text-status-attention">{error}</p>}
    {!inherited && <History events={memory.history} />}
  </article>;
}

function RowAction({ memoryId, name, value, onSubmit, title, className, children }: {
  memoryId: string; name: string; value: string; onSubmit: (data: FormData) => Promise<void>; title?: string; className?: string; children: ReactNode;
}) {
  return <form action={onSubmit} title={title}>
    <input type="hidden" name="memoryId" value={memoryId} />
    <Submit name={name} value={value} className={cn(action, className)}>{children}</Submit>
  </form>;
}

function EditMemory({ memory, onClose }: { memory: MemoryItem; onClose: () => void }) {
  const [error, setError] = useState('');
  return <form aria-label="Edit memory" action={async (data) => {
    setError('');
    try { await updateMemoryAction(data); onClose(); }
    catch { setError('Could not save this memory. The same memory may already exist here.'); }
  }}>
    <input type="hidden" name="memoryId" value={memory.id} />
    <textarea name="content" rows={3} required minLength={3} maxLength={2000} defaultValue={memory.content} aria-label="Memory content" autoFocus
      className="w-full rounded-md border border-border bg-background px-3 py-2 text-[13px] outline-none focus-visible:ring-2 focus-visible:ring-ring" />
    <div className="mt-2 flex flex-wrap items-end gap-3">
      <label className="flex flex-col gap-1 text-xs text-muted-foreground">Kind
        <select name="kind" defaultValue={memory.kind} className={cn(field, 'text-foreground')}>
          {MEMORY_KINDS.map((value) => <option key={value} value={value}>{value}</option>)}
        </select>
      </label>
      <PriorityField defaultValue={memory.weight} />
      <div className="ml-auto flex gap-2">
        <button type="button" className={cn(action, 'h-8 px-3 text-[13px]')} onClick={onClose}>Cancel</button>
        <Submit className="inline-flex h-8 items-center rounded-md bg-primary px-3 text-[13px] font-semibold text-primary-foreground hover:bg-accent-dark disabled:opacity-50">Save</Submit>
      </div>
    </div>
    {error && <p role="alert" className="mt-2 text-xs text-status-attention">{error}</p>}
  </form>;
}

function History({ events }: { events: MemoryEvent[] }) {
  if (!events.length) return null;
  return <details className="mt-2 text-xs text-muted-foreground">
    <summary className="w-fit cursor-pointer hover:text-foreground">History ({events.length})</summary>
    <ul className="mt-1.5 flex flex-col gap-1 border-l border-border pl-3">
      {events.map((event) => {
        const actor = eventActor(event.actor);
        return <li key={event.id} className="flex flex-wrap items-center gap-x-1.5">
          <span className="tabular-nums">{formatSydneyDateTime(event.createdAt)}</span>
          <span className="font-medium text-foreground">{event.action}</span>
          <span>by {actor.runId ? <Link href={`/work/runs/${actor.runId}`} className="underline hover:text-foreground">{actor.label}</Link> : actor.label}</span>
          {event.after && <span className="wrap-anywhere">· {eventSummary(event.after)}</span>}
          {event.before && <form action={revertMemoryAction}>
            <input type="hidden" name="eventId" value={event.id} />
            <button type="submit" className="underline hover:text-foreground" title={`Put back ${eventSummary(event.before)}`}>Revert</button>
          </form>}
        </li>;
      })}
    </ul>
  </details>;
}

/** Scales to many repositories: a searchable list with the projects that have memories first. */
export function ScopePicker({ current, options, sharedCount }: { current: string | null; options: ScopeOption[]; sharedCount: number }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const box = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => { if (!box.current?.contains(event.target as Node)) setOpen(false); };
    document.addEventListener('pointerdown', close);
    return () => document.removeEventListener('pointerdown', close);
  }, [open]);
  const label = options.find((option) => option.id === current)?.name ?? ALL_PROJECTS;
  const needle = query.trim().toLowerCase();
  const matches = options.filter((option) => option.name.toLowerCase().includes(needle));
  const used = matches.filter((option) => option.active + option.review > 0);
  const unused = matches.filter((option) => option.active + option.review === 0);
  const showShared = !needle || ALL_PROJECTS.toLowerCase().includes(needle);
  const href = (id: string | null) => id ? `/memory?project=${encodeURIComponent(id)}` : '/memory';
  const close = () => { setOpen(false); setQuery(''); };
  return <div ref={box} className="relative" onKeyDown={(event) => { if (event.key === 'Escape' && open) { close(); trigger.current?.focus(); } }}>
    <button ref={trigger} type="button" aria-expanded={open} aria-haspopup="dialog" onClick={() => setOpen(!open)}
      className="flex h-8 max-w-80 items-center gap-2 rounded-md border border-border bg-card px-2.5 text-[13px] transition-colors hover:bg-muted">
      <span className="text-muted-foreground">Scope</span>
      <span className="truncate font-medium">{label}</span>
      <ChevronDown aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
    </button>
    {open && <div role="dialog" aria-label="Choose scope" className="absolute right-0 z-30 mt-1 w-80 max-w-[calc(100vw-3rem)] rounded-md border border-border bg-card shadow-lg">
      <input type="search" autoFocus aria-label="Find a project" placeholder="Find a project…" value={query}
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={(event) => {
          if (event.key !== 'Enter') return;
          const first = showShared ? null : (used[0] ?? unused[0])?.id;
          if (first === undefined) return;
          event.preventDefault(); close(); router.push(href(first));
        }}
        className="h-9 w-full border-b border-border bg-transparent px-3 text-[13px] outline-none placeholder:text-muted-foreground" />
      <div className="max-h-80 overflow-y-auto p-1">
        {showShared && <ScopeLink href={href(null)} current={!current} name={ALL_PROJECTS} active={sharedCount} onPick={close} icon={<Globe aria-hidden className="size-3.5" />} />}
        {used.length > 0 && <p className="px-2 pb-1 pt-2 text-[11px] font-medium text-muted-foreground">Projects with memories</p>}
        {used.map((option) => <ScopeLink key={option.id} href={href(option.id)} current={current === option.id} name={option.name} active={option.active} review={option.review} onPick={close} />)}
        {unused.length > 0 && <p className="px-2 pb-1 pt-2 text-[11px] font-medium text-muted-foreground">Other projects</p>}
        {unused.map((option) => <ScopeLink key={option.id} href={href(option.id)} current={current === option.id} name={option.name} onPick={close} />)}
        {!showShared && !matches.length && <p className="px-2 py-3 text-center text-xs text-muted-foreground">No projects match.</p>}
      </div>
    </div>}
  </div>;
}

function ScopeLink({ href, current, name, active, review, icon, onPick }: {
  href: string; current: boolean; name: string; active?: number; review?: number; icon?: ReactNode; onPick: () => void;
}) {
  return <Link href={href} onClick={onPick} aria-current={current ? 'page' : undefined}
    className={cn('flex items-center gap-2 rounded px-2 py-1.5 text-[13px] hover:bg-muted', current && 'bg-muted font-medium')}>
    {icon ?? <FolderGit2 aria-hidden className="size-3.5 text-muted-foreground" />}
    <span className="min-w-0 flex-1 truncate">{name}</span>
    {!!review && <span className="rounded-full bg-primary px-1.5 text-[11px] font-medium leading-4 text-primary-foreground">{review} to review</span>}
    {!!active && <span className="text-xs tabular-nums text-muted-foreground">{active}</span>}
  </Link>;
}
