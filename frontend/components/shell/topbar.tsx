"use client"

import { useEffect, useRef, useState } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { useTheme } from "next-themes"
import { AnimatePresence, motion, useReducedMotion } from "motion/react"
import {
  Bell,
  CalendarDays,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Languages,
  LogOut,
  Menu,
  MessageSquare,
  Moon,
  Palette,
  Plus,
  Search,
  Sun,
  Type,
  User,
} from "lucide-react"
import { cn } from "@/lib/utils"
import { duration, easing, springs } from "@/lib/core/motion"
import { usePrefs } from "@/lib/core/prefs"
import { useData, dataActions, memberById, useMe } from "@/lib/core/data"
import { monthNames, timeAgo } from "@/lib/core/format"
import { ui, useUi } from "@/lib/core/ui"
import { useEntities } from "@/lib/core/workspace"
import { Icon } from "@/lib/core/icons"
import { signOut } from "@/components/auth-provider"
import { Button } from "@/components/ui/button"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Kbd, Monogram } from "@/components/crm/primitives"
import { ActivityIcon } from "@/components/crm/activity-icon"
import { useT } from "@/components/i18n-provider"
import { joinActivityText, useActivityText } from "@/lib/core/activity-text"
import { useLanguage } from "@/lib/core/language"
import { LOCALES, LOCALE_NAMES, isLocale } from "@/lib/i18n/config"
import { TextSizePanel } from "@/components/shell/text-size-panel"

function IconButton({ children, label, className, ...rest }: React.ComponentProps<"button"> & { label: string }) {
  return (
    <button
      aria-label={label}
      className={cn(
        "relative flex size-9 items-center justify-center rounded-[10px] border border-border bg-card text-muted-foreground transition-colors hover:border-border-strong hover:text-foreground",
        className,
      )}
      {...rest}
    >
      {children}
    </button>
  )
}

/** The member asked for less motion, or the OS did. */
function useCalm() {
  const pref = usePrefs((p) => p.reduceMotion)
  const os = useReducedMotion()
  return pref || !!os
}

/** Remembers which way the period last moved: 1 forward in time, -1 back. */
function useDirection(index: number) {
  const last = useRef(index)
  const dir = useRef(1)
  if (index !== last.current) {
    dir.current = index > last.current ? 1 : -1
    last.current = index
  }
  return dir.current
}

/** Text that rolls up (forward) or down (back) when it changes, with a soft blur. */
function Roll({ id, dir, children, className }: { id: string | number; dir: number; children: React.ReactNode; className?: string }) {
  const calm = useCalm()
  return (
    <span className={cn("relative inline-grid overflow-hidden", className)}>
      <AnimatePresence initial={false} custom={dir} mode="popLayout">
        <motion.span
          key={id}
          custom={dir}
          variants={{
            enter: (d: number) => ({ y: calm ? 0 : `${d * 70}%`, opacity: 0, filter: calm ? "none" : "blur(3px)" }),
            center: { y: 0, opacity: 1, filter: "blur(0px)" },
            exit: (d: number) => ({ y: calm ? 0 : `${d * -70}%`, opacity: 0, filter: calm ? "none" : "blur(3px)" }),
          }}
          initial="enter"
          animate="center"
          exit="exit"
          transition={calm ? { duration: 0 } : { duration: duration.normal, ease: easing.smooth }}
          className="whitespace-nowrap"
        >
          {children}
        </motion.span>
      </AnimatePresence>
    </span>
  )
}

/**
 * The calendar glyph of the period button: its page flips down when the
 * period changes or the button is hovered; a dot marks the current month.
 */
function CalendarGlyph({ flip, current }: { flip: number; current: boolean }) {
  const calm = useCalm()
  return (
    <span className="relative flex size-4 items-center justify-center [perspective:120px]">
      <motion.span
        key={flip}
        className="flex text-muted-foreground"
        style={{ originY: 0.12 }}
        initial={calm || flip === 0 ? false : { rotateX: -110, opacity: 0.2 }}
        animate={{ rotateX: 0, opacity: 1 }}
        transition={{ type: "spring", stiffness: 320, damping: 16, mass: 0.7 }}
      >
        <CalendarDays className="size-4" />
      </motion.span>
      <AnimatePresence>
        {current && (
          <motion.span
            initial={{ scale: 0 }}
            animate={{ scale: 1 }}
            exit={{ scale: 0 }}
            transition={springs.snappy}
            className="absolute -right-0.5 -top-0.5 size-1.5 rounded-full bg-brand ring-2 ring-card"
          />
        )}
      </AnimatePresence>
    </span>
  )
}

