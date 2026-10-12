"use client"

import { useState } from "react"
import {
  ArrowDownUp,
  ArrowDown,
  ArrowUp,
  Calendar,
  Columns3,
  Copy,
  Eye,
  EyeOff,
  Filter,
  GalleryVerticalEnd,
  GripVertical,
  Kanban,
  List,
  MoreHorizontal,
  Pencil,
  Plus,
  Rows3,
  Search,
  Table2,
  Trash2,
  X,
} from "lucide-react"
import { cn } from "@/lib/utils"
import type { EntityDef, FilterOp, FilterRule, ViewDef, ViewType } from "@/lib/core/types"
import { uid } from "@/lib/core/store"
import { workspaceActions } from "@/lib/core/workspace"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Switch } from "@/components/ui/switch"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { useT } from "@/components/i18n-provider"
import { useDefaultName } from "@/lib/core/schema-i18n"

/** View layouts; names and hints are in views.types.<type>. */
export const VIEW_TYPES: { type: ViewType; icon: typeof Table2 }[] = [
  { type: "table", icon: Table2 },
  { type: "board", icon: Kanban },
  { type: "gallery", icon: GalleryVerticalEnd },
  { type: "list", icon: List },
  { type: "calendar", icon: Calendar },
]

export const viewIcon = (t: ViewType) => VIEW_TYPES.find((v) => v.type === t)?.icon ?? Table2

function canUse(entity: EntityDef, t: ViewType) {
  if (t === "board") return entity.fields.some((f) => f.type === "status" || f.type === "select")
  if (t === "calendar") return entity.fields.some((f) => f.type === "date" || f.type === "datetime")
  return true
}

/* -------------------------------------------------------------------------- */

