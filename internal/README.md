# Yuma deployment (private)

This repository is the production source for https://factory.yumait.au. These notes cover the Yuma deployment.

## Where Yuma settings live

| Setting | Location |
| --- | --- |
| App name, label prefix (`Yuma Factory`, `yuma`) | Build env in `.github/workflows/cloudflare-deploy.yml` |
| Domains, trusted origins, PaperBoy URL/sender | `vars` in `wrangler.jsonc` |
| Runner label prefix, commit author, callback URL | `vars` in `sandbox-runner/wrangler.jsonc` |
| D1 ID, routes, resource names | `wrangler.jsonc`, `sandbox-runner/wrangler.jsonc` |
| Logo and icons | `public/logo.svg`, `public/favicon.svg`, `app/icon.svg` |

`NEXT_PUBLIC_LABEL_PREFIX` (build) and the runner's `LABEL_PREFIX` must both stay `yuma`, or existing `yuma:*` GitHub labels stop matching.

The PaperBoy digest also needs the `PAPERBOY_API_KEY` secret on `yuma-factory`; it is not set as of 2026-09-24, so no digest is sent.

## Deploy

Pushes to `main` run `.github/workflows/cloudflare-deploy.yml`, which tests, builds, applies D1 migrations and deploys both Workers with the shared organisation token. Runner deploys happen only when `sandbox-runner/` or `shared/` changes. Container image rollouts need a manual dispatch with `update_container_image`.