function PeriodPicker() {
  const period = useUi((s) => s.period)
  const t = useT()
  const months = monthNames("long")
  const shortMonths = monthNames("short")
  const index = period.year * 12 + period.month
  const dir = useDirection(index)
  const [flip, setFlip] = useState(0)
  const mounted = useRef(false)
  const now = new Date()
  const isCurrent = period.year === now.getFullYear() && period.month === now.getMonth()
  // The page flips on every change of period (not on the first render).
  useEffect(() => {
    if (mounted.current) setFlip((n) => n + 1)
    mounted.current = true
  }, [index])
  const step = (d: number) => {
    const m = period.month + d
    ui.setPeriod(period.year + Math.floor(m / 12), ((m % 12) + 12) % 12)
  }
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          onMouseEnter={() => setFlip((n) => n + 1)}
          className="group hidden h-9 items-center gap-2 rounded-[10px] border border-border bg-card px-3 text-sm font-semibold transition-colors hover:border-border-strong data-[state=open]:border-border-strong md:flex"
        >
          <CalendarGlyph flip={flip} current={isCurrent} />
          <Roll id={index} dir={dir} className="tabular">
            {months[period.month]} {period.year}
          </Roll>
          <ChevronDown className="size-3.5 text-muted-foreground transition-transform duration-300 group-data-[state=open]:rotate-180" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72 p-3">
        <div className="mb-3 flex items-center justify-between">
          <Button variant="ghost" size="icon-xs" onClick={() => ui.setPeriod(period.year - 1, period.month)} aria-label={t("common.previous")}>
            <ChevronLeft />
          </Button>
          <Roll id={period.year} dir={dir} className="text-sm font-semibold tabular">
            {period.year}
          </Roll>
          <Button variant="ghost" size="icon-xs" onClick={() => ui.setPeriod(period.year + 1, period.month)} aria-label={t("common.next")}>
            <ChevronRight />
          </Button>
        </div>
        <div className="grid grid-cols-3 gap-1.5">
          {shortMonths.map((m, i) => {
            const on = i === period.month
            const today = period.year === now.getFullYear() && i === now.getMonth()
            return (
              <button
                key={m}
                onClick={() => ui.setPeriod(period.year, i)}
                className={cn("relative h-8 rounded-lg text-sm font-medium transition-colors duration-200", on ? "text-primary-foreground" : "hover:bg-accent")}
              >
                {/* The selection glides between months. */}
                {on && <motion.span layoutId="period-month" className="absolute inset-0 rounded-lg bg-primary" transition={springs.snappy} />}
                <span className="relative">{m}</span>
                {today && <span className={cn("absolute bottom-1 left-1/2 size-1 -translate-x-1/2 rounded-full", on ? "bg-primary-foreground" : "bg-brand")} />}
              </button>
            )
          })}
        </div>
        <div className="mt-3 flex justify-between border-t pt-3">
          <Button variant="ghost" size="xs" onClick={() => step(-1)}>
            <ChevronLeft /> {t("common.previous")}
          </Button>
          <Button
            variant="outline"
            size="xs"
            onClick={() => {
              const n = new Date()
              ui.setPeriod(n.getFullYear(), n.getMonth())
            }}
          >
            {t("shell.thisMonth")}
          </Button>
          <Button variant="ghost" size="xs" onClick={() => step(1)}>
            {t("common.next")} <ChevronRight />
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  )
}

