import Image from 'next/image';

import { APP_NAME } from '@/lib/brand';
import { cn } from '@/lib/utils';

/** The wordmark is near-black, so the dark theme swaps in a copy with a light wordmark. */
export function Logo({
  className = 'h-10 w-auto',
  priority = false,
}: {
  className?: string;
  priority?: boolean;
}) {
  return (
    <>
      <Image
        src="/logo.svg"
        alt={APP_NAME}
        width={1024}
        height={367}
        unoptimized
        priority={priority}
        className={cn(className, 'dark:hidden')}
      />
      <Image
        src="/logo-dark.svg"
        alt={APP_NAME}
        width={1024}
        height={367}
        unoptimized
        priority={priority}
        className={cn(className, 'hidden dark:inline')}
      />
    </>
  );
}
