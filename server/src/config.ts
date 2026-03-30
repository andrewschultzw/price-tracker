import { resolve } from 'path';

export const config = {
  port: parseInt(process.env.PORT || '3100', 10),
  databasePath: resolve(process.env.DATABASE_PATH || './data/price-tracker.db'),
  discordWebhookUrl: process.env.DISCORD_WEBHOOK_URL || '',
  nodeEnv: process.env.NODE_ENV || 'development',
  defaultCheckInterval: 360, // minutes
  notificationCooldownHours: 6,
  maxConsecutiveFailures: 3,
  maxConcurrentScrapes: 2,
  // Auth
  jwtSecret: process.env.JWT_SECRET || (process.env.NODE_ENV === 'production' ? '' : 'dev-secret-do-not-use-in-prod'),
  jwtAccessExpirySeconds: 900,       // 15 minutes
  jwtRefreshExpiryDays: 30,
  bcryptRounds: 12,
  isProduction: process.env.NODE_ENV === 'production',
};

if (config.isProduction && !process.env.JWT_SECRET) {
  console.error('FATAL: JWT_SECRET environment variable is required in production');
  process.exit(1);
}
