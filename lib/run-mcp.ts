import 'server-only';

import { and, count, eq } from 'drizzle-orm';
import { agentMessages, memoryEvents, runs } from '@/db/schema';
import { getDb } from '@/lib/db';
import { getEnv } from '@/lib/env';
import { bearerToken } from '@/lib/factory-auth';
import { epicContext, postThreadMessage, threadMessages } from '@/lib/collab-store';
import { MEMORY_KINDS } from '@/lib/memory';
import { captureLearnings, memoriesForTicket } from '@/lib/memory-store';
import { getTicketWithContext } from '@/lib/queries';
import { runIdFromToken } from '@/lib/run-token';

// Per-run caps keep a confused or prompt-injected agent from flooding shared state.
export const RUN_CHANNEL_LIMITS = { proposals: 10, posts: 8 };
const PROTOCOL = '2025-03-26';

const TOOLS = [
  { name: 'factory_memory_search', description: 'Search team memory about this codebase (conventions, gotchas, commands) beyond what your prompt already contains.',
    inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'], additionalProperties: false } },
  { name: 'factory_memory_propose', description: `Record a durable, non-obvious fact about this codebase for future agents. One sentence, no secrets, nothing ticket-specific. At most ${RUN_CHANNEL_LIMITS.proposals} per run.`,
    inputSchema: { type: 'object', properties: { kind: { type: 'string', enum: [...MEMORY_KINDS] }, content: { type: 'string' } }, required: ['content'], additionalProperties: false } },
  { name: 'factory_thread_read', description: 'Read the epic thread: planner notes, handoffs and live updates from agents on sibling tickets, and team guidance.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'factory_thread_post', description: `Tell agents on sibling tickets something they need now, such as an interface you just defined or a blocker. Mirrored to GitHub. At most ${RUN_CHANNEL_LIMITS.posts} per run.`,
    inputSchema: { type: 'object', properties: { body: { type: 'string' } }, required: ['body'], additionalProperties: false } },
  { name: 'factory_team_status', description: 'The epic goal and the current state of sibling tickets.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
];

type Rpc = { jsonrpc?: string; id?: string | number | null; method?: string; params?: unknown };
const reply = (id: Rpc['id'], result: unknown) => ({ jsonrpc: '2.0', id: id ?? null, result });
const fail = (id: Rpc['id'], code: number, message: string) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });
const noStore = (data: unknown, status = 200) => Response.json(data, { status, headers: { 'Cache-Control': 'no-store' } });

/** Resolve the calling run from its bearer token. Tokens stop working the moment the run finishes. */
async function authenticate(request: Request) {
  const runId = runIdFromToken(bearerToken(request), getEnv().SANDBOX_RUNNER_SECRET);
  if (!runId) return null;
  const db = await getDb();
  const run = await db.select().from(runs).where(and(eq(runs.id, runId), eq(runs.status, 'running'))).get();
  if (!run) return null;
  const context = await getTicketWithContext(run.ticketId);
  return context ? { db, run, ...context } : null;
}
type Caller = NonNullable<Awaited<ReturnType<typeof authenticate>>>;

export async function handleRunMcp(request: Request) {
  // Streamable HTTP without a server-initiated stream: GET is not offered.
  if (request.method !== 'POST') return new Response(null, { status: 405, headers: { Allow: 'POST' } });
  const caller = await authenticate(request);
  if (!caller) return noStore({ error: 'Run is not active.' }, 401);
  const body: unknown = await request.json().catch(() => null);
  if (!body || typeof body !== 'object') return noStore(fail(null, -32700, 'Parse error'), 400);
  const messages = (Array.isArray(body) ? body : [body]) as Rpc[];
  const responses = [];
  for (const message of messages.slice(0, 20)) {
    if (message.jsonrpc !== '2.0' || typeof message.method !== 'string') { responses.push(fail(message.id, -32600, 'Invalid request')); continue; }
    if (message.id === undefined) continue; // Notifications need no reply.
    try {
      responses.push(await dispatch(caller, message));
    } catch (error) {
      responses.push(fail(message.id, -32000, error instanceof Error ? error.message : 'Tool failed.'));
    }
  }
  if (!responses.length) return new Response(null, { status: 202 });
  return noStore(Array.isArray(body) ? responses : responses[0]);
}

async function dispatch(caller: Caller, message: Rpc) {
  switch (message.method) {
    case 'initialize':
      return reply(message.id, { protocolVersion: PROTOCOL, capabilities: { tools: {} }, serverInfo: { name: 'factory-run', version: '1.0.0' } });
    case 'ping':
      return reply(message.id, {});
    case 'tools/list':
      return reply(message.id, { tools: TOOLS });
    case 'tools/call': {
      const params = (message.params && typeof message.params === 'object' ? message.params : {}) as { name?: unknown; arguments?: unknown };
      const args = (params.arguments && typeof params.arguments === 'object' ? params.arguments : {}) as Record<string, unknown>;
      const result = await callTool(caller, String(params.name ?? ''), args);
      return reply(message.id, { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result });
    }
    default:
      return fail(message.id, -32601, `Method not found: ${message.method}`);
  }
}

async function callTool({ db, run, ticket, project }: Caller, name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const threadTicketId = ticket.parentTicketId ?? ticket.id;
  switch (name) {
    case 'factory_memory_search': {
      const query = String(args.query ?? '').slice(0, 2000);
      const { selected } = await memoriesForTicket(db, project.id, query);
      return { memories: selected.slice(0, 15).map((memory) => ({ kind: memory.kind, content: memory.content })) };
    }
    case 'factory_memory_propose': {
      const [used] = await db.select({ value: count() }).from(memoryEvents).where(eq(memoryEvents.actor, `run:${run.id}`));
      if ((used?.value ?? 0) >= RUN_CHANNEL_LIMITS.proposals) throw new Error('Memory proposal limit reached for this run.');
      const saved = await captureLearnings(db, { projectId: project.id, runId: run.id, ticketId: ticket.id, raw: [{ kind: args.kind, content: args.content }] });
      if (!saved) throw new Error('Memory must be a single useful sentence of at least 20 characters.');
      return { ok: true };
    }
    case 'factory_thread_read':
      return { messages: (await threadMessages(db, threadTicketId, 30)).map((message) => ({ kind: message.kind, at: message.createdAt.toISOString(), body: message.body })) };
    case 'factory_thread_post': {
      const [used] = await db.select({ value: count() }).from(agentMessages)
        .where(and(eq(agentMessages.runId, run.id), eq(agentMessages.kind, 'agent')));
      if ((used?.value ?? 0) >= RUN_CHANNEL_LIMITS.posts) throw new Error('Thread post limit reached for this run.');
      await postThreadMessage(db, {
        threadTicketId, kind: 'agent', body: String(args.body ?? '').slice(0, 4000),
        fromTicketId: ticket.id, runId: run.id, agentId: run.agentId, author: `#${ticket.githubIssueNumber} (live)`,
      });
      return { ok: true };
    }
    case 'factory_team_status': {
      const context = await epicContext(db, ticket);
      return context ? { epic: context.epic, siblings: context.siblings } : { epic: null, siblings: [], note: 'This ticket is not part of an epic.' };
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}
