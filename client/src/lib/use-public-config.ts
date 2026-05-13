import { useEffect, useState } from 'react'

/**
 * Read-only client-side mirror of /api/public/config — small booleans
 * that drive boot-time UI (compliance footer, public-page hints, etc.).
 *
 * Cached in module scope so the second-and-Nth React render across the
 * app doesn't hit the network. The endpoint itself has a 5-min HTTP
 * cache header, but the module cache avoids the request churn entirely
 * when many components on the same page query at once. A page reload
 * picks up new server config without any manual cache-busting.
 *
 * Returns null while still loading on first call so callers can render
 * a "treat as off" default until config arrives — disclosure UI
 * shouldn't briefly appear and then disappear.
 */
export interface PublicConfig {
  amazon_affiliate_enabled: boolean
  /**
   * The affiliate tag string when configured, null otherwise. Public
   * because it's appended to every Amazon URL we serve — exposing it
   * here doesn't leak anything that isn't already in the click path.
   * Surfaced in the Settings UI so the user can confirm their
   * Associates ID is wired without SSHing into the host.
   */
  amazon_affiliate_tag: string | null
}

let cached: PublicConfig | null = null
let inflight: Promise<PublicConfig> | null = null

/**
 * Reset the module-level cache. Tests should call this in `beforeEach`
 * (or via a shared setup hook) so a fetch from one test doesn't bleed
 * into the next. Not a public API — exported for tests only.
 */
export function _resetPublicConfigCacheForTests(): void {
  cached = null
  inflight = null
}

function fetchOnce(): Promise<PublicConfig> {
  if (cached) return Promise.resolve(cached)
  if (inflight) return inflight
  inflight = fetch('/api/public/config', { credentials: 'omit' })
    .then(async r => {
      if (!r.ok) throw new Error(`config fetch failed: ${r.status}`)
      return (await r.json()) as PublicConfig
    })
    .then(cfg => {
      cached = cfg
      return cfg
    })
    .catch(err => {
      // Network/parse failure leaves the cache empty so subsequent
      // mounts try again. The disclosure stays hidden in this state,
      // which is the safe default (no over-promised compliance UI).
      inflight = null
      throw err
    })
  return inflight
}

export function usePublicConfig(): PublicConfig | null {
  const [cfg, setCfg] = useState<PublicConfig | null>(cached)
  useEffect(() => {
    if (cfg !== null) return
    let alive = true
    fetchOnce()
      .then(v => { if (alive) setCfg(v) })
      .catch(() => { /* see fetchOnce's catch — stays null */ })
    return () => { alive = false }
  }, [cfg])
  return cfg
}
