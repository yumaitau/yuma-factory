// @ts-expect-error OpenNext generates this JavaScript entrypoint during the build.
import handler from './.open-next/worker.js';

export default {
  fetch: handler.fetch,
  async scheduled(controller, env) {
    await env.FACTORY_EVENTS.send({ mode: 'sync', scheduledAt: controller.scheduledTime });
  },
  async queue(batch, env) {
    // Enter Next's request context through the existing private service binding.
    if (!env.WORKER_SELF_REFERENCE) throw new Error('Factory service binding is missing.');
    const messages = batch.messages.map((message) => message.body as { mode?: string; scheduledAt?: number });
    const scheduledAt = Math.max(0, ...messages.map((message) => message.scheduledAt ?? 0));
    const response = await env.WORKER_SELF_REFERENCE.fetch('https://factory.internal/api/automation/tick', {
      method: 'POST',
      headers: { 'x-runner-secret': env.SANDBOX_RUNNER_SECRET, 'x-scheduled-at': String(scheduledAt),
        'x-automation-mode': messages.some((message) => message.mode === 'sync') ? 'sync' : 'pickup' },
    });
    if (!response.ok) { batch.retryAll({ delaySeconds: 30 }); return; }
    await response.body?.cancel();
    batch.ackAll();
  },
} satisfies ExportedHandler<CloudflareEnv>;
