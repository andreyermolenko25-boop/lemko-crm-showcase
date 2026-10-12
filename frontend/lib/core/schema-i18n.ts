"use client"

import { useCallback } from "react"
import { useI18n } from "@/components/i18n-provider"
import type { EntityDef, FieldDef, ModuleManifest } from "@/lib/core/types"
import type { MessageKey, SchemaMessages } from "@/lib/i18n/translate"
import { getModule } from "@/lib/modules"

/**
 * Built-in modules are written in English; their objects, fields and options
 * get the labels of the interface language here. Workspace renames
 * (overrides) are applied after this, so a team's own names always win. The
 * server keeps receiving the English schema — it is shared by everyone.
 */

function localizeField(field: FieldDef, messages: NonNullable<NonNullable<SchemaMessages["entities"]>[string]["fields"]>[string] | undefined): FieldDef {
  if (!messages) return field
  return {
    ...field,
    label: messages.label ?? field.label,
    description: messages.description ?? field.description,
    options: field.options?.map((o) => ({ ...o, label: messages.options?.[o.value] ?? o.label })),
  }
}

export function localizeEntity(entity: EntityDef, schema: SchemaMessages): EntityDef {
  if (entity.custom) return entity
  const messages = schema.entities?.[entity.key]
  if (!messages) return entity
  return {
    ...entity,
    label: messages.label ?? entity.label,
    labelSingular: messages.labelSingular ?? entity.labelSingular,
    description: messages.description ?? entity.description,
    fields: entity.fields.map((f) => (f.custom ? f : localizeField(f, messages.fields?.[f.key]))),
  }
}

export function localizeModule(mod: ModuleManifest, schema: SchemaMessages): ModuleManifest {
  const messages = schema.modules?.[mod.id]
  return {
    ...mod,
    name: messages?.name ?? mod.name,
    tagline: messages?.tagline ?? mod.tagline,
    description: messages?.description ?? mod.description,
    niches: messages?.niches ?? mod.niches,
    entities: mod.entities.map((e) => localizeEntity(e, schema)),
  }
}

/** (moduleId) → module name in the interface language. */
export function useModuleName() {
  const { schema } = useI18n()
  return useCallback(
    (id: string): string | undefined => {
      const mod = getModule(id)
      return mod ? (schema.modules?.[id]?.name ?? mod.name) : undefined
    },
    [schema],
  )
}

export function useLocalizeModule() {
  const { schema } = useI18n()
  return useCallback((mod: ModuleManifest) => localizeModule(mod, schema), [schema])
}

/**
 * Names the app gives to new workspaces (dashboards, widgets, reports) in
 * English. Workspaces created before the interface was translated store them
 * like that; they are shown in the interface language until someone renames them.
 */
const DEFAULT_NAMES: Record<string, MessageKey> = {
  Overview: "workspace.defaults.overview",
  Team: "workspace.defaults.team",
  "Won revenue": "workspace.defaults.wonRevenue",
  "Active deals": "workspace.defaults.activeDeals",
  "Win rate": "workspace.defaults.winRate",
  "Average deal size": "workspace.defaults.averageDeal",
  "Sales trend": "workspace.defaults.salesTrend",
  "Sales funnel": "workspace.defaults.salesFunnel",
  "Biggest open deals": "workspace.defaults.biggestDeals",
  "Upcoming tasks": "workspace.defaults.upcomingTasks",
  Activity: "workspace.defaults.activity",
  Leaderboard: "workspace.defaults.leaderboard",
  "Quarter goal": "workspace.defaults.quarterGoal",
  "Deals by source": "workspace.defaults.dealsBySource",
  Tasks: "workspace.defaults.tasks",
  "Team notes": "workspace.defaults.teamNotes",
  "Pipeline value by stage": "workspace.defaults.pipelineByStage",
  "Contacts by lifecycle": "workspace.defaults.contactsByLifecycle",
  "Won revenue by owner": "workspace.defaults.wonRevenueByOwner",
  "New dashboard": "home.newDashboard",
  "New report": "reports.newReport",
  Records: "widgets.recordsLabel",
  Trend: "widgets.trend",
  Funnel: "widgets.funnel",
}

/** (stored name) → the same name in the interface language when it is one of the built-in defaults. */
export function useDefaultName() {
  const { t, schema, locale } = useI18n()
  return useCallback(
    (name: string | undefined): string => {
      if (!name || locale === "en") return name ?? ""
      const key = DEFAULT_NAMES[name]
      if (key) return t(key)
      return schema.views?.[name] ?? name
    },
    [t, schema, locale],
  )
}
