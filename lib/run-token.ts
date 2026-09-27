import { createHmac } from 'node:crypto';

import { secretMatches } from '@/lib/factory-auth';

// Domain-separated from other uses of the runner secret.
const PURPOSE = 'factory-run-channel:v1:';

/** Bearer token for one run's live channel. Valid only while that run is running. */
export function mintRunToken(runId: string, secret: string) {
  return `${runId}.${createHmac('sha256', secret).update(PURPOSE + runId).digest('base64url')}`;
}

/** Returns the run id a token was minted for, or null. */
export function runIdFromToken(token: string | null, secret: string | undefined) {
  if (!token || !secret) return null;
  const runId = token.split('.')[0];
  if (!/^run_[a-f0-9]{32}$/.test(runId)) return null;
  return secretMatches(token, mintRunToken(runId, secret)) ? runId : null;
}
