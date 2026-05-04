// server/src/ai/backfill-cron.ts
import cron from 'node-cron';
import { getTrackersWithStaleSummary } from '../db/queries.js';
import { generateSummaryForTracker } from './generators.js';
import { config } from '../config.js';
import { logger } from '../logger.js';

const PER_SWEEP_LIMIT = 50;

export async function runBackfillSweep(): Promise<{ attempted: number }> {
  if (process.env.AI_ENABLED !== 'true') return { attempted: 0 };

  const stalenessMs = config.aiSummaryStalenessDays * 86_400_000;
  const candidates = getTrackersWithStaleSummary(stalenessMs, PER_SWEEP_LIMIT);
  logger.info({ count: candidates.length }, 'ai_backfill_sweep_start');

  for (const t of candidates) {
    await generateSummaryForTracker(t.id);
  }

  logger.info({ attempted: candidates.length }, 'ai_backfill_sweep_done');
  return { attempted: candidates.length };
}

let task: cron.ScheduledTask | null = null;

export function startBackfillCron(): void {
  if (task) return;
  // Nightly at 03:00.
  task = cron.schedule('0 3 * * *', () => {
    runBackfillSweep().catch(err => logger.error({ err: String(err) }, 'ai_backfill_sweep_unhandled'));
  });
}

export function stopBackfillCron(): void {
  task?.stop();
  task = null;
}
