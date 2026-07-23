/**
 * Weekly digest — pure core (deal-intelligence phase 3, spec
 * docs/superpowers/specs/2026-07-23-deal-intelligence-roadmap.md).
 *
 * Everything here is deterministic given its inputs: eligibility, section
 * assembly, and the text/HTML renderers. Data gathering lives in data.ts,
 * scheduling in cron.ts.
 */

export const DIGEST_TZ = 'America/Chicago';

export interface DigestSettings {
  enabled?: string; // 'true' (default) | 'false'
  channel?: string; // explicit channel name, else first-configured fallback
  day?: string; // 0-6, 0=Sunday (default 0)
  hour?: string; // 0-23 local (default 8)
  always?: string; // 'true' = send even when empty (default false)
  lastSentAt?: string; // ISO timestamp of the last successful send
}

export interface DigestDrop {
  tracker_id: number;
  name: string;
  from: number;
  to: number;
  pct: number; // positive percentage drop
}

export interface DigestRecordLow {
  tracker_id: number;
  name: string;
  tier: string; // low_30d | low_90d | low_all_time
  price: number;
}

export interface DigestAttention {
  tracker_id: number;
  name: string;
  status: string; // error | blocked | auto-paused
  detail: string; // last error text or block reason, trimmed
  daysSince: number | null; // days since last successful check
}

export interface DigestStaleThreshold {
  tracker_id: number;
  name: string;
  threshold: number;
  kind: 'stale_low' | 'stale_high';
}

export interface DigestUnclaimedWin {
  tracker_id: number;
  name: string;
  threshold: number;
  bestPrice: number;
  daysAgo: number;
}

export interface DigestRestock {
  tracker_id: number;
  name: string;
  price: number;
}

export interface DigestData {
  drops: DigestDrop[];
  recordLows: DigestRecordLow[];
  restocks: DigestRestock[];
  attention: DigestAttention[];
  staleThresholds: DigestStaleThreshold[];
  unclaimedWins: DigestUnclaimedWin[];
  footer: { active: number; paused: number; problem: number; checksThisWeek: number };
}

export function isDigestEmpty(d: DigestData): boolean {
  return (
    d.drops.length === 0 &&
    d.recordLows.length === 0 &&
    d.restocks.length === 0 &&
    d.attention.length === 0 &&
    d.staleThresholds.length === 0 &&
    d.unclaimedWins.length === 0
  );
}

/** Local (America/Chicago) day-of-week 0-6 (0=Sunday) and hour 0-23 for a UTC instant. */
export function localDayHour(nowMs: number, timeZone: string = DIGEST_TZ): { day: number; hour: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'short',
    hour: 'numeric',
    hour12: false,
  }).formatToParts(new Date(nowMs));
  const weekday = parts.find(p => p.type === 'weekday')?.value ?? 'Sun';
  const hourRaw = Number(parts.find(p => p.type === 'hour')?.value ?? '0');
  const dayMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return { day: dayMap[weekday] ?? 0, hour: hourRaw % 24 };
}

/**
 * Is this user's digest due right now? True when enabled, the local
 * day+hour match, and the last send is safely more than 6 days old (the
 * hourly cron plus this stamp makes sends idempotent across restarts —
 * a re-run inside the same hour sees a fresh stamp and skips).
 */
export function isDigestDue(s: DigestSettings, nowMs: number, timeZone: string = DIGEST_TZ): boolean {
  if ((s.enabled ?? 'true').toLowerCase() === 'false') return false;
  const day = intOr(s.day, 0, 0, 6);
  const hour = intOr(s.hour, 8, 0, 23);
  const local = localDayHour(nowMs, timeZone);
  if (local.day !== day || local.hour !== hour) return false;
  if (s.lastSentAt) {
    const last = Date.parse(s.lastSentAt);
    if (Number.isFinite(last) && nowMs - last < 6 * 86_400_000) return false;
  }
  return true;
}

function intOr(raw: string | undefined, fallback: number, min: number, max: number): number {
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  return Number.isInteger(n) && n >= min && n <= max ? n : fallback;
}

const TIER_SHORT: Record<string, string> = {
  low_30d: '30-day low',
  low_90d: '90-day low',
  low_all_time: 'ALL-TIME low',
};

const money = (v: number): string => `$${v.toFixed(2)}`;

/**
 * Plain-text/markdown-ish rendering for ntfy, Discord, and the generic
 * webhook. Sections with no rows are omitted entirely.
 */
