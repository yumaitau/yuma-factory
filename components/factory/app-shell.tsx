import Link from "next/link";
import type { ReactNode } from "react";

import { SignOutButton } from "@/components/studio/sign-out-button";
import { Logo } from "@/components/studio/logo";
import { APP_NAME } from "@/lib/brand";

const NAV = [
  { href: "/work", label: "Work board" },
  { href: "/", label: "Projects" },
  { href: "/plans", label: "Plans" },
  { href: "/memory", label: "Memory" },
  { href: "/agents", label: "Agents" },
  { href: "/pool", label: "Codex subscriptions" },
];

export function AppShell({
  email,
  children,
  wide = false,
}: {
  email: string;
  children: ReactNode;
  wide?: boolean;
}) {
  return (
    <div className="min-h-[100dvh] bg-background">
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
            <span className="hidden min-w-0 wrap-anywhere text-sm text-muted-foreground sm:inline">
              {email}
            </span>
            <SignOutButton />
          </div>
        </div>
      </header>
      <main className={`mx-auto px-6 py-8 ${wide ? 'max-w-[1800px]' : 'max-w-6xl'}`}>{children}</main>
    </div>
  );
}
