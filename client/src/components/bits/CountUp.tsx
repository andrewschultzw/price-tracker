// Vendored-in-spirit from reactbits.dev Count Up, reimplemented on rAF to
// honor the no-new-runtime-deps constraint.
import { useEffect, useRef, useState } from 'react'

interface Props {
  value: number
  prefix?: string
  decimals?: number
  durationMs?: number
  className?: string
}

const prefersReducedMotion = () =>
  typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches

export default function CountUp({ value, prefix = '', decimals = 0, durationMs = 600, className }: Props) {
  const [display, setDisplay] = useState(() => (prefersReducedMotion() ? value : 0))
  const frame = useRef<number | null>(null)

  useEffect(() => {
    if (prefersReducedMotion()) { setDisplay(value); return }
    const start = performance.now()
    const from = 0
    const tick = (now: number) => {
      const p = Math.min((now - start) / durationMs, 1)
      const eased = 1 - Math.pow(1 - p, 3) // easeOutCubic
      setDisplay(from + (value - from) * eased)
      if (p < 1) frame.current = requestAnimationFrame(tick)
    }
    frame.current = requestAnimationFrame(tick)
    return () => { if (frame.current) cancelAnimationFrame(frame.current) }
  }, [value, durationMs])

  return <span className={className}>{prefix}{display.toFixed(decimals)}</span>
}
