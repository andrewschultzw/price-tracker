// server/src/ai/backfill-cron.ts
import cron from 'node-cron';
import { getTrackersWithStaleSummary, getTrackersWithStaleOrMissingVerdict } from '../db/queries.js';
import { generateSummaryForTracker, generateVerdictForTracker } from './generators.js';
import { expireStaleIntents } from '../db/purchase-intents.js';
import { config } from '../config.js';
import { logger } from '../logger.js';

const PER_SWEEP_LIMIT = 50;

export async function runSummaryBackfillSweep(): Promise<{ attempted: number }> {
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

export async function runVerdictBackfillSweep(): Promise<{ attempted: number }> {
  if (process.env.AI_ENABLED !== 'true') return { attempted: 0 };

  const stalenessMs = config.aiVerdictStalenessDays * 86_400_000;
  const candidates = getTrackersWithStaleOrMissingVerdict(stalenessMs, PER_SWEEP_LIMIT);
  logger.info({ count: candidates.length }, 'ai_verdict_backfill_sweep_start');

  for (const t of candidates) {
    await generateVerdictForTracker(t.id);
  }

  logger.info({ attempted: candidates.length }, 'ai_verdict_backfill_sweep_done');
  return { attempted: candidates.length };
}

/**
 * Combined nightly backfill orchestrator. Runs the verdict sweep first
 * (single Haiku call per tracker — cheaper and faster) so a fresh verdict
 * is in place before the heavier summary sweep runs. Returns the sum of
 * `attempted` across both sweeps.
 *
 * Each sweep applies PER_SWEEP_LIMIT independently — verdict and summary
 * each pull up to LIMIT trackers per nightly run.
 */
export async function runBackfillSweep(): Promise<{ attempted: number }> {
  const verdict = await runVerdictBackfillSweep();
  const summary = await runSummaryBackfillSweep();

  // Retire armed/approved purchase intents whose window elapsed.
  const expiredIntents = expireStaleIntents();
  if (expiredIntents > 0) logger.info({ expired: expiredIntents }, 'nightly_purchase_intent_expiry');

  return { attempted: verdict.attempted + summary.attempted };
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
