'use client';
import { useCallback, useEffect, useState } from 'react';
import { acceptReviewAction, mergeReviewAction } from '@/app/actions/review';
import type { ReviewState } from '@/lib/review-merge';
import { formatSydneyDateTime } from '@/lib/datetime';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

const TONE = { done: 'text-status-done', attention: 'text-status-attention', review: 'text-status-review', muted: 'text-muted-foreground' };

async function fetchReview(runId: string, signal?: AbortSignal) {
  const response = await fetch(`/api/runs/${runId}/review`, { cache: 'no-store', signal });
  if (!response.ok) throw new Error(((await response.json().catch(() => ({}))) as { error?: string }).error ?? 'Could not load review actions.');
  return await response.json() as ReviewState;
}

/** Accept, Merge and Deploy are three controls with three separate checks. None of them implies the next. */
export function ReviewActions({ runId, onChange }: { runId: string; onChange?: () => void }) {
  const [state, setState] = useState<ReviewState | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [pending, setPending] = useState<'accept' | 'merge' | null>(null);
  const load = useCallback((signal?: AbortSignal) => fetchReview(runId, signal).then((next) => { setState(next); setError(''); },
    (cause) => { if (!signal?.aborted) setError(cause instanceof Error ? cause.message : 'Could not load review actions.'); }), [runId]);
  useEffect(() => { const controller = new AbortController(); void load(controller.signal); return () => controller.abort(); }, [load]);
  async function act(kind: 'accept' | 'merge') {
    if (!state || pending) return;
    setPending(kind); setError(''); setNotice('');
    try {
      const result = kind === 'accept' ? await acceptReviewAction(runId, state.headSha) : await mergeReviewAction(runId);
      if ('error' in result) setError(result.error ?? 'Try again.'); else setNotice(result.message);
      await load(); onChange?.();
    } catch { setError('Could not reach Factory. Try again.'); } finally { setPending(null); }
  }
  if (!state) return error ? <p role="alert" className="text-xs text-status-attention">{error}</p> : <p role="status" className="text-xs text-muted-foreground">Checking the pull request…</p>;
  return <div className="space-y-3">
    <p className="text-xs text-muted-foreground">Head <code className="font-mono">{state.headSha.slice(0, 7)}</code>
      {state.acceptance ? <> · Accepted by {state.acceptance.by} at <code className="font-mono">{state.acceptance.headSha.slice(0, 7)}</code>, {formatSydneyDateTime(state.acceptance.at)}</> : ' · Not accepted'}</p>
    <div className="grid gap-2">
      <Control label="Accept review" busy={pending === 'accept'} busyLabel="Accepting…" decision={state.accept} onClick={() => void act('accept')} />
      <Control label="Merge" busy={pending === 'merge'} busyLabel="Merging…" decision={state.merge} onClick={() => void act('merge')} />
      {state.deploy && <Control label="Deploy" decision={{ allowed: true, reason: 'Opens the deployment target. Merging did not deploy.' }} onClick={() => {
        if (window.confirm(`Deploy ${state.headSha.slice(0, 7)}? This opens ${state.deploy!.target}. Merging did not deploy it.`)) window.open(state.deploy!.target, '_blank', 'noopener,noreferrer');
      }} />}
    </div>
    {notice && <p role="status" className="text-xs text-status-done">{notice}</p>}
    {error && <p role="alert" className="text-xs text-status-attention">{error}</p>}
    {!!state.history.length && <ol aria-label="Review history" className="space-y-1 border-t border-border pt-2">
      {state.history.map((entry, index) => <li key={index} className={cn('text-xs', TONE[entry.tone])}>
        <span className="text-muted-foreground">{formatSydneyDateTime(entry.at)}</span> · {entry.text}</li>)}
    </ol>}
  </div>;
}

function Control({ label, busyLabel, busy, decision, onClick }: { label: string; busyLabel?: string; busy?: boolean; decision: { allowed: boolean; reason: string }; onClick: () => void }) {
  return <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
    <Button type="button" size="sm" variant={decision.allowed ? 'default' : 'outline'} className="h-7 rounded px-3 text-xs" disabled={!decision.allowed || busy} onClick={onClick}>
      {busy ? busyLabel : label}</Button>
    <span className="min-w-0 flex-1 basis-40 text-xs text-muted-foreground">{decision.reason}</span>
  </div>;
}
