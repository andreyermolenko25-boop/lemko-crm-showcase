"use client"

import { useMemo, useState } from "react"
import { Plus } from "lucide-react"
import { cn } from "@/lib/utils"
import type { CrmRecord, EntityDef, FieldDef, FieldOption, ViewDef } from "@/lib/core/types"
import { dataActions, useMembers } from "@/lib/core/data"
import { formatMoney } from "@/lib/core/format"
import { ui } from "@/lib/core/ui"
import { FieldValue } from "@/components/crm/field-value"
import { Dot, MemberAvatar } from "@/components/crm/primitives"
import { useT } from "@/components/i18n-provider"
import { nounInSentence } from "@/lib/i18n/text"

export function groupOptions(field: FieldDef | undefined, members: ReturnType<typeof useMembers>): FieldOption[] {
  if (!field) return []
  if (field.type === "user") return members.map((m) => ({ value: m.id, label: m.name, color: m.color }))
  return field.options ?? []
}

export function RecordCard({ entity, view, record, dragging, ...rest }: { entity: EntityDef; view: ViewDef; record: CrmRecord; dragging?: boolean } & React.ComponentProps<"div">) {
  const fields = view.columns.map((k) => entity.fields.find((f) => f.key === k)).filter((f): f is FieldDef => !!f && f.key !== entity.primaryField)
  const owner = entity.ownerField ? record[entity.ownerField] : undefined
  const members = useMembers()
  const t = useT()
  return (
    <div
      {...rest}
      onClick={() => ui.peek(entity.key, record.id)}
      className={cn(
        "group/card cursor-pointer rounded-xl border bg-card p-3 shadow-[var(--shadow-card)] transition-[border-color,box-shadow,opacity] hover:border-border-strong",
        dragging && "opacity-40",
        rest.className,
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <p className="line-clamp-2 text-sm font-medium leading-snug">{String(record[entity.primaryField] ?? t("common.untitled"))}</p>
        {owner && !view.columns.includes(entity.ownerField!) ? <MemberAvatar member={members.find((m) => m.id === owner)} size="xs" /> : null}
      </div>
      {fields.length > 0 && (
        <div className="mt-2.5 flex flex-col gap-1.5">
          {fields.map((f) => (
            <div key={f.key} className="flex min-w-0 items-center justify-between gap-2 text-xs">
              <span className="shrink-0 text-subtle-foreground">{f.label}</span>
              <span className="flex min-w-0 justify-end text-muted-foreground [&_a]:text-muted-foreground">
                <FieldValue field={f} value={record[f.key]} compact />
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

export function BoardView({ entity, view, records }: { entity: EntityDef; view: ViewDef; records: CrmRecord[] }) {
  const members = useMembers()
  const groupKey = view.groupBy ?? entity.stageField ?? entity.fields.find((f) => f.type === "select")?.key
  const field = entity.fields.find((f) => f.key === groupKey)
  const options = groupOptions(field, members)
  const amountField = entity.fields.find((f) => f.key === entity.amountField)
  const [dragId, setDragId] = useState<string | null>(null)
  const [over, setOver] = useState<string | null>(null)
  const t = useT()

  const columns = useMemo(() => {
    const map = new Map<string, CrmRecord[]>(options.map((o) => [o.value, []]))
    const none: CrmRecord[] = []
    for (const r of records) {
      const v = String(r[groupKey ?? ""] ?? "")
      ;(map.get(v) ?? none).push(r)
    }
    return { map, none }
  }, [records, options, groupKey])

  if (!field) return <p className="text-sm text-muted-foreground">{t("views.boardNeedsField")}</p>

  const drop = (value: string | null) => {
    if (dragId && !field.readOnly) dataActions.update(entity, dragId, { [field.key]: value })
    setDragId(null)
    setOver(null)
  }

  const lanes = [...options.map((o) => ({ ...o, rows: columns.map.get(o.value) ?? [] })), ...(columns.none.length ? [{ value: "", label: t("views.noValue"), color: "gray" as const, rows: columns.none }] : [])]

  return (
    <div className="scrollbar-thin -mx-1 flex gap-3 overflow-x-auto px-1 pb-3">
      {lanes.map((lane) => {
        const total = amountField ? lane.rows.reduce((s, r) => s + (Number(r[amountField.key]) || 0), 0) : 0
        return (
          <div
            key={lane.value || "none"}
            onDragOver={(e) => {
              e.preventDefault()
              setOver(lane.value)
            }}
            onDragLeave={() => setOver((o) => (o === lane.value ? null : o))}
            onDrop={() => drop(lane.value || null)}
            className={cn(
              "flex w-[17.5rem] shrink-0 flex-col rounded-2xl border bg-elevated/60 transition-colors",
              over === lane.value && dragId && "border-brand/60 bg-brand-soft/40",
            )}
          >
            <div className="flex items-center gap-2 px-3 pb-2 pt-3">
              <Dot color={lane.color} />
              <span className="text-sm font-semibold">{lane.label}</span>
              <span className="rounded-md bg-foreground/[0.06] px-1.5 py-0.5 text-2xs font-medium tabular text-muted-foreground">{lane.rows.length}</span>
              {amountField && <span className="ml-auto text-xs font-medium tabular text-muted-foreground">{formatMoney(total, { compact: true })}</span>}
            </div>
            <div className="flex min-h-24 flex-1 flex-col gap-2 overflow-y-auto px-2 pb-2 scrollbar-thin" style={{ maxHeight: "calc(100dvh - 17rem)" }}>
              {lane.rows.map((r) => (
                <RecordCard
                  key={r.id}
                  entity={entity}
                  view={view}
                  record={r}
                  draggable={!field.readOnly}
                  dragging={dragId === r.id}
                  onDragStart={(e) => {
                    e.dataTransfer.effectAllowed = "move"
                    setDragId(r.id)
                  }}
                  onDragEnd={() => {
                    setDragId(null)
                    setOver(null)
                  }}
                />
              ))}
              <button
                onClick={() => ui.openCreate(entity.key, field.type === "user" ? { [field.key]: lane.value } : { [field.key]: lane.value || null })}
                className="flex h-8 items-center gap-1.5 rounded-lg px-2 text-xs text-muted-foreground transition-colors hover:bg-card hover:text-foreground"
              >
                <Plus className="size-3.5" /> {t("views.addRecord", { name: nounInSentence(entity.labelSingular) })}
              </button>
            </div>
          </div>
        )
      })}
    </div>
  )
}
