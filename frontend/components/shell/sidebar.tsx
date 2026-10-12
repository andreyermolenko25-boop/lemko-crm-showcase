"use client"

import Link from "next/link"
import { usePathname, useRouter } from "next/navigation"
import { AnimatePresence, MotionConfig, motion, useReducedMotion } from "motion/react"
import { Check, ChevronsLeft, ChevronsUpDown, Settings2, Star, Users } from "lucide-react"
import { cn } from "@/lib/utils"
import { Icon } from "@/lib/core/icons"
import { useNavItems, type NavItem } from "@/lib/core/nav"
import { setPrefs, usePrefs } from "@/lib/core/prefs"
import { duration, easing, springs, stagger } from "@/lib/core/motion"
import { workspaceApi } from "@/lib/core/backend"
import { useWorkspace, workspaceActions } from "@/lib/core/workspace"
import { initials } from "@/lib/core/format"
import { SectionLabel } from "@/components/crm/primitives"
import { useI18n, useT } from "@/components/i18n-provider"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"

/*
 * Layout rule: icons never move. The rail is 56px, the content column inside it
 * is 40px, and every row pads its icon to the centre of that column — so
 * collapsing only changes the width and fades the labels.
 */
const FULL_WIDTH = 248
const RAIL_WIDTH = 56
const ICON_INSET = "pl-[11.5px]"

/** Labels fade and slide a touch toward the icons as the rail closes; they come back the same way. */
const fade = (show: boolean) => ({
  initial: false as const,
  animate: { opacity: show ? 1 : 0, x: show ? 0 : -6 },
  transition: { duration: show ? duration.normal : duration.fast, ease: easing.smooth, delay: show ? 0.06 : 0 },
})

/** The member asked for less motion, or the OS did. */
function useMotionReduced() {
  const pref = usePrefs((p) => p.reduceMotion)
  const os = useReducedMotion()
  return pref || !!os
}

function isActive(pathname: string, href: string) {
  if (href === "/") return pathname === "/"
  return pathname === href || pathname.startsWith(`${href}/`)
}

/**
 * The current page is marked where it is, not chased there: the old row lets
 * go, the new one blooms its pill, draws its tick from the middle out and
 * gives its icon a small pop.
 */
const PILL_IN = { duration: 0.32, ease: easing.smooth }
const TICK = { type: "spring", stiffness: 520, damping: 30 } as const
const ICON_POP = {
  on: { scale: [1, 1.2, 0.96, 1], transition: { duration: 0.5, ease: easing.smooth, times: [0, 0.35, 0.7, 1] } },
  off: { scale: 1 },
}

