import { redirect } from 'next/navigation';

import { importReposAction } from '@/app/actions/factory';
import { getInstallationInfo } from '@/lib/github';
import { githubConfigured } from '@/lib/env';
import { upsertInstallation } from '@/lib/queries';
import { requireApiSession } from '@/lib/session';

/**
 * GitHub App post-install callback. GitHub redirects here with
 * ?installation_id=...&setup_action=install after a user installs the app.
 * We record the installation and import its repositories before opening the dashboard.
 */
export async function GET(request: Request) {
  const auth = await requireApiSession();
  if (!auth.ok) return auth.response;
  if (!githubConfigured()) {
    return Response.json({ error: 'GitHub App is not configured.' }, { status: 400 });
  }

  const url = new URL(request.url);
  const installationIdRaw = url.searchParams.get('installation_id');
  if (!installationIdRaw) {
    return Response.json({ error: 'Missing installation_id.' }, { status: 400 });
  }
  const installationId = Number(installationIdRaw);
  if (!Number.isSafeInteger(installationId) || installationId <= 0) {
    return Response.json({ error: 'Invalid installation_id.' }, { status: 400 });
  }

  const info = await getInstallationInfo(installationId);
  await upsertInstallation({
    installationId: info.installationId,
    accountLogin: info.accountLogin,
    accountType: info.accountType,
    connectedByUserId: auth.session.user.id,
  });
  await importReposAction(info.installationId);

  redirect(`/?connected=${encodeURIComponent(info.accountLogin)}&installation=${installationId}`);
}
