import 'server-only';

import { and, asc, eq, sql } from 'drizzle-orm';
import { agents, automation, githubInstallations, projects, tickets } from '@/db/schema';
import { getDb } from '@/lib/db';
import { getGithubApp } from '@/lib/github';
import { newId } from '@/lib/ids';
import { startCodexRun, refreshRuns } from '@/lib/agent/run';
import { AUTOMATION_ID, automationCandidates, claimAutomation, ensureAutomationAgents } from '@/lib/automation-state';
import { availableSlots } from '@/lib/codex/accounts';
import { dispatchAssignments, forEachConcurrent } from '@/lib/concurrency';
import { planLinkForBody, reconcileEpics, resumeStalePlans } from '@/lib/collab-store';
import { LABELS } from '@/lib/brand';
import { approvalHistory, staleApproval } from '@/lib/approval';
import { syncPullRequests } from '@/lib/pull-request-sync';

/** One durable lease covers cron and manual checks. Interrupted checks can resume after expiry. */
export async function runAutomation(scheduledAt?: Date, mode: 'sync' | 'pickup' = 'pickup') {
  const db = await getDb();
  if (scheduledAt) {
    await db.update(automation).set({ lastScheduledAt: scheduledAt })
      .where(eq(automation.id, AUTOMATION_ID));
  }
  const leaseId = crypto.randomUUID();
  const settings = await claimAutomation(db, leaseId);
  if (!settings) {
    const current = await db.select().from(automation).where(eq(automation.id, AUTOMATION_ID)).get();
    return { skipped: true, busy: !!current?.enabled && !!current.leaseUntil && current.leaseUntil.getTime() > Date.now() };
  }
  const deadline = Date.now() + 4 * 60_000;
  const syncDeadline = Date.now() + 90_000;
  let reposSynced = 0;
  let issuesSynced = 0;
  let runsStarted = 0;
  let partial = false;
  let summary = 'Check complete.';
  const errors: string[] = [];
  const held = () => and(eq(automation.id, AUTOMATION_ID), eq(automation.leaseId, leaseId));
  const stillEnabled = async () => !!(await db.select({ id: automation.id }).from(automation)
    .where(and(held(), eq(automation.enabled, true))).get());
  try {
    const pool = await ensureAutomationAgents(db, settings);
    await refreshRuns(settings.userId, 20_000);
    const app = getGithubApp();
    const clients = new Map<number, ReturnType<typeof app.getInstallationOctokit>>();
    const clientFor = async (id: number) => {
      if (!clients.has(id)) clients.set(id, app.getInstallationOctokit(id));
      return clients.get(id)!;
    };
    const boards = await db.select({ project: projects, installation: githubInstallations })
      .from(projects).innerJoin(githubInstallations, eq(projects.installationId, githubInstallations.id))
      .where(eq(projects.status, 'active')).orderBy(asc(projects.issuesSyncedAt), asc(projects.id)).all();

    const refreshBoards = mode === 'sync' ? boards.slice(0, 24) : [];
    await db.update(automation).set({ boardsTotal: refreshBoards.length, updatedAt: new Date(),
      summary: mode === 'sync' ? 'Reconciling up to 24 boards; GitHub pushes new work automatically.' : 'Checking queued tickets and available agents.' }).where(held());
    await forEachConcurrent(refreshBoards, 4, async ({ project, installation }) => {
      if (Date.now() > syncDeadline || !(await stillEnabled())) {
        partial = true;
        return;
      }
      let repoDelta = 0;
      let issueDelta = 0;
      try {
        const client = await clientFor(installation.installationId);
        const [owner, repo] = project.repoFullName.split('/');
        const started = new Date();
        let synced = 0;
        for (let page = 1; ; page++) {
          if (Date.now() > syncDeadline) { partial = true; throw new Error('Time budget reached; this board will resume next check.'); }
          const { data } = await client.request('GET /repos/{owner}/{repo}/issues', {
            owner, repo, per_page: 100, page,
            state: project.issuesSyncedAt ? 'all' : 'open',
            since: project.issuesSyncedAt ? new Date(project.issuesSyncedAt.getTime() - 60_000).toISOString() : undefined,
            request: { signal: AbortSignal.timeout(20_000) },
          });
          const issues = data.filter((issue) => !issue.pull_request);
          if (issues.some((issue) => !Number.isSafeInteger(Number(issue.id)))) {
            throw new Error('GitHub issue ID exceeds supported integer range.');
          }
          // Five rows keep each SQLite statement below D1's bound-parameter limit.
          for (let offset = 0; offset < issues.length; offset += 5) {
            await db.insert(tickets).values(issues.slice(offset, offset + 5).map((issue) => ({
              id: newId('tkt'), projectId: project.id,
              githubIssueId: Number(issue.id), githubIssueNumber: issue.number,
              title: issue.title, body: issue.body ?? null,
              labels: JSON.stringify(issue.labels.map((label) => typeof label === 'string' ? label : label.name).filter(Boolean)),
              githubState: issue.state, htmlUrl: issue.html_url,
              stage: 'intake', createdAt: started, updatedAt: started,
            }))).onConflictDoUpdate({
              target: [tickets.projectId, tickets.githubIssueNumber],
              set: {
                title: sql`excluded.title`, body: sql`excluded.body`, labels: sql`excluded.labels`,
                githubState: sql`excluded.github_state`, htmlUrl: sql`excluded.html_url`, updatedAt: started,
              },
            });
          }
          for (const issue of issues.filter((item) => item.body?.includes('factory-plan-task:'))) {
            const link = await planLinkForBody(db, issue.body, project.id);
            if (link) await db.update(tickets).set(link)
              .where(and(eq(tickets.projectId, project.id), eq(tickets.githubIssueNumber, issue.number), sql`${tickets.planTask} is null`));
          }
          synced += issues.length;
          if (data.length < 100) break;
        }
        await db.update(projects).set({ issuesSyncedAt: started }).where(eq(projects.id, project.id));
        reposSynced++;
        issuesSynced += synced;
        repoDelta = 1;
        issueDelta = synced;
      } catch (error) {
        const status = error && typeof error === 'object' && 'status' in error ? error.status : null;
        errors.push(`${project.repoFullName}: ${status ? `GitHub HTTP ${status}` : 'sync failed; will retry next check'}.`);
      }
      // Atomic increments prevent concurrent board completions overwriting newer progress.
      await db.update(automation).set({
        reposSynced: sql`${automation.reposSynced} + ${repoDelta}`,
        issuesSynced: sql`${automation.issuesSynced} + ${issueDelta}`,
        updatedAt: new Date(), summary: `Refreshing ${refreshBoards.length} boards in parallel.`,
      }).where(held());
    });

    if (await stillEnabled()) {
      if (mode === 'sync') await syncPullRequests(db, clientFor, syncDeadline + 60_000).catch(() => {});
      await resumeStalePlans(db).catch(() => {});
      await reconcileEpics(db).catch(() => {});
      // Refresh agent state after reconciliation; never reuse the pre-check snapshot.
      const idle = await db.select().from(agents).where(and(eq(agents.ownerUserId, settings.userId),
        eq(agents.status, 'idle'), sql`${agents.automationSlot} between 1 and ${settings.targetAgents}`)).all();
      const candidates = await automationCandidates(db, pool.map((agent) => agent.id), settings.label);
      const capacity = await availableSlots(settings.userId, db);
      const dispatchErrors: string[] = [];
      await db.update(automation).set({ reposSynced, issuesSynced, updatedAt: new Date(),
        summary: `Checking up to ${candidates.length} tickets for available agents.` }).where(held());
      await dispatchAssignments(candidates.map((row) => row.ticket), idle, capacity, 4, async (ticket, agent) => {
          if (Date.now() > deadline || !(await stillEnabled())) return false;
          const project = candidates.find((candidate) => candidate.ticket.id === ticket.id)!.project;
          const installation = boards.find((board) => board.project.id === project.id)?.installation;
          if (!installation) return false;
          try {
            await db.update(tickets).set({ dispatchCheckedAt: new Date() }).where(eq(tickets.id, ticket.id));
            // Re-check GitHub immediately before dispatch, including closed or unlabelled tickets.
            const client = await clientFor(installation.installationId);
            const [owner, repo] = project.repoFullName.split('/');
            const { data } = await client.request('GET /repos/{owner}/{repo}/issues/{issue_number}', { owner, repo, issue_number: ticket.githubIssueNumber,
              request: { signal: AbortSignal.timeout(20_000) } });
            const labels = data.labels.map((label) => typeof label === 'string' ? label : label.name).filter(Boolean);
            await db.update(tickets).set({ githubState: data.state, labels: JSON.stringify(labels),
              title: data.title, body: data.body ?? null, updatedAt: new Date() }).where(eq(tickets.id, ticket.id));
            if (data.state !== 'open' || data.pull_request || !labels.some((label) => [settings.label.toLowerCase(), LABELS.plan].includes(label?.toLowerCase() ?? ''))) return false;
            // Fail closed: text changed by anyone but the approver needs a fresh label.
            const stale = staleApproval(await approvalHistory(client.graphql, owner, repo, ticket.githubIssueNumber), [settings.label, LABELS.plan]);
            if (stale) throw new Error(`${project.repoFullName}#${ticket.githubIssueNumber}: ${stale}`);
            await startCodexRun(ticket.id, agent.id, agent.modelId ?? 'codex-default', settings.userId,
              { automationLabel: settings.label, automationLeaseId: leaseId });
            runsStarted++;
            await db.update(automation).set({ runsStarted: sql`${automation.runsStarted} + 1`, updatedAt: new Date() }).where(held()).catch(() => {});
            return true;
          } catch (error) {
            dispatchErrors.push(error instanceof Error ? error.message : 'Could not start the next ticket.');
            return false;
          }
      });
      summary = runsStarted ? `Started ${runsStarted} parallel run${runsStarted === 1 ? '' : 's'}. Remaining tickets wait for free agents and subscriptions.`
        : !candidates.length ? `No unattempted open tickets labelled ${settings.label}.`
        : !idle.length ? 'All worker agents are busy or disabled. Eligible tickets remain queued.'
        : !capacity ? 'Waiting for an enabled, available subscription. Eligible tickets remain queued.'
        : 'Eligible tickets remain queued for the next check.';
      if (dispatchErrors.length) errors.push(...dispatchErrors);
    }
  } catch {
    errors.push('Worker check failed. Check GitHub/runner configuration and Worker logs.');
    summary = 'Check failed; next scheduled check will retry.';
  } finally {
    if (partial) summary = `Partial sync; remaining boards continue next check. ${summary}`;
    await db.update(automation).set({
      leaseId: null, leaseUntil: null, lastFinishedAt: new Date(), updatedAt: new Date(),
      reposSynced, issuesSynced, runsStarted, summary,
      error: errors.length ? errors.slice(0, 8).join('\n') + (errors.length > 8 ? `\n${errors.length - 8} more boards failed.` : '') : null,
    }).where(held());
  }
  return { reposSynced, issuesSynced, runsStarted, errors: errors.length };
}
