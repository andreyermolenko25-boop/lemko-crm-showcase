import { LOCALE_FORMATS, type Locale } from "@/lib/i18n/config"

/**
 * Regional formats, independent of the interface language: a German-speaking
 * member in the US still gets $1,234.50 and 3:30 PM. Everything here is derived
 * from one region code (ISO 3166 alpha-2), detected from the browser until the
 * member picks one. No React and no stores, so it can be used anywhere.
 */

export type UnitSystem = "metric" | "imperial" | "uk"
export type TimeFormatPref = "auto" | "12h" | "24h"
export type UnitsPref = "auto" | UnitSystem
/** Day the week starts on, as Date#getDay(): Sunday 0, Monday 1, Saturday 6. */
export type WeekStart = 0 | 1 | 6

export type RegionPrefs = {
  /** ISO region code, or "auto" to detect it from the browser. */
  region: string
  /** ISO 4217 code, or "auto" for the currency of the region. */
  currency: string
  timeFormat: TimeFormatPref
  units: UnitsPref
  /** "auto" follows the region's calendar. */
  weekStartsOn: WeekStart | "auto"
}

export type ResolvedFormats = {
  region: string
  /** Intl locale that carries the region's number, date and time conventions ("en-GB"). */
  locale: string
  currency: string
  hour12: boolean
  weekStartsOn: WeekStart
  units: UnitSystem
}

/** [Intl locale, currency] of every region the picker offers. */
const REGIONS: Record<string, [string, string]> = {
  US: ["en-US", "USD"], CA: ["en-CA", "CAD"], MX: ["es-MX", "MXN"], BR: ["pt-BR", "BRL"],
  AR: ["es-AR", "ARS"], CL: ["es-CL", "CLP"], CO: ["es-CO", "COP"],
  GB: ["en-GB", "GBP"], IE: ["en-IE", "EUR"],
  DE: ["de-DE", "EUR"], AT: ["de-AT", "EUR"], CH: ["de-CH", "CHF"],
  FR: ["fr-FR", "EUR"], BE: ["nl-BE", "EUR"], NL: ["nl-NL", "EUR"], LU: ["fr-LU", "EUR"],
  ES: ["es-ES", "EUR"], PT: ["pt-PT", "EUR"], IT: ["it-IT", "EUR"], GR: ["el-GR", "EUR"],
  FI: ["fi-FI", "EUR"], EE: ["et-EE", "EUR"], LV: ["lv-LV", "EUR"], LT: ["lt-LT", "EUR"],
  SK: ["sk-SK", "EUR"], SI: ["sl-SI", "EUR"], HR: ["hr-HR", "EUR"], BG: ["bg-BG", "EUR"],
  PL: ["pl-PL", "PLN"], CZ: ["cs-CZ", "CZK"], HU: ["hu-HU", "HUF"], RO: ["ro-RO", "RON"],
  SE: ["sv-SE", "SEK"], NO: ["nb-NO", "NOK"], DK: ["da-DK", "DKK"], IS: ["is-IS", "ISK"],
  UA: ["uk-UA", "UAH"], MD: ["ro-MD", "MDL"], RU: ["ru-RU", "RUB"], BY: ["ru-BY", "BYN"],
  KZ: ["ru-KZ", "KZT"], GE: ["ka-GE", "GEL"], TR: ["tr-TR", "TRY"],
  IL: ["he-IL", "ILS"], AE: ["ar-AE", "AED"], SA: ["ar-SA", "SAR"], EG: ["ar-EG", "EGP"],
  ZA: ["en-ZA", "ZAR"], NG: ["en-NG", "NGN"],
  IN: ["en-IN", "INR"], JP: ["ja-JP", "JPY"], KR: ["ko-KR", "KRW"], CN: ["zh-CN", "CNY"],
  TW: ["zh-TW", "TWD"], HK: ["zh-HK", "HKD"], SG: ["en-SG", "SGD"], TH: ["th-TH", "THB"],
  ID: ["id-ID", "IDR"], VN: ["vi-VN", "VND"], PH: ["en-PH", "PHP"],
  AU: ["en-AU", "AUD"], NZ: ["en-NZ", "NZD"],
}

export const REGION_CODES = Object.keys(REGIONS)

