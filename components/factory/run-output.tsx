'use client';
import { useEffect, useRef, useState } from 'react';
import type { RunOutput } from '@/lib/run-output';
import { formatSydneyDateTime } from '@/lib/datetime';

export function RunOutputView({ runId, initial }: { runId: string; initial: RunOutput }) {
  const [output, setOutput] = useState(initial);
  const [connection, setConnection] = useState('Connecting…');
  const [follow, setFollow] = useState(true);
  const [retry, setRetry] = useState(0);
  const viewport = useRef<HTMLPreElement>(null);
  useEffect(() => {
    const events = new EventSource(`/api/runs/${runId}/output`);
    events.addEventListener('snapshot', (event) => {
      try {
        const value: RunOutput = JSON.parse((event as MessageEvent).data);
        // Reconnect starts with a DB snapshot, which can lag the live runner.
        if (typeof value.log !== 'string') return;
        setOutput((previous) => !previous.log || !['running', 'queued'].includes(value.status) ? value : previous);
      } catch { /* Retain the last readable output. */ }
    });
    events.addEventListener('output', (event) => {
      try {
        const value: RunOutput = JSON.parse((event as MessageEvent).data);
        if (typeof value.log !== 'string' || typeof value.status !== 'string') return;
        setOutput(value); setConnection('Connected');
      } catch { setConnection('Could not read output. Reconnecting…'); }
    });
    events.addEventListener('heartbeat', () => setConnection('Connected'));
    events.addEventListener('unavailable', () => setConnection('Output temporarily unavailable. Reconnecting…'));
    events.addEventListener('done', () => { setConnection('Run finished'); events.close(); });
    events.onerror = () => setConnection('Reconnecting…');
    return () => events.close();
  }, [runId, retry]);
  useEffect(() => {
    if (follow && viewport.current) viewport.current.scrollTop = viewport.current.scrollHeight;
  }, [output.log, follow]);
  const running = output.status === 'running' || output.status === 'queued';
  return <section aria-label="Codex run output" className="min-w-0">
    <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
      <div className="text-sm"><span className="font-semibold capitalize">{output.waitingReason ? 'Waiting' : output.status}</span><span className="ml-3 text-muted-foreground" role="status">{connection}</span>
        {output.outputUpdatedAt && <p className="mt-1 text-xs text-muted-foreground">Last output {formatSydneyDateTime(output.outputUpdatedAt)}</p>}</div>
      <div className="flex flex-wrap items-center gap-4 text-sm">
        {output.pullRequestUrl && <a className="text-primary underline" href={output.pullRequestUrl} target="_blank" rel="noreferrer">Open PR</a>}
        <label className="flex items-center gap-2"><input type="checkbox" checked={follow} onChange={(event) => setFollow(event.target.checked)} /> Follow output</label>
        <button className="rounded-md border px-3 py-1.5 hover:bg-muted" onClick={() => { setConnection('Connecting…'); setRetry((n) => n + 1); }}>Reconnect</button>
      </div>
    </div>
    {output.waitingReason && <p className="mb-4 text-sm" role="status">{output.waitingReason}</p>}
    <pre ref={viewport} tabIndex={0} aria-label="Execution log" className="h-[60vh] min-h-72 overflow-auto whitespace-pre-wrap wrap-anywhere rounded-lg border bg-muted/40 p-4 font-mono text-xs leading-6 focus-visible:outline-2 focus-visible:outline-ring"
      onScroll={() => { const el = viewport.current; if (el && el.scrollHeight - el.scrollTop - el.clientHeight > 60) setFollow(false); }}>
      {output.log || (running ? 'Waiting for the first Codex event…' : 'No output was recorded for this run.')}
    </pre>
    <p className="mt-3 max-w-prose text-xs text-muted-foreground">Commands, command results, file changes and Codex messages appear as execution events arrive. Showing the latest 60,000 characters. Closing this page leaves the run working.</p>
  </section>;
}
