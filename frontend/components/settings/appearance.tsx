"use client"

import { useId } from "react"
import Link from "next/link"
import { useTheme } from "next-themes"
import { motion } from "motion/react"
import { ArrowRight, Check, Monitor, Moon, SlidersHorizontal, Sparkles, Sun } from "lucide-react"
import { cn } from "@/lib/utils"
import { springs } from "@/lib/core/motion"
import { formatMoney } from "@/lib/core/format"
import { ADVANCED_DEFAULTS, APPEARANCE_DEFAULTS, FONTS, setPrefs, usePrefs, type FontKey, type Prefs } from "@/lib/core/prefs"
import { FONT_STACKS } from "@/lib/core/prefs-boot"
import { TextSizeSteps } from "@/components/shell/text-size-panel"
import { Switch } from "@/components/ui/switch"
import { Slider } from "@/components/ui/slider"
import { Button } from "@/components/ui/button"
import { AccentColorRow } from "@/components/settings/accent-picker"
import { Segmented, SettingsRow, SettingsSection } from "@/components/settings/shared"
import { useT } from "@/components/i18n-provider"

/* ------------------------------------------------------------------ */
/*  Essentials / Advanced                                              */
/* ------------------------------------------------------------------ */

function AppearanceTabs({ advanced }: { advanced: boolean }) {
  const t = useT()
  const tabs = [
    { href: "/settings/appearance", on: !advanced, label: t("appearance.essentials"), icon: Sparkles },
    { href: "/settings/appearance/advanced", on: advanced, label: t("appearance.advanced"), icon: SlidersHorizontal },
  ]
  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <nav aria-label={t("settings.nav.appearance")} className="inline-flex rounded-full border bg-elevated p-0.5">
        {tabs.map((tab) => (
          <Link
            key={tab.href}
            href={tab.href}
            aria-current={tab.on ? "page" : undefined}
            className={cn(
              "relative flex h-8 items-center gap-1.5 rounded-full px-3.5 text-xs font-medium outline-none transition-colors duration-200 focus-visible:ring-2 focus-visible:ring-ring",
              tab.on ? "text-foreground" : "text-muted-foreground hover:text-foreground",
            )}
          >
            {tab.on && (
              <motion.span
                layoutId="appearance-tab"
                className="absolute inset-0 rounded-full bg-card shadow-[0_1px_2px_oklch(0.2_0.01_260/8%),0_0_0_1px_var(--border)]"
                transition={springs.snappy}
              />
            )}
            <tab.icon className="relative size-3.5" />
            <span className="relative">{tab.label}</span>
          </Link>
        ))}
      </nav>
      <p className="text-xs text-muted-foreground">{advanced ? t("appearance.advancedHint") : t("appearance.essentialsHint")}</p>
    </div>
  )
}

