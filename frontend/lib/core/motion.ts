/**
 * Motion tokens of the app shell. Same numbers as the marketing site
 * (site/lib/motion-tokens.ts), so the product and the site move with one rhythm.
 */
export const duration = {
  instant: 0.08,
  fast: 0.18,
  normal: 0.35,
  slow: 0.6,
} as const

export const easing = {
  smooth: [0.22, 1, 0.36, 1] as const,
  sharp: [0.4, 0, 0.2, 1] as const,
}

export const stagger = {
  tight: 0.03,
  normal: 0.05,
} as const

export const springs = {
  snappy: { type: "spring", stiffness: 300, damping: 30 },
  instant: { type: "spring", stiffness: 600, damping: 35 },
} as const

/** Scale of a pressed control. */
export const press = 0.98
