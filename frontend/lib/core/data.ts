"use client"

import { useMemo } from "react"
import { toast } from "sonner"
import { t, type MessageKey } from "@/lib/i18n/translate"
import { createStore } from "@/lib/core/store"
import { activitiesApi, membersApi, recordsApi } from "@/lib/core/backend"
import type { Activity, ActivityKind, ColorKey, CrmRecord, EntityDef, FilterRule, Member, RecordValue, SortRule } from "@/lib/core/types"
import { workspaceStore } from "@/lib/core/workspace"

/**
 * Records, activity feed and members — all loaded from and written to the API
 * (lib/core/backend.ts). Edits apply instantly and roll back with an error toast
 * if the server rejects them; creations wait for the server so the record gets
 * its real id, validation and side effects (stock, shifts).
 */

type DataState = {
  records: Record<string, CrmRecord[]>
  activities: Activity[]
  unread: number
  members: Member[]
  meId: string | null
}

const COLORS: ColorKey[] = ["green", "blue", "violet", "amber", "pink", "teal", "orange", "indigo", "red"]

export function withColor(m: Omit<Member, "color">): Member {
  const n = Number(m.id.replace(/\D/g, "")) || 0
  return { ...m, color: COLORS[n % COLORS.length] }
}

export const dataStore = createStore<DataState>("data", () => ({ records: {}, activities: [], unread: 0, members: [], meId: null }))
const set = dataStore.set

export const useData = <S,>(selector: (s: DataState) => S) => dataStore.use(selector)

const EMPTY: CrmRecord[] = []

export function useRecords(entity: string | undefined): CrmRecord[] {
  return useData((s) => (entity ? s.records[entity] : undefined) ?? EMPTY)
}

export function useRecord(entity: string, id: string): CrmRecord | undefined {
  const list = useRecords(entity)
  return useMemo(() => list.find((r) => r.id === id), [list, id])
}

export function useMembers() {
  return useData((s) => s.members)
}

export function currentUserId(): string | null {
  return dataStore.get().meId
}

export function useCurrentUserId(): string | null {
  return useData((s) => s.meId)
}

export function useMe(): Member | undefined {
  const members = useMembers()
  const meId = useCurrentUserId()
  return useMemo(() => members.find((m) => m.id === meId), [members, meId])
}

export function memberById(id: unknown): Member | undefined {
  return dataStore.get().members.find((m) => m.id === id)
}

export function recordTitle(entity: EntityDef | undefined, record: CrmRecord | undefined): string {
  if (!entity || !record) return ""
  return String(record[entity.primaryField] ?? "Untitled")
}

export function findRecord(entity: string, id: unknown): CrmRecord | undefined {
  if (!id) return undefined
  return dataStore.get().records[entity]?.find((r) => r.id === id)
}

/* -------------------------------------------------------------------------- */
/*  Loading                                                                    */
/* -------------------------------------------------------------------------- */

function apiError(err: unknown, title: MessageKey) {
  toast.error(t(title), { description: err instanceof Error ? err.message : String(err) })
}

export async function loadRecords(entities: string[]) {
  if (!entities.length) return
  const loaded = await recordsApi.listMany(entities)
  set((s) => ({ ...s, records: { ...s.records, ...loaded } }))
}

export async function loadActivities() {
  const { items, unread } = await activitiesApi.list({ limit: 200 })
  set((s) => ({ ...s, activities: items, unread }))
}

export async function loadMembers() {
  const members = await membersApi.list()
  set((s) => ({ ...s, members: members.map(withColor) }))
}

export function setMe(member: Omit<Member, "color">) {
  set((s) => ({ ...s, meId: member.id, members: s.members.some((m) => m.id === member.id) ? s.members : [...s.members, withColor(member)] }))
}

/**
 * The server may change more than the edited record: the feed always, stock
 * when a visit is completed. Reload what can be affected, batched per burst
 * of edits.
 */
const pendingRefresh = new Set<string>()
let refreshTimer: ReturnType<typeof setTimeout> | undefined

function affectedBy(entity: string): string[] {
  const out = new Set<string>()
  // Starting / completing a visit writes materials off the stock.
  if (entity === "appointments") out.add("products")
  return [...out]
}

function scheduleRefresh(entity: string) {
  affectedBy(entity).forEach((e) => pendingRefresh.add(e))
  clearTimeout(refreshTimer)
  refreshTimer = setTimeout(() => {
    const entities = [...pendingRefresh]
    pendingRefresh.clear()
    void Promise.all([loadActivities(), loadRecords(entities)]).catch(() => undefined)
  }, 700)
}

function replaceRecord(entity: string, id: string, next: CrmRecord | null) {
  set((s) => ({
    ...s,
    records: {
      ...s.records,
      [entity]: next
        ? (s.records[entity] ?? []).map((r) => (r.id === id ? next : r))
        : (s.records[entity] ?? []).filter((r) => r.id !== id),
    },
  }))
}

