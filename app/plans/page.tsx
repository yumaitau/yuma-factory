import { connection } from 'next/server';
import { Suspense } from 'react';

import { decidePlanAction, postTeamMessageAction } from '@/app/actions/memory';
import { AppShell } from '@/components/factory/app-shell';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { LABELS } from '@/lib/brand';
import { threadMessages, listPlans } from '@/lib/collab-store';
import { formatSydneyDateTime } from '@/lib/datetime';
import { getDb } from '@/lib/db';
import { fileConflicts, planTaskId } from '@/lib/plan';
import { requireSession } from '@/lib/session';

export const metadata = { title: 'Plans' };

export default function PlansPage() {
  return (
    <Suspense fallback={<p className="p-6 text-sm text-muted-foreground">Loading plans…</p>}>
      <Plans />
    </Suspense>
  );
}

async function Plans() {
  await connection();
  const session = await requireSession();
  const db = await getDb();
  const plans = await listPlans(db);
  // One thread per epic, shown on its latest plan.
  const latest = plans.filter((plan, index) => plans.findIndex((other) => other.epic.id === plan.epic.id) === index);
  const threads = new Map(await Promise.all(latest.map(async (plan) => [plan.epic.id, await threadMessages(db, plan.epic.id, 30)] as const)));

  return (
    <AppShell email={session.user.email}>
      <div className="mb-6">
        <h1 className="text-2xl font-semibold">Plans</h1>
        <p className="text-sm text-muted-foreground">
          Label a GitHub issue <code>{LABELS.plan}</code> and a planner agent breaks it into subtasks.
          Approved plans become GitHub sub-issues labelled <code>{LABELS.ready}</code>. Each subtask starts once the tickets it builds on are closed.
          Agents hand off notes through the epic thread, and each subtask run reads it along with the epic&apos;s goal.
        </p>
      </div>
      {latest.length === 0 ? (
        <p className="text-sm text-muted-foreground">No plans yet.</p>
      ) : (
        <div className="flex flex-col gap-4">
          {latest.map((plan) => {
            const conflicts = fileConflicts(plan.tasks);
            const thread = threads.get(plan.epic.id) ?? [];
            return (
              <Card key={plan.id} className="p-4">
                <div className="mb-2 flex flex-wrap items-center gap-2">
                  <a href={plan.epic.htmlUrl} className="font-semibold hover:underline" target="_blank" rel="noreferrer">
                    {plan.epic.repo}#{plan.epic.number} {plan.epic.title}
                  </a>
                  <span className="rounded-full bg-muted px-2 py-0.5 text-xs font-medium">{plan.status}</span>
                  <span className="text-xs text-muted-foreground">{formatSydneyDateTime(plan.createdAt)}</span>
                </div>
                <p className="mb-3 whitespace-pre-wrap text-sm">{plan.summary}</p>
                {plan.error ? <p className="mb-3 text-sm text-red-600">{plan.error}</p> : null}
                <ol className="mb-3 flex list-decimal flex-col gap-1 pl-5 text-sm">
                  {plan.tasks.map((task) => {
                    const subtask = plan.subtasks.find((item) => item.planTask === planTaskId(plan.id, task.key));
                    return (
                      <li key={task.key}>
                        <span className="font-medium">{task.title}</span>
                        {task.dependsOn.length ? <span className="text-muted-foreground"> after {task.dependsOn.join(', ')}</span> : null}
                        {subtask ? (
                          <a href={subtask.htmlUrl} className="ml-2 text-xs underline" target="_blank" rel="noreferrer">
                            #{subtask.number} {subtask.state === 'closed' ? 'closed' : subtask.stage}
                          </a>
                        ) : null}
                        {task.body ? (
                          <details className="text-xs text-muted-foreground"><summary className="cursor-pointer">Details</summary>
                            <p className="whitespace-pre-wrap">{task.body}</p>
                            {task.files.length ? <p>Files: {task.files.join(', ')}</p> : null}
                          </details>
                        ) : null}
                      </li>
                    );
                  })}
                </ol>
                {conflicts.length ? (
                  <p className="mb-3 text-sm text-amber-700">
                    Parallel tasks touch the same files: {conflicts.map((item) => `${item.a} and ${item.b} (${item.files.join(', ')})`).join('; ')}.
                    Expect merge conflicts; reject and re-plan if they matter.
                  </p>
                ) : null}
                {plan.actionable ? (
                  <form action={decidePlanAction} className="mb-3 flex gap-2">
                    <input type="hidden" name="planId" value={plan.id} />
                    <Button type="submit" name="decision" value="approve" size="sm">
                      {plan.status === 'proposed' ? 'Approve and create subtasks' : 'Retry'}
                    </Button>
                    {plan.status !== 'applying' ? <Button type="submit" name="decision" value="reject" variant="outline" size="sm">Reject</Button> : null}
                  </form>
                ) : null}
                <details className="text-sm">
                  <summary className="cursor-pointer text-muted-foreground">Epic thread ({thread.length})</summary>
                  <ul className="mt-2 flex flex-col gap-2">
                    {thread.map((message) => (
                      <li key={message.id} className="rounded-md bg-muted p-2">
                        <p className="text-xs text-muted-foreground">{message.kind} · {formatSydneyDateTime(message.createdAt)}</p>
                        <p className="whitespace-pre-wrap">{message.body}</p>
                      </li>
                    ))}
                  </ul>
                  <form action={postTeamMessageAction} className="mt-2 flex flex-col gap-2">
                    <input type="hidden" name="ticketId" value={plan.epic.id} />
                    <textarea name="body" rows={2} required maxLength={8000} aria-label="Guidance for agents"
                      className="rounded-md border border-border bg-background px-3 py-2 text-sm"
                      placeholder="Guidance for agents on this epic. They read it at their next run." />
                    <div><Button type="submit" variant="outline" size="sm">Post to thread</Button></div>
                  </form>
                </details>
              </Card>
            );
          })}
        </div>
      )}
    </AppShell>
  );
}
