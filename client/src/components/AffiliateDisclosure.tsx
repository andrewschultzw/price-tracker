import { usePublicConfig } from '../lib/use-public-config'

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
 * the disclosure. Component is a no-op when the boolean is false,
 * so it's safe to drop in unconditionally.
 */
export default function AffiliateDisclosure() {
  const cfg = usePublicConfig()
  if (!cfg?.amazon_affiliate_enabled) return null
  return (
    <footer className="max-w-6xl mx-auto px-4 py-6 text-xs text-text-muted text-center">
      As an Amazon Associate, this site earns from qualifying purchases.
    </footer>
  )
}
