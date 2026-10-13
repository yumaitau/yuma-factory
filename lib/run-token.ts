import { createHmac } from 'node:crypto';

import { secretMatches } from '@/lib/factory-auth';

// Domain-separated from other uses of the runner secret.
const PURPOSE = 'factory-run-channel:v1:';
// The merge token stays with the root-owned bridge. The agent holds the channel token, so it can never merge.
const MERGE_PURPOSE = 'factory-run-merge:v1:';

/** Bearer token for one run's live channel. Valid only while that run is running. */
export function mintRunToken(runId: string, secret: string, purpose = PURPOSE) {
  return `${runId}.${createHmac('sha256', secret).update(purpose + runId).digest('base64url')}`;
}
export const mintMergeToken = (runId: string, secret: string) => mintRunToken(runId, secret, MERGE_PURPOSE);

/** Returns the run id a token was minted for, or null. */
export function runIdFromToken(token: string | null, secret: string | undefined, purpose = PURPOSE) {
  if (!token || !secret) return null;
  const runId = token.split('.')[0];
  if (!/^run_[a-f0-9]{32}$/.test(runId)) return null;
  return secretMatches(token, mintRunToken(runId, secret, purpose)) ? runId : null;
}
export const runIdFromMergeToken = (token: string | null, secret: string | undefined) => runIdFromToken(token, secret, MERGE_PURPOSE);