export function renderDigestText(d: DigestData, publicUrl: string): { title: string; body: string } {
  const lines: string[] = [];

  if (d.drops.length > 0) {
    lines.push('📉 Biggest drops this week');
    for (const x of d.drops) {
      lines.push(`  • ${x.name}: ${money(x.from)} → ${money(x.to)} (−${x.pct.toFixed(1)}%)`);
    }
  }
  if (d.recordLows.length > 0) {
    lines.push('', '🏆 Record lows hit');
    for (const x of d.recordLows) {
      lines.push(`  • ${x.name}: ${money(x.price)} — ${TIER_SHORT[x.tier] ?? x.tier}`);
    }
  }
  if (d.restocks.length > 0) {
    lines.push('', '📦 Back in stock');
    for (const x of d.restocks) {
      lines.push(`  • ${x.name}: ${money(x.price)}`);
    }
  }
  if (d.attention.length > 0) {
    lines.push('', '⚠️ Needs attention');
    for (const x of d.attention) {
      const since = x.daysSince !== null ? `, ${x.daysSince}d since last check` : '';
      lines.push(`  • ${x.name}: ${x.status}${since} — ${x.detail}`);
    }
  }
  if (d.staleThresholds.length > 0) {
    lines.push('', '🎯 Targets worth revisiting');
    for (const x of d.staleThresholds) {
      lines.push(
        x.kind === 'stale_low'
          ? `  • ${x.name}: target ${money(x.threshold)} is below anything ever seen`
          : `  • ${x.name}: target ${money(x.threshold)} is at/above the typical price`,
      );
    }
  }
  if (d.unclaimedWins.length > 0) {
    lines.push('', '🛒 Hit your target, never bought');
    for (const x of d.unclaimedWins) {
      lines.push(`  • ${x.name}: saw ${money(x.bestPrice)} (target ${money(x.threshold)}) ${x.daysAgo}d ago`);
    }
  }

  lines.push(
    '',
    `${d.footer.active} active · ${d.footer.paused} paused · ${d.footer.problem} with problems · ${d.footer.checksThisWeek} checks this week`,
    publicUrl,
  );

  return { title: 'Price Tracker — weekly digest', body: lines.join('\n').trim() };
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Minimal HTML rendering for the email channel. */
export function renderDigestHtml(d: DigestData, publicUrl: string): string {
  const section = (title: string, rows: string[]): string =>
    rows.length === 0
      ? ''
      : `<h3 style="margin:16px 0 6px 0; font-size:15px;">${title}</h3><ul style="margin:0; padding-left:18px; color:#374151;">${rows
          .map(r => `<li style="margin:2px 0;">${r}</li>`)
          .join('')}</ul>`;

  const link = (id: number, name: string): string =>
    `<a href="${publicUrl}/tracker/${id}" style="color:#2563eb; text-decoration:none;">${esc(name)}</a>`;

  const html = [
    section('📉 Biggest drops this week', d.drops.map(x =>
      `${link(x.tracker_id, x.name)}: ${money(x.from)} → <strong>${money(x.to)}</strong> (−${x.pct.toFixed(1)}%)`)),
    section('🏆 Record lows hit', d.recordLows.map(x =>
      `${link(x.tracker_id, x.name)}: <strong>${money(x.price)}</strong> — ${TIER_SHORT[x.tier] ?? esc(x.tier)}`)),
    section('📦 Back in stock', d.restocks.map(x =>
      `${link(x.tracker_id, x.name)}: <strong>${money(x.price)}</strong>`)),
    section('⚠️ Needs attention', d.attention.map(x =>
      `${link(x.tracker_id, x.name)}: ${esc(x.status)}${x.daysSince !== null ? `, ${x.daysSince}d since last check` : ''} — ${esc(x.detail)}`)),
    section('🎯 Targets worth revisiting', d.staleThresholds.map(x =>
      x.kind === 'stale_low'
        ? `${link(x.tracker_id, x.name)}: target ${money(x.threshold)} is below anything ever seen`
        : `${link(x.tracker_id, x.name)}: target ${money(x.threshold)} is at/above the typical price`)),
    section('🛒 Hit your target, never bought', d.unclaimedWins.map(x =>
      `${link(x.tracker_id, x.name)}: saw <strong>${money(x.bestPrice)}</strong> (target ${money(x.threshold)}) ${x.daysAgo}d ago`)),
  ].join('');

  return `<!doctype html>
<html><body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif; color:#1a1a1a; max-width:560px; margin:0 auto; padding:24px;">
  <h2 style="margin:0 0 4px 0; font-size:18px;">Weekly digest</h2>
  ${html}
  <p style="margin-top:20px; color:#6b7280; font-size:13px;">${d.footer.active} active · ${d.footer.paused} paused · ${d.footer.problem} with problems · ${d.footer.checksThisWeek} checks this week</p>
  <a href="${publicUrl}" style="display:inline-block; margin-top:8px; color:#2563eb;">Open Price Tracker</a>
</body></html>`;
}
