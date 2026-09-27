import 'server-only';

import { App, Octokit } from 'octokit';

import { getEnv, githubAppCredentials } from '@/lib/env';

/**
 * Build the GitHub App client from configured credentials. Throws when the
 * integration is not configured so callers can guard on githubConfigured()
 * first and surface a clean "connect GitHub" state.
 *
 * octokit is fetch-based and runs on the Cloudflare Workers runtime.
 */
export function getGithubApp(): App {
  const creds = githubAppCredentials(getEnv());
  if (!creds) {
    throw new Error('GitHub App is not configured (GITHUB_APP_* env group is incomplete).');
  }
  return new App({
    // Bottleneck's module-global queues share promises between Worker requests.
    // A finished request can strand another request's token renewal. Factory's
    // durable queue/backoff owns scheduling; keep Octokit requests independent.
    Octokit: Octokit.defaults({ throttle: { enabled: false } }),
    appId: creds.appId,
    privateKey: creds.privateKey,
    oauth: { clientId: creds.clientId, clientSecret: creds.clientSecret },
    ...(creds.webhookSecret ? { webhooks: { secret: creds.webhookSecret } } : {}),
  });
}

export type InstallationInfo = {
  installationId: number;
  accountLogin: string;
  accountType: string;
};

/** Resolve an installation id to its account login + type. */
export async function getInstallationInfo(installationId: number): Promise<InstallationInfo> {
  const app = getGithubApp();
  const { data } = await app.octokit.request('GET /app/installations/{installation_id}', {
    installation_id: installationId,
  });
  const account = data.account;
  // account can be a User or Organization; both carry `login` + `type`.
  const login = account && 'login' in account ? account.login : 'unknown';
  const type = account && 'type' in account ? (account.type ?? 'User') : 'Organization';
  return { installationId, accountLogin: login, accountType: type };
}

export type RepoSummary = {
  repoId: number;
  fullName: string;
  defaultBranch: string;
  description: string | null;
  private: boolean;
};

/** List repositories the installation can access. */
export async function listInstallationRepos(installationId: number): Promise<RepoSummary[]> {
  const app = getGithubApp();
  const octokit = await app.getInstallationOctokit(installationId);
  const repos: RepoSummary[] = [];
  const iterator = octokit.paginate.iterator(
    octokit.rest.apps.listReposAccessibleToInstallation,
    { per_page: 100 },
  );
  for await (const { data } of iterator) {
    // paginate over the installation-repos endpoint returns an array of repos.
    const page = Array.isArray(data) ? data : (data as { repositories?: unknown[] }).repositories ?? [];
    for (const repo of page as Array<{
      id: number;
      full_name: string;
      default_branch: string;
      description: string | null;
      private: boolean;
    }>) {
      repos.push({
        repoId: repo.id,
        fullName: repo.full_name,
        defaultBranch: repo.default_branch,
        description: repo.description,
        private: repo.private,
      });
    }
  }
  return repos;
}

export type IssueSummary = {
  githubIssueId: number;
  number: number;
  title: string;
  body: string | null;
  labels: string[];
  state: string;
  htmlUrl: string;
};

/**
 * List open issues for a repo. Pull requests are excluded (GitHub returns PRs
 * from the issues endpoint; they carry a `pull_request` field).
 */
export async function listRepoIssues(
  installationId: number,
  owner: string,
  repo: string,
): Promise<IssueSummary[]> {
  const app = getGithubApp();
  const octokit = await app.getInstallationOctokit(installationId);
  const issues: IssueSummary[] = [];
  const iterator = octokit.paginate.iterator(octokit.rest.issues.listForRepo, {
    owner,
    repo,
    state: 'open',
    per_page: 100,
  });
  for await (const { data } of iterator) {
    for (const issue of data) {
      if ('pull_request' in issue && issue.pull_request) continue;
      issues.push({
        githubIssueId: issue.id,
        number: issue.number,
        title: issue.title,
        body: issue.body ?? null,
        labels: issue.labels.map((l) => (typeof l === 'string' ? l : (l.name ?? ''))).filter(Boolean),
        state: issue.state,
        htmlUrl: issue.html_url,
      });
    }
  }
  return issues;
}

/**
 * Create a pull request in the repo. Used by the sandbox run flow once an
 * agent has pushed a branch. Returns the PR html_url.
 */
export async function createPullRequest(input: {
  installationId: number;
  owner: string;
  repo: string;
  head: string;
  base: string;
  title: string;
  body: string;
}): Promise<string> {
  const app = getGithubApp();
  const octokit = await app.getInstallationOctokit(input.installationId);
  const { data } = await octokit.rest.pulls.create({
    owner: input.owner,
    repo: input.repo,
    head: input.head,
    base: input.base,
    title: input.title,
    body: input.body,
  });
  return data.html_url;
}

/**
 * Mint a short-lived installation access token. The sandbox uses this as the
 * git credential to clone/push; it expires in ~1h and is never persisted.
 */
export async function getInstallationToken(installationId: number, requireCI = false): Promise<string> {
  const app = getGithubApp();
  const { data } = await app.octokit.request(
    'POST /app/installations/{installation_id}/access_tokens',
    { installation_id: installationId },
  );
  if (requireCI && (
    !data.permissions?.administration || !data.permissions?.checks || !data.permissions?.actions || !data.permissions?.statuses ||
    data.permissions?.issues !== 'write' || data.permissions?.pull_requests !== 'write' ||
    data.permissions?.contents !== 'write'
  )) {
    throw new Error('Update the Factory GitHub App installation: Administration, Checks, Actions and Commit statuses need Read access; Contents, Issues and Pull requests need Read/Write. Ticket remains open.');
  }
  return data.token;
}

/** Build the GitHub App installation URL users click to connect repos. */
export function getInstallUrl(): string {
  const creds = githubAppCredentials(getEnv());
  if (!creds) throw new Error('GitHub App is not configured.');
  return `https://github.com/apps/${creds.slug}/installations/new`;
}
