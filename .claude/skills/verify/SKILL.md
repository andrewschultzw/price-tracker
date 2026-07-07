---
name: verify
description: Use when a price-tracker change is about to be committed, PR'd, or reported done — especially UI changes where tests and tsc are already green, and especially "just a small tweak".
---

# Verifying a Price-Tracker Change

## Overview

CI green is not a working app. PR #41 passed typecheck, 128 client + 836 server
tests, and built clean — then shipped a blank login screen (a hooks-order bug
that only fired on the loading→loaded transition). Done = CI parity + render proof.

## Gate 1 — CI parity (every change)

Mirror `.github/workflows/ci.yml` exactly — all three workspaces even if you
touched one:

```bash
(cd server    && npm test -- --run && npx tsc --noEmit)
(cd client    && npm test -- --run && npx tsc --noEmit && npm run build)
(cd extension && npm test && npm run typecheck && npm run build)
```

CI runs nothing else (no eslint) — don't invent gates, don't skip these.

**Extension parity trap:** the extension has a Tracker-parity drift test that
fails whenever the server's `Tracker` type gains a field. Fix by mirroring the
field in the extension's types — never by loosening the test.

## Gate 2 — render smoke (any `client/src` change)

1. Component tests must cover **both loading and loaded states**. An
   initial-render-only test misses every state-transition bug, including the
   entire hooks-order class.
2. Prove it renders. The Playwright **MCP** browser is network-isolated, but the
   repo's own `playwright` (server dep) reaches localhost fine:

```bash
(cd server && npm run dev &)   # API :3100, dev DB
(cd client && npm run dev &)   # vite :5173, proxies /api → :3100
node .claude/skills/verify/render-smoke.cjs \
  http://localhost:5173 /tmp/dashboard.png   # exits 1 on any console/page error
```

Look at the screenshot yourself; if the change is user-visible, send it to
Andrew with the PR. If the app genuinely can't be served locally, the render
gate is **owed** — say so in the PR verbatim; never report "browser-verified"
for a render you never rendered.

## Gate 3 — deploy verification (post-merge)

Merge → CI → `workflow_run` webhook → CT 302 listener rebuilds. Confirm it landed:

```bash
gh pr checks <PR#> --watch
ssh root@192.168.1.166 "journalctl -u price-tracker-deploy -n 20"
curl -s -o /dev/null -w '%{http_code}\n' https://prices.schultzsolutions.tech   # 200
```

Deploy gotchas (each has bitten before):
- `VITE_*` vars bake in at client **build time** from `client/.env` on the
  building machine. `scripts/rebuild.sh` does **not** rebuild the client.
- `DATABASE_PATH` must be absolute (systemd `WorkingDirectory` is `server/`).

## Red flags

- "It's a tiny UI tweak and tests are green" — that was PR #41.
- "I'll browser-check after merge" — merge **is** the deploy (webhook). Smoke first.
- Reporting "verified" without stating exactly what you ran and observed.
