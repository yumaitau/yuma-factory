"use client";

import { startTransition, useEffect, useOptimistic, useRef, useState } from "react";
import { useRouter } from "next/navigation";

import {
  assignTicketAction,
  moveTicketAction,
  setTicketRiskAction,
  startRunAction,
} from "@/app/actions/factory";
import { Button } from "@/components/ui/button";
import { BoardCard, BoardColumn, BoardDnd } from "@/components/factory/board-dnd";
import { StatusIcon, type StatusKind } from "@/components/factory/status-icon";
import { IssuePanel, issueLinkProps, openIssue } from "@/components/factory/issue-panel";
import { stageMoveError } from "@/lib/board-moves";
import { factoryRisk, parseRiskLabel, ticketRisk, TICKET_RISKS } from "@/shared/ticket-risk";
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

const STAGES: { id: string; label: string; icon: StatusKind; progress?: number; color: string }[] = [
  { id: "intake", label: "Intake", icon: "backlog", color: "text-muted-foreground" },
  { id: "assigned", label: "Assigned", icon: "todo", color: "text-muted-foreground" },
  { id: "in_progress", label: "In progress", icon: "started", progress: 0.33, color: "text-status-running" },
  { id: "review", label: "Ready for review", icon: "started", progress: 0.75, color: "text-status-review" },
  { id: "done", label: "Integrated", icon: "done", color: "text-status-done" },
];