function NavLink({ item, collapsed, pills, onNavigate }: { item: NavItem; collapsed: boolean; pills: boolean; onNavigate?: () => void }) {
  const pathname = usePathname()
  const active = isActive(pathname, item.href)
  return (
    <Tooltip delayDuration={0} open={collapsed ? undefined : false}>
      <TooltipTrigger asChild>
        <Link
          href={item.href}
          onClick={onNavigate}
          aria-current={active ? "page" : undefined}
          className={cn(
            "nav-row relative flex h-9 items-center gap-3 rounded-lg pr-2.5 text-sm outline-none transition-colors duration-200 focus-visible:ring-2 focus-visible:ring-sidebar-ring",
            ICON_INSET,
            active ? "font-medium text-foreground" : "text-muted-foreground hover:text-foreground",
          )}
        >
          <AnimatePresence initial={false}>
            {active && pills && (
              <motion.span
                key="pill"
                initial={{ opacity: 0, scale: 0.9 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.97, transition: { duration: duration.fast, ease: easing.smooth } }}
                transition={PILL_IN}
                className="absolute inset-0 rounded-lg bg-sidebar-accent shadow-[inset_0_0_0_1px_var(--sidebar-border)]"
              />
            )}
            {active && (
              <motion.span
                key="tick"
                initial={{ scaleY: 0, opacity: 0 }}
                animate={{ scaleY: 1, opacity: 1 }}
                exit={{ scaleY: 0, opacity: 0, transition: { duration: duration.fast, ease: easing.smooth } }}
                transition={TICK}
                className="absolute -left-2 top-1/2 -mt-2 h-4 w-[2px] rounded-r-full bg-foreground"
              />
            )}
          </AnimatePresence>
          <motion.span initial={false} variants={ICON_POP} animate={active ? "on" : "off"} className="relative flex shrink-0">
            <Icon name={item.icon} className="nav-icon size-[17px] shrink-0" />
          </motion.span>
          <motion.span {...fade(!collapsed)} className="relative min-w-0 flex-1 overflow-hidden whitespace-nowrap">
            <span className={cn("nav-label block", !collapsed && "truncate")}>{item.label}</span>
          </motion.span>
          {item.badge ? (
            <>
              <motion.span {...fade(!collapsed)} className="relative shrink-0 rounded-md bg-foreground px-1.5 py-0.5 text-2xs font-semibold tabular text-background">
                {item.badge}
              </motion.span>
              <AnimatePresence>
                {collapsed && (
                  <motion.span
                    initial={{ scale: 0 }}
                    animate={{ scale: 1 }}
                    exit={{ scale: 0 }}
                    transition={springs.snappy}
                    className="absolute right-1.5 top-1.5 size-1.5 rounded-full bg-foreground"
                  />
                )}
              </AnimatePresence>
            </>
          ) : null}
        </Link>
      </TooltipTrigger>
      <TooltipContent side="right">{item.label}</TooltipContent>
    </Tooltip>
  )
}

export function WorkspaceLogo({ className }: { className?: string }) {
  const name = useWorkspace((s) => s.name)
  const logo = useWorkspace((s) => s.logoAttachmentId)
  if (logo) {
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={workspaceApi.attachmentUrl(logo)} alt="" className={cn("shrink-0 rounded-lg object-cover ring-1 ring-border", className)} />
  }
  return (
    <span className={cn("flex shrink-0 items-center justify-center rounded-lg bg-elevated text-xs font-semibold text-foreground ring-1 ring-border", className)}>
      {initials(name)}
    </span>
  )
}

/** Lemko mark, same as the site: an "L" built from a pipeline, ink on white. */
function BrandMark() {
  return (
    <svg viewBox="0 0 32 32" aria-hidden className="size-8 shrink-0">
      <rect width="32" height="32" rx="9" fill="var(--foreground)" />
      <path d="M11 8.5v12.5a2.5 2.5 0 0 0 2.5 2.5H22" fill="none" stroke="var(--background)" strokeWidth="3" strokeLinecap="round" />
      <circle cx="22.5" cy="11" r="3" fill="var(--background)" />
    </svg>
  )
}

function WorkspaceSwitcher({ collapsed }: { collapsed: boolean }) {
  const name = useWorkspace((s) => s.name)
  const plan = useWorkspace((s) => s.plan)
  const router = useRouter()
  const { t, maybe } = useI18n()
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button className="flex h-11 w-full items-center gap-2.5 rounded-lg pl-1.5 pr-2 text-left outline-none transition-colors duration-150 hover:bg-sidebar-accent focus-visible:ring-2 focus-visible:ring-sidebar-ring">
          <WorkspaceLogo className="size-7" />
          <motion.span {...fade(!collapsed)} className="flex min-w-0 flex-1 items-center gap-2">
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-semibold leading-tight">{name}</span>
              <span className="block truncate text-xs text-muted-foreground">{maybe(`workspaceSettings.plans.${plan}`) ?? plan}</span>
            </span>
            <ChevronsUpDown className="size-3.5 shrink-0 text-muted-foreground" />
          </motion.span>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-60">
        <DropdownMenuLabel className="text-xs text-muted-foreground">{t("shell.workspace")}</DropdownMenuLabel>
        <DropdownMenuItem>
          <WorkspaceLogo className="size-6 text-2xs" />
          <span className="flex-1">{name}</span>
          <Check className="size-3.5" />
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => router.push("/settings")}>
          <Settings2 /> {t("shell.workspaceSettings")}
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => router.push("/settings/members")}>
          <Users /> {t("shell.members")}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/**
 * Group heading. Keeps its height when collapsed so the rows below do not
 * jump; in the rail the words give way to a short hairline under the icons.
 */
