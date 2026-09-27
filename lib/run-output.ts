import type { RunResult } from '@/shared/codex';

export type RunOutput = {
  status: string;
  waitingReason?: string | null;
  log: string;
  pullRequestUrl: string | null;
  outputUpdatedAt: string | null;
};

/** Explicit allowlist: account state and subscription metadata stay server-side. */
export function publicRunOutput(result: Pick<RunResult, 'status' | 'log' | 'pullRequestUrl' | 'outputUpdatedAt'> | RunOutput): RunOutput {
  return {
    status: result.status,
    ...('waitingReason' in result && result.waitingReason ? { waitingReason: result.waitingReason } : {}),
    log: result.log.slice(-60000),
    pullRequestUrl: result.pullRequestUrl?.startsWith('https://github.com/') ? result.pullRequestUrl : null,
    outputUpdatedAt: result.outputUpdatedAt ?? null,
  };
}

/** Short-lived SSE connections reauthenticate on reconnect and stop on disconnect. */
export function runOutputStream(initial: RunOutput, read: (signal: AbortSignal) => Promise<RunOutput>, signal: AbortSignal,
  options = { interval: 2000, lifetime: 30_000 }) {
  const abort = new AbortController();
  const encoder = new TextEncoder();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let wake: (() => void) | undefined;
  let cancelled = false;
  const stop = () => { abort.abort(); clearTimeout(timer); wake?.(); };
  signal.addEventListener('abort', stop, { once: true });
  if (signal.aborted) stop();
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: string, data: unknown) => {
        if (!abort.signal.aborted) controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      };
      let last = JSON.stringify(initial);
      try {
        send('snapshot', initial);
        if (initial.status !== 'running' && initial.status !== 'queued') { send('done', {}); return; }
        const until = Date.now() + options.lifetime;
        while (!abort.signal.aborted && Date.now() < until) {
          try {
            const current = await read(abort.signal);
            if (abort.signal.aborted) break;
            const value = JSON.stringify(current);
            if (value !== last) { send('output', current); last = value; }
            else send('heartbeat', {});
            if (current.status !== 'running' && current.status !== 'queued') { send('done', {}); break; }
          } catch {
            send('unavailable', { message: 'Live output temporarily unavailable. Reconnecting automatically.' });
            break;
          }
          await new Promise<void>((resolve) => { wake = resolve; timer = setTimeout(resolve, options.interval); });
        }
      } finally {
        signal.removeEventListener('abort', stop);
        if (!cancelled) controller.close();
        stop();
      }
    },
    cancel() { cancelled = true; stop(); },
  });
}
