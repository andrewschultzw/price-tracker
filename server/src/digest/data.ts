/**
 * Weekly digest — data gathering (phase 3). One function per section, all
 * scoped to a single user, composed by gatherDigestData(). SQL lives here
 * rather than db/queries.ts because these aggregations serve only the
 * digest (same modularity precedent as db/purchase-intents.ts).
 */

import { getDb } from '../db/connection.js';
import { getDailyMinHistoryForTracker } from '../db/queries.js';
import { computePriceStats, thresholdStaleness } from '../stats/price-stats.js';
import type {
  DigestAttention,
  DigestData,
  DigestDrop,
  DigestRecordLow,
  DigestStaleThreshold,
  DigestUnclaimedWin,
} from './build.js';

const DAY_MS = 86_400_000;

interface TrackerRow {
  id: number;
  name: string;
  threshold_price: number | null;
  status: string;
  last_error: string | null;
  last_checked_at: string | null;
  consecutive_failures: number;
}

function userTrackers(userId: number): TrackerRow[] {
  return getDb().prepare(`
    SELECT id, name, threshold_price, status, last_error, last_checked_at, consecutive_failures
    FROM trackers WHERE user_id = ?
  `).all(userId) as TrackerRow[];
}

/** Top-5 percentage drops over the trailing week, daily-min basis. */
function weeklyDrops(trackers: TrackerRow[], nowMs: number): DigestDrop[] {
  const drops: DigestDrop[] = [];
  for (const t of trackers) {
    if (t.status !== 'active') continue;
    const week = getDailyMinHistoryForTracker(t.id).filter(
      d => nowMs - Date.parse(`${d.date}T00:00:00Z`) <= 8 * DAY_MS,
    );
    if (week.length < 2) continue;
    const from = week[0].price;
    const to = week[week.length - 1].price;
    if (from <= 0 || to >= from) continue;
    drops.push({ tracker_id: t.id, name: t.name, from, to, pct: ((from - to) / from) * 100 });
  }
  return drops.sort((a, b) => b.pct - a.pct).slice(0, 5);
}

/** Record-low alerts fired in the last 7 days, best tier per tracker. */
function weeklyRecordLows(userId: number): DigestRecordLow[] {
  const rows = getDb().prepare(`
    SELECT n.tracker_id, t.name, n.alert_type AS tier, MIN(n.price) AS price,
           MAX(CASE n.alert_type
             WHEN 'low_all_time' THEN 3 WHEN 'low_90d' THEN 2 ELSE 1 END) AS sev
    FROM notifications n
    INNER JOIN trackers t ON t.id = n.tracker_id
    WHERE t.user_id = ?
      AND n.alert_type LIKE 'low_%'
      AND n.sent_at >= datetime('now', '-7 days')
    GROUP BY n.tracker_id
    ORDER BY sev DESC, price ASC
  `).all(userId) as Array<{ tracker_id: number; name: string; tier: string; price: number; sev: number }>;
  const SEV_TIER: Record<number, string> = { 3: 'low_all_time', 2: 'low_90d', 1: 'low_30d' };
  return rows.map(r => ({
    tracker_id: r.tracker_id,
    name: r.name,
    tier: SEV_TIER[r.sev] ?? r.tier,
    price: r.price,
  }));
}

/** Errored/blocked trackers plus auto-paused ones (failure-count signature). */
function attentionList(trackers: TrackerRow[], nowMs: number): DigestAttention[] {
  const out: DigestAttention[] = [];
  for (const t of trackers) {
    let status: string | null = null;
    if (t.status === 'error' || t.status === 'blocked') status = t.status;
    else if (t.status === 'paused' && t.consecutive_failures >= 3) status = 'auto-paused';
    if (!status) continue;
    const checked = t.last_checked_at ? Date.parse(t.last_checked_at.replace(' ', 'T') + 'Z') : NaN;
    out.push({
      tracker_id: t.id,
      name: t.name,
      status,
      detail: (t.last_error ?? 'no error recorded').slice(0, 90),
      daysSince: Number.isFinite(checked) ? Math.floor((nowMs - checked) / DAY_MS) : null,
    });
  }
  return out;
}

/** Thresholds the phase-1 detector flags as unreachable or trivially loose. */
function staleThresholds(trackers: TrackerRow[], nowMs: number): DigestStaleThreshold[] {
  const out: DigestStaleThreshold[] = [];
  for (const t of trackers) {
    if (t.status !== 'active' || !t.threshold_price) continue;
    const stats = computePriceStats(getDailyMinHistoryForTracker(t.id), nowMs);
    const kind = thresholdStaleness(t.threshold_price, stats);
    if (kind) out.push({ tracker_id: t.id, name: t.name, threshold: t.threshold_price, kind });
    if (out.length >= 10) break;
  }
  return out;
}

/** Threshold alerts fired in the last 30d on still-active trackers with no purchase. */
function unclaimedWins(userId: number, nowMs: number): DigestUnclaimedWin[] {
  const rows = getDb().prepare(`
    SELECT t.id AS tracker_id, t.name, t.threshold_price AS threshold,
           MIN(n.price) AS bestPrice, MAX(n.sent_at) AS lastAt
    FROM notifications n
    INNER JOIN trackers t ON t.id = n.tracker_id
    WHERE t.user_id = ?
      AND t.status = 'active'
      AND t.threshold_price IS NOT NULL
      AND n.alert_type = 'threshold'
      AND n.sent_at >= datetime('now', '-30 days')
      AND NOT EXISTS (SELECT 1 FROM purchases p WHERE p.tracker_id = t.id)
    GROUP BY t.id
    ORDER BY (t.threshold_price - MIN(n.price)) DESC
    LIMIT 10
  `).all(userId) as Array<{ tracker_id: number; name: string; threshold: number; bestPrice: number; lastAt: string }>;
  return rows.map(r => ({
    tracker_id: r.tracker_id,
    name: r.name,
    threshold: r.threshold,
    bestPrice: r.bestPrice,
    daysAgo: Math.max(0, Math.floor((nowMs - Date.parse(r.lastAt.replace(' ', 'T') + 'Z')) / DAY_MS)),
  }));
}

function footerStats(userId: number, trackers: TrackerRow[]): DigestData['footer'] {
  const active = trackers.filter(t => t.status === 'active').length;
  const paused = trackers.filter(t => t.status === 'paused').length;
  const problem = trackers.filter(t => t.status === 'error' || t.status === 'blocked').length;
  const checks = getDb().prepare(`
    SELECT COUNT(*) AS c FROM price_history ph
    INNER JOIN trackers t ON t.id = ph.tracker_id
    WHERE t.user_id = ? AND ph.scraped_at >= datetime('now', '-7 days')
  `).get(userId) as { c: number };
  return { active, paused, problem, checksThisWeek: checks.c };
}

export function gatherDigestData(userId: number, nowMs: number): DigestData {
  const trackers = userTrackers(userId);
  return {
    drops: weeklyDrops(trackers, nowMs),
    recordLows: weeklyRecordLows(userId),
    attention: attentionList(trackers, nowMs),
    staleThresholds: staleThresholds(trackers, nowMs),
    unclaimedWins: unclaimedWins(userId, nowMs),
    footer: footerStats(userId, trackers),
  };
}
