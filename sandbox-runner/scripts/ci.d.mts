export function loadRequiredChecks(
  github: (path: string) => Promise<unknown>, pages: (path: string) => Promise<unknown[]>, baseBranch: string,
): Promise<{ context: string; app_id?: number }[]>;

// The sandbox Worker imports this script as Text to install it in each container.
declare const source: string;
export default source;
