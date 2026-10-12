"use client"

import { useEffect, useState, type ReactNode } from "react"
import { useRouter } from "next/navigation"
import { clearSession, fetchMe, hasTabSession, logout, refreshSession } from "@/lib/auth"
import { MfaEnrollmentGate } from "@/components/settings/security"
import { resetSession } from "@/lib/core/session"
import { useT } from "@/components/i18n-provider"

const REFRESH_INTERVAL_MS = 10 * 60 * 1000

/**
 * Session bound to the browser tab + silent refresh.
 *
 * sessionStorage.tab_session survives F5 but not closing the tab. If the cookie
 * is still alive (the browser restored it) but the marker is gone — sign out and
 * go to /login. While the tab is open, POST /api/refresh every 10 minutes.
 */
export function AuthProvider({ children }: { children: ReactNode }) {
  const router = useRouter()
  const [ready, setReady] = useState(false)
  const [enroll, setEnroll] = useState(false)
  const t = useT()

  useEffect(() => {
    let cancelled = false
    let timer: number | undefined

    async function boot() {
      if (!hasTabSession()) {
        try {
          await fetch("/api/logout", { method: "POST", credentials: "same-origin" })
        } catch {
          // ignore
        }
        clearSession()
        if (!cancelled) router.replace("/login")
        return
      }

      const ok = await refreshSession()
      if (cancelled) return
      if (!ok) {
        clearSession()
        router.replace("/login")
        return
      }

      // Workspace policy "2FA for everyone": set it up before the app opens.
      try {
        const me = await fetchMe()
        if (cancelled) return
        if (me.mfa_enrollment_required) setEnroll(true)
      } catch {
        // The app's own boot reports API problems.
      }
      setReady(true)
      timer = window.setInterval(() => {
        void refreshSession().then((alive) => {
          if (!alive) {
            clearSession()
            resetSession()
            router.replace("/login")
          }
        })
      }, REFRESH_INTERVAL_MS)
    }

    void boot()

    return () => {
      cancelled = true
      if (timer) window.clearInterval(timer)
    }
  }, [router])

  if (!ready) {
    return (
      <div className="flex min-h-dvh items-center justify-center bg-background">
        <span className="size-5 animate-spin rounded-full border-2 border-border border-t-foreground" aria-label={t("common.loading")} />
      </div>
    )
  }

  if (enroll) return <MfaEnrollmentGate onDone={() => setEnroll(false)} />

  return <>{children}</>
}

/** Explicit sign-out from the UI. */
export async function signOut(router: { replace: (href: string) => void }) {
  await logout()
  resetSession()
  router.replace("/login")
}
