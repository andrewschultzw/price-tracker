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
};
