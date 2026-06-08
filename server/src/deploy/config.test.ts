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

  it('parses the optional alert ntfy url when present', () => {
    const cfg = loadDeployConfig({ DEPLOY_WEBHOOK_SECRET: 's', DEPLOY_ALERT_NTFY_URL: 'https://ntfy.sh/pt-deploy' });
    expect(cfg.alertNtfyUrl).toBe('https://ntfy.sh/pt-deploy');
  });
  it('leaves alertNtfyUrl undefined when not set', () => {
    expect(loadDeployConfig({ DEPLOY_WEBHOOK_SECRET: 's' }).alertNtfyUrl).toBeUndefined();
  });

  it('throws when the secret is missing or empty', () => {
    expect(() => loadDeployConfig({})).toThrow();
    expect(() => loadDeployConfig({ DEPLOY_WEBHOOK_SECRET: '' })).toThrow();
  });

  it('throws a readable error naming the bad field', () => {
    expect(() => loadDeployConfig({})).toThrow(/Invalid deploy config.*DEPLOY_WEBHOOK_SECRET/);
  });
});
