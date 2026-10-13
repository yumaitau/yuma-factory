import 'server-only';
import { and, asc, desc, eq, inArray } from 'drizzle-orm';
import { githubInstallations, mergeEvents, projects, reviewAcceptances, runs, tickets, users } from '@/db/schema';
import { newId } from '@/lib/ids';
import { mergeGreenPullRequest } from '@/lib/github-completion';
import { observeHead, runEvidenceGate } from '@/lib/review-evidence-store';
import { acceptDecision, deployControl, historyEntries, mergeDecision, type PullState } from '@/lib/review-actions';
import { parsePullRef } from '@/lib/work-review';
import { LABEL_PREFIX } from '@/lib/brand';
import { isLowRisk, ticketRisk } from '@/shared/ticket-risk';
import type { Db } from '@/lib/queries';
import type { getGithubApp } from '@/lib/github';

type Client = Awaited<ReturnType<ReturnType<typeof getGithubApp>['getInstallationOctokit']>>;
export type MergeEvent = typeof mergeEvents.$inferSelect;
export type MergeBy = { actor: 'user'; userId: string; acceptanceId: string } | { actor: 'factory' };
export type ReviewContext = NonNullable<Awaited<ReturnType<typeof reviewContext>>>;

// A pending claim older than this belongs to a request that died mid-merge; it is released.
const STALE_PENDING_MS = 2 * 60_000;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const parseLabels = (labels: string | null) => { try { const value: unknown = JSON.parse(labels ?? '[]'); return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []; } catch { return []; } };

/** A run's pull request, ticket and project. Null when the run has no pull request in its project's repository. */
export async function reviewContext(db: Db, runId: string, pullRequestUrl?: string) {
  const row = await db.select({ run: runs, ticket: tickets, project: projects, installationId: githubInstallations.installationId })
    .from(runs).innerJoin(tickets, eq(runs.ticketId, tickets.id)).innerJoin(projects, eq(tickets.projectId, projects.id))
    .innerJoin(githubInstallations, eq(projects.installationId, githubInstallations.id)).where(eq(runs.id, runId)).get();
  const url = pullRequestUrl ?? row?.run.pullRequestUrl ?? null;
  const ref = row && parsePullRef(url, row.project.repoFullName);
  if (!row || !ref) return null;
  const [owner, repo] = row.project.repoFullName.split('/');
  return { ...row, owner, repo, pullNumber: ref.number, pullRequestUrl: url! };
}

/** GitHub's current view of the pull request. Every decision is made against this head, never a cached one. */
export async function livePull(client: Client, context: ReviewContext): Promise<PullState> {
  const { data } = await client.request('GET /repos/{owner}/{repo}/pulls/{pull_number}', {
    owner: context.owner, repo: context.repo, pull_number: context.pullNumber, request: { signal: AbortSignal.timeout(15_000) },
  });
  return { open: data.state === 'open', merged: !!data.merged, draft: !!data.draft, headSha: data.head.sha, mergeableState: data.mergeable_state ?? null };
}

export async function activeAcceptance(db: Db, pullRequestUrl: string) {
  return (await db.select().from(reviewAcceptances)
    .where(and(eq(reviewAcceptances.pullRequestUrl, pullRequestUrl), eq(reviewAcceptances.status, 'active'))).get()) ?? null;
}

/**
 * One GitHub merge per pull request. The pending row is a D1 conditional insert guarded by a partial
 * unique index; a concurrent attempt finds it, waits for that merge, and returns the same recorded result.
 */
