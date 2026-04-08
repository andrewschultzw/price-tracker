import { Router, Request, Response } from 'express';
import { logger } from '../logger.js';

/**
 * Favicon proxy + in-memory cache.
 *
 * Before this route existed, every TrackerCard and CategoryCard fetched a
 * favicon directly from `www.google.com/s2/favicons`, which meant every
 * dashboard load leaked the full list of retailers the user tracks to
 * Google. For a privacy-leaning self-hosted app that's unacceptable.
 *
 * Now:
 *   1. The client requests `/api/favicon?domain=example.com` (same origin).
 *   2. On a cache miss, we fetch from DuckDuckGo's icons service — they
 *      don't build user profiles from these lookups the way Google does.
 *   3. We cache the bytes + content-type in memory and set Cache-Control
 *      so the browser also caches for a day. Restarts rebuild the cache
 *      organically on demand.
 *
 * Failures (unreachable upstream, unknown domain, non-2xx) are cached as
 * empty entries with a shorter TTL so we don't hammer the upstream on every
 * dashboard refresh for a broken domain.
 *
 * This route is intentionally public — favicons aren't secret, and serving
 * them without auth means `<img src=...>` tags don't need to send cookies.
 */

export const faviconRouter = Router();

interface CacheEntry {
  bytes: Buffer | null; // null = upstream failure, cached short
  contentType: string;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();
const HIT_TTL_MS = 24 * 60 * 60 * 1000;  // 24h for successful lookups
const MISS_TTL_MS = 10 * 60 * 1000;       // 10min for failures (don't hammer upstream)
const MAX_CACHE_ENTRIES = 500;            // soft LRU ceiling; evict oldest on overflow

// Strict hostname validation to prevent SSRF-style abuse: only allow
// lowercase letters, digits, dots, and hyphens, and require at least one
// dot. No paths, no protocols, no @, no userinfo, nothing that could let an
// attacker redirect our upstream fetch to an internal service.
const HOSTNAME_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;
// Reject bare IPv4 literals (the HOSTNAME_RE above matches all-digit labels
// so without this check, 127.0.0.1 and 10.0.0.1 would sneak through and
// become SSRF vectors against internal services).
const IPV4_RE = /^\d{1,3}(\.\d{1,3}){3}$/;

function isValidDomain(input: string): boolean {
  if (!input || input.length > 253) return false;
  if (IPV4_RE.test(input)) return false;
  return HOSTNAME_RE.test(input);
}

function evictIfNeeded(): void {
  if (cache.size <= MAX_CACHE_ENTRIES) return;
  // Map iteration is insertion-ordered, so the first key is the oldest.
  const oldest = cache.keys().next().value;
  if (oldest) cache.delete(oldest);
}

async function fetchUpstream(domain: string): Promise<CacheEntry> {
  const upstreamUrl = `https://icons.duckduckgo.com/ip3/${encodeURIComponent(domain)}.ico`;
  try {
    const response = await fetch(upstreamUrl, {
      // Short timeout so a slow upstream doesn't stall the dashboard.
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) {
      logger.debug({ domain, status: response.status }, 'Favicon upstream returned non-2xx');
      return { bytes: null, contentType: 'image/x-icon', expiresAt: Date.now() + MISS_TTL_MS };
    }
    const arrayBuffer = await response.arrayBuffer();
    const contentType = response.headers.get('content-type') || 'image/x-icon';
    return {
      bytes: Buffer.from(arrayBuffer),
      contentType,
      expiresAt: Date.now() + HIT_TTL_MS,
    };
  } catch (err) {
    logger.debug({ err, domain }, 'Favicon upstream fetch failed');
    return { bytes: null, contentType: 'image/x-icon', expiresAt: Date.now() + MISS_TTL_MS };
  }
}

faviconRouter.get('/', async (req: Request, res: Response) => {
  const rawDomain = String(req.query.domain || '').toLowerCase().trim();
  if (!isValidDomain(rawDomain)) {
    res.status(400).json({ error: 'Invalid domain' });
    return;
  }

  const existing = cache.get(rawDomain);
  const now = Date.now();
  let entry: CacheEntry;

  if (existing && existing.expiresAt > now) {
    entry = existing;
  } else {
    entry = await fetchUpstream(rawDomain);
    cache.set(rawDomain, entry);
    evictIfNeeded();
  }

  if (!entry.bytes) {
    // Upstream failure: return 404 so the <img onError> handler hides the
    // broken image. Short cache so a transient upstream issue heals on its
    // own without the user noticing.
    res.setHeader('Cache-Control', `public, max-age=${Math.floor(MISS_TTL_MS / 1000)}`);
    res.status(404).end();
    return;
  }

  res.setHeader('Content-Type', entry.contentType);
  res.setHeader('Cache-Control', `public, max-age=${Math.floor(HIT_TTL_MS / 1000)}, immutable`);
  res.status(200).end(entry.bytes);
});

// Exported for tests
export const _test = { isValidDomain };