/* -------------------------------------------------------------------------- */
/*  Mutations                                                                  */
/* -------------------------------------------------------------------------- */

const writableValues = (entity: EntityDef, values: Record<string, RecordValue>) =>
  Object.fromEntries(Object.entries(values).filter(([k]) => !entity.fields.find((f) => f.key === k)?.readOnly))

export const dataActions = {
  /** Creates on the server; resolves with the saved record or null (error already shown). */
  async create(entity: EntityDef, values: Record<string, RecordValue>): Promise<CrmRecord | null> {
    try {
      const saved = await recordsApi.create(entity.key, writableValues(entity, values))
      set((s) => ({ ...s, records: { ...s.records, [entity.key]: [saved, ...(s.records[entity.key] ?? [])] } }))
      scheduleRefresh(entity.key)
      return saved
    } catch (err) {
      apiError(err, "data.createFailed")
      return null
    }
  },

  update(entity: EntityDef, id: string, patch: Record<string, RecordValue>) {
    const prev = findRecord(entity.key, id)
    if (!prev) return
    const values = writableValues(entity, patch)
    if (!Object.keys(values).length) return
    replaceRecord(entity.key, id, { ...prev, ...values, updatedAt: new Date().toISOString() })
    recordsApi.update(entity.key, id, values).then(
      (saved) => {
        replaceRecord(entity.key, id, saved)
        scheduleRefresh(entity.key)
      },
      (err) => {
        const current = findRecord(entity.key, id)
        if (current) replaceRecord(entity.key, id, { ...current, ...Object.fromEntries(Object.keys(values).map((k) => [k, prev[k]])) })
        apiError(err, "data.updateFailed")
      },
    )
  },

  remove(entity: EntityDef, ids: string[]) {
    const removed = (dataStore.get().records[entity.key] ?? []).filter((r) => ids.includes(r.id))
    set((s) => ({ ...s, records: { ...s.records, [entity.key]: (s.records[entity.key] ?? []).filter((r) => !ids.includes(r.id)) } }))
    for (const rec of removed) {
      recordsApi.remove(entity.key, rec.id).then(
        // Archived instead of deleted (a cancelled appointment) — keep showing it.
        (archived) => {
          if (archived) set((s) => ({ ...s, records: { ...s.records, [entity.key]: [archived, ...(s.records[entity.key] ?? [])] } }))
          scheduleRefresh(entity.key)
        },
        (err) => {
          set((s) => ({ ...s, records: { ...s.records, [entity.key]: [rec, ...(s.records[entity.key] ?? [])] } }))
          apiError(err, "data.deleteFailed")
        },
      )
    }
  },

  async addNote(entity: EntityDef, recordId: string, body: string, kind: ActivityKind = "note"): Promise<Activity | null> {
    try {
      const saved = await activitiesApi.add({ entity: entity.key, recordId, kind, body })
      set((s) => ({ ...s, activities: [saved, ...s.activities] }))
      return saved
    } catch (err) {
      apiError(err, "data.noteFailed")
      return null
    }
  },

  markAllRead() {
    set((s) => ({ ...s, unread: 0, activities: s.activities.map((a) => (a.read ? a : { ...a, read: true })) }))
    activitiesApi.markAllRead().catch((err) => apiError(err, "data.markReadFailed"))
  },

  markRead(id: string) {
    const target = dataStore.get().activities.find((a) => a.id === id)
    if (!target || target.read) return
    set((s) => ({ ...s, unread: Math.max(0, s.unread - 1), activities: s.activities.map((a) => (a.id === id ? { ...a, read: true } : a)) }))
    activitiesApi.markRead([id]).catch(() => undefined)
  },

  /** Creates the account; resolves with the one-time password to hand over. */
  async inviteMember(m: { email: string; name?: string; role: Member["role"]; title?: string }): Promise<string | null> {
    try {
      const { member, temporaryPassword } = await membersApi.invite(m)
      set((s) => ({ ...s, members: [...s.members, withColor(member)] }))
      return temporaryPassword
    } catch (err) {
      apiError(err, "data.inviteFailed")
      return null
    }
  },

  updateMember(id: string, patch: Partial<Pick<Member, "name" | "title" | "role">>) {
    const prev = dataStore.get().members.find((m) => m.id === id)
    if (!prev) return
    set((s) => ({ ...s, members: s.members.map((m) => (m.id === id ? { ...m, ...patch } : m)) }))
    membersApi.update(id, patch).then(
      (saved) => set((s) => ({ ...s, members: s.members.map((m) => (m.id === id ? withColor(saved) : m)) })),
      (err) => {
        set((s) => ({ ...s, members: s.members.map((m) => (m.id === id ? prev : m)) }))
        apiError(err, "data.memberFailed")
      },
    )
  },

  /** Own name / title / notification email. */
  async updateProfile(patch: { name?: string; title?: string; email?: string | null }) {
    try {
      const { member } = await membersApi.updateMe(patch)
      set((s) => ({ ...s, members: s.members.map((m) => (m.id === member.id ? withColor(member) : m)) }))
    } catch (err) {
      apiError(err, "data.profileFailed")
    }
  },

  /** Deactivates the account: sign-in is closed, their history stays. */
  removeMember(id: string) {
    const prev = dataStore.get().members.find((m) => m.id === id)
    if (!prev) return
    set((s) => ({ ...s, members: s.members.map((m) => (m.id === id ? { ...m, status: "disabled" } : m)) }))
    membersApi.remove(id).catch((err) => {
      set((s) => ({ ...s, members: s.members.map((m) => (m.id === id ? prev : m)) }))
      apiError(err, "data.removeMemberFailed")
    })
  },
}

