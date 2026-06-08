import { z, ZodError } from 'zod';

const schema = z.object({
  DEPLOY_WEBHOOK_SECRET: z.string().min(1, 'DEPLOY_WEBHOOK_SECRET is required'),
  DEPLOY_PORT: z.coerce.number().int().positive().default(9000),
  DEPLOY_REPO_ROOT: z.string().min(1).default('/opt/price-tracker'),
  DEPLOY_PUBLIC_URL: z.string().url().default('https://prices.schultzsolutions.tech'),
  DEPLOY_ALERT_NTFY_URL: z.string().url().optional(),
});

export interface DeployConfig {
  secret: string;
  port: number;
  repoRoot: string;
  publicUrl: string;
  alertNtfyUrl?: string;
}

export function loadDeployConfig(env: NodeJS.ProcessEnv | Record<string, string | undefined>): DeployConfig {
  try {
    const parsed = schema.parse(env);
    return {
      secret: parsed.DEPLOY_WEBHOOK_SECRET,
      port: parsed.DEPLOY_PORT,
      repoRoot: parsed.DEPLOY_REPO_ROOT,
      publicUrl: parsed.DEPLOY_PUBLIC_URL,
      alertNtfyUrl: parsed.DEPLOY_ALERT_NTFY_URL,
    };
  } catch (err) {
    if (err instanceof ZodError) {
      const detail = err.errors.map((e) => `${e.path.join('.') || '(root)'}: ${e.message}`).join('; ');
      throw new Error(`Invalid deploy config: ${detail}`);
    }
    throw err;
  }
}
