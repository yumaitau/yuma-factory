import "server-only";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { accountLeases, agents, codexAccounts, runs, tickets } from "@/db/schema";
import { getDb } from "@/lib/db";
import { newId } from "@/lib/ids";
import { getGithubApp, getInstallationToken } from "@/lib/github";
import { markGithubIssueDone } from '@/lib/github-completion';
import { LABELS } from '@/lib/brand';
import { parsePullRef } from '@/lib/work-review';
import {
  finishRun,
  getTicketWithContext,
  setAgentStatus,
  setTicketStage,
} from "@/lib/queries";
import { claimAccount, releaseAccount, saveStatus } from "@/lib/codex/accounts";
import { runnerRequest } from "@/lib/codex/runner";
import { completionStage, hasGreenCICompletion, isProvider, validModel, type RunResult } from "@/shared/codex";
import { forEachConcurrent } from '@/lib/concurrency';
import { applyRunOutcome, captureLearnings, memoriesForTicket, recordRunMemories } from '@/lib/memory-store';
import { epicContext, isPlanTicket, postThreadMessage, storePlan } from '@/lib/collab-store';
import { buildRunPrompt } from '@/lib/run-prompt';
import { updateGithubIssueStatus, type IssueRunStatus } from '@/lib/github-status';

/** Status visibility is advisory and must never strand a run or its account. */
async function publishIssueStatus(ticketId: string, status: IssueRunStatus) {
  try {
    const context = await getTicketWithContext(ticketId);
    if (!context?.installation) throw new Error('GitHub installation unavailable.');
    const [owner, repo] = context.project.repoFullName.split('/');
    const client = await getGithubApp().getInstallationOctokit(context.installation.installationId);
    await updateGithubIssueStatus(client, owner, repo, context.ticket.githubIssueNumber, status);
  } catch {
    await getDb().then((db) => db.update(runs).set({
      log: sql`substr(coalesce(${runs.log}, '') || char(10) || 'Factory could not update the GitHub issue status.', -100000)`,
    }).where(eq(runs.id, status.runId))).catch(() => {});
  }
}

