"use client"

import Link from "next/link"
import { useParams } from "next/navigation"
import { AnimatePresence, motion, useReducedMotion } from "motion/react"
import {
  ArrowUpRight,
  Bell,
  Boxes,
  Building2,
  Code2,
  Database,
  Languages,
  LayoutPanelLeft,
  Palette,
  Plug,
  Shapes,
  ShieldCheck,
  User,
  Users,
} from "lucide-react"
import { cn } from "@/lib/utils"
import { duration, easing } from "@/lib/core/motion"
import { usePrefs } from "@/lib/core/prefs"
import { useEntity } from "@/lib/core/workspace"
import { AppearanceSettings } from "@/components/settings/appearance"
import { LanguageSettings } from "@/components/settings/language"
import { useT } from "@/components/i18n-provider"
import type { MessageKey } from "@/lib/i18n/translate"
import { NavigationSettings } from "@/components/settings/navigation"
import { ObjectsSettings } from "@/components/settings/objects"
import { ObjectEditor } from "@/components/settings/object-editor"
import { SecuritySettings } from "@/components/settings/security"
import {
  DataSettings,
  GeneralSettings,
  IntegrationsSettings,
  MembersSettings,
  NotificationSettings,
  ProfileSettings,
} from "@/components/settings/workspace"

type NavItem = { slug: string; label: MessageKey; icon: typeof Building2; href?: string }
type NavGroup = { group: MessageKey; items: NavItem[] }

const NAV: NavGroup[] = [
  {
    group: "settings.groups.workspace",
    items: [
      { slug: "general", label: "settings.nav.general", icon: Building2 },
      { slug: "appearance", label: "settings.nav.appearance", icon: Palette },
      { slug: "navigation", label: "settings.nav.navigation", icon: LayoutPanelLeft },
      { slug: "objects", label: "settings.nav.objects", icon: Shapes },
      { slug: "apps", label: "settings.nav.apps", icon: Boxes, href: "/apps" },
      { slug: "store", label: "settings.nav.store", icon: Plug, href: "/integrations" },
      { slug: "members", label: "settings.nav.members", icon: Users },
      { slug: "integrations", label: "settings.nav.integrations", icon: Code2 },
      { slug: "data", label: "settings.nav.data", icon: Database },
    ],
  },
  {
    group: "settings.groups.account",
    items: [
      { slug: "profile", label: "settings.nav.profile", icon: User },
      { slug: "language", label: "settings.nav.language", icon: Languages },
      { slug: "security", label: "settings.nav.security", icon: ShieldCheck },
      { slug: "notifications", label: "settings.nav.notifications", icon: Bell },
    ],
  },
]

/** Pages that live inside Settings (the rest of the nav links out). */
const SECTIONS = NAV.flatMap((g) => g.items.filter((i) => !i.href).map((i) => ({ ...i, group: g.group })))

function ObjectRoute({ entityKey }: { entityKey: string }) {
  const entity = useEntity(entityKey)
  const t = useT()
  if (!entity) return <p className="text-sm text-muted-foreground">{t("settings.objectNotFound")}</p>
  return <ObjectEditor key={entity.key} entity={entity} />
}

/** The member asked for less motion, or the OS did. */
function useCalm() {
  const pref = usePrefs((p) => p.reduceMotion)
  const os = useReducedMotion()
  return pref || !!os
}

/**
 * Settings navigation. The current page sits on a white pill that blooms in
 * place; rows wash on hover (.nav-row in globals.css). Links that leave
 * Settings show an outward arrow on hover.
 */
