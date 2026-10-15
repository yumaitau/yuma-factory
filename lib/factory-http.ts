import 'server-only';

import { FACTORY_OPERATIONS } from '@/lib/factory-catalog';
import { bearerActor, bearerToken, crossOrigin } from '@/lib/factory-auth';
import { FactoryApiError, runFactoryOperation } from '@/lib/factory-operations';
import { factoryApiKey } from '@/lib/env';
import { requireApiSession } from '@/lib/session';
import { apiKeyOwner } from '@/lib/api-keys';
import { getDb } from '@/lib/db';

function noStore(data: unknown, status = 200) {
  return Response.json(data, { status, headers: { 'Cache-Control': 'private, no-store' } });
}

/**
 * Who is calling: a personal API key or a session acts as that person. The shared FACTORY_API_KEY
 * has no person, so it reaches only operations that do not act as someone.
 */
export type { FactoryActor } from '@/lib/factory-auth';

/**
 * Mutating calls need a bearer token: a session cookie travels with any same-site request, so it
 * would let another page on the site act as a signed-in person.
 */
export async function requireFactoryAccess(request: Request, auth: boolean, mutating = false) {
  const token = bearerToken(request);
  if (token) return bearerActor(token, async (key) => apiKeyOwner(await getDb(), key), factoryApiKey());
  if (!auth) return { ok: true as const, actor: { userId: null } };
  if (mutating) return { ok: false as const, response: noStore({ error: 'Changes need an API key: Authorization: Bearer <key>.' }, 401) };
  const session = await requireApiSession();
  if (!session.ok) return session;
  return { ok: true as const, actor: { userId: session.session.user.id } };
}

function matchOperation(method: string, segments: string[]) {
  return FACTORY_OPERATIONS.find((operation) => {
    if (operation.method !== method) return false;
    const parts = operation.path.split('/').filter(Boolean);
    if (parts.length !== segments.length) return false;
    return parts.every((part, index) => part.startsWith('{') || part === segments[index]);
  }) ?? null;
}

function argsFrom(operationPath: string, segments: string[], request: Request, body: Record<string, unknown>) {
  const args: Record<string, unknown> = { ...body };
  // Only reads take query parameters; a change must come as a JSON body.
  if (request.method === 'GET') new URL(request.url).searchParams.forEach((value, key) => { args[key] = value; });
  operationPath.split('/').filter(Boolean).forEach((part, index) => {
    const match = /^\{(.+)\}$/.exec(part);
    if (match) args[match[1]] = segments[index];
  });
  return args;
}

export async function handleFactoryApi(request: Request) {
  const url = new URL(request.url);
  const relative = url.pathname.replace(/^\/api\/v1\/?/, '');
  const segments = relative ? relative.split('/').filter(Boolean) : [];
  const operation = matchOperation(request.method, segments);
  if (!operation) return noStore({ error: 'Not found' }, 404);
  if (crossOrigin(request)) return noStore({ error: 'Cross-origin API requests are not allowed.' }, 403);
  const access = await requireFactoryAccess(request, operation.auth, operation.mutating);
  if (!access.ok) return access.response;
  let body: Record<string, unknown> = {};
  if (request.method !== 'GET' && request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() === 'application/json') {
    const parsed: unknown = await request.json().catch(() => null);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) body = parsed as Record<string, unknown>;
  }
  try {
    const result = await runFactoryOperation(operation.id, argsFrom(operation.path, segments, request, body), access.actor);
    return noStore(result);
  } catch (error) {
    if (error instanceof FactoryApiError) return noStore({ error: error.message }, error.status);
    throw error;
  }
}