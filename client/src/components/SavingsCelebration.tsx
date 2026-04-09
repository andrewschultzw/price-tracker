import { useEffect, useCallback } from 'react'
import { createPortal } from 'react-dom'
import confetti from 'canvas-confetti'
import type { SavingsTier } from '../lib/savings-tiers'

interface Props {
  tier: SavingsTier
  saying: string
  savingsAmount: number
  onDismiss: () => void
}

/**
 * Full-page celebration overlay triggered when the user clicks the
 * Potential Savings stat card. The visual effects escalate per tier
 * (cumulative — tier 6 includes everything from tier 1 through 5), while
 * the saying is displayed center-screen in a floating card.
 *
 * Rendered via React portal so it sits above every other element in the
 * DOM regardless of where in the tree it's mounted from.
 *
 * Accessibility: respects prefers-reduced-motion — the saying text still
 * shows but the visual effects (confetti, shake, flash) are all skipped.
 *
 * Dismissal: auto after 5s (7s for tier 6 which has bigger effects to
 * finish playing), or click/tap anywhere to skip early.
 */
export default function SavingsCelebration({ tier, saying, savingsAmount, onDismiss }: Props) {
  useEffect(() => {
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    if (!reducedMotion) {
      runTierEffects(tier)
    }

    const holdMs = tier >= 6 ? 7000 : 5000
    const timer = setTimeout(onDismiss, holdMs)
    return () => {
      clearTimeout(timer)
      cleanupBodyClasses()
    }
  }, [tier, onDismiss])

  const handleClick = useCallback(() => {
    cleanupBodyClasses()
    onDismiss()
  }, [onDismiss])

  // Render into document.body via portal so we're guaranteed to be above
  // every other page element without z-index wars.
  return createPortal(
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center cursor-pointer"
      onClick={handleClick}
      role="dialog"
      aria-label={`Savings celebration, tier ${tier}: ${saying}`}
    >
      {/* Backdrop — only dim + blur for tier 6; lighter tiers keep the dashboard visible so the confetti sparkles over it */}
      <div
        className={`absolute inset-0 pointer-events-none transition-opacity duration-500 ${
          tier >= 6 ? 'bg-black/60 backdrop-blur-sm' : 'bg-transparent'
        }`}
      />

      {/* Saying card */}
      <div
        className={`relative z-10 max-w-lg mx-4 pointer-events-none ${
          tier >= 6 ? 'animate-celebration-pop-big' : 'animate-celebration-pop'
        }`}
      >
        <div
          className={`bg-surface/95 backdrop-blur border-2 rounded-2xl px-6 py-5 sm:px-10 sm:py-8 text-center shadow-2xl ${
            tier >= 6 ? 'border-warning shadow-warning/50' : 'border-primary/60'
          }`}
        >
          <div className={`text-xs uppercase tracking-wider font-bold mb-2 ${
            tier >= 6 ? 'text-warning' : 'text-primary'
          }`}>
            Tier {tier}
          </div>
          <div className={`font-bold text-text ${tier >= 6 ? 'text-3xl sm:text-4xl' : 'text-xl sm:text-2xl'}`}>
            {saying}
          </div>
          <div className={`mt-3 ${tier >= 6 ? 'text-2xl sm:text-3xl text-success font-extrabold' : 'text-lg text-success font-semibold'}`}>
            ${savingsAmount.toFixed(2)} in potential savings
          </div>
          <div className="text-[11px] text-text-muted mt-4">
            Click anywhere to dismiss
          </div>
        </div>
      </div>
    </div>,
    document.body,
  )
}

/**
 * Drives the visual effects. Each tier's effects are a strict superset of
 * the previous tier — tier 6 plays everything. The confetti canvas is
 * drawn outside React's render tree so it sits over the whole viewport
 * without any CSS plumbing.
 */
