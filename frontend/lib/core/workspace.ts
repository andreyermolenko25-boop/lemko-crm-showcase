"use client"

import { useMemo } from "react"
import { toast } from "sonner"
import { createStore, uid } from "@/lib/core/store"
import {
  membersApi,
  schemaOf,
  workspaceApi,
  type IntegrationConnection,
  type ReportDef,
  type WorkspaceSnapshot,
} from "@/lib/core/backend"
import { COLOR_KEYS, type ColorKey, type DashboardDef, type EntityDef, type FieldDef, type FieldOption, type ViewDef } from "@/lib/core/types"
import { DEFAULT_ENABLED_MODULES, getModule, listModules } from "@/lib/modules"
import { localizeEntity } from "@/lib/core/schema-i18n"
import { useI18n } from "@/components/i18n-provider"
import { getTranslator, t, type MessageKey, type SchemaMessages } from "@/lib/i18n/translate"
import { nounInSentence } from "@/lib/i18n/text"

export type { IntegrationConnection, ReportDef }

/**
 * Workspace configuration — everything the team customises in the UI. The
 * server keeps it (lib/core/backend.ts → /workspace, /views, /dashboards…);
 * this store mirrors it, applies edits instantly and saves them in the
 * background. Favorites and the last-opened view per object are personal and
 * saved to the member's preferences.
 */

/* -------------------------------------------------------------------------- */
/*  State shape                                                                */
/* -------------------------------------------------------------------------- */

export type FieldOverride = { label?: string; hidden?: boolean; options?: FieldOption[] }

export type EntityOverride = {
  label?: string
  labelSingular?: string
  icon?: string
  color?: ColorKey
  description?: string
  fields?: Record<string, FieldOverride>
  extraFields?: FieldDef[]
  fieldOrder?: string[]
}

export type Favorite = { id: string; label: string; href: string; icon: string }

export type NavConfig = {
  order: string[]
  hidden: string[]
  /** Pinned views and records — personal. */
  favorites: Favorite[]
}

/** A prebuilt module package added manually (file / URL / registry id). */
/** A module installed from a JSON manifest (objects + views), see installPackage. */
export type InstalledPackage = {
  id: string
  name: string
  version: string
  source: "file" | "url"
  origin: string
  installedAt: string
  enabled: boolean
  /** Keys of the objects the package created. */
  entities: string[]
}

export type PackageManifest = {
  name: string
  version?: string
  entities: Omit<EntityDef, "module" | "custom">[]
  views?: Omit<ViewDef, "id">[]
}

export type WorkspaceState = {
  ready: boolean
  name: string
  plan: string
  /** IANA zone — days and months of every chart are counted in it. */
  timezone: string
  trialEndsAt: string | null
  color: ColorKey
  niche: string
  logoAttachmentId: number | null
  enabledModules: string[]
  customEntities: EntityDef[]
  overrides: Record<string, EntityOverride>
  nav: NavConfig
  views: Record<string, ViewDef[]>
  activeView: Record<string, string>
  dashboards: DashboardDef[]
  reports: ReportDef[]
  packages: InstalledPackage[]
  integrations: Record<string, IntegrationConnection>
}

/* -------------------------------------------------------------------------- */
/*  Defaults for a brand-new workspace (applied once, on the server)           */
/* -------------------------------------------------------------------------- */

/*
 * Built-in names (views, dashboards, widgets, reports) are stored in English
 * and translated when shown, so every member sees them in their own language
 * until someone renames them.
 */

function moduleViews(moduleId: string): Omit<ViewDef, "id">[] {
  const mod = getModule(moduleId)
  if (!mod) return []
  const out: Omit<ViewDef, "id">[] = [...(mod.views ?? [])]
  // Entities without views get a default table.
  for (const e of mod.entities) {
    if (!out.some((v) => v.entity === e.key)) out.push(defaultTableView(e))
  }
  return out
}

/**
 * Default table of an object. Built-in objects get the English name (shown in
 * each member's language, see useDefaultName); a team's own objects are named
 * in the language of whoever creates them.
 */
