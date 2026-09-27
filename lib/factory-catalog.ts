import { APP_NAME } from '@/lib/brand';
import { appUrl, paperboyConfig } from '@/lib/env';

export type FactoryOperation = {
  id: string;
  method: 'GET' | 'POST';
  path: string;
  mcp: string | null;
  auth: boolean;
  mutating: boolean;
  description: string;
  input?: Record<string, unknown>;
};

export const FACTORY_OPERATIONS: FactoryOperation[] = [
  { id: 'listCapabilities', method: 'GET', path: '', mcp: 'factory_list_capabilities', auth: false, mutating: false,
    description: 'List Factory HTTP routes and MCP tools.' },
  { id: 'getOpenApi', method: 'GET', path: 'openapi.json', mcp: null, auth: false, mutating: false,
    description: 'OpenAPI 3.1 document for the Factory HTTP API.' },
  { id: 'getStatus', method: 'GET', path: 'status', mcp: 'factory_get_status', auth: true, mutating: false,
    description: 'PaperBoy, API-key, and last digest status.' },
  { id: 'listOutstanding', method: 'GET', path: 'outstanding', mcp: 'factory_list_outstanding', auth: true, mutating: false,
    description: 'Work-board items that are not done, plus open Factory PRs.' },
  { id: 'listWork', method: 'GET', path: 'work', mcp: 'factory_list_work', auth: true, mutating: false,
    description: 'Full live work-board cards.' },
  { id: 'listReviewQueue', method: 'GET', path: 'work/review', mcp: 'factory_list_review_queue', auth: true, mutating: false,
    description: 'Open Factory pull requests still waiting for review.' },
  { id: 'listProjects', method: 'GET', path: 'projects', mcp: 'factory_list_projects', auth: true, mutating: false,
    description: 'Active connected GitHub repositories.' },
  { id: 'listTickets', method: 'GET', path: 'tickets', mcp: 'factory_list_tickets', auth: true, mutating: false,
    description: 'Tickets on active projects. Optional projectId filter.',
    input: { type: 'object', properties: { projectId: { type: 'string' } }, additionalProperties: false } },
  { id: 'getTicket', method: 'GET', path: 'tickets/{ticketId}', mcp: 'factory_get_ticket', auth: true, mutating: false,
    description: 'One ticket with project and assignee, without GitHub installation tokens.',
    input: { type: 'object', properties: { ticketId: { type: 'string' } }, required: ['ticketId'], additionalProperties: false } },
  { id: 'listAgents', method: 'GET', path: 'agents', mcp: 'factory_list_agents', auth: true, mutating: false,
    description: 'Factory agents and owners.' },
  { id: 'getRun', method: 'GET', path: 'runs/{runId}', mcp: 'factory_get_run', auth: true, mutating: false,
    description: 'One run without execution logs.',
    input: { type: 'object', properties: { runId: { type: 'string' } }, required: ['runId'], additionalProperties: false } },
  { id: 'getAutomation', method: 'GET', path: 'automation', mcp: 'factory_get_automation', auth: true, mutating: false,
    description: 'Background worker pool status.' },
  { id: 'enqueuePickup', method: 'POST', path: 'automation/pickup', mcp: 'factory_enqueue_pickup', auth: true, mutating: true,
    description: 'Queue a pickup if the background worker is enabled.' },
  { id: 'previewDigest', method: 'GET', path: 'digest', mcp: 'factory_preview_digest', auth: true, mutating: false,
    description: 'Render the outstanding digest without sending mail.' },
  { id: 'sendDigest', method: 'POST', path: 'digest', mcp: 'factory_send_digest', auth: true, mutating: true,
    description: 'Send the outstanding digest through PaperBoy.',
    input: { type: 'object', properties: { force: { type: 'boolean' } }, additionalProperties: false } },
  { id: 'listMemories', method: 'GET', path: 'memories', mcp: 'factory_list_memories', auth: true, mutating: false,
    description: 'Team memory injected into agent runs. projectId filters to one project; "global" to shared memory; status to active, suggested or archived.',
    input: { type: 'object', properties: { projectId: { type: 'string' }, status: { type: 'string' } }, additionalProperties: false } },
  { id: 'previewMemory', method: 'GET', path: 'memories/preview', mcp: 'factory_preview_memory', auth: true, mutating: false,
    description: 'The ranked memory block a ticket in this project would receive.',
    input: { type: 'object', properties: { projectId: { type: 'string' }, text: { type: 'string' } }, required: ['projectId'], additionalProperties: false } },
  { id: 'createMemory', method: 'POST', path: 'memories', mcp: 'factory_create_memory', auth: true, mutating: true,
    description: 'Teach Factory something about your software. Omit projectId for memory shared by every project.',
    input: { type: 'object', properties: { projectId: { type: 'string' }, kind: { type: 'string', enum: ['convention', 'architecture', 'gotcha', 'command', 'decision', 'note'] }, content: { type: 'string' }, weight: { type: 'number' }, pinned: { type: 'boolean' } }, required: ['content'], additionalProperties: false } },
  { id: 'updateMemory', method: 'POST', path: 'memories/{memoryId}', mcp: 'factory_update_memory', auth: true, mutating: true,
    description: 'Tune a memory: edit content or kind, set weight 0-100, pin, or change status (active, suggested, archived). Every change is audited.',
    input: { type: 'object', properties: { memoryId: { type: 'string' }, kind: { type: 'string' }, content: { type: 'string' }, weight: { type: 'number' }, pinned: { type: 'boolean' }, status: { type: 'string', enum: ['active', 'suggested', 'archived'] } }, required: ['memoryId'], additionalProperties: false } },
  { id: 'listPlans', method: 'GET', path: 'plans', mcp: 'factory_list_plans', auth: true, mutating: false,
    description: 'Planner breakdowns of epics into subtasks, with approval status.' },
  { id: 'approvePlan', method: 'POST', path: 'plans/{planId}/approve', mcp: 'factory_approve_plan', auth: true, mutating: true,
    description: 'Approve a proposed plan: creates GitHub sub-issues labelled for pickup, with blockers.',
    input: { type: 'object', properties: { planId: { type: 'string' } }, required: ['planId'], additionalProperties: false } },
  { id: 'rejectPlan', method: 'POST', path: 'plans/{planId}/reject', mcp: 'factory_reject_plan', auth: true, mutating: true,
    description: 'Reject a proposed plan.',
    input: { type: 'object', properties: { planId: { type: 'string' } }, required: ['planId'], additionalProperties: false } },
  { id: 'listMessages', method: 'GET', path: 'tickets/{ticketId}/messages', mcp: 'factory_list_messages', auth: true, mutating: false,
    description: 'Epic thread: planner notes, agent handoffs and team guidance.',
    input: { type: 'object', properties: { ticketId: { type: 'string' } }, required: ['ticketId'], additionalProperties: false } },
  { id: 'postMessage', method: 'POST', path: 'tickets/{ticketId}/messages', mcp: 'factory_post_message', auth: true, mutating: true,
    description: 'Add team guidance to an epic thread. Agents on its subtasks read it at their next run.',
    input: { type: 'object', properties: { ticketId: { type: 'string' }, body: { type: 'string' } }, required: ['ticketId', 'body'], additionalProperties: false } },
];

