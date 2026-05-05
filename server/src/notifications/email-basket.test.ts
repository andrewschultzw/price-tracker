import { describe, it, expect, beforeEach, vi } from 'vitest';

const sentMessages: any[] = [];
vi.mock('nodemailer', () => ({
  default: { createTransport: vi.fn(() => ({
    sendMail: vi.fn(opts => { sentMessages.push(opts); return Promise.resolve({ messageId: 'test-id' }); }),
  })) },
}));
vi.mock('../config.js', () => ({
  config: { smtpHost: 'h', smtpPort: 465, smtpUser: 'u', smtpPass: 'p', smtpFrom: 'a@b.c' },
  isEmailConfigured: () => true,
}));
vi.mock('../logger.js', () => ({ logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() } }));

import { sendEmailBasketAlert } from './email.js';
import type { Project, BasketState, BasketMember } from '../projects/types.js';

function makeProject(): Project {
  return { id: 1, user_id: 1, name: 'NAS Build', target_total: 100,
    status: 'active', created_at: '2026-05-05', updated_at: '2026-05-05' };
}
function makeBasket(): BasketState {
  return { total: 80, target_total: 100, item_count: 2,
    items_with_price: 2, items_below_ceiling: 2, eligible: true, ineligible_reason: null };
}
function makeMembers(): BasketMember[] {
  return [
    { tracker_id: 1, tracker_name: 'SSD', last_price: 30, tracker_status: 'active',
      per_item_ceiling: null, position: 0, ai_verdict_tier: null, ai_verdict_reason: null },
    { tracker_id: 2, tracker_name: 'CPU', last_price: 50, tracker_status: 'active',
      per_item_ceiling: null, position: 1, ai_verdict_tier: null, ai_verdict_reason: null },
  ];
}

describe('sendEmailBasketAlert', () => {
  beforeEach(() => { sentMessages.length = 0; });

  it('sends email with subject + bodies containing totals + members', async () => {
    const ok = await sendEmailBasketAlert(makeProject(), makeBasket(), makeMembers(), 'user@example.com');
    expect(ok).toBe(true);
    expect(sentMessages[0].subject).toContain('NAS Build');
    expect(sentMessages[0].subject).toContain('80');
    expect(sentMessages[0].text).toContain('SSD');
    expect(sentMessages[0].html).toContain('SSD');
  });

  it('appends aiCommentary to both bodies when provided', async () => {
    await sendEmailBasketAlert(makeProject(), makeBasket(), makeMembers(), 'user@example.com', 'Worth pulling the trigger.');
    expect(sentMessages[0].text).toContain('Worth pulling the trigger.');
    expect(sentMessages[0].html).toContain('Worth pulling the trigger.');
  });

  it('omits aiCommentary when null', async () => {
    await sendEmailBasketAlert(makeProject(), makeBasket(), makeMembers(), 'user@example.com', null);
    expect(sentMessages[0].text).not.toContain('Worth pulling');
    expect(sentMessages[0].html).not.toContain('Worth pulling');
  });

  it('returns false when basket.total is null', async () => {
    const basket = { ...makeBasket(), total: null };
    const ok = await sendEmailBasketAlert(makeProject(), basket, makeMembers(), 'user@example.com');
    expect(ok).toBe(false);
    expect(sentMessages.length).toBe(0);
  });
});
