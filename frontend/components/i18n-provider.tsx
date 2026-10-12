"use client"

import { createContext, useContext, useMemo, type ReactNode } from "react"
import type { Locale } from "@/lib/i18n/config"
import { createTranslator, setActiveTranslator, type Messages, type SchemaMessages, type Translator } from "@/lib/i18n/translate"

const I18nContext = createContext<Translator | null>(null)

/** Receives the one dictionary the server picked for this request. */
export function I18nProvider({
  locale,
  messages,
  schema,
  children,
}: {
  locale: Locale
  messages: Messages
  schema: SchemaMessages
  children: ReactNode
}) {
  const value = useMemo(() => createTranslator(locale, messages, schema), [locale, messages, schema])
  // Code outside React (stores, toasts, formatters) reads the same language.
  if (typeof window !== "undefined") setActiveTranslator(value)
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>
}

function useI18nContext() {
  const ctx = useContext(I18nContext)
  if (!ctx) throw new Error("useT must be used inside <I18nProvider>")
  return ctx
}

/** `const t = useT()` → `t("auth.signIn")`. Re-renders when the language changes. */
export function useT(): Translator["t"] {
  return useI18nContext().t
}

export function useI18n() {
  return useI18nContext()
}

export function useLocale(): Locale {
  return useI18nContext().locale
}
