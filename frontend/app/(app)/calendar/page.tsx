"use client"

import { useMemo, useState } from "react"
import { cn } from "@/lib/utils"
import { useData } from "@/lib/core/data"
import { useEntities } from "@/lib/core/workspace"
import { ui } from "@/lib/core/ui"
import { PageHeader, Dot } from "@/components/crm/primitives"
import { MonthCalendar, type CalendarEvent } from "@/components/views/month-calendar"
import { useT } from "@/components/i18n-provider"

/** Unified calendar: every object with a date field contributes events. */
export default function CalendarPage() {
  const entities = useEntities()
  const records = useData((s) => s.records)
  const dated = useMemo(() => entities.filter((e) => e.dateField), [entities])
  const [hidden, setHidden] = useState<string[]>([])
  const t = useT()

  const events = useMemo(() => {
    const out: CalendarEvent[] = []
    for (const e of dated) {
      if (hidden.includes(e.key)) continue
      const f = e.fields.find((x) => x.key === e.dateField)!
      for (const r of records[e.key] ?? []) {
        if (!r[f.key]) continue
        out.push({
          id: `${e.key}-${r.id}`,
          date: new Date(String(r[f.key])),
          title: String(r[e.primaryField] ?? ""),
          color: e.color,
          allDay: f.type === "date",
          onClick: () => ui.peek(e.key, r.id),
        })
      }
    }
    return out
  }, [dated, records, hidden])

  return (
    <div className="flex flex-col gap-[var(--gap)]">
      <PageHeader icon="calendar" title={t("calendarPage.title")} description={t("calendarPage.description")} />
      <MonthCalendar
        events={events}
        toolbar={
          <div className="flex flex-wrap gap-1.5">
            {dated.map((e) => {
              const off = hidden.includes(e.key)
              return (
                <button
                  key={e.key}
                  onClick={() => setHidden((h) => (off ? h.filter((x) => x !== e.key) : [...h, e.key]))}
                  className={cn("flex h-7 items-center gap-1.5 rounded-lg border px-2.5 text-xs font-medium transition-opacity", off && "opacity-45")}
                >
                  <Dot color={e.color} />
                  {e.label}
                </button>
              )
            })}
          </div>
        }
      />
    </div>
  )
}
