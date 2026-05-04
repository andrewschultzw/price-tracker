import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import rateLimit from 'express-rate-limit';
import { resolve } from 'path';
import { config } from './config.js';
import { initializeSchema } from './db/schema.js';
import { closeDb } from './db/connection.js';
import { authMiddleware, adminMiddleware } from './auth/middleware.js';
import { apiKeyMiddleware } from './auth/apiKey.js';
import authRoutes, { generateSetupToken } from './routes/auth.js';
import adminRoutes from './routes/admin.js';
import trackerRoutes from './routes/trackers.js';
import priceRoutes from './routes/prices.js';
import settingsRoutes from './routes/settings.js';
import notificationRoutes from './routes/notifications.js';
import { faviconRouter } from './routes/favicon.js';
import { startScheduler, stopScheduler } from './scheduler/cron.js';
import { startBackfillCron, stopBackfillCron } from './ai/backfill-cron.js';
import { closeBrowser } from './scraper/browser.js';
import { getUserCount, deleteExpiredRefreshTokens } from './db/user-queries.js';
import { initSettingsCrypto } from './crypto/settings-crypto.js';
import { logger } from './logger.js';
import { verifyAccessToken } from './auth/tokens.js';
import { getDb } from './db/connection.js';

// Initialize crypto BEFORE the database so migration v3 (which encrypts
// existing webhook settings rows) can use it during initializeSchema().
initSettingsCrypto(process.env.SETTINGS_ENCRYPTION_KEY);
logger.info('Settings crypto initialized');

// Initialize database
initializeSchema();
logger.info('Database initialized');

// First-run setup check
const userCount = getUserCount();
if (userCount === 0) {
  const token = generateSetupToken();
  const baseUrl = config.isProduction
    ? 'https://prices.schultzsolutions.tech'
    : `http://localhost:${config.port}`;
  logger.info('==========================================================');
  logger.info('FIRST-RUN SETUP: No users found. Create your admin account:');
  logger.info(`${baseUrl}/setup?token=${token}`);
  logger.info('==========================================================');
}

const app = express();

// CORS - lock down in production
app.use(cors({
  origin: config.isProduction ? 'https://prices.schultzsolutions.tech' : true,
  credentials: true,
}));
app.use(express.json());
app.use(cookieParser());

// Rate limiting on auth endpoints
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  message: { error: 'Too many attempts, please try again later' },
  standardHeaders: true,
  legacyHeaders: false,
});
app.use('/api/auth/login', authLimiter);
app.use('/api/auth/register', authLimiter);

// Auth routes (public - middleware applied per-route inside)
app.use('/api/auth', authRoutes);

// Public favicon proxy (intentionally no auth — favicons aren't sensitive
// and unauthenticated <img> tags are simpler than cookie-gated assets).
app.use('/api/favicon', faviconRouter);

// Protected API routes
app.use('/api/trackers', apiKeyMiddleware, authMiddleware, trackerRoutes);
app.use('/api/trackers', apiKeyMiddleware, authMiddleware, priceRoutes);
app.use('/api/settings', apiKeyMiddleware, authMiddleware, settingsRoutes);
app.use('/api/notifications', apiKeyMiddleware, authMiddleware, notificationRoutes);
app.use('/api/admin', apiKeyMiddleware, authMiddleware, adminMiddleware, adminRoutes);

// Helper: count cumulative AI failures across all trackers
function countAIFailures(): number {
  const result = getDb().prepare(`
    SELECT COALESCE(SUM(ai_failure_count), 0) AS n FROM trackers
  `).get() as { n: number };
  return result.n ?? 0;
}

// Helper: soft-auth — try to decode JWT if present, return null if invalid/expired
function tryDecodeAuth(req: express.Request) {
  const auth = req.headers.authorization;
  if (!auth?.startsWith('Bearer ')) return null;
  try {
    return verifyAccessToken(auth.slice('Bearer '.length));
  } catch {
    return null;
  }
}

app.get('/api/health', (req, res) => {
  const baseFields = { status: 'ok', timestamp: new Date().toISOString() };

  const user = tryDecodeAuth(req);
  if (user?.role !== 'admin') {
    return res.json(baseFields);
  }

  // Admin observability fields
  const aiFields = {
    ai_enabled: process.env.AI_ENABLED === 'true',
    ai_verdict_failures_24h: countAIFailures(),
    // TODO(debt): The four metrics below need accumulators we don't track yet.
    // Landing as 0 placeholders; wire real values in a follow-up once
    // volume justifies an in-memory counter or an ai_metrics table.
    ai_summary_failures_24h: 0,
    ai_alert_copy_timeouts_24h: 0,
    ai_avg_latency_ms_24h: 0,
    ai_cache_hit_rate_24h: 0,
  };
  res.json({ ...baseFields, ...aiFields });
});

// Serve frontend in production
const clientDist = resolve(import.meta.dirname, '../../client/dist');
app.use(express.static(clientDist));
app.get('*', (_req, res) => {
  res.sendFile(resolve(clientDist, 'index.html'));
});

const server = app.listen(config.port, () => {
  logger.info(`Price Tracker running on port ${config.port}`);
  startScheduler();
  startBackfillCron();
});

// Periodic cleanup of expired refresh tokens (every hour)
const cleanupInterval = setInterval(() => {
  deleteExpiredRefreshTokens();
}, 60 * 60 * 1000);

// Graceful shutdown
function shutdown() {
  logger.info('Shutting down...');
  stopScheduler();
  stopBackfillCron();
  clearInterval(cleanupInterval);
  server.close(() => {
    closeBrowser().then(() => {
      closeDb();
      logger.info('Shutdown complete');
      process.exit(0);
    });
  });
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
