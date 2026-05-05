// server/src/ai/client.ts
import Anthropic from '@anthropic-ai/sdk';
import { AIGenerationError } from './types.js';
import type { AIGenerationCategory } from './types.js';
import { config } from '../config.js';
import { logger } from '../logger.js';

export interface ClaudePromptInput {
  system: Array<{ type: 'text'; text: string; cache_control?: { type: 'ephemeral' } }>;
  user: string;
  maxTokens: number;
  maxOutputChars: number;
  promptName: 'verdict' | 'summary' | 'alert';
}

export interface ClaudeResponse {
  text: string;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  latencyMs: number;
}

const BANNED_PHRASES = [
  /\bas an ai\b/i,
  /\bi cannot\b/i,
  /\bi'm sorry\b/i,
  /\bi am unable\b/i,
];

let clientInstance: Anthropic | null = null;
function getClient(): Anthropic {
  if (!clientInstance) {
    clientInstance = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }
  return clientInstance;
}

export function _resetClientForTesting(): void {
  clientInstance = null;
}

function categorize(err: unknown): AIGenerationCategory {
  if (err && typeof err === 'object' && 'status' in err) {
    const status = (err as { status?: number }).status;
    if (status === 429) return 'rate_limit';
    if (status === 408) return 'timeout';
  }
  if (err instanceof Error && /timeout|timed out/i.test(err.message)) return 'timeout';
  return 'api_error';
}

function validate(text: string, maxChars: number): string {
  const trimmed = text.trim();
  if (!trimmed) throw new AIGenerationError('validation_error', 'empty output');
  if (trimmed.length > maxChars) {
    throw new AIGenerationError(
      'validation_error',
      `oversized output (${trimmed.length} > ${maxChars})`,
    );
  }
  for (const re of BANNED_PHRASES) {
    if (re.test(trimmed)) {
      throw new AIGenerationError('validation_error', `banned phrase matched: ${re}`);
    }
  }
  return trimmed;
}

async function callOnce(input: ClaudePromptInput, shorten: boolean): Promise<ClaudeResponse> {
  const startMs = Date.now();
  const userText = shorten
    ? `${input.user}\n\nIMPORTANT: be shorter than your previous attempt — output must be under ${input.maxOutputChars} characters.`
    : input.user;

  const resp = await getClient().messages.create({
    model: config.aiModel,
    max_tokens: input.maxTokens,
    system: input.system,
    messages: [{ role: 'user', content: userText }],
  });

  const block = resp.content?.[0];
  const text = block && block.type === 'text' ? block.text : '';
  const usage = resp.usage as
    | { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number }
    | undefined;

  return {
    text: validate(text, input.maxOutputChars),
    inputTokens: usage?.input_tokens ?? 0,
    outputTokens: usage?.output_tokens ?? 0,
    cachedTokens: usage?.cache_read_input_tokens ?? 0,
    latencyMs: Date.now() - startMs,
  };
}

export async function callClaude(input: ClaudePromptInput): Promise<ClaudeResponse> {
  if (process.env.AI_ENABLED !== 'true') {
    throw new AIGenerationError('kill_switch', 'AI_ENABLED is false');
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new AIGenerationError('kill_switch', 'ANTHROPIC_API_KEY not set');
  }

  let firstErr: unknown = null;
  try {
    const result = await callOnce(input, false);
    logger.info(
      {
        prompt: input.promptName,
        model: config.aiModel,
        input_tokens: result.inputTokens,
        output_tokens: result.outputTokens,
        cached_tokens: result.cachedTokens,
        latency_ms: result.latencyMs,
        status: 'success',
      },
      'ai_call_ok',
    );
    return result;
  } catch (err) {
    firstErr = err;
    if (err instanceof AIGenerationError && err.category === 'validation_error') {
      // Oversized or invalid output: retry with "be shorter" nudge
      try {
        const result = await callOnce(input, true);
        logger.info(
          { prompt: input.promptName, status: 'success_after_retry' },
          'ai_call_retry_ok',
        );
        return result;
      } catch (err2) {
        if (err2 instanceof AIGenerationError) throw err2;
        throw new AIGenerationError(categorize(err2), 'retry failed', err2);
      }
    }
    // Transient API error: back off then retry once
    await new Promise(r => setTimeout(r, 500));
    try {
      const result = await callOnce(input, false);
      logger.info(
        { prompt: input.promptName, status: 'success_after_retry' },
        'ai_call_retry_ok',
      );
      return result;
    } catch (err2) {
      if (err2 instanceof AIGenerationError) throw err2;
      throw new AIGenerationError(categorize(err2 ?? firstErr), 'second attempt failed', err2);
    }
  }
}
