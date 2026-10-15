import 'server-only';

import { enqueuePickup } from '@/lib/automation-queue';
import { automationStatus } from '@/lib/automation-state';
import { factoryApiKey, paperboyConfig } from '@/lib/env';
import { factoryCapabilities, factoryOpenApi } from '@/lib/factory-catalog';
import { latestDigestSend, previewDigest, sendOutstandingDigest } from '@/lib/digest';
import { outstandingSnapshot } from '@/lib/outstanding-query';
import {
  getRun,
  getTicketWithContext,
  listAgentsWithOwners,
  listProjects,
  listTicketsForProject,
} from '@/lib/queries';
import { workBoardCards } from '@/lib/work-board-query';
import { getDb } from '@/lib/db';
import { createMemory, listMemories, memoriesForTicket, memoryHistory, revertMemoryEvent, setProjectMemorySettings, updateMemory } from '@/lib/memory-store';
import { applyPlan, listPlans, postThreadMessage, rejectPlan, threadMessages } from '@/lib/collab-store';
import { outstandingPullRequests } from '@/lib/work-review-query';
import { desc, eq } from 'drizzle-orm';
import { memoryEvents, runs } from '@/db/schema';
import { FACTORY_OPERATIONS } from '@/lib/factory-catalog';
import {
  NotFoundError, acceptRunReview, createTicket, mergeRunReview, moveWorkCard, refreshRepos, retryAttention, setAutomationEnabled, setAutomationSize,
  setTicketRisk, shareSubscription, syncTickets,
} from '@/lib/factory-control';
import { assignTicket, createAgent } from '@/lib/queries';
import { getRunSession } from '@/lib/run-activities';
import { publicRunOutput } from '@/lib/run-output';
import { runnerRequest } from '@/lib/codex/runner';
import { refreshAccount, setAccountEnabled, setAccountMaxRuns, visibleAccounts } from '@/lib/codex/accounts';
import { getGithubApp } from '@/lib/github';
import { reviewContext, reviewState } from '@/lib/review-merge';
import { MAX_PARALLEL_RUNS, PROVIDERS, validId, type AccountStatus, type RunResult } from '@/shared/codex';
import { TICKET_RISKS } from '@/shared/ticket-risk';

export class FactoryApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

function stringArg(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

/** Validation failures in the stores are the caller's problem, not a server error. */
async function userError<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    throw new FactoryApiError(400, error instanceof Error ? error.message : 'Invalid request.');
  }
}

function idArg(args: Record<string, unknown>, key: string): string {
  const value = stringArg(args, key);
  if (!value || !validId(value)) throw new FactoryApiError(400, `${key} is required.`);
  return value;
}

/** Store and GitHub refusals (busy agent, wrong owner, moved head) are the caller's to fix. */
async function refused<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof FactoryApiError) throw error;
    if (error instanceof NotFoundError || (error instanceof Error && error.message === 'Subscription not found.'))
      throw new FactoryApiError(404, error.message);
    throw new FactoryApiError(409, error instanceof Error ? error.message : 'Factory refused this request.');
  }
}

