import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Drift detector between `extension/src/types/api.ts` Tracker and
 * `server/src/db/queries.ts` Tracker.
 *
 * Why this exists: the extension hand-mirrors only the subset of fields
 * it actually displays in the popup (id, name, last_price, the AI
 * verdict pair, etc.). When the server adds a field, the extension keeps
 * compiling — no signal — and we miss potentially-useful data. When the
 * server RENAMES a field, the extension's hand-typed name diverges
 * silently and `assertTrackerShape` starts rejecting every response.
 *
 * Both modes show up here:
 *   1. Every extension Tracker field must exist on the server. Catches
 *      renames / typos / removed fields.
 *   2. Every server Tracker field must EITHER be on the extension OR
 *      explicitly enumerated in IGNORED_SERVER_FIELDS below. New server
 *      fields force a one-line decision (mirror it or ignore it).
 *
 * Implementation is a regex over the source files because the extension
 * and server are separate TS workspaces with separate tsconfigs — type-
 * level imports across them aren't available. This stays fast and
 * doesn't depend on the TypeScript compiler API.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const EXTENSION_API_TS = resolve(__dirname, './api.ts');
const SERVER_QUERIES_TS = resolve(__dirname, '../../../server/src/db/queries.ts');

/**
 * Server Tracker fields that the extension popup deliberately doesn't
 * surface. Adding a field here is the explicit "we know, we don't want
 * it in the popup right now" decision. If you remove an entry, the
 * parity test forces the extension's Tracker to mirror that field.
 */
const IGNORED_SERVER_FIELDS = new Set<string>([
  // Internal scheduler state — not useful for "add or check" popup flow.
  'jitter_minutes',
  'check_interval_minutes', // present in extension too, but listed here for clarity
  'css_selector',
  'last_checked_at',
  'last_error',
  'consecutive_failures',
  'status',
  'created_at',
  'updated_at',
  'user_id',
  // AI Buyer's Assistant — popup shows verdict_tier + verdict_reason,
  // the rest are derivatives the dashboard renders, not the popup.
  'ai_verdict_reason_key',
  'ai_verdict_updated_at',
  'ai_summary',
  'ai_summary_updated_at',
  'ai_signals_json',
  'ai_failure_count',
  // Doorbuster — daycare-mode escalation, scheduled / dashboard-only UX.
  'doorbuster_start_at',
  'doorbuster_end_at',
  'doorbuster_interval_minutes',
  // Wishlist — owner-only toggle, gift-flow UX is separate from the popup.
  'is_wishlisted',
  // Autonomous purchasing — arming is a web-UI-only owner action; the
  // popup is create/check-only and never surfaces the buy-on-trigger flow.
  'buy_armed',
  'buy_quantity',
]);

function extractTrackerFields(source: string): string[] {
  // Match the `export interface Tracker { ... }` block specifically
  // (avoid matching `TrackerWithSellerSummary extends Tracker { ... }`
  // or other look-alikes). Greedy-match until the closing brace at
  // column 0 — both interfaces end that way.
  const match = source.match(/^export interface Tracker \{([\s\S]+?)^\}/m);
  if (!match) {
    throw new Error('Could not locate `export interface Tracker { ... }` block');
  }
  const body = match[1];
  // Field lines look like `  fieldName: type;` or `  fieldName?: type;`.
  // Skip blank lines, comment lines, and method signatures (none used
  // in either Tracker today; this is defensive).
  const fields: string[] = [];
  for (const line of body.split('\n')) {
    const fieldMatch = line.match(/^\s+(\w+)\??:\s+/);
    if (fieldMatch) fields.push(fieldMatch[1]);
  }
  return fields;
}

describe('Tracker shape — extension/server parity', () => {
  const serverFields = new Set(
    extractTrackerFields(readFileSync(SERVER_QUERIES_TS, 'utf8')),
  );
  const extensionFields = new Set(
    extractTrackerFields(readFileSync(EXTENSION_API_TS, 'utf8')),
  );

  it('every extension Tracker field exists on the server Tracker', () => {
    const orphans = [...extensionFields].filter(f => !serverFields.has(f));
    expect(orphans, `Extension fields not on server: ${orphans.join(', ')}`).toEqual([]);
  });

  it('every server Tracker field is either mirrored or explicitly ignored', () => {
    const unaccounted = [...serverFields].filter(
      f => !extensionFields.has(f) && !IGNORED_SERVER_FIELDS.has(f),
    );
    expect(
      unaccounted,
      `New server Tracker fields need a decision (mirror in extension/src/types/api.ts ` +
        `OR add to IGNORED_SERVER_FIELDS in this test with a reason): ${unaccounted.join(', ')}`,
    ).toEqual([]);
  });

  it('IGNORED_SERVER_FIELDS only lists fields the server actually has', () => {
    // Catches stale entries — when the server removes a field, the
    // corresponding entry here becomes dead code and should be cleaned up.
    const stale = [...IGNORED_SERVER_FIELDS].filter(f => !serverFields.has(f));
    expect(
      stale,
      `IGNORED_SERVER_FIELDS contains fields no longer on the server: ${stale.join(', ')}`,
    ).toEqual([]);
  });
});
