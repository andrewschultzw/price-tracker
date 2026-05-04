import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AIGenerationError } from './types.js';

const createMock = vi.fn();
vi.mock('@anthropic-ai/sdk', () => {
  return {
    default: class MockAnthropic {
      messages = { create: createMock };
    },
    Anthropic: class MockAnthropic {
      messages = { create: createMock };
    },
  };
});

import { callClaude, _resetClientForTesting } from './client.js';

const STUB_PROMPT = {
  system: [{ type: 'text', text: 'system block', cache_control: { type: 'ephemeral' } }],
  user: 'user block',
  maxTokens: 100,
  maxOutputChars: 150,
  promptName: 'verdict' as const,
};

beforeEach(() => {
  _resetClientForTesting();
  createMock.mockReset();
  process.env.AI_ENABLED = 'true';
  process.env.ANTHROPIC_API_KEY = 'test-key';
});

describe('callClaude', () => {
  it('returns the trimmed text on success', async () => {
    createMock.mockResolvedValueOnce({
      content: [{ type: 'text', text: '  hello world  ' }],
      usage: { input_tokens: 100, output_tokens: 5, cache_read_input_tokens: 90 },
    });
    const out = await callClaude(STUB_PROMPT);
    expect(out.text).toBe('hello world');
    expect(out.cachedTokens).toBe(90);
  });

  it('throws kill_switch when AI_ENABLED=false', async () => {
    process.env.AI_ENABLED = 'false';
    await expect(callClaude(STUB_PROMPT)).rejects.toMatchObject({
      name: 'AIGenerationError', category: 'kill_switch',
    });
  });

  it('throws kill_switch when ANTHROPIC_API_KEY is empty', async () => {
    process.env.ANTHROPIC_API_KEY = '';
    await expect(callClaude(STUB_PROMPT)).rejects.toMatchObject({ category: 'kill_switch' });
  });

  it('rejects oversized output (over maxOutputChars)', async () => {
    createMock.mockResolvedValue({
      content: [{ type: 'text', text: 'x'.repeat(200) }],
      usage: { input_tokens: 100, output_tokens: 200 },
    });
    await expect(callClaude(STUB_PROMPT)).rejects.toMatchObject({ category: 'validation_error' });
    expect(createMock).toHaveBeenCalledTimes(2);
  });

  it('rejects empty output', async () => {
    createMock.mockResolvedValue({
      content: [{ type: 'text', text: '   ' }],
      usage: { input_tokens: 100, output_tokens: 5 },
    });
    await expect(callClaude(STUB_PROMPT)).rejects.toMatchObject({ category: 'validation_error' });
  });

  it('rejects banned phrases ("as an AI", "I cannot")', async () => {
    createMock.mockResolvedValue({
      content: [{ type: 'text', text: 'As an AI I cannot help' }],
      usage: { input_tokens: 100, output_tokens: 10 },
    });
    await expect(callClaude(STUB_PROMPT)).rejects.toMatchObject({ category: 'validation_error' });
  });

  it('retries once on transient error then succeeds', async () => {
    createMock
      .mockRejectedValueOnce(Object.assign(new Error('429 Rate limit'), { status: 429 }))
      .mockResolvedValueOnce({
        content: [{ type: 'text', text: 'recovered' }],
        usage: { input_tokens: 100, output_tokens: 5 },
      });
    const out = await callClaude(STUB_PROMPT);
    expect(out.text).toBe('recovered');
    expect(createMock).toHaveBeenCalledTimes(2);
  });

  it('throws rate_limit category after both attempts fail with 429', async () => {
    const err = Object.assign(new Error('429'), { status: 429 });
    createMock.mockRejectedValue(err);
    await expect(callClaude(STUB_PROMPT)).rejects.toMatchObject({ category: 'rate_limit' });
    expect(createMock).toHaveBeenCalledTimes(2);
  });

  it('throws api_error for non-rate-limit failures', async () => {
    createMock.mockRejectedValue(new Error('boom'));
    await expect(callClaude(STUB_PROMPT)).rejects.toMatchObject({ category: 'api_error' });
  });
});
