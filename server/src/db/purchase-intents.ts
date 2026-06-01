import { randomBytes } from 'crypto';
import { getDb } from './connection.js';
import { createPurchase, type Purchase } from './queries.js';
import { logger } from '../logger.js';

export type IntentStatus =
  | 'armed' | 'approved' | 'purchased' | 'not_completed' | 'expired' | 'canceled';

export interface PurchaseIntent {
  id: number;
  tracker_id: number;
  tracker_url_id: number | null;
  asin: string;
  price_at_arm: number;
  threshold_at_arm: number;
  quantity: number;
  token: string;
  status: IntentStatus;
  purchase_id: number | null;
  created_at: string;
  approved_at: string | null;
  resolved_at: string | null;
  expires_at: string;
}

export interface CreateIntentInput {
  tracker_id: number;
  tracker_url_id: number | null;
  asin: string;
  price_at_arm: number;
  threshold_at_arm: number;
  quantity: number;
  expires_at: string;
}

const byId = (id: number): PurchaseIntent =>
  getDb().prepare('SELECT * FROM purchase_intents WHERE id = ?').get(id) as PurchaseIntent;

export function createIntent(input: CreateIntentInput): PurchaseIntent {
  const token = randomBytes(24).toString('base64url');
  const row = getDb().prepare(
    `INSERT INTO purchase_intents
       (tracker_id, tracker_url_id, asin, price_at_arm, threshold_at_arm, quantity, token, status, expires_at)
     VALUES (@tracker_id, @tracker_url_id, @asin, @price_at_arm, @threshold_at_arm, @quantity, @token, 'armed', @expires_at)
     RETURNING *`,
  ).get({ ...input, token }) as PurchaseIntent;
  logger.info({ intent_id: row.id, tracker_id: input.tracker_id, asin: input.asin }, 'purchase_intent_created');
  return row;
}

export function getIntentByToken(token: string): PurchaseIntent | undefined {
  return getDb().prepare('SELECT * FROM purchase_intents WHERE token = ?').get(token) as PurchaseIntent | undefined;
}

/** The single live intent for a tracker, if any. Enforces one-open-per-tracker at the read layer. */
export function getOpenIntentForTracker(trackerId: number): PurchaseIntent | undefined {
  return getDb().prepare(
    `SELECT * FROM purchase_intents
      WHERE tracker_id = ? AND status IN ('armed','approved')
      ORDER BY id DESC LIMIT 1`,
  ).get(trackerId) as PurchaseIntent | undefined;
}

/** Most recent intent that reached a re-arm-cooling terminal state. */
export function getMostRecentTerminalIntent(trackerId: number): PurchaseIntent | undefined {
  return getDb().prepare(
    `SELECT * FROM purchase_intents
      WHERE tracker_id = ? AND status IN ('expired','not_completed')
      ORDER BY id DESC LIMIT 1`,
  ).get(trackerId) as PurchaseIntent | undefined;
}

/** armed -> approved. Idempotent for an already-approved intent (returns it
 *  unchanged). Throws for terminal/invalid states so a caller can't 'approve'
 *  an expired/purchased/canceled intent. */
export function approveIntent(id: number): PurchaseIntent {
  const current = byId(id);
  if (!current) throw new Error(`approveIntent: intent ${id} not found`);
  if (current.status === 'approved') return current; // idempotent no-op
  if (current.status !== 'armed') {
    throw new Error(`approveIntent: intent ${id} is in '${current.status}', cannot approve`);
  }
  getDb().prepare(
    `UPDATE purchase_intents SET status = 'approved', approved_at = datetime('now')
      WHERE id = ? AND status = 'armed'`,
  ).run(id);
  return byId(id);
}

/** approved -> purchased. Logs a real purchase, links it, disarms the tracker. */
export function resolveIntentPurchased(id: number): { intent: PurchaseIntent; purchase: Purchase } {
  const db = getDb();
  const result = db.transaction(() => {
    // Atomic state gate FIRST: flip approved -> purchased. If 0 rows changed
    // the intent wasn't 'approved' (already resolved, expired, etc.) — abort
    // before any money-real work so a double-invocation can't log two buys.
    const gate = db.prepare(
      `UPDATE purchase_intents SET status = 'purchased', resolved_at = datetime('now')
        WHERE id = ? AND status = 'approved'`,
    ).run(id);
    if (gate.changes === 0) {
      throw new Error(`resolveIntentPurchased: intent ${id} is not in 'approved' state`);
    }
    const intent = byId(id);
    const purchase = createPurchase(
      intent.tracker_id,
      { purchase_price: intent.price_at_arm, quantity: intent.quantity, tracker_url_id: intent.tracker_url_id },
      { keep_watching: false }, // sets tracker.status = 'purchased' (scheduler excludes it)
    );
    db.prepare(`UPDATE trackers SET buy_armed = 0 WHERE id = ?`).run(intent.tracker_id);
    db.prepare(`UPDATE purchase_intents SET purchase_id = ? WHERE id = ?`).run(purchase.id, id);
    return { intent: byId(id), purchase };
  })();
  logger.info({ intent_id: id, purchase_id: result.purchase.id }, 'purchase_intent_resolved_purchased');
  return result;
}

/** approved -> not_completed. Tracker stays active + armed; re-arm cooldown begins. */
export function resolveIntentNotCompleted(id: number): PurchaseIntent {
  // Gate strictly on 'approved' to match resolveIntentPurchased and the
  // documented state machine (not_completed is only reachable from approved;
  // the armed disarm path is 'canceled'). The route already enforces this —
  // this is the last line of defense.
  const res = getDb().prepare(
    `UPDATE purchase_intents SET status = 'not_completed', resolved_at = datetime('now')
      WHERE id = ? AND status = 'approved'`,
  ).run(id);
  if (res.changes === 0) {
    throw new Error(`resolveIntentNotCompleted: intent ${id} is not in 'approved' state`);
  }
  logger.info({ intent_id: id }, 'purchase_intent_resolved_not_completed');
  return byId(id);
}

/** Cancel any open (armed/approved) intent for a tracker — e.g. when the owner
 *  disarms it. Returns the number of intents canceled. */
export function cancelOpenIntentsForTracker(trackerId: number): number {
  const res = getDb().prepare(
    `UPDATE purchase_intents SET status = 'canceled', resolved_at = datetime('now')
      WHERE tracker_id = ? AND status IN ('armed','approved')`,
  ).run(trackerId);
  if (res.changes > 0) logger.info({ tracker_id: trackerId, canceled: res.changes }, 'purchase_intents_canceled_on_disarm');
  return res.changes;
}

/** Sweep: armed/approved intents past expires_at -> expired. Returns count. */
export function expireStaleIntents(nowIso?: string): number {
  const now = nowIso ?? new Date().toISOString().replace('T', ' ').slice(0, 19);
  const res = getDb().prepare(
    `UPDATE purchase_intents
        SET status = 'expired', resolved_at = datetime('now')
      WHERE status IN ('armed','approved') AND expires_at <= ?`,
  ).run(now);
  if (res.changes > 0) logger.info({ count: res.changes }, 'purchase_intents_expired');
  return res.changes;
}