export async function startCodexRun(
  ticketId: string,
  agentId: string,
  modelId: string,
  userId: string,
  options?: { automationLabel: string; automationLeaseId: string },
) {
  if (!validModel(modelId))
    throw new Error("Choose a model or the subscription default.");
  const db = await getDb();
  const context = await getTicketWithContext(ticketId);
  const agent = await db
    .select()
    .from(agents)
    .where(eq(agents.id, agentId))
    .get();
  if (!context?.installation || !agent || agent.status === "disabled")
    throw new Error("Ticket or agent is unavailable.");
  // Check installation permissions before claiming a ticket or subscription.
  const githubToken = await getInstallationToken(context.installation.installationId, true, context.project.repoId);
  const mode = isPlanTicket(context.ticket) ? "plan" : "implement";
  // Pre-run hydrate: ranked memory plus the epic's goal, siblings and thread.
  const memory = await memoriesForTicket(db, context.project.id, `${context.ticket.title}\n${context.ticket.body ?? ""}`);
  const epic = await epicContext(db, context.ticket);
  const prompt = buildRunPrompt({
    mode, issueNumber: context.ticket.githubIssueNumber, title: context.ticket.title, body: context.ticket.body,
    agentPrompt: agent.systemPrompt, memoryBlock: memory.block,
    epic: epic?.epic, siblings: epic?.siblings, thread: epic?.thread,
  });
  const runId = newId("run");
  // A pinned provider keeps a provider-specific model off the other CLI.
  const account = await claimAccount(userId, runId, db, isProvider(agent.provider) ? agent.provider : null);
  let inserted = false;
  let claimedTicket = false;
  let claimedAgent = false;
  let dispatched = false;
  try {
    const availableAgent = await db
      .update(agents)
      .set({ status: "working", updatedAt: new Date() })
      .where(and(eq(agents.id, agentId), eq(agents.status, "idle")))
      .returning({ id: agents.id });
    if (!availableAgent.length)
      throw new Error("This agent is already working or disabled.");
    claimedAgent = true;
    // Compare-and-set prevents two requests starting the same ticket.
    const claimed = await db
      .update(tickets)
      .set({
        stage: "in_progress",
        assignedAgentId: agentId,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(tickets.id, ticketId),
          eq(tickets.githubState, 'open'),
          inArray(tickets.stage, ["intake", "assigned", "review"]),
          ...(options ? [
            inArray(tickets.stage, ['intake', 'assigned']),
            sql`(${tickets.assignedAgentId} is null or ${tickets.assignedAgentId} = ${agentId})`,
            sql`not exists (select 1 from runs where ticket_id = ${ticketId} and (${tickets.requeuedAt} is null or created_at >= ${tickets.requeuedAt}))`,
            sql`exists (select 1 from json_each(case when json_valid(${tickets.labels}) then ${tickets.labels} else '[]' end) where lower(value) in (lower(${options.automationLabel}), ${LABELS.plan}))`,
            sql`not exists (select 1 from ticket_dependencies d join tickets blocker on blocker.id = d.depends_on_ticket_id where d.ticket_id = ${ticketId} and blocker.github_state = 'open')`,
            sql`exists (select 1 from automation a join agents worker on worker.id = ${agentId} where a.id = 'github' and a.enabled = 1 and a.user_id = ${userId} and a.lease_id = ${options.automationLeaseId} and worker.owner_user_id = a.user_id and worker.automation_slot between 1 and a.target_agents)`,
          ] : []),
        ),
      )
      .returning({ id: tickets.id });
    if (!claimed.length)
      throw new Error("Ticket already running or completed.");
    claimedTicket = true;
    await db.insert(runs).values({
      id: runId,
      ticketId,
      agentId,
      requestedByUserId: userId,
      codexAccountId: account.id,
      status: "running",
      modelId,
      mode,
      startedAt: new Date(),
      createdAt: new Date(),
    });
    inserted = true;
    // Usage tracking is advisory; it must never block a run from starting.
    await recordRunMemories(db, runId, memory.selected.map((item) => item.id)).catch(() => {});
    await publishIssueStatus(ticketId, { runId, status: 'running' });
    dispatched = true;
    await runnerRequest(`/runs/${runId}`, "POST", {
      accountId: account.id,
      repoFullName: context.project.repoFullName,
      defaultBranch: context.project.defaultBranch,
      branchName: `factory/ticket-${context.ticket.githubIssueNumber}-${runId.slice(-8)}`,
      githubToken,
      model: modelId === "codex-default" ? undefined : modelId,
      mode,
      prompt,
      prTitle: context.ticket.title.slice(0, 200),
      issueNumber: context.ticket.githubIssueNumber,
    });
    return runId;
  } catch (error) {
    // A timed-out dispatch may already be executing. Let polling/cron reconcile it
    // instead of releasing credentials for a second concurrent run.
    if (inserted && dispatched) {
      await db
        .update(runs)
        .set({ log: "Waiting for the runner to confirm startup." })
        .where(eq(runs.id, runId));
      return runId;
    }
    if (inserted) {
      await finishRun({
        runId,
        status: "failed",
        log: error instanceof Error ? error.message : "Could not start Codex.",
      });
    }
    if (claimedAgent) await setAgentStatus(agentId, "idle");
    if (claimedTicket) await setTicketStage(ticketId, "assigned");
    await releaseAccount(account.id, runId);
    throw error;
  }
}

