import { allowedEmailDomains, isAllowedEmail, type AppEnv } from '@/lib/env';

/**
 * Google Workspace authority is the signed `hd` claim, not the email suffix.
 * Consumer Gmail has no `hd`. Aliases can fake an allowed-domain address.
 */
export function googleHostedDomainAllowed(hostedDomain: unknown, env: AppEnv): boolean {
  if (typeof hostedDomain !== 'string') return false;
  const domain = hostedDomain.trim().toLowerCase().replace(/^@/, '');
  return allowedEmailDomains(env).includes(domain);
}

export function googleWorkspaceAccountAllowed(input: {
  hostedDomain: unknown;
  email: unknown;
  env: AppEnv;
}): boolean {
  if (typeof input.email !== 'string' || !isAllowedEmail(input.email, input.env)) {
    return false;
  }
  return googleHostedDomainAllowed(input.hostedDomain, input.env);
}