export async function mergeOnce(db: Db, client: Client, context: ReviewContext, sha: string, by: MergeBy,
  options: { wait?: (ms: number) => Promise<unknown>; timeoutMs?: number } = {}): Promise<{ event: MergeEvent; joined: boolean }> {
  const { wait = sleep, timeoutMs = 25_000 } = options;
  const url = context.pullRequestUrl;
  const claim = () => db.insert(mergeEvents).values({ id: newId('mrg'), runId: context.run.id, ticketId: context.ticket.id, pullRequestUrl: url,
    headSha: sha, actor: by.actor, userId: by.actor === 'user' ? by.userId : null, acceptanceId: by.actor === 'user' ? by.acceptanceId : null,
    status: 'pending', createdAt: new Date() }).onConflictDoNothing().returning();
  let event: MergeEvent | undefined;
  for (let attempt = 0; !event && attempt < 3; attempt++) {
    [event] = await claim();
    if (event) break;
    let open = await db.select().from(mergeEvents).where(and(eq(mergeEvents.pullRequestUrl, url), inArray(mergeEvents.status, ['pending', 'merged']))).get();
    if (!open) continue;
    if (open.status === 'pending' && open.createdAt.getTime() < Date.now() - STALE_PENDING_MS) {
      await db.update(mergeEvents).set({ status: 'abandoned', finishedAt: new Date(), message: 'The merge request did not finish.' })
        .where(and(eq(mergeEvents.id, open.id), eq(mergeEvents.status, 'pending')));
      continue;
    }
    // Join the merge already under way and report its result.
    const until = Date.now() + timeoutMs;
    while (open.status === 'pending' && Date.now() < until) {
      await wait(250);
      open = (await db.select().from(mergeEvents).where(eq(mergeEvents.id, open.id)).get()) ?? open;
    }
    return { event: open, joined: true };
  }
  if (!event) throw new Error('Could not start the merge. Try again.');
  let status: string, mergeSha: string | null = null, message: string | null = null;
  try {
    const result = await mergeGreenPullRequest(client, context.owner, context.repo, context.pullNumber, sha);
    status = result.result === 'merge' ? 'merged' : result.result;
    mergeSha = result.sha;
    if (result.result === 'blocked') message = 'GitHub refused the merge. Repository rules or merge settings block it.';
  } catch (error) {
    const text = error instanceof Error ? error.message : 'unknown error';
    status = /head changed|closed before merge/i.test(text) ? 'refused' : 'failed';
    message = status === 'refused' ? text.replace(' Ticket left open.', '') : `Merge failed: ${text}`;
  }
  const [done] = await db.update(mergeEvents).set({ status, mergeSha, message, finishedAt: new Date() }).where(eq(mergeEvents.id, event.id)).returning();
  return { event: done ?? { ...event, status, mergeSha, message }, joined: false };
}

/** Accept review: records the user, the head SHA they reviewed and the time. It never calls the merge API. */
export async function acceptReview(db: Db, client: Client, context: ReviewContext, userId: string, reviewedSha: string) {
  const pull = await livePull(client, context);
  await observeHead(db, context.run.id, pull.headSha);
  const decision = acceptDecision(pull, reviewedSha, await activeAcceptance(db, context.pullRequestUrl), userId);
  if (!decision.allowed) throw new Error(decision.reason);
  const now = new Date();
  // One active acceptance per PR: replacing it and recording the new one is one transaction.
  const [, inserted] = await db.batch([
    db.update(reviewAcceptances).set({ status: 'superseded', supersededAt: now })
      .where(and(eq(reviewAcceptances.pullRequestUrl, context.pullRequestUrl), eq(reviewAcceptances.status, 'active'))),
    db.insert(reviewAcceptances).values({ id: newId('acc'), runId: context.run.id, ticketId: context.ticket.id,
      pullRequestUrl: context.pullRequestUrl, headSha: pull.headSha, userId, createdAt: now }).returning(),
  ]);
  return inserted[0];
}

