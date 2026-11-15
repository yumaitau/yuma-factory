/**
 * Wrap a poll so slow responses never stack requests: a call made while one is still in flight is skipped.
 * Resolves true when the task ran, false when it was skipped.
 */
export function singleFlight(task: () => Promise<unknown>) {
  let running = false;
  return async () => {
    if (running) return false;
    running = true;
    try {
      await task();
      return true;
    } finally {
      running = false;
    }
  };
}
