import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getBlockedRetailerHosts } from './url-guard.js';

/**
 * Drift detector between the extension's hand-mirror of blocked
 * retailer hosts and `server/src/scraper/blocked-retailers.ts`. If
 * the server adds Costco (or removes Best Buy because they unblock
 * us), this test fails until the extension is updated to match.
 *
 * Without this guard the popup would happily let a user add a tracker
 * for a host the server is about to mark `status='blocked'` anyway —
 * the user would see "Add tracker" → click → silently end up in the
 * blocked state with no popup-level explanation.
 *
 * Same approach as `extension/src/types/api.parity.test.ts`: read the
 * server source at test time, extract the host list with a regex, and
 * assert set-equality. The extension can't import server types
 * directly (separate TS workspaces).
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER_BLOCKED_RETAILERS_TS = resolve(
  __dirname,
  '../../../server/src/scraper/blocked-retailers.ts',
);

function extractServerHosts(source: string): string[] {
  // Match the `const BLOCKED_HOSTS: ReadonlySet<string> = new Set([ ... ])`
  // literal. Greedy-match until the closing `]` so the captured body
  // contains every host literal in source order.
  const match = source.match(/BLOCKED_HOSTS[^=]*=\s*new Set\(\[([\s\S]*?)\]\)/);
  if (!match) {
    throw new Error("Couldn't locate BLOCKED_HOSTS in server/src/scraper/blocked-retailers.ts");
  }
  const body = match[1];
  // Each line: `  'host.example',` — pull the quoted string out.
  const hosts: string[] = [];
  for (const line of body.split('\n')) {
    const m = line.match(/^\s*'([^']+)'/);
    if (m) hosts.push(m[1]);
  }
  return hosts;
}

describe('blocked retailer hosts — extension/server parity', () => {
  const serverSource = readFileSync(SERVER_BLOCKED_RETAILERS_TS, 'utf8');
  const serverHosts = new Set(extractServerHosts(serverSource));
  const extensionHosts = new Set(getBlockedRetailerHosts());

  it('sanity: server source actually contained host entries', () => {
    // Guards against the regex silently capturing an empty body.
    expect(serverHosts.size).toBeGreaterThan(0);
  });

  it('extension list is a strict mirror of the server list', () => {
    const missingFromExtension = [...serverHosts].filter(h => !extensionHosts.has(h));
    const extraInExtension = [...extensionHosts].filter(h => !serverHosts.has(h));
    expect(
      missingFromExtension,
      `Extension missing host(s) the server already blocks: ${missingFromExtension.join(', ')}`,
    ).toEqual([]);
    expect(
      extraInExtension,
      `Extension blocks host(s) the server doesn't: ${extraInExtension.join(', ')}`,
    ).toEqual([]);
  });
});
