# Webhook Deploy for price-tracker

**Date:** 2026-06-08
**Status:** Approved — ready for implementation plan

## Problem

Deploying price-tracker today is manual: a human runs `scripts/deploy.sh` from
CT 300, which builds server + client locally and rsyncs the result to CT 302.
The client is built on CT 300 specifically because the `VITE_*` build-time vars
live in the dev machine's `client/.env`. We want push-to-deploy: merge to `main`,
and once CI is green, CT 302 updates itself — no human in the loop, nothing new
exposed to the internet, and the dev box removed from the deploy path.

## Goals

- Merge to `main` → CI passes → CT 302 redeploys automatically.
- Never deploy a commit that failed CI.
- Keep the existing manual `deploy.sh` as a break-glass path.
- No reduction in the existing deploy safety checks (DB backup, live-bundle verify).

## Non-goals

- Self-hosted CI runner (rejected: price-tracker is public; hosted minutes are free
  and unlimited; a runner on a public repo is a LAN security hazard).
- Multi-environment / staging deploys.
- Code rollback automation (git checkout of a prior SHA remains a manual action).
- Building the client in CI and shipping an artifact (rejected in favor of
  building on CT 302 so the build stays self-contained and secrets stay on the LAN).

## Architecture

```
push to main ─▶ GitHub CI (hosted, free)
                     │ completes
                     ▼
   GitHub workflow_run webhook ──CF tunnel──▶ NPM ──▶ 127.0.0.1:9000 (listener on CT 302)
                                                            │ verify HMAC + CI==success + branch==main
                                                            ▼
                                                   deploy-local.sh (git checkout SHA →
                                                   build server + client → backup db →
                                                   restart service → verify live bundle)
```

A small **deploy-listener** service runs on CT 302, bound to `127.0.0.1:9000`.
GitHub sends a `workflow_run` webhook when the CI workflow finishes. The listener
verifies the request, confirms CI passed on `main`, and runs a local deploy script.
The endpoint reaches GitHub via a new NPM proxy host → existing CF tunnel
(`pt-deploy.schultzsolutions.tech`).

**Key shift from today:** CT 302 owns the entire build (server *and* client).
The rsync-from-dev model in `deploy.sh` is superseded; `/opt/price-tracker` on
CT 302 becomes a real git checkout that builds itself. The dev box leaves the
deploy path.

## Components

### 1. `deploy-listener` (new) — single-file Node/Express service on CT 302

- One route: `POST /hook`. Everything else → 404.
- Verifies `X-Hub-Signature-256` HMAC over the **raw request body**
  (constant-time compare) against a shared webhook secret. Invalid/missing → 401.
- Proceeds only if the `workflow_run` payload has `action == "completed"`,
  `workflow.name == "CI"`, `conclusion == "success"`, `head_branch == "main"`.
  Any other valid-but-irrelevant event → `204 No Content`.
- Responds `202 Accepted` immediately, then runs the deploy asynchronously
  (GitHub expects a <10s response; a build takes minutes).
- Runs as systemd unit `price-tracker-deploy.service`; logs to journald with the
  triggering commit SHA on every line of interest.

**Raw-body footgun:** the HMAC must be computed over the exact bytes GitHub sent.
The route uses a raw-body parser (`express.raw({type: '*/*'})` or equivalent),
**not** `express.json()` before verification — re-serializing the body breaks the
signature.

### 2. `scripts/deploy-local.sh` (new, in repo) — build-on-302 deploy

Steps, in order:
1. `git fetch` then `git checkout <head_sha>` — deploy the **exact commit CI
   validated**, not "whatever is on main right now."
2. Build server.
3. Build client (now with `VITE_VAPID_PUBLIC_KEY` sourced from CT 302's
   `client/.env`).
4. Back up the SQLite DB (port the existing rotation logic: keep last 10).
5. `systemctl restart price-tracker`.
6. Verify the live bundle hash served at `https://prices.schultzsolutions.tech/`
   matches the freshly-built bundle (port the existing safety check from
   `deploy.sh`).

Build happens **before** restart, so a failed build never takes down the running
service. Supports a `--no-restart` dry-run mode for testing (checkout + build +
bundle-verify without touching the live service).

### 3. Repo conversion (one-time)

`/opt/price-tracker` on CT 302 is currently an rsync copy with `.git` excluded.
Convert it to a real `git clone` of the repo so `deploy-local.sh` can check out
commits. Preserve the existing `data/` dir and `.env` files (not tracked).

### 4. `deploy.sh` (existing) — retained as manual break-glass

Still works as-is for a push-button deploy from CT 300 if the webhook chain is
down. Not modified.

## Concurrency & failure handling

- **Single-slot coalescing:** if a deploy is running and another event arrives,
  set a "rerun" flag rather than queueing N deploys. When the current deploy
  finishes, if the flag is set, deploy once more to the latest green commit.
  Converges to newest without stacking builds.
- **On failure:** full detail to journald (the failing step + the SHA). The
  service keeps running the previous build. DB backup happens before restart, so
  data is safe. A failed deploy is loud in logs and invisible to users.

## Security

- **HMAC signature is the primary gate.** Recompute over the raw body,
  constant-time compare. No valid signature → 401, no deploy.
- **Payload allow-listing** (event/workflow/conclusion/branch) means a
  validly-signed event for a failed run or a feature branch is a no-op.
- **Listener binds `127.0.0.1` only.** The single ingress is CF tunnel → NPM
  proxy host; the only reachable surface is `POST /hook`.
- **Secret storage:** webhook secret in `/opt/price-tracker-deploy/.env`
  (mode 600), never in the repo. Mirrors the existing `~/.secrets/*.env` pattern.
- **Optional defense-in-depth (deferred):** a Cloudflare WAF rule allowing only
  GitHub's published webhook IP ranges to the path. Not load-bearing; add later
  if desired.
- **Note on `VITE_VAPID_PUBLIC_KEY`:** it is a *public* key (shipped to every
  browser), so placing it in CT 302's `client/.env` exposes nothing secret.

## Testing & verification

- **Unit:** signature verification (valid / tampered / missing); payload filter
  (passing CI vs failed CI vs wrong branch → deploy or no-op). The
  security-critical paths get real tests.
- **`deploy-local.sh`:** exercise `--no-restart` dry-run (checkout + build +
  bundle-verify) without touching the live service.
- **End-to-end (mandatory before done):** `workflow_dispatch` a CI run on a
  trivial commit; watch journald show receive → verify → deploy → bundle-match;
  confirm the live site serves the new bundle.
- **Negative E2E:** push a commit that fails CI; confirm **no** deploy fires.

## One-time setup checklist (deploy-time, not code)

- [ ] Convert `/opt/price-tracker` to a git clone (preserve `data/`, `.env`).
- [ ] Create CT 302 `client/.env` with `VITE_VAPID_PUBLIC_KEY`.
- [ ] Create `/opt/price-tracker-deploy/.env` with `WEBHOOK_SECRET` (mode 600).
- [ ] Install + enable `price-tracker-deploy.service`.
- [ ] Add NPM proxy host `pt-deploy.schultzsolutions.tech` → `127.0.0.1:9000`.
- [ ] Register the GitHub webhook (workflow_run events) with the shared secret.
