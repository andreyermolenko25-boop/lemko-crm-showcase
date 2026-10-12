"use client"

import { useId, type ReactNode } from "react"
import { motion } from "motion/react"
import { cn } from "@/lib/utils"
import { springs } from "@/lib/core/motion"

/**
 * One settings card: hairline border, quiet header, rows split by hairlines.
 * The look comes from `.settings-scope` in globals.css, so hand-built
 * `section.surface` cards on other settings pages match it too.
 */
export function SettingsSection({
  title,
  description,
  actions,
  children,
  className,
}: {
  title: string
  description?: string
  actions?: ReactNode
  children: ReactNode
  className?: string
}) {
  return (
    <section className={cn("surface", className)}>
      <header className="flex items-start justify-between gap-4 border-b px-[var(--pad)] py-4">
        <div className="min-w-0">
          <h2 className="text-base font-semibold tracking-tight">{title}</h2>
          {description && <p className="mt-0.5 text-pretty text-xs text-muted-foreground">{description}</p>}
        </div>
        {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
      </header>
      <div className="divide-y">{children}</div>
    </section>
  )
}

export function SettingsRow({ label, hint, children, stack }: { label: ReactNode; hint?: ReactNode; children: ReactNode; stack?: boolean }) {
  return (
    <div className={cn("flex gap-4 px-[var(--pad)] py-4", stack ? "flex-col" : "flex-col sm:flex-row sm:items-center sm:justify-between")}>
      <div className={cn("min-w-0", stack ? "max-w-xl" : "sm:max-w-sm")}>
        <p className="text-sm font-medium">{label}</p>
        {hint && <p className="mt-0.5 text-pretty text-xs text-muted-foreground">{hint}</p>}
      </div>
      <div className={cn("min-w-0", !stack && "sm:shrink-0")}>{children}</div>
    </div>
  )
}

/**
 * Pill toggle like the billing switch on the marketing site: the white pill
 * glides to the chosen option. Arrow keys move the choice.
 */
export function Segmented<T extends string | number>({
  value,
  options,
  onChange,
  label,
  className,
}: {
  value: T
  options: { value: T; label: ReactNode }[]
  onChange: (v: T) => void
  label?: string
  className?: string
}) {
  const pill = useId()
  const index = options.findIndex((o) => o.value === value)
  return (
    <div
      role="radiogroup"
      aria-label={label}
      className={cn("inline-flex max-w-full overflow-x-auto rounded-full border bg-elevated p-0.5 scrollbar-none", className)}
      onKeyDown={(e) => {
        const step = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 0
        if (!step) return
        e.preventDefault()
        const next = (Math.max(index, 0) + step + options.length) % options.length
        onChange(options[next].value)
        e.currentTarget.querySelectorAll<HTMLButtonElement>("[role=radio]")[next]?.focus()
      }}
    >
      {options.map((o, i) => {
        const active = value === o.value
        return (
          <button
            key={String(o.value)}
            type="button"
            role="radio"
            aria-checked={active}
            tabIndex={active || (index < 0 && i === 0) ? 0 : -1}
            onClick={() => onChange(o.value)}
            className={cn(
              "relative flex h-7 shrink-0 items-center justify-center gap-1.5 rounded-full px-3 text-xs font-medium outline-none transition-colors duration-200 focus-visible:ring-2 focus-visible:ring-ring",
              active ? "text-foreground" : "text-muted-foreground hover:text-foreground",
            )}
          >
            {active && (
              <motion.span
                layoutId={pill}
                className="absolute inset-0 rounded-full bg-card shadow-[0_1px_2px_oklch(0.2_0.01_260/8%),0_0_0_1px_var(--border)]"
                transition={springs.snappy}
              />
            )}
            <span className="relative flex min-w-0 items-center gap-1.5 whitespace-nowrap [&_svg]:shrink-0">{o.label}</span>
          </button>
        )
      })}
    </div>
  )
}
