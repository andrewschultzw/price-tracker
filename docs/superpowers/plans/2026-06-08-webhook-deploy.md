# Webhook Deploy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Push-to-deploy for price-tracker: merge to `main` → CI passes → CT 302 rebuilds and restarts itself, with no human in the loop and nothing new exposed beyond a signature-verified webhook endpoint.

**Architecture:** A small Node/Express `deploy-listener` runs on CT 302 bound to `127.0.0.1:9000`, fronted by a new NPM proxy host → existing CF tunnel. GitHub sends a `workflow_run` webhook when CI finishes; the listener verifies the HMAC signature, confirms the run was CI / success / `main`, responds `202` immediately, then runs `scripts/deploy-local.sh` which checks out the exact validated SHA, builds server + client on CT 302, backs up the DB, restarts the service, and verifies the live bundle.

**Tech Stack:** TypeScript (ESM), Express, Node `crypto` (HMAC), Zod (config), pino (logging), Vitest + supertest (tests), Bash (deploy script), systemd, NPM (nginx proxy), Cloudflare Tunnel.

**Spec:** `docs/superpowers/specs/2026-06-08-webhook-deploy-design.md`

---

## File Structure

All listener code lives in the **existing `server` workspace** so it reuses Express, Zod, pino, Vitest, and the `tsc` build already in place. The listener is a *separate process/entry* (`server/dist/deploy/listener.js`) run by its own systemd unit — it is not wired into the main app.

- Create: `server/src/deploy/config.ts` — Zod-validated env config for the listener (port, secret, repo root, public URL, deploy script path).
- Create: `server/src/deploy/config.test.ts`
- Create: `server/src/deploy/verify.ts` — pure functions: `verifySignature()` (constant-time HMAC) and `shouldDeploy()` (payload allow-list).
- Create: `server/src/deploy/verify.test.ts`
- Create: `server/src/deploy/queue.ts` — `createDeployQueue()`: single-slot coalescing runner.
- Create: `server/src/deploy/queue.test.ts`
- Create: `server/src/deploy/app.ts` — `createListenerApp()`: Express wiring (raw body, `POST /hook`, 202/401/204/404). Takes deps by injection for testing.
- Create: `server/src/deploy/app.test.ts`
- Create: `server/src/deploy/listener.ts` — entry `main()`: load config, wire real deploy spawn, `app.listen()`.
- Create: `scripts/deploy-local.sh` — build-on-302 deploy (checkout SHA → build → backup → restart → verify bundle).
- Create: `scripts/price-tracker-deploy.service` — checked-in systemd unit template.
- Modify: `docs/deployment.md` — document the new push-to-deploy flow + break-glass.

**Naming locked across tasks:**
- `verifySignature(rawBody: Buffer, signatureHeader: string | undefined, secret: string): boolean`
- `shouldDeploy(payload: unknown): { deploy: boolean; reason: string; sha: string | null }`
- `createDeployQueue(deployFn: (sha: string) => Promise<void>): { enqueue: (sha: string) => void; isRunning: () => boolean }`
- `createListenerApp(deps: { secret: string; queue: { enqueue: (sha: string) => void } }): express.Express`
- Env vars: `DEPLOY_WEBHOOK_SECRET`, `DEPLOY_PORT` (default `9000`), `DEPLOY_REPO_ROOT` (default `/opt/price-tracker`), `DEPLOY_PUBLIC_URL` (default `https://prices.schultzsolutions.tech`).

---

## Task 1: Listener config module

**Files:**
- Create: `server/src/deploy/config.ts`
- Test: `server/src/deploy/config.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// server/src/deploy/config.test.ts
import { describe, it, expect } from 'vitest';
import { loadDeployConfig } from './config.js';

describe('loadDeployConfig', () => {
  it('parses a full env', () => {
    const cfg = loadDeployConfig({
      DEPLOY_WEBHOOK_SECRET: 'shhh',
      DEPLOY_PORT: '9001',
      DEPLOY_REPO_ROOT: '/srv/pt',
      DEPLOY_PUBLIC_URL: 'https://example.test',
    });
    expect(cfg).toEqual({
      secret: 'shhh',
      port: 9001,
      repoRoot: '/srv/pt',
      publicUrl: 'https://example.test',
    });
  });

  it('applies defaults for everything except the secret', () => {
    const cfg = loadDeployConfig({ DEPLOY_WEBHOOK_SECRET: 'shhh' });
    expect(cfg.port).toBe(9000);
    expect(cfg.repoRoot).toBe('/opt/price-tracker');
    expect(cfg.publicUrl).toBe('https://prices.schultzsolutions.tech');
  });

  it('throws when the secret is missing or empty', () => {
    expect(() => loadDeployConfig({})).toThrow();
    expect(() => loadDeployConfig({ DEPLOY_WEBHOOK_SECRET: '' })).toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run src/deploy/config.test.ts`
