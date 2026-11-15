/**
 * One line in Workers Logs for a failure the caller carries on from. Only the error's name and message are
 * written, never the error object: a request error can carry headers and bodies.
 */
export function logFailure(step: string, error: unknown, context: Record<string, string> = {}) {
  const message = error instanceof Error ? `${error.name}: ${error.message}` : 'Unknown error';
  console.error(`[factory] ${step} failed`, JSON.stringify({ ...context, message: message.slice(0, 500) }));
}
