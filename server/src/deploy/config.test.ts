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
