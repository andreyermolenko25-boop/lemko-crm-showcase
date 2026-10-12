import type { ComponentType } from "react"

/* -------------------------------------------------------------------------- */
/*  Schema                                                                    */
/*  The whole UI is driven by these definitions — a niche module only ships   */
/*  data (entities, fields, views, widgets), never bespoke list/detail pages.  */
/* -------------------------------------------------------------------------- */

export type ColorKey =
  | "gray"
  | "red"
  | "orange"
  | "amber"
  | "green"
  | "teal"
  | "blue"
  | "indigo"
  | "violet"
  | "pink"

export const COLOR_KEYS: ColorKey[] = [
  "gray",
  "red",
  "orange",
  "amber",
  "green",
  "teal",
  "blue",
  "indigo",
  "violet",
  "pink",
]

export type FieldType =
  | "text"
  | "longtext"
  | "number"
  | "currency"
  | "percent"
  | "select"
  | "multiselect"
  | "status"
  | "date"
  | "datetime"
  | "boolean"
  | "email"
  | "phone"
  | "url"
  | "user"
  | "relation"
  | "rating"

export type FieldOption = { value: string; label: string; color: ColorKey }

export type FieldDef = {
  key: string
  label: string
  type: FieldType
  description?: string
  required?: boolean
  /** select / multiselect / status */
  options?: FieldOption[]
  /** relation → target entity key */
  relation?: string
  /** System fields cannot be deleted (but can be renamed / hidden). */
  system?: boolean
  /** Computed by the server (lifetime value, paid amount, stock status) — not editable. */
  readOnly?: boolean
  /** Added by the workspace (not by a module). */
  custom?: boolean
}

export type EntityDef = {
  key: string
  label: string
  labelSingular: string
  icon: string
  color: ColorKey
  description?: string
  /** Owning module id (or "custom"). */
  module: string
  /** Field used as the record title. */
  primaryField: string
  /** Optional secondary line under the title. */
  secondaryField?: string
  fields: FieldDef[]
  /** Status/stage field — enables Board (kanban) view. */
  stageField?: string
  /** Date field — enables Calendar view. */
  dateField?: string
  /** Money field — used for totals on board columns & reports. */
  amountField?: string
  /** Owner (user) field. */
  ownerField?: string
  custom?: boolean
}

/* -------------------------------------------------------------------------- */
/*  Views                                                                      */
/* -------------------------------------------------------------------------- */

export type ViewType = "table" | "board" | "gallery" | "calendar" | "list"

export type FilterOp =
  | "contains"
  | "not_contains"
  | "is"
  | "is_not"
  | "gt"
  | "lt"
  | "empty"
  | "not_empty"

export type FilterRule = { id: string; field: string; op: FilterOp; value?: string }

export type SortRule = { field: string; dir: "asc" | "desc" }

export type ViewDef = {
  id: string
  entity: string
  name: string
  type: ViewType
  /** Ordered visible columns (table / gallery / list card fields). */
  columns: string[]
  widths?: Record<string, number>
  filters: FilterRule[]
  sort?: SortRule
  groupBy?: string
  rowHeight?: "short" | "medium" | "tall"
  /** Shared with the workspace vs. personal. */
  shared?: boolean
}

/* -------------------------------------------------------------------------- */
/*  Records                                                                    */
/* -------------------------------------------------------------------------- */

export type RecordValue = string | number | boolean | string[] | null | undefined

export type CrmRecord = {
  id: string
  createdAt: string
  updatedAt: string
  [field: string]: RecordValue
}

export type ActivityKind =
  | "created"
  | "updated"
  | "deleted"
  | "stage"
  | "note"
  | "email"
  | "call"
  | "meeting"
  | "task"
  | "comment"
  // Personal notifications.
  | "assigned"
  | "mention"
  | "reminder"
  | "digest"
  | "automation"

export type Activity = {
  id: string
  kind: ActivityKind
  entity: string
  recordId: string
  /** Member id ("u_3"); null — the system (automation, integration, schedule). */
  actor: string | null
  at: string
  title: string
  body?: string | null
  read?: boolean
  /** Addressed to the signed-in member only (assigned, mention, reminder…). */
  personal?: boolean
  source?: string | null
  /** What happened ("record.created"…) — the UI builds the sentence from it; older events have only `title`. */
  event?: string | null
  params?: Record<string, unknown> | null
}

export type Member = {
  id: string
  name: string
  email: string
  role: "Owner" | "Admin" | "Manager" | "Member" | "Viewer"
  title: string
  /** Avatar colour (derived from the id on the client). */
  color: ColorKey
  /** active — has signed in; invited — never signed in yet; disabled — access blocked. */
  status: "active" | "invited" | "disabled"
}

/* -------------------------------------------------------------------------- */
/*  Dashboards & widgets                                                       */
/* -------------------------------------------------------------------------- */

/** Size in grid cells: w of 12 columns, h in rows. */
export type WidgetSize = { w: number; h: number }

export type WidgetInstance = {
  id: string
  type: string
  title?: string
  size: WidgetSize
  /** Top-left grid cell; absent on widgets saved before the free layout. */
  pos?: { x: number; y: number }
  config: Record<string, unknown>
}

export type DashboardDef = {
  id: string
  name: string
  icon: string
  widgets: WidgetInstance[]
}

export type WidgetProps = {
  widget: WidgetInstance
  editing: boolean
  onConfig: (patch: Record<string, unknown>) => void
}

export type WidgetDef = {
  type: string
  name: string
  description: string
  icon: string
  module: string
  defaultSize: WidgetSize
  defaultConfig?: Record<string, unknown>
  /** Only shown when these entities exist. */
  requires?: string[]
  component: ComponentType<WidgetProps>
}

/* -------------------------------------------------------------------------- */
/*  Modules                                                                    */
/* -------------------------------------------------------------------------- */

export type ModuleCategory =
  | "Core"
  | "Sales"
  | "Service"
  | "Operations"
  | "Finance"
  | "Support"
  | "Industry"

export type ModuleManifest = {
  id: string
  name: string
  tagline: string
  description: string
  icon: string
  color: ColorKey
  category: ModuleCategory
  version: string
  /** Core modules cannot be disabled. */
  core?: boolean
  niches?: string[]
  entities: EntityDef[]
  /** Default views created on install. */
  views?: Omit<ViewDef, "id">[]
}
