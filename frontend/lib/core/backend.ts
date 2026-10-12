"use client"

import { ApiError, apiRequest, readBody, safeFetch } from "@/lib/api"
import type {
  Activity,
  ColorKey,
  CrmRecord,
  DashboardDef,
  EntityDef,
  Member,
  RecordValue,
  ViewDef,
} from "@/lib/core/types"

/**
 * Typed client for the FastAPI backend. Everything the workspace shows or edits
 * lives on the server: records of every object, workspace configuration,
 * views, dashboards, reports, connected apps,
 * the activity feed, members and personal preferences. Widget and report
 * numbers are computed server-side (stats.py).
 */

let companyId: number | null = null

export function setCompany(id: number) {
  companyId = id
}

function base(): string {
  if (companyId === null) throw new Error("Not signed in")
  return `/companies/${companyId}`
}

const get = <T,>(path: string, params?: Record<string, string | number | undefined>) =>
  apiRequest<T>(`${base()}${path}`, { params })
const send = <T,>(method: string, path: string, body?: unknown) =>
  apiRequest<T>(`${base()}${path}`, { method, body })

/* -------------------------------------------------------------------------- */
/*  Records                                                                    */
/* -------------------------------------------------------------------------- */

export const recordsApi = {
  listMany: (entities: string[]) =>
    get<Record<string, CrmRecord[]>>("/records", { entities: entities.join(",") }),
  get: (entity: string, id: string) => get<CrmRecord>(`/records/${entity}/${id}`),
  create: (entity: string, values: Record<string, RecordValue>) =>
    send<CrmRecord>("POST", `/records/${entity}`, { values }),
  update: (entity: string, id: string, values: Record<string, RecordValue>) =>
    send<CrmRecord>("PATCH", `/records/${entity}/${id}`, { values }),
  /** null — deleted; a record — archived but still listed (cancelled appointment). */
  remove: async (entity: string, id: string) =>
    (await send<{ record: CrmRecord | null }>("DELETE", `/records/${entity}/${id}`)).record,
}

/* -------------------------------------------------------------------------- */
/*  Workspace                                                                  */
/* -------------------------------------------------------------------------- */

export type ReportDef = {
  id: string
  name: string
  entity: string
  groupBy: string
  metric: "count" | "sum" | "avg"
  metricField?: string | null
  chart: "bar" | "line" | "pie" | "table"
}

export type IntegrationConnection = {
  id: string
  account: string
  connectedAt: string
  lastSyncedAt?: string | null
  status: "connected" | "syncing" | "error"
  settings: Record<string, boolean>
}

export type WorkspaceConfig = {
  enabledModules?: string[]
  customEntities?: EntityDef[]
  overrides?: Record<string, unknown>
  nav?: { order: string[]; hidden: string[] }
  packages?: unknown[]
  color?: string
  niche?: string
  logoAttachmentId?: number | null
}

export type WorkspaceSnapshot = {
  initialized: boolean
  company: { id: number; name: string; plan: string; timezone: string; trialEndsAt: string | null }
  config: WorkspaceConfig
  views: ViewDef[]
  dashboards: DashboardDef[]
  reports: ReportDef[]
  integrations: IntegrationConnection[]
}

type ViewInput = Omit<ViewDef, "id">
type DashboardInput = Omit<DashboardDef, "id">
type ReportInput = Omit<ReportDef, "id">

export const workspaceApi = {
  load: () => get<WorkspaceSnapshot>("/workspace"),
  bootstrap: (body: { config: WorkspaceConfig; views: ViewInput[]; dashboards: DashboardInput[]; reports: ReportInput[] }) =>
    send<WorkspaceSnapshot>("POST", "/workspace/bootstrap", body),
  reset: () => send<WorkspaceSnapshot>("POST", "/workspace/reset"),
  patchConfig: (config: Partial<WorkspaceConfig>) => send<WorkspaceConfig>("PATCH", "/workspace/config", { config }),
  putSchema: (schema: unknown[]) => send<void>("PUT", "/workspace/schema", schema),
  exportConfig: () => get<Record<string, unknown>>("/workspace/export"),
  importConfig: (body: unknown) => send<WorkspaceSnapshot>("POST", "/workspace/import", body),
  updateCompany: (patch: { name?: string; timezone?: string }) => apiRequest(`${base()}`, { method: "PATCH", body: patch }),

  createView: (view: ViewInput) => send<ViewDef>("POST", "/views", view),
  updateView: (id: string, patch: Partial<ViewDef>) => send<ViewDef>("PATCH", `/views/${id}`, patch),
  deleteView: (id: string) => send<void>("DELETE", `/views/${id}`),

  createDashboard: (d: DashboardInput) => send<DashboardDef>("POST", "/dashboards", d),
  updateDashboard: (id: string, patch: Partial<DashboardInput>) => send<DashboardDef>("PATCH", `/dashboards/${id}`, patch),
  deleteDashboard: (id: string) => send<void>("DELETE", `/dashboards/${id}`),

  createReport: (r: ReportInput) => send<ReportDef>("POST", "/reports", r),
  updateReport: (id: string, r: ReportInput) => send<ReportDef>("PUT", `/reports/${id}`, r),
  deleteReport: (id: string) => send<void>("DELETE", `/reports/${id}`),

  connectIntegration: (app: string, body: { account: string; status?: string; settings: Record<string, boolean> }) =>
    send<IntegrationConnection>("PUT", `/integrations/${app}`, body),
  syncIntegration: (app: string) => send<IntegrationConnection>("POST", `/integrations/${app}/sync`),
  disconnectIntegration: (app: string) => send<void>("DELETE", `/integrations/${app}`),

  uploadLogo: (file: File) => {
    const form = new FormData()
    form.set("file", file)
    form.set("entity_type", "company")
    form.set("entity_id", String(companyId))
    return apiRequest<{ id: number }>(`${base()}/attachments`, { method: "POST", body: form })
  },
  attachmentUrl: (id: number) => `/api/backend${base()}/attachments/${id}/content`,
}

