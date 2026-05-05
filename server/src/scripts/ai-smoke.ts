/**
 * AI Buyer's Assistant smoke test — local dev tool.
 *
 * Picks one tracker by id (CLI arg) and runs the verdict + summary
 * generators against it using the real Anthropic API. Prints the
 * resulting prose so the operator can eyeball it before flipping the
 * AI_ENABLED flag globally.
 *
 * Usage:
 *   AI_ENABLED=true ANTHROPIC_API_KEY=sk-... npm run ai-smoke -- <tracker_id>
 *
 * Gated on AI_ENABLED + ANTHROPIC_API_KEY in env. Designed to be re-run
 * on demand. NOT part of the test suite.
 */

import { generateVerdictForTracker, generateSummaryForTracker } from '../ai/generators.js';
import { getTrackerById } from '../db/queries.js';
import { initSettingsCrypto } from '../crypto/settings-crypto.js';
import { runMigrations } from '../db/migrations.js';

async function main() {
  const id = Number(process.argv[2]);
  if (!Number.isFinite(id)) {
    console.error('usage: npm run ai-smoke -- <tracker_id>');
    process.exit(1);
  }
  if (process.env.AI_ENABLED !== 'true') {
    console.error('AI_ENABLED must be "true"');
    process.exit(1);
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('ANTHROPIC_API_KEY must be set');
    process.exit(1);
  }

  const cryptoKey = process.env.SETTINGS_ENCRYPTION_KEY;
  if (cryptoKey) {
    initSettingsCrypto(cryptoKey);
  }
  runMigrations();

  console.log(`Tracker ${id}: generating verdict...`);
  await generateVerdictForTracker(id);

  console.log(`Tracker ${id}: generating summary...`);
  await generateSummaryForTracker(id);

  const t = getTrackerById(id);
  if (!t) {
    console.error(`Tracker ${id} not found`);
    process.exit(1);
  }

  console.log('--- result ---');
  console.log({
    tier: t.ai_verdict_tier,
    reasonKey: t.ai_verdict_reason_key,
    reason: t.ai_verdict_reason,
    summary: t.ai_summary,
    verdictUpdatedAt: t.ai_verdict_updated_at && new Date(t.ai_verdict_updated_at).toISOString(),
    summaryUpdatedAt: t.ai_summary_updated_at && new Date(t.ai_summary_updated_at).toISOString(),
    failureCount: t.ai_failure_count,
  });
}

main().catch(err => { console.error(err); process.exit(1); });
