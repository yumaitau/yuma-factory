import { eq } from 'drizzle-orm';

import { projects, tickets } from '@/db/schema';
import { getDb } from '@/lib/db';
import { getEnv, githubAppCredentials } from '@/lib/env';
import { enqueuePickup } from '@/lib/automation-queue';
import { LABELS } from '@/lib/brand';
import { planLinkForBody } from '@/lib/collab-store';

/**
 * GitHub App webhook receiver. Verifies the HMAC-SHA256 signature against
 * GITHUB_APP_WEBHOOK_SECRET, then reconciles issue events into tickets.
 *
 * This route is intentionally NOT session-guarded — GitHub calls it. The
 * signature check is the authentication. Requests without a valid signature
 * are rejected with 401.
 */
export async function POST(request: Request) {
  const creds = githubAppCredentials(getEnv());
  if (!creds?.webhookSecret) {
    return Response.json({ error: 'Webhook secret not configured.' }, { status: 400 });
  }

  const signature = request.headers.get('x-hub-signature-256');
  const event = request.headers.get('x-github-event');
  const raw = await request.text();

  if (!signature || !(await verifySignature(creds.webhookSecret, raw, signature))) {
    return Response.json({ error: 'Invalid signature.' }, { status: 401 });
  }

  if (event === 'issues') {
    const payload = JSON.parse(raw);
    const tracked = await handleIssueEvent(payload);
    if (tracked && payload.issue?.state === 'open' && payload.issue.labels?.some((label: string | { name?: string }) =>
      [LABELS.ready, LABELS.plan].includes((typeof label === 'string' ? label : label.name)?.toLowerCase() ?? ''))) {
      await enqueuePickup(`GitHub issue ${payload.action}`);
    }
  }
  // Other events (installation, installation_repositories, pull_request) can be
  // added here later; unhandled events are acknowledged so GitHub stops retrying.
  return Response.json({ ok: true });
}

async function handleIssueEvent(payload: {
  action: string;
  issue: {
    id: number;
    number: number;
    title: string;
    body: string | null;
    state: string;
    html_url: string;
    labels: Array<string | { name?: string }>;
    pull_request?: unknown;
  };
  repository: { id: number };
}) {
  // Ignore PRs surfaced through the issues event.
  if (payload.issue.pull_request) return false;

  const db = await getDb();
  const project = await db
    .select()
    .from(projects)
    .where(eq(projects.repoId, payload.repository.id))
    .get();
  if (!project) return false; // repo not tracked as a project

  const labels = payload.issue.labels
    .map((l) => (typeof l === 'string' ? l : (l.name ?? '')))
    .filter(Boolean);

  const now = new Date();
  const { newId } = await import('@/lib/ids');
  // Subtasks carry a plan marker, so one created just before a crash still joins its epic.
  const link = await planLinkForBody(db, payload.issue.body);
  await db.insert(tickets).values({
    id: newId('tkt'),
    projectId: project.id,
    githubIssueNumber: payload.issue.number,
    githubIssueId: payload.issue.id,
    title: payload.issue.title,
    body: payload.issue.body,
    labels: JSON.stringify(labels),
    githubState: payload.issue.state,
    stage: 'intake',
    htmlUrl: payload.issue.html_url,
    ...(link ?? {}),
    createdAt: now,
    updatedAt: now,
  }).onConflictDoUpdate({ target: [tickets.projectId, tickets.githubIssueNumber], set: {
    title: payload.issue.title, body: payload.issue.body, labels: JSON.stringify(labels),
    githubState: payload.issue.state, htmlUrl: payload.issue.html_url, ...(link ?? {}), updatedAt: now,
  } });
  return true;
}

/**
 * Verify GitHub's x-hub-signature-256 using the Web Crypto API (available on
 * the Workers runtime). Constant-time comparison via crypto.subtle.verify.
 */
async function verifySignature(secret: string, body: string, signature: string): Promise<boolean> {
  const expectedPrefix = 'sha256=';
  if (!signature.startsWith(expectedPrefix)) return false;
  const sigHex = signature.slice(expectedPrefix.length);
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['verify'],
  );
  const sigBytes = hexToBytes(sigHex);
  if (!sigBytes) return false;
  return crypto.subtle.verify('HMAC', key, sigBytes, new TextEncoder().encode(body));
}

function hexToBytes(hex: string): Uint8Array<ArrayBuffer> | null {
  if (hex.length % 2 !== 0 || /[^0-9a-fA-F]/.test(hex)) return null;
  const bytes = new Uint8Array(new ArrayBuffer(hex.length / 2));
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}
