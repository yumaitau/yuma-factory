'use client';

import Link from 'next/link';

import { Card } from '@/components/ui/card';
import { buttonVariants } from '@/components/ui/button';

export function ConnectGithub({ installUrl }: { installUrl: string | null }) {
  return (
    <Card className="flex flex-col items-start gap-3">
      <h2 className="text-lg font-semibold">Connect GitHub</h2>
      <p className="text-sm text-muted-foreground">
        Install the Factory GitHub App on your organization to pull issues into the factory
        and let agents open pull requests.
      </p>
      {installUrl ? (
        <Link className={buttonVariants()} href={installUrl}>
          Install GitHub App
        </Link>
      ) : (
        <p className="text-sm text-red-700">
          GitHub App is not configured. Set the GITHUB_APP_* secrets, then reload.
        </p>
      )}
    </Card>
  );
}