function SettingsNav({ section }: { section: string }) {
  const t = useT()
  return (
    <nav
      aria-label={t("settings.title")}
      className="-mx-4 flex gap-5 overflow-x-auto px-4 pb-1 scrollbar-none lg:sticky lg:top-[5.25rem] lg:mx-0 lg:flex-col lg:gap-6 lg:self-start lg:overflow-visible lg:px-0 lg:pb-0"
    >
      {NAV.map((g) => (
        <div key={g.group} className="flex shrink-0 gap-0.5 lg:flex-col">
          <p className="mb-1.5 hidden px-3 text-2xs font-medium uppercase tracking-[0.12em] text-subtle-foreground lg:block">{t(g.group)}</p>
          {g.items.map((i) => {
            const active = section === i.slug
            return (
              <Link
                key={i.slug}
                href={i.href ?? `/settings/${i.slug}`}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "nav-row group/item relative flex h-9 shrink-0 items-center gap-2.5 rounded-full px-3 text-sm outline-none transition-colors duration-200 [--nav-wash:var(--accent)] focus-visible:ring-2 focus-visible:ring-ring lg:rounded-[10px]",
                  active ? "font-medium text-foreground" : "text-muted-foreground hover:text-foreground",
                )}
              >
                {/* The current section blooms in place; nothing glides between rows. */}
                <AnimatePresence initial={false}>
                  {active && (
                    <motion.span
                      initial={{ opacity: 0, scale: 0.92 }}
                      animate={{ opacity: 1, scale: 1 }}
                      exit={{ opacity: 0, scale: 0.97, transition: { duration: duration.fast, ease: easing.smooth } }}
                      transition={{ duration: 0.32, ease: easing.smooth }}
                      className="absolute inset-0 rounded-[inherit] bg-card shadow-[0_1px_2px_oklch(0.2_0.01_260/6%),0_0_0_1px_var(--border)]"
                    />
                  )}
                </AnimatePresence>
                <i.icon className="nav-icon relative size-4 shrink-0" />
                <span className="nav-label relative whitespace-nowrap">{t(i.label)}</span>
                {i.href && (
                  <ArrowUpRight className="relative -ml-1 size-3.5 shrink-0 -translate-x-1 opacity-0 transition-[opacity,transform] duration-200 group-hover/item:translate-x-0 group-hover/item:opacity-60" />
                )}
              </Link>
            )
          })}
        </div>
      ))}
    </nav>
  )
}

export default function SettingsPage() {
  const { slug } = useParams<{ slug?: string[] }>()
  const section = slug?.[0] ?? "general"
  const t = useT()
  const calm = useCalm()
  const current = SECTIONS.find((s) => s.slug === section) ?? SECTIONS[0]

  let content: React.ReactNode
  switch (section) {
    case "appearance":
      content = <AppearanceSettings advanced={slug?.[1] === "advanced"} />
      break
    case "navigation":
      content = <NavigationSettings />
      break
    case "objects":
      content = slug?.[1] ? <ObjectRoute entityKey={slug[1]} /> : <ObjectsSettings />
      break
    case "members":
      content = <MembersSettings />
      break
    case "integrations":
      content = <IntegrationsSettings />
      break
    case "data":
      content = <DataSettings />
      break
    case "security":
      content = <SecuritySettings />
      break
    case "language":
      content = <LanguageSettings />
      break
    case "profile":
      content = <ProfileSettings />
      break
    case "notifications":
      content = <NotificationSettings />
      break
    default:
      content = <GeneralSettings />
  }

  const swap = calm
    ? { initial: false as const, animate: { opacity: 1 }, exit: { opacity: 0 }, transition: { duration: 0 } }
    : {
        initial: { opacity: 0, y: 8, filter: "blur(6px)" },
        animate: { opacity: 1, y: 0, filter: "blur(0px)" },
        exit: { opacity: 0, y: -6, filter: "blur(6px)" },
        transition: { duration: duration.normal, ease: easing.smooth },
      }

  return (
    <div className="settings-scope flex flex-col gap-[var(--gap)]">
      <header className="flex flex-col gap-2 border-b pb-6 lg:pb-7">
        <p className="flex items-center gap-2 text-2xs font-medium uppercase tracking-[0.12em] text-subtle-foreground">
          {t("settings.title")}
          <span className="size-1 rounded-full bg-border-strong" />
          {t(current.group)}
        </p>
        {/* Title and subtitle cross-fade with a soft blur when the section changes. */}
        <AnimatePresence mode="wait" initial={false}>
          <motion.div key={current.slug} {...swap}>
            <h1 className="text-balance text-3xl font-semibold tracking-[-0.03em] sm:text-4xl">{t(current.label)}</h1>
            <p className="mt-2 max-w-2xl text-pretty text-sm text-muted-foreground">{t(`settings.descriptions.${current.slug}` as MessageKey)}</p>
          </motion.div>
        </AnimatePresence>
      </header>
      <div className="grid gap-[var(--gap)] lg:grid-cols-[14rem_minmax(0,1fr)]">
        <SettingsNav section={section} />
        <div key={section} className="settings-reveal min-w-0 max-w-4xl">
          {content}
        </div>
      </div>
    </div>
  )
}
