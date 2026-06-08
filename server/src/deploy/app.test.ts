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

  it('400 on a signed but unparseable body', async () => {
    const { app, enqueue } = appWithSpy();
    const body = 'not-json';
    const res = await request(app)
      .post('/hook')
      .set('X-Hub-Signature-256', sign(body))
      .set('Content-Type', 'application/json')
      .send(body);
    expect(res.status).toBe(400);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('404 on any other route', async () => {
    const { app } = appWithSpy();
    expect((await request(app).get('/')).status).toBe(404);
    expect((await request(app).post('/deploy')).status).toBe(404);
  });
});