export async function runFactoryOperation(id: string, args: Record<string, unknown> = {}, actor: { userId: string | null } = { userId: null }): Promise<unknown> {
  const operation = FACTORY_OPERATIONS.find((item) => item.id === id);
  if (operation?.person && !actor.userId)
    throw new FactoryApiError(403, 'This operation acts as a person. Use a personal API key from Settings, not the shared FACTORY_API_KEY.');
  const userId = actor.userId ?? '';
  switch (id) {
    case 'listCapabilities':
      return factoryCapabilities();
    case 'getOpenApi':
      return factoryOpenApi();
    case 'getStatus': {
      const last = await latestDigestSend();
      return {
        ok: true,
        paperboy: !!paperboyConfig(),
        factoryApiKey: !!factoryApiKey(),
        digest: last ? {
          sydneyDate: last.sydneyDate,
          sentAt: last.sentAt.toISOString(),
          messageId: last.messageId,
          recipientCount: last.recipientCount,
          error: last.error,
        } : null,
      };
    }
    case 'listOutstanding':
      return outstandingSnapshot();
    case 'listWork':
      return { cards: await workBoardCards() };
    case 'listReviewQueue':
      return outstandingPullRequests();
    case 'listProjects': {
      const projects = await listProjects();
      return {
        projects: projects.map((project) => ({
          id: project.id,
          repo: project.repoFullName,
          defaultBranch: project.defaultBranch,
          description: project.description,
          private: project.private,
          status: project.status,
          issuesSyncedAt: project.issuesSyncedAt?.toISOString() ?? null,
        })),
      };
    }
    case 'listTickets': {
      const projectId = stringArg(args, 'projectId');
      if (projectId) {
        const tickets = await listTicketsForProject(projectId);
        return { tickets };
      }
      return { cards: await workBoardCards() };
    }
    case 'getTicket': {
      const ticketId = stringArg(args, 'ticketId');
      if (!ticketId) throw new FactoryApiError(400, 'ticketId is required.');
      const context = await getTicketWithContext(ticketId);
      if (!context) throw new FactoryApiError(404, 'Ticket not found.');
      return {
        ticket: context.ticket,
        repo: context.project.repoFullName,
        agent: context.agent ? { id: context.agent.id, name: context.agent.name, status: context.agent.status } : null,
      };
    }
    case 'listAgents':
      return { agents: await listAgentsWithOwners() };
    case 'getRun': {
      const runId = stringArg(args, 'runId');
      if (!runId) throw new FactoryApiError(400, 'runId is required.');
      const run = await getRun(runId);
      if (!run) throw new FactoryApiError(404, 'Run not found.');
      return {
        run: {
          id: run.id,
          ticketId: run.ticketId,
          agentId: run.agentId,
          status: run.status,
          sandboxId: run.sandboxId,
          modelId: run.modelId,
          pullRequestUrl: run.pullRequestUrl,
          inputTokens: run.inputTokens,
          outputTokens: run.outputTokens,
          startedAt: run.startedAt,
          finishedAt: run.finishedAt,
          createdAt: run.createdAt,
          waitingReason: run.waitingReason,
        },
      };
    }
    case 'getAutomation':
      return { automation: await automationStatus() };
    case 'enqueuePickup':
      await enqueuePickup('API pickup');
      return { ok: true };
    case 'previewDigest':
      return previewDigest();
    case 'sendDigest':
      return sendOutstandingDigest({ force: args.force === true });
    case 'listMemories': {
      const projectId = stringArg(args, 'projectId');
      return { memories: await listMemories(await getDb(), {
        projectId: projectId === 'global' ? null : projectId, status: stringArg(args, 'status'),
      }) };
    }
    case 'previewMemory': {
      const projectId = stringArg(args, 'projectId');
      if (!projectId) throw new FactoryApiError(400, 'projectId is required.');
      const { selected, block } = await memoriesForTicket(await getDb(), projectId, stringArg(args, 'text') ?? '');
      return { memoryIds: selected.map((memory) => memory.id), block };
    }
    case 'createMemory':
      return userError(async () => ({ memory: await createMemory(await getDb(), {
        projectId: stringArg(args, 'projectId') ?? null, kind: stringArg(args, 'kind'), content: String(args.content ?? ''),
        weight: typeof args.weight === 'number' ? args.weight : undefined, pinned: args.pinned === true,
      }, 'api') }));
    case 'updateMemory': {
      const memoryId = stringArg(args, 'memoryId');
      if (!memoryId) throw new FactoryApiError(400, 'memoryId is required.');
      return userError(async () => ({ memory: await updateMemory(await getDb(), memoryId, {
        content: typeof args.content === 'string' ? args.content : undefined, kind: stringArg(args, 'kind'),
        weight: typeof args.weight === 'number' ? args.weight : undefined,
        pinned: typeof args.pinned === 'boolean' ? args.pinned : undefined, status: stringArg(args, 'status'),
      }, 'api') }));
    }
    case 'getMemoryHistory': {
      const memoryId = idArg(args, 'memoryId');
      const db = await getDb();
      if (!(await listMemories(db)).some((memory) => memory.id === memoryId)) throw new FactoryApiError(404, 'Memory not found.');
      const events = await memoryHistory(db, [memoryId]);
      return { events: events.map((event) => ({ id: event.id, action: event.action, actor: event.actor, createdAt: event.createdAt,
        before: event.before ? JSON.parse(event.before) as unknown : null, after: event.after ? JSON.parse(event.after) as unknown : null })) };
    }
    case 'revertMemory': {
      const eventId = idArg(args, 'eventId');
      const db = await getDb();
      if (!(await db.select({ id: memoryEvents.id }).from(memoryEvents).where(eq(memoryEvents.id, eventId)).get()))
        throw new FactoryApiError(404, 'Memory change not found.');
      return userError(async () => ({ memory: await revertMemoryEvent(db, eventId, actor.userId ? `user:${actor.userId}` : 'api') }));
    }
    case 'listPlans':
      return { plans: await listPlans(await getDb()) };
    case 'approvePlan':
    case 'rejectPlan': {
      const planId = stringArg(args, 'planId');
      if (!planId) throw new FactoryApiError(400, 'planId is required.');
      await userError(async () => id === 'approvePlan' ? applyPlan(await getDb(), planId, null) : rejectPlan(await getDb(), planId, null));
      return { ok: true };
    }
    case 'listMessages': {
      const ticketId = stringArg(args, 'ticketId');
      if (!ticketId) throw new FactoryApiError(400, 'ticketId is required.');
      return { messages: await threadMessages(await getDb(), ticketId) };
    }
    case 'postMessage': {
      const ticketId = stringArg(args, 'ticketId');
      if (!ticketId) throw new FactoryApiError(400, 'ticketId is required.');
      return userError(async () => ({ id: await postThreadMessage(await getDb(), {
        threadTicketId: ticketId, kind: 'human', body: String(args.body ?? ''), author: 'API',
      }) }));
    }
    case 'listRuns': {
      const ticketId = idArg(args, 'ticketId');
      const rows = await (await getDb()).select({
        id: runs.id, status: runs.status, mode: runs.mode, attempt: runs.attempt, failureKind: runs.failureKind,
        agentId: runs.agentId, modelId: runs.modelId, branchName: runs.branchName, parentRunId: runs.parentRunId,
        pullRequestUrl: runs.pullRequestUrl, pullRequestState: runs.pullRequestState,
        startedAt: runs.startedAt, finishedAt: runs.finishedAt, createdAt: runs.createdAt,
      }).from(runs).where(eq(runs.ticketId, ticketId)).orderBy(desc(runs.createdAt)).limit(50).all();
      return { runs: rows };
    }
    case 'getRunLog': {
      const runId = idArg(args, 'runId');
      const run = await getRun(runId);
      if (!run) throw new FactoryApiError(404, 'Run not found.');
      const requested = args.tail === undefined ? 20_000 : Number(args.tail);
      if (!Number.isFinite(requested)) throw new FactoryApiError(400, 'tail must be a number.');
      const tail = Math.min(Math.max(Math.floor(requested), 1), 60_000);
      // Same redacted output the Work board streams: live from the runner while running, stored after.
      const output = run.status === 'running' && run.codexAccountId
        ? publicRunOutput({ ...await runnerRequest<RunResult>(`/runs/${runId}/output?accountId=${encodeURIComponent(run.codexAccountId)}`,
          'GET', undefined, 10_000), waitingReason: run.waitingReason })
        : publicRunOutput({ ...run, outputUpdatedAt: run.finishedAt?.toISOString() ?? null });
      return { ...output, log: output.log.slice(-tail) };
    }
    case 'getRunSession': {
      const session = await getRunSession(await getDb(), idArg(args, 'runId'));
      if (!session) throw new FactoryApiError(404, 'Run not found.');
      return session;
    }
    case 'getReviewState': {
      const db = await getDb();
      const context = await reviewContext(db, idArg(args, 'runId'));
      if (!context) throw new FactoryApiError(404, 'This run has no pull request.');
      const client = await getGithubApp().getInstallationOctokit(context.installationId);
      return reviewState(db, client, context, userId);
    }
    case 'listSubscriptions':
      return { subscriptions: (await visibleAccounts(userId)).map((account) => ({
        id: account.id, provider: account.provider, label: account.label, email: account.email, plan: account.plan,
        status: account.status, error: account.error, enabled: account.enabled, shared: account.shared,
        mine: account.ownerUserId === userId, maxRuns: account.maxRuns, runningRuns: account.runningRuns,
        limits: account.limitsJson ? JSON.parse(account.limitsJson) as unknown : null, lastUsedAt: account.lastUsedAt,
      })) };
    case 'startRun': {
      const ticketId = idArg(args, 'ticketId');
      const agentId = idArg(args, 'agentId');
      const { startCodexRun } = await import('@/lib/agent/run');
      return { runId: await refused(() => startCodexRun(ticketId, agentId, stringArg(args, 'modelId') ?? 'codex-default', userId)) };
    }
    case 'stopRun': {
      const runId = idArg(args, 'runId');
      const { cancelCodexRun } = await import('@/lib/agent/run');
      await refused(() => cancelCodexRun(runId, userId));
      return { ok: true };
    }
    case 'promptRun': {
      const runId = idArg(args, 'runId');
      const { promptRun } = await import('@/lib/agent/run');
      return refused(() => promptRun(runId, userId, String(args.body ?? '')));
    }
    case 'moveTicket': {
      const lane = stringArg(args, 'lane');
      if (lane !== 'queued' && lane !== 'intake') throw new FactoryApiError(400, 'lane must be queued or intake.');
      const ticketId = idArg(args, 'ticketId');
      await refused(() => moveWorkCard(ticketId, lane));
      return { ok: true };
    }
    case 'retryFailed': {
      const ids = args.ticketIds;
      if (ids !== undefined && (!Array.isArray(ids) || ids.length > 500 || ids.some((item) => typeof item !== 'string')))
        throw new FactoryApiError(400, 'ticketIds must be a list of up to 500 ticket ids.');
      return refused(() => retryAttention(ids as string[] | undefined));
    }
    case 'assignTicket': {
      const ticketId = idArg(args, 'ticketId');
      const agentId = args.agentId === null ? null : idArg(args, 'agentId');
      await refused(() => assignTicket(ticketId, agentId));
      return { ok: true };
    }
    case 'setTicketRisk': {
      const ticketId = idArg(args, 'ticketId');
      const risk = args.risk === null ? null : TICKET_RISKS.find((value) => value === args.risk);
      if (risk === undefined) throw new FactoryApiError(400, 'risk must be low, medium, high or null.');
      return refused(() => setTicketRisk(ticketId, risk));
    }
    case 'syncTickets': {
      const projectId = idArg(args, 'projectId');
      return refused(() => syncTickets(projectId));
    }
    case 'createTicket': {
      const projectId = idArg(args, 'projectId');
      const title = stringArg(args, 'title');
      const body = typeof args.body === 'string' ? args.body : '';
      if (!title || title.length > 256) throw new FactoryApiError(400, 'title is required, up to 256 characters.');
      if (!body.trim() || body.length > 60_000) throw new FactoryApiError(400, 'body is required, up to 60000 characters.');
      const risk = args.risk === undefined || args.risk === null ? null : TICKET_RISKS.find((value) => value === args.risk);
      if (risk === undefined) throw new FactoryApiError(400, 'risk must be low, medium, high or null.');
      const start = args.start;
      if (start !== 'queue' && start !== 'plan' && start !== 'none') throw new FactoryApiError(400, 'start must be queue, plan or none.');
      // Low risk merges without anyone reading the PR. Starting work on it takes a separate, deliberate call.
      if (risk === 'low' && start !== 'none')
        throw new FactoryApiError(400, 'A low-risk ticket is created with start none. Queue it with factory_move_ticket once someone has read it.');
      return refused(() => createTicket(userId, { projectId, title, body, risk, start }));
    }
    case 'setProjectSettings': {
      const projectId = idArg(args, 'projectId');
      const { memoryBudget, activateLearnings, autoApprovePlans } = args;
      if (memoryBudget === undefined && activateLearnings === undefined && autoApprovePlans === undefined)
        throw new FactoryApiError(400, 'Pass memoryBudget, activateLearnings or autoApprovePlans.');
      if (memoryBudget !== undefined && (typeof memoryBudget !== 'number' || !Number.isInteger(memoryBudget) || memoryBudget < 0 || memoryBudget > 20_000))
        throw new FactoryApiError(400, 'memoryBudget must be a whole number from 0 to 20000.');
      for (const [key, value] of Object.entries({ activateLearnings, autoApprovePlans }))
        if (value !== undefined && typeof value !== 'boolean') throw new FactoryApiError(400, `${key} must be true or false.`);
      if (!(await listProjects()).some((project) => project.id === projectId)) throw new FactoryApiError(404, 'Project not found.');
      await setProjectMemorySettings(await getDb(), projectId, {
        memoryBudget: memoryBudget as number | undefined, activateLearnings: activateLearnings as boolean | undefined,
        autoApprovePlans: autoApprovePlans as boolean | undefined,
      });
      return { ok: true };
    }
    case 'refreshRepos':
      return refused(() => refreshRepos());
    case 'createAgent': {
      const name = stringArg(args, 'name');
      const provider = stringArg(args, 'provider');
      const modelId = stringArg(args, 'modelId');
      const color = stringArg(args, 'color');
      if (!name || name.length > 80) throw new FactoryApiError(400, 'name is required, up to 80 characters.');
      if (provider && !PROVIDERS.includes(provider as (typeof PROVIDERS)[number])) throw new FactoryApiError(400, 'Unknown provider.');
      if (modelId && (!provider || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(modelId)))
        throw new FactoryApiError(400, 'A custom modelId needs a valid name and a provider.');
      if (color && !/^#[0-9a-fA-F]{6}$/.test(color)) throw new FactoryApiError(400, 'color must be #rrggbb.');
      if (args.systemPrompt !== undefined && (typeof args.systemPrompt !== 'string' || args.systemPrompt.length > 4000))
        throw new FactoryApiError(400, 'systemPrompt must be text up to 4000 characters.');
      const systemPrompt = typeof args.systemPrompt === 'string' && args.systemPrompt ? args.systemPrompt : null;
      return { agent: await createAgent({ ownerUserId: userId, name, color, modelId: modelId ?? null,
        provider: (provider as (typeof PROVIDERS)[number] | undefined) ?? null, systemPrompt }) };
    }
    case 'acceptReview': {
      const runId = idArg(args, 'runId');
      const acceptance = await refused(() => acceptRunReview(userId, runId, String(args.headSha ?? '')));
      return { acceptedSha: acceptance.headSha, merged: false };
    }
    case 'mergeReview': {
      const runId = idArg(args, 'runId');
      const { event, joined } = await refused(() => mergeRunReview(userId, runId));
      return { status: event.status, headSha: event.headSha, mergeSha: event.mergeSha, message: event.message, joined };
    }
    case 'setAutomation': {
      // Validate everything before the first write, so a bad field never leaves half a change.
      if (args.enabled === undefined && args.targetAgents === undefined) throw new FactoryApiError(400, 'Pass enabled, targetAgents or both.');
      if (args.enabled !== undefined && typeof args.enabled !== 'boolean') throw new FactoryApiError(400, 'enabled must be true or false.');
      const size = args.targetAgents;
      if (size !== undefined && (typeof size !== 'number' || !Number.isInteger(size) || size < 10 || size > 20))
        throw new FactoryApiError(400, 'targetAgents must be a whole number from 10 to 20.');
      if (typeof args.enabled === 'boolean') await refused(() => setAutomationEnabled(userId, args.enabled as boolean));
      if (typeof size === 'number') await refused(() => setAutomationSize(userId, size));
      return { automation: await automationStatus() };
    }
    case 'shareSubscription': {
      const accountId = idArg(args, 'accountId');
      if (typeof args.shared !== 'boolean') throw new FactoryApiError(400, 'shared must be true or false.');
      await refused(() => shareSubscription(userId, accountId, args.shared as boolean));
      return { ok: true };
    }
    case 'refreshSubscription': {
      // Sign-in codes and account keys stay in the app.
      const status = await refused(() => refreshAccount(idArg(args, 'accountId'), userId)) as Partial<AccountStatus>;
      return { status: status.status, email: status.email ?? null, plan: status.plan ?? null, limits: status.limits ?? null, error: status.error ?? null };
    }
    case 'setSubscription': {
      const accountId = idArg(args, 'accountId');
      if (args.enabled === undefined && args.maxRuns === undefined) throw new FactoryApiError(400, 'Pass enabled, maxRuns or both.');
      if (args.enabled !== undefined && typeof args.enabled !== 'boolean') throw new FactoryApiError(400, 'enabled must be true or false.');
      const maxRuns = args.maxRuns;
      if (maxRuns !== undefined && (typeof maxRuns !== 'number' || !Number.isInteger(maxRuns) || maxRuns < 1 || maxRuns > MAX_PARALLEL_RUNS))
        throw new FactoryApiError(400, `maxRuns must be a whole number from 1 to ${MAX_PARALLEL_RUNS}.`);
      // maxRuns is owner-only, so it goes first: a refusal there leaves nothing changed.
      if (typeof maxRuns === 'number') await refused(() => setAccountMaxRuns(accountId, userId, maxRuns));
      if (typeof args.enabled === 'boolean') await refused(() => setAccountEnabled(accountId, userId, args.enabled as boolean));
      return { ok: true };
    }
    default:
      throw new FactoryApiError(404, 'Unknown operation.');
  }
}