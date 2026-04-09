/**
 * Savings celebration tiers. Pure function, easily testable. The tier
 * thresholds and sayings are the single source of truth — the celebration
 * component imports this to decide what to play.
 *
 * Tiers are open-at-top, closed-at-bottom — i.e. tier 2 covers [10, 25).
 * This avoids off-by-one confusion at the boundaries ($10 is tier 2, not
 * tier 1; $25 is tier 3, not tier 2).
 */

export type SavingsTier = 1 | 2 | 3 | 4 | 5 | 6

interface TierDef {
  tier: SavingsTier
  min: number  // inclusive
  max: number  // exclusive; Infinity for top tier
  sayings: readonly string[]
}

const TIERS: readonly TierDef[] = [
  {
    tier: 1,
    min: 1,
    max: 10,
    sayings: [
      'Every dollar counts.',
      'A coffee on the house.',
      'Small wins compound.',
      'Your vigilance paid off.',
      "That's a snack, at least.",
    ],
  },
  {
    tier: 2,
    min: 10,
    max: 25,
    sayings: [
      'Lunch is on the bots.',
      'Patience, rewarded.',
      "Someone dropped the price so you didn't have to.",
      "That's the good kind of green.",
      'Enough for a decent takeout order.',
    ],
  },
  {
    tier: 3,
    min: 25,
    max: 50,
    sayings: [
      'Tank of gas saved.',
      "Now we're talking.",
      'The algorithms are smiling on you.',
      "That's a real dinner out.",
      'Worth every cron tick.',
    ],
  },
  {
    tier: 4,
    min: 50,
    max: 100,
    sayings: [
      'Weekend fund activated.',
      'Your future self is thanking you.',
      'The scraper earned its keep this month.',
      'New keyboard fund right there.',
      'Victory. Actual victory.',
    ],
  },
  {
    tier: 5,
    min: 100,
    max: 250,
    sayings: [
      'Your patience just paid rent on a CT.',
      'This is why you automate.',
      'The price tracker is officially in the black.',
      "Somewhere, a retailer's pricing algorithm is crying.",
      'Put it toward more homelab gear. You know you want to.',
    ],
  },
  {
    tier: 6,
    min: 250,
    max: Infinity,
    sayings: [
      'Absolutely unhinged savings.',
      'The homelab has achieved sentience.',
      'This tracker pays for itself and then some.',
      'Start a second homelab with the savings.',
      'You just out-bargained the entire internet.',
    ],
  },
] as const

/**
 * Which tier does this savings amount belong to? Returns null for anything
 * under $1 (no celebration for trivial savings).
 */
export function getTier(savings: number): SavingsTier | null {
  if (!Number.isFinite(savings) || savings < 1) return null
  for (const def of TIERS) {
    if (savings >= def.min && savings < def.max) return def.tier
  }
  return null
}

/**
 * Pick a random saying for the given tier. `rng` is injectable so tests
 * can make the output deterministic.
 */
export function pickSaying(tier: SavingsTier, rng: () => number = Math.random): string {
  const def = TIERS.find(t => t.tier === tier)
  if (!def) throw new Error(`Unknown tier: ${tier}`)
  const idx = Math.floor(rng() * def.sayings.length)
  return def.sayings[idx]
}

/** Expose the full tier table for UI that wants to show "you need $X more to unlock tier Y" etc. */
export function getTierDefinitions(): readonly TierDef[] {
  return TIERS
}
