"use client"

import { useMemo, useRef, useState } from "react"
import { createPortal } from "react-dom"
import { ArrowDown, ArrowUp, ChevronDown, EyeOff, Trash2, X } from "lucide-react"
import { toast } from "sonner"
import { cn } from "@/lib/utils"
import type { CrmRecord, EntityDef, FieldDef, ViewDef } from "@/lib/core/types"
import { dataActions } from "@/lib/core/data"
import { workspaceActions } from "@/lib/core/workspace"
import { formatMoney, formatNumber } from "@/lib/core/format"
import { ui } from "@/lib/core/ui"
import { Checkbox } from "@/components/ui/checkbox"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { FieldValue, RecordAvatar } from "@/components/crm/field-value"
import { FieldInput } from "@/components/crm/field-input"
import { EmptyState, Tag } from "@/components/crm/primitives"
import { useT } from "@/components/i18n-provider"
import { nounInSentence } from "@/lib/i18n/text"

/** Default column widths in rem, so columns grow with the member's text size. Resized widths are stored in px. */
const DEFAULT_WIDTH: Partial<Record<FieldDef["type"], number>> = {
  text: 12.5,
  longtext: 16.25,
  email: 13.75,
  phone: 10.5,
  relation: 12,
  user: 10.5,
  currency: 8.25,
  number: 7,
  percent: 8.75,
  date: 8.25,
  datetime: 11.5,
  boolean: 6.25,
  rating: 7.5,
  multiselect: 12.5,
}
const PRIMARY_WIDTH = 16.25
const FALLBACK_WIDTH = 9.5

function EditableCell({ entity, record, field }: { entity: EntityDef; record: CrmRecord; field: FieldDef }) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(record[field.key])
  const instant = ["select", "status", "multiselect", "user", "relation", "rating"].includes(field.type)
  // Computed by the server (lifetime value, stock status…).
  if (field.readOnly) {
    return (
      <div className="flex h-full min-w-0 items-center">
        <FieldValue field={field} value={record[field.key]} compact />
      </div>
    )
  }
  if (field.type === "boolean") {
    return (
      <button onClick={(e) => (e.stopPropagation(), dataActions.update(entity, record.id, { [field.key]: !record[field.key] }))} className="flex h-full items-center">
        <FieldValue field={field} value={record[field.key]} />
      </button>
    )
  }
  if (!editing) {
    return (
      <div
        className="flex h-full min-w-0 items-center"
        onDoubleClick={(e) => {
          e.stopPropagation()
          setDraft(record[field.key])
          setEditing(true)
        }}
      >
        <FieldValue field={field} value={record[field.key]} compact />
      </div>
    )
  }
  const commit = (v = draft) => {
    if (v !== record[field.key]) dataActions.update(entity, record.id, { [field.key]: v })
    setEditing(false)
  }
  return (
    <div
      className="relative z-10 -mx-1 min-w-full"
      onClick={(e) => e.stopPropagation()}
      onBlur={(e) => !instant && !e.currentTarget.contains(e.relatedTarget as Node) && commit()}
      onKeyDown={(e) => {
        if (e.key === "Enter") commit()
        if (e.key === "Escape") setEditing(false)
      }}
    >
      <FieldInput
        field={field}
        value={draft}
        autoFocus
        onChange={(v) => {
          setDraft(v)
          if (instant && field.type !== "multiselect") commit(v)
        }}
      />
    </div>
  )
}

