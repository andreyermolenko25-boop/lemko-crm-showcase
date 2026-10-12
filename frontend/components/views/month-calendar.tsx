"use client"

import { useMemo, useState } from "react"
import { ChevronLeft, ChevronRight, Plus } from "lucide-react"
import { cn } from "@/lib/utils"
import type { ColorKey } from "@/lib/core/types"
import { formatTime, isSameDay, monthYear, useFormats, weekdayNames } from "@/lib/core/format"
import { useT } from "@/components/i18n-provider"
import { Button } from "@/components/ui/button"

export type CalendarEvent = { id: string; date: Date; title: string; color: ColorKey; allDay?: boolean; onClick?: () => void }

export function MonthCalendar({
  events,
  onCreate,
  initial,
  toolbar,
}: {
  events: CalendarEvent[]
  onCreate?: (date: Date) => void
  initial?: Date
  toolbar?: React.ReactNode
}) {
  const { weekStartsOn: weekStart } = useFormats()
  const t = useT()
  const [cursor, setCursor] = useState(() => {
    const d = initial ?? new Date()
    return new Date(d.getFullYear(), d.getMonth(), 1)
  })
  const today = new Date()

  const days = useMemo(() => {
    const first = new Date(cursor)
    const offset = (first.getDay() - weekStart + 7) % 7
    const start = new Date(first)
    start.setDate(1 - offset)
    return Array.from({ length: 42 }, (_, i) => {
      const d = new Date(start)
      d.setDate(start.getDate() + i)
      return d
    })
  }, [cursor, weekStart])

  const byDay = useMemo(() => {
    const m = new Map<string, CalendarEvent[]>()
    for (const e of events) {
      const k = e.date.toDateString()
      const list = m.get(k) ?? []
      list.push(e)
      m.set(k, list)
    }
    for (const list of m.values()) list.sort((a, b) => a.date.getTime() - b.date.getTime())
    return m
  }, [events])

  const dayNames = weekdayNames("short")
  const names = [...dayNames.slice(weekStart), ...dayNames.slice(0, weekStart)]

  return (
    <div className="surface overflow-hidden">
      <div className="flex flex-wrap items-center gap-2 border-b px-4 py-3">
        <h2 className="mr-2 text-base font-semibold">
          {monthYear(cursor)}
        </h2>
        <Button variant="outline" size="icon-sm" onClick={() => setCursor(new Date(cursor.getFullYear(), cursor.getMonth() - 1, 1))} aria-label={t("views.previousMonth")}>
          <ChevronLeft />
        </Button>
        <Button variant="outline" size="sm" onClick={() => setCursor(new Date(today.getFullYear(), today.getMonth(), 1))}>
          {t("views.today")}
        </Button>
        <Button variant="outline" size="icon-sm" onClick={() => setCursor(new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1))} aria-label={t("views.nextMonth")}>
          <ChevronRight />
        </Button>
        <div className="ml-auto flex items-center gap-2">{toolbar}</div>
      </div>
      <div className="grid grid-cols-7 border-b text-xs font-medium uppercase tracking-wider text-subtle-foreground">
        {names.map((n) => (
          <div key={n} className="px-3 py-2">
            {n}
          </div>
        ))}
      </div>
      <div className="grid grid-cols-7 grid-rows-6">
        {days.map((d, i) => {
          const inMonth = d.getMonth() === cursor.getMonth()
          const list = byDay.get(d.toDateString()) ?? []
          const isToday = isSameDay(d, today)
          return (
            <div
              key={i}
              className={cn(
                "group/day relative flex min-h-[6.75rem] flex-col gap-1 border-b border-r p-1.5 [&:nth-child(7n)]:border-r-0",
                !inMonth && "bg-elevated/50",
              )}
            >
              <div className="flex items-center justify-between px-1">
                <span
                  className={cn(
                    "flex size-6 items-center justify-center rounded-full text-xs tabular",
                    isToday ? "bg-primary font-semibold text-primary-foreground" : inMonth ? "text-foreground" : "text-subtle-foreground",
                  )}
                >
                  {d.getDate()}
                </span>
                {onCreate && (
                  <button
                    onClick={() => onCreate(d)}
                    className="flex size-5 items-center justify-center rounded text-muted-foreground opacity-0 hover:bg-accent hover:text-foreground group-hover/day:opacity-100"
                    aria-label={t("views.addOnDay")}
                  >
                    <Plus className="size-3.5" />
                  </button>
                )}
              </div>
              {list.slice(0, 3).map((e) => (
                <button
                  key={e.id}
                  onClick={e.onClick}
                  title={e.title}
                  data-color={e.color}
                  className="tag flex h-[1.375rem] min-w-0 items-center gap-1 rounded px-1.5 text-left text-xs font-medium"
                >
                  {!e.allDay && <span className="shrink-0 tabular opacity-70">{formatTime(e.date)}</span>}
                  <span className="truncate">{e.title}</span>
                </button>
              ))}
              {list.length > 3 && <span className="px-1.5 text-xs text-muted-foreground">{t("views.moreCount", { count: list.length - 3 })}</span>}
            </div>
          )
        })}
      </div>
    </div>
  )
}
