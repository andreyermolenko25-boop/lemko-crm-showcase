"use client"

import type { ComponentProps, ReactNode } from "react"
import { motion, useReducedMotion } from "motion/react"
import { ArrowDownRight, ArrowUpRight } from "lucide-react"
import { cn } from "@/lib/utils"
import { Icon } from "@/lib/core/icons"
import { usePrefs } from "@/lib/core/prefs"
import { formatLocale, initials } from "@/lib/core/format"
import { useT } from "@/components/i18n-provider"
import type { ColorKey, Member } from "@/lib/core/types"

/* Pill tag that follows a colour key (status / select options). */
export function Tag({ color = "gray", children, className, dot }: { color?: ColorKey; children: ReactNode; className?: string; dot?: boolean }) {
  return (
    <span
      data-color={color}
      className={cn("tag inline-flex h-[1.375rem] max-w-full items-center gap-1.5 truncate rounded-md px-2 text-xs font-medium", className)}
    >
      {dot && <span data-color={color} className="tag-dot size-1.5 shrink-0 rounded-full" />}
      <span className="truncate">{children}</span>
    </span>
  )
}

export function Dot({ color = "gray", className }: { color?: ColorKey; className?: string }) {
  return <span data-color={color} className={cn("tag-dot inline-block size-2 shrink-0 rounded-full", className)} />
}

export function IconTile({ icon, color = "gray", className, size = "md" }: { icon: string; color?: ColorKey; className?: string; size?: "sm" | "md" | "lg" }) {
  const s = { sm: "size-6 rounded-md [&_svg]:size-3.5", md: "size-8 rounded-lg [&_svg]:size-4", lg: "size-10 rounded-xl [&_svg]:size-5" }[size]
  return (
    <span data-color={color} className={cn("icon-tile inline-flex shrink-0 items-center justify-center", s, className)}>
      <Icon name={icon} />
    </span>
  )
}

/* Monogram avatar — used for people, companies and members. */
export function Monogram({
  name,
  color,
  size = "md",
  className,
  square,
}: {
  name: unknown
  color?: ColorKey
  size?: "xs" | "sm" | "md" | "lg" | "xl"
  className?: string
  square?: boolean
}) {
  const s = {
    xs: "size-5 text-2xs",
    sm: "size-6 text-2xs",
    md: "size-8 text-xs",
    lg: "size-10 text-xs",
    xl: "size-14 text-base",
  }[size]
  return (
    <span
      data-color={color}
      className={cn(
        "inline-flex shrink-0 select-none items-center justify-center border font-semibold tracking-wide",
        color ? "icon-tile border-transparent" : "border-border bg-elevated text-muted-foreground",
        square ? "rounded-lg" : "rounded-full",
        s,
        className,
      )}
    >
      {initials(name)}
    </span>
  )
}

export function MemberAvatar({ member, size = "sm", withName, className }: { member?: Member; size?: "xs" | "sm" | "md" | "lg"; withName?: boolean; className?: string }) {
  if (!member) return <span className="text-subtle-foreground">—</span>
  if (!withName) return <Monogram name={member.name} color={member.color} size={size} className={className} />
  return (
    <span className={cn("inline-flex min-w-0 items-center gap-2", className)}>
      <Monogram name={member.name} color={member.color} size={size} />
      <span className="truncate">{member.name}</span>
    </span>
  )
}

/* Card container used by every widget / panel. */
export function Panel({
  title,
  subtitle,
  actions,
  children,
  className,
  bodyClassName,
  ...rest
}: {
  title?: ReactNode
  subtitle?: ReactNode
  actions?: ReactNode
  children?: ReactNode
  className?: string
  bodyClassName?: string
} & Omit<ComponentProps<"section">, "title">) {
  return (
    <section className={cn("surface flex min-w-0 flex-col", className)} {...rest}>
      {(title || actions) && (
        <header className="flex items-start justify-between gap-3 px-[var(--pad)] pt-[var(--pad)]">
          <div className="min-w-0">
            {title && <h3 className="truncate text-base font-semibold tracking-tight">{title}</h3>}
            {subtitle && <p className="mt-0.5 truncate text-xs text-muted-foreground">{subtitle}</p>}
          </div>
          {actions && <div className="flex shrink-0 items-center gap-1.5">{actions}</div>}
        </header>
      )}
      <div className={cn("panel-body flex min-h-0 flex-1 flex-col px-[var(--pad)] pb-[var(--pad)] pt-3", bodyClassName)}>{children}</div>
    </section>
  )
}

