import 'server-only';

import { APIError, createAuthEndpoint } from 'better-auth/api';
import { setSessionCookie } from 'better-auth/cookies';
import type { BetterAuthPlugin } from 'better-auth';
import { z } from 'zod';

import { APP_NAME } from '@/lib/brand';
import { isAllowedEmail } from '@/lib/env';

/** Playwright / Lightpanda only. Not registered unless E2E_AUTH_ENABLED=1. */
export function e2eSessionPlugin(): BetterAuthPlugin {
  return {
    id: 'e2e-session',
    endpoints: {
      e2eSession: createAuthEndpoint(
        '/e2e/session',
        {
          method: 'POST',
          body: z.object({
            email: z.string().email(),
            name: z.string().min(1),
          }),
        },
        async (ctx) => {
          if (process.env.E2E_AUTH_ENABLED !== '1') {
            throw new APIError('NOT_FOUND', { message: 'Not found' });
          }
          const email = ctx.body.email.trim().toLowerCase();
          if (!isAllowedEmail(email)) {
            throw new APIError('FORBIDDEN', { message: `${APP_NAME} is limited to approved email domains.` });
          }
          const user = await ctx.context.internalAdapter.createUser({
            email,
            name: ctx.body.name,
            emailVerified: true,
          });
          if (!user) {
            throw new APIError('INTERNAL_SERVER_ERROR', { message: 'Could not create user' });
          }
          const session = await ctx.context.internalAdapter.createSession(user.id);
          if (!session) {
            throw new APIError('INTERNAL_SERVER_ERROR', { message: 'Could not create session' });
          }
          await setSessionCookie(ctx, { session, user });
          return ctx.json({ ok: true });
        },
      ),
    },
  };
}