const chip = "inline-flex h-5 max-w-full min-w-0 items-center gap-1 rounded border border-border bg-card px-1.5 text-[11px] leading-none text-muted-foreground";
const control = "h-6 min-w-0 max-w-full flex-1 rounded border border-border bg-background px-1.5 text-[11px]";

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
  // The optimistic stage sits on top of each fresh server render until the move settles.
  const [shown, showMove] = useOptimistic(tickets, (state, { id, stage }: { id: string; stage: string }) =>
    state.map((ticket) => (ticket.id === id ? { ...ticket, stage } : ticket)));
  const dragging = useRef(false);
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
            // A refresh mid-drag would move cards under the pointer.
            if (!dragging.current) router.refresh();
          }
        })
        .catch(() => {});
    };
    refresh();
    const timer = setInterval(refresh, 10000);
    return () => clearInterval(timer);
  }, [router]);
  const agentById = new Map(agents.map((a) => [a.id, a]));
  const ticketById = new Map(shown.map((t) => [t.id, t]));
  const label = (ticket: BoardTicket) => `#${ticket.githubIssueNumber} ${ticket.title}`;

  function move(ticketId: string, stage: string) {
    setError("");
    startTransition(async () => {
      showMove({ id: ticketId, stage });
      try {
        const result = await moveTicketAction(ticketId, stage);
        if (result.error) setError(result.error);
      } catch (error) {
        setError(error instanceof Error ? error.message : "Could not move ticket.");
      }
    });
  }

  return (
    <div className="min-w-0 wrap-anywhere">
      {error && (
        <p role="alert" className="mb-3 text-sm text-status-attention">
          {error}
        </p>
      )}
      <p className="mb-3 text-xs text-muted-foreground">
        Drag a ticket to change its stage. With the keyboard, focus its handle, press Space, then use the arrow keys.
      </p>
      <BoardDnd
        id="ticket-board"
        columnOf={(id) => ticketById.get(id)?.stage}
        canDrop={(id, stage) => {
          const ticket = ticketById.get(id);
          return !!ticket && !stageMoveError(ticket.stage, stage);
        }}
        onMove={move}
        onDragging={(value) => { dragging.current = value; }}
        cardLabel={(id) => { const ticket = ticketById.get(id); return ticket ? label(ticket) : "ticket"; }}
        columnLabel={(stage) => STAGES.find((s) => s.id === stage)?.label ?? stage}
        overlay={(id) => {
          const ticket = ticketById.get(id);
          return ticket && (
            <div className="w-[17rem] cursor-grabbing rounded-md border border-border bg-card p-2.5 text-[13px] shadow-lg">
              <p className="text-xs text-muted-foreground">#{ticket.githubIssueNumber}</p>
              <p className="mt-1 line-clamp-2 font-medium leading-snug">{ticket.title}</p>
            </div>
          );
        }}
      >
        <div className="flex min-w-0 gap-3 overflow-x-auto pb-4">
          {STAGES.map((stage) => {
            const items = shown.filter((t) => t.stage === stage.id);
            return (
              <BoardColumn
                key={stage.id}
                id={stage.id}
                aria-label={`${stage.label} tickets`}
                className="flex w-72 max-w-full shrink-0 flex-col rounded-lg bg-muted/50 p-1.5"
              >
                <div className="px-1.5 pb-2 pt-1">
                  <h3 className="flex items-center gap-2 text-[13px] font-medium">
                    <StatusIcon kind={stage.icon} progress={stage.progress} className={stage.color} />
                    {stage.label}
                    <span className="font-normal tabular-nums text-muted-foreground">{items.length}</span>
                  </h3>
                  {stage.id === 'done' && <p className="mt-0.5 text-[11px] text-muted-foreground">Issue closed. Not a release.</p>}
                  {stage.id === 'review' && <p className="mt-0.5 text-[11px] text-muted-foreground">Review is not a merge or a deploy.</p>}
                </div>
                <div className="flex flex-col gap-1.5">
                  {items.map((ticket) => {
                    const agent = ticket.assignedAgentId
                      ? agentById.get(ticket.assignedAgentId)
                      : undefined;
                    const risk = ticketRisk(ticket.labels, LABEL_PREFIX);
                    const labels = ticket.labels.filter((name) => !parseRiskLabel(name, LABEL_PREFIX));
                    return (
                      <BoardCard
                        key={ticket.id}
                        id={ticket.id}
                        label={label(ticket)}
                        onOpen={() => openIssue(ticket.id)}
                        blocked={stage.id === "in_progress" ? stageMoveError("in_progress", "intake") : null}
                        className="min-w-0 rounded-md border border-border bg-card p-2.5 text-[13px] shadow-[0_1px_2px_rgb(28_25_23/0.04)] transition-colors duration-150 ease-out hover:border-foreground/20"
                      >
                        {(handle) => (
                          <>
                            <div className="flex min-w-0 items-center gap-1.5">
                              {handle}
                              <span className="text-xs text-muted-foreground">#{ticket.githubIssueNumber}</span>
                              {agent ? (
                                <span
                                  role="img"
                                  aria-label={`${agent.name} · ${agent.ownerName}`}
                                  title={`${agent.name} · ${agent.ownerName}`}
                                  className="ml-auto grid size-5 shrink-0 place-items-center rounded-full text-[10px] font-semibold text-white"
                                  style={{ backgroundColor: agent.color }}
                                >
                                  {agent.name[0]?.toUpperCase()}
                                </span>
                              ) : (
                                <span role="img" aria-label="Unassigned" title="Unassigned" className="ml-auto size-5 shrink-0 rounded-full border border-dashed border-muted-foreground/50" />
                              )}
                            </div>
                            <a
                              {...issueLinkProps(ticket.id)}
                              draggable={false}
                              className="mt-1 line-clamp-3 wrap-anywhere font-medium leading-snug hover:underline"
                            >
                              {ticket.title}
                            </a>
                            <div className="mt-2 flex flex-wrap gap-1">
                              <span className={chip}>
                                <span className="truncate">
                                  {risk ? `${risk[0].toUpperCase()}${risk.slice(1)} risk${risk === "low" ? " · auto-merge when CI is green" : ""}` : "No risk rating"}
                                </span>
                              </span>
                              {labels.slice(0, 3).map((name) => (
                                <span key={name} className={chip} title={name}>
                                  <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-muted-foreground/50" />
                                  <span className="truncate">{name}</span>
                                </span>
                              ))}
                              {labels.length > 3 && <span className={chip} title={labels.slice(3).join(", ")}>+{labels.length - 3}</span>}
                            </div>

                            <div className="mt-2 flex flex-wrap items-center gap-1.5">
                              <select
                                aria-label="Risk rating"
                                className={control}
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
                                className={control}
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

                              {ticket.assignedAgentId &&
                              stage.id !== "in_progress" &&
                              stage.id !== "done" ? (
                                <Button
                                  size="sm"
                                  className="h-6 rounded px-2 text-[11px]"
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
                          </>
                        )}
                      </BoardCard>
                    );
                  })}
                  {items.length === 0 ? (
                    <p className="py-5 text-center text-xs text-muted-foreground">Nothing here.</p>
                  ) : null}
                </div>
              </BoardColumn>
            );
          })}
        </div>
      </BoardDnd>
      <IssuePanel />
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
