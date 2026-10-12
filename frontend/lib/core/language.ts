"use client"

import { useCallback, useEffect, useRef } from "react"
import { useI18n } from "@/components/i18n-provider"
import { isLocale, type Locale } from "@/lib/i18n/config"
import { renewStoredLocale, storedLocale, useSetLocale } from "@/lib/i18n/client"
import { membersApi } from "@/lib/core/backend"
import { savePreferences, sessionStore } from "@/lib/core/session"

/**
 * Interface language of the signed-in member. The browser keeps the choice in
 * a cookie (the server renders with it); the member's preferences keep a copy
 * so a new device starts in the same language. A choice stays until the member
 * picks another language.
 */
export function useLanguage() {
  const { locale } = useI18n()
  const { setLocale, pending } = useSetLocale()
  const change = useCallback(
    (next: Locale) => {
      setLocale(next)
      savePreferences({ locale: next }).catch(() => undefined)
    },
    [setLocale],
  )
  return { locale, change, pending }
}

/**
 * After sign-in: a browser without its own choice takes the one saved in the
 * member's preferences; a browser with a choice (made on the sign-in page,
 * say) is the latest word and is saved for the other devices. The browser's
 * copy is renewed on every visit, so it does not expire while it is in use.
 */
export function useLanguageSync(ready: boolean) {
  const { setLocale } = useSetLocale()
  const done = useRef(false)
  useEffect(() => {
    if (!ready || done.current) return
    done.current = true
    const saved = sessionStore.get().preferences.locale
    const local = storedLocale()
    if (local === null) {
      if (isLocale(saved)) setLocale(saved)
      return
    }
    renewStoredLocale()
    if (saved !== local) {
      sessionStore.set((s) => ({ ...s, preferences: { ...s.preferences, locale: local } }))
      membersApi.updateMe({ preferences: { locale: local } }).catch(() => undefined)
    }
  }, [ready, setLocale])
}