export function ViewTabs({ entity, views, active }: { entity: EntityDef; views: ViewDef[]; active: ViewDef }) {
  const [renaming, setRenaming] = useState<string | null>(null)
  const t = useT()
  const dn = useDefaultName()
  return (
    <div className="flex min-w-0 items-center gap-1 overflow-x-auto scrollbar-none">
      {views.map((v) => {
        const I = viewIcon(v.type)
        const isActive = v.id === active.id
        return (
          <div key={v.id} className="group/tab relative flex shrink-0 items-center">
            {renaming === v.id ? (
              <Input
                autoFocus
                defaultValue={dn(v.name)}
                className="h-8 w-40"
                onBlur={(e) => {
                  const name = e.target.value.trim()
                  if (name && name !== dn(v.name)) workspaceActions.updateView(entity.key, v.id, { name })
                  setRenaming(null)
                }}
                onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
              />
            ) : (
              <button
                onClick={() => workspaceActions.setActiveView(entity.key, v.id)}
                onDoubleClick={() => setRenaming(v.id)}
                className={cn(
                  "flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-sm font-medium transition-colors",
                  isActive ? "bg-card text-foreground shadow-[var(--shadow-card)] ring-1 ring-border" : "text-muted-foreground hover:bg-accent hover:text-foreground",
                )}
              >
                <I className="size-3.5" />
                {dn(v.name)}
              </button>
            )}
            {isActive && renaming !== v.id && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button className="ml-0.5 flex size-6 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground" aria-label={t("views.options")}>
                    <MoreHorizontal className="size-3.5" />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="w-48">
                  <DropdownMenuItem onSelect={() => setRenaming(v.id)}>
                    <Pencil /> {t("common.rename")}
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onSelect={() => {
                      const { id: _i, entity: _e, ...rest } = v
                      workspaceActions.addView(entity.key, { ...rest, name: t("views.copyName", { name: dn(v.name) }), filters: v.filters.map((f) => ({ ...f, id: uid("f") })) })
                    }}
                  >
                    <Copy /> {t("common.duplicate")}
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuLabel className="text-xs text-muted-foreground">{t("views.layout")}</DropdownMenuLabel>
                  {VIEW_TYPES.filter((vt) => canUse(entity, vt.type)).map((vt) => (
                    <DropdownMenuItem key={vt.type} onSelect={() => workspaceActions.updateView(entity.key, v.id, { type: vt.type })}>
                      <vt.icon /> {t(`views.types.${vt.type}.label`)}
                      {vt.type === v.type && <span className="ml-auto size-1.5 rounded-full bg-brand" />}
                    </DropdownMenuItem>
                  ))}
                  <DropdownMenuSeparator />
                  <DropdownMenuItem variant="destructive" disabled={views.length < 2} onSelect={() => workspaceActions.removeView(entity.key, v.id)}>
                    <Trash2 /> {t("views.deleteView")}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </div>
        )
      })}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button className="flex h-8 shrink-0 items-center gap-1 rounded-lg px-2 text-sm text-muted-foreground hover:bg-accent hover:text-foreground">
            <Plus className="size-3.5" /> {t("views.view")}
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-72">
          <DropdownMenuLabel className="text-xs text-muted-foreground">{t("views.newView")}</DropdownMenuLabel>
          {VIEW_TYPES.map((vt) => (
            <DropdownMenuItem
              key={vt.type}
              disabled={!canUse(entity, vt.type)}
              onSelect={() =>
                workspaceActions.addView(entity.key, {
                  name: t(`views.types.${vt.type}.label`),
                  type: vt.type,
                  columns: vt.type === "table" ? entity.fields.slice(0, 7).map((f) => f.key) : entity.fields.slice(1, 5).map((f) => f.key),
                  filters: [],
                })
              }
            >
              <vt.icon />
              <div>
                <p>{t(`views.types.${vt.type}.label`)}</p>
                <p className="text-xs text-muted-foreground">{t(`views.types.${vt.type}.hint`)}</p>
              </div>
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}

/* -------------------------------------------------------------------------- */

const OPS: FilterOp[] = ["is", "is_not", "contains", "not_contains", "gt", "lt", "empty", "not_empty"]

function FilterValue({ entity, rule, onChange }: { entity: EntityDef; rule: FilterRule; onChange: (v: string) => void }) {
  const field = entity.fields.find((f) => f.key === rule.field)
  const t = useT()
  if (rule.op === "empty" || rule.op === "not_empty") return <div className="flex-1" />
  if (field?.options && (rule.op === "is" || rule.op === "is_not")) {
    return (
      <Select value={rule.value ?? ""} onValueChange={onChange}>
        <SelectTrigger size="sm" className="h-8 flex-1">
          <SelectValue placeholder={t("views.value")} />
        </SelectTrigger>
        <SelectContent>
          {field.options.map((o) => (
            <SelectItem key={o.value} value={o.value}>
              {o.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    )
  }
  const isDate = field?.type === "date" || field?.type === "datetime"
  const isNum = field && ["number", "currency", "percent", "rating"].includes(field.type)
  return (
    <Input
      className="h-8 flex-1"
      type={isDate ? "date" : isNum ? "number" : "text"}
      value={rule.value ?? ""}
      onChange={(e) => onChange(e.target.value)}
      placeholder={t("views.value")}
    />
  )
}

export function FilterButton({ entity, view }: { entity: EntityDef; view: ViewDef }) {
  const update = (filters: FilterRule[]) => workspaceActions.updateView(entity.key, view.id, { filters })
  const active = view.filters.filter((f) => f.field).length
  const t = useT()
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" className={cn(active && "border-brand/50 text-brand")}>
          <Filter /> {t("views.filter")}{active ? ` · ${active}` : ""}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[min(36rem,calc(100vw-2rem))] p-3">
        <p className="mb-2.5 text-xs font-semibold text-muted-foreground">{t("views.showWhere")}</p>
        <div className="flex flex-col gap-2">
          {view.filters.length === 0 && <p className="rounded-lg border border-dashed p-3 text-center text-xs text-muted-foreground">{t("views.noFilters")}</p>}
          {view.filters.map((rule, i) => (
            <div key={rule.id} className="flex flex-wrap items-center gap-1.5 sm:flex-nowrap">
              <span className="w-12 shrink-0 text-xs text-muted-foreground">{i === 0 ? t("views.where") : t("views.and")}</span>
              <Select value={rule.field} onValueChange={(v) => update(view.filters.map((f) => (f.id === rule.id ? { ...f, field: v, value: "" } : f)))}>
                <SelectTrigger size="sm" className="h-8 w-36">
                  <SelectValue placeholder={t("views.field")} />
                </SelectTrigger>
                <SelectContent>
                  {entity.fields.map((f) => (
                    <SelectItem key={f.key} value={f.key}>
                      {f.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select value={rule.op} onValueChange={(v) => update(view.filters.map((f) => (f.id === rule.id ? { ...f, op: v as FilterOp } : f)))}>
                <SelectTrigger size="sm" className="h-8 w-40">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {OPS.map((op) => (
                    <SelectItem key={op} value={op}>
                      {t(`views.ops.${op}`)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <FilterValue entity={entity} rule={rule} onChange={(v) => update(view.filters.map((f) => (f.id === rule.id ? { ...f, value: v } : f)))} />
              <Button variant="ghost" size="icon-xs" onClick={() => update(view.filters.filter((f) => f.id !== rule.id))} aria-label={t("views.removeFilter")}>
                <X />
              </Button>
            </div>
          ))}
        </div>
        <div className="mt-3 flex justify-between">
          <Button variant="ghost" size="xs" onClick={() => update([...view.filters, { id: uid("f"), field: entity.fields[0].key, op: "contains", value: "" }])}>
            <Plus /> {t("views.addFilter")}
          </Button>
          {view.filters.length > 0 && (
            <Button variant="ghost" size="xs" onClick={() => update([])}>
              {t("views.clearAll")}
            </Button>
          )}
        </div>
      </PopoverContent>
    </Popover>
  )
}

export function SortButton({ entity, view }: { entity: EntityDef; view: ViewDef }) {
  const sort = view.sort
  const label = sort ? entity.fields.find((f) => f.key === sort.field)?.label : null
  const t = useT()
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" className={cn(sort && "border-brand/50 text-brand")}>
          <ArrowDownUp /> {label ? `${label}` : t("views.sort")}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72 p-3">
        <p className="mb-2.5 text-xs font-semibold text-muted-foreground">{t("views.sortBy")}</p>
        <div className="flex gap-1.5">
          <Select value={sort?.field ?? ""} onValueChange={(v) => workspaceActions.updateView(entity.key, view.id, { sort: { field: v, dir: sort?.dir ?? "asc" } })}>
            <SelectTrigger size="sm" className="h-8 flex-1">
              <SelectValue placeholder={t("views.chooseField")} />
            </SelectTrigger>
            <SelectContent>
              {entity.fields.map((f) => (
                <SelectItem key={f.key} value={f.key}>
                  {f.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            variant="outline"
            size="icon-sm"
            disabled={!sort}
            onClick={() => sort && workspaceActions.updateView(entity.key, view.id, { sort: { ...sort, dir: sort.dir === "asc" ? "desc" : "asc" } })}
            aria-label={t("views.toggleDirection")}
          >
            {sort?.dir === "desc" ? <ArrowDown /> : <ArrowUp />}
          </Button>
        </div>
        {sort && (
          <Button variant="ghost" size="xs" className="mt-2" onClick={() => workspaceActions.updateView(entity.key, view.id, { sort: undefined })}>
            {t("views.removeSort")}
          </Button>
        )}
      </PopoverContent>
    </Popover>
  )
}

export function GroupButton({ entity, view }: { entity: EntityDef; view: ViewDef }) {
  const options = entity.fields.filter((f) => f.type === "status" || f.type === "select" || f.type === "user")
  const current = view.groupBy ?? (view.type === "board" ? entity.stageField : undefined)
  const t = useT()
  return (
    <Select
      value={current ?? "__none"}
      onValueChange={(v) => workspaceActions.updateView(entity.key, view.id, { groupBy: v === "__none" ? undefined : v })}
    >
      <SelectTrigger size="sm" className="h-8 gap-1.5 text-sm font-medium">
        <Rows3 className="size-3.5" />
        <span className="text-muted-foreground">{t("views.group")}</span>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {view.type !== "board" && <SelectItem value="__none">{t("views.none")}</SelectItem>}
        {options.map((f) => (
          <SelectItem key={f.key} value={f.key}>
            {f.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

export function FieldsButton({ entity, view }: { entity: EntityDef; view: ViewDef }) {
  const [drag, setDrag] = useState<string | null>(null)
  const visible = view.columns.filter((c) => entity.fields.some((f) => f.key === c))
  const hidden = entity.fields.filter((f) => !visible.includes(f.key))
  const setCols = (columns: string[]) => workspaceActions.updateView(entity.key, view.id, { columns })
  const t = useT()
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm">
          <Columns3 /> {t("views.fields")}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72 p-2">
        <p className="px-2 pb-1.5 pt-1 text-xs font-semibold text-muted-foreground">{t("views.shownHint")}</p>
        <ul className="flex flex-col">
          {visible.map((key) => {
            const f = entity.fields.find((x) => x.key === key)!
            const locked = view.type === "table" && key === entity.primaryField
            return (
              <li
                key={key}
                draggable
                onDragStart={() => setDrag(key)}
                onDragOver={(e) => {
                  e.preventDefault()
                  if (!drag || drag === key) return
                  const next = visible.filter((k) => k !== drag)
                  next.splice(next.indexOf(key), 0, drag)
                  setCols(next)
                }}
                onDragEnd={() => setDrag(null)}
                className={cn("flex h-8 items-center gap-2 rounded-md px-1.5 text-sm hover:bg-accent", drag === key && "opacity-50")}
              >
                <GripVertical className="size-3.5 cursor-grab text-subtle-foreground" />
                <span className="flex-1 truncate">{f.label}</span>
                <button disabled={locked} onClick={() => setCols(visible.filter((k) => k !== key))} className="text-muted-foreground hover:text-foreground disabled:opacity-30" aria-label={t("views.hideField", { name: f.label })}>
                  <Eye className="size-3.5" />
                </button>
              </li>
            )
          })}
        </ul>
        {hidden.length > 0 && (
          <>
            <p className="px-2 pb-1.5 pt-3 text-xs font-semibold text-muted-foreground">{t("views.hidden")}</p>
            <ul>
              {hidden.map((f) => (
                <li key={f.key} className="flex h-8 items-center gap-2 rounded-md px-1.5 pl-7 text-sm text-muted-foreground hover:bg-accent">
                  <span className="flex-1 truncate">{f.label}</span>
                  <button onClick={() => setCols([...visible, f.key])} className="hover:text-foreground" aria-label={t("views.showField", { name: f.label })}>
                    <EyeOff className="size-3.5" />
                  </button>
                </li>
              ))}
            </ul>
          </>
        )}
        {view.type === "table" && (
          <div className="mt-2 flex items-center justify-between border-t px-2 pt-2.5 text-sm">
            <span>{t("views.tallRows")}</span>
            <Switch checked={view.rowHeight === "tall"} onCheckedChange={(v) => workspaceActions.updateView(entity.key, view.id, { rowHeight: v ? "tall" : "medium" })} />
          </div>
        )}
      </PopoverContent>
    </Popover>
  )
}

export function SearchBox({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder: string }) {
  return (
    <div className="relative">
      <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
      <Input value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} className="h-8 w-48 pl-8 text-sm text-ellipsis 2xl:w-56" />
    </div>
  )
}
