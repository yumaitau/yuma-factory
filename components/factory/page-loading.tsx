import { Logo } from '@/components/studio/logo';
import { APP_NAME } from '@/lib/brand';

const spinner = <span aria-hidden className="size-3.5 rounded-full border-2 border-primary/20 border-t-primary motion-safe:animate-spin" />;
const fadeIn = 'motion-safe:animate-[fade-in_300ms_ease-out_150ms_backwards]';

/** Suspense fallback for a page under the persistent header: fills the content area only. */
export function PageLoading({ label }: { label: string }) {
  return <main role="status" aria-live="polite" className={`flex min-h-[50dvh] items-center justify-center gap-2 p-6 text-sm text-muted-foreground ${fadeIn}`}>
    {spinner}{label}
  </main>;
}

/** Full-page Suspense fallback for pages without the app header: the brand, centred, with what is loading. */
export function FullPageLoading({ label }: { label: string }) {
  return <main role="status" aria-live="polite" className={`flex min-h-[100dvh] flex-col items-center justify-center gap-5 p-6 ${fadeIn}`}>
    <Logo className="h-12 w-auto" priority />
    <div className="flex flex-col items-center gap-1.5 text-center">
      <p className="font-heading text-lg font-semibold tracking-tight">{APP_NAME}</p>
      <p className="flex items-center gap-2 text-sm text-muted-foreground">{spinner}{label}</p>
    </div>
  </main>;
}
