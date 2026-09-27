import { connection } from 'next/server';
import { Suspense } from 'react';

import { AppShell } from '@/components/factory/app-shell';
import { ConnectGithub } from '@/components/factory/connect-github';
import { ProjectBrowser } from '@/components/factory/project-browser';
import { AutomationPanel } from '@/components/factory/automation-panel';
import { automationStatus } from '@/lib/automation-state';
import { githubConfigured } from '@/lib/env';
import { getInstallUrl } from '@/lib/github';
import { listProjects, ticketCountsByProject } from '@/lib/queries';
import { requireSession } from '@/lib/session';

export default function HomePage() {
  return (
    <Suspense fallback={<p className="p-6 text-sm text-muted-foreground">Loading factory…</p>}>
      <Dashboard />
    </Suspense>
  );
}

async function Dashboard() {
  await connection();
  const session = await requireSession();
  const configured = githubConfigured();
  const installUrl = configured ? safeInstallUrl() : null;

  const projects = await listProjects();
  const counts = await ticketCountsByProject();
  const worker = await automationStatus();

  return (
    <AppShell email={session.user.email}>
      <div className="mb-6 flex items-end justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Projects</h1>
          <p className="text-sm text-muted-foreground">
            Connected repositories. Each card shows open tickets by workflow stage.
          </p>
        </div>
      </div>

      <AutomationPanel status={worker} userId={session.user.id} />
      {projects.length === 0 ? (
        <ConnectGithub installUrl={installUrl} />
      ) : (
        <ProjectBrowser projects={projects.map((project) => ({
          id: project.id,
          repoFullName: project.repoFullName,
          description: project.description,
          defaultBranch: project.defaultBranch,
          private: project.private,
          createdAt: project.createdAt.getTime(),
          counts: counts.get(project.id) ?? {},
        }))} />
      )}
    </AppShell>
  );
}

function safeInstallUrl(): string | null {
  try {
    getInstallUrl();
    return '/api/github/install';
  } catch {
    return null;
  }
}
