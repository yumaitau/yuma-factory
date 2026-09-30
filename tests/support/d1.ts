import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { drizzle } from 'drizzle-orm/d1';
import * as schema from '../../db/schema';

/** Exercise real SQLite queries with D1's transactional batch semantics. */
export function lifecycleDatabase() {
  const sqlite = new DatabaseSync(':memory:');
  const directory = new URL('../../drizzle/', import.meta.url);
  for (const file of readdirSync(directory).filter((name) => name.endsWith('.sql')).sort())
    sqlite.exec(readFileSync(new URL(file, directory), 'utf8'));
  type Bound = { all(): Promise<{ results: unknown[] }> };
  const binding = {
    prepare(query: string) {
      return { bind(...params: unknown[]) {
        const statement = sqlite.prepare(query);
        return {
          async raw() { statement.setReturnArrays(true); return statement.all(...params as never[]); },
          async all() { return { results: statement.all(...params as never[]) }; },
          async run() { statement.run(...params as never[]); return { success: true }; },
        };
      } };
    },
    async batch(statements: Bound[]) {
      sqlite.exec('BEGIN');
      try {
        const results = [];
        for (const statement of statements) results.push(await statement.all());
        sqlite.exec('COMMIT');
        return results;
      } catch (error) { sqlite.exec('ROLLBACK'); throw error; }
    },
  };
  sqlite.exec(`
    INSERT INTO users (id, name, email, created_at, updated_at) VALUES ('user', 'User', 'user@example.com', 0, 0);
    INSERT INTO agents (id, owner_user_id, name, created_at, updated_at) VALUES ('worker', 'user', 'Worker', 0, 0), ('other', 'user', 'Other', 0, 0);
    INSERT INTO github_installations (id, installation_id, account_login, account_type, connected_by_user_id, created_at, updated_at)
      VALUES ('installation', 1, 'org', 'Organization', 'user', 0, 0);
    INSERT INTO projects (id, installation_id, repo_full_name, repo_id, created_at, updated_at) VALUES ('project', 'installation', 'org/repo', 1, 0, 0);
    INSERT INTO tickets (id, project_id, github_issue_number, github_issue_id, title, html_url, labels, created_at, updated_at)
      VALUES ('ticket', 'project', 1, 1, 'Work', 'https://github.com/org/repo/issues/1', '["factory:ready"]', 0, 0),
      ('second', 'project', 2, 2, 'Second', 'https://github.com/org/repo/issues/2', '["factory:ready"]', 0, 0);
    INSERT INTO codex_accounts (id, owner_user_id, label, status, created_at, updated_at) VALUES ('account', 'user', 'Account', 'ready', 0, 0);
  `);
  return { db: drizzle(binding as unknown as D1Database, { schema }), sqlite };
}
