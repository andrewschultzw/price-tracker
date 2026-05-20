import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { usePublicConfig } from '../lib/use-public-config'
import { getPublicSavings } from '../api'
import type { SavingsSummary } from '../types'

/**
 * Public footer line showing cumulative savings + a link to the
 * `/savings` page. Pulls from the no-auth, no-PII
 * `/api/public/savings` endpoint, which is cached server-side for
 * 5 min, so this is safe to mount on every page. Hides cleanly when
 * there are no purchases logged yet (or the endpoint returns 0) so
 * the footer doesn't read as broken on a fresh install.
 */
function SavingsLine() {
  const [data, setData] = useState<SavingsSummary | null>(null)
  useEffect(() => {
    getPublicSavings()
      .then(setData)
      .catch(() => {
        /* swallow: a failed fetch should just hide the line, not break the
           footer. The line is decorative, not functional. */
      })
  }, [])

  if (!data || data.total_saved <= 0 || !data.since) return null

  const sinceLabel = new Date(data.since).toLocaleDateString('en-US', {
    month: 'short',
    year: 'numeric',
  })
  const formattedTotal = data.total_saved.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })
  return (
    <div className="text-xs text-text-muted mb-2">
      <Link to="/savings" className="hover:text-primary no-underline">
        Saved ${formattedTotal} since {sinceLabel} →
      </Link>
    </div>
  )
}

/**
 * Footer that satisfies Amazon Associates Operating Agreement section
 * 5: "You will state on your Site... a clear, clear and conspicuous
 * statement that you participate in the Associates Program." Renders
 * only when the server reports `amazon_affiliate_enabled: true` (i.e.
 * AMAZON_AFFILIATE_TAG is set). Hidden otherwise to keep the footer
 * uncluttered for self-hosters who haven't enabled the program.
 *
 * The wording mirrors Amazon's recommended canonical disclosure
 * verbatim — using their suggested string avoids the periodic
 * compliance-review headache of evaluating custom phrasings.
 *
 * Rendered on every authenticated app page and every public page
 * (PublicProduct, CommunityDeals, WishlistPublic) so any user-facing
 * surface that might contain an affiliate-tagged link also carries
 * the disclosure. Affiliate paragraph is a no-op when the boolean is
 * false; SavingsLine is independent so the cumulative-savings line
 * still appears on installs that haven't wired Amazon Associates.
 */
export default function AffiliateDisclosure() {
  const cfg = usePublicConfig()
  const showAffiliate = !!cfg?.amazon_affiliate_enabled
  return (
    <footer className="max-w-6xl mx-auto px-4 py-6 text-xs text-text-muted text-center">
      <SavingsLine />
      {showAffiliate && (
        <div>As an Amazon Associate, this site earns from qualifying purchases.</div>
      )}
    </footer>
  )
}
