import type { Metadata } from "next";
import { connection } from "next/server";
import { Suspense } from "react";

import { Card } from "@/components/ui/card";
import { Logo } from "@/components/studio/logo";
import { APP_NAME } from "@/lib/brand";
import { getEnv } from "@/lib/env";

import { SignInForm } from "./sign-in-form";

export const metadata: Metadata = { title: "Sign in" };

export default function SignInPage() {
  return (
    <Suspense
      fallback={
        <p className="p-6 text-sm text-muted-foreground">Loading sign-in…</p>
      }
    >
      <SignInContent />
    </Suspense>
  );
}

async function SignInContent() {
  // Worker secrets are available at request time, not during prerendering.
  await connection();

  // Detect whether Google SSO is actually configured so we can show a clear
  // notice instead of a button that would 500 on click.
  let googleConfigured = false;
  try {
    const env = getEnv();
    googleConfigured = Boolean(
      env.GOOGLE_CLIENT_ID?.trim() && env.GOOGLE_CLIENT_SECRET?.trim(),
    );
  } catch {
    googleConfigured = false;
  }

  return (
    <main className="flex min-h-[100dvh] items-center justify-center p-6">
      <Card className="mx-auto w-full max-w-md space-y-6">
        <Logo className="h-14 w-auto" priority />
        <div>
          <h1 className="text-2xl font-semibold">{APP_NAME}</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Sign in with your Google Workspace account.
          </p>
        </div>
        {googleConfigured ? (
          <SignInForm />
        ) : (
          <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
            Google Workspace SSO is not configured yet. Set{" "}
            <code>GOOGLE_CLIENT_ID</code> and <code>GOOGLE_CLIENT_SECRET</code>{" "}
            on the worker (see <code>SECRETS.md</code>), then reload.
          </div>
        )}
      </Card>
    </main>
  );
}