export function defaultTableView(e: EntityDef): Omit<ViewDef, "id"> {
  const source = e.custom ? undefined : getModule(e.module)?.entities.find((x) => x.key === e.key)
  return {
    entity: e.key,
    name: source ? `All ${source.label.toLowerCase()}` : t("workspace.allRecords", { name: nounInSentence(e.label) }),
    type: "table",
    columns: e.fields.slice(0, 8).map((f) => f.key),
    filters: [],
    shared: true,
  }
}

const defaultDashboards = (): Omit<DashboardDef, "id">[] => [
  {
    name: "Overview",
    icon: "dashboard",
    widgets: [
      { id: "w1", type: "kpi", size: { w: 3, h: 1 }, config: { entity: "deals", metric: "sum", field: "amount", label: "Won revenue", filterStage: "won" } },
      { id: "w2", type: "kpi", size: { w: 3, h: 1 }, config: { entity: "deals", metric: "count", label: "Active deals", excludeClosed: true } },
      { id: "w3", type: "kpi", size: { w: 3, h: 1 }, config: { entity: "deals", metric: "conversion", label: "Win rate" } },
      { id: "w4", type: "kpi", size: { w: 3, h: 1 }, config: { entity: "deals", metric: "avg", field: "amount", label: "Average deal size" } },
      { id: "w5", type: "trend", size: { w: 8, h: 2 }, config: { entity: "deals", field: "amount", title: "Sales trend" } },
      { id: "w6", type: "funnel", size: { w: 4, h: 2 }, config: { entity: "deals", title: "Sales funnel" } },
      { id: "w7", type: "records", size: { w: 6, h: 2 }, config: { entity: "deals", title: "Biggest open deals", limit: 4 } },
      { id: "w8", type: "agenda", size: { w: 3, h: 2 }, config: { entity: "tasks", title: "Upcoming tasks" } },
      { id: "w9", type: "activity", size: { w: 3, h: 2 }, config: { title: "Activity" } },
    ],
  },
  {
    name: "Team",
    icon: "users",
    widgets: [
      { id: "t1", type: "leaderboard", size: { w: 6, h: 2 }, config: { entity: "deals", title: "Leaderboard" } },
      { id: "t2", type: "goal", size: { w: 3, h: 2 }, config: { entity: "deals", title: "Quarter goal", range: "quarter" } },
      { id: "t3", type: "breakdown", size: { w: 3, h: 2 }, config: { entity: "deals", field: "source", title: "Deals by source" } },
      { id: "t4", type: "stages", size: { w: 4, h: 1 }, config: { entity: "tasks", title: "Tasks" } },
      { id: "t5", type: "notes", size: { w: 8, h: 1 }, config: { title: "Team notes", text: "" } },
    ],
  },
]

const defaultReports = (): Omit<ReportDef, "id">[] => [
  { name: "Pipeline value by stage", entity: "deals", groupBy: "stage", metric: "sum", metricField: "amount", chart: "bar" },
  { name: "Deals by source", entity: "deals", groupBy: "source", metric: "count", chart: "pie" },
  { name: "Contacts by lifecycle", entity: "contacts", groupBy: "lifecycle", metric: "count", chart: "bar" },
  { name: "Won revenue by owner", entity: "deals", groupBy: "owner", metric: "sum", metricField: "amount", chart: "table" },
]

export function bootstrapPayload() {
  return {
    config: { enabledModules: [...DEFAULT_ENABLED_MODULES], nav: { order: [], hidden: [] } },
    views: DEFAULT_ENABLED_MODULES.flatMap(moduleViews),
    dashboards: defaultDashboards(),
    reports: defaultReports(),
  }
}

/* -------------------------------------------------------------------------- */
/*  Store                                                                      */
/* -------------------------------------------------------------------------- */

