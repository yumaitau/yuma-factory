// PaperBoy (https://github.com/yumaitau/paperboy) is a self-hosted transactional email API.
export function paperboyEmailsUrl(apiUrl: string): string {
  return `${apiUrl.replace(/\/$/, '')}/api/v1/emails`;
}

export type PaperboySendInput = {
  apiUrl: string;
  apiKey: string;
  from: string;
  to: string | string[];
  subject: string;
  html: string;
  text: string;
  idempotencyKey?: string;
  tags?: { name: string; value: string }[];
  fetch?: typeof fetch;
};

export type PaperboySendResult = { id: string };

export async function sendPaperboyEmail(input: PaperboySendInput): Promise<PaperboySendResult> {
  const response = await (input.fetch ?? fetch)(paperboyEmailsUrl(input.apiUrl), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${input.apiKey}`,
      'Content-Type': 'application/json',
      ...(input.idempotencyKey ? { 'Idempotency-Key': input.idempotencyKey } : {}),
    },
    body: JSON.stringify({
      from: input.from,
      to: input.to,
      subject: input.subject,
      html: input.html,
      text: input.text,
      tags: input.tags,
    }),
  });
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const message = paperboyErrorMessage(body) || `PaperBoy send failed (${response.status})`;
    throw new Error(message);
  }
  if (!body || typeof body !== 'object' || typeof (body as { id?: unknown }).id !== 'string') {
    throw new Error('PaperBoy send returned no message id.');
  }
  return { id: (body as { id: string }).id };
}

function paperboyErrorMessage(body: unknown): string | null {
  if (!body || typeof body !== 'object') return null;
  const error = (body as { error?: { message?: unknown }; message?: unknown }).error;
  if (error && typeof error === 'object' && typeof error.message === 'string') return error.message;
  if (typeof (body as { message?: unknown }).message === 'string') return (body as { message: string }).message;
  return null;
}