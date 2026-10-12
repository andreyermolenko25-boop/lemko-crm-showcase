import { AlarmClock, ArrowRight, AtSign, CalendarClock, CheckCircle2, FilePen, Mail, MessageCircle, Newspaper, Pencil, Phone, PlusCircle, Trash2, UserPlus, Zap } from "lucide-react"
import { cn } from "@/lib/utils"
import type { ActivityKind } from "@/lib/core/types"

const MAP: Record<ActivityKind, { icon: typeof Mail; tone: string }> = {
  stage: { icon: ArrowRight, tone: "text-warning" },
  note: { icon: FilePen, tone: "text-[oklch(0.7_0.15_300)]" },
  email: { icon: Mail, tone: "text-info" },
  call: { icon: Phone, tone: "text-success" },
  meeting: { icon: CalendarClock, tone: "text-[oklch(0.68_0.15_300)]" },
  task: { icon: CheckCircle2, tone: "text-success" },
  created: { icon: PlusCircle, tone: "text-brand" },
  updated: { icon: Pencil, tone: "text-muted-foreground" },
  comment: { icon: MessageCircle, tone: "text-info" },
  deleted: { icon: Trash2, tone: "text-destructive" },
  assigned: { icon: UserPlus, tone: "text-brand" },
  mention: { icon: AtSign, tone: "text-info" },
  reminder: { icon: AlarmClock, tone: "text-warning" },
  digest: { icon: Newspaper, tone: "text-muted-foreground" },
  automation: { icon: Zap, tone: "text-warning" },
}

export function ActivityIcon({ kind, className }: { kind: ActivityKind; className?: string }) {
  const { icon: I, tone } = MAP[kind] ?? MAP.updated
  return (
    <span className={cn("flex size-8 shrink-0 items-center justify-center rounded-full border border-border bg-elevated", className)}>
      <I className={cn("size-3.5", tone)} />
    </span>
  )
}
