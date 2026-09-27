import { test } from 'node:test';
import assert from 'node:assert/strict';
import { browseProjects, type BrowserProject } from '../lib/project-browser';

const projects: BrowserProject[] = Array.from({ length: 30 }, (_, index): BrowserProject => ({
  id: String(index),
  repoFullName: `acme/project-${index + 1}`,
  description: index % 2 === 0 ? 'Wildlife monitoring' : null,
  defaultBranch: 'main',
  private: index % 2 === 0,
  createdAt: index,
  counts: index % 3 === 0 ? { review: index + 1 } : {},
}));

test('search combines name and description terms with visibility and open-ticket stage', () => {
  const result = browseProjects(projects, new URLSearchParams('q=ACME wildlife&visibility=private&work=review'));
  assert.deepEqual(result.projects.map((project) => project.id), ['0', '6', '12', '18', '24']);
  assert.equal(result.total, 5);
  assert.equal(browseProjects(projects, new URLSearchParams('work=empty')).total, 20);
  assert.equal(browseProjects(projects, new URLSearchParams('visibility=public&work=open')).total, 5);
});

test('pagination applies after filtering and deterministic natural sorting', () => {
  const result = browseProjects([...projects].reverse(), new URLSearchParams('page=2'));
  assert.equal(result.total, 30);
  assert.equal(result.pages, 3);
  assert.equal(result.start, 13);
  assert.equal(result.end, 24);
  assert.equal(result.projects[0].repoFullName, 'acme/project-13');
  const last = browseProjects(projects, new URLSearchParams('page=99'));
  assert.equal(last.page, 3);
  assert.equal(last.projects.length, 6);
  assert.equal(projects[0].id, '0');
});

test('sorts by descending name, open ticket count and date with name tie-breaks', () => {
  assert.equal(browseProjects(projects, new URLSearchParams('sort=name-desc')).projects[0].id, '29');
  assert.equal(browseProjects(projects, new URLSearchParams('sort=newest')).projects[0].id, '29');
  assert.equal(browseProjects(projects, new URLSearchParams('sort=open')).projects[0].id, '27');
  const tied = projects.map((project) => ({ ...project, createdAt: 1 }));
  assert.equal(browseProjects(tied.reverse(), new URLSearchParams('sort=newest')).projects[0].id, '0');
});

test('empty results and malformed URL values give safe page bounds', () => {
  const empty = browseProjects(projects, new URLSearchParams('q=not-found&page=99'));
  assert.equal(empty.total, 0);
  assert.equal(empty.start, 0);
  assert.equal(empty.end, 0);
  assert.equal(empty.page, 1);
  for (const page of ['-1', 'NaN', 'Infinity', '1.5', '9007199254740993']) {
    const result = browseProjects(projects, new URLSearchParams(`page=${page}&size=999&sort=invalid&work=invalid&visibility=invalid`));
    assert.equal(result.page, 1);
    assert.equal(result.pageSize, 12);
    assert.equal(result.total, 30);
  }
  assert.equal(browseProjects(projects, new URLSearchParams('size=24')).projects.length, 24);
  assert.equal(browseProjects(projects, new URLSearchParams('size=48')).projects.length, 30);
});