function GroupLabel({ collapsed, children }: { collapsed: boolean; children: string }) {
  return (
    <div className="relative flex h-6 items-end overflow-hidden whitespace-nowrap px-3 pb-1">
      <motion.div {...fade(!collapsed)}>
        <SectionLabel>{children}</SectionLabel>
      </motion.div>
      <motion.span
        aria-hidden
        initial={false}
        animate={{ opacity: collapsed ? 1 : 0, scaleX: collapsed ? 1 : 0.2 }}
        transition={{ duration: duration.normal, ease: easing.smooth, delay: collapsed ? 0.08 : 0 }}
        className="absolute bottom-2.5 left-3 h-px w-4 bg-sidebar-border"
      />
    </div>
  )
}

export function SidebarContent({ collapsed = false, onNavigate }: { collapsed?: boolean; onNavigate?: () => void }) {
  const { visible } = useNavItems()
  const favorites = useWorkspace((s) => s.nav.favorites)
  const pills = usePrefs((p) => p.sidebarStyle) === "pills"
  const niche = useWorkspace((s) => s.niche)
  const reduced = useMotionReduced()
  const t = useT()

  /** Rows rise in one after another, un-blurring like the site's reveals, the first time the sidebar mounts. */
  const rise = (i: number) => ({
    initial: { opacity: 0, y: 6, filter: "blur(4px)" },
    // A finished row drops its filter: it would otherwise stay a compositing layer for good.
    animate: { opacity: 1, y: 0, filter: "blur(0px)", transitionEnd: { filter: "none" } },
    transition: { duration: duration.slow, ease: easing.smooth, delay: 0.05 + i * stagger.tight },
  })

  return (
    <MotionConfig reducedMotion={reduced ? "always" : "never"}>
      <div className="flex h-full w-full flex-col gap-2 px-2 py-3">
        {/* Brand */}
        <div className="flex h-10 items-center gap-2.5 pl-1">
          <BrandMark />
          <motion.div {...fade(!collapsed)} className="min-w-0 flex-1">
            <p className="truncate text-[15px] font-semibold leading-tight tracking-tight">
              {t("auth.brand")}
            </p>
            <p className="truncate text-2xs font-medium uppercase tracking-[0.08em] text-muted-foreground">{niche}</p>
          </motion.div>
        </div>

        <WorkspaceSwitcher collapsed={collapsed} />

        <nav className="scrollbar-thin -mx-2 min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-2">
          <div className="flex flex-col gap-4 pt-1">
            {favorites.length > 0 && (
              <div className="flex flex-col gap-0.5">
                <GroupLabel collapsed={collapsed}>{t("shell.favorites")}</GroupLabel>
                {favorites.map((f, i) => (
                  <motion.div key={f.id} {...rise(i)}>
                    <NavLink
                      collapsed={collapsed}
                      pills={false}
                      onNavigate={onNavigate}
                      item={{ id: f.id, label: f.label, href: f.href, icon: f.icon, kind: "page" }}
                    />
                  </motion.div>
                ))}
              </div>
            )}
            <div className="flex flex-col gap-0.5">
              <GroupLabel collapsed={collapsed}>{t("shell.workspace")}</GroupLabel>
              {visible.map((item, i) => (
                <motion.div key={item.id} {...rise(i + favorites.length)}>
                  <NavLink item={item} collapsed={collapsed} pills={pills} onNavigate={onNavigate} />
                </motion.div>
              ))}
            </div>
          </div>
        </nav>

        <div className="flex flex-col gap-0.5 border-t border-sidebar-border pt-2">
          <NavLink
            item={{ id: "settings", label: t("nav.settings"), href: "/settings", icon: "settings", kind: "page" }}
            collapsed={collapsed}
            pills={pills}
            onNavigate={onNavigate}
          />
          <Tooltip delayDuration={0} open={collapsed ? undefined : false}>
            <TooltipTrigger asChild>
              <button
                onClick={() => setPrefs({ sidebarCollapsed: !collapsed })}
                aria-label={collapsed ? t("shell.expandSidebar") : t("shell.collapseSidebar")}
                className={cn(
                  "nav-row group/nav relative hidden h-9 items-center gap-3 rounded-lg pr-2.5 text-sm text-muted-foreground outline-none transition-colors duration-200 hover:text-foreground focus-visible:ring-2 focus-visible:ring-sidebar-ring lg:flex",
                  ICON_INSET,
                )}
              >
                {/* The chevrons turn over with a little spring and nudge toward where the rail will go. */}
                <motion.span
                  initial={false}
                  animate={{ rotate: collapsed ? 180 : 0 }}
                  transition={{ type: "spring", stiffness: 260, damping: 18 }}
                  className="relative flex"
                >
                  <ChevronsLeft className="size-[17px] shrink-0 transition-transform duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] group-hover/nav:-translate-x-0.5" />
                </motion.span>
                <motion.span {...fade(!collapsed)} className="relative overflow-hidden whitespace-nowrap">
                  <span className="nav-label block">{t("shell.collapseSidebar")}</span>
                </motion.span>
              </button>
            </TooltipTrigger>
            <TooltipContent side="right">{t("shell.expandSidebar")}</TooltipContent>
          </Tooltip>
        </div>
      </div>
    </MotionConfig>
  )
}

