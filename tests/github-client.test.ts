import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { getGithubApp } from '../lib/github';

test('one request waiting for a GitHub token cannot block another request client', async (t) => {
  const previous = { ...process.env };
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  Object.assign(process.env, {
    BETTER_AUTH_SECRET: 'test-secret-that-is-at-least-32-characters',
    BETTER_AUTH_URL: 'https://factory.example.test',
    GITHUB_APP_ID: '1',
    GITHUB_APP_PRIVATE_KEY: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    GITHUB_APP_CLIENT_ID: 'test-client',
    GITHUB_APP_CLIENT_SECRET: 'test-secret',
    GITHUB_APP_SLUG: 'test-factory',
  });
  let release!: () => void;
  let started!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const firstStarted = new Promise<void>((resolve) => { started = resolve; });
  t.mock.method(globalThis, 'fetch', async (url: string | URL | Request) => {
    if (String(url).includes('/installations/1/')) {
      started();
      await held;
    }
    return Response.json({ token: 'test-token', expires_at: '2099-01-01T00:00:00Z' });
  });
  let first: Promise<unknown> | undefined;
  let second: Promise<unknown> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    first = getGithubApp().octokit.request('POST /app/installations/{installation_id}/access_tokens', { installation_id: 1 });
    await firstStarted;
    second = getGithubApp().octokit.request('POST /app/installations/{installation_id}/access_tokens', { installation_id: 2 });
    const result = await Promise.race([
      second,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Independent token request blocked by shared throttle')), 1000); }),
    ]) as { data: { token: string } };
    assert.equal(result.data.token, 'test-token');
  } finally {
    clearTimeout(timer);
    release();
    await Promise.allSettled([first, second]);
    for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
    Object.assign(process.env, previous);
  }
});
