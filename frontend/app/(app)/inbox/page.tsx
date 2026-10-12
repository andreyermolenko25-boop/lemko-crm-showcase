"use client"

import Link from "next/link"
import { useMemo, useState } from "react"
import { CheckCheck } from "lucide-react"
import { cn } from "@/lib/utils"
import type { ActivityKind } from "@/lib/core/types"
import { dataActions, memberById, useData } from "@/lib/core/data"
import { useEntities } from "@/lib/core/workspace"
import { useActivityText } from "@/lib/core/activity-text"
import { formatDate, timeAgo } from "@/lib/core/format"
import { Button } from "@/components/ui/button"
import { ActivityIcon } from "@/components/crm/activity-icon"
import { EmptyState, IconTile, MemberAvatar, PageHeader } from "@/components/crm/primitives"
import { useT } from "@/components/i18n-provider"

const FILTERS = ["all", "unread", "personal", "stage", "note", "email", "call", "meeting"] as const satisfies readonly ("all" | "unread" | "personal" | ActivityKind)[]

export default function InboxPage() {
  const activities = useData((s) => s.activities)
  const entities = useEntities()
  const [filter, setFilter] = useState<(typeof FILTERS)[number]>("all")
  const t = useT()
  const describe = useActivityText()
  const [entity, setEntity] = useState<string>("all")

  const rows = useMemo(
    () =>
      activities.filter(
        (a) =>
          (filter === "all" || (filter === "unread" ? !a.read : filter === "personal" ? a.personal : a.kind === filter)) &&
          (entity === "all" || a.entity === entity),
      ),
    [activities, filter, entity],
  )
  const groups = useMemo(() => {
    const m = new Map<string, ((typeof rows)[number] & { text: ReturnType<typeof describe> })[]>()
    for (const a of rows) {
      const d = new Date(a.at)
      const today = new Date()
      const y = new Date()
      y.setDate(y.getDate() - 1)
      const k = d.toDateString() === today.toDateString() ? t("inbox.today") : d.toDateString() === y.toDateString() ? t("inbox.yesterday") : formatDate(a.at, { weekday: "long", month: "short", day: "numeric" })
      m.set(k, [...(m.get(k) ?? []), { ...a, text: describe(a) }])
    }
    return [...m.entries()]
  }, [rows, t, describe])
  const unread = useData((s) => s.unread)

  return (
    <div className="flex flex-col gap-[var(--gap)]">
      <PageHeader
        icon="inbox"
        title={t("inbox.title")}
        description={t("inbox.description", { count: unread })}
        actions={
          <Button variant="outline" size="sm" onClick={() => dataActions.markAllRead()}>
            <CheckCheck /> {t("inbox.markAllRead")}
          </Button>
        }
      />
      <div className="grid gap-[var(--gap)] lg:grid-cols-[14rem_1fr]">
        <aside className="flex flex-col gap-4">
          <div className="flex flex-wrap gap-1 lg:flex-col">
            {FILTERS.map((f) => (
              <button
                key={f}
                onClick={() => setFilter(f)}
                className={cn(
                  "flex h-8 items-center justify-between gap-3 rounded-lg px-2.5 text-sm transition-colors",
                  filter === f ? "bg-card font-medium shadow-[var(--shadow-card)] ring-1 ring-border" : "text-muted-foreground hover:bg-accent hover:text-foreground",
                )}
              >
                {t(`inbox.filters.${f}`)}
                {f === "unread" && unread > 0 && <span className="rounded-md bg-brand-soft px-1.5 text-xs font-semibold text-brand-soft-foreground">{unread}</span>}
              </button>
            ))}
          </div>
          <div className="hidden flex-col gap-1 lg:flex">
            <p className="px-2.5 text-2xs font-semibold uppercase tracking-wider text-subtle-foreground">{t("inbox.objects")}</p>
            {[{ key: "all", label: t("inbox.allObjects"), icon: "boxes", color: "gray" as const }, ...entities.map((e) => ({ key: e.key, label: e.label, icon: e.icon, color: e.color }))].map((e) => (
              <button
                key={e.key}
                onClick={() => setEntity(e.key)}
                className={cn("flex h-8 items-center gap-2 rounded-lg px-2.5 text-sm", entity === e.key ? "bg-accent font-medium" : "text-muted-foreground hover:bg-accent/60")}
              >
                <IconTile icon={e.icon} color={e.color} size="sm" className="size-5 [&_svg]:size-3" />
                {e.label}
              </button>
            ))}
          </div>
        </aside>
        <div className="flex flex-col gap-[var(--gap)]">
          {groups.length === 0 && (
            <div className="surface">
              <EmptyState icon="inbox" title={t("inbox.caughtUp")} description={t("inbox.caughtUpHint")} />
            </div>
          )}
          {groups.map(([day, items]) => (
            <section key={day} className="surface overflow-hidden">
              <header className="border-b px-4 py-2.5 text-xs font-semibold text-muted-foreground">{day}</header>
              <ul className="divide-y">
                {items.map((a) => (
                  <li key={a.id}>
                    <Link
                      href={a.entity === "workspace" ? "/inbox" : `/o/${a.entity}/${a.recordId}`}
                      onClick={() => dataActions.markRead(a.id)}
                      className={cn("flex items-start gap-3 px-4 py-3.5 transition-colors hover:bg-elevated", !a.read && "bg-brand-soft/25")}
                    >
                      <ActivityIcon kind={a.kind} />
                      <div className="min-w-0 flex-1">
                        <p className="text-sm">
                          <span className="font-medium">{a.text.head}</span>
                          {a.text.subject && <span className="text-muted-foreground"> · {a.text.subject}</span>}
                        </p>
                        {a.text.body && <p className="mt-1 line-clamp-3 whitespace-pre-line text-sm text-muted-foreground">{a.text.body}</p>}
                        <div className="mt-1.5 flex items-center gap-2 text-xs text-muted-foreground">
                          {a.actor ? <MemberAvatar member={memberById(a.actor)} withName size="xs" /> : <span>{a.source === "schedule" ? t("inbox.reminder") : t("common.system")}</span>}
                          <span>·</span>
                          <span>{timeAgo(a.at)}</span>
                        </div>
                      </div>
                      {!a.read && <span className="mt-2 size-2 shrink-0 rounded-full bg-brand" />}
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      </div>
    </div>
  )
}
