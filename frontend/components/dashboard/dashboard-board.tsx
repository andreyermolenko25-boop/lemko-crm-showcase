"use client"

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import type React from "react"
import { AnimatePresence, motion } from "motion/react"
import { Check, Copy, GripVertical, LayoutGrid, Maximize2, Plus, Search, Settings2, Sparkles, Trash2, Wand2, X } from "lucide-react"
import { toast } from "sonner"
import { cn } from "@/lib/utils"
import type { DashboardDef, WidgetInstance } from "@/lib/core/types"
import { uid } from "@/lib/core/store"
import { useEntities, useWorkspace, workspaceActions } from "@/lib/core/workspace"
import { Icon } from "@/lib/core/icons"
import { applyCells, clampCell, compact, COLS, findSpot, MAX_H, minSizeFor, sameCells, settle, toCells, type Cell, type MinSize } from "@/lib/core/grid-layout"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { getWidget, WIDGETS } from "@/components/dashboard/widgets"
import { IconTile } from "@/components/crm/primitives"
import { useI18n, useT } from "@/components/i18n-provider"
import { useDefaultName } from "@/lib/core/schema-i18n"

/** Row height of the dashboard grid; widths come from 12 equal columns. */
const ROW_H = "8.25rem"
/** Below this board width the free layout collapses into a simple stack. */
const FREE_MIN_WIDTH = 840
const WIDTH_PRESETS = [2, 3, 4, 6, 8, 12]
const HEIGHT_PRESETS = [1, 2, 3, 4]

/* -------------------------------------------------------------------------- */
/*  Per-widget configuration                                                    */
/* -------------------------------------------------------------------------- */