function NotificationsButton() {
  const activities = useData((s) => s.activities)
  const unread = useData((s) => s.unread)
  const recent = activities.slice(0, 7)
  const t = useT()
  const describe = useActivityText()
  return (
    <Popover>
      <PopoverTrigger asChild>
        <IconButton label={t("shell.notifications")} className={unread ? "text-brand hover:text-brand" : undefined}>
          <Bell className="size-4" />
          {unread > 0 && <span className="absolute right-2 top-2 size-1.5 rounded-full bg-brand ring-2 ring-card" />}
        </IconButton>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[22rem] p-0">
        <div className="flex items-center justify-between border-b px-4 py-3">
          <div>
            <p className="text-sm font-semibold">{t("shell.notifications")}</p>
            <p className="text-xs text-muted-foreground">{t("shell.unread", { count: unread })}</p>
          </div>
          <Button variant="ghost" size="xs" onClick={() => dataActions.markAllRead()}>
            {t("shell.markAllRead")}
          </Button>
        </div>
        <ul className="max-h-96 overflow-y-auto p-1.5">
          {recent.length === 0 && <li className="py-8 text-center text-sm text-muted-foreground">{t("shell.nothingNew")}</li>}
          {recent.map((a) => (
            <li key={a.id}>
              <Link
                href={`/o/${a.entity}/${a.recordId}`}
                onClick={() => dataActions.markRead(a.id)}
                className="flex gap-3 rounded-lg p-2.5 transition-colors hover:bg-accent"
              >
                <ActivityIcon kind={a.kind} />
                <div className="min-w-0 flex-1">
                  <p className="line-clamp-2 text-sm font-medium">{joinActivityText(describe(a))}</p>
                  <p className="text-xs text-muted-foreground">
                    {memberById(a.actor)?.name ?? t("common.system")} · {timeAgo(a.at)}
                  </p>
                </div>
                {!a.read && <span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-brand" />}
              </Link>
            </li>
          ))}
        </ul>
        <div className="border-t p-1.5">
          <Button asChild variant="ghost" size="sm" className="w-full">
            <Link href="/inbox">{t("shell.openInbox")}</Link>
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  )
}

function QuickCreate() {
  const entities = useEntities()
  const t = useT()
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <IconButton label={t("shell.create")} className="hidden sm:flex">
          <Plus className="size-4" />
        </IconButton>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuLabel className="text-xs text-muted-foreground">{t("shell.createNew")}</DropdownMenuLabel>
        {entities.map((e) => (
          <DropdownMenuItem key={e.key} onSelect={() => ui.openCreate(e.key)}>
            <Icon name={e.icon} /> {e.labelSingular}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function UserMenu() {
  const router = useRouter()
  const { theme, resolvedTheme, setTheme } = useTheme()
  const shownTheme = theme === "system" ? resolvedTheme : theme
  const me = useMe()
  const t = useT()
  const language = useLanguage()
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button className="flex h-9 items-center gap-2.5 rounded-[10px] border border-border bg-card pl-1 pr-2 transition-colors hover:border-border-strong sm:pr-2.5">
          <Monogram name={me?.name} size="sm" className="size-7 rounded-lg" square />
          <span className="hidden max-w-40 text-left sm:block">
            <span className="block truncate text-sm/5 font-semibold">{me?.name}</span>
            <span className="block truncate text-xs/4 text-muted-foreground">{me?.title}</span>
          </span>
          <ChevronDown className="hidden size-3.5 text-muted-foreground sm:block" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64">
        <DropdownMenuLabel>
          <p className="text-sm font-semibold">{me?.name}</p>
          <p className="text-xs font-normal text-muted-foreground">{me?.email}</p>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => router.push("/settings/profile")}>
          <User /> {t("shell.profile")}
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => router.push("/settings/appearance")}>
          <Palette /> {t("shell.appearance")}
        </DropdownMenuItem>
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>
            <Languages /> {t("shell.language")}
            <span className="ml-auto pl-2 text-xs text-muted-foreground">{LOCALE_NAMES[language.locale]}</span>
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent className="w-48">
            <DropdownMenuRadioGroup value={language.locale} onValueChange={(v) => isLocale(v) && language.change(v)}>
              {LOCALES.map((l) => (
                <DropdownMenuRadioItem key={l} value={l} lang={l}>
                  {LOCALE_NAMES[l]}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        <DropdownMenuSeparator />
        {/* Light or dark; following the system lives in Appearance → Advanced. */}
        <div role="radiogroup" aria-label={t("appearance.themeTitle")} className="m-1 grid grid-cols-2 rounded-lg bg-muted/70 p-0.5">
          {(
            [
              ["light", Sun],
              ["dark", Moon],
            ] as const
          ).map(([mode, I]) => {
            const on = shownTheme === mode
            return (
              <button
                key={mode}
                type="button"
                role="radio"
                aria-checked={on}
                onClick={() => setTheme(mode)}
                className={cn(
                  "relative flex h-8 items-center justify-center gap-1.5 rounded-md text-sm transition-colors duration-200",
                  on ? "font-medium text-foreground" : "text-muted-foreground hover:text-foreground",
                )}
              >
                {on && (
                  <motion.span
                    layoutId="menu-theme-pill"
                    className="absolute inset-0 rounded-md bg-card shadow-[0_1px_2px_oklch(0.2_0.01_260/8%),0_0_0_1px_var(--border)]"
                    transition={springs.snappy}
                  />
                )}
                <motion.span
                  className="relative flex"
                  initial={false}
                  animate={{ rotate: on ? 0 : mode === "light" ? -45 : 30, scale: on ? 1 : 0.88 }}
                  transition={springs.snappy}
                >
                  <I className="size-3.5" />
                </motion.span>
                <span className="relative">{t(`shell.themes.${mode}`)}</span>
              </button>
            )
          })}
        </div>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          variant="destructive"
          onSelect={() => void signOut(router)}
        >
          <LogOut /> {t("shell.signOut")}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

export function ThemeToggle() {
  const { resolvedTheme, setTheme } = useTheme()
  const t = useT()
  return (
    <IconButton label={t("shell.toggleTheme")} onClick={() => setTheme(resolvedTheme === "dark" ? "light" : "dark")} className="hidden sm:flex">
      <Sun className="size-4 dark:hidden" />
      <Moon className="hidden size-4 dark:block" />
    </IconButton>
  )
}

/** One click to a mini panel for the interface text size; the choice applies live and is remembered. */
function TextSizeButton() {
  const t = useT()
  return (
    <Popover>
      <PopoverTrigger asChild>
        <IconButton label={t("textSize.label")} className="hidden sm:flex">
          <Type className="size-4" />
        </IconButton>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[372px] max-w-[calc(100vw-16px)] p-[14px]">
        <TextSizePanel />
      </PopoverContent>
    </Popover>
  )
}

export function Topbar() {
  const t = useT()
  return (
    <header className="sticky top-0 z-30 border-b border-border bg-background/85 backdrop-blur-md">
      <div className="flex h-[3.75rem] items-center gap-2 px-4 sm:gap-2.5 lg:px-[1.125rem]">
        <IconButton label={t("shell.openNavigation")} className="lg:hidden" onClick={() => ui.openMobileNav(true)}>
          <Menu className="size-4" />
        </IconButton>
        <button
          onClick={() => ui.openCommand(true)}
          className="flex h-9 min-w-0 flex-1 items-center gap-2.5 rounded-[10px] border border-border bg-card px-3 text-left text-sm text-muted-foreground transition-colors hover:border-border-strong md:max-w-[28rem]"
        >
          <Search className="size-4 shrink-0" />
          <span className="flex-1 truncate">{t("shell.searchPlaceholder")}</span>
          <span className="hidden items-center gap-0.5 sm:flex">
            <Kbd>⌘</Kbd>
            <Kbd>K</Kbd>
          </span>
        </button>
        <div className="ml-auto flex items-center gap-2">
          <PeriodPicker />
          <QuickCreate />
          <TextSizeButton />
          <ThemeToggle />
          <Link href="/inbox" aria-label={t("shell.messages")} className="relative hidden size-9 items-center justify-center rounded-[10px] border border-border bg-card text-muted-foreground transition-colors hover:border-border-strong hover:text-foreground sm:flex">
            <MessageSquare className="size-4" />
          </Link>
          <NotificationsButton />
          <UserMenu />
        </div>
      </div>
    </header>
  )
}
