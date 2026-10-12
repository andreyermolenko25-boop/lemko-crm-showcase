"use client"

import { useEffect, useRef, type ReactNode } from "react"
import { useTheme } from "next-themes"
import { TooltipProvider } from "@/components/ui/tooltip"
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet"
import { Button } from "@/components/ui/button"
import { membersApi } from "@/lib/core/backend"
import { applyPrefsToDocument, prefsStore } from "@/lib/core/prefs"
import { bootWorkspace, sessionStore, useSession } from "@/lib/core/session"
import { ui, useUi } from "@/lib/core/ui"
import { Sidebar, SidebarContent } from "@/components/shell/sidebar"
import { Topbar } from "@/components/shell/topbar"
import { CommandPalette } from "@/components/shell/command-palette"
import { CreateRecordDialog } from "@/components/crm/record-form"
import { RecordPeek } from "@/components/crm/record-peek"
import { useT } from "@/components/i18n-provider"
import { useLanguageSync } from "@/lib/core/language"

function useSyncPrefs() {
  useEffect(() => {
    applyPrefsToDocument(prefsStore.get())
    return prefsStore.subscribe(() => applyPrefsToDocument(prefsStore.get()))
  }, [])
}

/** The member's theme lives in their preferences on the server, like the rest of Appearance. */
function useThemeSync(ready: boolean) {
  const { theme, setTheme } = useTheme()
  const applied = useRef(false)
  useEffect(() => {
    if (!ready || applied.current) return
    applied.current = true
    const saved = sessionStore.get().preferences.theme
    if (typeof saved === "string" && saved !== theme) setTheme(saved)
  }, [ready, theme, setTheme])
  useEffect(() => {
    if (!ready || !applied.current || !theme) return
    if (sessionStore.get().preferences.theme === theme) return
    sessionStore.set((s) => ({ ...s, preferences: { ...s.preferences, theme } }))
    membersApi.updateMe({ preferences: { theme } }).catch(() => undefined)
  }, [ready, theme])
}

function MobileNav() {
  const open = useUi((s) => s.mobileNavOpen)
  const t = useT()
  return (
    <Sheet open={open} onOpenChange={(o) => ui.openMobileNav(o)}>
      <SheetContent side="left" className="w-[17rem] bg-sidebar p-0">
        <SheetTitle className="sr-only">{t("shell.navigation")}</SheetTitle>
        <SheetDescription className="sr-only">{t("shell.mainNavigation")}</SheetDescription>
        <SidebarContent onNavigate={() => ui.openMobileNav(false)} />
      </SheetContent>
    </Sheet>
  )
}

function BootScreen() {
  const status = useSession((s) => s.status)
  const error = useSession((s) => s.error)
  const t = useT()
  if (status === "error") {
    return (
      <div className="flex min-h-dvh flex-col items-center justify-center gap-3 bg-background p-6 text-center">
        <p className="text-sm font-semibold">{t("shell.loadFailed")}</p>
        <p className="max-w-md text-xs text-muted-foreground">{error}</p>
        <Button size="sm" variant="outline" onClick={() => void bootWorkspace()}>
          {t("common.retry")}
        </Button>
      </div>
    )
  }
  return (
    <div className="flex min-h-dvh items-center justify-center bg-background">
      <span className="size-5 animate-spin rounded-full border-2 border-border border-t-foreground" aria-label={t("common.loading")} />
    </div>
  )
}

export function AppShell({ children }: { children: ReactNode }) {
  const ready = useSession((s) => s.status) === "ready"
  useSyncPrefs()
  useThemeSync(ready)
  useLanguageSync(ready)
  useEffect(() => {
    void bootWorkspace()
  }, [])
  if (!ready) return <BootScreen />
  return (
    <TooltipProvider delayDuration={300}>
      <div className="flex min-h-dvh bg-background">
        <Sidebar />
        <div className="flex min-w-0 flex-1 flex-col">
          <Topbar />
          <main className="flex-1 px-4 py-5 sm:px-[1.125rem] lg:py-6">{children}</main>
        </div>
      </div>
      <MobileNav />
      <CommandPalette />
      <CreateRecordDialog />
      <RecordPeek />
    </TooltipProvider>
  )
}