export const CURRENCY_CODES = Array.from(new Set(Object.values(REGIONS).map(([, c]) => c))).sort()

const IMPERIAL = new Set(["US", "LR", "MM"])
// Only used where the engine has no Intl.Locale week info.
const SUNDAY_START = new Set(["US", "CA", "MX", "BR", "AR", "CO", "JP", "KR", "TW", "HK", "IL", "SA", "IN", "PH", "ZA", "TH"])
const SATURDAY_START = new Set(["EG", "AF", "IR", "DZ", "IQ", "SY"])

const TIME_ZONE_REGIONS: Record<string, string> = {
  "Europe/Warsaw": "PL", "Europe/Berlin": "DE", "Europe/Kyiv": "UA", "Europe/Kiev": "UA", "Europe/Moscow": "RU",
  "Europe/London": "GB", "Europe/Dublin": "IE", "Europe/Paris": "FR", "Europe/Madrid": "ES", "Europe/Rome": "IT",
  "Europe/Amsterdam": "NL", "Europe/Brussels": "BE", "Europe/Vienna": "AT", "Europe/Zurich": "CH",
  "Europe/Prague": "CZ", "Europe/Budapest": "HU", "Europe/Bucharest": "RO", "Europe/Sofia": "BG",
  "Europe/Stockholm": "SE", "Europe/Oslo": "NO", "Europe/Copenhagen": "DK", "Europe/Helsinki": "FI",
  "Europe/Lisbon": "PT", "Europe/Athens": "GR", "Europe/Istanbul": "TR", "Europe/Minsk": "BY",
  "Europe/Riga": "LV", "Europe/Vilnius": "LT", "Europe/Tallinn": "EE", "Europe/Bratislava": "SK",
  "Europe/Ljubljana": "SI", "Europe/Zagreb": "HR", "Europe/Chisinau": "MD", "Atlantic/Reykjavik": "IS",
  "Asia/Tokyo": "JP", "Asia/Seoul": "KR", "Asia/Shanghai": "CN", "Asia/Kolkata": "IN", "Asia/Calcutta": "IN",
  "Asia/Dubai": "AE", "Asia/Jerusalem": "IL", "Asia/Singapore": "SG", "Asia/Almaty": "KZ", "Asia/Tbilisi": "GE",
  "Asia/Bangkok": "TH", "Asia/Manila": "PH", "Asia/Taipei": "TW", "Asia/Hong_Kong": "HK",
  "Pacific/Auckland": "NZ", "Africa/Johannesburg": "ZA", "Africa/Cairo": "EG", "Africa/Lagos": "NG",
  "America/Toronto": "CA", "America/Vancouver": "CA", "America/Sao_Paulo": "BR", "America/Mexico_City": "MX",
  "America/Argentina/Buenos_Aires": "AR", "America/Bogota": "CO", "America/Santiago": "CL",
}

const US_ZONES = /^America\/(New_York|Chicago|Denver|Los_Angeles|Phoenix|Anchorage|Detroit|Boise)$|^Pacific\/Honolulu$/

export type BrowserEnv = { languages: readonly string[]; timeZone?: string }

export function browserEnv(): BrowserEnv {
  if (typeof navigator === "undefined") return { languages: [] }
  const languages = navigator.languages?.length ? navigator.languages : navigator.language ? [navigator.language] : []
  let timeZone: string | undefined
  try {
    timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone
  } catch {
    timeZone = undefined
  }
  return { languages, timeZone }
}

/** "en-GB" → "GB", "zh-Hant-TW" → "TW", "en" → undefined. */
function regionOfTag(tag: string): string | undefined {
  return /^[A-Za-z]{2,3}(?:-[A-Za-z]{4})?-([A-Za-z]{2})(?:-|$)/.exec(tag)?.[1].toUpperCase()
}

/**
 * The region the member most likely lives in. The explicit region of a browser
 * language ("en-GB") wins, then the time zone, and only then the default region
 * of the interface language. A bare "en" therefore doesn't force the US.
 */
