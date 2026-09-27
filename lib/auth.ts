import "server-only";

import { APIError } from "better-auth/api";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { nextCookies } from "better-auth/next-js";
import { verifyGoogleIdToken } from "better-auth/social-providers";

import {
  accounts,
  rateLimits,
  sessions,
  users,
  verifications,
} from "@/db/schema";
import { getDb } from "@/lib/db";
import { e2eSessionPlugin } from "@/lib/e2e-auth";
import { APP_NAME } from "@/lib/brand";
import { allowedEmailDomains, getEnv, googleCredentials, isAllowedEmail, parseEmailList } from "@/lib/env";
import { googleWorkspaceAccountAllowed } from "@/lib/google-workspace";

export async function getAuth() {
  const env = getEnv();
  const google = googleCredentials(env);
  if (!google) {
    throw new Error(
      "GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are required for Google Workspace SSO.",
    );
  }
  const db = await getDb();
  const origin = new URL(env.BETTER_AUTH_URL);
  const workspaceMessage = `Use a Google Workspace account from ${allowedEmailDomains(env).join(" or ") || "an allowed domain"}.`;
  const isLocal = origin.hostname === 'localhost' || origin.hostname === '127.0.0.1';
  // Localhost is only trusted for local development; never in production.
  const localOrigins = isLocal ? [
    `${origin.protocol}//localhost${origin.port ? `:${origin.port}` : ""}`,
    `${origin.protocol}//127.0.0.1${origin.port ? `:${origin.port}` : ""}`,
  ] : [];

  return betterAuth({
    appName: APP_NAME,
    baseURL: env.BETTER_AUTH_URL,
    secret: env.BETTER_AUTH_SECRET,
    trustedOrigins: [
      ...new Set([
        origin.origin,
        ...localOrigins,
        ...parseEmailList(env.TRUSTED_ORIGINS),
      ]),
    ],
    database: drizzleAdapter(db, {
      provider: "sqlite",
      usePlural: true,
      schema: { users, sessions, accounts, verifications, rateLimits },
    }),
    emailAndPassword: { enabled: false },
    account: {
      accountLinking: {
        enabled: true,
        trustedProviders: ["google"],
      },
    },
    socialProviders: {
      google: {
        clientId: google.clientId,
        clientSecret: google.clientSecret,
        prompt: "select_account" as const,
        verifyIdToken: async (token: string, nonce?: string) => {
          const claims = await verifyGoogleIdToken({
            token,
            audience: google.clientId,
            nonce,
          });
          if (!claims) return false;
          if (
            !googleWorkspaceAccountAllowed({
              hostedDomain: claims.hd,
              email: claims.email,
              env,
            })
          ) {
            throw new APIError("FORBIDDEN", {
              message: workspaceMessage,
            });
          }
          return true;
        },
        mapProfileToUser: async (profile: { hd?: string; email?: string }) => {
          if (
            !googleWorkspaceAccountAllowed({
              hostedDomain: profile.hd,
              email: profile.email,
              env,
            })
          ) {
            throw new APIError("FORBIDDEN", {
              message: workspaceMessage,
            });
          }
          return {};
        },
      },
    },
    advanced: {
      ipAddress: { ipAddressHeaders: ["cf-connecting-ip"] },
    },
    rateLimit: {
      enabled: env.E2E_DISABLE_AUTH_RATE_LIMIT !== "1",
      storage: "database",
    },
    databaseHooks: {
      user: {
        create: {
          before: async (user) => {
            const email = user.email.trim().toLowerCase();
            if (!isAllowedEmail(email, env)) {
              throw new APIError("FORBIDDEN", {
                message: `${APP_NAME} is limited to approved email domains.`,
              });
            }
            return { data: { ...user, email } };
          },
        },
      },
    },
    plugins: [
      nextCookies(),
      ...(env.E2E_AUTH_ENABLED === "1" ? [e2eSessionPlugin()] : []),
    ],
  });
}
