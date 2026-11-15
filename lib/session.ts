import 'server-only';

import { redirect } from 'next/navigation';

import { getSessionSafe } from '@/lib/api-session';

export { getSession, getSessionSafe, requireApiSession } from '@/lib/api-session';

export async function requireSession() {
  const session = await getSessionSafe();
  if (!session) redirect('/sign-in');
  return session;
}
