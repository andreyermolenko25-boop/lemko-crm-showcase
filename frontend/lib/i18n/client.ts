"use client"

import { useRouter } from "next/navigation"
import { useCallback, useTransition } from "react"
import { LOCALE_COOKIE, LOCALE_COOKIE_MAX_AGE, isLocale, type Locale } from "@/lib/i18n/config"

function readCookie(): Locale | null {
  if (typeof document === "undefined") return null
  const match = document.cookie.match(new RegExp(`(?:^|; )${LOCALE_COOKIE}=([^;]*)`))
  const value = match ? decodeURIComponent(match[1]) : null
  return isLocale(value) ? value : null
}

function writeCookie(locale: Locale) {
  const secure = window.location.protocol === "https:" ? "; Secure" : ""
  document.cookie = `${LOCALE_COOKIE}=${locale}; Path=/; Max-Age=${LOCALE_COOKIE_MAX_AGE}; SameSite=Lax${secure}`
}

/** The language this browser was pinned to, or null while the member has not picked one. */
export function storedLocale(): Locale | null {
  return readCookie()
}

/** Pins the language in this browser; returns false when it is already the stored choice. */
export function writeLocale(locale: Locale): boolean {
  if (readCookie() === locale) return false
  writeCookie(locale)
  return true
}

/**
 * Pushes the expiry of the stored choice forward, so it lasts for as long as
 * the member keeps coming back and is only replaced when they pick another one.
 */
export function renewStoredLocale() {
  const locale = readCookie()
  if (locale) writeCookie(locale)
}

/**
 * Switches the interface language. The server renders the layout again with
 * the new dictionary (router.refresh keeps client state: open dialogs,
 * loaded records, scroll).
 */
export function useSetLocale() {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const setLocale = useCallback(
    (locale: Locale) => {
      if (!writeLocale(locale)) return
      startTransition(() => router.refresh())
    },
    [router],
  )
  return { setLocale, pending }
}
