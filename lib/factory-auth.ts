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