import Link from "next/link";
import { connection } from "next/server";
import { Suspense, type ReactNode } from "react";

import { ThemeToggle } from "@/components/factory/theme-toggle";
import { SignOutButton } from "@/components/studio/sign-out-button";
import { Logo } from "@/components/studio/logo";
import { APP_NAME } from "@/lib/brand";
import { requireSession } from "@/lib/session";

const NAV = [
  { href: "/work", label: "Work" },
  { href: "/", label: "Projects" },
  { href: "/plans", label: "Plans" },
  { href: "/memory", label: "Memory" },
  { href: "/agents", label: "Agents" },
  { href: "/pool", label: "Subscriptions" },
];

/** Persistent header, rendered once by the (app) layout so navigation only swaps the page below it. */
export function AppHeader() {
  return (
    <header className="border-b border-border">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-4 px-6 py-4">
        <div className="flex min-w-0 flex-wrap items-center gap-3 sm:gap-6">
          <Link href="/" aria-label={`${APP_NAME} home`}>
            <Logo className="h-8 w-auto" />
          </Link>
          <nav className="flex flex-wrap items-center gap-1">
            {NAV.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                className="rounded-md px-3 py-1.5 text-sm text-muted-foreground hover:bg-muted hover:text-foreground"
              >
                {item.label}
              </Link>
            ))}
          </nav>
        </div>
        <div className="flex min-w-0 max-w-full items-center gap-3 [&>button]:shrink-0">
          <Suspense fallback={null}>
            <UserEmail />
          </Suspense>
          <ThemeToggle />
          <SignOutButton />
        </div>
      </div>
    </header>
  );
}

async function UserEmail() {
  // Auth setup uses Math.random(), so it must run at request time like each page's session read.
  await connection();
  const session = await requireSession();
  return (
    <span className="hidden min-w-0 wrap-anywhere text-sm text-muted-foreground sm:inline">
      {session.user.email}
    </span>
  );
}

export function AppShell({
  children,
  wide = false,
}: {
  children: ReactNode;
  wide?: boolean;
}) {
  return <main className={`mx-auto px-6 py-8 ${wide ? 'max-w-[1800px]' : 'max-w-6xl'}`}>{children}</main>;
}
