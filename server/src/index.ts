import express from 'express';
import cors from 'cors';
import { resolve } from 'path';
import { config } from './config.js';
import { initializeSchema } from './db/schema.js';
import { closeDb } from './db/connection.js';
import trackerRoutes from './routes/trackers.js';
import priceRoutes from './routes/prices.js';
import settingsRoutes from './routes/settings.js';
import { startScheduler, stopScheduler } from './scheduler/cron.js';
import { closeBrowser } from './scraper/browser.js';
import { logger } from './logger.js';

// Initialize database
initializeSchema();
logger.info('Database initialized');

const app = express();

app.use(cors());
app.use(express.json());

// API routes
app.use('/api/trackers', trackerRoutes);
app.use('/api/trackers', priceRoutes);
app.use('/api/settings', settingsRoutes);

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

// Graceful shutdown
function shutdown() {
  logger.info('Shutting down...');
  stopScheduler();
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
