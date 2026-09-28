"use client";
import { formatSydneyDateTime } from '@/lib/datetime';
import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  connectCodexAction,
  refreshCodexAction,
  disconnectCodexAction,
  shareCodexAction,
  setCodexEnabledAction,
  setCodexMaxRunsAction,
  reconnectCodexAction,
  testCodexAction,
  testCodexStatusAction,
  type ActionResult,
} from "@/app/actions/codex";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { MAX_PARALLEL_RUNS, type AccountStatus, type RunResult } from "@/shared/codex";

async function call<T>(promise: Promise<ActionResult<T>>): Promise<T> {
  const result = await promise;
  if (result.error !== undefined) throw new Error(result.error);
  return result.data as T;
}

type Entry = {
  id: string;
  label: string;
  ownerUserId: string;
  email: string | null;
  plan: string | null;
  status: string;
  shared: boolean;
  enabled: boolean;
  activeRunId: string | null;
  maxRuns: number;
  runningRuns: number;
  limitsJson: string | null;
  error: string | null;
};
export function CodexPool({
  entries,
  userId,
}: {
  entries: Entry[];
  userId: string;
}) {
  const [pending, start] = useTransition();
  const [error, setError] = useState("");
  const [probe, setProbe] = useState<{ id: string; runId: string } | null>(
    null,
  );
  const [testResult, setTestResult] = useState<RunResult | null>(null);
  const [login, setLogin] = useState<(AccountStatus & { id: string }) | null>(
    null,
  );
  const form = useRef<HTMLFormElement>(null);
  const router = useRouter();
  const act = (fn: () => Promise<unknown>) =>
    start(async () => {
      setError("");
      try {
        await fn();
        router.refresh();
      } catch (e) {
        setError(e instanceof Error ? e.message : "Request failed.");
      }
    });
  useEffect(() => {
    if (!login || login.status !== "connecting") return;
    const timer = setInterval(() => {
      void call(refreshCodexAction(login.id))
        .then((s) => {
          setLogin(s as AccountStatus & { id: string });
          router.refresh();
        })
        .catch((e) => setError(e.message));
    }, 5000);
    return () => clearInterval(timer);
  }, [login, router]);
  useEffect(() => {
    if (!probe) return;
    const timer = setInterval(() => {
      void call(testCodexStatusAction(probe.id, probe.runId))
        .then((result) => {
          setTestResult(result);
          if (result.status !== "running") {
            setProbe(null);
            router.refresh();
          }
        })
        .catch((e) => setError(e.message));
    }, 5000);
    return () => clearInterval(timer);
  }, [probe, router]);
  return (
    <>
      <Card className="mb-6 p-5">
        <h2 className="mb-2 text-lg font-semibold">
          Connect a Codex subscription
        </h2>
        <p className="mb-4 text-sm text-muted-foreground">
          Sign in with each ChatGPT account. Each subscription keeps its own
          usage limits; one development run uses one account at a time.
        </p>
        <form
          ref={form}
          action={(data) =>
            act(async () => {
              const result = await call(connectCodexAction(data));
              setLogin(result);
              form.current?.reset();
            })
          }
          className="space-y-4"
        >
          <div>
            <Label htmlFor="codex-label">Account name</Label>
            <Input
              id="codex-label"
              name="label"
              required
              maxLength={80}
              placeholder="Justin’s Codex"
            />
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" name="enabled" defaultChecked />
            Enable for new work after connecting
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" name="shared" />
            Allow team members to assign work to this subscription
          </label>
          <details>
            <summary className="cursor-pointer text-sm">
              Already signed in to Codex on another machine?
            </summary>
            <p className="my-2 text-sm text-muted-foreground">
              Import that account’s auth.json login file instead of signing in
              again. It is stored encrypted and never shown to other members.
            </p>
            <Label htmlFor="codex-auth">Codex login file (optional)</Label>
            <Input
              id="codex-auth"
              name="authFile"
              type="file"
              accept=".json,application/json"
            />
          </details>
          <Button disabled={pending}>
            {pending ? "Connecting…" : "Connect Codex"}
          </Button>
        </form>
        {login?.status === "connecting" && login.verificationUrl && (
          <div className="mt-4 rounded-md bg-muted p-4">
            <p>
              Open{" "}
              <a
                className="underline"
                href={login.verificationUrl}
                target="_blank"
                rel="noreferrer"
              >
                Codex sign-in
              </a>{" "}
              and enter:
            </p>
            <p className="my-2 font-mono text-xl">{login.userCode}</p>
            <p className="text-sm">
              Waiting for authorization. Enable device-code login in ChatGPT
              security settings if prompted.
            </p>
          </div>
        )}
        {login?.status === "ready" && (
          <p role="status" className="mt-3 text-sm">
            Subscription connected.
          </p>
        )}
        {error && (
          <p role="alert" className="mt-3 text-sm text-red-700">
            {error}
          </p>
        )}
      </Card>
      {testResult && (
        <Card className="mb-6 p-5">
          <h2 className="font-semibold">
            Connection test: {testResult.status}
          </h2>
          <pre className="mt-2 whitespace-pre-wrap text-sm">
            {testResult.log}
          </pre>
        </Card>
      )}
      {!entries.length && (
        <p className="text-sm text-muted-foreground">
          No subscriptions connected yet. Connect an account to start
          development runs.
        </p>
      )}
      <div className="grid gap-4 md:grid-cols-2">
        {entries.map((entry) => {
          const limits = entry.limitsJson
            ? (JSON.parse(entry.limitsJson) as AccountStatus["limits"])
            : null;
          const own = entry.ownerUserId === userId;
          // Maintenance needs the subscription to itself: no runs and no other operation.
          const busy = !!entry.activeRunId || entry.runningRuns > 0;
          return (
            <Card key={entry.id} className="p-5">
              <div className="flex justify-between gap-3">
                <h2 className="font-semibold">{entry.label}</h2>
                <span className="text-sm">
                  {!entry.enabled ? (entry.runningRuns ? "Disabled · finishing current runs" : "Disabled")
                    : entry.runningRuns ? `Running ${entry.runningRuns}/${entry.maxRuns}` : entry.activeRunId ? "Busy" : entry.status}
                </span>
              </div>
              <p className="mt-1 text-sm text-muted-foreground">
                {entry.email ?? "Not signed in"}
                {entry.plan ? ` · ${entry.plan}` : ""}
              </p>
              {["primary", "secondary"].map((key, i) => {
                const w = limits?.[key as "primary" | "secondary"];
                return w ? (
                  <div className="mt-3" key={key}>
                    <p className="text-xs">
                      {i ? "Weekly / longer window" : "Current window"}:{" "}
                      {Math.max(0, 100 - w.usedPercent)}% remaining · resets{" "}
                      {w.resetsAt
                        ? formatSydneyDateTime(w.resetsAt * 1000)
                        : "not reported"}
                    </p>
                    <progress
                      className="mt-1 w-full"
                      max={100}
                      value={Math.max(0, 100 - w.usedPercent)}
                    />
                  </div>
                ) : null;
              })}
              {!limits && (
                <p className="mt-3 text-xs text-muted-foreground">
                  Usage availability not yet reported by Codex.
                </p>
              )}
              {entry.error && (
                <p className="mt-3 text-sm text-red-700">{entry.error}</p>
              )}
              <p className="mt-3 text-xs">
                {!entry.enabled ? "Excluded from new work. Credentials stay connected." : entry.shared
                  ? "Available to team"
                  : "Only available to account owner"}
              </p>
              {entry.shared && <p className="mt-1 text-xs text-muted-foreground">Team members can enable or disable this subscription for everyone.</p>}
              <label className="mt-3 flex items-center gap-2 text-xs">Parallel runs
                <select aria-label="Parallel runs" className="rounded-md border bg-background px-2 py-1" value={entry.maxRuns}
                  disabled={pending || !own} onChange={(event) => act(() => call(setCodexMaxRunsAction(entry.id, Number(event.target.value))))}>
                  {Array.from({ length: MAX_PARALLEL_RUNS }, (_, i) => i + 1).map((value) => <option key={value} value={value}>{value}</option>)}
                </select>
                <span className="text-muted-foreground">tickets at once. More runs use usage limits faster.</span>
              </label>
              {(own || entry.shared) && (
                <div className="mt-4 flex flex-wrap gap-2">
                  <Button size="sm" variant="outline" disabled={pending}
                    onClick={() => act(() => call(setCodexEnabledAction(entry.id, !entry.enabled)))}>
                    {entry.enabled ? "Disable subscription" : "Enable subscription"}
                  </Button>
                  {own && <>
                  <Button
                    size="sm"
                    disabled={
                      pending || !entry.enabled || busy || entry.status !== "ready"
                    }
                    onClick={() =>
                      act(async () => {
                        setProbe(await call(testCodexAction(entry.id)));
                        setTestResult({
                          status: "running",
                          log: "Running a small coding task and its test using this subscription…",
                        });
                      })
                    }
                  >
                    Test connection
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={pending || busy}
                    onClick={() =>
                      act(async () =>
                        setLogin(await call(reconnectCodexAction(entry.id))),
                      )
                    }
                  >
                    Reconnect
                  </Button>
                  <Button
                    size="sm"
                    disabled={pending || busy}
                    onClick={() =>
                      act(async () => {
                        const s = await call(refreshCodexAction(entry.id));
                        setLogin(s as AccountStatus & { id: string });
                      })
                    }
                  >
                    Refresh status
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={pending}
                    onClick={() =>
                      act(() => call(shareCodexAction(entry.id, !entry.shared)))
                    }
                  >
                    {entry.shared ? "Stop sharing" : "Share with team"}
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={pending || busy}
                    onClick={() =>
                      act(() => call(disconnectCodexAction(entry.id)))
                    }
                  >
                    Disconnect
                  </Button>
                  </>}
                </div>
              )}
            </Card>
          );
        })}
      </div>
    </>
  );
}
