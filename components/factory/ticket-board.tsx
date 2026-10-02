"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

import {
  assignTicketAction,
  moveTicketAction,
  setTicketRiskAction,
  startRunAction,
} from "@/app/actions/factory";
import { Button } from "@/components/ui/button";
import { factoryRisk, ticketRisk, TICKET_RISKS } from "@/shared/ticket-risk";
import { LABEL_PREFIX } from "@/lib/brand";

export type BoardTicket = {
  id: string;
  githubIssueNumber: number;
  title: string;
  stage: string;
  htmlUrl: string;
  assignedAgentId: string | null;
  labels: string[];
};

export type BoardAgent = {
  id: string;
  name: string;
  color: string;
  ownerName: string;
  modelId: string | null;
};

const STAGES: { id: string; label: string }[] = [
  { id: "intake", label: "Intake" },
  { id: "assigned", label: "Assigned" },
  { id: "in_progress", label: "In progress" },
  { id: "review", label: "Review" },
  { id: "done", label: "Done" },
];

export function TicketBoard({
  tickets,
  agents,
  defaultModelId,
}: {
  tickets: BoardTicket[];
  agents: BoardAgent[];
  defaultModelId: string;
}) {
  // Per-ticket, so one slow action never locks every other ticket's controls.
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set());
  const track = async (ticketId: string, work: () => Promise<void>) => {
    setBusy((ids) => new Set(ids).add(ticketId));
    try { await work(); }
    finally { setBusy((ids) => { const next = new Set(ids); next.delete(ticketId); return next; }); }
  };
  const router = useRouter();
  const [error, setError] = useState("");
  const [runRows, setRunRows] = useState<
    {
      id: string;
      ticketId: string;
      status: string;
      log: string;
      pullRequestUrl: string | null;
    }[]
  >([]);
  useEffect(() => {
    const refresh = () => {
      void fetch("/api/codex/status")
        .then((r) => (r.ok ? r.json() : null))
        .then((data) => {
          if (data) {
            setRunRows((data as { runs: typeof runRows }).runs);
            router.refresh();
          }
        })
        .catch(() => {});
    };
    refresh();
    const timer = setInterval(refresh, 10000);
    return () => clearInterval(timer);
  }, [router]);
  const agentById = new Map(agents.map((a) => [a.id, a]));

  return (
    <div className="min-w-0 wrap-anywhere">
      {error && (
        <p role="alert" className="mb-4 text-red-700">
          {error}
        </p>
      )}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
        {STAGES.map((stage) => {
          const items = tickets.filter((t) => t.stage === stage.id);
          return (
            <div
              key={stage.id}
              className="min-w-0 rounded-xl border border-border bg-muted/30 p-3"
            >
              <div className="mb-3 flex items-center justify-between">
                <h3 className="text-sm font-semibold">{stage.label}</h3>
                <span className="text-xs text-muted-foreground">
                  {items.length}
                </span>
              </div>
              <div className="flex flex-col gap-3">
                {items.map((ticket) => {
                  const agent = ticket.assignedAgentId
                    ? agentById.get(ticket.assignedAgentId)
                    : undefined;
                  const risk = ticketRisk(ticket.labels, LABEL_PREFIX);
                  return (
                    <div
                      key={ticket.id}
                      className="min-w-0 rounded-lg border border-border bg-card p-3 shadow-sm"
                    >
                      <Link
                        href={ticket.htmlUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="block wrap-anywhere text-sm font-medium hover:underline"
                      >
                        #{ticket.githubIssueNumber} {ticket.title}
                      </Link>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {risk ? `${risk[0].toUpperCase()}${risk.slice(1)} risk${risk === "low" ? " · auto-merge when CI is green" : ""}` : "No risk rating"}
                      </p>

                      {agent ? (
                        <div className="mt-2 flex items-center gap-1.5">
                          <span
                            className="inline-block h-2.5 w-2.5 shrink-0 rounded-full"
                            style={{ backgroundColor: agent.color }}
                            aria-hidden
                          />
                          <span className="text-xs text-muted-foreground">
                            {agent.name} · {agent.ownerName}
                          </span>
                        </div>
                      ) : null}

                      <div className="mt-3 flex flex-wrap items-center gap-2">
                        <select
                          aria-label="Risk rating"
                          className="min-w-0 w-full max-w-full rounded-md border border-border bg-background px-2 py-1 text-xs"
                          value={factoryRisk(ticket.labels, LABEL_PREFIX) ?? risk ?? ""}
                          disabled={busy.has(ticket.id)}
                          onChange={(e) =>
                            track(ticket.id, async () => {
                              setError("");
                              try {
                                await setTicketRiskAction(ticket.id, e.target.value || null);
                              } catch (err) {
                                setError(err instanceof Error ? err.message : "Could not set risk rating.");
                              }
                            })
                          }
                        >
                          <option value="">Unrated</option>
                          {TICKET_RISKS.map((value) => (
                            <option key={value} value={value}>
                              {value[0].toUpperCase()}{value.slice(1)} risk
                            </option>
                          ))}
                        </select>

                        <select
                          aria-label="Assign agent"
                          className="min-w-0 w-full max-w-full rounded-md border border-border bg-background px-2 py-1 text-xs"
                          value={ticket.assignedAgentId ?? ""}
                          disabled={busy.has(ticket.id)}
                          onChange={(e) =>
                            track(ticket.id, async () => {
                              setError('');
                              try {
                                const result = await assignTicketAction(ticket.id, e.target.value || null);
                                if (result.error) setError(result.error);
                              }
                              catch (error) { setError(error instanceof Error ? error.message : 'Could not reassign ticket.'); }
                            })
                          }
                        >
                          <option value="">Unassigned</option>
                          {agents.map((a) => (
                            <option key={a.id} value={a.id}>
                              {a.name} ({a.ownerName})
                            </option>
                          ))}
                        </select>

                        <select
                          aria-label="Move stage"
                          className="min-w-0 w-full max-w-full rounded-md border border-border bg-background px-2 py-1 text-xs"
                          value={ticket.stage}
                          disabled={busy.has(ticket.id)}
                          onChange={(e) =>
                            track(ticket.id, async () => {
                              setError('');
                              try {
                                const result = await moveTicketAction(ticket.id, e.target.value);
                                if (result.error) setError(result.error);
                              }
                              catch (error) { setError(error instanceof Error ? error.message : 'Could not move ticket.'); }
                            })
                          }
                        >
                          {STAGES.map((s) => (
                            <option key={s.id} value={s.id} disabled={s.id === "done"}>
                              {s.label}
                            </option>
                          ))}
                        </select>

                        {ticket.assignedAgentId &&
                        stage.id !== "in_progress" &&
                        stage.id !== "done" ? (
                          <Button
                            size="sm"
                            disabled={busy.has(ticket.id)}
                            onClick={() =>
                              track(ticket.id, async () => {
                                setError("");
                                try {
                                  const result = await startRunAction(
                                    ticket.id,
                                    ticket.assignedAgentId!,
                                    agentById.get(ticket.assignedAgentId!)
                                      ?.modelId ?? defaultModelId,
                                  );
                                  if (result.error)
                                    throw new Error(result.error);
                                  router.refresh();
                                } catch (e) {
                                  setError(
                                    e instanceof Error
                                      ? e.message
                                      : "Could not start run.",
                                  );
                                }
                              })
                            }
                          >
                            Work it
                          </Button>
                        ) : null}
                      </div>
                    </div>
                  );
                })}
                {items.length === 0 ? (
                  <p className="text-xs text-muted-foreground">Nothing here.</p>
                ) : null}
              </div>
            </div>
          );
        })}
      </div>
      <section className="mt-8">
        <h2 className="mb-3 font-semibold">Your recent runs</h2>
        {runRows
          .filter((run) => tickets.some((ticket) => ticket.id === run.ticketId))
          .map((run) => (
            <details key={run.id} className="mb-2 rounded-md border p-3">
              <summary className="cursor-pointer text-sm">
                {run.id} · {run.status}
              </summary>
              {run.pullRequestUrl && (
                <a
                  className="my-2 block underline"
                  href={run.pullRequestUrl}
                  target="_blank"
                  rel="noreferrer"
                >
                  Open pull request
                </a>
              )}
              <pre className="mt-2 whitespace-pre-wrap break-words text-xs">
                {run.log || "Agent is working in the repository…"}
              </pre>
            </details>
          ))}
      </section>
    </div>
  );
}
