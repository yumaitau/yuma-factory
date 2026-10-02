import 'server-only';

import { headers } from 'next/headers';
import { redirect } from 'next/navigation';

import { getAuth } from '@/lib/auth';

export async function getSession() {
  // Read request headers first: awaiting auth setup first lets a build prerender finish, then headers() rejects.
  const requestHeaders = await headers();
  const auth = await getAuth();
  return auth.api.getSession({ headers: requestHeaders });
}

/**
 * Returns the session, or null if the user isn't signed in OR auth can't be
 * initialised (e.g. Google SSO secrets not yet configured). Only
 * configuration problems resolve to null — operational failures (D1 outage,
 * network errors) rethrow so callers see a 500 instead of a sign-in loop.
 */
export async function getSessionSafe() {
  try {
    return await getSession();
  } catch (error) {
    if (
      error instanceof Error &&
      /GOOGLE_CLIENT_ID|GOOGLE_CLIENT_SECRET|BETTER_AUTH_SECRET|BETTER_AUTH_URL/.test(error.message)
    ) {
      return null;
    }
    throw error;
  }
}

export async function requireSession() {
  const session = await getSessionSafe();
  if (!session) redirect('/sign-in');
  return session;
}

export async function requireApiSession() {
  const session = await getSessionSafe();
  if (!session) {
    return { ok: false as const, response: Response.json({ error: 'Unauthorised' }, { status: 401 }) };
  }
  return { ok: true as const, session };
}
