"use client"

import { membersApi } from "@/lib/core/backend"
import { FONT_STACKS, paintAppearance } from "@/lib/core/prefs-boot"
import { createStore } from "@/lib/core/store"
import type { TimeFormatPref, UnitsPref, WeekStart } from "@/lib/core/region"

const PREFS_VERSION = 3

export type AccentKey =
  | "rose"
  | "red"
  | "orange"
  | "amber"
  | "yellow"
  | "lime"
  | "green"
  | "emerald"
  | "teal"
  | "cyan"
  | "sky"
  | "blue"
  | "indigo"
  | "violet"
  | "purple"
  | "fuchsia"
  | "pink"
  | "graphite"

/** How light or deep the primary (brand) color is; "base" is the original look. */
export type AccentShade = "lighter" | "light" | "base" | "deep" | "deeper"

export type Density = "compact" | "comfortable" | "spacious"

/** Typefaces of the interface; stacks live in paintAppearance (prefs-boot.ts). Only Geist is bundled. */
export type FontKey = "geist" | "system" | "humanist" | "geometric" | "serif" | "rounded" | "mono"
export const FONTS: FontKey[] = ["geist", "system", "humanist", "geometric", "serif", "rounded", "mono"]

export type Prefs = {
  /** A preset, or "custom" for a colour picked in the accent picker. */
  accent: AccentKey | "custom"
  /** Hue (0–360), chroma and light-theme lightness (OKLCH) of the custom accent; ignored for presets. */
  accentHue?: number
  accentChroma?: number
  accentLight?: number
  accentShade: AccentShade
  density: Density
  radius: number
  /** Body text size in px. It is 1rem of the whole UI, so every type step follows it. */
  textSize: number
  contrast: "normal" | "high"
  reduceMotion: boolean
  sidebarCollapsed: boolean
  sidebarStyle: "pills" | "plain"
  showGreeting: boolean
  /* Advanced · typography */
  fontBody: FontKey
  /** "same" uses the text font for headings too. */
  fontHeading: FontKey | "same"
  /** Weight of headings, labels and emphasis; body text stays regular. */
  weight: "light" | "regular" | "bold"
  lineHeight: "tight" | "normal" | "relaxed"
  letterSpacing: "tight" | "normal" | "wide"
  tabularNumbers: boolean
  /* Advanced · styling */
  shadows: "flat" | "soft" | "lifted"
  borders: "subtle" | "normal" | "strong"
  /** The page behind cards: plain white/black, the soft default grey, or tinted with the accent. */
  canvas: "plain" | "soft" | "tinted"
  iconStroke: "thin" | "regular" | "bold"
  /**
   * Region whose conventions drive numbers, dates, time, week and units; not the
   * interface language. "auto" is detected from the browser (see region.ts).
   */
  region: string
  /** ISO 4217 code; "auto" is the currency of the region. */
  currency: string
  timeFormat: TimeFormatPref
  units: UnitsPref
  /** "auto" follows the region's calendar. */
  weekStartsOn: WeekStart | "auto"
  /** 3 — formats follow `region`; before that `numberLocale` followed the interface language. */
  version?: number
}

/** Range of the "Text size" setting, in px of body text; 16px is the readable default. */
export const TEXT_SIZE_MIN = 12
export const TEXT_SIZE_MAX = 24
export const DEFAULT_TEXT_SIZE = 16
/** One-tap sizes under the slider; anything in the range is allowed. */
export const TEXT_SIZE_PRESETS = [14, 16, 18, 20, 22] as const

export const clampTextSize = (n: number) => Math.round(Math.min(TEXT_SIZE_MAX, Math.max(TEXT_SIZE_MIN, n || DEFAULT_TEXT_SIZE)))

/** Hue / chroma mirror the [data-accent] presets in globals.css. */
export const ACCENTS: { key: AccentKey; h: number; c: number }[] = [
  { key: "rose", h: 10, c: 0.19 },
  { key: "red", h: 25, c: 0.2 },
  { key: "orange", h: 50, c: 0.16 },
  { key: "amber", h: 78, c: 0.15 },
  { key: "yellow", h: 100, c: 0.15 },
  { key: "lime", h: 125, c: 0.17 },
  { key: "green", h: 145, c: 0.17 },
  { key: "emerald", h: 152, c: 0.15 },
  { key: "teal", h: 185, c: 0.12 },
  { key: "cyan", h: 205, c: 0.12 },
  { key: "sky", h: 230, c: 0.13 },
  { key: "blue", h: 255, c: 0.17 },
  { key: "indigo", h: 275, c: 0.18 },
  { key: "violet", h: 300, c: 0.18 },
  { key: "purple", h: 312, c: 0.19 },
  { key: "fuchsia", h: 328, c: 0.2 },
  { key: "pink", h: 350, c: 0.17 },
  { key: "graphite", h: 260, c: 0.01 },
]

/** Lightness of each shade in the light theme (mirrors [data-shade] in globals.css). */
export const ACCENT_SHADES: { key: AccentShade; l: number }[] = [
  { key: "lighter", l: 0.7 },
  { key: "light", l: 0.63 },
  { key: "base", l: 0.56 },
  { key: "deep", l: 0.49 },
  { key: "deeper", l: 0.42 },
]

