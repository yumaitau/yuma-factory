import { importReposAction } from '@/app/actions/factory';
import { getInstallationInfo, INSTALL_STATE_COOKIE } from '@/lib/github';
import { secretMatches } from '@/lib/factory-auth';
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
  // Without this, any link to the callback could attach someone else's installation.
  const cookie = request.headers.get('cookie')?.split(/;\s*/).find((part) => part.startsWith(`${INSTALL_STATE_COOKIE}=`));
  if (!secretMatches(url.searchParams.get('state'), cookie?.slice(INSTALL_STATE_COOKIE.length + 1))) {
    return Response.json({ error: 'Start the GitHub App installation from Factory, then try again.' }, { status: 403 });
  }
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

  return new Response(null, { status: 302, headers: {
    Location: `/?connected=${encodeURIComponent(info.accountLogin)}&installation=${installationId}`,
    'Set-Cookie': `${INSTALL_STATE_COOKIE}=; Path=/api/github/callback; Max-Age=0; HttpOnly; Secure; SameSite=Lax`,
  } });
}
