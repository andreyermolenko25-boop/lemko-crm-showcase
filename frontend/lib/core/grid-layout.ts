import type { WidgetInstance } from "@/lib/core/types"

/*
 * Free-form dashboard layout. Every widget owns a rectangle on a 12-column
 * grid (x, y, w, h in grid cells). Moving or resizing one pins it and pushes
 * whatever it overlaps further down — gaps are allowed, so the board behaves
 * like a sandbox. `compact` floats everything up when the user wants it tidy.
 */

export const COLS = 12
export const MAX_H = 6

export type Cell = { id: string; x: number; y: number; w: number; h: number }
export type MinSize = { w: number; h: number }

/* Tables and lists stay readable: never narrower/shorter than roughly a square. */
const MIN_SIZE: Record<string, MinSize> = {
  kpi: { w: 2, h: 1 },
  stages: { w: 3, h: 1 },
  notes: { w: 3, h: 1 },
  records: { w: 5, h: 2 },
  leaderboard: { w: 4, h: 2 },
  agenda: { w: 3, h: 2 },
  activity: { w: 3, h: 2 },
  trend: { w: 4, h: 2 },
  funnel: { w: 3, h: 2 },
  goal: { w: 3, h: 2 },
  breakdown: { w: 3, h: 2 },
  code: { w: 3, h: 1 },
}

export const minSizeFor = (type: string): MinSize => MIN_SIZE[type] ?? { w: 3, h: 2 }

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))

export const collides = (a: Cell, b: Cell) =>
  a.id !== b.id && a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h

export function clampCell(c: Cell, min: MinSize): Cell {
  const w = clamp(Math.round(c.w), min.w, COLS)
  const h = clamp(Math.round(c.h), min.h, MAX_H)
  return { id: c.id, w, h, x: clamp(Math.round(c.x), 0, COLS - w), y: Math.max(0, Math.round(c.y)) }
}

/** First free top-left slot (row by row) for a w×h rectangle. */
export function findSpot(placed: Cell[], w: number, h: number, id = "_"): { x: number; y: number } {
  for (let y = 0; ; y++) {
    for (let x = 0; x + w <= COLS; x++) {
      const probe = { id, x, y, w, h }
      if (!placed.some((p) => collides(probe, p))) return { x, y }
    }
  }
}

/** Widgets → cells. Widgets saved before free layout (no `pos`) are packed in order. */
export function toCells(widgets: WidgetInstance[]): Cell[] {
  const placed: Cell[] = []
  const pending: WidgetInstance[] = []
  for (const w of widgets) {
    const min = minSizeFor(w.type)
    if (!w.pos) {
      pending.push(w)
      continue
    }
    const cell = clampCell({ id: w.id, x: w.pos.x, y: w.pos.y, w: w.size.w, h: w.size.h }, min)
    if (placed.some((p) => collides(cell, p))) pending.push(w)
    else placed.push(cell)
  }
  for (const w of pending) {
    const min = minSizeFor(w.type)
    const size = clampCell({ id: w.id, x: 0, y: 0, w: w.size.w, h: w.size.h }, min)
    placed.push({ ...size, ...findSpot(placed, size.w, size.h, w.id) })
  }
  return placed
}

/** Pin `pinned` where it is and push every overlapping cell down until nothing overlaps. */
export function settle(cells: Cell[], pinned: Cell): Cell[] {
  const out: Cell[] = [pinned]
  const rest = cells.filter((c) => c.id !== pinned.id).sort((a, b) => a.y - b.y || a.x - b.x)
  for (const c of rest) {
    let y = c.y
    while (out.some((p) => collides({ ...c, y }, p))) y++
    out.push({ ...c, y })
  }
  return out
}

/** Float every cell up as far as it goes, keeping columns. */
export function compact(cells: Cell[]): Cell[] {
  const out: Cell[] = []
  for (const c of [...cells].sort((a, b) => a.y - b.y || a.x - b.x)) {
    let y = c.y
    while (y > 0 && !out.some((p) => collides({ ...c, y: y - 1 }, p))) y--
    out.push({ ...c, y })
  }
  return out
}

export const sameCells = (a: Cell[], b: Cell[]) => {
  if (a.length !== b.length) return false
  const m = new Map(b.map((c) => [c.id, c]))
  return a.every((c) => {
    const o = m.get(c.id)
    return o && o.x === c.x && o.y === c.y && o.w === c.w && o.h === c.h
  })
}

/** Write cell geometry back onto the widgets. */
export function applyCells(widgets: WidgetInstance[], cells: Cell[]): WidgetInstance[] {
  const m = new Map(cells.map((c) => [c.id, c]))
  return widgets.map((w) => {
    const c = m.get(w.id)
    return c ? { ...w, pos: { x: c.x, y: c.y }, size: { w: c.w, h: c.h } } : w
  })
}