export function accentSwatch(key: AccentKey, l = 0.62): string {
  const a = ACCENTS.find((x) => x.key === key) ?? ACCENTS[0]
  return `oklch(${l} ${a.c} ${a.h})`
}

/** Hue of the current accent, preset or custom. */
export function accentHueOf(p: Pick<Prefs, "accent" | "accentHue">): number {
  if (p.accent === "custom") return p.accentHue ?? 152
  return (ACCENTS.find((a) => a.key === p.accent) ?? ACCENTS[7]).h
}

/** Chroma (colourfulness) of the current accent, preset or custom. */
export function accentChromaOf(p: Pick<Prefs, "accent" | "accentChroma">): number {
  if (p.accent === "custom") return p.accentChroma ?? 0.15
  return (ACCENTS.find((a) => a.key === p.accent) ?? ACCENTS[7]).c
}

/** Highest chroma the wheel offers; beyond it most hues leave the sRGB gamut. */
export const MAX_CHROMA = 0.22

/** Defaults of the Advanced tab, so it can be reset on its own. */
export const ADVANCED_DEFAULTS = {
  fontBody: "geist",
  fontHeading: "same",
  weight: "regular",
  lineHeight: "normal",
  letterSpacing: "normal",
  tabularNumbers: false,
  shadows: "soft",
  borders: "normal",
  canvas: "soft",
  iconStroke: "regular",
  radius: 0.75,
} satisfies Partial<Prefs>

/** Everything "Reset appearance" restores; language and regional formats are left alone. */
export const APPEARANCE_DEFAULTS = {
  accent: "emerald",
  accentHue: undefined,
  accentChroma: undefined,
  accentLight: undefined,
  accentShade: "base",
  density: "comfortable",
  textSize: DEFAULT_TEXT_SIZE,
  contrast: "normal",
  reduceMotion: false,
  sidebarCollapsed: false,
  sidebarStyle: "pills",
  showGreeting: true,
  ...ADVANCED_DEFAULTS,
} satisfies Partial<Prefs>

/**
 * Appearance and formatting preferences of the signed-in member. Saved to the
 * member's preferences on the server; the local copy (same key as
 * PREFS_STORAGE_KEY, "lemko:prefs:v1") lets the boot script paint before
 * React hydrates.
 */
export const prefsStore = createStore<Prefs>("prefs", () => ({
  ...APPEARANCE_DEFAULTS,
  region: "auto",
  currency: "auto",
  timeFormat: "auto",
  units: "auto",
  weekStartsOn: "auto",
  version: PREFS_VERSION,
}), { persist: true })

/**
 * Copies from before version 3 stored `numberLocale` (an Intl locale, "auto" =
 * interface language) and EUR / Monday as plain defaults. Those defaults become
 * "auto" so the region is detected; an explicit number locale becomes its region.
 */
export function migratePrefs(p: Prefs & { numberLocale?: string }): Prefs {
  if ((p.version ?? 0) >= PREFS_VERSION) return p
  const { numberLocale, ...next } = p
  // Before version 2 "en-US" was only the default, not a choice.
  const chosen = numberLocale && numberLocale !== "auto" && !(!p.version && numberLocale === "en-US")
  const region = chosen ? numberLocale.split("-")[1]?.toUpperCase() : undefined
  if (region) next.region = region
  if (next.currency === "EUR") next.currency = "auto"
  if (next.weekStartsOn === 1) next.weekStartsOn = "auto"
  next.version = PREFS_VERSION
  return next
}

if (typeof window !== "undefined") {
  const current = prefsStore.get()
  const migrated = migratePrefs(current)
  if (migrated !== current) prefsStore.set(() => migrated)
}

export function applyPrefsToDocument(p: Prefs) {
  paintAppearance(p, document.documentElement, FONT_STACKS)
}

export const usePrefs = <S,>(selector: (p: Prefs) => S) => prefsStore.use(selector)
export const setPrefs = prefsStore.set

let applyingServer = false
let saveTimer: ReturnType<typeof setTimeout> | undefined

/** Server copy wins on sign-in (another device may have changed it). */
export function applyServerPrefs(saved: Partial<Prefs> | undefined) {
  if (!saved) return
  applyingServer = true
  prefsStore.set((p) => {
    // `fontSize` was the old root size (default 14px, too small); it is dropped
    // so everyone starts from the readable `textSize` default.
    const { fontSize: _legacy, ...next } = { ...p, ...saved } as Prefs & { fontSize?: unknown }
    return migratePrefs(next)
  })
  applyingServer = false
}

/** Saves every later change to the member's preferences (debounced). */
export function startPrefsSync(): () => void {
  return prefsStore.subscribe(() => {
    if (applyingServer) return
    clearTimeout(saveTimer)
    saveTimer = setTimeout(() => {
      membersApi.updateMe({ preferences: { prefs: prefsStore.get() } }).catch(() => undefined)
    }, 600)
  })
}
