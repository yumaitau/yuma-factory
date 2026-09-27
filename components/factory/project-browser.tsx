'use client';

import { useSearchParams } from 'next/navigation';
import { Search } from 'lucide-react';

import { ProjectCard } from '@/components/factory/project-card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { browseProjects, PROJECT_SORTS, WORK_FILTERS, type BrowserProject } from '@/lib/project-browser';

const selectClass = 'h-10 w-full rounded-md border border-border bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring';

export function ProjectBrowser({ projects }: { projects: BrowserProject[] }) {
  const params = useSearchParams();
  const result = browseProjects(projects, params);
  const filtered = result.query !== '' || result.visibility !== 'all' || result.work !== 'all';

  function update(key: string, value: string, replace = false) {
    const next = new URLSearchParams(window.location.search);
    next.delete('connected');
    next.delete('installation');
    if (value) next.set(key, value);
    else next.delete(key);
    if (key !== 'page') next.delete('page');
    const url = `${window.location.pathname}${next.size ? `?${next}` : ''}`;
    if (replace) window.history.replaceState(null, '', url);
    else window.history.pushState(null, '', url);
  }

  function clearFilters() {
    const next = new URLSearchParams(window.location.search);
    for (const key of ['q', 'visibility', 'work', 'page', 'connected', 'installation']) next.delete(key);
    window.history.pushState(null, '', `${window.location.pathname}${next.size ? `?${next}` : ''}`);
  }

  const pageNumbers = Array.from(new Set([1, result.page - 1, result.page, result.page + 1, result.pages]))
    .filter((page) => page >= 1 && page <= result.pages).sort((a, b) => a - b);

  return (
    <section aria-label="Browse projects">
      <div className="grid grid-cols-1 gap-3 border-b border-border pb-5 sm:grid-cols-2 lg:grid-cols-[minmax(15rem,2fr)_1fr_1.2fr_1.2fr]">
        <label className="space-y-1.5 text-sm font-medium">
          <span>Search projects</span>
          <div className="relative">
            <Search aria-hidden="true" className="pointer-events-none absolute left-3 top-3 h-4 w-4 text-muted-foreground" />
            <Input type="search" value={result.query} placeholder="Name or description…" className="pl-9"
              onChange={(event) => update('q', event.target.value, true)} />
          </div>
        </label>
        <label className="space-y-1.5 text-sm font-medium">
          <span>Visibility</span>
          <select className={selectClass} value={result.visibility} onChange={(event) => update('visibility', event.target.value)}>
            <option value="all">All visibility</option>
            <option value="private">Private</option>
            <option value="public">Public</option>
          </select>
        </label>
        <label className="space-y-1.5 text-sm font-medium">
          <span>Open ticket stage</span>
          <select className={selectClass} value={result.work} onChange={(event) => update('work', event.target.value)}>
            {WORK_FILTERS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
        </label>
        <label className="space-y-1.5 text-sm font-medium">
          <span>Sort by</span>
          <select className={selectClass} value={result.sort} onChange={(event) => update('sort', event.target.value)}>
            {PROJECT_SORTS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
        </label>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3 py-4">
        <div className="flex flex-wrap items-center gap-3">
          <p role="status" className="text-sm text-muted-foreground">
            {result.total ? `${result.start}–${result.end} of ${result.total} ${result.total === 1 ? 'project' : 'projects'}` : '0 projects'}
            {filtered && <span> · {projects.length} total</span>}
          </p>
          {filtered && <Button variant="ghost" size="sm" onClick={clearFilters}>Clear filters</Button>}
        </div>
        <label className="flex items-center gap-2 text-sm text-muted-foreground">
          <span>Per page</span>
          <select className={`${selectClass} w-20`} value={result.pageSize} onChange={(event) => update('size', event.target.value)}>
            {[12, 24, 48].map((size) => <option key={size} value={size}>{size}</option>)}
          </select>
        </label>
      </div>

      {result.total ? (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
          {result.projects.map((project) => <ProjectCard key={project.id} project={project} counts={project.counts} />)}
        </div>
      ) : (
        <div className="py-16 text-center">
          <h2 className="text-lg font-semibold">No matching projects</h2>
          <p className="mt-2 text-sm text-muted-foreground">Try another name or clear filters to see all repositories.</p>
          <Button variant="outline" className="mt-5" onClick={clearFilters}>Clear filters</Button>
        </div>
      )}

      {result.total > 0 && (
        <nav aria-label="Project pagination" className="mt-6 flex flex-wrap items-center justify-between gap-3 border-t border-border pt-5">
          <p className="text-sm text-muted-foreground">Page {result.page} of {result.pages}</p>
          <div className="flex flex-wrap items-center gap-1">
            <Button variant="outline" size="sm" disabled={result.page === 1} onClick={() => update('page', String(result.page - 1))}>Previous</Button>
            {pageNumbers.map((page, index) => (
              <span key={page} className="inline-flex items-center gap-1">
                {index > 0 && page - pageNumbers[index - 1] > 1 && <span aria-hidden="true" className="px-1 text-muted-foreground">…</span>}
                <Button size="sm" variant={page === result.page ? 'default' : 'ghost'} aria-label={`Page ${page}`}
                  aria-current={page === result.page ? 'page' : undefined}
                  onClick={() => update('page', String(page))}>{page}</Button>
              </span>
            ))}
            <Button variant="outline" size="sm" disabled={result.page === result.pages} onClick={() => update('page', String(result.page + 1))}>Next</Button>
          </div>
        </nav>
      )}
    </section>
  );
}
