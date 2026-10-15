import { createHash, timingSafeEqual } from 'node:crypto';

export function bearerToken(request: Request): string | null {
  const header = request.headers.get('authorization');
  if (!header) return null;
  const match = /^Bearer\s+(\S+)/i.exec(header.trim());
  return match?.[1] ?? null;
}

/** Compare secrets as SHA-256 digests so length differences cannot short-circuit. */
export function secretMatches(supplied: string | null, expected: string | undefined): boolean {
  if (!expected || !supplied) return false;
  const left = createHash('sha256').update(expected).digest();
  const right = createHash('sha256').update(supplied).digest();
  return left.length === right.length && timingSafeEqual(left, right);
}
/** Who is calling. A personal key or session is a person; the shared key is nobody in particular. */
export type FactoryActor = { userId: string | null };

const unauthorised = () => ({ ok: false as const, response: Response.json({ error: 'Unauthorised' },
  { status: 401, headers: { 'Cache-Control': 'private, no-store' } }) });

/** A bearer token decides alone: an invalid one is refused, never replaced by a session cookie. */
export async function bearerActor(token: string, resolveKey: (token: string) => Promise<string | null>, sharedKey: string | undefined) {
  if (token.startsWith('fk_')) {
    const userId = await resolveKey(token);
    return userId ? { ok: true as const, actor: { userId } as FactoryActor } : unauthorised();
  }
  return secretMatches(token, sharedKey) ? { ok: true as const, actor: { userId: null } as FactoryActor } : unauthorised();
}

/** Browsers send Origin on cross-site requests; machine clients do not. */
export function crossOrigin(request: Request) {
  const origin = request.headers.get('origin');
  if (!origin) return false;
  try { return new URL(origin).origin !== new URL(request.url).origin; } catch { return true; }
}