function initWorkspace(): WorkspaceState {
  return {
    ready: false,
    name: "",
    plan: "",
    timezone: "UTC",
    trialEndsAt: null,
    color: "green",
    niche: "",
    logoAttachmentId: null,
    enabledModules: [],
    customEntities: [],
    overrides: {},
    nav: { order: [], hidden: [], favorites: [] },
    views: {},
    activeView: {},
    dashboards: [],
    reports: [],
    packages: [],
    integrations: {},
  }
}

export const workspaceStore = createStore<WorkspaceState>("workspace", initWorkspace)
export const useWorkspace = <S,>(selector: (s: WorkspaceState) => S) => workspaceStore.use(selector)
const set = workspaceStore.set

function groupViews(views: ViewDef[]): Record<string, ViewDef[]> {
  const out: Record<string, ViewDef[]> = {}
  for (const v of views) (out[v.entity] ??= []).push(v)
  return out
}

/** Replaces the mirror with what the server returned (+ the member's own preferences). */
export function applySnapshot(snap: WorkspaceSnapshot, personal: Record<string, unknown>) {
  const c = snap.config
  set({
    ready: true,
    name: snap.company.name,
    plan: snap.company.plan,
    timezone: snap.company.timezone,
    trialEndsAt: snap.company.trialEndsAt,
    color: (c.color as ColorKey) ?? "green",
    niche: c.niche ?? "",
    logoAttachmentId: c.logoAttachmentId ?? null,
    enabledModules: c.enabledModules ?? [...DEFAULT_ENABLED_MODULES],
    customEntities: c.customEntities ?? [],
    overrides: (c.overrides as Record<string, EntityOverride>) ?? {},
    nav: {
      order: c.nav?.order ?? [],
      hidden: c.nav?.hidden ?? [],
      favorites: (personal.favorites as Favorite[]) ?? [],
    },
    views: groupViews(snap.views),
    activeView: (personal.activeView as Record<string, string>) ?? {},
    dashboards: snap.dashboards,
    reports: snap.reports,
    packages: (c.packages as InstalledPackage[]) ?? [],
    integrations: Object.fromEntries(snap.integrations.map((i) => [i.id, i])),
  })
}

/* -------------------------------------------------------------------------- */
/*  Saving                                                                     */
/* -------------------------------------------------------------------------- */

function apiError(err: unknown, title: MessageKey) {
  toast.error(t(title), { description: err instanceof Error ? err.message : String(err) })
}

/** Debounced save per key — rapid edits (typing, column resize) become one request. */
const timers = new Map<string, ReturnType<typeof setTimeout>>()
function later(key: string, run: () => Promise<unknown>, delay = 500) {
  clearTimeout(timers.get(key))
  timers.set(
    key,
    setTimeout(() => {
      timers.delete(key)
      run().catch((err) => apiError(err, "workspace.errors.save"))
    }, delay),
  )
}

type ConfigKey = "enabledModules" | "customEntities" | "overrides" | "nav" | "packages" | "niche" | "color" | "logoAttachmentId"

function saveConfig(...keys: ConfigKey[]) {
  for (const key of keys) {
    later(`config:${key}`, () => {
      const s = workspaceStore.get()
      const value = key === "nav" ? { order: s.nav.order, hidden: s.nav.hidden } : s[key]
      return workspaceApi.patchConfig({ [key]: value })
    })
  }
}

function savePersonal() {
  later("personal", () => {
    const s = workspaceStore.get()
    return membersApi.updateMe({ preferences: { favorites: s.nav.favorites, activeView: s.activeView } })
  })
}

let lastSchema = ""

/** Sends the resolved object definitions to the server (formulas, feed titles, webhooks). */
export function syncSchema(): Promise<void> {
  const schema = resolveEntities(workspaceStore.get()).map(schemaOf)
  const json = JSON.stringify(schema)
  if (json === lastSchema) return Promise.resolve()
  lastSchema = json
  return workspaceApi.putSchema(schema).catch((err) => {
    lastSchema = ""
    apiError(err, "workspace.errors.syncSchema")
  })
}

const isServerId = (id: string) => /^\d+$/.test(id)

