"use client"

import { useMemo } from "react"
import { Check, Languages } from "lucide-react"
import { cn } from "@/lib/utils"
import { LOCALES, LOCALE_NAMES, type Locale } from "@/lib/i18n/config"
import { storedLocale } from "@/lib/i18n/client"
import { useLanguage } from "@/lib/core/language"
import { setPrefs, usePrefs } from "@/lib/core/prefs"
import { formatDate, formatMeasure, formatMoney, formatTime } from "@/lib/core/format"
import { CURRENCY_CODES, REGION_CODES, regionName, resolveFormats } from "@/lib/core/region"
import { useT } from "@/components/i18n-provider"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Segmented, SettingsRow, SettingsSection } from "@/components/settings/shared"

function LanguageOption({ label, active, lang, disabled, onClick }: { label: string; active: boolean; lang?: string; disabled?: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      lang={lang}
      aria-pressed={active}
      className={cn(
        "flex min-h-14 items-center gap-3 rounded-xl border px-3.5 py-2.5 text-left transition-colors disabled:opacity-60",
        active ? "border-brand bg-brand-soft/40" : "hover:border-border-strong hover:bg-elevated",
      )}
    >
      <span className="min-w-0 flex-1 truncate text-sm font-medium">{label}</span>
      {active && <Check className="size-4 shrink-0 text-brand" />}
    </button>
  )
}

export function LanguageSettings() {
  const t = useT()
  const { locale, change, pending } = useLanguage()
  const p = usePrefs((x) => x)
  // What "Automatic" resolves to for the region and, within the chosen region, for the currency.
  const detected = useMemo(() => resolveFormats({ ...p, region: "auto" }, locale), [p, locale])
  const regionDefault = useMemo(() => resolveFormats({ ...p, currency: "auto" }, locale), [p, locale])
  const regions = useMemo(
    () => REGION_CODES.map((c) => [c, regionName(c, locale)] as const).sort((a, b) => a[1].localeCompare(b[1], locale)),
    [locale],
  )
  // Also pins the language shown on a first visit (picked from the browser's language, not yet stored).
  const pick = (next: Locale) => (next !== locale || storedLocale() !== next) && change(next)

  return (
    <div className="flex flex-col gap-[var(--gap)]">
      <SettingsSection title={t("languageSettings.title")} description={t("languageSettings.description")}>
        <div className="grid grid-cols-1 gap-2 p-[var(--pad)] sm:grid-cols-2 lg:grid-cols-3">
          {LOCALES.map((l) => (
            <LanguageOption key={l} label={LOCALE_NAMES[l]} lang={l} active={locale === l} disabled={pending} onClick={() => pick(l)} />
          ))}
        </div>
        <div aria-live="polite">
          {pending && (
            <p className="flex items-center gap-2 px-[var(--pad)] py-3 text-xs text-muted-foreground">
              <Languages className="size-3.5 shrink-0" />
              {t("languageSettings.applying")}
            </p>
          )}
        </div>
      </SettingsSection>

      <SettingsSection title={t("languageSettings.formatsTitle")} description={t("languageSettings.formatsDescription")}>
        <SettingsRow
          label={t("languageSettings.region")}
          hint={`${t("languageSettings.regionHint")} ${t("languageSettings.example", {
            value: `${formatMoney(1234567.89)} · ${formatDate(new Date(), { day: "numeric", month: "long", year: "numeric" })} · ${formatTime(new Date())} · ${formatMeasure(12.5, "distance")}`,
          })}`}
        >
          <Select value={p.region || "auto"} onValueChange={(v) => setPrefs({ region: v })}>
            <SelectTrigger className="w-64">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="auto">{t("languageSettings.regionAuto", { region: regionName(detected.region, locale) })}</SelectItem>
              {regions.map(([code, name]) => (
                <SelectItem key={code} value={code}>
                  {name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </SettingsRow>
        <SettingsRow label={t("languageSettings.currency")}>
          <Select value={p.currency || "auto"} onValueChange={(v) => setPrefs({ currency: v })}>
            <SelectTrigger className="w-64">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="auto">{t("languageSettings.currencyAuto", { currency: regionDefault.currency })}</SelectItem>
              {CURRENCY_CODES.map((c) => (
                <SelectItem key={c} value={c}>
                  {c}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </SettingsRow>
        <SettingsRow label={t("languageSettings.timeFormat")}>
          <Segmented
            value={p.timeFormat}
            onChange={(v) => setPrefs({ timeFormat: v })}
            options={[
              { value: "auto" as const, label: t("languageSettings.automatic") },
              { value: "12h" as const, label: t("languageSettings.time12") },
              { value: "24h" as const, label: t("languageSettings.time24") },
            ]}
          />
        </SettingsRow>
        <SettingsRow label={t("languageSettings.units")}>
          <Segmented
            value={p.units}
            onChange={(v) => setPrefs({ units: v })}
            options={[
              { value: "auto" as const, label: t("languageSettings.automatic") },
              { value: "metric" as const, label: t("languageSettings.unitsMetric") },
              { value: "imperial" as const, label: t("languageSettings.unitsImperial") },
              { value: "uk" as const, label: t("languageSettings.unitsUk") },
            ]}
          />
        </SettingsRow>
        <SettingsRow label={t("languageSettings.weekStartsOn")}>
          <Segmented
            value={p.weekStartsOn}
            onChange={(v) => setPrefs({ weekStartsOn: v })}
            options={[
              { value: "auto" as const, label: t("languageSettings.automatic") },
              { value: 1 as const, label: t("languageSettings.monday") },
              { value: 0 as const, label: t("languageSettings.sunday") },
            ]}
          />
        </SettingsRow>
      </SettingsSection>
    </div>
  )
}
