import { connection } from "next/server";
import { notFound } from "next/navigation";
import { Suspense } from "react";

import { AppShell } from "@/components/factory/app-shell";
import {
  TicketBoard,
  type BoardTicket,
} from "@/components/factory/ticket-board";
import {
  getProject,
  listAgentsWithOwners,
  listTicketsForProject,
} from "@/lib/queries";
import { requireSession } from "@/lib/session";

export default function ProjectPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  return (
    <Suspense
      fallback={
        <p className="p-6 text-sm text-muted-foreground">Loading board…</p>
      }
    >
      <ProjectBoard params={params} />
    </Suspense>
  );
}

async function ProjectBoard({ params }: { params: Promise<{ id: string }> }) {
  await connection();
  const session = await requireSession();
  const { id } = await params;

  const project = await getProject(id);
  if (!project) notFound();

  const [ticketRows, agents] = await Promise.all([
    listTicketsForProject(id),
    listAgentsWithOwners(),
  ]);

  const tickets: BoardTicket[] = ticketRows.map((t) => ({
    id: t.id,
    githubIssueNumber: t.githubIssueNumber,
    title: t.title,
    stage: t.stage,
    htmlUrl: t.htmlUrl,
    assignedAgentId: t.assignedAgentId,
    labels: safeParseLabels(t.labels),
  }));

  return (
    <AppShell email={session.user.email}>
      <div className="mb-6 wrap-anywhere">
        <h1 className="text-2xl font-semibold">{project.repoFullName}</h1>
        <p className="text-sm text-muted-foreground">
          {tickets.length} tickets · default branch {project.defaultBranch}
        </p>
      </div>
      <TicketBoard
        tickets={tickets}
        agents={agents.map((a) => ({
          id: a.id,
          name: a.name,
          color: a.color,
          ownerName: a.ownerName,
          modelId: a.modelId,
        }))}
        defaultModelId="codex-default"
      />
    </AppShell>
  );
}

function safeParseLabels(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((x): x is string => typeof x === "string")
      : [];
  } catch {
    return [];
  }
}
