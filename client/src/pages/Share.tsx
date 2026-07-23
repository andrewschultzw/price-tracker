import { useEffect, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { Share2 } from 'lucide-react'
import { matchTrackerByUrl } from '../api'
import { cleanSharedTitle, extractSharedUrl } from '../lib/share-url'

/**
 * Web Share Target landing page (deal-intelligence phase 2). Android's share
 * sheet GETs /share?title=&text=&url=; this page never renders for more than
 * a moment:
 *   - already tracked  -> tracker detail (with an "already tracking" note)
 *   - new product      -> /add prefilled with url + cleaned title
 *   - no link in share -> a friendly dead-end with a manual-add link
 */
export default function Share() {
  const [params] = useSearchParams()
  const navigate = useNavigate()
  const [noLink, setNoLink] = useState(false)

  useEffect(() => {
    const sharedUrl = extractSharedUrl({
      url: params.get('url'),
      text: params.get('text'),
      title: params.get('title'),
    })
    if (!sharedUrl) {
      setNoLink(true)
      return
    }
    let cancelled = false
    ;(async () => {
      let existingId: number | null = null
      try {
        existingId = (await matchTrackerByUrl(sharedUrl)).tracker_id
      } catch {
        // Dedup is best-effort — on failure fall through to the add form,
        // where the server-side duplicate handling still applies.
      }
      if (cancelled) return
      if (existingId !== null) {
        navigate(`/tracker/${existingId}`, { replace: true, state: { sharedDuplicate: true } })
      } else {
        const prefill = new URLSearchParams({ url: sharedUrl })
        const name = cleanSharedTitle(params.get('title'))
        if (name) prefill.set('name', name)
        navigate(`/add?${prefill.toString()}`, { replace: true })
      }
    })()
    return () => { cancelled = true }
  }, [params, navigate])

  if (noLink) {
    return (
      <div className="max-w-md mx-auto text-center py-16">
        <Share2 className="w-10 h-10 mx-auto text-text-muted mb-4" />
        <h1 className="text-lg font-semibold mb-2">Nothing to track in that share</h1>
        <p className="text-sm text-text-muted mb-6">
          The shared content didn&apos;t include a product link. Try sharing from the
          product page itself, or add it by hand.
        </p>
        <Link
          to="/add"
          className="inline-block px-4 py-2 rounded-lg bg-primary text-white text-sm font-medium"
        >
          Add a tracker manually
        </Link>
      </div>
    )
  }

  return (
    <div className="flex items-center justify-center h-64 text-text-muted">
      Looking up shared product…
    </div>
  )
}
