'use client';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { formatSydneyDateTime } from '@/lib/datetime';
import type { CompletedWork, ReviewQueue } from '@/lib/work-review';

export function WorkReview({ completed }: { completed: CompletedWork[] }) {
  const [queue, setQueue] = useState<ReviewQueue | null>(null);
  const [error, setError] = useState('');
  const [refresh, setRefresh] = useState(0);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const check = async () => {
      if (document.visibilityState === 'hidden') { timer = setTimeout(check, 60_000); return; }
      setLoading(true);
      try {
        const response = await fetch('/api/work/review', { cache: 'no-store', signal: controller.signal });
        if (!response.ok) throw new Error('GitHub review queue unavailable. Try again.');
        const result: ReviewQueue = await response.json();
        if (controller.signal.aborted) return;
        setQueue(result); setError('');
      } catch {
        if (!controller.signal.aborted) setError('Could not refresh PRs. Displayed results may be out of date.');
      } finally {
        if (!controller.signal.aborted) { setLoading(false); timer = setTimeout(check, 60_000); }
      }
    };
    void check();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [refresh]);
  return <div className="mb-8 grid min-w-0 gap-8 xl:grid-cols-2">
    <section aria-labelledby="review-heading" className="min-w-0">
      <div className="flex items-center justify-between gap-3 border-b pb-3">
        <h2 id="review-heading" className="text-lg font-semibold">PRs to review{queue ? ` (${queue.pulls.length})` : ''}</h2>
        <button className="rounded-md border px-3 py-1.5 text-xs hover:bg-muted disabled:opacity-50" disabled={loading} onClick={() => setRefresh((n) => n + 1)}>{loading ? 'Checking GitHub…' : 'Refresh PRs'}</button>
      </div>
      <p className="my-3 text-xs text-muted-foreground">Open PRs created by Factory, including completed tickets. Low-risk tickets merge automatically after green CI. Other merging stays with you.</p>
      {error && <p role="alert" className="mb-3 text-sm text-primary">{error}</p>}
      {!!queue?.unavailableRepos.length && <p role="alert" className="mb-3 text-sm">GitHub status unavailable for {queue.unavailableRepos.join(', ')}. Queue may be incomplete.</p>}
      {!queue && loading && <p role="status" className="py-4 text-sm text-muted-foreground">Loading pull requests…</p>}
      {queue && !queue.pulls.length && !queue.unavailableRepos.length && <p className="py-4 text-sm text-muted-foreground">No open Factory PRs waiting for review.</p>}
      <ul className="max-h-80 divide-y overflow-y-auto">{queue?.pulls.map((pr) => <li key={pr.url} className="flex flex-wrap items-start justify-between gap-3 py-3">
        <div className="min-w-0 flex-1 basis-48">
          <p className="break-all text-xs text-muted-foreground">{pr.repo} #{pr.number}</p>
          <a className="mt-1 block wrap-anywhere text-sm font-medium hover:underline" href={pr.url} target="_blank" rel="noreferrer">{pr.title}</a>
          <p className="mt-1 text-xs text-muted-foreground">{pr.draft ? 'Draft' : pr.running ? 'Codex still working' : 'Ready for your review'} · Updated {formatSydneyDateTime(pr.updatedAt)}</p>
        </div>
        <div className="flex gap-3 text-xs"><Link className="underline" href={`/work/runs/${pr.runId}`}>Run output</Link><a className="font-medium text-primary underline" href={pr.url} target="_blank" rel="noreferrer">Review PR</a></div>
      </li>)}</ul>
      {queue && <p className="mt-3 text-xs text-muted-foreground">Checked {formatSydneyDateTime(queue.checkedAt)} · Refreshes every minute</p>}
    </section>
    <section aria-labelledby="completed-heading" className="min-w-0">
      <h2 id="completed-heading" className="border-b pb-3 text-lg font-semibold">Recently completed</h2>
      <p className="my-3 text-xs text-muted-foreground">Latest 20 successful runs, newest first. A completed run may still have an open PR.</p>
      {!completed.length && <p className="py-4 text-sm text-muted-foreground">Completed work will appear here when a run succeeds.</p>}
      <ul className="max-h-80 divide-y overflow-y-auto">{completed.map((run) => <li key={run.runId} className="flex flex-wrap items-start justify-between gap-3 py-3">
        <div className="min-w-0 flex-1 basis-48"><p className="break-all text-xs text-muted-foreground">{run.repo} #{run.issueNumber}</p>
          <Link className="mt-1 block wrap-anywhere text-sm font-medium hover:underline" href={`/work/runs/${run.runId}`}>{run.title}</Link>
          <p className="mt-1 text-xs text-muted-foreground">Completed {formatSydneyDateTime(run.finishedAt)}</p>
        </div>
        <div className="flex gap-3 text-xs"><Link className="underline" href={`/work/runs/${run.runId}`}>View output</Link>{run.pullRequestUrl && <a className="underline" href={run.pullRequestUrl} target="_blank" rel="noreferrer">View PR</a>}</div>
      </li>)}</ul>
    </section>
  </div>;
}