/** Merge: only an accepted current head, with repository rules and risk policy allowing this user. */
export async function mergeReview(db: Db, client: Client, context: ReviewContext, userId: string, options?: Parameters<typeof mergeOnce>[5]) {
  const pull = await livePull(client, context);
  await observeHead(db, context.run.id, pull.headSha);
  const acceptance = await activeAcceptance(db, context.pullRequestUrl);
  const decision = mergeDecision(pull, acceptance, ticketRisk(parseLabels(context.ticket.labels), LABEL_PREFIX), userId);
  if (!decision.allowed || !acceptance) {
    // A merge someone else finished is a shared result, not an error.
    const merged = pull.merged && await db.select().from(mergeEvents)
      .where(and(eq(mergeEvents.pullRequestUrl, context.pullRequestUrl), eq(mergeEvents.status, 'merged'))).get();
    if (merged) return { event: merged, joined: true };
    throw new Error(decision.reason);
  }
  return mergeOnce(db, client, context, pull.headSha, { actor: 'user', userId, acceptanceId: acceptance.id }, options);
}

/**
 * Factory's low-risk policy merges the CI-confirmed SHA through the same serialised path. The issue's
 * labels are read live; a head that moved off `sha` is refused. Recorded as Factory, never as an acceptance.
 */
export async function factoryMerge(db: Db, client: Client, context: ReviewContext, sha: string, options?: Parameters<typeof mergeOnce>[5]) {
  const { data: issue } = await client.request('GET /repos/{owner}/{repo}/issues/{issue_number}', {
    owner: context.owner, repo: context.repo, issue_number: context.ticket.githubIssueNumber, request: { signal: AbortSignal.timeout(15_000) },
  });
  const labels = issue.labels.map((label) => typeof label === 'string' ? label : label.name ?? '');
  if (!isLowRisk(labels, LABEL_PREFIX)) throw new Error('Only low-risk tickets merge automatically. PR left open for review.');
  return mergeOnce(db, client, context, sha, { actor: 'factory' }, options);
}

/** Accepting, merging and deploying for one run's pull request, each with its own check, plus the task history. */
export async function reviewState(db: Db, client: Client, context: ReviewContext, userId: string) {
  const pull = await livePull(client, context);
  await observeHead(db, context.run.id, pull.headSha);
  const [acceptance, acceptances, merges, evidence] = await Promise.all([
    activeAcceptance(db, context.pullRequestUrl),
    db.select().from(reviewAcceptances).where(eq(reviewAcceptances.ticketId, context.ticket.id)).orderBy(asc(reviewAcceptances.createdAt)).limit(50).all(),
    db.select().from(mergeEvents).where(eq(mergeEvents.ticketId, context.ticket.id)).orderBy(desc(mergeEvents.createdAt)).limit(50).all(),
    runEvidenceGate(db, context.run.id, pull.headSha),
  ]);
  const ids = [...new Set([...acceptances.map((row) => row.userId), ...merges.flatMap((row) => row.userId ? [row.userId] : [])])];
  const names = new Map((ids.length ? await db.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, ids)).all() : [])
    .map((user) => [user.id, user.name]));
  const name = (id: string | null) => !id ? 'Someone' : id === userId ? 'You' : names.get(id) ?? 'A team member';
  const iso = (date: Date) => date.toISOString();
  return {
    runId: context.run.id, pullRequestUrl: context.pullRequestUrl, headSha: pull.headSha, open: pull.open, merged: pull.merged, evidence,
    acceptance: acceptance && { headSha: acceptance.headSha, by: name(acceptance.userId), at: iso(acceptance.createdAt) },
    accept: acceptDecision(pull, pull.headSha, acceptance, userId),
    merge: mergeDecision(pull, acceptance, ticketRisk(parseLabels(context.ticket.labels), LABEL_PREFIX), userId),
    deploy: deployControl(context.project.deploymentTarget, pull.merged),
    history: historyEntries(acceptances.map((row) => ({ ...row, createdAt: iso(row.createdAt) })),
      merges.map((row) => ({ ...row, createdAt: iso(row.createdAt) })), name),
  };
}
export type ReviewState = Awaited<ReturnType<typeof reviewState>>;