/** Width and column move on one curve: quick out of the gate, long soft landing. */
const RAIL_EASE = [0.32, 0.72, 0, 1] as const

export function Sidebar() {
  const collapsed = usePrefs((p) => p.sidebarCollapsed)
  const reduced = useMotionReduced()
  const transition = reduced ? { duration: 0 } : { duration: 0.42, ease: RAIL_EASE }
  const width = collapsed ? RAIL_WIDTH : FULL_WIDTH
  return (
    <motion.aside
      initial={false}
      animate={{ width }}
      transition={transition}
      className="sticky top-0 hidden h-dvh shrink-0 overflow-hidden border-r border-sidebar-border bg-sidebar text-sidebar-foreground lg:block"
    >
      {/*
       * The column tracks the aside on the same curve, so rows are exactly as wide as the rail
       * while it moves: the hover highlight and the active pill stay rounded instead of clipped.
       * Labels are single-line and fade first, so nothing re-wraps on the way.
       */}
      <motion.div initial={false} animate={{ width }} transition={transition} className="h-full">
        <SidebarContent collapsed={collapsed} />
      </motion.div>
    </motion.aside>
  )
}

export function FavoriteToggle({ fav }: { fav: { id: string; label: string; href: string; icon: string } }) {
  const isFav = useWorkspace((s) => s.nav.favorites.some((f) => f.id === fav.id))
  const t = useT()
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          onClick={() => workspaceActions.toggleFavorite(fav)}
          className="flex size-8 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          aria-label={isFav ? t("shell.removeFavorite") : t("shell.addFavorite")}
        >
          <Star className={cn("size-4", isFav && "fill-warning text-warning")} />
        </button>
      </TooltipTrigger>
      <TooltipContent>{isFav ? t("shell.unpinFromSidebar") : t("shell.pinToSidebar")}</TooltipContent>
    </Tooltip>
  )
}
