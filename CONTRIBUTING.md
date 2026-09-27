# Contributing

Thanks for helping improve Factory.

## Before you start

- For anything beyond a small fix, open an issue first so we can agree on the approach.
- Security problems go through [SECURITY.md](SECURITY.md), not public issues.

## Development

```bash
pnpm install
cp .dev.vars.example .dev.vars
pnpm d1:migrate:local
pnpm dev
```

The runner in `sandbox-runner/` is a separate package with its own lockfile.

Next.js in this repository is a recent major version; read `node_modules/next/dist/docs/` before relying on older APIs.

## Pull requests

- Keep changes focused. One concern per PR.
- Add or update tests for behaviour changes.
- All of these must pass:

  ```bash
  pnpm test
  pnpm typecheck
  pnpm lint
  (cd sandbox-runner && pnpm run typecheck)
  ```

- Run `pnpm test:e2e` when you touch sign-in, navigation or the work board.
- Schema changes need a Drizzle migration (`pnpm db:generate`). Never edit a migration that has shipped.
- Use [Conventional Commits](https://www.conventionalcommits.org/) (`feat:`, `fix:`, `docs:` and so on).

By contributing, you agree your contributions are licensed under the [MIT License](LICENSE).