export function AppearanceSettings({ advanced = false }: { advanced?: boolean }) {
  return (
    <div className="flex flex-col gap-6">
      <AppearanceTabs advanced={advanced} />
      <div key={advanced ? "advanced" : "essentials"} className="settings-stagger flex flex-col gap-[var(--gap)]">
        {advanced ? <AdvancedAppearance /> : <EssentialAppearance />}
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/*  Essentials                                                         */
/* ------------------------------------------------------------------ */

const MOCK = {
  light: { canvas: "#f4f4f5", panel: "#ffffff", line: "#e6e6e8", ink: "#18181b", faint: "#d4d4d8" },
  dark: { canvas: "#0e0e0f", panel: "#1a1a1b", line: "#2a2a2c", ink: "#ededee", faint: "#3a3a3d" },
}

/** A miniature of the workspace in the given theme, with the current accent. */
function ThemeMock({ mode }: { mode: "light" | "dark" }) {
  const c = MOCK[mode]
  return (
    <div className="flex h-full gap-2 p-2.5" style={{ background: c.canvas }}>
      <div className="flex w-[22%] flex-col gap-1.5 rounded-md p-1.5" style={{ background: c.panel, boxShadow: `inset 0 0 0 1px ${c.line}` }}>
        <span className="size-2.5 rounded-[3px]" style={{ background: c.ink }} />
        {[0.9, 0.7, 0.8, 0.6].map((w, i) => (
          <span key={i} className="h-1 rounded-full" style={{ width: `${w * 100}%`, background: i === 1 ? "var(--brand)" : c.faint }} />
        ))}
      </div>
      <div className="flex flex-1 flex-col gap-2">
        <span className="h-2 w-1/2 rounded-full" style={{ background: c.ink, opacity: 0.85 }} />
        <div className="grid flex-1 grid-cols-2 gap-2">
          {[0, 1].map((i) => (
            <div key={i} className="flex flex-col justify-end gap-1 rounded-md p-1.5" style={{ background: c.panel, boxShadow: `inset 0 0 0 1px ${c.line}` }}>
              {/* Bars rearrange when the card is hovered. */}
              <div className="flex h-5 items-end gap-[3px]">
                {[0.5, 0.8, 0.6, 1, 0.7].map((h, j) => (
                  <span
                    key={j}
                    className="w-1 rounded-full transition-[height] duration-500 ease-[cubic-bezier(0.22,1,0.36,1)] group-hover:[height:var(--h-hover)]"
                    style={{
                      height: `${h * 100}%`,
                      ["--h-hover" as string]: `${(1.25 - h) * 100}%`,
                      background: i === 0 && j === 3 ? "var(--brand)" : c.faint,
                      transitionDelay: `${j * 40}ms`,
                    }}
                  />
                ))}
              </div>
              <span className="h-1 w-2/3 rounded-full" style={{ background: c.faint }} />
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

function ThemeCard({ mode, active, auto, onSelect }: { mode: "light" | "dark"; active: boolean; auto: boolean; onSelect: () => void }) {
  const t = useT()
  const Ico = mode === "light" ? Sun : Moon
  return (
    <button
      type="button"
      role="radio"
      aria-checked={active}
      onClick={onSelect}
      className="group relative flex flex-col gap-2.5 rounded-2xl p-1.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      {active && (
        <motion.span
          layoutId="theme-card-ring"
          className="pointer-events-none absolute inset-0 rounded-2xl shadow-[0_0_0_1.5px_var(--foreground)]"
          transition={springs.snappy}
        />
      )}
      <div className="aspect-[16/10] overflow-hidden rounded-xl border transition-[transform,box-shadow] duration-500 ease-[cubic-bezier(0.22,1,0.36,1)] group-hover:-translate-y-0.5 group-hover:shadow-[0_12px_28px_-14px_oklch(0.2_0.01_260/35%)]">
        <ThemeMock mode={mode} />
      </div>
      <span className="flex items-center gap-2 px-1.5 pb-1 text-sm font-medium">
        <Ico className="size-4 transition-transform duration-500 ease-[cubic-bezier(0.22,1,0.36,1)] group-hover:rotate-[24deg]" />
        {t(`appearance.${mode}`)}
        {auto && <span className="rounded-full border px-1.5 text-2xs font-medium text-muted-foreground">{t("appearance.auto")}</span>}
        {active && <Check className="ml-auto size-4" />}
      </span>
    </button>
  )
}

function EssentialAppearance() {
  const { theme, resolvedTheme, setTheme } = useTheme()
  const p = usePrefs((x) => x)
  const t = useT()
  const followsSystem = theme === "system"
  const shown = followsSystem ? resolvedTheme : theme
  return (
    <>
      <SettingsSection title={t("appearance.themeTitle")} description={t("appearance.themeDescription")}>
        <div role="radiogroup" aria-label={t("appearance.themeTitle")} className="grid grid-cols-2 gap-3 p-[var(--pad)]">
          {(["light", "dark"] as const).map((mode) => (
            <ThemeCard key={mode} mode={mode} active={shown === mode} auto={followsSystem && shown === mode} onSelect={() => setTheme(mode)} />
          ))}
        </div>
        {followsSystem && (
          <p className="flex items-center gap-2 px-[var(--pad)] py-3 text-xs text-muted-foreground">
            <Monitor className="size-3.5 shrink-0" />
            {t("appearance.followingSystem")}
            <Link href="/settings/appearance/advanced" className="ml-auto shrink-0 font-medium text-foreground underline-offset-4 hover:underline">
              {t("appearance.advanced")}
            </Link>
          </p>
        )}
      </SettingsSection>

      <SettingsSection title={t("appearance.colorTitle")} description={t("appearance.colorDescription")}>
        <AccentColorRow />
      </SettingsSection>

      <SettingsSection title={t("appearance.layoutTitle")} description={t("appearance.layoutDescription")}>
        <SettingsRow label={t("appearance.density")} hint={t("appearance.densityHint")}>
          <Segmented
            label={t("appearance.density")}
            value={p.density}
            onChange={(v) => setPrefs({ density: v })}
            options={[
              { value: "compact", label: t("appearance.compact") },
              { value: "comfortable", label: t("appearance.comfortable") },
              { value: "spacious", label: t("appearance.spacious") },
            ]}
          />
        </SettingsRow>
        <SettingsRow label={t("appearance.textSize")} hint={t("appearance.textSizeHint", { size: p.textSize })}>
          <TextSizeSteps className="w-full sm:w-[340px]" />
        </SettingsRow>
        <SettingsRow label={t("appearance.sidebarStyle")} hint={t("appearance.sidebarStyleHint")}>
          <Segmented
            label={t("appearance.sidebarStyle")}
            value={p.sidebarStyle}
            onChange={(v) => setPrefs({ sidebarStyle: v })}
            options={[
              { value: "pills", label: t("appearance.pills") },
              { value: "plain", label: t("appearance.plain") },
            ]}
          />
        </SettingsRow>
        <SettingsRow label={t("appearance.collapseSidebar")} hint={t("appearance.collapseSidebarHint")}>
          <Switch checked={p.sidebarCollapsed} onCheckedChange={(v) => setPrefs({ sidebarCollapsed: v })} aria-label={t("appearance.collapseSidebar")} />
        </SettingsRow>
        <SettingsRow label={t("appearance.greeting")}>
          <Switch checked={p.showGreeting} onCheckedChange={(v) => setPrefs({ showGreeting: v })} aria-label={t("appearance.greeting")} />
        </SettingsRow>
      </SettingsSection>

      <SettingsSection title={t("appearance.accessibility")}>
        <SettingsRow label={t("appearance.highContrast")}>
          <Switch checked={p.contrast === "high"} onCheckedChange={(v) => setPrefs({ contrast: v ? "high" : "normal" })} aria-label={t("appearance.highContrast")} />
        </SettingsRow>
        <SettingsRow label={t("appearance.reduceMotion")} hint={t("appearance.reduceMotionHint")}>
          <Switch checked={p.reduceMotion} onCheckedChange={(v) => setPrefs({ reduceMotion: v })} aria-label={t("appearance.reduceMotion")} />
        </SettingsRow>
      </SettingsSection>

      <div className="flex flex-wrap items-center justify-between gap-3 px-1">
        <p className="text-sm text-muted-foreground">
          {t("appearance.languageNote")}{" "}
          <Link href="/settings/language" className="font-medium text-foreground underline-offset-4 hover:underline">
            {t("settings.nav.language")}
          </Link>
        </p>
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="sm" onClick={() => setPrefs(APPEARANCE_DEFAULTS)}>
            {t("appearance.reset")}
          </Button>
          <Button variant="outline" size="sm" asChild>
            <Link href="/settings/appearance/advanced">
              {t("appearance.openAdvanced")} <ArrowRight />
            </Link>
          </Button>
        </div>
      </div>
    </>
  )
}

/* ------------------------------------------------------------------ */
/*  Advanced                                                           */
/* ------------------------------------------------------------------ */

/** Typeface tiles: each shows "Aa" in its own font; the ink ring glides to the choice. */
function FontPicker({
  value,
  onChange,
  withSame,
  label,
}: {
  value: FontKey | "same"
  onChange: (v: FontKey | "same") => void
  withSame?: boolean
  label: string
}) {
  const t = useT()
  const ring = useId()
  const options: (FontKey | "same")[] = withSame ? ["same", ...FONTS] : FONTS
  return (
    <div role="radiogroup" aria-label={label} className="grid grid-cols-2 gap-2 sm:grid-cols-4">
      {options.map((f) => {
        const on = value === f
        return (
          <button
            key={f}
            type="button"
            role="radio"
            aria-checked={on}
            onClick={() => onChange(f)}
            className={cn(
              "relative flex h-[4.75rem] flex-col justify-between rounded-xl border bg-card p-2.5 text-left outline-none transition-[border-color,transform] duration-300 hover:-translate-y-0.5 hover:border-border-strong focus-visible:ring-2 focus-visible:ring-ring",
              on && "border-transparent",
            )}
          >
            {on && (
              <motion.span layoutId={ring} className="pointer-events-none absolute -inset-px rounded-xl shadow-[0_0_0_1.5px_var(--foreground)]" transition={springs.snappy} />
            )}
            <span aria-hidden className="text-2xl font-semibold leading-none tracking-tight" style={{ fontFamily: f === "same" ? "var(--font-body)" : FONT_STACKS[f] }}>
              Aa
            </span>
            <span className="flex items-center justify-between gap-1 text-2xs font-medium text-muted-foreground">
              <span className="truncate">{t(`appearance.fonts.${f}`)}</span>
              {on && <Check className="size-3 shrink-0 text-foreground" />}
            </span>
          </button>
        )
      })}
    </div>
  )
}

/** Live sample of the current typography: eyebrow, heading, body, figures, button and badge. */
function TypePreview() {
  const t = useT()
  const rows: [string, number][] = [
    ["Northwind", 11111],
    ["Globex", 88480],
    ["Initech", 40710],
  ]
  return (
    <div className="m-[var(--pad)] grid gap-5 rounded-xl border bg-background p-5 sm:grid-cols-[minmax(0,1fr)_12rem]">
      <div className="min-w-0">
        <p className="text-2xs font-medium uppercase tracking-[0.12em] text-subtle-foreground">{t("appearance.previewEyebrow")}</p>
        <h3 className="mt-2 text-xl font-semibold tracking-tight">{t("appearance.previewHeading")}</h3>
        <p className="mt-1.5 text-pretty text-sm text-muted-foreground">{t("appearance.previewBody")}</p>
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <span className="inline-flex h-8 items-center rounded-lg bg-brand px-3 text-xs font-semibold text-brand-foreground">{t("appearance.previewButton")}</span>
          <span className="inline-flex h-6 items-center rounded-md bg-brand-soft px-2 text-xs font-medium text-brand-soft-foreground">{t("appearance.previewBadge")}</span>
        </div>
      </div>
      <ul className="flex flex-col divide-y self-center rounded-lg border bg-card text-xs">
        {rows.map(([name, value]) => (
          <li key={name} className="flex items-center justify-between gap-3 px-3 py-2">
            <span className="truncate text-muted-foreground">{name}</span>
            <span className="font-medium">{formatMoney(value)}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}

function RadiusRow() {
  const t = useT()
  const radius = usePrefs((p) => p.radius)
  return (
    <SettingsRow label={t("appearance.radius")} hint={`${radius.toFixed(2)} rem`}>
      <div className="flex w-full items-center gap-4 sm:w-72">
        <Slider min={0} max={1.25} step={0.125} value={[radius]} onValueChange={([v]) => setPrefs({ radius: v })} aria-label={t("appearance.radius")} />
        <span
          aria-hidden
          className="size-9 shrink-0 border-2 border-foreground/50 bg-brand-soft transition-[border-radius] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)]"
          style={{ borderRadius: `${radius * 1.1}rem` }}
        />
      </div>
    </SettingsRow>
  )
}

function AdvancedAppearance() {
  const { theme, setTheme } = useTheme()
  const p = usePrefs((x) => x)
  const t = useT()
  const set =
    <K extends keyof Prefs>(key: K) =>
    (v: Prefs[K]) =>
      setPrefs({ [key]: v } as Partial<Prefs>)
  return (
    <>
      <SettingsSection title={t("appearance.themeBehaviour")} description={t("appearance.themeBehaviourDescription")}>
        <SettingsRow label={t("appearance.themeMode")} hint={theme === "system" ? t("appearance.followingSystem") : t("appearance.themeModeHint")}>
          <Segmented
            label={t("appearance.themeMode")}
            value={(theme ?? "dark") as "light" | "dark" | "system"}
            onChange={(v) => setTheme(v)}
            options={[
              { value: "light", label: <><Sun className="size-3.5" /> {t("appearance.light")}</> },
              { value: "dark", label: <><Moon className="size-3.5" /> {t("appearance.dark")}</> },
              { value: "system", label: <><Monitor className="size-3.5" /> {t("appearance.system")}</> },
            ]}
          />
        </SettingsRow>
      </SettingsSection>

      <SettingsSection title={t("appearance.typographyTitle")} description={t("appearance.typographyDescription")}>
        <TypePreview />
        <SettingsRow stack label={t("appearance.bodyFont")} hint={t("appearance.bodyFontHint")}>
          <FontPicker label={t("appearance.bodyFont")} value={p.fontBody} onChange={(v) => v !== "same" && setPrefs({ fontBody: v })} />
        </SettingsRow>
        <SettingsRow stack label={t("appearance.headingFont")} hint={t("appearance.headingFontHint")}>
          <FontPicker withSame label={t("appearance.headingFont")} value={p.fontHeading} onChange={set("fontHeading")} />
        </SettingsRow>
        <SettingsRow label={t("appearance.textSize")} hint={t("appearance.textSizeHint", { size: p.textSize })}>
          <TextSizeSteps className="w-full sm:w-[340px]" />
        </SettingsRow>
        <SettingsRow label={t("appearance.weight")} hint={t("appearance.weightHint")}>
          <Segmented
            label={t("appearance.weight")}
            value={p.weight}
            onChange={set("weight")}
            options={[
              { value: "light", label: t("appearance.weights.light") },
              { value: "regular", label: t("appearance.weights.regular") },
              { value: "bold", label: t("appearance.weights.bold") },
            ]}
          />
        </SettingsRow>
        <SettingsRow label={t("appearance.lineHeight")} hint={t("appearance.lineHeightHint")}>
          <Segmented
            label={t("appearance.lineHeight")}
            value={p.lineHeight}
            onChange={set("lineHeight")}
            options={[
              { value: "tight", label: t("appearance.lineHeights.tight") },
              { value: "normal", label: t("appearance.lineHeights.normal") },
              { value: "relaxed", label: t("appearance.lineHeights.relaxed") },
            ]}
          />
        </SettingsRow>
        <SettingsRow label={t("appearance.letterSpacing")} hint={t("appearance.letterSpacingHint")}>
          <Segmented
            label={t("appearance.letterSpacing")}
            value={p.letterSpacing}
            onChange={set("letterSpacing")}
            options={[
              { value: "tight", label: t("appearance.letterSpacings.tight") },
              { value: "normal", label: t("appearance.letterSpacings.normal") },
              { value: "wide", label: t("appearance.letterSpacings.wide") },
            ]}
          />
        </SettingsRow>
        <SettingsRow label={t("appearance.tabularNumbers")} hint={t("appearance.tabularNumbersHint")}>
          <Switch checked={p.tabularNumbers} onCheckedChange={set("tabularNumbers")} aria-label={t("appearance.tabularNumbers")} />
        </SettingsRow>
      </SettingsSection>

      <SettingsSection title={t("appearance.stylingTitle")} description={t("appearance.stylingDescription")}>
        <RadiusRow />
        <SettingsRow label={t("appearance.shadows")} hint={t("appearance.shadowsHint")}>
          <Segmented
            label={t("appearance.shadows")}
            value={p.shadows}
            onChange={set("shadows")}
            options={[
              { value: "flat", label: t("appearance.shadowLevels.flat") },
              { value: "soft", label: t("appearance.shadowLevels.soft") },
              { value: "lifted", label: t("appearance.shadowLevels.lifted") },
            ]}
          />
        </SettingsRow>
        <SettingsRow label={t("appearance.borders")} hint={t("appearance.bordersHint")}>
          <Segmented
            label={t("appearance.borders")}
            value={p.borders}
            onChange={set("borders")}
            options={[
              { value: "subtle", label: t("appearance.borderLevels.subtle") },
              { value: "normal", label: t("appearance.borderLevels.normal") },
              { value: "strong", label: t("appearance.borderLevels.strong") },
            ]}
          />
        </SettingsRow>
        <SettingsRow label={t("appearance.canvas")} hint={t("appearance.canvasHint")}>
          <Segmented
            label={t("appearance.canvas")}
            value={p.canvas}
            onChange={set("canvas")}
            options={[
              { value: "plain", label: t("appearance.canvasOptions.plain") },
              { value: "soft", label: t("appearance.canvasOptions.soft") },
              { value: "tinted", label: t("appearance.canvasOptions.tinted") },
            ]}
          />
        </SettingsRow>
        <SettingsRow label={t("appearance.iconStroke")} hint={t("appearance.iconStrokeHint")}>
          <Segmented
            label={t("appearance.iconStroke")}
            value={p.iconStroke}
            onChange={set("iconStroke")}
            options={[
              { value: "thin", label: t("appearance.iconStrokes.thin") },
              { value: "regular", label: t("appearance.iconStrokes.regular") },
              { value: "bold", label: t("appearance.iconStrokes.bold") },
            ]}
          />
        </SettingsRow>
      </SettingsSection>

      <div className="flex flex-wrap items-center justify-between gap-3 px-1">
        <p className="text-sm text-muted-foreground">{t("appearance.advancedFooter")}</p>
        <Button variant="outline" size="sm" onClick={() => setPrefs(ADVANCED_DEFAULTS)}>
          {t("appearance.resetAdvanced")}
        </Button>
      </div>
    </>
  )
}