/** Poll durable sandbox jobs; no coding work depends on a request's waitUntil lifetime. */
export async function refreshRuns(userId: string, timeoutMs = 120_000) {
  const db = await getDb();
  const active = await db
    .select()
    .from(runs)
    .where(and(eq(runs.requestedByUserId, userId), eq(runs.status, "running")))
    .all();
  await forEachConcurrent(active, 4, async (run) => {
    if (!run.codexAccountId) return;
    let result: RunResult;
    try {
      result = await runnerRequest<RunResult>(
        `/runs/${run.id}?accountId=${run.codexAccountId}`,
        'GET', undefined, timeoutMs,
      );
    } catch {
      return;
    } // Transient runner failure must not release an executing subscription.
    if (result.status === "running") {
      if (result.log) await db.update(runs).set({
        log: result.log.slice(-100000),
        pullRequestUrl: result.pullRequestUrl ?? null,
      }).where(and(eq(runs.id, run.id), eq(runs.status, "running")));
      return;
    }
    try {
      await completeCodexRun(run.id, result);
    } catch {
      // One failing completion must not block polling of the other runs;
      // the runner callback and the next check retry it.
      return;
    }
  });
  return db
    .select({
      id: runs.id,
      ticketId: runs.ticketId,
      status: runs.status,
      log: runs.log,
      pullRequestUrl: runs.pullRequestUrl,
      modelId: runs.modelId,
      codexAccountId: runs.codexAccountId,
    })
    .from(runs)
    .where(eq(runs.requestedByUserId, userId))
    .orderBy(desc(runs.createdAt))
    .limit(100)
    .all();
}

export async function completeCodexRun(runId: string, result: RunResult) {
  if (result.status === "running") return;
  const db = await getDb();
  const run = await db.select().from(runs).where(eq(runs.id, runId)).get();
  if (!run) {
    const account = await db
      .select()
      .from(codexAccounts)
      .where(eq(codexAccounts.activeRunId, runId))
      .get();
    if (account) {
      if (result.accountStatus)
        await saveStatus(account.id, result.accountStatus);
      await releaseAccount(account.id, runId);
    }
    return;
  }
  const active = sql`exists (select 1 from runs where id = ${runId} and status = 'running')`;
  if (run.status !== 'running') return;
  let completedLabels: string[] | undefined;
  let completionNote: string | undefined;
  const ciComplete = hasGreenCICompletion(result);
  if (ciComplete) {
    await db.update(runs).set({ log: `CI green; updating GitHub issue, merging low-risk PRs, and applying ${LABELS.done}.`,
      pullRequestUrl: result.pullRequestUrl ?? null }).where(and(eq(runs.id, runId), eq(runs.status, 'running')));
    try {
      const context = await getTicketWithContext(run.ticketId);
      if (!context?.installation) throw new Error('Cannot complete issue without its GitHub installation.');
      const [owner, repo] = context.project.repoFullName.split('/');
      const client = await getGithubApp().getInstallationOctokit(context.installation.installationId);
      const pull = parsePullRef(result.pullRequestUrl ?? null, context.project.repoFullName);
      completedLabels = await markGithubIssueDone(client, owner, repo, context.ticket.githubIssueNumber, {
        pullNumber: pull?.number, sha: result.ciHeadSha,
      });
    } catch (error) {
      // A finished run must never strand its agent: record completion, park the
      // ticket in review, and surface the GitHub failure in the run log.
      completionNote = `CI is green, but closing the GitHub issue failed: ${error instanceof Error ? error.message : 'unknown error'}. Review the pull request and close the issue on GitHub.`;
    }
  }
  const accountState = result.accountStatus;
  // D1 batches are transactional: completion cannot leave the ticket or account locked.
  const [, , , , , finished] = await db.batch([
    db
      .update(tickets)
      .set({
        // A plan run leaves its epic in review while the proposal waits for approval.
        stage: completionStage(result.status, !!completedLabels),
        ...(completedLabels ? { githubState: 'closed', labels: JSON.stringify(completedLabels) } : {}),
        updatedAt: new Date(),
      })
      .where(and(eq(tickets.id, run.ticketId), active)),
    db
      .update(agents)
      .set({ status: "idle", updatedAt: new Date() })
      .where(and(eq(agents.id, run.agentId), active)),
    db
      .update(codexAccounts)
      .set({
        ...(accountState ? {
          status: accountState.status,
          email: accountState.email,
          plan: accountState.plan,
          limitsJson: accountState.limits ? JSON.stringify(accountState.limits) : null,
          error: accountState.error ?? null,
        } : {}),
        updatedAt: new Date(),
      })
      .where(and(eq(codexAccounts.id, run.codexAccountId ?? ""), active)),
    // A paused run holds no lease; deleting a missing one is a no-op.
    db.delete(accountLeases).where(eq(accountLeases.holderId, runId)),
    // Runs claimed before parallel leases existed held the maintenance lock instead.
    db.update(codexAccounts).set({ activeRunId: null }).where(eq(codexAccounts.activeRunId, runId)),
    db
      .update(runs)
      .set({
        status: result.status,
        log: completionNote
          ? `${result.log.slice(0, 100_000 - completionNote.length - 1)}\n${completionNote}`
          : result.log.slice(0, 100000),
        pullRequestUrl: result.pullRequestUrl ?? run.pullRequestUrl,
        inputTokens: result.inputTokens ?? 0,
        outputTokens: result.outputTokens ?? 0,
        finishedAt: new Date(),
      })
      .where(and(eq(runs.id, runId), eq(runs.status, "running")))
      .returning({ id: runs.id }),
  ]);
  // Only the completion that finished the run captures memory, so retries never double count.
  if (finished.length) {
    await publishIssueStatus(run.ticketId, {
      runId, status: result.status, issueClosed: !!completedLabels,
      pullRequestUrl: result.pullRequestUrl ?? run.pullRequestUrl,
    });
    await afterRun(run, result, ciComplete);
  }
}