/* -------------------------------------------------------------------------- */
/*  Query helpers (filter / sort / search) — pure, shared by every view        */
/* -------------------------------------------------------------------------- */

export function displayValue(entity: EntityDef, record: CrmRecord, key: string): string {
  const field = entity.fields.find((f) => f.key === key)
  const v = record[key]
  if (v === null || v === undefined || v === "") return ""
  if (!field) return String(v)
  switch (field.type) {
    case "select":
    case "status":
      return field.options?.find((o) => o.value === v)?.label ?? String(v)
    case "multiselect":
      return (Array.isArray(v) ? v : [v]).map((x) => field.options?.find((o) => o.value === x)?.label ?? x).join(", ")
    case "user":
      return memberById(v)?.name ?? ""
    case "relation": {
      const target = findRecord(field.relation ?? "", v)
      return target ? String(target.name ?? target.title ?? target.number ?? target.subject ?? target.address ?? target.id) : ""
    }
    default:
      return String(v)
  }
}

function matches(entity: EntityDef, r: CrmRecord, rule: FilterRule): boolean {
  const raw = r[rule.field]
  const field = entity.fields.find((f) => f.key === rule.field)
  const text = displayValue(entity, r, rule.field).toLowerCase()
  const val = (rule.value ?? "").toLowerCase()
  const isEmpty = raw === null || raw === undefined || raw === "" || (Array.isArray(raw) && raw.length === 0)
  switch (rule.op) {
    case "empty":
      return isEmpty
    case "not_empty":
      return !isEmpty
    case "contains":
      return text.includes(val)
    case "not_contains":
      return !text.includes(val)
    case "is":
      if (Array.isArray(raw)) return raw.map(String).includes(rule.value ?? "")
      return String(raw ?? "").toLowerCase() === val || text === val
    case "is_not":
      if (Array.isArray(raw)) return !raw.map(String).includes(rule.value ?? "")
      return String(raw ?? "").toLowerCase() !== val && text !== val
    case "gt":
    case "lt": {
      const isDate = field?.type === "date" || field?.type === "datetime"
      const a = isDate ? new Date(String(raw)).getTime() : Number(raw)
      const b = isDate ? new Date(rule.value ?? "").getTime() : Number(rule.value)
      if (!Number.isFinite(a) || !Number.isFinite(b)) return false
      return rule.op === "gt" ? a > b : a < b
    }
  }
}

export function queryRecords(
  entity: EntityDef,
  records: CrmRecord[],
  opts: { search?: string; filters?: FilterRule[]; sort?: SortRule },
): CrmRecord[] {
  let out = records
  const q = opts.search?.trim().toLowerCase()
  if (q) {
    const keys = entity.fields.filter((f) => ["text", "email", "phone", "relation", "select", "status", "url"].includes(f.type)).map((f) => f.key)
    out = out.filter((r) => keys.some((k) => displayValue(entity, r, k).toLowerCase().includes(q)))
  }
  const rules = (opts.filters ?? []).filter((f) => f.field && (f.op === "empty" || f.op === "not_empty" || (f.value ?? "") !== ""))
  if (rules.length) out = out.filter((r) => rules.every((rule) => matches(entity, r, rule)))
  if (opts.sort) {
    const { field, dir } = opts.sort
    const def = entity.fields.find((f) => f.key === field)
    const numeric = def && ["number", "currency", "percent", "rating"].includes(def.type)
    const dateLike = def && ["date", "datetime"].includes(def.type)
    const optIndex = (v: unknown) => def?.options?.findIndex((o) => o.value === v) ?? -1
    out = [...out].sort((a, b) => {
      let cmp: number
      if (numeric) cmp = (Number(a[field]) || 0) - (Number(b[field]) || 0)
      else if (dateLike) cmp = new Date(String(a[field] ?? 0)).getTime() - new Date(String(b[field] ?? 0)).getTime()
      else if (def?.type === "status" || def?.type === "select") cmp = optIndex(a[field]) - optIndex(b[field])
      else cmp = displayValue(entity, a, field).localeCompare(displayValue(entity, b, field))
      return dir === "asc" ? cmp : -cmp
    })
  }
  return out
}
