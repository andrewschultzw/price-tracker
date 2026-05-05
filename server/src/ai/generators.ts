// server/src/ai/generators.ts
import { computeSignals } from './signals.js';
import { signalsToVerdict } from './verdict.js';
import { buildVerdictPrompt, buildSummaryPrompt, buildAlertCopyPrompt } from './prompts.js';
import type { AlertCopyContext } from './prompts.js';
import { callClaude } from './client.js';
import type { ClaudeResponse, ClaudePromptInput } from './client.js';
import { AIGenerationError } from './types.js';
import {
  getTrackerById,
  getRecentSuccessfulPricesForTracker,
  updateTrackerAIVerdict,
  updateTrackerAISummary,
  incrementAIFailureCount,
} from '../db/queries.js';
import { logger } from '../logger.js';

let clientFn: (input: ClaudePromptInput) => Promise<ClaudeResponse> = callClaude;
export function _setClientForTesting(fn: (input: ClaudePromptInput) => Promise<ClaudeResponse>): void {
  clientFn = fn;
}

const HISTORY_WINDOW_DAYS = 365;

async function loadSignalsForTracker(trackerId: number) {
  const tracker = getTrackerById(trackerId);
  if (!tracker || tracker.last_price === null) return null;

  const cutoff = Date.now() - HISTORY_WINDOW_DAYS * 86_400_000;
  const observations = getRecentSuccessfulPricesForTracker(trackerId, cutoff);

  const signals = computeSignals(
    observations,
    tracker.last_price,
    tracker.threshold_price ?? null,
    Date.now(),
    null,
  );
  if (!signals) return null;

  return { tracker, signals, observations };
}

export async function generateVerdictForTracker(trackerId: number): Promise<void> {
  try {
    const ctx = await loadSignalsForTracker(trackerId);
    if (!ctx) return;

    const verdict = signalsToVerdict(ctx.signals);
    const prompt = buildVerdictPrompt(ctx.signals, verdict.tier, verdict.reasonKey);

    const resp = await clientFn(prompt);
    updateTrackerAIVerdict(trackerId, {
      tier: verdict.tier,
      reason: resp.text,
      reasonKey: verdict.reasonKey,
      signalsJson: JSON.stringify(ctx.signals),
    });
  } catch (err) {
    if (err instanceof AIGenerationError) {
      logger.warn({ tracker_id: trackerId, category: err.category, msg: err.message }, 'ai_verdict_failed');
      incrementAIFailureCount(trackerId);
      return;
    }
    logger.error({ tracker_id: trackerId, err: String(err) }, 'ai_verdict_unexpected');
    incrementAIFailureCount(trackerId);
  }
}

export async function generateSummaryForTracker(trackerId: number): Promise<void> {
  try {
    const ctx = await loadSignalsForTracker(trackerId);
    if (!ctx) return;

    const prompt = buildSummaryPrompt(ctx.signals, ctx.observations);
    const resp = await clientFn(prompt);
    updateTrackerAISummary(trackerId, resp.text);
  } catch (err) {
    if (err instanceof AIGenerationError) {
      logger.warn({ tracker_id: trackerId, category: err.category }, 'ai_summary_failed');
      return;
    }
    logger.error({ tracker_id: trackerId, err: String(err) }, 'ai_summary_unexpected');
  }
}

export async function generateAlertCopy(ctx: AlertCopyContext): Promise<string | null> {
  try {
    const prompt = buildAlertCopyPrompt(ctx);
    const resp = await clientFn(prompt);
    return resp.text.trim();
  } catch (err) {
    if (err instanceof AIGenerationError) {
      logger.info({ category: err.category, tracker: ctx.trackerName }, 'ai_alert_copy_skip');
      return null;
    }
    logger.error({ err: String(err) }, 'ai_alert_copy_unexpected');
    return null;
  }
}

// Helper used by cron.ts to compute signals + verdict for the alert path
// without re-querying. Returns null when sparse.
export async function computeSignalsAndVerdictForTracker(trackerId: number) {
  const ctx = await loadSignalsForTracker(trackerId);
  if (!ctx) return null;
  return { signals: ctx.signals, verdict: signalsToVerdict(ctx.signals) };
}