Expected: FAIL — `Cannot find module './config.js'`.

- [ ] **Step 3: Write minimal implementation**

```typescript
// server/src/deploy/config.ts
import { z } from 'zod';

const schema = z.object({
  DEPLOY_WEBHOOK_SECRET: z.string().min(1, 'DEPLOY_WEBHOOK_SECRET is required'),
  DEPLOY_PORT: z.coerce.number().int().positive().default(9000),
  DEPLOY_REPO_ROOT: z.string().min(1).default('/opt/price-tracker'),
  DEPLOY_PUBLIC_URL: z.string().url().default('https://prices.schultzsolutions.tech'),
});

export interface DeployConfig {
  secret: string;
  port: number;
  repoRoot: string;
  publicUrl: string;
}

export function loadDeployConfig(env: NodeJS.ProcessEnv | Record<string, string | undefined>): DeployConfig {
  const parsed = schema.parse(env);
  return {
    secret: parsed.DEPLOY_WEBHOOK_SECRET,
    port: parsed.DEPLOY_PORT,
    repoRoot: parsed.DEPLOY_REPO_ROOT,
    publicUrl: parsed.DEPLOY_PUBLIC_URL,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && npx vitest run src/deploy/config.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add server/src/deploy/config.ts server/src/deploy/config.test.ts
git commit -m "feat(deploy): add listener config loader

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 2: Signature verification

**Files:**
- Create: `server/src/deploy/verify.ts`
- Test: `server/src/deploy/verify.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// server/src/deploy/verify.test.ts
import { describe, it, expect } from 'vitest';
import { createHmac } from 'crypto';
import { verifySignature } from './verify.js';

const SECRET = 'test-secret';

function sign(body: Buffer, secret = SECRET): string {
  return 'sha256=' + createHmac('sha256', secret).update(body).digest('hex');
}