/** Post-run capture: learnings, outcome feedback, handoff to the epic thread, plan proposals. */
async function afterRun(run: typeof runs.$inferSelect, result: RunResult, ciComplete: boolean) {
  const db = await getDb();
  const context = await getTicketWithContext(run.ticketId);
  if (!context) return;
  const note = async (message: string) => {
    await db.update(runs).set({ log: sql`substr(${runs.log} || char(10) || ${message}, -100000)` }).where(eq(runs.id, run.id));
  };
  const steps: [string, () => Promise<unknown>][] = [
    ['learnings', () => result.status === 'cancelled' ? Promise.resolve()
      : captureLearnings(db, { projectId: context.project.id, runId: run.id, ticketId: run.ticketId, raw: result.notes?.learnings })],
    ['outcome', () => run.mode !== 'implement' || (!ciComplete && result.status !== 'failed') ? Promise.resolve()
      : applyRunOutcome(db, run.id, ciComplete)],
    ['handoff', () => typeof result.notes?.handoff !== 'string' || !context.ticket.parentTicketId ? Promise.resolve()
      : postThreadMessage(db, {
        threadTicketId: context.ticket.parentTicketId, kind: 'handoff', body: result.notes.handoff,
        fromTicketId: run.ticketId, runId: run.id, agentId: run.agentId, author: `#${context.ticket.githubIssueNumber}`,
      })],
    ['plan', () => run.mode !== 'plan' || result.status !== 'succeeded' ? Promise.resolve()
      : storePlan(db, { ticket: context.ticket, runId: run.id, raw: result.plan })],
  ];
  for (const [name, step] of steps) {
    try {
      await step();
    } catch (error) {
      await note(`Factory ${name} step failed: ${error instanceof Error ? error.message : 'unknown error'}`).catch(() => {});
    }
  }
}

/** Stop the durable job before releasing its ticket or agent. */
export async function cancelCodexRun(runId: string, userId: string) {
  const db = await getDb();
  const run = await db.select().from(runs)
    .where(and(eq(runs.id, runId), eq(runs.requestedByUserId, userId))).get();
  if (!run) throw new Error('Run unavailable or belongs to another user.');
  if (run.status !== 'running') return;
  if (!run.codexAccountId) throw new Error('Run has no subscription. Contact support to reconcile it.');
  const result = await runnerRequest<RunResult>(`/runs/${run.id}/cancel?accountId=${run.codexAccountId}`, 'POST');
  if (result.status === 'running') throw new Error('Recovery is currently updating this run. Try stopping it again shortly.');
  if (!['cancelled', 'succeeded', 'failed'].includes(result.status) || typeof result.log !== 'string')
    throw new Error('Runner did not confirm that the run stopped.');
  await completeCodexRun(run.id, result);
}
