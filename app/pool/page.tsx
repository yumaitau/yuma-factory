import { connection } from "next/server";
import { Suspense } from "react";
import { AppShell } from "@/components/factory/app-shell";
import { CodexPool } from "@/components/factory/codex-pool";
import { visibleAccounts } from "@/lib/codex/accounts";
import { requireSession } from "@/lib/session";
export const metadata = { title: "Subscriptions" };
export default function PoolPage() {
  return (
    <Suspense fallback={<p className="p-6">Loading subscriptions…</p>}>
      <Pool />
    </Suspense>
  );
}
async function Pool() {
  await connection();
  const session = await requireSession();
  const entries = await visibleAccounts(session.user.id);
  return (
    <AppShell email={session.user.email}>
      <div className="mb-6">
        <h1 className="text-2xl font-semibold">Subscriptions</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Your existing ChatGPT (Codex) and Claude subscriptions, coordinated for development.
        </p>
      </div>
      <CodexPool entries={entries} userId={session.user.id} />
    </AppShell>
  );
}
