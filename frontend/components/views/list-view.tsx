"use client"

import { useMemo } from "react"
import type { CrmRecord, EntityDef, FieldDef, ViewDef } from "@/lib/core/types"
import { useMembers } from "@/lib/core/data"
import { ui } from "@/lib/core/ui"
import { FieldValue, RecordAvatar } from "@/components/crm/field-value"
import { Dot } from "@/components/crm/primitives"
import { groupOptions } from "@/components/views/board-view"
import { useT } from "@/components/i18n-provider"

export function ListView({ entity, view, records }: { entity: EntityDef; view: ViewDef; records: CrmRecord[] }) {
  const members = useMembers()
  const t = useT()
  const groupField = entity.fields.find((f) => f.key === view.groupBy)
  const fields = view.columns.map((k) => entity.fields.find((f) => f.key === k)).filter((f): f is FieldDef => !!f && f.key !== entity.primaryField)

  const groups = useMemo(() => {
    if (!groupField) return [{ key: "all", label: "", color: "gray" as const, rows: records }]
    const opts = groupOptions(groupField, members)
    const out = opts.map((o) => ({ key: o.value, label: o.label, color: o.color, rows: records.filter((r) => r[groupField.key] === o.value) }))
    const rest = records.filter((r) => !opts.some((o) => o.value === r[groupField.key]))
    if (rest.length) out.push({ key: "__none", label: t("views.noValue"), color: "gray", rows: rest })
    return out.filter((g) => g.rows.length)
  }, [groupField, records, members, t])

  return (
    <div className="flex flex-col gap-[var(--gap)]">
      {groups.map((g) => (
        <section key={g.key} className="surface overflow-hidden">
          {groupField && (
            <header className="flex items-center gap-2 border-b bg-elevated/60 px-4 py-2.5">
              <Dot color={g.color} />
              <span className="text-sm font-semibold">{g.label}</span>
              <span className="text-xs text-muted-foreground tabular">{g.rows.length}</span>
            </header>
          )}
          <ul className="divide-y">
            {g.rows.map((r) => (
              <li key={r.id}>
                <button onClick={() => ui.peek(entity.key, r.id)} className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-elevated">
                  <RecordAvatar entity={entity} record={r} size="md" />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{String(r[entity.primaryField] ?? t("common.untitled"))}</p>
                    {fields[0] && (
                      <div className="truncate text-xs text-muted-foreground">
                        <FieldValue field={fields[0]} value={r[fields[0].key]} compact />
                      </div>
                    )}
                  </div>
                  <div className="hidden items-center gap-5 text-sm md:flex">
                    {fields.slice(1, 4).map((f) => (
                      <span key={f.key} className="flex w-36 justify-end truncate">
                        <FieldValue field={f} value={r[f.key]} compact />
                      </span>
                    ))}
                  </div>
                </button>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  )
}