/* -------------------------------------------------------------------------- */
/*  Activity feed                                                              */
/* -------------------------------------------------------------------------- */

export const activitiesApi = {
  list: (params: { limit?: number; entity?: string; recordId?: string } = {}) =>
    get<{ items: Activity[]; unread: number }>("/activities", {
      limit: params.limit,
      entity: params.entity,
      record_id: params.recordId,
    }),
  add: (body: { entity: string; recordId: string; kind: string; body: string }) => send<Activity>("POST", "/activities", body),
  markRead: (ids: string[]) => send<void>("POST", "/activities/read", { ids }),
  markAllRead: () => send<void>("POST", "/activities/read-all"),
}

/* -------------------------------------------------------------------------- */
/*  Analytics (server-side formulas)                                           */
/* -------------------------------------------------------------------------- */

export type WidgetResult<T = Record<string, unknown>> = { data?: T; error?: { code: string; message: string } }

export const analyticsApi = {
  widgets: (period: { year: number; month: number }, widgets: { id: string; type: string; config: Record<string, unknown> }[]) =>
    send<{ results: Record<string, WidgetResult> }>("POST", "/analytics/widgets", { period, widgets }),
  report: (q: { entity: string; groupBy: string; metric: string; metricField?: string | null }) =>
    send<{ rows: { key: string | null; value: number }[] }>("POST", "/analytics/report", q),
}

/* -------------------------------------------------------------------------- */
/*  Members & profile                                                          */
/* -------------------------------------------------------------------------- */

export type Profile = { member: Member; companyId: number; preferences: Record<string, unknown> }

export const membersApi = {
  list: () => get<Member[]>("/members"),
  invite: (body: { email: string; name?: string; role: Member["role"]; title?: string }) =>
    send<{ member: Member; temporaryPassword: string }>("POST", "/members/invite", body),
  update: (id: string, patch: Partial<Pick<Member, "name" | "title" | "role">>) => send<Member>("PATCH", `/members/${id}`, patch),
  remove: (id: string) => send<void>("DELETE", `/members/${id}`),
  me: () => get<Profile>("/me"),
  updateMe: (patch: { name?: string; title?: string; email?: string | null; preferences?: Record<string, unknown> }) =>
    send<Profile>("PATCH", "/me", patch),
}

/* -------------------------------------------------------------------------- */
/*  API keys & webhooks (tenant from the session, no company in the path)     */
/* -------------------------------------------------------------------------- */

export type ApiKey = { id: number; name: string; prefix: string; is_active: boolean; expires_at: string | null; last_used_at: string | null; created_at: string }
export type WebhookSub = { id: number; url: string; events: string[]; is_active: boolean; description: string | null; created_at: string }

export const WEBHOOK_EVENTS = [
  "record.created",
  "record.updated",
  "record.deleted",
  "client.created",
  "client.updated",
  "appointment.created",
  "appointment.rescheduled",
  "appointment.cancelled",
  "lead.received",
] as const

export const integrationsApi = {
  listKeys: () => apiRequest<ApiKey[]>("/integrations/api-keys"),
  createKey: (name: string) => apiRequest<ApiKey & { token: string }>("/integrations/api-keys", { method: "POST", body: { name } }),
  revokeKey: (id: number) => apiRequest<ApiKey>(`/integrations/api-keys/${id}`, { method: "DELETE" }),
  listWebhooks: () => apiRequest<WebhookSub[]>("/integrations/webhooks"),
  createWebhook: (body: { url: string; events: string[]; description?: string }) =>
    apiRequest<WebhookSub & { secret: string }>("/integrations/webhooks", { method: "POST", body }),
  updateWebhook: (id: number, body: Partial<{ url: string; events: string[]; is_active: boolean }>) =>
    apiRequest<WebhookSub>(`/integrations/webhooks/${id}`, { method: "PATCH", body }),
  deleteWebhook: (id: number) => apiRequest<void>(`/integrations/webhooks/${id}`, { method: "DELETE" }),
}

