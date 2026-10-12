import { DEFAULT_LOCALE, LOCALE_FORMATS, type Locale } from "@/lib/i18n/config"
import type en from "@/lib/i18n/messages/en"

/**
 * Message lookup without a library: dictionaries are plain objects, keys are
 * dotted paths checked by TypeScript, values support `{name}` placeholders and
 * plural forms picked with Intl.PluralRules (Polish, Ukrainian and Russian have
 * one / few / many).
 */

export type Plural = { zero?: string; one?: string; two?: string; few?: string; many?: string; other: string }

/** Same keys as the English dictionary; every language fills in its own plural forms. */
export type Dictionary<T> = {
  [K in keyof T]: T[K] extends string ? string : T[K] extends { other: string } ? Plural : Dictionary<T[K]>
}

export type Messages = Dictionary<typeof en>

type Paths<T, P extends string = ""> = {
  [K in keyof T & string]: T[K] extends string | { other: string } ? `${P}${K}` : Paths<T[K], `${P}${K}.`>
}[keyof T & string]

export type MessageKey = Paths<typeof en>
export type MessageVars = Record<string, string | number>

/** Labels of the objects, fields and modules that ship with the app (English is the source). */
export type SchemaFieldMessages = { label?: string; description?: string; options?: Record<string, string> }
export type SchemaMessages = {
  modules?: Record<string, { name?: string; tagline?: string; description?: string; niches?: string[] }>
  /** Names of the default views of the modules, by their English name. */
  views?: Record<string, string>
  entities?: Record<string, { label?: string; labelSingular?: string; description?: string; fields?: Record<string, SchemaFieldMessages> }>
  /** Texts of the integrations store, by app id (permissions in the same order as in the catalogue). */
  integrations?: Record<
    string,
    { tagline?: string; description?: string; permissions?: string[]; settings?: Record<string, { label?: string; hint?: string }> }
  >
}

export type Translator = {
  locale: Locale
  /** Intl locale for numbers and dates in this language ("pl-PL"). */
  formatLocale: string
  t: (key: MessageKey, vars?: MessageVars) => string
  /** Untyped lookup for keys built at runtime; undefined when the key is missing. */
  maybe: (key: string, vars?: MessageVars) => string | undefined
  schema: SchemaMessages
}

const PLACEHOLDER = /\{(\w+)\}/g

function interpolate(text: string, vars?: MessageVars): string {
  if (!vars) return text
  return text.replace(PLACEHOLDER, (match, name: string) => (name in vars ? String(vars[name]) : match))
}

export function createTranslator(locale: Locale, messages: Messages, schema: SchemaMessages = {}): Translator {
  const plurals = new Intl.PluralRules(locale)
  const cache = new Map<string, unknown>()

  function lookup(key: string): unknown {
    if (cache.has(key)) return cache.get(key)
    let node: unknown = messages
    for (const part of key.split(".")) {
      node = node && typeof node === "object" ? (node as Record<string, unknown>)[part] : undefined
    }
    cache.set(key, node)
    return node
  }

  function maybe(key: string, vars?: MessageVars): string | undefined {
    const value = lookup(key)
    if (typeof value === "string") return interpolate(value, vars)
    if (value && typeof value === "object" && "other" in value) {
      const forms = value as Plural
      const count = Number(vars?.count ?? 0)
      const form = count === 0 && forms.zero ? "zero" : plurals.select(count)
      return interpolate(forms[form as keyof Plural] ?? forms.other, vars)
    }
    return undefined
  }

  return {
    locale,
    formatLocale: LOCALE_FORMATS[locale],
    t: (key, vars) => maybe(key, vars) ?? key,
    maybe,
    schema,
  }
}

/* -------------------------------------------------------------------------- */
/*  The language of the open page, for code outside React (toasts, formats)   */
/* -------------------------------------------------------------------------- */

let active: Translator = createTranslator(DEFAULT_LOCALE, {} as Messages)

/** Set by I18nProvider. App pages render in the browser only, so one instance is enough there. */
export function setActiveTranslator(translator: Translator) {
  active = translator
}

export function getTranslator(): Translator {
  return active
}

/** Translate outside of React components (event handlers, stores, toasts). */
export function t(key: MessageKey, vars?: MessageVars): string {
  return active.t(key, vars)
}

export function getLocale(): Locale {
  return active.locale
}
