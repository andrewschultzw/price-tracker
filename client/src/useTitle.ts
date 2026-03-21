import { useEffect } from 'react'

export default function useTitle(title: string) {
  useEffect(() => {
    const prev = document.title
    document.title = title ? `${title} | Price Tracker` : 'Price Tracker'
    return () => { document.title = prev }
  }, [title])
}
