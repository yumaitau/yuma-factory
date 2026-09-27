import 'server-only';

import { FACTORY_OPERATIONS } from '@/lib/factory-catalog';
import { bearerToken, secretMatches } from '@/lib/factory-auth';
import { FactoryApiError, runFactoryOperation } from '@/lib/factory-operations';
import { factoryApiKey } from '@/lib/env';
import { requireApiSession } from '@/lib/session';

function noStore(data: unknown, status = 200) {
  return Response.json(data, { status, headers: { 'Cache-Control': 'private, no-store' } });
}

export async function requireFactoryAccess(request: Request, auth: boolean) {
  if (!auth) return { ok: true as const };
  if (secretMatches(bearerToken(request), factoryApiKey())) return { ok: true as const };
  const session = await requireApiSession();
  if (!session.ok) return session;
  return { ok: true as const };
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
  const url = new URL(request.url);
  url.searchParams.forEach((value, key) => { args[key] = value; });
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
  const access = await requireFactoryAccess(request, operation.auth);
  if (!access.ok) return access.response;
  let body: Record<string, unknown> = {};
  if (request.method !== 'GET' && request.headers.get('content-type')?.includes('application/json')) {
    const parsed: unknown = await request.json().catch(() => null);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) body = parsed as Record<string, unknown>;
  }
  try {
    const result = await runFactoryOperation(operation.id, argsFrom(operation.path, segments, request, body));
    return noStore(result);
  } catch (error) {
    if (error instanceof FactoryApiError) return noStore({ error: error.message }, error.status);
    throw error;
  }
}