export function factoryCapabilities() {
  return {
    name: 'factory',
    baseUrl: appUrl(),
    transports: { http: '/api/v1', mcp: '/api/mcp' },
    from: paperboyConfig()?.from ?? null,
    operations: FACTORY_OPERATIONS.map(({ id, method, path, mcp, auth, mutating, description }) => ({
      id, method, path: `/api/v1/${path}`.replace(/\/$/, '') || '/api/v1', mcp, auth, mutating, description,
    })),
  };
}

export function factoryOpenApi() {
  const paths: Record<string, unknown> = {};
  for (const operation of FACTORY_OPERATIONS) {
    const path = `/api/v1/${operation.path}`.replace(/\/$/, '') || '/api/v1';
    const item = (paths[path] as Record<string, unknown>) ?? {};
    item[operation.method.toLowerCase()] = {
      operationId: operation.id,
      summary: operation.description,
      security: operation.auth ? [{ bearerAuth: [] }] : [],
      'x-factory-mcp': operation.mcp,
    };
    paths[path] = item;
  }
  return {
    openapi: '3.1.0',
    info: { title: `${APP_NAME} HTTP API`, version: '1.0.0' },
    servers: [{ url: appUrl() }],
    security: [{ bearerAuth: [] }],
    paths,
    components: {
      securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer' } },
    },
    'x-factory-mcp': {
      url: `${appUrl()}/api/mcp`,
      equivalents: Object.fromEntries(FACTORY_OPERATIONS.filter((operation) => operation.mcp).map((operation) => [operation.id, operation.mcp])),
    },
  };
}