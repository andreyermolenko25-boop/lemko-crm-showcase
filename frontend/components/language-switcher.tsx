"use client"

import { Globe } from "lucide-react"
import { cn } from "@/lib/utils"
import { LOCALES, LOCALE_NAMES, isLocale, type Locale } from "@/lib/i18n/config"
import { useSetLocale } from "@/lib/i18n/client"
import { useI18n } from "@/components/i18n-provider"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"

/** Compact language menu for pages without settings (sign-in, sign-up). */
export function LanguageSwitcher({ className, onChange }: { className?: string; onChange?: (locale: Locale) => void }) {
  const { t, locale } = useI18n()
  const { setLocale, pending } = useSetLocale()
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={t("language.switcherLabel")}
        className={cn(
          "inline-flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-60",
          className,
        )}
        disabled={pending}
      >
        <Globe className="size-4" />
        {LOCALE_NAMES[locale]}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-52">
        <DropdownMenuLabel className="text-xs text-muted-foreground">{t("language.switcherLabel")}</DropdownMenuLabel>
        <DropdownMenuRadioGroup
          value={locale}
          onValueChange={(v) => {
            if (!isLocale(v)) return
            setLocale(v)
            onChange?.(v)
          }}
        >
          {LOCALES.map((l) => (
            <DropdownMenuRadioItem key={l} value={l} lang={l}>
              {LOCALE_NAMES[l]}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
