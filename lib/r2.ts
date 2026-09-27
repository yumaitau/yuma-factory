import 'server-only';

import { getCloudflareContext } from '@opennextjs/cloudflare';

export async function documentsBucket() {
  const { env } = await getCloudflareContext({ async: true });
  return env.ARTIFACTS;
}

export function exportObjectKey(input: {
  userId: string;
  conversationId: string;
  filename: string;
}) {
  return `exports/${input.userId}/${input.conversationId}/${input.filename}`;
}
