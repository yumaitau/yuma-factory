import Link from 'next/link';
import { deliveryState, executionState, workLane, workReason, type WorkCard } from '@/lib/work-board';

const tiles = [
  { id: 'attention', title: 'Needs attention', empty: 'Nothing is waiting on you.' },
  { id: 'review', title: 'Ready for review', empty: 'No finished run is waiting for review.' },
  { id: 'active', title: 'In progress', empty: 'No run is executing or waiting.' },
] as const;

export function DecisionSummary({ cards }: { cards: WorkCard[] }) {
  const groups = {
    attention: cards.filter((card) => workLane(card) === 'attention'),
    review: cards.filter((card) => workLane(card) === 'review'),
    active: cards.filter((card) => { const lane = workLane(card); return lane === 'running' || lane === 'waiting'; }),
  };
  return <section aria-label="What needs a decision" className="mb-6 grid gap-3 sm:grid-cols-3">
    {tiles.map((tile) => {
      const first = groups[tile.id][0];
      return <Link key={tile.id} href="/work" className="rounded-lg border border-border bg-card p-4 hover:bg-muted/40">
        <p className="text-xs font-medium text-muted-foreground">{tile.title}</p>
        <p className="mt-1 text-2xl font-semibold tabular-nums">{groups[tile.id].length}</p>
        <p className="mt-2 text-sm">{first ? first.title : tile.empty}</p>
        {first && <p className="mt-1 text-xs text-muted-foreground">{workReason(first)}</p>}
        {first && <p className="mt-1 text-xs text-muted-foreground">{executionState(first).label} · {deliveryState(first).label}</p>}
      </Link>;
    })}
  </section>;
}
