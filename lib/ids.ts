/**
 * Prefixed, sortable-ish ids. crypto.randomUUID is available in the Workers
 * runtime and in Node 22 used for local dev.
 */
export function newId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, '')}`;
}
