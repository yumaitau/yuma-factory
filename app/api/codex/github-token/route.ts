import { and, eq } from "drizzle-orm";
import { accountLeases, codexAccounts, runs } from "@/db/schema";
import { reserveRunAccount } from "@/lib/codex/accounts";
import { getDb } from "@/lib/db";
import { getEnv } from "@/lib/env";
import { secretMatches } from "@/lib/factory-auth";
import { getInstallationToken } from "@/lib/github";
import { getTicketWithContext } from "@/lib/queries";
import { validId, type AccountStatus } from "@/shared/codex";
import { mintRunToken } from "@/lib/run-token";

/** Renew only the installation credential belonging to an active runner job. */
export async function POST(request: Request) {
  const env = getEnv();
  if (!secretMatches(request.headers.get("x-runner-secret"), env.SANDBOX_RUNNER_SECRET))
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  const { id, accountId, action = "renew", accountStatus } = await request.json() as { id: string; accountId: string; action?: string; accountStatus?: AccountStatus };
  if (!["renew", "resume", "pause"].includes(action))
    return Response.json({ error: "Invalid action" }, { status: 400 });
  if (!validId(id) || !validId(accountId))
    return Response.json({ error: "Invalid run" }, { status: 400 });
  const db = await getDb();
  const run = await db.select().from(runs).where(eq(runs.id, id)).get();
  if (!run || !run.requestedByUserId || run.codexAccountId !== accountId)
    return Response.json({ error: "Run is not active" }, { status: 409 });
  if (action === "pause") {
    // Completion can win a concurrent stop. Its account release is already done.
    if (run.status !== 'running') return Response.json({ ok: true });
    // Runner has destroyed the stopped sandbox before releasing its account.
    const status = accountStatus && ["ready", "limited", "error", "disconnected"].includes(accountStatus.status) ? accountStatus.status : undefined;
    const released = await db.delete(accountLeases)
      .where(and(eq(accountLeases.accountId, accountId), eq(accountLeases.holderId, id))).returning({ id: accountLeases.holderId });
    await db.update(codexAccounts).set({ activeRunId: null }).where(and(eq(codexAccounts.id, accountId), eq(codexAccounts.activeRunId, id)));
    if (released.length && status) await db.update(codexAccounts).set({ updatedAt: new Date(), status, error: accountStatus?.error ?? null,
      limitsJson: accountStatus?.limits ? JSON.stringify(accountStatus.limits) : null }).where(eq(codexAccounts.id, accountId));
    return Response.json({ ok: true });
  }
  if (run.status !== 'running')
    return Response.json({ error: "Run is not active" }, { status: 409 });
  const context = await getTicketWithContext(run.ticketId);
  if (!context?.installation)
    return Response.json({ error: "Installation unavailable" }, { status: 409 });
  const token = await getInstallationToken(context.installation.installationId, true, context.project.repoId);
  if (!await reserveRunAccount(accountId, run.requestedByUserId, id, action === "resume", db))
    return Response.json({ error: "Subscription is busy, disabled or needs reconnecting. Recovery will retry." }, { status: 409 });
  // The run token opens this run's live channel (/api/runs/mcp); it dies with the run.
  return Response.json({ token, issuedAt: Date.now(), runToken: mintRunToken(id, env.SANDBOX_RUNNER_SECRET!) }, {
    headers: { "Cache-Control": "no-store" },
  });
}
