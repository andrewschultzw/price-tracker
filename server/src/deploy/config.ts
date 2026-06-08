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
