import 'server-only';

import { FACTORY_OPERATIONS, factoryCapabilities } from '@/lib/factory-catalog';
import { FactoryApiError, runFactoryOperation } from '@/lib/factory-operations';
import { crossOrigin, type FactoryActor } from '@/lib/factory-auth';
import { requireFactoryAccess } from '@/lib/factory-http';

const PROTOCOL = '2025-03-26';

type Rpc = { jsonrpc?: string; id?: string | number | null; method?: string; params?: unknown };

function rpcResult(id: string | number | null | undefined, result: unknown) {
  return { jsonrpc: '2.0', id: id ?? null, result };
}

function rpcError(id: string | number | null | undefined, code: number, message: string) {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

function noStore(data: unknown, status = 200) {
  return Response.json(data, { status, headers: { 'Cache-Control': 'private, no-store' } });
}


function toolsList() {
  return {
    tools: FACTORY_OPERATIONS.filter((operation) => operation.mcp).map((operation) => ({
      name: operation.mcp,
      description: operation.description,
      inputSchema: operation.input ?? { type: 'object', properties: {}, additionalProperties: false },
    })),
  };
}

export async function handleFactoryMcp(request: Request) {
  if (crossOrigin(request))
    return noStore({ error: { code: 'forbidden', message: 'Cross-origin MCP requests are not allowed.' } }, 403);
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: { Allow: 'GET, POST, OPTIONS', 'Cache-Control': 'private, no-store' } });
  }
  // Tool calls can change things, so MCP POSTs need a bearer key, never a session cookie alone.
  const access = await requireFactoryAccess(request, true, request.method === 'POST');
  if (!access.ok) return access.response;
  if (request.method === 'GET') {
    return noStore({ ...factoryCapabilities(), protocolVersion: PROTOCOL, transport: 'streamable-http' });
  }
  if (request.method !== 'POST') return noStore({ error: 'Method not allowed' }, 405);
  const body: unknown = await request.json().catch(() => null);
  if (!body || typeof body !== 'object') return noStore(rpcError(null, -32700, 'Parse error'), 400);
  const messages = Array.isArray(body) ? body : [body];
  const responses = [];
  for (const raw of messages) {
    const message = raw as Rpc;
    if (message.jsonrpc !== '2.0' || typeof message.method !== 'string') {
      responses.push(rpcError(message.id ?? null, -32600, 'Invalid request'));
      continue;
    }
    if (message.id === undefined && message.method.startsWith('notifications/')) continue;
    try {
      responses.push(await dispatchMcp(message, access.actor));
    } catch (error) {
      // Only Factory's own refusals reach the client; anything else may carry runner or database detail.
      if (error instanceof FactoryApiError) responses.push(rpcError(message.id ?? null, -32000, error.message));
      else responses.push(rpcError(message.id ?? null, -32603, 'Internal error'));
    }
  }
  if (!responses.length) return new Response(null, { status: 204, headers: { 'Cache-Control': 'private, no-store' } });
  return noStore(Array.isArray(body) ? responses : responses[0]);
}

async function dispatchMcp(message: Rpc, actor: FactoryActor) {
  const id = message.id ?? null;
  switch (message.method) {
    case 'initialize':
      return rpcResult(id, {
        protocolVersion: PROTOCOL,
        capabilities: { tools: {}, resources: {} },
        serverInfo: { name: 'factory', version: '1.0.0' },
      });
    case 'ping':
      return rpcResult(id, {});
    case 'tools/list':
      return rpcResult(id, toolsList());
    case 'resources/list':
      return rpcResult(id, {
        resources: [
          { uri: 'factory://docs/api', name: 'Factory API and MCP catalog', mimeType: 'application/json' },
        ],
      });
    case 'resources/read': {
      const uri = message.params && typeof message.params === 'object' ? (message.params as { uri?: unknown }).uri : null;
      if (uri !== 'factory://docs/api') return rpcError(id, -32602, 'Unknown resource.');
      return rpcResult(id, { contents: [{ uri: 'factory://docs/api', mimeType: 'application/json', text: JSON.stringify(factoryCapabilities()) }] });
    }
    case 'tools/call': {
      const params = message.params && typeof message.params === 'object' ? message.params as { name?: unknown; arguments?: unknown } : {};
      const name = typeof params.name === 'string' ? params.name : '';
      const operation = FACTORY_OPERATIONS.find((item) => item.mcp === name);
      if (!operation) return rpcError(id, -32601, `Unknown tool: ${name}`);
      const args = params.arguments && typeof params.arguments === 'object' && !Array.isArray(params.arguments)
        ? params.arguments as Record<string, unknown>
        : {};
      const result = await runFactoryOperation(operation.id, args, actor);
      return rpcResult(id, { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result });
    }
    default:
      return rpcError(id, -32601, `Method not found: ${message.method}`);
  }
}