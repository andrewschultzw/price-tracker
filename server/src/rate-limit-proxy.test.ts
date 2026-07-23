import { describe, expect, it } from 'vitest';
import express from 'express';
import rateLimit from 'express-rate-limit';
import request from 'supertest';

/**
 * Regression lock for the trust-proxy fix (2026-07-24). The app runs behind
 * exactly one reverse proxy (NPM), which sets X-Forwarded-For. Without
 * `trust proxy = 1`, req.ip is the PROXY's address for every request —
 * express-rate-limit v7 threw ERR_ERL_UNEXPECTED_X_FORWARDED_FOR on every
 * limited request, and all external clients shared one login bucket
 * (one visitor's failed logins could lock everyone out; conversely a
 * brute-forcer rotating XFF... couldn't, but neither could the limiter see
 * real IPs). These tests replicate index.ts's exact limiter + trust-proxy
 * configuration and pin the per-client-IP keying behavior.
 */

function makeApp(trustProxy: boolean): express.Express {
  const app = express();
  if (trustProxy) app.set('trust proxy', 1); // must match index.ts
  const limiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 5,
    message: { error: 'Too many attempts, please try again later' },
    standardHeaders: true,
    legacyHeaders: false,
  });
  app.use('/login', limiter, (_req, res) => { res.status(401).json({ error: 'bad creds' }); });
  return app;
}

describe('auth rate limiting behind one proxy hop', () => {
  it('keys buckets on the X-Forwarded-For client, not the proxy', async () => {
    const app = makeApp(true);

    // Client A exhausts its bucket…
    for (let i = 0; i < 5; i++) {
      const res = await request(app).post('/login').set('X-Forwarded-For', '203.0.113.10');
      expect(res.status).toBe(401);
    }
    const blocked = await request(app).post('/login').set('X-Forwarded-For', '203.0.113.10');
    expect(blocked.status).toBe(429);

    // …while client B, through the same proxy, is unaffected.
    const other = await request(app).post('/login').set('X-Forwarded-For', '203.0.113.99');
    expect(other.status).toBe(401);
  });

  it('documents the pre-fix failure: without trust proxy, all XFF clients share one bucket', async () => {
    const app = makeApp(false);
    for (let i = 0; i < 5; i++) {
      await request(app).post('/login').set('X-Forwarded-For', `203.0.113.${i}`);
    }
    // A brand-new "client IP" is already rate-limited — proving the keying
    // collapsed onto the proxy address. This is the behavior the fix removes.
    const collapsed = await request(app).post('/login').set('X-Forwarded-For', '198.51.100.7');
    expect(collapsed.status).toBe(429);
  });
});
