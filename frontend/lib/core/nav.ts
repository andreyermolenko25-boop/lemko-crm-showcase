"use client"

import { useMemo } from "react"
import type { ColorKey, CrmRecord, EntityDef } from "@/lib/core/types"
import { useData } from "@/lib/core/data"
import { useEntities, useWorkspace } from "@/lib/core/workspace"
import { useT } from "@/components/i18n-provider"
import type { MessageKey } from "@/lib/i18n/translate"

export type NavItem = {
  id: string
  label: string
  href: string
  icon: string
  color?: ColorKey
  badge?: number
  kind: "page" | "entity"
}

const PAGE_ITEMS: (Omit<NavItem, "label"> & { labelKey: MessageKey })[] = [
  { id: "page:home", labelKey: "nav.overview", href: "/", icon: "dashboard", kind: "page" },
  { id: "page:inbox", labelKey: "nav.inbox", href: "/inbox", icon: "inbox", kind: "page" },
  { id: "page:calendar", labelKey: "nav.calendar", href: "/calendar", icon: "calendar", kind: "page" },
  { id: "page:reports", labelKey: "nav.analytics", href: "/reports", icon: "chart-line", kind: "page" },
  { id: "page:integrations", labelKey: "nav.integrations", href: "/integrations", icon: "plug", kind: "page" },
  { id: "page:apps", labelKey: "nav.apps", href: "/apps", icon: "boxes", kind: "page" },
]

const DEFAULT_ORDER = ["page:home", "page:inbox", "entity:deals", "entity:contacts", "entity:companies", "entity:tasks"]
const TAIL = ["page:calendar", "page:reports", "page:integrations", "page:apps"]

function badgeFor(entity: EntityDef, records: CrmRecord[] | undefined): number | undefined {
  if (!records?.length) return undefined
  if (entity.key === "tasks") {
    const end = new Date()
    end.setHours(23, 59, 59, 999)
    const n = records.filter((r) => r.status !== "done" && r.due && new Date(String(r.due)) <= end).length
    return n || undefined
  }
  if (entity.stageField) {
    const field = entity.fields.find((f) => f.key === entity.stageField)
    const open = field?.options?.filter((o) => !["won", "lost", "done", "completed", "paid", "solved", "sold"].includes(o.value)).map((o) => o.value)
    if (!open || entity.key !== "deals") return undefined
    const n = records.filter((r) => open.includes(String(r[entity.stageField!]))).length
    return n || undefined
  }
  return undefined
}

/** Navigation after module enablement + user ordering / hiding. */
export function useNavItems(): { visible: NavItem[]; all: NavItem[] } {
  const entities = useEntities()
  const order = useWorkspace((s) => s.nav.order)
  const hidden = useWorkspace((s) => s.nav.hidden)
  const records = useData((s) => s.records)
  const unread = useData((s) => s.unread)
  const t = useT()

  return useMemo(() => {
    const items = new Map<string, NavItem>()
    for (const { labelKey, ...p } of PAGE_ITEMS) items.set(p.id, { ...p, label: t(labelKey) })
    const inbox = items.get("page:inbox")!
    inbox.badge = unread || undefined
    for (const e of entities) {
      items.set(`entity:${e.key}`, {
        id: `entity:${e.key}`,
        label: e.label,
        href: `/o/${e.key}`,
        icon: e.icon,
        color: e.color,
        kind: "entity",
        badge: badgeFor(e, records[e.key]),
      })
    }
    const base = order.length ? order : DEFAULT_ORDER
    const seq: string[] = []
    for (const id of base) if (items.has(id) && !seq.includes(id)) seq.push(id)
    // New entities (from freshly installed modules) slot in before the tail pages.
    for (const id of items.keys()) if (!seq.includes(id) && !TAIL.includes(id)) seq.push(id)
    for (const id of TAIL) if (!seq.includes(id)) seq.push(id)
    const all = seq.map((id) => items.get(id)!).filter(Boolean)
    return { all, visible: all.filter((i) => !hidden.includes(i.id)) }
  }, [entities, order, hidden, records, unread, t])
}
