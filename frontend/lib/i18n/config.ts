/**
 * Interface languages. Shared by the server (language detection) and the
 * browser (switcher), so it must stay free of server-only and client-only imports.
 */

export const LOCALES = ["en", "pl", "de", "uk", "ru"] as const
export type Locale = (typeof LOCALES)[number]

export const DEFAULT_LOCALE: Locale = "en"

/**
 * Explicit choice of the member; it stays until they pick another language.
 * Before any choice (no cookie) the first visit starts in the best match of the
 * browser / OS language — a silent default, not an option in the switcher.
 */
export const LOCALE_COOKIE = "lemko_locale"
export const LOCALE_COOKIE_MAX_AGE = 60 * 60 * 24 * 365

/** Language names as their speakers write them (shown in the switcher). */
export const LOCALE_NAMES: Record<Locale, string> = {
  en: "English",
  pl: "Polski",
  de: "Deutsch",
  uk: "Українська",
  ru: "Русский",
}

/** Regional format each language uses for numbers and dates by default. */
export const LOCALE_FORMATS: Record<Locale, string> = {
  en: "en-US",
  pl: "pl-PL",
  de: "de-DE",
  uk: "uk-UA",
  ru: "ru-RU",
}

export function isLocale(value: unknown): value is Locale {
  return typeof value === "string" && (LOCALES as readonly string[]).includes(value)
}

/**
 * Picks the best supported language from an Accept-Language header
 * ("pl-PL,pl;q=0.9,en-US;q=0.8,en;q=0.7"). The browser builds that header from
 * the OS language and the languages set in the browser (in Chrome they come
 * from the Google account when sync is on), so this is the member's own
 * preference without asking. Falls back to English.
 */
export function matchAcceptLanguage(header: string | null | undefined): Locale {
  if (!header) return DEFAULT_LOCALE
  const ranked = header
    .split(",")
    .map((part, index) => {
      const [tag, ...params] = part.trim().split(";")
      const q = params.map((p) => p.trim()).find((p) => p.startsWith("q="))
      const quality = q ? Number(q.slice(2)) : 1
      return { tag: tag.trim().toLowerCase(), quality: Number.isFinite(quality) ? quality : 0, index }
    })
    .filter((x) => x.tag && x.tag !== "*" && x.quality > 0)
    .sort((a, b) => b.quality - a.quality || a.index - b.index)
  for (const { tag } of ranked) {
    const base = tag.split("-")[0]
    if (isLocale(base)) return base
  }
  return DEFAULT_LOCALE
}
