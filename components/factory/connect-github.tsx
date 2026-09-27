'use client';

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
        // Plain navigation: the install route sets a state cookie and redirects to GitHub.
        <a className={buttonVariants()} href={installUrl}>
          Install GitHub App
        </a>
      ) : (
        <p className="text-sm text-red-700">
          GitHub App is not configured. Set the GITHUB_APP_* secrets, then reload.
        </p>
      )}
    </Card>
  );
}
