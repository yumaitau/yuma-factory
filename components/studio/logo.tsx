import Image from 'next/image';

import { APP_NAME } from '@/lib/brand';

export function Logo({
  className = 'h-10 w-auto',
  priority = false,
}: {
  className?: string;
  priority?: boolean;
}) {
  return (
    <Image
      src="/logo.svg"
      alt={APP_NAME}
      width={1024}
      height={367}
      unoptimized
      priority={priority}
      className={className}
    />
  );
}
