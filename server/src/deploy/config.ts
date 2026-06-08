import { z, ZodError } from 'zod';

const schema = z.object({
  DEPLOY_WEBHOOK_SECRET: z.string().min(1, 'DEPLOY_WEBHOOK_SECRET is required'),
  DEPLOY_PORT: z.coerce.number().int().positive().default(9000),
  // Defaults to localhost. Set to 0.0.0.0 (or a LAN IP) only where a separate
  // reverse proxy on another host must reach the listener — the HMAC gate, not
  // the bind interface, is the security boundary.
  DEPLOY_BIND_HOST: z.string().min(1).default('127.0.0.1'),
  DEPLOY_REPO_ROOT: z.string().min(1).default('/opt/price-tracker'),
  DEPLOY_PUBLIC_URL: z.string().url().default('https://prices.schultzsolutions.tech'),
  DEPLOY_ALERT_NTFY_URL: z.string().url().optional(),
  DEPLOY_ALERT_NTFY_TOKEN: z.string().min(1).optional(),
});

export interface DeployConfig {
  secret: string;
  port: number;
  bindHost: string;
  repoRoot: string;
  publicUrl: string;
  alertNtfyUrl?: string;
  alertNtfyToken?: string;
}

export function loadDeployConfig(env: NodeJS.ProcessEnv | Record<string, string | undefined>): DeployConfig {
  try {
    const parsed = schema.parse(env);
    return {
      secret: parsed.DEPLOY_WEBHOOK_SECRET,
      port: parsed.DEPLOY_PORT,
      bindHost: parsed.DEPLOY_BIND_HOST,
      repoRoot: parsed.DEPLOY_REPO_ROOT,
      publicUrl: parsed.DEPLOY_PUBLIC_URL,
      alertNtfyUrl: parsed.DEPLOY_ALERT_NTFY_URL,
      alertNtfyToken: parsed.DEPLOY_ALERT_NTFY_TOKEN,
    };
  } catch (err) {
    if (err instanceof ZodError) {
      const detail = err.errors.map((e) => `${e.path.join('.') || '(root)'}: ${e.message}`).join('; ');
      throw new Error(`Invalid deploy config: ${detail}`);
    }
    throw err;
  }
}
