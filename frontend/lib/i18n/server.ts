import { cookies, headers } from "next/headers"
import { LOCALE_COOKIE, isLocale, matchAcceptLanguage, type Locale } from "@/lib/i18n/config"
import type { Messages, SchemaMessages } from "@/lib/i18n/translate"

/**
 * Language of a request: the member's saved choice (cookie) or, until they
 * make one, the best match of the browser's Accept-Language as a first-visit
 * default. Decided on the server, so the first paint is already in the right
 * language and only that one dictionary is sent to the browser.
 */
export async function getRequestLocale(): Promise<{ locale: Locale }> {
  const saved = (await cookies()).get(LOCALE_COOKIE)?.value
  if (isLocale(saved)) return { locale: saved }
  return { locale: matchAcceptLanguage((await headers()).get("accept-language")) }
}

type Bundle = { default: Messages; schema: SchemaMessages }

const loaders: Record<Locale, () => Promise<Bundle>> = {
  en: () => import("@/lib/i18n/messages/en"),
  pl: () => import("@/lib/i18n/messages/pl"),
  de: () => import("@/lib/i18n/messages/de"),
  uk: () => import("@/lib/i18n/messages/uk"),
  ru: () => import("@/lib/i18n/messages/ru"),
}

export async function loadMessages(locale: Locale): Promise<{ messages: Messages; schema: SchemaMessages }> {
  const bundle = await loaders[locale]()
  return { messages: bundle.default, schema: bundle.schema }
}