/** Change badge: % growth, or percentage points (pp) for rates. */
export function Delta({ value, unit = "%", className }: { value: number; unit?: "%" | "pp"; className?: string }) {
  const up = value >= 0
  const t = useT()
  return (
    <span
      className={cn(
        "inline-flex h-[1.375rem] items-center gap-0.5 rounded-md px-1.5 text-xs font-semibold tabular",
        up ? "bg-success/12 text-success" : "bg-destructive/12 text-destructive",
        className,
      )}
    >
      {up ? <ArrowUpRight className="size-3" /> : <ArrowDownRight className="size-3" />}
      {new Intl.NumberFormat(formatLocale(), { minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(Math.abs(value))}
      {unit === "pp" ? ` ${t("common.percentPoints")}` : "%"}
    </span>
  )
}

/* Mini bar sparkline like in the KPI cards. */
export function SparkBars({ values, className, highlightLast = true, color }: { values: number[]; className?: string; highlightLast?: boolean; color?: string }) {
  const max = Math.max(...values, 1)
  return (
    <div className={cn("flex h-7 items-end gap-[3px]", className)} aria-hidden>
      {values.map((v, i) => {
        const last = highlightLast && i === values.length - 1
        return (
          <span
            key={i}
            className={cn("w-[5px] rounded-full", !color && (last ? "bg-foreground/80" : "bg-foreground/25"))}
            style={{ height: `${28 + (v / max) * 72}%`, ...(color ? { background: color, opacity: last ? 1 : 0.4 } : {}) }}
          />
        )
      })}
    </div>
  )
}

export function MiniProgress({ value, className }: { value: number; className?: string }) {
  return (
    <div className={cn("h-1 w-full overflow-hidden rounded-full bg-foreground/10", className)}>
      <div className="h-full rounded-full bg-foreground/70" style={{ width: `${Math.min(100, Math.max(0, value))}%` }} />
    </div>
  )
}

export function EmptyState({ icon = "inbox", title, description, action, className }: { icon?: string; title: string; description?: string; action?: ReactNode; className?: string }) {
  return (
    <div className={cn("flex flex-col items-center justify-center gap-3 px-6 py-12 text-center", className)}>
      <IconTile icon={icon} size="lg" />
      <div>
        <p className="text-sm font-medium">{title}</p>
        {description && <p className="mt-1 max-w-sm text-xs text-muted-foreground">{description}</p>}
      </div>
      {action}
    </div>
  )
}

export function Kbd({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <kbd className={cn("inline-flex h-5 min-w-5 items-center justify-center rounded border border-border bg-elevated px-1 font-sans text-2xs font-medium text-muted-foreground", className)}>
      {children}
    </kbd>
  )
}

export function SectionLabel({ children, className }: { children: ReactNode; className?: string }) {
  return <p className={cn("px-1 text-xs font-semibold uppercase tracking-[0.08em] text-subtle-foreground", className)}>{children}</p>
}

/** The page's icon tile: a quiet fade-in when the page opens, nothing else. */
function HeaderIcon({ icon }: { icon: string }) {
  const os = useReducedMotion()
  const calm = usePrefs((p) => p.reduceMotion) || !!os
  const tile = "icon-tile inline-flex size-10 shrink-0 items-center justify-center rounded-xl [&_svg]:size-5"
  if (calm) {
    return (
      <span className={tile}>
        <Icon name={icon} />
      </span>
    )
  }
  return (
    <motion.span className={tile} initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.25, ease: "easeOut" }}>
      <Icon name={icon} />
    </motion.span>
  )
}

export function PageHeader({ title, description, actions, icon, children }: { title: ReactNode; description?: ReactNode; actions?: ReactNode; icon?: string; color?: ColorKey; children?: ReactNode }) {
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex min-w-0 items-center gap-3">
          {icon && <HeaderIcon key={icon} icon={icon} />}
          <div className="min-w-0">
            <h1 className="truncate text-2xl font-semibold tracking-tight">{title}</h1>
            {description && <p className="mt-0.5 text-sm text-muted-foreground">{description}</p>}
          </div>
        </div>
        {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
      </div>
      {children}
    </div>
  )
}