/* -------------------------------------------------------------------------- */
/*  Schema resolution                                                          */
/* -------------------------------------------------------------------------- */

function applyOverride(entity: EntityDef, o?: EntityOverride): EntityDef {
  if (!o) return entity
  let fields = [...entity.fields, ...(o.extraFields ?? [])].map((f) => {
    const fo = o.fields?.[f.key]
    return fo ? { ...f, ...(fo.label ? { label: fo.label } : {}), ...(fo.options ? { options: fo.options } : {}) } : f
  })
  fields = fields.filter((f) => !o.fields?.[f.key]?.hidden)
  if (o.fieldOrder?.length) {
    const idx = (k: string) => {
      const i = o.fieldOrder!.indexOf(k)
      return i === -1 ? 999 : i
    }
    fields.sort((a, b) => idx(a.key) - idx(b.key))
  }
  return {
    ...entity,
    label: o.label ?? entity.label,
    labelSingular: o.labelSingular ?? entity.labelSingular,
    icon: o.icon ?? entity.icon,
    color: o.color ?? entity.color,
    description: o.description ?? entity.description,
    fields,
  }
}

type EntitySources = Pick<WorkspaceState, "enabledModules" | "customEntities" | "overrides"> & { packages?: InstalledPackage[] }

/** Objects of disabled packages stay defined but are hidden everywhere. */
function hiddenByPackages(packages: InstalledPackage[] | undefined): Set<string> {
  return new Set((packages ?? []).filter((p) => !p.enabled).flatMap((p) => p.entities ?? []))
}

/**
 * Object definitions after module enablement + workspace customisation.
 * `schema` — labels of the interface language for the built-in objects (UI);
 * without it the English source is returned (what the server stores).
 */
export function resolveEntities(s: EntitySources, schema?: SchemaMessages): EntityDef[] {
  const base: EntityDef[] = []
  for (const mod of listModules()) {
    if (!s.enabledModules.includes(mod.id)) continue
    base.push(...(schema ? mod.entities.map((e) => localizeEntity(e, schema)) : mod.entities))
  }
  const hidden = hiddenByPackages(s.packages)
  base.push(...s.customEntities.filter((e) => !hidden.has(e.key)))
  return base.map((e) => applyOverride(e, s.overrides[e.key]))
}

/** Entity definitions as the UI shows them (labels in the interface language). */
export function resolveLocalizedEntities(): EntityDef[] {
  return resolveEntities(workspaceStore.get(), getTranslator().schema)
}

/** All entity definitions after module enablement + workspace customisation. */
export function useEntities(): EntityDef[] {
  const enabledModules = useWorkspace((s) => s.enabledModules)
  const customEntities = useWorkspace((s) => s.customEntities)
  const overrides = useWorkspace((s) => s.overrides)
  const packages = useWorkspace((s) => s.packages)
  const { schema } = useI18n()
  return useMemo(
    () => resolveEntities({ enabledModules, customEntities, overrides, packages }, schema),
    [enabledModules, customEntities, overrides, packages, schema],
  )
}

export function useEntity(key: string | undefined): EntityDef | undefined {
  const entities = useEntities()
  return useMemo(() => entities.find((e) => e.key === key), [entities, key])
}

/** Raw (un-hidden) field list — used by the data model editor. */
export function useEntityAllFields(key: string): (FieldDef & { hidden?: boolean })[] {
  const enabledModules = useWorkspace((s) => s.enabledModules)
  const customEntities = useWorkspace((s) => s.customEntities)
  const override = useWorkspace((s) => s.overrides[key])
  const { schema } = useI18n()
  return useMemo(() => {
    const found = [...listModules().filter((m) => enabledModules.includes(m.id)).flatMap((m) => m.entities), ...customEntities].find(
      (e) => e.key === key,
    )
    if (!found) return []
    const base = localizeEntity(found, schema)
    const all = [...base.fields, ...(override?.extraFields ?? [])].map((f) => {
      const fo = override?.fields?.[f.key]
      return { ...f, label: fo?.label ?? f.label, options: fo?.options ?? f.options, hidden: fo?.hidden }
    })
    if (override?.fieldOrder?.length) {
      const idx = (k: string) => {
        const i = override.fieldOrder!.indexOf(k)
        return i === -1 ? 999 : i
      }
      all.sort((a, b) => idx(a.key) - idx(b.key))
    }
    return all
  }, [enabledModules, customEntities, override, key, schema])
}

