import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { notifyDeployFailure } from './notify.js';

describe('notifyDeployFailure', () => {
  beforeEach(() => { vi.restoreAllMocks(); });
  afterEach(() => { vi.restoreAllMocks(); });

  it('no-ops (no fetch) when url is undefined', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    await notifyDeployFailure(undefined, 'abc123', 'boom');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('posts ntfy JSON to the instance base with the parsed topic', async () => {
    const fetchSpy = vi.fn(async () => ({ ok: true, status: 200 }) as Response);
    vi.stubGlobal('fetch', fetchSpy);
    await notifyDeployFailure('https://ntfy.sh/pt-deploy', 'deadbeefcafe', 'exit 1');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchSpy.mock.calls[0];
    expect(url).toBe('https://ntfy.sh');
    expect(opts.method).toBe('POST');
    const body = JSON.parse(opts.body);
    expect(body.topic).toBe('pt-deploy');
    expect(body.message).toContain('deadbeefcafe'.slice(0, 12));
    expect(body.message).toContain('exit 1');
    expect(body.title).toMatch(/fail/i);
  });

  it('does not throw when fetch rejects', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network down'); }));
    await expect(notifyDeployFailure('https://ntfy.sh/t', 'abc', 'd')).resolves.toBeUndefined();
  });

  it('does not throw and does not fetch when the url has no topic', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    await expect(notifyDeployFailure('https://ntfy.sh/', 'abc', 'd')).resolves.toBeUndefined();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
