import { describe, expect, it } from 'vitest';
import {
  isDigestDue,
  isDigestEmpty,
  localDayHour,
  renderDigestHtml,
  renderDigestText,
  type DigestData,
} from './build.js';

// 2026-07-26 is a Sunday. 13:00 UTC = 08:00 America/Chicago (CDT, UTC-5).
const SUNDAY_8AM_CT = Date.parse('2026-07-26T13:00:00Z');

function emptyData(): DigestData {
  return {
    drops: [],
    recordLows: [],
    attention: [],
    staleThresholds: [],
    unclaimedWins: [],
    footer: { active: 3, paused: 1, problem: 0, checksThisWeek: 42 },
  };
}

function fullData(): DigestData {
  return {
    drops: [{ tracker_id: 1, name: 'Widget', from: 100, to: 80, pct: 20 }],
    recordLows: [{ tracker_id: 2, name: 'Gadget', tier: 'low_all_time', price: 49.4 }],
    attention: [{ tracker_id: 3, name: 'Doohickey', status: 'blocked', detail: 'WAF block', daysSince: 4 }],
    staleThresholds: [{ tracker_id: 4, name: 'Gizmo', threshold: 10, kind: 'stale_low' }],
    unclaimedWins: [{ tracker_id: 5, name: 'Thingamajig', threshold: 50, bestPrice: 44, daysAgo: 12 }],
    footer: { active: 5, paused: 0, problem: 1, checksThisWeek: 99 },
  };
}

describe('localDayHour', () => {
  it('converts UTC to America/Chicago day+hour across the date line', () => {
    expect(localDayHour(SUNDAY_8AM_CT)).toEqual({ day: 0, hour: 8 });
    // 04:00 UTC Monday = 23:00 Sunday in Chicago
    expect(localDayHour(Date.parse('2026-07-27T04:00:00Z'))).toEqual({ day: 0, hour: 23 });
  });
});

describe('isDigestDue', () => {
  it('due at the default Sunday 8am slot with no prior send', () => {
    expect(isDigestDue({}, SUNDAY_8AM_CT)).toBe(true);
  });

  it('not due at other hours/days', () => {
    expect(isDigestDue({}, SUNDAY_8AM_CT + 3_600_000)).toBe(false); // 9am
    expect(isDigestDue({}, SUNDAY_8AM_CT + 86_400_000)).toBe(false); // Monday
  });

  it('honors custom day/hour settings', () => {
    const wed7pm = Date.parse('2026-07-29T00:00:00Z'); // Tue 19:00 CT... compute: 00:00 UTC Wed = 19:00 Tue CT
    expect(isDigestDue({ day: '2', hour: '19' }, wed7pm)).toBe(true);
  });

  it('a send within the last 6 days blocks re-sending (restart idempotency)', () => {
    const lastWeek = new Date(SUNDAY_8AM_CT - 7 * 86_400_000).toISOString();
    const thisMorning = new Date(SUNDAY_8AM_CT - 30 * 60_000).toISOString();
    expect(isDigestDue({ lastSentAt: lastWeek }, SUNDAY_8AM_CT)).toBe(true);
    expect(isDigestDue({ lastSentAt: thisMorning }, SUNDAY_8AM_CT)).toBe(false);
  });

  it('disabled wins over everything', () => {
    expect(isDigestDue({ enabled: 'false' }, SUNDAY_8AM_CT)).toBe(false);
  });

  it('garbage day/hour fall back to defaults instead of never matching', () => {
    expect(isDigestDue({ day: 'sunday', hour: 'morning' }, SUNDAY_8AM_CT)).toBe(true);
  });
});

describe('renderDigestText', () => {
  it('omits empty sections and always includes the footer', () => {
    const { title, body } = renderDigestText(emptyData(), 'https://x.test');
    expect(title).toContain('weekly digest');
    expect(body).not.toContain('Biggest drops');
    expect(body).toContain('3 active · 1 paused');
    expect(body).toContain('https://x.test');
  });

  it('renders every populated section with prices and percentages', () => {
    const { body } = renderDigestText(fullData(), 'https://x.test');
    expect(body).toContain('Widget: $100.00 → $80.00 (−20.0%)');
    expect(body).toContain('Gadget: $49.40 — ALL-TIME low');
    expect(body).toContain('Doohickey: blocked, 4d since last check — WAF block');
    expect(body).toContain('Gizmo: target $10.00 is below anything ever seen');
    expect(body).toContain('Thingamajig: saw $44.00 (target $50.00) 12d ago');
  });
});

describe('renderDigestHtml', () => {
  it('links trackers and escapes HTML in names', () => {
    const data = fullData();
    data.attention[0].detail = '<script>alert(1)</script>';
    const html = renderDigestHtml(data, 'https://x.test');
    expect(html).toContain('href="https://x.test/tracker/1"');
    expect(html).not.toContain('<script>alert');
    expect(html).toContain('&lt;script&gt;');
  });
});

describe('isDigestEmpty', () => {
  it('footer alone does not make a digest', () => {
    expect(isDigestEmpty(emptyData())).toBe(true);
    expect(isDigestEmpty(fullData())).toBe(false);
  });
});