function runTierEffects(tier: number): void {
  // --- Tier 1: small confetti burst from bottom-center ---
  confetti({
    particleCount: 40,
    spread: 70,
    origin: { y: 0.85, x: 0.5 },
    startVelocity: 35,
    zIndex: 200,
  })

  // --- Tier 2: shake the stat cards ---
  if (tier >= 2) {
    document.body.classList.add('celebration-shake')
    setTimeout(() => document.body.classList.remove('celebration-shake'), 1500)
  }

  // --- Tier 3: bigger confetti spray from both sides ---
  if (tier >= 3) {
    setTimeout(() => {
      confetti({
        particleCount: 80,
        angle: 60,
        spread: 75,
        origin: { x: 0, y: 0.8 },
        startVelocity: 55,
        zIndex: 200,
      })
      confetti({
        particleCount: 80,
        angle: 120,
        spread: 75,
        origin: { x: 1, y: 0.8 },
        startVelocity: 55,
        zIndex: 200,
      })
    }, 200)
  }

  // --- Tier 4: fireworks + subtle gold flash ---
  if (tier >= 4) {
    fireFireworks(3000)
    document.body.classList.add('celebration-flash')
    setTimeout(() => document.body.classList.remove('celebration-flash'), 500)
  }

  // --- Tier 5: emoji rain + card bounce ---
  if (tier >= 5) {
    setTimeout(() => fireEmojiRain(), 400)
    document.body.classList.add('celebration-bounce')
    setTimeout(() => document.body.classList.remove('celebration-bounce'), 2200)
  }

  // --- Tier 6: the works ---
  if (tier >= 6) {
    document.body.classList.add('celebration-tier-6')
    setTimeout(() => document.body.classList.remove('celebration-tier-6'), 7000)

    // Massive cannon from bottom
    setTimeout(() => {
      confetti({
        particleCount: 250,
        spread: 120,
        origin: { y: 0.7 },
        startVelocity: 75,
        scalar: 1.3,
        zIndex: 200,
      })
    }, 100)

    // Second cannon for dramatic effect
    setTimeout(() => {
      confetti({
        particleCount: 150,
        spread: 100,
        origin: { y: 0.8, x: 0.3 },
        startVelocity: 70,
        zIndex: 200,
      })
      confetti({
        particleCount: 150,
        spread: 100,
        origin: { y: 0.8, x: 0.7 },
        startVelocity: 70,
        zIndex: 200,
      })
    }, 1500)
  }
}

/**
 * Continuous fireworks over a duration (tier 4+). Shoots random bursts
 * from random points near the top two-thirds of the viewport.
 */
function fireFireworks(durationMs: number): void {
  const animationEnd = Date.now() + durationMs
  const defaults = {
    startVelocity: 30,
    spread: 360,
    ticks: 60,
    zIndex: 200,
  }

  const interval = window.setInterval(() => {
    const timeLeft = animationEnd - Date.now()
    if (timeLeft <= 0) {
      clearInterval(interval)
      return
    }
    const particleCount = 50 * (timeLeft / durationMs)
    confetti({
      ...defaults,
      particleCount,
      origin: { x: Math.random(), y: Math.random() * 0.5 + 0.1 },
    })
  }, 250)
}

/**
 * Emoji rain (tier 5+). Uses canvas-confetti's shapeFromText for the
 * money-themed emoji shapes, falling with reduced start velocity so they
 * look like they're raining rather than exploding.
 */
function fireEmojiRain(): void {
  const scalar = 2.2
  const shapes = ['💸', '💰', '🎉'].map(text =>
    confetti.shapeFromText({ text, scalar }),
  )
  const defaults = {
    spread: 360,
    ticks: 100,
    gravity: 0.7,
    decay: 0.94,
    startVelocity: 25,
    shapes,
    scalar,
    zIndex: 200,
  }
  confetti({ ...defaults, particleCount: 25, origin: { x: 0.2, y: 0 } })
  confetti({ ...defaults, particleCount: 25, origin: { x: 0.5, y: 0 } })
  confetti({ ...defaults, particleCount: 25, origin: { x: 0.8, y: 0 } })
}

/**
 * Defensive cleanup — if the user clicks through multiple celebrations
 * rapidly, or the component unmounts mid-animation, we don't want stale
 * classes left on body.
 */
function cleanupBodyClasses(): void {
  for (const cls of [
    'celebration-shake',
    'celebration-flash',
    'celebration-bounce',
    'celebration-tier-6',
  ]) {
    document.body.classList.remove(cls)
  }
}
