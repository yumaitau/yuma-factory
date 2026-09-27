export type BrowserProject = {
  id: string;
  repoFullName: string;
  description: string | null;
  defaultBranch: string;
  private: boolean;
  createdAt: number;
  counts: Record<string, number>;
};

export const WORK_FILTERS = [
  ['all', 'All projects'],
  ['open', 'With open tickets'],
  ['empty', 'No open tickets'],
  ['intake', 'Intake'],
  ['assigned', 'Assigned'],
  ['in_progress', 'In progress'],
  ['review', 'Review'],
  ['done', 'Done'],
] as const;

export const PROJECT_SORTS = [
  ['name', 'Name: A–Z'],
  ['name-desc', 'Name: Z–A'],
  ['open', 'Most open tickets'],
  ['newest', 'Recently added'],
] as const;

export function browseProjects(projects: BrowserProject[], params: Pick<URLSearchParams, 'get'>) {
  const query = params.get('q') ?? '';
  const visibility = ['public', 'private'].includes(params.get('visibility') ?? '')
    ? params.get('visibility')! : 'all';
  const work = WORK_FILTERS.find(([value]) => value === params.get('work'))?.[0] ?? 'all';
  const sort = PROJECT_SORTS.find(([value]) => value === params.get('sort'))?.[0] ?? 'name';
  const size = Number(params.get('size'));
  const pageSize = [12, 24, 48].includes(size) ? size : 12;
  const requestedPage = Number(params.get('page'));
  const terms = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
  const openCount = (project: BrowserProject) => Object.values(project.counts).reduce((a, b) => a + b, 0);
  const matches = projects.filter((project) => {
    const text = `${project.repoFullName} ${project.description ?? ''}`.toLowerCase();
    if (!terms.every((term) => text.includes(term))) return false;
    if (visibility !== 'all' && project.private !== (visibility === 'private')) return false;
    if (work === 'open') return openCount(project) > 0;
    if (work === 'empty') return openCount(project) === 0;
    return work === 'all' || (project.counts[work] ?? 0) > 0;
  }).sort((a, b) => {
    const byName = a.repoFullName.localeCompare(b.repoFullName, 'en', { numeric: true, sensitivity: 'base' })
      || a.id.localeCompare(b.id);
    if (sort === 'name-desc') return -byName;
    if (sort === 'open') return openCount(b) - openCount(a) || byName;
    if (sort === 'newest') return b.createdAt - a.createdAt || byName;
    return byName;
  });
  const pages = Math.max(1, Math.ceil(matches.length / pageSize));
  const page = Number.isSafeInteger(requestedPage) && requestedPage > 0
    ? Math.min(requestedPage, pages) : 1;
  const start = (page - 1) * pageSize;
  return {
    query, visibility, work, sort, pageSize, page, pages,
    total: matches.length,
    start: matches.length ? start + 1 : 0,
    end: Math.min(start + pageSize, matches.length),
    projects: matches.slice(start, start + pageSize),
  };
}
