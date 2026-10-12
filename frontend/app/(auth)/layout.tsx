import type React from "react"
import { AuthShowcase } from "@/components/auth-showcase"
import { LanguageSwitcher } from "@/components/language-switcher"
import { getRequestLocale, loadMessages } from "@/lib/i18n/server"
import { createTranslator } from "@/lib/i18n/translate"

export default async function AuthLayout({ children }: { children: React.ReactNode }) {
  const { locale } = await getRequestLocale()
  const { t } = createTranslator(locale, (await loadMessages(locale)).messages)
  return (
    <main className="grid min-h-dvh bg-background lg:grid-cols-[1fr_minmax(0,38rem)]">
      <section className="relative flex flex-col px-6 py-6 sm:px-10">
        <div className="flex items-center gap-2.5">
          <svg viewBox="0 0 32 32" aria-hidden className="size-9 shrink-0">
            <rect width="32" height="32" rx="9" fill="var(--foreground)" />
            <path d="M11 8.5v12.5a2.5 2.5 0 0 0 2.5 2.5H22" fill="none" stroke="var(--background)" strokeWidth="3" strokeLinecap="round" />
            <circle cx="22.5" cy="11" r="3" fill="var(--background)" />
          </svg>
          <span className="text-base font-semibold tracking-tight">{t("auth.brand")}</span>
          <LanguageSwitcher className="ml-auto" />
        </div>
        <div className="flex flex-1 items-center justify-center py-10">{children}</div>
        <p className="text-xs text-subtle-foreground">{t("auth.footer", { year: new Date().getFullYear() })}</p>
      </section>
      <AuthShowcase />
    </main>
  )
}
