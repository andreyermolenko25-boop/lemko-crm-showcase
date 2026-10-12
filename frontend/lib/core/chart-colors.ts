/** Categorical series colours (CSS vars switch per theme). Assign in fixed order — never by rank. */
export const SERIES = [1, 2, 3, 4, 5, 6, 7, 8].map((n) => `var(--series-${n})`)
export const seriesColor = (i: number) => SERIES[i % SERIES.length]

/** Ordinal ramp for ordered stages (funnels). Light → dark in light mode, reversed on dark. */
export const RAMP = [1, 2, 3, 4, 5, 6].map((n) => `var(--ramp-${n})`)
export const rampColor = (i: number, count: number) => RAMP[Math.round((i / Math.max(1, count - 1)) * (RAMP.length - 1))]
