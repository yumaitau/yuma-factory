import { connection } from 'next/server';
import { Suspense } from 'react';
import { PageLoading } from '@/components/factory/page-loading';

import { refreshReposAction } from '@/app/actions/factory';
import { AppShell } from '@/components/factory/app-shell';
import { Button, buttonVariants } from '@/components/ui/button';
import { ConnectGithub } from '@/components/factory/connect-github';
import { ProjectBrowser } from '@/components/factory/project-browser';
import { AutomationPanel } from '@/components/factory/automation-panel';
import { DecisionSummary } from '@/components/factory/decision-summary';
import { automationStatus } from '@/lib/automation-state';
import { githubConfigured } from '@/lib/env';
import { getInstallUrl } from '@/lib/github';
import { listProjects, ticketCountsByProject } from '@/lib/queries';
import { workBoardCards } from '@/lib/work-board-query';
import { requireSession } from '@/lib/session';

export default function HomePage() {
  return (
    <Suspense fallback={<PageLoading label="Loading factory…" />}>
      <Dashboard />
    </Suspense>
  );
}

async function Dashboard() {
  await connection();
  const session = await requireSession();
  const configured = githubConfigured();
  const installUrl = configured ? safeInstallUrl() : null;

  const [projects, counts, worker, cards] = await Promise.all([
    listProjects(), ticketCountsByProject(), automationStatus(), workBoardCards(),
  ]);

  return (
    <AppShell email={session.user.email}>
      <div className="mb-6 flex items-end justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Projects</h1>
          <p className="text-sm text-muted-foreground">
            What needs attention, what is in progress, and what is ready for review. Repositories sit below that.
          </p>
        </div>
        {projects.length > 0 && installUrl ? (
          <div className="flex flex-wrap items-center gap-2">
            {/* Grant the App more repositories on GitHub, then refresh to import them. */}
            <a className={buttonVariants({ variant: 'outline', size: 'sm' })} href={installUrl}>Add repositories on GitHub</a>
            <form action={refreshReposAction}>
              <Button type="submit" variant="outline" size="sm">Refresh repositories</Button>
            </form>
          </div>
        ) : null}
      </div>

      {projects.length === 0 ? (
        <ConnectGithub installUrl={installUrl} />
      ) : (
        <>
          <DecisionSummary cards={cards} />
          <ProjectBrowser projects={projects.map((project) => ({
          id: project.id,
          repoFullName: project.repoFullName,
          description: project.description,
          defaultBranch: project.defaultBranch,
          private: project.private,
          createdAt: project.createdAt.getTime(),
          counts: counts.get(project.id) ?? {},
        }))} />
        </>
      )}
      <div className="mt-8">
        <AutomationPanel status={worker} userId={session.user.id} />
      </div>
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
