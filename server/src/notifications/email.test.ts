import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock nodemailer BEFORE importing the module under test. The mock
// captures every sendMail call for assertion.
const sentMessages: any[] = [];
vi.mock('nodemailer', () => ({
  default: {
    createTransport: vi.fn(() => ({
      sendMail: vi.fn((opts) => {
        sentMessages.push(opts);
        return Promise.resolve({ messageId: 'test-id' });
      }),
    })),
  },
}));

// Swap config to a fully-populated SMTP block for these tests.
vi.mock('../config.js', () => ({
  config: {
    smtpHost: 'smtp.gmail.com',
    smtpPort: 465,
    smtpUser: 'homelab.schultz@gmail.com',
    smtpPass: 'app-pass',
    smtpFrom: 'Price Tracker <alerts@schultzsolutions.tech>',
  },
  isEmailConfigured: () => true,
}));

// Suppress logger output in tests.
vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  sendEmailPriceAlert,
  sendEmailErrorAlert,
  testEmail,
  resetEmailTransportForTesting,
} from './email.js';
import type { Tracker } from '../db/queries.js';

function makeTracker(overrides: Partial<Tracker> = {}): Tracker {
  return {
    id: 7,
    user_id: 1,
    name: 'WD Red Plus 10TB HDD',
    url: 'https://www.newegg.com/p/N82E16822234588',
    threshold_price: 200,
    check_interval_minutes: 360,
    css_selector: null,
    last_price: 189.99,
    last_checked_at: '2026-04-18 12:00:00',
    last_error: null,
    consecutive_failures: 0,
    status: 'active',
    created_at: '2026-04-01 00:00:00',
    updated_at: '2026-04-18 12:00:00',
    ...overrides,
  } as unknown as Tracker;
}

beforeEach(() => {
  sentMessages.length = 0;
  resetEmailTransportForTesting();
});

describe('sendEmailPriceAlert', () => {
  it('sends multipart HTML + text to the recipient', async () => {
    const ok = await sendEmailPriceAlert(makeTracker(), 189.99, 'me@example.com');
    expect(ok).toBe(true);
    expect(sentMessages).toHaveLength(1);
    const m = sentMessages[0];
    expect(m.to).toBe('me@example.com');
    expect(m.from).toBe('Price Tracker <alerts@schultzsolutions.tech>');
    expect(m.subject).toContain('Price drop');
    expect(m.subject).toContain('WD Red Plus 10TB HDD');
    expect(m.subject).toContain('189.99');
    expect(m.text).toContain('189.99');
    expect(m.text).toContain('Target: $200');
    expect(m.text).toContain('Savings: $10.01');
    expect(m.text).toContain('https://www.newegg.com/p/N82E16822234588');
    expect(m.html).toContain('189.99');
    expect(m.html).toContain('<a');
  });

  it('returns false on missing threshold (nothing to compare)', async () => {
    const ok = await sendEmailPriceAlert(makeTracker({ threshold_price: null as unknown as number }), 10, 'me@example.com');
    expect(ok).toBe(false);
    expect(sentMessages).toHaveLength(0);
  });
});

describe('sendEmailErrorAlert', () => {
  it('sends an error-themed message', async () => {
    const ok = await sendEmailErrorAlert(
      makeTracker({ consecutive_failures: 3 }),
      'Product is currently unavailable on Amazon',
      'me@example.com',
    );
    expect(ok).toBe(true);
    const m = sentMessages[0];
    expect(m.subject).toContain('Tracker error');
    expect(m.subject).toContain('WD Red Plus 10TB HDD');
    expect(m.text).toContain('Product is currently unavailable on Amazon');
    expect(m.text).toContain('3 consecutive');
    expect(m.html).toContain('Product is currently unavailable on Amazon');
  });
});

describe('testEmail', () => {
  it('returns {ok: true} on success', async () => {
    const r = await testEmail('me@example.com');
    expect(r.ok).toBe(true);
    expect(sentMessages).toHaveLength(1);
    expect(sentMessages[0].subject).toContain('Test');
  });

  it('returns {ok: false, error} on SMTP failure', async () => {
    // Re-mock createTransport to reject for this one test
    const nodemailer = await import('nodemailer');
    (nodemailer.default.createTransport as any).mockReturnValueOnce({
      sendMail: vi.fn(() => Promise.reject(new Error('EAUTH: bad credentials'))),
    });
    resetEmailTransportForTesting();
    const r = await testEmail('me@example.com');
    expect(r.ok).toBe(false);
    expect(r.error).toContain('EAUTH');
  });
});
