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
      return res.status(401).send('unauthorized');
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

  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    logger.warn({ err }, 'deploy webhook: unhandled error');
    if (!res.headersSent) res.status(500).send('internal error');
  });

  return app;
}