/* -------------------------------------------------------------------------- */
/*  Security (Settings → Security)                                             */
/* -------------------------------------------------------------------------- */

export type SecurityOverview = {
  email: string | null
  email_verified: boolean
  phone: string | null
  phone_verified: boolean
  has_password: boolean
  password_changed_at: string | null
  totp: boolean
  sms: boolean
  sms_available: boolean
  passkeys: { id: number; name: string; added_at: string; last_used_at: string | null }[]
  backup_codes_left: number
  social: Record<"google" | "microsoft" | "apple", boolean>
  providers: Record<"google" | "microsoft" | "apple", boolean>
  reauth_required: boolean
}

export type SessionInfo = { id: string; device: string; ip: string | null; method: string; created_at: string; last_seen_at: string; current: boolean }
export type LoginEvent = { at: string; event: string; method: string; status: "success" | "failed" | "blocked"; ip: string | null; device: string }
export type SecurityPolicy = {
  require2fa: boolean
  methods: Record<string, boolean>
  timeout: string
  minLength: string
  newDeviceAlert: boolean
  ipAllowlist: string
  can_edit: boolean
}

const security = <T,>(path: string, method = "GET", body?: unknown) =>
  apiRequest<T>(`/auth/security${path}`, method === "GET" ? {} : { method, body: body ?? {} })

export const securityApi = {
  overview: () => security<SecurityOverview>(""),
  reauth: (body: { password?: string; code?: string }) => security<void>("/reauth", "POST", body),
  changePassword: (body: { current_password?: string; new_password: string; sign_out_others: boolean }) =>
    security<void>("/password", "POST", body),
  startEmail: (email: string) => security<{ sent_to: string }>("/email/start", "POST", { email }),
  confirmEmail: (code: string) => security<SecurityOverview>("/email/confirm", "POST", { code }),
  startPhone: (phone: string) => security<{ sent_to: string }>("/phone/start", "POST", { phone }),
  confirmPhone: (code: string) => security<SecurityOverview>("/phone/confirm", "POST", { code }),
  removePhone: () => security<SecurityOverview>("/phone", "DELETE"),
  setSms: (enabled: boolean) => security<SecurityOverview>("/sms", "PUT", { enabled }),
  setupTotp: () => security<{ secret: string; otpauth_uri: string; qr: string }>("/totp/setup", "POST"),
  enableTotp: (code: string) => security<{ codes: string[] }>("/totp/enable", "POST", { code }),
  disableTotp: () => security<SecurityOverview>("/totp", "DELETE"),
  backupCodes: () => security<{ codes: string[] }>("/backup-codes", "POST"),
  passkeyOptions: () => security<Record<string, unknown>>("/passkeys/options", "POST"),
  addPasskey: (name: string, credential: Record<string, unknown>) =>
    security<SecurityOverview>("/passkeys", "POST", { name, credential }),
  removePasskey: (id: number) => security<SecurityOverview>(`/passkeys/${id}`, "DELETE"),
  unlinkSocial: (provider: string) => security<SecurityOverview>(`/social/${provider}`, "DELETE"),
  history: () => security<LoginEvent[]>("/history"),
  sessions: () => apiRequest<SessionInfo[]>("/auth/sessions"),
  revokeSession: (id: string) => apiRequest<void>(`/auth/sessions/${id}`, { method: "DELETE" }),
  revokeOthers: () => apiRequest<{ revoked: number }>("/auth/sessions/revoke-others", { method: "POST", body: {} }),
  policy: () => get<SecurityPolicy>("/security-policy"),
  updatePolicy: (patch: Partial<Omit<SecurityPolicy, "can_edit">>) => send<SecurityPolicy>("PATCH", "/security-policy", patch),
}

/** Server schema of an object (what the backend needs for formulas, feed titles, webhooks). */
export function schemaOf(e: EntityDef) {
  return {
    key: e.key,
    label: e.label,
    labelSingular: e.labelSingular,
    primaryField: e.primaryField,
    stageField: e.stageField,
    dateField: e.dateField,
    amountField: e.amountField,
    ownerField: e.ownerField,
    fields: e.fields.map((f) => ({
      key: f.key,
      label: f.label,
      type: f.type,
      relation: f.relation,
      options: f.options?.map((o) => ({ value: o.value, label: o.label, color: o.color })),
    })),
  }
}