/* -------------------------------------------------------------------------- */
/*  Mutations                                                                  */
/* -------------------------------------------------------------------------- */

function setViews(entity: string, fn: (list: ViewDef[]) => ViewDef[]) {
  set((s) => ({ ...s, views: { ...s.views, [entity]: fn(s.views[entity] ?? []) } }))
}

async function createView(entity: string, view: Omit<ViewDef, "id" | "entity">): Promise<ViewDef | null> {
  try {
    const saved = await workspaceApi.createView({ ...view, entity })
    setViews(entity, (list) => [...list, saved])
    return saved
  } catch (err) {
    apiError(err, "workspace.errors.createView")
    return null
  }
}

const creatingViews = new Set<string>()

const FIELD_TYPES = new Set(["text", "longtext", "number", "currency", "percent", "select", "multiselect", "status", "date", "datetime", "boolean", "email", "phone", "url", "user", "relation", "rating"])
const KEY_RE = /^[a-z][a-z0-9_]{0,47}$/

function validateManifest(m: PackageManifest): Omit<EntityDef, "module" | "custom">[] {
  if (!m || typeof m !== "object" || typeof m.name !== "string" || !m.name.trim()) throw new Error(t("workspace.manifest.needsName"))
  if (!Array.isArray(m.entities) || !m.entities.length) throw new Error(t("workspace.manifest.needsEntities"))
  return m.entities.map((e, i) => {
    const where = `entities[${i}]`
    if (!e || typeof e.key !== "string" || !KEY_RE.test(e.key)) throw new Error(t("workspace.manifest.keyFormat", { where }))
    if (!Array.isArray(e.fields) || !e.fields.length) throw new Error(t("workspace.manifest.fieldsEmpty", { where }))
    const fields = e.fields.map((f, j) => {
      if (!f || typeof f.key !== "string" || !KEY_RE.test(f.key)) throw new Error(t("workspace.manifest.invalidKey", { where: `${where}.fields[${j}]` }))
      if (!FIELD_TYPES.has(f.type)) throw new Error(t("workspace.manifest.unknownType", { where: `${where}.fields[${j}]`, type: String(f.type) }))
      return { ...f, label: f.label || f.key, custom: true }
    })
    const primaryField = e.primaryField && fields.some((f) => f.key === e.primaryField) ? e.primaryField : fields[0].key
    const label = e.label || e.key
    return {
      ...e,
      label,
      labelSingular: e.labelSingular || label.replace(/s$/, ""),
      icon: e.icon || "box",
      color: COLOR_KEYS.includes(e.color) ? e.color : "gray",
      primaryField,
      fields,
    }
  })
}

