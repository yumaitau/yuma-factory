import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_API_KEYS, apiKeyOwner, createApiKey, listApiKeys, revokeApiKey } from '../lib/api-keys';
import { bearerActor, crossOrigin } from '../lib/factory-auth';
import { FACTORY_OPERATIONS } from '../lib/factory-catalog';
import { runFactoryOperation } from '../lib/factory-operations';
import { lifecycleDatabase } from './support/d1';

test('a personal key acts as its owner until revoked, and only its digest is stored', async () => {
  const { db, sqlite } = lifecycleDatabase();
  try {
    const created = await createApiKey(db, 'user', '  Claude Code  ');
    assert.match(created.key, /^fk_[A-Za-z0-9_-]{43}$/);
    assert.equal(created.name, 'Claude Code');
    const stored = sqlite.prepare('SELECT hash, prefix FROM api_keys').get() as { hash: string; prefix: string };
    assert.notEqual(stored.hash, created.key);
    assert.ok(!stored.hash.includes(created.key.slice(3)));
    assert.equal(stored.prefix, created.key.slice(0, 10));

    assert.equal(await apiKeyOwner(db, created.key, () => true), 'user');
    assert.ok((await listApiKeys(db, 'user'))[0].lastUsedAt);
    for (const wrong of [null, '', created.key.slice(0, -1), `${created.key}x`, created.key.replace('fk_', 'xx_')])
      assert.equal(await apiKeyOwner(db, wrong, () => true), null, String(wrong));

    // Someone who may no longer sign in loses their keys; an expired key stops working.
    const allowAll = () => true;
    assert.equal(await apiKeyOwner(db, created.key, () => false), null);
    sqlite.exec('UPDATE api_keys SET expires_at = 1');
    assert.equal(await apiKeyOwner(db, created.key, allowAll), null);
    sqlite.exec(`UPDATE api_keys SET expires_at = ${Math.floor(Date.now() / 1000) + 3600}`);
    assert.equal(await apiKeyOwner(db, created.key, allowAll), 'user');
    // Another person cannot revoke it.
    sqlite.exec("INSERT INTO users (id, name, email, created_at, updated_at) VALUES ('other', 'Other', 'other@example.com', 0, 0)");
    await assert.rejects(revokeApiKey(db, 'other', created.id), /not found/);
    await revokeApiKey(db, 'user', created.id);
    assert.equal(await apiKeyOwner(db, created.key, () => true), null);
    await assert.rejects(revokeApiKey(db, 'user', created.id), /already revoked/);

    await assert.rejects(createApiKey(db, 'user', '   '), /Name the key/);
    for (let i = 0; i < MAX_API_KEYS; i++) await createApiKey(db, 'user', `key ${i}`);
    await assert.rejects(createApiKey(db, 'user', 'one too many'), /Revoke one first/);
  } finally { sqlite.close(); }
});

test('operations that act as a person refuse the shared key, and every MCP tool is unique and listed', async () => {
  for (const operation of FACTORY_OPERATIONS.filter((item) => item.person))
    await assert.rejects(runFactoryOperation(operation.id, {}, { userId: null }), (error: Error & { status?: number }) =>
      error.status === 403 && /personal API key/.test(error.message), operation.id);
  const tools = FACTORY_OPERATIONS.flatMap((operation) => operation.mcp ? [operation.mcp] : []);
  assert.equal(new Set(tools).size, tools.length);
  const routes = FACTORY_OPERATIONS.map((operation) => `${operation.method} ${operation.path.replace(/\{[^}]+\}/g, '{}')}`);
  assert.equal(new Set(routes).size, routes.length);
  // Control tools exist for what the app can do.
  for (const name of ['factory_start_run', 'factory_stop_run', 'factory_prompt_run', 'factory_get_run_log', 'factory_move_ticket',
    'factory_retry_failed', 'factory_accept_review', 'factory_merge_review', 'factory_set_automation', 'factory_set_subscription'])
    assert.ok(tools.includes(name), name);
  // Everything that changes state outside memory, plans and the digest needs a person.
  for (const operation of FACTORY_OPERATIONS.filter((item) => item.mutating && !item.person))
    assert.match(operation.id, /Pickup|Digest|Memory|Plan|Message/, operation.id);
});

test('a bearer token decides alone: a personal key is its owner, the shared key nobody, anything else 401', async () => {
  const keys = async (token: string) => token === 'fk_good' ? 'user' : null;
  assert.deepEqual(await bearerActor('fk_good', keys, 'shared'), { ok: true, actor: { userId: 'user' } });
  assert.deepEqual(await bearerActor('shared', keys, 'shared'), { ok: true, actor: { userId: null } });
  for (const [token, shared] of [['fk_revoked', 'shared'], ['wrong', 'shared'], ['shared', undefined], ['fk_shared', 'fk_shared']] as const) {
    const result = await bearerActor(token, keys, shared);
    assert.equal(result.ok, false, token);
    if (!result.ok) assert.equal(result.response.status, 401);
  }
});

test('browser requests from another origin are refused; machine clients send no Origin', () => {
  const request = (origin?: string) => new Request('https://factory.example/api/v1/runs/x/merge', { method: 'POST', headers: origin ? { origin } : {} });
  assert.equal(crossOrigin(request()), false);
  assert.equal(crossOrigin(request('https://factory.example')), false);
  assert.equal(crossOrigin(request('https://other.example.com')), true);
  assert.equal(crossOrigin(request('null')), true);
});