function WidgetSettings({ widget, onChange }: { widget: WidgetInstance; onChange: (w: WidgetInstance) => void }) {
  const entities = useEntities()
  const c = widget.config
  const entity = entities.find((e) => e.key === (c.entity as string))
  const setCfg = (patch: Record<string, unknown>) => onChange({ ...widget, config: { ...c, ...patch } })
  const hasEntity = !["activity", "notes", "code"].includes(widget.type)
  const fieldTypes = widget.type === "breakdown" ? ["select", "status"] : ["currency", "number", "percent", "rating"]
  const fieldOpts = entity?.fields.filter((f) => fieldTypes.includes(f.type)) ?? []
  const t = useT()
  const dn = useDefaultName()

  return (
    <div className="flex flex-col gap-3">
      <div className="grid gap-1.5">
        <Label className="text-xs">{t("dashboard.title")}</Label>
        <Input
          className="h-8"
          defaultValue={dn((widget.title as string) ?? (c.label as string) ?? (c.title as string) ?? "")}
          onBlur={(e) => onChange({ ...widget, title: e.target.value || undefined, config: widget.type === "kpi" ? { ...c, label: e.target.value } : c })}
        />
      </div>
      {hasEntity && (
        <div className="grid gap-1.5">
          <Label className="text-xs">{t("dashboard.object")}</Label>
          <Select value={(c.entity as string) ?? ""} onValueChange={(v) => setCfg({ entity: v, field: undefined, filterStage: undefined })}>
            <SelectTrigger size="sm" className="h-8 w-full">
              <SelectValue placeholder={t("dashboard.chooseObject")} />
            </SelectTrigger>
            <SelectContent>
              {entities.map((e) => (
                <SelectItem key={e.key} value={e.key}>
                  {e.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}
      {widget.type === "kpi" && (
        <div className="grid gap-1.5">
          <Label className="text-xs">{t("dashboard.metric")}</Label>
          <Select value={(c.metric as string) ?? "count"} onValueChange={(v) => setCfg({ metric: v })}>
            <SelectTrigger size="sm" className="h-8 w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="count">{t("dashboard.metrics.count")}</SelectItem>
              <SelectItem value="sum">{t("dashboard.metrics.sum")}</SelectItem>
              <SelectItem value="avg">{t("dashboard.metrics.avg")}</SelectItem>
              <SelectItem value="conversion">{t("dashboard.metrics.conversion")}</SelectItem>
            </SelectContent>
          </Select>
        </div>
      )}
      {(widget.type === "breakdown" || widget.type === "trend" || (widget.type === "kpi" && ["sum", "avg"].includes(c.metric as string))) && fieldOpts.length > 0 && (
        <div className="grid gap-1.5">
          <Label className="text-xs">{t("dashboard.field")}</Label>
          <Select value={(c.field as string) ?? ""} onValueChange={(v) => setCfg({ field: v })}>
            <SelectTrigger size="sm" className="h-8 w-full">
              <SelectValue placeholder={t("dashboard.default")} />
            </SelectTrigger>
            <SelectContent>
              {fieldOpts.map((f) => (
                <SelectItem key={f.key} value={f.key}>
                  {f.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}
      {widget.type === "goal" && (
        <div className="grid gap-1.5">
          <Label className="text-xs">{t("dashboard.period")}</Label>
          <Select value={(c.range as string) ?? "quarter"} onValueChange={(v) => setCfg({ range: v })}>
            <SelectTrigger size="sm" className="h-8 w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="month">{t("dashboard.periods.month")}</SelectItem>
              <SelectItem value="quarter">{t("dashboard.periods.quarter")}</SelectItem>
              <SelectItem value="year">{t("dashboard.periods.year")}</SelectItem>
              <SelectItem value="all">{t("dashboard.periods.all")}</SelectItem>
            </SelectContent>
          </Select>
        </div>
      )}
      {(widget.type === "goal" || widget.type === "kpi" || widget.type === "trend") && (
        <div className="grid gap-1.5">
          <Label className="text-xs">{widget.type === "trend" ? t("dashboard.planOptional") : t("dashboard.targetOptional")}</Label>
          <Input className="h-8" type="number" defaultValue={(c.target as number) ?? ""} onBlur={(e) => setCfg({ target: e.target.value ? Number(e.target.value) : undefined })} />
        </div>
      )}
      {(widget.type === "records" || widget.type === "agenda" || widget.type === "activity") && (
        <div className="grid gap-1.5">
          <Label className="text-xs">{t("dashboard.rows")}</Label>
          <Select value={String(c.limit ?? 4)} onValueChange={(v) => setCfg({ limit: Number(v) })}>
            <SelectTrigger size="sm" className="h-8 w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {[3, 4, 5, 6, 8, 10].map((n) => (
                <SelectItem key={n} value={String(n)}>
                  {n}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}
    </div>
  )
}


/* -------------------------------------------------------------------------- */
/*  Widget gallery                                                              */
/* -------------------------------------------------------------------------- */

type GalleryGroup = "all" | "metrics" | "charts" | "tables" | "misc"

const GROUP_OF: Record<string, GalleryGroup> = {
  kpi: "metrics",
  goal: "metrics",
  stages: "metrics",
  trend: "charts",
  funnel: "charts",
  breakdown: "charts",
  records: "tables",
  leaderboard: "tables",
  agenda: "tables",
  activity: "tables",
  notes: "misc",
}

const GROUPS: { key: GalleryGroup; label: string; icon: string }[] = [
  { key: "all", label: "Everything", icon: "dashboard" },
  { key: "metrics", label: "Metrics", icon: "gauge" },
  { key: "charts", label: "Charts", icon: "chart-line" },
  { key: "tables", label: "Tables & lists", icon: "checklist" },
  { key: "misc", label: "Other", icon: "file" },
]

type GalleryItem = { key: string; name: string; description: string; group: GalleryGroup; size: { w: number; h: number }; tile: React.ReactNode; badge?: string; make: () => WidgetInstance }

/* A tiny 12×4 map of the footprint the widget takes on the board. */
function Footprint({ w, h }: { w: number; h: number }) {
  return (
    <span className="grid w-full grid-cols-12 gap-[2px]" aria-hidden>
      {Array.from({ length: 12 * 3 }, (_, i) => {
        const x = i % 12
        const y = Math.floor(i / 12)
        const on = x < w && y < Math.min(h, 3)
        return <span key={i} className={cn("h-1.5 rounded-[2px] transition-colors duration-300", on ? "bg-brand/70 group-hover/card:bg-brand" : "bg-foreground/[0.07]")} />
      })}
    </span>
  )
}

function AddWidgetDialog({ open, onOpenChange, onAdd }: { open: boolean; onOpenChange: (o: boolean) => void; onAdd: (w: WidgetInstance) => void }) {
  const { t, maybe } = useI18n()
  const [group, setGroup] = useState<GalleryGroup>("all")
  const [query, setQuery] = useState("")

  const items = useMemo<GalleryItem[]>(() => {
    const builtIn: GalleryItem[] = WIDGETS.map((w) => {
      const min = minSizeFor(w.type)
      const size = { w: Math.max(w.defaultSize.w, min.w), h: Math.max(w.defaultSize.h, min.h) }
      return {
        key: w.type,
        name: maybe(`widgets.types.${w.type}.name`) ?? w.name,
        description: maybe(`widgets.types.${w.type}.description`) ?? w.description,
        group: GROUP_OF[w.type] ?? "misc",
        size,
        tile: <IconTile icon={w.icon} color={GROUP_OF[w.type] === "tables" ? "teal" : GROUP_OF[w.type] === "charts" ? "blue" : GROUP_OF[w.type] === "metrics" ? "violet" : "gray"} size="lg" />,
        make: () => ({ id: uid("w"), type: w.type, size, config: { ...w.defaultConfig } }),
      }
    })
    return builtIn
  }, [maybe])

  const q = query.trim().toLowerCase()
  const shown = items.filter((i) => (group === "all" || i.group === group) && (!q || `${i.name} ${i.description}`.toLowerCase().includes(q)))
  const count = (g: GalleryGroup) => (g === "all" ? items.length : items.filter((i) => i.group === g).length)

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        onOpenChange(o)
        if (!o) {
          setQuery("")
          setGroup("all")
        }
      }}
    >
      <DialogContent className="gap-0 overflow-hidden p-0 sm:max-w-3xl">
        <div className="relative border-b px-6 pb-5 pt-6">
          <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(60%_120%_at_0%_0%,color-mix(in_oklch,var(--brand)_14%,transparent),transparent_70%)]" />
          <div className="relative flex items-center gap-3">
            <span className="flex size-10 items-center justify-center rounded-xl bg-brand text-brand-foreground shadow-[0_6px_20px_-6px_var(--brand)]">
              <Sparkles className="size-5" />
            </span>
            <div>
              <DialogTitle className="text-lg font-semibold tracking-tight">{t("dashboard.galleryTitle")}</DialogTitle>
              <DialogDescription className="text-sm text-muted-foreground">{t("dashboard.galleryDescription")}</DialogDescription>
            </div>
          </div>
          <div className="relative mt-4 flex h-10 items-center gap-2 rounded-xl border bg-card px-3 focus-within:border-brand/60 focus-within:ring-3 focus-within:ring-ring/20">
            <Search className="size-4 text-muted-foreground" />
            <input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t("dashboard.searchWidgets")}
              className="w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground/70"
            />
          </div>
        </div>

        <div className="grid sm:grid-cols-[12.5rem_1fr]">
          <nav className="flex gap-1 overflow-x-auto border-b p-2 scrollbar-none sm:flex-col sm:border-b-0 sm:border-r sm:p-3">
            {GROUPS.filter((g) => count(g.key) > 0).map((g) => (
              <button
                key={g.key}
                onClick={() => setGroup(g.key)}
                className={cn(
                  "relative flex h-9 shrink-0 items-center gap-2.5 rounded-lg px-2.5 text-sm font-medium transition-colors",
                  group === g.key ? "text-foreground" : "text-muted-foreground hover:text-foreground",
                )}
              >
                {group === g.key && <motion.span layoutId="gallery-group" className="absolute inset-0 rounded-lg bg-accent" transition={{ type: "spring", stiffness: 500, damping: 38 }} />}
                <Icon name={g.icon} className="relative size-4" />
                <span className="relative">{t(`dashboard.groups.${g.key}`)}</span>
                <span className="relative ml-auto pl-2 text-xs tabular text-subtle-foreground">{count(g.key)}</span>
              </button>
            ))}
          </nav>

          <div className="grid max-h-[min(60dvh,32rem)] auto-rows-min grid-cols-1 gap-3 overflow-y-auto p-4 sm:grid-cols-2">
            <AnimatePresence mode="popLayout" initial={false}>
              {shown.map((item, i) => (
                <motion.button
                  key={item.key}
                  layout
                  initial={{ opacity: 0, y: 8, scale: 0.98 }}
                  animate={{ opacity: 1, y: 0, scale: 1, transition: { delay: Math.min(i, 8) * 0.025, duration: 0.25, ease: [0.22, 1, 0.36, 1] } }}
                  exit={{ opacity: 0, scale: 0.97, transition: { duration: 0.12 } }}
                  whileHover={{ y: -2 }}
                  whileTap={{ scale: 0.985 }}
                  onClick={() => {
                    onAdd(item.make())
                    onOpenChange(false)
                  }}
                  className="group/card flex flex-col gap-3 rounded-2xl border bg-card p-4 text-left shadow-xs transition-[border-color,box-shadow] hover:border-brand/40 hover:shadow-[var(--shadow-pop)]"
                >
                  <span className="flex items-start gap-3">
                    {item.tile}
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-1.5 text-sm font-semibold">
                        <span className="truncate">{item.name}</span>
                        {item.badge && <span className="rounded bg-muted px-1 text-2xs font-medium text-muted-foreground">{item.badge}</span>}
                      </span>
                      <span className="mt-0.5 line-clamp-2 block text-xs text-muted-foreground">{item.description}</span>
                    </span>
                    <span className="flex size-7 shrink-0 items-center justify-center rounded-full border text-muted-foreground opacity-0 transition-all group-hover/card:border-brand/40 group-hover/card:text-brand group-hover/card:opacity-100">
                      <Plus className="size-3.5" />
                    </span>
                  </span>
                  <span className="flex items-center gap-3">
                    <Footprint w={item.size.w} h={item.size.h} />
                    <span className="shrink-0 text-2xs font-medium tabular text-subtle-foreground">
                      {item.size.w}×{item.size.h}
                    </span>
                  </span>
                </motion.button>
              ))}
            </AnimatePresence>
            {shown.length === 0 && <p className="col-span-full py-12 text-center text-sm text-muted-foreground">{t("dashboard.noMatch", { query })}</p>}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}

/* -------------------------------------------------------------------------- */
/*  Board                                                                       */
/* -------------------------------------------------------------------------- */

type DragKind = "move" | "resize" | "resize-x" | "resize-y"

type Drag = {
  id: string
  kind: DragKind
  /** Pointer position when the gesture started. */
  px: number
  py: number
  dx: number
  dy: number
  orig: Cell
  min: MinSize
  /** Layout when the gesture started — previews are always computed from it, so they are reversible. */
  base: Cell[]
  /** Live preview. */
  cells: Cell[]
}

type Metrics = { width: number; stepX: number; stepY: number }

function nextCell(d: Drag, gx: number, gy: number): Cell {
  const o = d.orig
  if (d.kind === "move") return clampCell({ ...o, x: o.x + gx, y: o.y + gy }, d.min)
  const w = d.kind === "resize-y" ? o.w : Math.min(o.w + gx, COLS - o.x)
  const h = d.kind === "resize-x" ? o.h : o.h + gy
  return clampCell({ ...o, w: Math.max(w, d.min.w), h }, d.min)
}

export function DashboardBoard({ dashboard, editing, onExitEdit }: { dashboard: DashboardDef; editing: boolean; onExitEdit: () => void }) {
  const [draft, setDraft] = useState<DashboardDef | null>(null)
  const [adding, setAdding] = useState(false)
  const [drag, setDrag] = useState<Drag | null>(null)
  const [metrics, setMetrics] = useState<Metrics>({ width: 0, stepX: 0, stepY: 0 })
  const gridRef = useRef<HTMLDivElement>(null)
  const dragRef = useRef<Drag | null>(null)
  const metricsRef = useRef(metrics)
  metricsRef.current = metrics

  const current = editing ? (draft ?? dashboard) : dashboard
  const { t, maybe } = useI18n()
  const dn = useDefaultName()
  const update = (fn: (d: DashboardDef) => DashboardDef) => setDraft((d) => fn(d ?? dashboard))
  const updateWidget = (w: WidgetInstance) => {
    if (editing) update((d) => ({ ...d, widgets: d.widgets.map((x) => (x.id === w.id ? w : x)) }))
    else workspaceActions.saveDashboard({ ...dashboard, widgets: dashboard.widgets.map((x) => (x.id === w.id ? w : x)) })
  }
  const commit = (cells: Cell[]) => update((d) => ({ ...d, widgets: applyCells(d.widgets, cells) }))

  const widgets = useMemo(() => current.widgets.filter((w) => getWidget(w.type)), [current.widgets])
  const cells = useMemo(() => toCells(widgets), [widgets])
  const free = metrics.width >= FREE_MIN_WIDTH
  const canArrange = editing && free

  /* Column/row pitch in px, so pointer deltas can be turned into grid cells. */
  useLayoutEffect(() => {
    const el = gridRef.current
    if (!el) return
    const measure = () => {
      const cs = getComputedStyle(el)
      const gapX = parseFloat(cs.columnGap) || 0
      const gapY = parseFloat(cs.rowGap) || 0
      const row = parseFloat(cs.gridAutoRows) || 132
      const width = el.clientWidth
      setMetrics({ width, stepX: (width - gapX * (COLS - 1)) / COLS + gapX, stepY: row + gapY })
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const gesture = drag ? `${drag.id}:${drag.kind}` : null
  useEffect(() => {
    if (!gesture) return
    const onMove = (e: PointerEvent) => {
      const d = dragRef.current
      const m = metricsRef.current
      if (!d || !m.stepX) return
      const dx = e.clientX - d.px
      const dy = e.clientY - d.py
      const target = nextCell(d, Math.round(dx / m.stepX), Math.round(dy / m.stepY))
      const prev = d.cells.find((c) => c.id === d.id)
      const moved = !prev || prev.x !== target.x || prev.y !== target.y || prev.w !== target.w || prev.h !== target.h
      const next: Drag = { ...d, dx, dy, cells: moved ? settle(d.base, target) : d.cells }
      dragRef.current = next
      setDrag(next)
    }
    const finish = (save: boolean) => {
      const d = dragRef.current
      dragRef.current = null
      setDrag(null)
      if (save && d && !sameCells(d.cells, d.base)) commit(d.cells)
    }
    const onUp = () => finish(true)
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && finish(false)
    const cursor = gesture.endsWith("resize-x") ? "ew-resize" : gesture.endsWith("resize-y") ? "ns-resize" : gesture.endsWith("resize") ? "nwse-resize" : "grabbing"
    document.body.style.cursor = cursor
    document.body.style.userSelect = "none"
    window.addEventListener("pointermove", onMove)
    window.addEventListener("pointerup", onUp)
    window.addEventListener("pointercancel", onUp)
    window.addEventListener("keydown", onKey)
    return () => {
      document.body.style.cursor = ""
      document.body.style.userSelect = ""
      window.removeEventListener("pointermove", onMove)
      window.removeEventListener("pointerup", onUp)
      window.removeEventListener("pointercancel", onUp)
      window.removeEventListener("keydown", onKey)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gesture])

  const begin = (e: React.PointerEvent, cell: Cell, type: string, kind: DragKind) => {
    if (!canArrange || e.button !== 0) return
    // Events from portalled popovers bubble through React — only react to the card itself.
    if (!(e.currentTarget as Node).contains(e.target as Node) || (e.target as HTMLElement).closest("[data-no-drag]")) return
    e.preventDefault()
    e.stopPropagation()
    const d: Drag = { id: cell.id, kind, px: e.clientX, py: e.clientY, dx: 0, dy: 0, orig: cell, min: minSizeFor(type), base: cells, cells }
    dragRef.current = d
    setDrag(d)
  }

  const place = (cell: Cell, type: string) => commit(settle(cells, clampCell(cell, minSizeFor(type))))

  const onKeyArrange = (e: React.KeyboardEvent, cell: Cell, type: string) => {
    if (!canArrange || e.target !== e.currentTarget) return
    const step: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }
    const s = step[e.key]
    if (!s) return
    e.preventDefault()
    place(e.shiftKey ? { ...cell, w: cell.w + s[0], h: cell.h + s[1] } : { ...cell, x: cell.x + s[0], y: cell.y + s[1] }, type)
  }

  const addWidget = (w: WidgetInstance) => {
    const min = minSizeFor(w.type)
    const size = { w: Math.max(w.size.w, min.w), h: Math.max(w.size.h, min.h) }
    update((d) => ({ ...d, widgets: [...d.widgets, { ...w, size, pos: findSpot(toCells(d.widgets.filter((x) => getWidget(x.type))), size.w, size.h) }] }))
  }

  const shown = drag?.cells ?? cells
  const cellOf = new Map(shown.map((c) => [c.id, c]))
  const bottom = shown.reduce((m, c) => Math.max(m, c.y + c.h), 0)
  const addSpot = canArrange ? findSpot(shown, 3, 1) : null
  const rows = Math.max(bottom, addSpot ? addSpot.y + 1 : 0) + (canArrange ? 1 : 0)
  const ordered = free ? widgets : [...widgets].sort((a, b) => {
    const ca = cellOf.get(a.id)!
    const cb = cellOf.get(b.id)!
    return ca.y - cb.y || ca.x - cb.x
  })
  // Built-in default titles stored in English are shown in the interface language.
  const localizeWidget = (w: WidgetInstance): WidgetInstance => {
    const c = w.config
    const title = typeof c.title === "string" ? dn(c.title) : c.title
    const label = typeof c.label === "string" ? dn(c.label) : c.label
    return { ...w, title: w.title === undefined ? undefined : dn(w.title), config: { ...c, title, label } }
  }
  const narrowSpan = (w: number) => (w >= 7 || metrics.width < 560 ? COLS : COLS / 2)
  const dragged = drag ? cellOf.get(drag.id) : undefined

  return (
    <>
      <AnimatePresence initial={false}>
        {editing && (
          <motion.div
            initial={{ opacity: 0, y: -8, height: 0, marginBottom: 0 }}
            animate={{ opacity: 1, y: 0, height: "auto", marginBottom: "var(--gap)" }}
            exit={{ opacity: 0, y: -8, height: 0, marginBottom: 0 }}
            transition={{ duration: 0.25, ease: [0.22, 1, 0.36, 1] }}
            className="sticky top-[4.25rem] z-20"
          >
            <div className="flex flex-wrap items-center gap-2 rounded-2xl border border-brand/30 bg-popover/85 p-2 pl-3 shadow-[var(--shadow-pop)] backdrop-blur-xl">
              <span className="flex size-8 items-center justify-center rounded-lg bg-brand-soft text-brand-soft-foreground">
                <LayoutGrid className="size-4" />
              </span>
              <div className="min-w-0 leading-tight">
                <p className="truncate text-sm font-semibold">{t("dashboard.arranging", { name: dn(current.name) })}</p>
                <p className="truncate text-xs text-muted-foreground">
                  {free ? t("dashboard.arrangeHint") : t("dashboard.arrangeNarrow")}
                </p>
              </div>
              <div className="ml-auto flex gap-1.5">
                <Button size="sm" variant="ghost" onClick={() => commit(compact(cells))} disabled={sameCells(compact(cells), cells)}>
                  <Wand2 /> {t("dashboard.tidyUp")}
                </Button>
                <Button size="sm" variant="outline" onClick={() => setAdding(true)}>
                  <Plus /> {t("dashboard.addWidget")}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setDraft(null)
                    onExitEdit()
                  }}
                >
                  <X /> {t("common.cancel")}
                </Button>
                <Button
                  size="sm"
                  onClick={() => {
                    if (draft) workspaceActions.saveDashboard(draft)
                    setDraft(null)
                    onExitEdit()
                    toast.success(t("dashboard.saved"))
                  }}
                >
                  <Check /> {t("common.done")}
                </Button>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <div
        ref={gridRef}
        className={cn("relative grid grid-cols-12 gap-[var(--gap)] transition-[background-color] duration-300", !free && "grid-flow-row-dense", canArrange && "dash-guides rounded-2xl")}
        style={
          {
            gridAutoRows: ROW_H,
            gridTemplateRows: free && rows ? `repeat(${rows}, ${ROW_H})` : undefined,
            "--step-x": `${metrics.stepX}px`,
            "--step-y": `${metrics.stepY}px`,
          } as React.CSSProperties
        }
      >
        {/* Drop target under the card being dragged. */}
        <AnimatePresence>
          {drag?.kind === "move" && dragged && (
            <motion.div
              key="placeholder"
              layout="position"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ type: "spring", stiffness: 520, damping: 42 }}
              className="pointer-events-none rounded-[calc(var(--radius)*1.25)] border-2 border-dashed border-brand/60 bg-brand/10"
              style={{ gridColumn: `${dragged.x + 1} / span ${dragged.w}`, gridRow: `${dragged.y + 1} / span ${dragged.h}` }}
            />
          )}
        </AnimatePresence>

        {ordered.map((w, i) => {
          const def = getWidget(w.type)!
          const Cmp = def.component
          const c = cellOf.get(w.id)!
          const min = minSizeFor(w.type)
          const active = drag?.id === w.id
          const moving = active && drag.kind === "move"
          const offX = moving ? (drag.orig.x - c.x) * metrics.stepX + drag.dx : 0
          const offY = moving ? (drag.orig.y - c.y) * metrics.stepY + drag.dy : 0
          return (
            <motion.div
              key={w.id}
              layout={active ? false : "position"}
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ layout: { type: "spring", stiffness: 520, damping: 42 }, default: { delay: Math.min(i, 10) * 0.035, duration: 0.35, ease: [0.22, 1, 0.36, 1] } }}
              style={
                free
                  ? { gridColumn: `${c.x + 1} / span ${c.w}`, gridRow: `${c.y + 1} / span ${c.h}`, zIndex: active ? 30 : undefined }
                  : { gridColumn: `span ${narrowSpan(c.w)}`, gridRow: `span ${c.h}` }
              }
              tabIndex={canArrange ? 0 : undefined}
              aria-label={canArrange ? t("dashboard.cardAria", { name: maybe(`widgets.types.${def.type}.name`) ?? def.name, w: c.w, h: c.h }) : undefined}
              onKeyDown={(e) => onKeyArrange(e, c, w.type)}
              onPointerDown={(e) => begin(e, c, w.type, "move")}
              className={cn("group/widget relative min-w-0 outline-none", canArrange && "cursor-grab")}
            >
              <div
                className={cn("dash-cell h-full rounded-[calc(var(--radius)*1.25)]", moving && "shadow-[0_24px_60px_-20px_rgb(0_0_0/0.45)]")}
                style={{
                  transform: moving ? `translate(${offX}px, ${offY}px) rotate(${Math.max(-1.5, Math.min(1.5, drag.dx / 120))}deg) scale(1.02)` : undefined,
                  transition: moving ? "box-shadow 200ms" : "transform 260ms cubic-bezier(0.22, 1, 0.36, 1), box-shadow 200ms",
                }}
              >
                <div className={cn("h-full", editing && "pointer-events-none select-none")}>
                  <Cmp widget={localizeWidget(w)} editing={editing} onConfig={(patch) => updateWidget({ ...w, config: { ...w.config, ...patch } })} />
                </div>

                {editing && (
                  <>
                    <div
                      className={cn(
                        "pointer-events-none absolute inset-0 rounded-[inherit] ring-1 ring-border-strong transition-[box-shadow] duration-200",
                        "group-hover/widget:ring-2 group-hover/widget:ring-brand/50 group-focus-visible/widget:ring-2 group-focus-visible/widget:ring-brand",
                        active && "ring-2 ring-brand",
                      )}
                    />
                    <div
                      data-no-drag
                      className="absolute -top-3 right-3 z-10 flex items-center gap-0.5 rounded-lg border bg-popover p-0.5 shadow-[var(--shadow-pop)] transition-opacity sm:opacity-0 sm:group-hover/widget:opacity-100 sm:group-focus-within/widget:opacity-100"
                    >
                      {canArrange && (
                        <span className="flex size-7 items-center justify-center text-muted-foreground" title={t("dashboard.dragToMove")}>
                          <GripVertical className="size-3.5" />
                        </span>
                      )}
                      <Popover>
                        <PopoverTrigger asChild>
                          <Button variant="ghost" size="icon-xs" aria-label={t("dashboard.configure")}>
                            <Settings2 />
                          </Button>
                        </PopoverTrigger>
                        <PopoverContent className="w-64" align="end">
                          <p className="mb-3 text-xs font-semibold text-muted-foreground">{t("dashboard.settingsOf", { name: maybe(`widgets.types.${def.type}.name`) ?? def.name })}</p>
                          <WidgetSettings widget={w} onChange={updateWidget} />
                        </PopoverContent>
                      </Popover>
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button variant="ghost" size="icon-xs" aria-label={t("dashboard.size")}>
                            <Maximize2 />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end" className="w-52">
                          <DropdownMenuLabel className="text-xs text-muted-foreground">{t("dashboard.widthCols")}</DropdownMenuLabel>
                          <div className="grid grid-cols-6 gap-1 px-1 pb-1">
                            {WIDTH_PRESETS.map((x) => (
                              <button
                                key={x}
                                disabled={x < min.w}
                                onClick={() => place({ ...c, w: x }, w.type)}
                                className={cn("h-7 rounded-md text-xs tabular disabled:opacity-30", c.w === x ? "bg-primary text-primary-foreground" : "hover:bg-accent")}
                              >
                                {x}
                              </button>
                            ))}
                          </div>
                          <DropdownMenuSeparator />
                          <DropdownMenuLabel className="text-xs text-muted-foreground">{t("dashboard.heightRows")}</DropdownMenuLabel>
                          <div className="grid grid-cols-4 gap-1 px-1 pb-1">
                            {HEIGHT_PRESETS.map((h) => (
                              <button
                                key={h}
                                disabled={h < min.h || h > MAX_H}
                                onClick={() => place({ ...c, h }, w.type)}
                                className={cn("h-7 rounded-md text-xs tabular disabled:opacity-30", c.h === h ? "bg-primary text-primary-foreground" : "hover:bg-accent")}
                              >
                                {h}
                              </button>
                            ))}
                          </div>
                          <p className="px-2 pb-1.5 pt-1 text-2xs text-subtle-foreground">
                            {t("dashboard.smallest", { w: min.w, h: min.h })}
                          </p>
                        </DropdownMenuContent>
                      </DropdownMenu>
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        aria-label={t("common.duplicate")}
                        onClick={() =>
                          update((d) => ({ ...d, widgets: [...d.widgets, { ...w, id: uid("w"), pos: findSpot(cells, c.w, c.h), size: { w: c.w, h: c.h } }] }))
                        }
                      >
                        <Copy />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        className="hover:text-destructive"
                        aria-label={t("common.remove")}
                        onClick={() => update((d) => ({ ...d, widgets: d.widgets.filter((x) => x.id !== w.id) }))}
                      >
                        <Trash2 />
                      </Button>
                    </div>

                    {canArrange && (
                      <>
                        <span
                          onPointerDown={(e) => begin(e, c, w.type, "resize-x")}
                          className="absolute -right-1.5 top-1/2 z-10 h-10 w-3 -translate-y-1/2 cursor-ew-resize rounded-full opacity-0 transition-opacity group-hover/widget:opacity-100"
                        >
                          <span className="mx-auto block h-full w-1 rounded-full bg-brand/80" />
                        </span>
                        <span
                          onPointerDown={(e) => begin(e, c, w.type, "resize-y")}
                          className="absolute -bottom-1.5 left-1/2 z-10 h-3 w-10 -translate-x-1/2 cursor-ns-resize rounded-full opacity-0 transition-opacity group-hover/widget:opacity-100"
                        >
                          <span className="my-auto block h-1 w-full translate-y-1 rounded-full bg-brand/80" />
                        </span>
                        <span
                          onPointerDown={(e) => begin(e, c, w.type, "resize")}
                          aria-hidden
                          className="absolute -bottom-1.5 -right-1.5 z-10 flex size-5 cursor-nwse-resize items-center justify-center rounded-md border bg-popover shadow-sm transition-transform hover:scale-110"
                        >
                          <svg viewBox="0 0 10 10" className="size-2.5 text-muted-foreground">
                            <path d="M9 3 3 9M9 6.5 6.5 9" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
                          </svg>
                        </span>
                      </>
                    )}

                    <AnimatePresence>
                      {active && (
                        <motion.span
                          initial={{ opacity: 0, scale: 0.9 }}
                          animate={{ opacity: 1, scale: 1 }}
                          exit={{ opacity: 0, scale: 0.9 }}
                          className="pointer-events-none absolute left-1/2 top-1/2 z-20 -translate-x-1/2 -translate-y-1/2 rounded-full bg-foreground px-3 py-1 text-xs font-semibold tabular text-background shadow-lg"
                        >
                          {c.w} × {c.h}
                        </motion.span>
                      )}
                    </AnimatePresence>
                  </>
                )}
              </div>
            </motion.div>
          )
        })}

        {editing && !drag && (
          <motion.button
            layout="position"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            onClick={() => setAdding(true)}
            style={addSpot ? { gridColumn: `${addSpot.x + 1} / span 3`, gridRow: `${addSpot.y + 1} / span 1` } : { gridColumn: `span ${narrowSpan(3)}` }}
            className="group/add flex flex-col items-center justify-center gap-2 rounded-[calc(var(--radius)*1.25)] border-2 border-dashed text-sm font-medium text-muted-foreground transition-colors hover:border-brand/60 hover:bg-brand/5 hover:text-foreground"
          >
            <span className="flex size-8 items-center justify-center rounded-full bg-muted transition-transform duration-300 group-hover/add:rotate-90 group-hover/add:bg-brand group-hover/add:text-brand-foreground">
              <Plus className="size-4" />
            </span>
            {t("dashboard.addWidget")}
          </motion.button>
        )}
      </div>

      <AddWidgetDialog open={adding} onOpenChange={setAdding} onAdd={addWidget} />
    </>
  )
}
