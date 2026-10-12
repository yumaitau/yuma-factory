import { Logo } from '@/components/studio/logo';
import { APP_NAME } from '@/lib/brand';

/** Full-page Suspense fallback: the brand, centred, with what is loading. */
export function PageLoading({ label }: { label: string }) {
  return <main role="status" aria-live="polite" className="flex min-h-[100dvh] flex-col items-center justify-center gap-5 p-6 motion-safe:animate-[fade-in_300ms_ease-out_150ms_backwards]">
    <Logo className="h-12 w-auto" priority />
    <div className="flex flex-col items-center gap-1.5 text-center">
      <p className="font-heading text-lg font-semibold tracking-tight">{APP_NAME}</p>
      <p className="flex items-center gap-2 text-sm text-muted-foreground">
        <span aria-hidden className="size-3.5 rounded-full border-2 border-primary/20 border-t-primary motion-safe:animate-spin" />
        {label}
      </p>
    </div>
  </main>;
}
