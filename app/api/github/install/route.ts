import { getInstallUrl, INSTALL_STATE_COOKIE } from '@/lib/github';
import { requireApiSession } from '@/lib/session';

/** Start a GitHub App install with a one-time state the callback must echo back. */
export async function GET() {
  const auth = await requireApiSession();
  if (!auth.ok) return auth.response;
  const state = crypto.randomUUID();
  return new Response(null, {
    status: 302,
    headers: {
      Location: getInstallUrl(state),
      'Set-Cookie': `${INSTALL_STATE_COOKIE}=${state}; Path=/api/github/callback; Max-Age=1800; HttpOnly; Secure; SameSite=Lax`,
      'Cache-Control': 'no-store',
    },
  });
}
