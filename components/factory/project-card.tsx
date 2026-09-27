'use client';

import Link from 'next/link';
import { useState, useTransition } from 'react';

import { syncTicketsAction } from '@/app/actions/factory';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';

const STAGE_LABELS: Record<string, string> = {
  intake: 'Intake',
  assigned: 'Assigned',
  in_progress: 'In progress',
  review: 'Review',
  done: 'Done',
};

export function ProjectCard({
  project,
  counts,
}: {
  project: { id: string; repoFullName: string; description: string | null; defaultBranch: string };
  counts: Record<string, number>;
}) {
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<string | null>(null);
  const total = Object.values(counts).reduce((a, b) => a + b, 0);

  return (
    <Card className="flex min-w-0 flex-col gap-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <Link href={`/projects/${project.id}`} className="block wrap-anywhere font-semibold hover:underline">
            {project.repoFullName}
          </Link>
          <p className="mt-1 line-clamp-2 wrap-anywhere text-sm text-muted-foreground">
            {project.description || 'No description'}
          </p>
        </div>
        <span className="shrink-0 rounded-full bg-muted px-2.5 py-1 text-xs font-medium">
          {total} open
        </span>
      </div>

      <div className="flex flex-wrap gap-2">
        {Object.entries(STAGE_LABELS).map(([stage, label]) => (
          <span key={stage} className="rounded-md bg-muted px-2 py-1 text-xs text-muted-foreground">
            {label}: <strong className="text-foreground">{counts[stage] ?? 0}</strong>
          </span>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          variant="outline"
          disabled={pending}
          onClick={() =>
            startTransition(async () => {
              setMessage(null);
              try {
                const res = await syncTicketsAction(project.id);
                setMessage(`Synced ${res.synced} issues`);
              } catch (e) {
                setMessage(e instanceof Error ? e.message : 'Sync failed');
              }
            })
          }
        >
          {pending ? 'Syncing…' : 'Sync issues'}
        </Button>
        <Link href={`/projects/${project.id}`} className="text-sm text-muted-foreground hover:underline">
          Open board →
        </Link>
        {message ? <span className="w-full wrap-anywhere text-xs text-muted-foreground">{message}</span> : null}
      </div>
    </Card>
  );
}
