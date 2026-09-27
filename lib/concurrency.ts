/** Bound external work while awaiting every task, including in-flight work after a failure. */
export async function forEachConcurrent<T>(items: T[], concurrency: number, task: (item: T) => Promise<void>) {
  // Guard invalid input: zero/negative/NaN concurrency must still drain the queue once, not silently succeed.
  const workers = Math.min(items.length, Math.max(1, Math.floor(concurrency) || 1));
  let next = 0;
  const results = await Promise.allSettled(Array.from({ length: workers }, async () => {
    while (next < items.length) await task(items[next++]);
  }));
  const failed = results.find((result) => result.status === 'rejected');
  if (failed?.status === 'rejected') throw failed.reason;
}

export function planAssignments<T extends { id: string; assignedAgentId: string | null }, A extends { id: string }>(tickets: T[], agents: A[], capacity: number) {
  const available = new Map(agents.map((agent) => [agent.id, agent]));
  const assignments: { ticket: T; agent: A }[] = [];
  // Honour explicit assignments before allocating unassigned tickets.
  for (const ticket of [...tickets.filter((ticket) => ticket.assignedAgentId), ...tickets.filter((ticket) => !ticket.assignedAgentId)]) {
    if (assignments.length >= capacity) break;
    const agent = ticket.assignedAgentId ? available.get(ticket.assignedAgentId) : available.values().next().value;
    if (!agent) continue;
    assignments.push({ ticket, agent });
    available.delete(agent.id);
  }
  return assignments;
}