export const workspaceActions = {
  rename(name: string) {
    const prev = workspaceStore.get().name
    if (name === prev) return
    set({ name })
    workspaceApi.updateCompany({ name }).catch((err) => {
      set({ name: prev })
      apiError(err, "workspace.errors.rename")
    })
  },
  setTimezone(timezone: string) {
    const prev = workspaceStore.get().timezone
    if (timezone === prev) return
    set({ timezone })
    workspaceApi.updateCompany({ timezone }).catch((err) => {
      set({ timezone: prev })
      apiError(err, "workspace.errors.timezone")
    })
  },
  update(patch: Partial<Pick<WorkspaceState, "niche" | "color" | "logoAttachmentId">>) {
    set(patch)
    saveConfig(...(Object.keys(patch) as ConfigKey[]))
  },

  enableModule(id: string) {
    const s = workspaceStore.get()
    if (s.enabledModules.includes(id)) return
    set({ enabledModules: [...s.enabledModules, id] })
    saveConfig("enabledModules")
    // Re-enabling keeps the views made earlier; only missing ones are created.
    for (const view of moduleViews(id)) {
      const existing = workspaceStore.get().views[view.entity] ?? []
      if (!existing.some((v) => v.name === view.name)) void createView(view.entity, view)
    }
  },
  disableModule(id: string) {
    if (getModule(id)?.core) return
    set((s) => ({ ...s, enabledModules: s.enabledModules.filter((m) => m !== id) }))
    saveConfig("enabledModules")
  },

  /* Entities & fields ------------------------------------------------------ */
  overrideEntity(key: string, patch: Partial<EntityOverride>) {
    set((s) => ({ ...s, overrides: { ...s.overrides, [key]: { ...s.overrides[key], ...patch } } }))
    saveConfig("overrides")
  },
  overrideField(entity: string, field: string, patch: FieldOverride) {
    set((s) => {
      const o = s.overrides[entity] ?? {}
      return {
        ...s,
        overrides: { ...s.overrides, [entity]: { ...o, fields: { ...o.fields, [field]: { ...o.fields?.[field], ...patch } } } },
      }
    })
    saveConfig("overrides")
  },
  addField(entity: string, field: FieldDef) {
    set((s) => {
      const custom = s.customEntities.find((e) => e.key === entity)
      if (custom) {
        return {
          ...s,
          customEntities: s.customEntities.map((e) => (e.key === entity ? { ...e, fields: [...e.fields, { ...field, custom: true }] } : e)),
        }
      }
      const o = s.overrides[entity] ?? {}
      return { ...s, overrides: { ...s.overrides, [entity]: { ...o, extraFields: [...(o.extraFields ?? []), { ...field, custom: true }] } } }
    })
    saveConfig("customEntities", "overrides")
  },
  updateCustomField(entity: string, key: string, patch: Partial<FieldDef>) {
    set((s) => {
      const o = s.overrides[entity] ?? {}
      return {
        ...s,
        customEntities: s.customEntities.map((e) =>
          e.key === entity ? { ...e, fields: e.fields.map((f) => (f.key === key ? { ...f, ...patch } : f)) } : e,
        ),
        overrides: { ...s.overrides, [entity]: { ...o, extraFields: (o.extraFields ?? []).map((f) => (f.key === key ? { ...f, ...patch } : f)) } },
      }
    })
    saveConfig("customEntities", "overrides")
  },
  removeField(entity: string, key: string) {
    set((s) => {
      const o = s.overrides[entity] ?? {}
      return {
        ...s,
        customEntities: s.customEntities.map((e) => (e.key === entity ? { ...e, fields: e.fields.filter((f) => f.key !== key) } : e)),
        overrides: { ...s.overrides, [entity]: { ...o, extraFields: (o.extraFields ?? []).filter((f) => f.key !== key) } },
      }
    })
    saveConfig("customEntities", "overrides")
    for (const v of workspaceStore.get().views[entity] ?? []) {
      if (v.columns.includes(key)) workspaceActions.updateView(entity, v.id, { columns: v.columns.filter((c) => c !== key) })
    }
  },
  reorderFields(entity: string, order: string[]) {
    workspaceActions.overrideEntity(entity, { fieldOrder: order })
  },
  createEntity(def: Omit<EntityDef, "module" | "custom">) {
    const entity: EntityDef = { ...def, module: "custom", custom: true }
    set((s) => ({ ...s, customEntities: [...s.customEntities, entity] }))
    saveConfig("customEntities")
    void createView(entity.key, defaultTableView(entity))
    return entity
  },
  deleteEntity(key: string) {
    const views = workspaceStore.get().views[key] ?? []
    set((s) => {
      const next = { ...s.views }
      delete next[key]
      return { ...s, customEntities: s.customEntities.filter((e) => e.key !== key), views: next }
    })
    saveConfig("customEntities")
    for (const v of views) workspaceApi.deleteView(v.id).catch(() => undefined)
  },

  /* Views ------------------------------------------------------------------ */
  setActiveView(entity: string, viewId: string) {
    set((s) => ({ ...s, activeView: { ...s.activeView, [entity]: viewId } }))
    savePersonal()
  },
  async addView(entity: string, view: Omit<ViewDef, "id" | "entity">) {
    const saved = await createView(entity, view)
    if (saved) workspaceActions.setActiveView(entity, saved.id)
    return saved
  },
  updateView(entity: string, id: string, patch: Partial<ViewDef>) {
    setViews(entity, (list) => list.map((v) => (v.id === id ? { ...v, ...patch } : v)))
    later(`view:${id}`, () => {
      const view = (workspaceStore.get().views[entity] ?? []).find((v) => v.id === id)
      if (!view) return Promise.resolve()
      const { id: _id, entity: _entity, ...body } = view
      return workspaceApi.updateView(id, body)
    })
  },
  removeView(entity: string, id: string) {
    setViews(entity, (list) => list.filter((v) => v.id !== id))
    workspaceApi.deleteView(id).catch((err) => apiError(err, "workspace.errors.deleteView"))
  },
  ensureViews(entity: EntityDef) {
    const s = workspaceStore.get()
    if (!s.ready || s.views[entity.key]?.length || creatingViews.has(entity.key)) return
    creatingViews.add(entity.key)
    void createView(entity.key, defaultTableView(entity)).finally(() => creatingViews.delete(entity.key))
  },

  /* Navigation ------------------------------------------------------------- */
  setNavOrder(order: string[]) {
    set((s) => ({ ...s, nav: { ...s.nav, order } }))
    saveConfig("nav")
  },
  toggleNavHidden(id: string) {
    set((s) => ({
      ...s,
      nav: { ...s.nav, hidden: s.nav.hidden.includes(id) ? s.nav.hidden.filter((h) => h !== id) : [...s.nav.hidden, id] },
    }))
    saveConfig("nav")
  },
  toggleFavorite(fav: Favorite) {
    set((s) => {
      const exists = s.nav.favorites.some((f) => f.id === fav.id)
      return { ...s, nav: { ...s.nav, favorites: exists ? s.nav.favorites.filter((f) => f.id !== fav.id) : [...s.nav.favorites, fav] } }
    })
    savePersonal()
  },

  /* Dashboards ------------------------------------------------------------- */
  async createDashboard(d: Omit<DashboardDef, "id">): Promise<DashboardDef | null> {
    try {
      const saved = await workspaceApi.createDashboard({ ...d, position: workspaceStore.get().dashboards.length } as Omit<DashboardDef, "id">)
      set((s) => ({ ...s, dashboards: [...s.dashboards, saved] }))
      return saved
    } catch (err) {
      apiError(err, "workspace.errors.createDashboard")
      return null
    }
  },
  saveDashboard(d: DashboardDef) {
    set((s) => ({ ...s, dashboards: s.dashboards.map((x) => (x.id === d.id ? d : x)) }))
    later(`dashboard:${d.id}`, () => workspaceApi.updateDashboard(d.id, { name: d.name, icon: d.icon, widgets: d.widgets }))
  },
  removeDashboard(id: string) {
    set((s) => ({ ...s, dashboards: s.dashboards.filter((d) => d.id !== id) }))
    workspaceApi.deleteDashboard(id).catch((err) => apiError(err, "workspace.errors.deleteDashboard"))
  },

  /* Reports ---------------------------------------------------------------- */
  async saveReport(r: ReportDef): Promise<boolean> {
    const { id, ...body } = r
    try {
      if (isServerId(id)) {
        const saved = await workspaceApi.updateReport(id, body)
        set((s) => ({ ...s, reports: s.reports.map((x) => (x.id === id ? saved : x)) }))
      } else {
        const saved = await workspaceApi.createReport(body)
        set((s) => ({ ...s, reports: [saved, ...s.reports] }))
      }
      return true
    } catch (err) {
      apiError(err, "workspace.errors.saveReport")
      return false
    }
  },
  removeReport(id: string) {
    set((s) => ({ ...s, reports: s.reports.filter((r) => r.id !== id) }))
    workspaceApi.deleteReport(id).catch((err) => apiError(err, "workspace.errors.deleteReport"))
  },

  /* Packages --------------------------------------------------------------- */
  /** Creates the manifest's objects and views; throws with a readable message if it is invalid. */
  async installPackage(manifest: PackageManifest, source: InstalledPackage["source"], origin: string): Promise<InstalledPackage> {
    const state = workspaceStore.get()
    const taken = new Set(resolveEntities(state).map((e) => e.key).concat(state.customEntities.map((e) => e.key)))
    const entities = validateManifest(manifest)
    const clash = entities.find((e) => taken.has(e.key))
    if (clash) throw new Error(t("workspace.manifest.keyExists", { key: clash.key }))
    const views = manifest.views ?? []
    const created = entities.map((e) => {
      const entity: EntityDef = { ...e, module: "custom", custom: true }
      return entity
    })
    set((s) => ({ ...s, customEntities: [...s.customEntities, ...created] }))
    for (const e of created) {
      const own = views.filter((v) => v.entity === e.key)
      const list = own.length ? own : [defaultTableView(e)]
      for (const v of list) await createView(e.key, { ...v, filters: v.filters ?? [], columns: v.columns ?? e.fields.slice(0, 8).map((f) => f.key) })
    }
    const pkg: InstalledPackage = {
      id: uid("pkg"),
      name: manifest.name,
      version: manifest.version || "1.0.0",
      source,
      origin,
      installedAt: new Date().toISOString(),
      enabled: true,
      entities: created.map((e) => e.key),
    }
    set((s) => ({ ...s, packages: [pkg, ...s.packages] }))
    saveConfig("customEntities", "packages")
    return pkg
  },
  updatePackage(id: string, patch: Partial<Pick<InstalledPackage, "enabled">>) {
    set((s) => ({ ...s, packages: s.packages.map((p) => (p.id === id ? { ...p, ...patch } : p)) }))
    saveConfig("packages")
  },
  /** Removes the package and the objects it defined (their records stay in the database). */
  removePackage(id: string) {
    const pkg = workspaceStore.get().packages.find((p) => p.id === id)
    for (const key of pkg?.entities ?? []) workspaceActions.deleteEntity(key)
    set((s) => ({ ...s, packages: s.packages.filter((p) => p.id !== id) }))
    saveConfig("packages")
  },

  /* Connected apps --------------------------------------------------------- */
  async connectIntegration(app: string, account: string, settings: Record<string, boolean>) {
    try {
      const saved = await workspaceApi.connectIntegration(app, { account, settings })
      set((s) => ({ ...s, integrations: { ...s.integrations, [app]: saved } }))
      return saved
    } catch (err) {
      apiError(err, "workspace.errors.connectApp")
      return null
    }
  },
  updateIntegration(app: string, patch: Pick<IntegrationConnection, "settings">) {
    const conn = workspaceStore.get().integrations[app]
    if (!conn) return
    const next = { ...conn, ...patch }
    set((s) => ({ ...s, integrations: { ...s.integrations, [app]: next } }))
    later(`integration:${app}`, () => workspaceApi.connectIntegration(app, { account: next.account, status: next.status, settings: next.settings }))
  },
  async syncIntegration(app: string) {
    try {
      const saved = await workspaceApi.syncIntegration(app)
      set((s) => ({ ...s, integrations: { ...s.integrations, [app]: saved } }))
    } catch (err) {
      apiError(err, "workspace.errors.syncApp")
    }
  },
  disconnectIntegration(app: string) {
    set((s) => {
      const next = { ...s.integrations }
      delete next[app]
      return { ...s, integrations: next }
    })
    workspaceApi.disconnectIntegration(app).catch((err) => apiError(err, "workspace.errors.disconnectApp"))
  },
}
