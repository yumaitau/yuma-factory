'use client';

import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { authClient } from '@/lib/auth-client';

export function SignInForm() {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function signInWithGoogle() {
    setError(null);
    setPending(true);
    try {
      const result = await authClient.signIn.social({
        provider: 'google',
        callbackURL: '/',
      });
      if (result.error) {
        setError(result.error.message ?? 'Google sign-in failed');
        setPending(false);
      } else {
        // Success normally navigates away. If we're still here (blocked
        // redirect), release the button instead of sticking on Redirecting….
        await new Promise((resolve) => setTimeout(resolve, 3000));
        setPending(false);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Google sign-in failed');
      setPending(false);
    }
  }

  return (
    <div className="space-y-4">
      {error ? <p role="alert" className="text-sm text-red-700">{error}</p> : null}
      <Button className="w-full" disabled={pending} onClick={signInWithGoogle} type="button">
        {pending ? 'Redirecting…' : 'Sign in with Google Workspace'}
      </Button>
    </div>
  );
}