describe('verifySignature', () => {
  it('accepts a correctly signed body', () => {
    const body = Buffer.from(JSON.stringify({ hello: 'world' }));
    expect(verifySignature(body, sign(body), SECRET)).toBe(true);
  });

  it('rejects a tampered body', () => {
    const body = Buffer.from(JSON.stringify({ hello: 'world' }));
    const sig = sign(body);
    const tampered = Buffer.from(JSON.stringify({ hello: 'evil' }));
    expect(verifySignature(tampered, sig, SECRET)).toBe(false);
  });

  it('rejects a signature made with the wrong secret', () => {
    const body = Buffer.from('payload');
    expect(verifySignature(body, sign(body, 'wrong'), SECRET)).toBe(false);
  });

  it('rejects a missing signature header', () => {
    expect(verifySignature(Buffer.from('x'), undefined, SECRET)).toBe(false);
  });

  it('rejects a malformed signature header', () => {
    expect(verifySignature(Buffer.from('x'), 'garbage', SECRET)).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run src/deploy/verify.test.ts`
Expected: FAIL — `verifySignature` not exported / module not found.

- [ ] **Step 3: Write minimal implementation**

```typescript
// server/src/deploy/verify.ts
import { createHmac, timingSafeEqual } from 'crypto';

/**
 * Verify GitHub's X-Hub-Signature-256 over the RAW request body.
 * Must be the exact bytes GitHub sent — re-serialized JSON will not match.
 */
export function verifySignature(
  rawBody: Buffer,
  signatureHeader: string | undefined,
  secret: string,
): boolean {
  if (!signatureHeader || !signatureHeader.startsWith('sha256=')) return false;
  const expected = 'sha256=' + createHmac('sha256', secret).update(rawBody).digest('hex');
  const a = Buffer.from(signatureHeader);
  const b = Buffer.from(expected);
  // timingSafeEqual throws on length mismatch — guard first.
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && npx vitest run src/deploy/verify.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add server/src/deploy/verify.ts server/src/deploy/verify.test.ts
git commit -m "feat(deploy): add constant-time webhook signature verification

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 3: Payload allow-list (`shouldDeploy`)

**Files:**
- Modify: `server/src/deploy/verify.ts`
- Modify: `server/src/deploy/verify.test.ts`

- [ ] **Step 1: Write the failing test (append to verify.test.ts)**

```typescript
// append to server/src/deploy/verify.test.ts
import { shouldDeploy } from './verify.js';

function workflowRun(over: Record<string, unknown> = {}) {
  return {
    action: 'completed',
    workflow_run: {
      name: 'CI',
      conclusion: 'success',
      head_branch: 'main',
      head_sha: 'abc123',
      ...over,
    },
  };
}

describe('shouldDeploy', () => {
  it('deploys on completed + CI + success + main', () => {
    const r = shouldDeploy(workflowRun());
    expect(r.deploy).toBe(true);
    expect(r.sha).toBe('abc123');
  });

  it('skips when the run failed', () => {
    expect(shouldDeploy(workflowRun({ conclusion: 'failure' })).deploy).toBe(false);
  });

  it('skips a non-main branch', () => {
    expect(shouldDeploy(workflowRun({ head_branch: 'feature/x' })).deploy).toBe(false);
  });

  it('skips a non-CI workflow', () => {
    expect(shouldDeploy(workflowRun({ name: 'Release' })).deploy).toBe(false);
  });

  it('skips actions other than completed', () => {
    expect(shouldDeploy({ action: 'requested', workflow_run: { name: 'CI' } }).deploy).toBe(false);
  });

  it('skips a payload with no workflow_run (e.g. a ping event)', () => {
    expect(shouldDeploy({ zen: 'hi' }).deploy).toBe(false);
  });

  it('returns a human-readable reason', () => {
    expect(shouldDeploy(workflowRun({ conclusion: 'failure' })).reason).toMatch(/conclusion/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run src/deploy/verify.test.ts`
Expected: FAIL — `shouldDeploy` not exported.

- [ ] **Step 3: Add implementation to verify.ts**

```typescript
// append to server/src/deploy/verify.ts
import { z } from 'zod';

const workflowRunSchema = z.object({
  action: z.string(),
  workflow_run: z.object({
    name: z.string(),
    conclusion: z.string().nullable(),
    head_branch: z.string(),
    head_sha: z.string(),
  }),
});

export function shouldDeploy(payload: unknown): { deploy: boolean; reason: string; sha: string | null } {
  const parsed = workflowRunSchema.safeParse(payload);
  if (!parsed.success) return { deploy: false, reason: 'not a workflow_run event', sha: null };

  const run = parsed.data.workflow_run;
  if (parsed.data.action !== 'completed') return { deploy: false, reason: `action is ${parsed.data.action}`, sha: null };
  if (run.name !== 'CI') return { deploy: false, reason: `workflow is ${run.name}`, sha: null };
  if (run.head_branch !== 'main') return { deploy: false, reason: `branch is ${run.head_branch}`, sha: null };
  if (run.conclusion !== 'success') return { deploy: false, reason: `conclusion is ${run.conclusion}`, sha: null };

  return { deploy: true, reason: 'CI success on main', sha: run.head_sha };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && npx vitest run src/deploy/verify.test.ts`
Expected: PASS (all tests, including the 5 from Task 2).

- [ ] **Step 5: Commit**

```bash
git add server/src/deploy/verify.ts server/src/deploy/verify.test.ts
git commit -m "feat(deploy): add workflow_run payload allow-list

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 4: Single-slot coalescing deploy queue

**Files:**
- Create: `server/src/deploy/queue.ts`
- Test: `server/src/deploy/queue.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// server/src/deploy/queue.test.ts
import { describe, it, expect } from 'vitest';
import { createDeployQueue } from './queue.js';

/** A deferred promise we can resolve from the test to control timing. */
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
}

describe('createDeployQueue', () => {
  it('runs a single deploy', async () => {
    const calls: string[] = [];
    const q = createDeployQueue(async (sha) => { calls.push(sha); });
    q.enqueue('a');
    await new Promise((r) => setImmediate(r));
    expect(calls).toEqual(['a']);
  });

  it('coalesces events that arrive while a deploy is running into one rerun', async () => {
    const calls: string[] = [];
    const gate = deferred();
    const q = createDeployQueue(async (sha) => {
      calls.push(sha);
      if (calls.length === 1) await gate.promise; // hold the first deploy open
    });

    q.enqueue('first');                 // starts running, blocks on gate
    await new Promise((r) => setImmediate(r));
    q.enqueue('second');                // arrives while running -> rerun flag
    q.enqueue('third');                 // overwrites rerun flag -> latest wins
    gate.resolve();                     // let first finish
    await new Promise((r) => setTimeout(r, 10));

    expect(calls).toEqual(['first', 'third']); // 'second' coalesced away
  });

  it('reports running state', async () => {
    const gate = deferred();
    const q = createDeployQueue(async () => { await gate.promise; });
    expect(q.isRunning()).toBe(false);
    q.enqueue('a');
    await new Promise((r) => setImmediate(r));
    expect(q.isRunning()).toBe(true);
    gate.resolve();
    await new Promise((r) => setTimeout(r, 10));
    expect(q.isRunning()).toBe(false);
  });

  it('keeps running after a deploy throws', async () => {
    const calls: string[] = [];
    const q = createDeployQueue(async (sha) => {
      calls.push(sha);
      if (sha === 'boom') throw new Error('deploy failed');
    });
    q.enqueue('boom');
    await new Promise((r) => setTimeout(r, 10));
    q.enqueue('ok');
    await new Promise((r) => setTimeout(r, 10));
    expect(calls).toEqual(['boom', 'ok']);
    expect(q.isRunning()).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run src/deploy/queue.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```typescript
// server/src/deploy/queue.ts
import { logger } from '../logger.js';

export interface DeployQueue {
  enqueue: (sha: string) => void;
  isRunning: () => boolean;
}

/**
 * Single-slot coalescing queue. While a deploy runs, the newest incoming SHA
 * is remembered (older pending SHAs are discarded); when the current deploy
 * finishes, it runs once more for that newest SHA. Converges to the latest
 * green commit without stacking N builds.
 */
export function createDeployQueue(deployFn: (sha: string) => Promise<void>): DeployQueue {
  let running = false;
  let pending: string | null = null;

  async function drain(sha: string): Promise<void> {
    running = true;
    let next: string | null = sha;
    try {
      while (next) {
        const current = next;
        pending = null;
        try {
          await deployFn(current);
        } catch (err) {
          logger.error({ err, sha: current }, 'deploy failed; previous build still running');
        }
        next = pending;
      }
    } finally {
      running = false;
    }
  }

  return {
    enqueue(sha: string) {
      if (running) {
        pending = sha;
        logger.info({ sha }, 'deploy in progress; coalescing into rerun');
        return;
      }
      void drain(sha);
    },
    isRunning: () => running,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && npx vitest run src/deploy/queue.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add server/src/deploy/queue.ts server/src/deploy/queue.test.ts
git commit -m "feat(deploy): add single-slot coalescing deploy queue

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 5: Listener Express app

**Files:**
- Create: `server/src/deploy/app.ts`
- Test: `server/src/deploy/app.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// server/src/deploy/app.test.ts
import { describe, it, expect, vi } from 'vitest';
import { createHmac } from 'crypto';
import request from 'supertest';
import { createListenerApp } from './app.js';

const SECRET = 'test-secret';

function sign(body: string, secret = SECRET): string {
  return 'sha256=' + createHmac('sha256', secret).update(Buffer.from(body)).digest('hex');
}

function appWithSpy() {
  const enqueue = vi.fn();
  const app = createListenerApp({ secret: SECRET, queue: { enqueue } });
  return { app, enqueue };
}

const successBody = JSON.stringify({
  action: 'completed',
  workflow_run: { name: 'CI', conclusion: 'success', head_branch: 'main', head_sha: 'deadbeef' },
});

describe('createListenerApp', () => {
  it('202 + enqueues on a valid, signed, deployable event', async () => {
    const { app, enqueue } = appWithSpy();
    const res = await request(app)
      .post('/hook')
      .set('X-Hub-Signature-256', sign(successBody))
      .set('Content-Type', 'application/json')
      .send(successBody);
    expect(res.status).toBe(202);
    expect(enqueue).toHaveBeenCalledWith('deadbeef');
  });

  it('401 + no enqueue on a bad signature', async () => {
    const { app, enqueue } = appWithSpy();
    const res = await request(app)
      .post('/hook')
      .set('X-Hub-Signature-256', 'sha256=bad')
      .set('Content-Type', 'application/json')
      .send(successBody);
    expect(res.status).toBe(401);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('204 + no enqueue on a valid-but-irrelevant event (failed CI)', async () => {
    const { app, enqueue } = appWithSpy();
    const body = JSON.stringify({
      action: 'completed',
      workflow_run: { name: 'CI', conclusion: 'failure', head_branch: 'main', head_sha: 'x' },
    });
    const res = await request(app)
      .post('/hook')
      .set('X-Hub-Signature-256', sign(body))
      .set('Content-Type', 'application/json')
      .send(body);
    expect(res.status).toBe(204);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('404 on any other route', async () => {
    const { app } = appWithSpy();
    expect((await request(app).get('/')).status).toBe(404);
    expect((await request(app).post('/deploy')).status).toBe(404);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run src/deploy/app.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```typescript
// server/src/deploy/app.ts
import express from 'express';
import { logger } from '../logger.js';
import { verifySignature, shouldDeploy } from './verify.js';

export interface ListenerDeps {
  secret: string;
  queue: { enqueue: (sha: string) => void };
}

export function createListenerApp(deps: ListenerDeps): express.Express {
  const app = express();

  // RAW body — the HMAC must cover the exact bytes GitHub sent. Do NOT add
  // express.json() before this; re-serialization breaks the signature.
  app.post('/hook', express.raw({ type: '*/*', limit: '2mb' }), (req, res) => {
    const raw: Buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    const sig = req.header('X-Hub-Signature-256');

    if (!verifySignature(raw, sig, deps.secret)) {
      logger.warn('deploy webhook: invalid signature');
      return res.status(401).send('invalid signature');
    }

    let payload: unknown;
    try {
      payload = JSON.parse(raw.toString('utf8'));
    } catch {
      logger.warn('deploy webhook: unparseable JSON body');
      return res.status(400).send('bad json');
    }

    const decision = shouldDeploy(payload);
    if (!decision.deploy || !decision.sha) {
      logger.info({ reason: decision.reason }, 'deploy webhook: ignored event');
      return res.status(204).end();
    }

    logger.info({ sha: decision.sha }, 'deploy webhook: accepted; enqueuing deploy');
    deps.queue.enqueue(decision.sha);
    return res.status(202).send('accepted');
  });

  return app;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && npx vitest run src/deploy/app.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Run the full deploy-module suite**

Run: `cd server && npx vitest run src/deploy/`
Expected: PASS (all deploy tests).

- [ ] **Step 6: Commit**

```bash
git add server/src/deploy/app.ts server/src/deploy/app.test.ts
git commit -m "feat(deploy): add listener Express app with signed /hook route

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 6: Listener entry point

**Files:**
- Create: `server/src/deploy/listener.ts`

No unit test — this is the thin composition root (config + queue + real deploy spawn + `listen`). It is exercised by the end-to-end verification in Task 10. Each injected piece is already tested.

- [ ] **Step 1: Write the entry point**

```typescript
// server/src/deploy/listener.ts
import { spawn } from 'child_process';
import path from 'path';
import { logger } from '../logger.js';
import { loadDeployConfig } from './config.js';
import { createDeployQueue } from './queue.js';
import { createListenerApp } from './app.js';

const config = loadDeployConfig(process.env);

/** Run scripts/deploy-local.sh <sha>, streaming output to the logger. */
function runDeployScript(sha: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const script = path.join(config.repoRoot, 'scripts', 'deploy-local.sh');
    logger.info({ sha, script }, 'starting deploy');
    const child = spawn('bash', [script, sha], {
      cwd: config.repoRoot,
      env: { ...process.env, DEPLOY_PUBLIC_URL: config.publicUrl },
    });
    child.stdout.on('data', (d) => logger.info({ sha }, `deploy: ${d.toString().trimEnd()}`));
    child.stderr.on('data', (d) => logger.warn({ sha }, `deploy: ${d.toString().trimEnd()}`));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        logger.info({ sha }, 'deploy succeeded');
        resolve();
      } else {
        reject(new Error(`deploy-local.sh exited ${code}`));
      }
    });
  });
}

const queue = createDeployQueue(runDeployScript);
const app = createListenerApp({ secret: config.secret, queue });

// Bind localhost only — the sole ingress is the CF tunnel -> NPM proxy host.
app.listen(config.port, '127.0.0.1', () => {
  logger.info({ port: config.port, repoRoot: config.repoRoot }, 'deploy-listener up on 127.0.0.1');
});
```

- [ ] **Step 2: Verify it builds**

Run: `cd server && npm run build`
Expected: PASS — `dist/deploy/listener.js` exists. Verify: `ls dist/deploy/listener.js`.

- [ ] **Step 3: Smoke-run locally (no real GitHub)**

Run:
```bash
cd server && DEPLOY_WEBHOOK_SECRET=local-smoke DEPLOY_REPO_ROOT=/tmp/nope node dist/deploy/listener.js &
sleep 1
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:9000/   # expect 404
curl -s -o /dev/null -w "%{http_code}\n" -X POST http://127.0.0.1:9000/hook -H 'Content-Type: application/json' -d '{}'  # expect 401 (no sig)
kill %1
```
Expected: `404` then `401`.

- [ ] **Step 4: Commit**

```bash
git add server/src/deploy/listener.ts
git commit -m "feat(deploy): add deploy-listener entry point

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 7: `deploy-local.sh` build-on-302 script

**Files:**
- Create: `scripts/deploy-local.sh`

This mirrors today's `deploy.sh` + `rebuild.sh` but runs entirely on CT 302 against a checked-out SHA. **No test run** here — CI is the deploy gate (per spec). Build happens before restart so a failed build never takes down the service.

- [ ] **Step 1: Write the script**

```bash
#!/bin/bash
# Build-on-302 deploy. Usage: deploy-local.sh <git-sha> [--no-restart]
# Invoked by the deploy-listener after CI passes on main. Checks out the exact
# validated SHA, builds server + client locally, backs up the DB, restarts the
# service, and verifies the live bundle matches what was built.
set -euo pipefail

SHA="${1:?usage: deploy-local.sh <git-sha> [--no-restart]}"
MODE="${2:-}"

DEPLOY_DIR="$(cd "$(dirname "$0")/.." && pwd)"
DATA_DIR="$DEPLOY_DIR/data"
BACKUP_DIR="/opt/price-tracker-backups"
PUBLIC_URL="${DEPLOY_PUBLIC_URL:-https://prices.schultzsolutions.tech}"

cd "$DEPLOY_DIR"

echo "=== Fetching origin ==="
git fetch --quiet origin

echo "=== Checking out $SHA ==="
git checkout --quiet --detach "$SHA"

echo "=== Building server ==="
( cd server && npm ci --no-audit --no-fund && npm run build )

echo "=== Building client (with client/.env VITE_* vars) ==="
( cd client && npm ci --no-audit --no-fund && npm run build )

# Safety net for the 'silent stale bundle' class of bug: capture the freshly
# built bundle name so we can confirm the live site actually serves it.
LOCAL_BUNDLE=$(ls "$DEPLOY_DIR/client/dist/assets/" | grep -E '^index-[A-Za-z0-9_-]+\.js$' | head -1)
if [ -z "$LOCAL_BUNDLE" ]; then
  echo "ERROR: no client bundle in client/dist/assets/ — vite build silently failed?" >&2
  exit 1
fi
echo "=== Built bundle: $LOCAL_BUNDLE ==="

if [ "$MODE" = "--no-restart" ]; then
  echo "=== --no-restart: skipping DB backup, restart, and live verify ==="
  echo "=== Dry run complete ==="
  exit 0
fi

# Back up the DB before restart (rotate, keep last 10).
if [ -f "$DATA_DIR/price-tracker.db" ]; then
  mkdir -p "$BACKUP_DIR"
  TIMESTAMP=$(date +%Y%m%d-%H%M%S)
  cp "$DATA_DIR/price-tracker.db" "$BACKUP_DIR/price-tracker-$TIMESTAMP.db"
  echo "=== Database backed up: price-tracker-$TIMESTAMP.db ==="
  ls -t "$BACKUP_DIR"/price-tracker-*.db 2>/dev/null | tail -n +11 | xargs -r rm
fi

echo "=== Restarting service ==="
systemctl restart price-tracker

echo "=== Verifying live bundle ==="
sleep 2
LIVE_BUNDLE=$(curl -s "$PUBLIC_URL/" | grep -oE 'assets/index-[A-Za-z0-9_-]+\.js' | head -1 | sed 's|assets/||')
if [ -z "$LIVE_BUNDLE" ]; then
  echo "ERROR: could not extract bundle from $PUBLIC_URL/ — production HTML unparseable" >&2
  exit 1
fi
if [ "$LIVE_BUNDLE" != "$LOCAL_BUNDLE" ]; then
  echo "ERROR: bundle mismatch — local=$LOCAL_BUNDLE live=$LIVE_BUNDLE" >&2
  echo "Live site is NOT serving the new build. Check rebuild logs and CDN cache." >&2
  exit 1
fi
echo "=== Bundle verified live: $LIVE_BUNDLE ==="
echo "=== Deploy complete: $SHA ==="
```

- [ ] **Step 2: Make executable and lint**

Run:
```bash
chmod +x scripts/deploy-local.sh
shellcheck scripts/deploy-local.sh || echo "(install shellcheck if missing; review warnings)"
bash -n scripts/deploy-local.sh && echo "syntax OK"
```
Expected: `syntax OK`; shellcheck clean (or only style-level notes).

- [ ] **Step 3: Commit**

```bash
git add scripts/deploy-local.sh
git commit -m "feat(deploy): add build-on-302 deploy-local.sh

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 8: systemd unit template

**Files:**
- Create: `scripts/price-tracker-deploy.service`

- [ ] **Step 1: Write the unit file**

```ini
# Checked-in template for the deploy-listener. Install on CT 302 to
# /etc/systemd/system/price-tracker-deploy.service (see docs/deployment.md).
[Unit]
Description=Price Tracker deploy-listener (GitHub webhook -> build-on-302)
After=network.target

[Service]
Type=simple
WorkingDirectory=/opt/price-tracker
EnvironmentFile=/opt/price-tracker-deploy/.env
ExecStart=/usr/bin/node /opt/price-tracker/server/dist/deploy/listener.js
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

- [ ] **Step 2: Commit**

```bash
git add scripts/price-tracker-deploy.service
git commit -m "chore(deploy): add deploy-listener systemd unit template

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 9: Document the flow

**Files:**
- Modify: `docs/deployment.md`

- [ ] **Step 1: Append a "Push-to-deploy (webhook)" section**

Add to `docs/deployment.md`:

```markdown
## Push-to-deploy (webhook)

Merging to `main` triggers CI. When CI passes, GitHub sends a `workflow_run`
webhook to the `deploy-listener` on CT 302, which rebuilds and restarts the app.

**Flow:** push → CI (GitHub-hosted) → `workflow_run` webhook → CF tunnel → NPM
(`pt-deploy.schultzsolutions.tech`) → `127.0.0.1:9000` listener → verify HMAC +
CI/success/main → `scripts/deploy-local.sh <sha>` (checkout SHA, build server +
client, back up DB, restart, verify live bundle).

**Break-glass (manual):** if the webhook chain is down, deploy from CT 300 with
`scripts/deploy.sh` exactly as before — it is unchanged.

**Listener logs:** `journalctl -u price-tracker-deploy -f` on CT 302.

**One-time setup:** see "CT 302 deploy-listener setup" below.
```

- [ ] **Step 2: Append the one-time setup runbook (the deploy-time steps from Task 10)**

Copy the runbook commands from Task 10 Step 1–6 into a `### CT 302 deploy-listener setup` subsection so the procedure is captured in-repo, not only in this plan.

- [ ] **Step 3: Commit**

```bash
git add docs/deployment.md
git commit -m "docs(deploy): document push-to-deploy webhook flow and setup

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 10: One-time CT 302 setup + end-to-end verification

These are **operational steps run against CT 302** (root@192.168.1.166), not code. Run them after Tasks 1–9 are merged to `main` so the listener code is present. Do them in order.

- [ ] **Step 1: Convert `/opt/price-tracker` to a clean clone tracking `origin/main`**

The current dir is a local-only git repo (no remote, branch `master`, ~200 dirty files). Replace it with a clean clone, preserving `data/` and the `.env` files (all gitignored, so not in any commit).

```bash
ssh root@192.168.1.166 'bash -s' <<'EOF'
set -euo pipefail
systemctl stop price-tracker || true
cd /opt
# Preserve runtime state.
cp -a price-tracker/data /opt/pt-data.bak
cp price-tracker/.env /opt/pt-server.env.bak
cp price-tracker/client/.env /opt/pt-client.env.bak 2>/dev/null || echo "(no client/.env yet)"
mv price-tracker price-tracker.old.$(date +%s)
git clone https://github.com/andrewschultzw/price-tracker.git price-tracker
cd price-tracker
# Restore runtime state.
rm -rf data && mv /opt/pt-data.bak data
cp /opt/pt-server.env.bak .env
echo "Repo cloned at $(git rev-parse --short HEAD); data + .env restored."
EOF
```
Expected: clone succeeds; prints a short SHA; `data` and `.env` restored.

- [ ] **Step 2: Create `client/.env` with the public VAPID key**

```bash
# Read the existing value from CT 300's checkout, then write it on CT 302.
VAPID=$(grep VITE_VAPID_PUBLIC_KEY /root/price-tracker/client/.env | cut -d= -f2-)
ssh root@192.168.1.166 "printf 'VITE_VAPID_PUBLIC_KEY=%s\n' '$VAPID' > /opt/price-tracker/client/.env && echo wrote client/.env"
```
Expected: `wrote client/.env`. (This key is public — shipped to every browser — so it is safe to place here.)

- [ ] **Step 3: Create the listener secret env (mode 600)**

```bash
ssh root@192.168.1.166 'bash -s' <<'EOF'
set -euo pipefail
mkdir -p /opt/price-tracker-deploy
SECRET=$(openssl rand -hex 32)
cat > /opt/price-tracker-deploy/.env <<ENV
DEPLOY_WEBHOOK_SECRET=$SECRET
DEPLOY_PORT=9000
DEPLOY_REPO_ROOT=/opt/price-tracker
DEPLOY_PUBLIC_URL=https://prices.schultzsolutions.tech
ENV
chmod 600 /opt/price-tracker-deploy/.env
echo "WEBHOOK SECRET (copy into the GitHub webhook config now):"
echo "$SECRET"
EOF
```
Expected: prints a 64-char hex secret. **Copy it** — needed in Step 7.

- [ ] **Step 4: Build the app + install/enable the listener service**

```bash
ssh root@192.168.1.166 'bash -s' <<'EOF'
set -euo pipefail
cd /opt/price-tracker
( cd server && npm ci --no-audit --no-fund && npm run build )
( cd client && npm ci --no-audit --no-fund && npm run build )
cp scripts/price-tracker-deploy.service /etc/systemd/system/price-tracker-deploy.service
systemctl daemon-reload
systemctl enable --now price-tracker
systemctl enable --now price-tracker-deploy
sleep 1
systemctl is-active price-tracker price-tracker-deploy
curl -s -o /dev/null -w "hook unauthenticated -> %{http_code}\n" -X POST http://127.0.0.1:9000/hook -H 'Content-Type: application/json' -d '{}'
EOF
```
Expected: both services `active`; the curl prints `hook unauthenticated -> 401`.

- [ ] **Step 2-alt note (git auth):** if the repo clone in Step 1 prompts for credentials, the private/public status of `price-tracker` (currently public) means anonymous HTTPS clone works. If it ever goes private, add a deploy key or token to CT 302 first.

- [ ] **Step 5: Add the NPM proxy host**

In NPM admin (per `reference_npm_api.md`): create a proxy host
`pt-deploy.schultzsolutions.tech` → forward to `127.0.0.1:9000` (HTTP), SSL via
the wildcard cert, websockets off. Verify externally:

```bash
curl -s -o /dev/null -w "%{http_code}\n" -X POST https://pt-deploy.schultzsolutions.tech/hook -d '{}'
```
Expected: `401` (reached the listener; rejected for missing signature).

- [ ] **Step 6: Register the GitHub webhook**

```bash
gh api -X POST repos/andrewschultzw/price-tracker/hooks \
  -f name=web \
  -F active=true \
  -f 'events[]=workflow_run' \
  -f config.url=https://pt-deploy.schultzsolutions.tech/hook \
  -f config.content_type=json \
  -f config.secret='<SECRET-FROM-STEP-3>'
```
Expected: HTTP 201 with the new hook's JSON. Confirm in GitHub → Settings → Webhooks that the latest delivery (the ping) shows a response (it will be `401`/`400` for the ping event — that's correct; the ping is not a `workflow_run`).

- [ ] **Step 7: POSITIVE end-to-end**

```bash
# Trivial no-op commit on main to trigger CI.
cd /root/price-tracker && git checkout main && git pull
git commit --allow-empty -m "chore: trigger deploy E2E"
git push
# Watch CI, then the listener.
gh run watch -R andrewschultzw/price-tracker
ssh root@192.168.1.166 'journalctl -u price-tracker-deploy -n 50 --no-pager'
```
Expected: after CI goes green, the listener log shows `accepted; enqueuing deploy` → `starting deploy` → bundle built → `Bundle verified live` → `deploy succeeded`. Confirm the live site loads: `curl -sI https://prices.schultzsolutions.tech/ | head -1` → `200`.

- [ ] **Step 8: NEGATIVE end-to-end**

```bash
# Push a commit that fails CI on a throwaway branch merged to main, OR
# temporarily break a test on main in a commit, push, and confirm NO deploy.
# Safer: open a PR with a failing test; observe that a failed CI run produces
# a workflow_run webhook with conclusion=failure and the listener logs
# "ignored event (conclusion is failure)" with NO deploy.
ssh root@192.168.1.166 'journalctl -u price-tracker-deploy -n 20 --no-pager | grep -i ignored'
```
Expected: listener logs an `ignored event` line referencing `conclusion is failure`; no `starting deploy` follows it.

- [ ] **Step 9: Final confirmation**

Confirm and report: both systemd services active, positive E2E deployed the new bundle live, negative E2E did not deploy. Capture the journald excerpts as evidence.

---

## Task 11: Deploy-failure ntfy notification (fast-follow)

Added after the final review: journald-only failure visibility was deemed
insufficient. On a failed/timed-out deploy, post a best-effort ntfy alert.
Self-contained (no app DB coupling); no-op if unconfigured; never throws.

**Files:**
- Modify: `server/src/deploy/config.ts` (+ `config.test.ts`) — add optional `DEPLOY_ALERT_NTFY_URL`.
- Create: `server/src/deploy/notify.ts` (+ `notify.test.ts`) — `notifyDeployFailure(ntfyUrl, sha, detail)`.
- Modify: `server/src/deploy/listener.ts` — wrap the queue's deploy fn to fire the alert on failure, then rethrow so the queue still logs.

See the implementation commits on the branch for the exact code; behavior:
ntfy JSON publish (UTF-8 safe, mirrors `notifications/ntfy.ts`), priority 5,
swallows its own errors to `logger.warn`.

## Self-Review

**Spec coverage:**
- Listener service (HMAC, allow-list, 202-then-async, systemd, journald) → Tasks 1–6, 8. ✓
- Raw-body footgun → Task 5 (`express.raw`, explicit comment + test path). ✓
- `deploy-local.sh` (checkout SHA, build server+client, DB backup, restart, bundle verify, `--no-restart`) → Task 7. ✓
- Repo conversion (one-time, real git clone, preserve data/.env) → Task 10 Step 1. ✓
- `deploy.sh` retained as break-glass → unchanged; documented Task 9. ✓
- Single-slot coalescing + failure handling → Task 4. ✓
- Security (HMAC primary, allow-list, localhost bind, secret in /opt/.../.env 600, public-VAPID note) → Tasks 2,3,5,10; spec WAF marked deferred (not in plan, by design). ✓
- Testing: unit (verify, queue, config), app (supertest), dry-run, positive + negative E2E → Tasks 1–7,10. ✓
- One-time setup checklist (repo, client/.env, deploy .env, service, NPM, GitHub webhook) → Task 10 Steps 1–6. ✓

**Placeholder scan:** Step 6/Step 7 of Task 10 carry an intentional `<SECRET-FROM-STEP-3>` substitution (a runtime value, not a plan placeholder). No "TBD"/"handle edge cases"/uncoded steps elsewhere.

**Type consistency:** `verifySignature`, `shouldDeploy`, `createDeployQueue`/`enqueue`/`isRunning`, `createListenerApp({secret, queue})`, and env var names (`DEPLOY_WEBHOOK_SECRET`/`DEPLOY_PORT`/`DEPLOY_REPO_ROOT`/`DEPLOY_PUBLIC_URL`) are used identically across Tasks 1–6, 8, 10. ✓
