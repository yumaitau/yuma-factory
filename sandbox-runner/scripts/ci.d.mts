export function loadRequiredChecks(
  github: (path: string) => Promise<unknown>, pages: (path: string) => Promise<unknown[]>, baseBranch: string,
): Promise<{ context: string; app_id?: number }[]>;