export function detectRegion(env: BrowserEnv, uiLocale: Locale): string {
  for (const tag of env.languages) {
    const region = regionOfTag(tag)
    if (region && REGIONS[region]) return region
  }
  const zone = env.timeZone
  if (zone) {
    if (TIME_ZONE_REGIONS[zone]) return TIME_ZONE_REGIONS[zone]
    if (US_ZONES.test(zone)) return "US"
    if (zone.startsWith("Australia/")) return "AU"
  }
  return LOCALE_FORMATS[uiLocale].split("-")[1]
}

function hour12Of(locale: string): boolean {
  try {
    return new Intl.DateTimeFormat(locale, { hour: "numeric" }).resolvedOptions().hour12 ?? false
  } catch {
    return false
  }
}

function weekStartOf(region: string, locale: string): WeekStart {
  try {
    const loc = new Intl.Locale(locale) as Intl.Locale & {
      getWeekInfo?: () => { firstDay: number }
      weekInfo?: { firstDay: number }
    }
    const first = (loc.getWeekInfo?.() ?? loc.weekInfo)?.firstDay
    // Intl numbers days 1 (Monday) to 7 (Sunday).
    if (first) return (first % 7) as WeekStart
  } catch {
    // Older engines: fall through to the table.
  }
  if (SATURDAY_START.has(region)) return 6
  return SUNDAY_START.has(region) ? 0 : 1
}

function unitsOf(region: string): UnitSystem {
  if (IMPERIAL.has(region)) return "imperial"
  return region === "GB" ? "uk" : "metric"
}

/** Region code, locale and currency for a region; unknown regions fall back to the language's own. */
export function regionInfo(region: string, uiLocale: Locale): { region: string; locale: string; currency: string } {
  const known = REGIONS[region]
  if (known) return { region, locale: known[0], currency: known[1] }
  const fallback = LOCALE_FORMATS[uiLocale]
  const code = fallback.split("-")[1]
  return { region: code, locale: fallback, currency: REGIONS[code]?.[1] ?? "EUR" }
}

export function resolveFormats(p: RegionPrefs, uiLocale: Locale, env: BrowserEnv = browserEnv()): ResolvedFormats {
  const wanted = p.region && p.region !== "auto" ? p.region : detectRegion(env, uiLocale)
  const info = regionInfo(wanted, uiLocale)
  return {
    region: info.region,
    locale: info.locale,
    currency: p.currency && p.currency !== "auto" ? p.currency : info.currency,
    hour12: p.timeFormat === "12h" ? true : p.timeFormat === "24h" ? false : hour12Of(info.locale),
    weekStartsOn: p.weekStartsOn === "auto" || p.weekStartsOn === undefined ? weekStartOf(info.region, info.locale) : p.weekStartsOn,
    units: p.units && p.units !== "auto" ? p.units : unitsOf(info.region),
  }
}

/** Names of the regions in the given language ("Germany"), for the picker. */
export function regionName(region: string, language: string): string {
  try {
    return new Intl.DisplayNames([language], { type: "region" }).of(region) ?? region
  } catch {
    return region
  }
}

/** Base units the app stores values in; shown in the member's measurement system. */
export type MeasureKind = "distance" | "length" | "weight" | "temperature"

const UNIT_TABLE: Record<MeasureKind, { metric: [string, (v: number) => number]; imperial: [string, (v: number) => number] }> = {
  distance: { metric: ["kilometer", (v) => v], imperial: ["mile", (v) => v / 1.609344] },
  length: { metric: ["centimeter", (v) => v], imperial: ["inch", (v) => v / 2.54] },
  weight: { metric: ["kilogram", (v) => v], imperial: ["pound", (v) => v / 0.45359237] },
  temperature: { metric: ["celsius", (v) => v], imperial: ["fahrenheit", (v) => (v * 9) / 5 + 32] },
}

/**
 * Converts a value stored in kilometres, centimetres, kilograms or °C to the
 * unit of the measurement system. "uk" keeps the metric weight and temperature
 * of everyday British use but measures road distance in miles.
 */
export function convertMeasure(value: number, kind: MeasureKind, units: UnitSystem): { value: number; unit: string } {
  const imperial = units === "imperial" || (units === "uk" && kind === "distance")
  const [unit, convert] = UNIT_TABLE[kind][imperial ? "imperial" : "metric"]
  return { value: convert(value), unit }
}
