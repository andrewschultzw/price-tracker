import { DollarSign, CheckCircle, AlertCircle } from 'lucide-react'
import { usePublicConfig } from '../lib/use-public-config'

/**
 * Read-only Settings card that surfaces the Amazon Associates wiring
 * state. Pulls from /api/public/config (cached, also drives the
 * disclosure footer). When configured, shows the tag string so the
 * user can confirm setup without SSHing into the host. When not
 * configured, shows the env-var name + a one-line hint.
 *
 * The card is intentionally read-only: the tag lives in the server
 * .env (single source of truth, no setting clutter) and changing it
 * is rare-enough that a Settings input would be overkill.
 */
export function AffiliateStatusCard() {
  const cfg = usePublicConfig()

  // Render a low-emphasis placeholder while the boolean is still
  // resolving — avoids a "Not configured" flash before the real
  // status arrives.
  if (cfg === null) {
    return (
      <div className="bg-surface border border-border rounded-xl p-4 sm:p-6 mt-4">
        <div className="flex items-center gap-2 mb-2">
          <DollarSign className="w-5 h-5 text-primary" />
          <h2 className="text-lg font-semibold">Amazon Associates</h2>
        </div>
        <p className="text-text-muted text-sm">Loading...</p>
      </div>
    )
  }

  return (
    <div className="bg-surface border border-border rounded-xl p-4 sm:p-6 mt-4">
      <div className="flex items-center gap-2 mb-2">
        <DollarSign className="w-5 h-5 text-primary" />
        <h2 className="text-lg font-semibold">Amazon Associates</h2>
      </div>

      {cfg.amazon_affiliate_enabled ? (
        <>
          <div className="flex items-center gap-2 mb-3">
            <CheckCircle className="w-4 h-4 text-success" />
            <span className="text-sm font-medium">Configured</span>
            <code className="text-xs bg-bg-subtle px-2 py-0.5 rounded border border-border font-mono">
              {cfg.amazon_affiliate_tag}
            </code>
          </div>
          <p className="text-text-muted text-sm">
            Every Amazon URL on your dashboard, on your public wishlist link, and in
            anonymous click-throughs is tagged with this Associates ID. The disclosure
            footer is shown site-wide.
          </p>
        </>
      ) : (
        <>
          <div className="flex items-center gap-2 mb-3">
            <AlertCircle className="w-4 h-4 text-warning" />
            <span className="text-sm font-medium">Not configured</span>
          </div>
          <p className="text-text-muted text-sm">
            Set <code className="text-xs bg-bg-subtle px-1 py-0.5 rounded border border-border font-mono">AMAZON_AFFILIATE_TAG</code> in
            the server's <code className="text-xs bg-bg-subtle px-1 py-0.5 rounded border border-border font-mono">.env</code> and restart
            the service to start earning commission on click-throughs.
          </p>
        </>
      )}
    </div>
  )
}
