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
import { createMemory, listMemories, memoriesForTicket, updateMemory } from '@/lib/memory-store';
import { applyPlan, listPlans, postThreadMessage, rejectPlan, threadMessages } from '@/lib/collab-store';
import { outstandingPullRequests } from '@/lib/work-review-query';

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

export async function runFactoryOperation(id: string, args: Record<string, unknown> = {}): Promise<unknown> {
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
    default:
      throw new FactoryApiError(404, 'Unknown operation.');
  }
}