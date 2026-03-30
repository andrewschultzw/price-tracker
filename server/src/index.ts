import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import rateLimit from 'express-rate-limit';
import { resolve } from 'path';
import { config } from './config.js';
import { initializeSchema } from './db/schema.js';
import { closeDb } from './db/connection.js';
import { authMiddleware, adminMiddleware } from './auth/middleware.js';
import authRoutes, { generateSetupToken } from './routes/auth.js';
import adminRoutes from './routes/admin.js';
import trackerRoutes from './routes/trackers.js';
import priceRoutes from './routes/prices.js';
import settingsRoutes from './routes/settings.js';
import { startScheduler, stopScheduler } from './scheduler/cron.js';
import { closeBrowser } from './scraper/browser.js';
import { getUserCount, deleteExpiredRefreshTokens } from './db/user-queries.js';
import { logger } from './logger.js';

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

// Protected API routes
app.use('/api/trackers', authMiddleware, trackerRoutes);
app.use('/api/trackers', authMiddleware, priceRoutes);
app.use('/api/settings', authMiddleware, settingsRoutes);
app.use('/api/admin', authMiddleware, adminMiddleware, adminRoutes);

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
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
});

// Periodic cleanup of expired refresh tokens (every hour)
const cleanupInterval = setInterval(() => {
  deleteExpiredRefreshTokens();
}, 60 * 60 * 1000);

// Graceful shutdown
function shutdown() {
  logger.info('Shutting down...');
  stopScheduler();
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
