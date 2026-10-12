"use client"

import { useMemo } from "react"
import type { CrmRecord, EntityDef, ViewDef } from "@/lib/core/types"
import { ui } from "@/lib/core/ui"
import { MonthCalendar } from "@/components/views/month-calendar"
import { useT } from "@/components/i18n-provider"

export function CalendarView({ entity, records }: { entity: EntityDef; view: ViewDef; records: CrmRecord[] }) {
  const dateField = entity.fields.find((f) => f.key === entity.dateField) ?? entity.fields.find((f) => f.type === "date" || f.type === "datetime")
  const stage = entity.fields.find((f) => f.key === entity.stageField)
  const t = useT()
  const events = useMemo(
    () =>
      dateField
        ? records
            .filter((r) => r[dateField.key])
            .map((r) => ({
              id: r.id,
              date: new Date(String(r[dateField.key])),
              title: String(r[entity.primaryField] ?? ""),
              allDay: dateField.type === "date",
              color: stage?.options?.find((o) => o.value === r[stage.key])?.color ?? entity.color,
              onClick: () => ui.peek(entity.key, r.id),
            }))
        : [],
    [records, dateField, entity, stage],
  )
  if (!dateField) return <p className="text-sm text-muted-foreground">{t("views.calendarNeedsField")}</p>
  return (
    <MonthCalendar
      events={events}
      onCreate={(d) => {
        d.setHours(10, 0, 0, 0)
        ui.openCreate(entity.key, { [dateField.key]: d.toISOString() })
      }}
    />
  )
}
