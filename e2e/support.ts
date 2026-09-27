export function uniqueEmail(engine: string) {
  return `${engine}-${crypto.randomUUID()}@example.com`;
}

export async function cleanupUser(email: string, request: { post: (url: string, options: { data: { email: string } }) => Promise<unknown> }) {
  try {
    await request.post('/api/e2e/cleanup', { data: { email } });
  } catch {
    // Best-effort; the test may already have closed the browser.
  }
}
