import { cn } from "@/lib/utils"
import type { IntegrationDef } from "@/lib/core/integrations"

/** Generic monogram tile for an integration (not a brand logo). */
export function AppMark({ app, size = "md" }: { app: IntegrationDef; size?: "sm" | "md" | "lg" }) {
  const s = { sm: "size-8 rounded-lg text-xs", md: "size-10 rounded-xl text-sm", lg: "size-14 rounded-2xl text-lg" }[size]
  return (
    <span className={cn("flex shrink-0 items-center justify-center font-bold tracking-tight ring-1 ring-black/5 dark:ring-white/10", s)} style={{ background: app.bg, color: app.fg }} aria-hidden>
      {app.mark}
    </span>
  )
}
