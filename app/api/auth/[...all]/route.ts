import { toNextJsHandler } from 'better-auth/next-js';

import { getAuth } from '@/lib/auth';

export async function GET(request: Request) {
  const auth = await getAuth();
  return toNextJsHandler(auth).GET(request);
}

export async function POST(request: Request) {
  const auth = await getAuth();
  return toNextJsHandler(auth).POST(request);
}
