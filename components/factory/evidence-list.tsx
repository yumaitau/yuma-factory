import { formatSydneyDateTime } from '@/lib/datetime';
import { shortSha, type Evidence, type EvidenceGate, type EvidenceResult } from '@/lib/review-evidence';
import { cn } from '@/lib/utils';

const RESULT_TONE: Record<EvidenceResult, string> = {
  passed: 'text-status-done', failed: 'text-status-attention', skipped: 'text-muted-foreground', unknown: 'text-status-running',
};
const RESULT_LABEL: Record<EvidenceResult, string> = { passed: 'Passed', failed: 'Failed', skipped: 'Skipped', unknown: 'Pending' };
const GATE_TONE = { no_ci: 'text-muted-foreground', ready: 'text-status-done', pending: 'text-status-running', unchecked: 'text-muted-foreground', failed: 'text-status-attention', missing: 'text-status-attention' };

function Row({ record, stale }: { record: Evidence; stale?: boolean }) {
  const at = record.finishedAt ?? record.startedAt;
  const name = record.url?.startsWith('https://') ? <a href={record.url} target="_blank" rel="noreferrer" className="hover:underline">{record.name}</a> : record.name;
  return <li className={cn('flex flex-wrap items-baseline gap-x-2 text-xs', stale && 'text-muted-foreground')}>
    <span className={cn('font-medium', stale ? 'text-muted-foreground' : RESULT_TONE[record.result])}>{stale ? 'Stale' : RESULT_LABEL[record.result]}</span>
    <span className="min-w-0 wrap-anywhere">{name}</span>
    <code className="font-mono text-[11px]">{shortSha(record.sourceSha)}</code>
    {at && <span className="text-muted-foreground">{formatSydneyDateTime(at)}</span>}
    {stale && <span>{RESULT_LABEL[record.result].toLowerCase()} on an older commit</span>}
  </li>;
}

/** Checks on the PR's current head, then older records labelled stale. Stale records never count toward review. */
export function EvidenceList({ gate, limit = 8 }: { gate: EvidenceGate; limit?: number }) {
  return <div className="space-y-1.5">
    <p className={cn('text-xs', GATE_TONE[gate.state])}>{gate.reason}</p>
    {!!gate.current.length && <ul aria-label="Evidence on the current head" className="space-y-1">{gate.current.slice(0, limit).map((record) =>
      <Row key={`${record.kind}:${record.name}`} record={record} />)}</ul>}
    {!!gate.stale.length && <ul aria-label="Stale evidence" className="space-y-1">{gate.stale.slice(0, limit).map((record) =>
      <Row key={`${record.sourceSha}:${record.kind}:${record.name}`} record={record} stale />)}</ul>}
  </div>;
}
