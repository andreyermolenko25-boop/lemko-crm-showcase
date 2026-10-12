import { useMemo, useSyncExternalStore } from "react"
import { prefsStore, usePrefs } from "@/lib/core/prefs"
import { convertMeasure, resolveFormats, type MeasureKind, type ResolvedFormats } from "@/lib/core/region"
import { getTranslator } from "@/lib/i18n/translate"

const resolved = new Map<string, ResolvedFormats>()

/**
 * Currency, number, date, time, week and unit conventions of the member: their
 * chosen region, or the one detected from the browser. The interface language
 * only decides the region when the browser gives no hint at all.
 */
export function formats(): ResolvedFormats {
  const p = prefsStore.get()
  const ui = getTranslator().locale
  const key = [p.region, p.currency, p.timeFormat, p.units, p.weekStartsOn, ui].join("|")
  let f = resolved.get(key)
  if (!f) {
    f = resolveFormats(p, ui)
    resolved.set(key, f)
  }
  return f
}

/** Re-renders when the region or any format preference changes (or the language does, for the fallback). */
export function useFormats(): ResolvedFormats {
  const region = usePrefs((p) => p.region)
  const currency = usePrefs((p) => p.currency)
  const timeFormat = usePrefs((p) => p.timeFormat)
  const units = usePrefs((p) => p.units)
  const weekStartsOn = usePrefs((p) => p.weekStartsOn)
  const ui = getTranslator().locale
  return useMemo(
    () => resolveFormats({ region, currency, timeFormat, units, weekStartsOn }, ui),
    [region, currency, timeFormat, units, weekStartsOn, ui],
  )
}

/**
 * Format locale for pages that may be server-rendered (public booking): the
 * language's own locale during SSR and hydration, the member's region afterwards.
 */
export function useFormatLocale(fallback: string): string {
  return useSyncExternalStore(prefsStore.subscribe, () => formats().locale, () => fallback)
}

/** Intl locale carrying the region's number, date and time conventions ("en-GB"). */
export function formatLocale(): string {
  return formats().locale
}

const nf = new Map<string, Intl.NumberFormat>()

function numberFormat(key: string, opts: Intl.NumberFormatOptions) {
  const locale = formatLocale()
  const cacheKey = `${locale}|${key}`
  let f = nf.get(cacheKey)
  if (!f) {
    f = new Intl.NumberFormat(locale, opts)
    nf.set(cacheKey, f)
  }
  return f
}

export function formatMoney(value: unknown, opts: { compact?: boolean; currency?: string } = {}) {
  const n = Number(value)
  if (!Number.isFinite(n)) return "—"
  const currency = opts.currency ?? formats().currency
  if (opts.compact && Math.abs(n) >= 10_000) {
    return numberFormat(`money-c-${currency}`, {
      style: "currency",
      currency,
      notation: "compact",
      maximumFractionDigits: 2,
    }).format(n)
  }
  return numberFormat(`money-${currency}`, {
    style: "currency",
    currency,
    maximumFractionDigits: 0,
  }).format(n)
}

export function formatNumber(value: unknown, compact = false) {
  const n = Number(value)
  if (!Number.isFinite(n)) return "—"
  return numberFormat(compact ? "num-c" : "num", {
    notation: compact ? "compact" : "standard",
    maximumFractionDigits: compact ? 1 : 2,
  }).format(n)
}

export function formatDate(value: unknown, opts: Intl.DateTimeFormatOptions = { month: "short", day: "2-digit" }) {
  if (!value) return "—"
  const d = new Date(String(value))
  if (Number.isNaN(d.getTime())) return "—"
  const f = formats()
  // A format that shows the time of day follows the 12/24-hour choice unless it states its own.
  const withTime = opts.hour !== undefined || opts.timeStyle !== undefined
  const hour = opts.hour12 === undefined && opts.hourCycle === undefined && withTime ? { hour12: f.hour12 } : {}
  return d.toLocaleDateString(f.locale, { ...opts, ...hour })
}

export function formatTime(value: unknown) {
  if (!value) return ""
  const d = new Date(String(value))
  if (Number.isNaN(d.getTime())) return ""
  const { locale, hour12 } = formats()
  return d.toLocaleTimeString(locale, { hour: hour12 ? "numeric" : "2-digit", minute: "2-digit", hour12 })
}

/** A length, distance, weight or temperature stored in metric units, shown in the member's system. */
export function formatMeasure(value: unknown, kind: MeasureKind, maximumFractionDigits = 1) {
  const n = Number(value)
  if (!Number.isFinite(n)) return "—"
  const f = formats()
  const { value: converted, unit } = convertMeasure(n, kind, f.units)
  return numberFormat(`unit-${unit}-${maximumFractionDigits}`, {
    style: "unit",
    unit,
    unitDisplay: "short",
    maximumFractionDigits,
  }).format(converted)
}

export function formatDateTime(value: unknown) {
  return `${formatDate(value, { month: "short", day: "2-digit", year: "numeric" })}, ${formatTime(value)}`
}

const rtf = new Map<string, Intl.RelativeTimeFormat>()

export function timeAgo(value: unknown) {
  if (!value) return ""
  const d = new Date(String(value)).getTime()
  const diff = d - Date.now()
  const abs = Math.abs(diff)
  const min = 60_000
  const { locale, t } = getTranslator()
  if (abs < min) return t("common.justNow")
  let f = rtf.get(locale)
  if (!f) {
    f = new Intl.RelativeTimeFormat(locale, { style: "narrow", numeric: "always" })
    rtf.set(locale, f)
  }
  const sign = diff < 0 ? -1 : 1
  if (abs < 60 * min) return f.format(sign * Math.round(abs / min), "minute")
  if (abs < 24 * 60 * min) return f.format(sign * Math.round(abs / (60 * min)), "hour")
  if (abs < 7 * 24 * 60 * min) return f.format(sign * Math.round(abs / (24 * 60 * min)), "day")
  return formatDate(value)
}

const capitalize = (s: string) => s.charAt(0).toLocaleUpperCase() + s.slice(1)

/** Month names in the interface language (January = 0), capitalised for headings and pickers. */
export function monthNames(style: "long" | "short" = "long"): string[] {
  const f = new Intl.DateTimeFormat(getTranslator().locale, { month: style })
  return Array.from({ length: 12 }, (_, m) => capitalize(f.format(new Date(2024, m, 1)).replace(/\.$/, "")))
}

/** Weekday names in the interface language starting from Sunday (= 0). */
export function weekdayNames(style: "long" | "short" | "narrow" = "short"): string[] {
  const f = new Intl.DateTimeFormat(getTranslator().locale, { weekday: style })
  // 2024-01-07 was a Sunday.
  return Array.from({ length: 7 }, (_, d) => capitalize(f.format(new Date(2024, 0, 7 + d))))
}

/** "March 2026" in the interface language. */
export function monthYear(date: Date): string {
  return capitalize(new Intl.DateTimeFormat(getTranslator().locale, { month: "long", year: "numeric" }).format(date))
}

export function initials(name: unknown) {
  const s = String(name ?? "").trim()
  if (!s) return "?"
  const parts = s.split(/\s+/)
  return (parts[0][0] + (parts[1]?.[0] ?? parts[0][1] ?? "")).toUpperCase()
}

export function isSameDay(a: Date, b: Date) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
}
