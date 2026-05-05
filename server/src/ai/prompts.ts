// server/src/ai/prompts.ts
import type { Signals, ReasonKey, VerdictTier, PriceObservation } from './types.js';
import type { ClaudePromptInput } from './client.js';

const TONE_BLOCK = `You are the deal-advisor inside a price-tracking app. Your tone is terse, factual, and helpful — like a knowledgeable friend texting a one-liner. Never use marketing language ("amazing deal!", "incredible savings!"). Never use exclamation points. Never reference yourself or the LLM nature of your output.`;

const HALLUCINATION_GUARD = `STRICT RULE: Every quantitative claim in your output (percentile rankings, day counts, dollar amounts, "X-month low" phrases) must correspond to a value present in the signals object you are given. Do not invent percentiles, time windows, or comparisons not provided. If a signal is null, do not reference it. Only use values present in the signals object.`;

const REASON_KEY_GLOSSARY = `reasonKey meanings:
- gathering_data: not enough history yet
- at_all_time_low: current price is at or within 2% of the all-time low
- in_bottom_decile: current price is in the lowest 10% of all observed prices
- below_threshold_at_window_low: price below user's threshold AND at the 30-day low
- fake_msrp_or_near_high: current is suspiciously close to all-time high (markup not deal)
- rising_trend: 30-day trend is rising and current is in the top 30%
- at_30d_low: current is at the 30-day window low (modest deal)
- no_notable_signal: nothing stands out`;

function ephemeralSystem(text: string): ClaudePromptInput['system'] {
  return [{ type: 'text', text, cache_control: { type: 'ephemeral' } }];
}

export function buildVerdictPrompt(
  signals: Signals,
  tier: VerdictTier,
  reasonKey: ReasonKey,
): ClaudePromptInput {
  const systemText = `${TONE_BLOCK}

You are composing a one-sentence reason for a BUY/WAIT/HOLD verdict pill on a tracker card. Length: max 150 characters. Output the sentence only — no quotes, no labels, no preamble.

${REASON_KEY_GLOSSARY}

${HALLUCINATION_GUARD}`;

  const userText = `${JSON.stringify({ tier, reasonKey, signals }, null, 2)}

Compose the reason sentence.`;

  return {
    system: ephemeralSystem(systemText),
    user: userText,
    maxTokens: 80,
    maxOutputChars: 150,
    promptName: 'verdict',
  };
}

export function buildSummaryPrompt(
  signals: Signals,
  recentObservations: PriceObservation[],
): ClaudePromptInput {
  const systemText = `${TONE_BLOCK}

You are composing a 2-4 sentence narrative summary of a product's price story for a tracker detail page. Cover (when relevant): price range, recency of low, dwell behavior at low, fake-MSRP vs. real-discount distinction, trend. Length: max 400 characters. Output the paragraph only — no headings, no labels.

${HALLUCINATION_GUARD}`;

  const obs = recentObservations.slice(-30).map(o => ({ p: o.price, t: o.recorded_at }));

  const userText = `${JSON.stringify({ signals, recent_observations: obs }, null, 2)}

Compose the summary.`;

  return {
    system: ephemeralSystem(systemText),
    user: userText,
    maxTokens: 220,
    maxOutputChars: 400,
    promptName: 'summary',
  };
}

export interface AlertCopyContext {
  trackerName: string;
  oldPrice: number;
  newPrice: number;
  signals: Signals;
  reasonKey: ReasonKey;
}

export function buildAlertCopyPrompt(ctx: AlertCopyContext): ClaudePromptInput {
  const systemText = `${TONE_BLOCK}

You are composing a one-sentence punchy line to append to a price-drop alert. Reference the most striking signal (e.g., "12-month low", "matches February's drop", "first time below $X"). Length: max 120 characters. Output the sentence only.

${REASON_KEY_GLOSSARY}

${HALLUCINATION_GUARD}`;

  const userText = `${JSON.stringify({
    tracker: ctx.trackerName,
    old_price: ctx.oldPrice,
    new_price: ctx.newPrice,
    reasonKey: ctx.reasonKey,
    signals: ctx.signals,
  }, null, 2)}

Compose the alert line.`;

  return {
    system: ephemeralSystem(systemText),
    user: userText,
    maxTokens: 60,
    maxOutputChars: 120,
    promptName: 'alert',
  };
}
