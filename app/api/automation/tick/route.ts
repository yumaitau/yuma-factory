import { createHash, timingSafeEqual } from 'node:crypto';
import { getEnv } from '@/lib/env';
import { runAutomation } from '@/lib/automation';
import { maybeSendMorningDigest } from '@/lib/digest';

export async function POST(request: Request) {
  const expected = getEnv().SANDBOX_RUNNER_SECRET;
  const supplied = request.headers.get('x-runner-secret');
  if (!expected || !supplied || !timingSafeEqual(
    createHash('sha256').update(expected).digest(), createHash('sha256').update(supplied).digest(),
  )) return Response.json({ error: 'Unauthorized' }, { status: 401 });
  const scheduledAt = Number(request.headers.get('x-scheduled-at'));
  const when = Number.isSafeInteger(scheduledAt) && scheduledAt > 0 ? new Date(scheduledAt) : new Date();
  // Default to the cheap pickup: only an explicit 'sync' triggers full board reconciliation.
  const result = await runAutomation(Number.isSafeInteger(scheduledAt) && scheduledAt > 0 ? when : undefined,
    request.headers.get('x-automation-mode') === 'sync' ? 'sync' : 'pickup');
  const digest = await maybeSendMorningDigest(when);
  return Response.json({ ...result, digest }, { status: 'busy' in result && result.busy ? 409 : 200 });
}