export function TableView({ entity, view, records }: { entity: EntityDef; view: ViewDef; records: CrmRecord[] }) {
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [limit, setLimit] = useState(100)
  const resizing = useRef<{ key: string; startX: number; startW: number } | null>(null)
  const t = useT()

  const columns = useMemo(() => {
    const cols = view.columns.map((k) => entity.fields.find((f) => f.key === k)).filter(Boolean) as FieldDef[]
    const primary = entity.fields.find((f) => f.key === entity.primaryField)!
    return [primary, ...cols.filter((c) => c.key !== primary.key)]
  }, [view.columns, entity])

  const width = (f: FieldDef): number | string => view.widths?.[f.key] ?? `${f.key === entity.primaryField ? PRIMARY_WIDTH : (DEFAULT_WIDTH[f.type] ?? FALLBACK_WIDTH)}rem`
  const rowH = view.rowHeight === "tall" ? "h-[calc(var(--row-h)+0.75rem)]" : "h-[var(--row-h)]"
  const allSelected = records.length > 0 && selected.size === records.length
  const visibleRows = records.slice(0, limit)

  const startResize = (e: React.PointerEvent, f: FieldDef) => {
    e.preventDefault()
    e.stopPropagation()
    const th = (e.currentTarget as HTMLElement).closest("th")
    resizing.current = { key: f.key, startX: e.clientX, startW: th?.getBoundingClientRect().width ?? 150 }
    const move = (ev: PointerEvent) => {
      const r = resizing.current
      if (!r) return
      const w = Math.max(80, Math.min(600, r.startW + ev.clientX - r.startX))
      workspaceActions.updateView(entity.key, view.id, { widths: { ...view.widths, [r.key]: w } })
    }
    const up = () => {
      resizing.current = null
      window.removeEventListener("pointermove", move)
      window.removeEventListener("pointerup", up)
    }
    window.addEventListener("pointermove", move)
    window.addEventListener("pointerup", up)
  }

  const totals = useMemo(() => {
    const out: Record<string, string> = {}
    for (const c of columns) {
      if (c.type === "currency") out[c.key] = formatMoney(records.reduce((s, r) => s + (Number(r[c.key]) || 0), 0), { compact: true })
      else if (c.type === "number") out[c.key] = formatNumber(records.reduce((s, r) => s + (Number(r[c.key]) || 0), 0))
      else if (c.type === "percent" && records.length) out[c.key] = t("views.average", { value: Math.round(records.reduce((s, r) => s + (Number(r[c.key]) || 0), 0) / records.length) })
    }
    return out
  }, [columns, records, t])

  const bulkFields = entity.fields.filter((f) => !f.readOnly && (f.type === "status" || f.type === "select"))

  if (!records.length) {
    return (
      <div className="surface">
        <EmptyState
          icon={entity.icon}
          title={t("views.noMatch", { name: nounInSentence(entity.label) })}
          description={t("views.noMatchHint")}
          action={<Button size="sm" onClick={() => ui.openCreate(entity.key)}>{t("views.newRecord", { name: nounInSentence(entity.labelSingular) })}</Button>}
        />
      </div>
    )
  }

  return (
    <div className="surface relative overflow-hidden">
      <div className="scrollbar-thin overflow-x-auto">
        <table className="w-max min-w-full border-separate border-spacing-0 text-sm">
          <thead>
            <tr className="text-left text-xs font-medium uppercase tracking-wider text-subtle-foreground">
              <th className="sticky left-0 z-20 w-10 border-b bg-card px-3">
                <Checkbox
                  checked={allSelected ? true : selected.size ? "indeterminate" : false}
                  onCheckedChange={(v) => setSelected(v ? new Set(records.map((r) => r.id)) : new Set())}
                  aria-label={t("views.selectAll")}
                />
              </th>
              {columns.map((c, i) => {
                const sorted = view.sort?.field === c.key ? view.sort.dir : null
                return (
                  <th
                    key={c.key}
                    style={{ width: width(c), minWidth: width(c) }}
                    className={cn("group/th relative h-10 border-b bg-card px-3 font-medium", i === 0 && "sticky left-10 z-20")}
                  >
                    <DropdownMenu>
                      <DropdownMenuTrigger className="flex w-full items-center gap-1 truncate text-left uppercase outline-none hover:text-foreground">
                        <span className="truncate">{c.label}</span>
                        {sorted === "asc" && <ArrowUp className="size-3 shrink-0" />}
                        {sorted === "desc" && <ArrowDown className="size-3 shrink-0" />}
                        <ChevronDown className="size-3 shrink-0 opacity-0 group-hover/th:opacity-100" />
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="start" className="w-44">
                        <DropdownMenuItem onSelect={() => workspaceActions.updateView(entity.key, view.id, { sort: { field: c.key, dir: "asc" } })}>
                          <ArrowUp /> {t("views.sortAsc")}
                        </DropdownMenuItem>
                        <DropdownMenuItem onSelect={() => workspaceActions.updateView(entity.key, view.id, { sort: { field: c.key, dir: "desc" } })}>
                          <ArrowDown /> {t("views.sortDesc")}
                        </DropdownMenuItem>
                        {i > 0 && (
                          <>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem onSelect={() => workspaceActions.updateView(entity.key, view.id, { columns: view.columns.filter((k) => k !== c.key) })}>
                              <EyeOff /> {t("views.hideColumn")}
                            </DropdownMenuItem>
                          </>
                        )}
                      </DropdownMenuContent>
                    </DropdownMenu>
                    <span
                      onPointerDown={(e) => startResize(e, c)}
                      className="absolute right-0 top-2 bottom-2 w-1.5 cursor-col-resize rounded-full opacity-0 transition-opacity hover:bg-brand/60 hover:opacity-100 group-hover/th:opacity-100 group-hover/th:bg-border-strong"
                    />
                  </th>
                )
              })}
              <th className="w-full border-b bg-card" />
            </tr>
          </thead>
          <tbody>
            {visibleRows.map((r) => {
              const isSel = selected.has(r.id)
              return (
                <tr
                  key={r.id}
                  onClick={() => ui.peek(entity.key, r.id)}
                  className={cn("group/row cursor-pointer", isSel ? "[&>td]:bg-brand-soft/50" : "[&>td]:bg-card hover:[&>td]:bg-elevated")}
                >
                  <td className={cn("sticky left-0 z-10 border-b px-3", rowH)} onClick={(e) => e.stopPropagation()}>
                    <Checkbox
                      checked={isSel}
                      onCheckedChange={(v) =>
                        setSelected((s) => {
                          const n = new Set(s)
                          if (v) n.add(r.id)
                          else n.delete(r.id)
                          return n
                        })
                      }
                      aria-label={t("views.selectRow")}
                    />
                  </td>
                  {columns.map((c, i) => (
                    <td
                      key={c.key}
                      style={{ width: width(c), maxWidth: width(c) }}
                      className={cn("border-b px-3", rowH, i === 0 && "sticky left-10 z-10 border-r")}
                    >
                      {i === 0 ? (
                        <div className="flex min-w-0 items-center gap-2.5">
                          <RecordAvatar entity={entity} record={r} size="sm" />
                          <span className="truncate font-medium">{String(r[c.key] ?? t("common.untitled"))}</span>
                        </div>
                      ) : (
                        <EditableCell entity={entity} record={r} field={c} />
                      )}
                    </td>
                  ))}
                  <td className="border-b" />
                </tr>
              )
            })}
          </tbody>
          <tfoot>
            <tr className="text-xs text-muted-foreground">
              <td className="sticky left-0 z-10 bg-card" />
              {columns.map((c, i) => (
                <td key={c.key} className={cn("h-9 bg-card px-3 tabular", i === 0 && "sticky left-10 z-10")}>
                  {i === 0 ? t("views.recordsCount", { count: records.length }) : totals[c.key] ? <span className="font-medium text-foreground">{totals[c.key]}</span> : null}
                </td>
              ))}
              <td className="bg-card" />
            </tr>
          </tfoot>
        </table>
      </div>
      {records.length > limit && (
        <div className="border-t p-2 text-center">
          <Button variant="ghost" size="sm" onClick={() => setLimit((l) => l + 100)}>
            {t("views.showMore", { count: records.length - limit })}
          </Button>
        </div>
      )}

      {/* Portaled: the view wrapper's `rise` transform would otherwise anchor this bar to the table instead of the viewport. */}
      {selected.size > 0 && createPortal(
        <div className="rise fixed bottom-6 left-1/2 z-40 flex -translate-x-1/2 items-center gap-2 rounded-xl border bg-popover p-1.5 pl-3 shadow-[var(--shadow-pop)]">
          <span className="text-sm font-medium tabular">{t("views.selected", { count: selected.size })}</span>
          {bulkFields.length > 0 && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="sm">
                  {t("views.setField")} <ChevronDown />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent className="w-52">
                {bulkFields.map((f) => (
                  <DropdownMenuSub key={f.key}>
                    <DropdownMenuSubTrigger>{f.label}</DropdownMenuSubTrigger>
                    <DropdownMenuSubContent>
                      <DropdownMenuLabel className="text-xs text-muted-foreground">{f.label}</DropdownMenuLabel>
                      {f.options?.map((o) => (
                        <DropdownMenuItem
                          key={o.value}
                          onSelect={() => {
                            selected.forEach((id) => dataActions.update(entity, id, { [f.key]: o.value }))
                            toast.success(t("views.updatedCount", { count: selected.size }))
                          }}
                        >
                          <Tag color={o.color}>{o.label}</Tag>
                        </DropdownMenuItem>
                      ))}
                    </DropdownMenuSubContent>
                  </DropdownMenuSub>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
          <Button
            variant="outline"
            size="sm"
            className="text-destructive"
            onClick={() => {
              dataActions.remove(entity, [...selected])
              toast(t("views.deletedCount", { count: selected.size }))
              setSelected(new Set())
            }}
          >
            <Trash2 /> {t("common.delete")}
          </Button>
          <Button variant="ghost" size="icon-sm" onClick={() => setSelected(new Set())} aria-label={t("views.clearSelection")}>
            <X />
          </Button>
        </div>,
        document.body,
      )}
    </div>
  )
}
