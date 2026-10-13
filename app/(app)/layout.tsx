import type { ReactNode } from 'react';

import { AppHeader } from '@/components/factory/app-shell';

export default function SignedInLayout({ children }: Readonly<{ children: ReactNode }>) {
  return <div className="min-h-[100dvh] bg-background">
    <AppHeader />
    {children}
  </div>;
}
