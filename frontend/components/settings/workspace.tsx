"use client"

import { useEffect, useMemo, useRef, useState } from "react"
import { Check, Copy, Download, KeyRound, MoreHorizontal, Plus, RotateCcw, Trash2, Upload, Webhook } from "lucide-react"
import { toast } from "sonner"
import { useTheme } from "next-themes"
import type { Member } from "@/lib/core/types"
import { dataActions, dataStore, useCurrentUserId, useMe, useMembers } from "@/lib/core/data"
import { useWorkspace, workspaceActions } from "@/lib/core/workspace"
import { integrationsApi, workspaceApi, WEBHOOK_EVENTS, type ApiKey, type WebhookSub } from "@/lib/core/backend"
import { importWorkspace, resetWorkspace, savePreferences, useSession } from "@/lib/core/session"
import { formatDate, timeAgo } from "@/lib/core/format"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { Checkbox } from "@/components/ui/checkbox"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { MemberAvatar, Monogram, Tag } from "@/components/crm/primitives"
import { WorkspaceLogo } from "@/components/shell/sidebar"
import { SettingsRow, SettingsSection } from "@/components/settings/shared"
import { useI18n, useT } from "@/components/i18n-provider"
import { LOCALE_NAMES } from "@/lib/i18n/config"
import type { MessageKey } from "@/lib/i18n/translate"
import Link from "next/link"

function errorText(err: unknown) {
  return err instanceof Error ? err.message : String(err)
}

function useRole() {
  const role = useSession((s) => s.role)
  return { role, isOwner: role === "Owner", isAdmin: role === "Owner" || role === "Admin" }
}

function OnlyOwnerAndAdmins() {
  const t = useT()
  return <p className="px-[var(--pad)] py-4 text-sm text-muted-foreground">{t("workspaceSettings.onlyOwnerAdmins")}</p>
}

/** A secret the server shows exactly once (API key token, webhook signing secret). */
function SecretDialog({ secret, title, hint, onClose }: { secret: { value: string } | null; title: string; hint: string; onClose: () => void }) {
  const [copied, setCopied] = useState(false)
  const t = useT()
  return (
    <Dialog open={!!secret} onOpenChange={(o) => !o && (setCopied(false), onClose())}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{hint}</DialogDescription>
        </DialogHeader>
        <div className="flex items-center gap-2">
          <code className="min-w-0 flex-1 break-all rounded-md bg-muted px-2.5 py-2 font-mono text-xs">{secret?.value}</code>
          <Button
            variant="outline"
            size="icon-sm"
            aria-label={t("workspaceSettings.copy")}
            onClick={() => {
              void navigator.clipboard?.writeText(secret?.value ?? "")
              setCopied(true)
            }}
          >
            {copied ? <Check /> : <Copy />}
          </Button>
        </div>
        <DialogFooter>
          <Button onClick={() => (setCopied(false), onClose())}>{t("common.done")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/* -------------------------------------------------------------------------- */
/*  General                                                                    */
/* -------------------------------------------------------------------------- */

const TIME_ZONES: string[] = (() => {
  try {
    return (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.("timeZone") ?? []
  } catch {
    return []
  }
})()

export function GeneralSettings() {
  const name = useWorkspace((s) => s.name)
  const niche = useWorkspace((s) => s.niche)
  const plan = useWorkspace((s) => s.plan)
  const timezone = useWorkspace((s) => s.timezone)
  const trialEndsAt = useWorkspace((s) => s.trialEndsAt)
  const logo = useWorkspace((s) => s.logoAttachmentId)
  const { isOwner, role } = useRole()
  const canEdit = role !== "Viewer"
  const file = useRef<HTMLInputElement>(null)
  const [uploading, setUploading] = useState(false)
  const zones = useMemo(() => (TIME_ZONES.includes(timezone) ? TIME_ZONES : [timezone, ...TIME_ZONES]), [timezone])
  const { t, maybe } = useI18n()

  async function upload(f: File) {
    if (!f.type.startsWith("image/")) return toast.error(t("workspaceSettings.chooseImage"))
    setUploading(true)
    try {
      const { id } = await workspaceApi.uploadLogo(f)
      workspaceActions.update({ logoAttachmentId: id })
      toast.success(t("workspaceSettings.logoUpdated"))
    } catch (err) {
      toast.error(t("workspaceSettings.logoFailed"), { description: errorText(err) })
    } finally {
      setUploading(false)
    }
  }

  return (
    <div className="flex flex-col gap-[var(--gap)]">
      <SettingsSection title={t("workspaceSettings.workspace")} description={t("workspaceSettings.workspaceDescription")}>
        <SettingsRow label={t("workspaceSettings.logo")} hint={t("workspaceSettings.logoHint")}>
          <div className="flex items-center gap-3">
            <WorkspaceLogo className="size-12 rounded-xl text-sm" />
            <input
              ref={file}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0]
                e.target.value = ""
                if (f) void upload(f)
              }}
            />
            <Button variant="outline" size="sm" disabled={!canEdit || uploading} onClick={() => file.current?.click()}>
              <Upload /> {uploading ? t("workspaceSettings.uploading") : t("workspaceSettings.upload")}
            </Button>
            {logo && canEdit && (
              <Button variant="ghost" size="sm" onClick={() => workspaceActions.update({ logoAttachmentId: null })}>
                {t("common.remove")}
              </Button>
            )}
          </div>
        </SettingsRow>
        <SettingsRow label={t("workspaceSettings.workspaceName")} hint={isOwner ? undefined : t("workspaceSettings.ownerRenameOnly")}>
          <Input
            key={name}
            className="w-64"
            defaultValue={name}
            disabled={!isOwner}
            onBlur={(e) => e.target.value.trim().length >= 2 && workspaceActions.rename(e.target.value.trim())}
          />
        </SettingsRow>
        <SettingsRow label={t("workspaceSettings.niche")} hint={t("workspaceSettings.nicheHint")}>
          <Input className="w-64" defaultValue={niche} disabled={!canEdit} onBlur={(e) => e.target.value.trim() !== niche && workspaceActions.update({ niche: e.target.value.trim() })} />
        </SettingsRow>
        <SettingsRow label={t("workspaceSettings.timezone")} hint={t("workspaceSettings.timezoneHint")}>
          <Select value={timezone} onValueChange={(v) => workspaceActions.setTimezone(v)} disabled={!isOwner}>
            <SelectTrigger className="w-64">
              <SelectValue />
            </SelectTrigger>
            <SelectContent className="max-h-72">
              {zones.map((z) => (
                <SelectItem key={z} value={z}>
                  {z.replace(/_/g, " ")}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </SettingsRow>
      </SettingsSection>
      <SettingsSection title={t("workspaceSettings.plan")}>
        <SettingsRow label={plan ? (maybe(`workspaceSettings.plans.${plan}`) ?? plan) : "—"} hint={trialEndsAt ? t("workspaceSettings.trialEnds", { date: formatDate(trialEndsAt, { dateStyle: "medium" }) }) : undefined}>
          <Tag color={trialEndsAt ? "amber" : "green"} dot>
            {trialEndsAt ? t("workspaceSettings.trial") : t("workspaceSettings.active")}
          </Tag>
        </SettingsRow>
      </SettingsSection>
    </div>
  )
}

/* -------------------------------------------------------------------------- */
/*  Profile                                                                    */
/* -------------------------------------------------------------------------- */

export function ProfileSettings() {
  const me = useMe()
  const { theme } = useTheme()
  const { t, locale } = useI18n()
  if (!me) return null
  return (
    <SettingsSection title={t("workspaceSettings.profile")}>
      <SettingsRow label={t("workspaceSettings.avatar")}>
        <Monogram name={me.name} color={me.color} size="xl" />
      </SettingsRow>
      <SettingsRow label={t("workspaceSettings.fullName")}>
        <Input className="w-64" defaultValue={me.name} onBlur={(e) => e.target.value.trim() && e.target.value.trim() !== me.name && void dataActions.updateProfile({ name: e.target.value.trim() })} />
      </SettingsRow>
      <SettingsRow label={t("workspaceSettings.jobTitle")}>
        <Input className="w-64" defaultValue={me.title} onBlur={(e) => e.target.value.trim() !== me.title && void dataActions.updateProfile({ title: e.target.value.trim() })} />
      </SettingsRow>
      <SettingsRow label={t("workspaceSettings.email")} hint={t("workspaceSettings.emailHint")}>
        <Input
          className="w-64"
          type="email"
          defaultValue={me.email}
          onBlur={(e) => {
            const v = e.target.value.trim()
            if (v === (me.email ?? "")) return
            if (v && !/^\S+@\S+\.\S+$/.test(v)) return toast.error(t("workspaceSettings.invalidEmail"))
            void dataActions.updateProfile({ email: v || null })
          }}
        />
      </SettingsRow>
      <SettingsRow label={t("workspaceSettings.theme")} hint={t("workspaceSettings.themeHint")}>
        <span className="text-sm text-muted-foreground">{theme === "light" || theme === "dark" || theme === "system" ? t(`appearance.${theme}`) : theme}</span>
      </SettingsRow>
      <SettingsRow label={t("workspaceSettings.language")} hint={t("workspaceSettings.languageHint")}>
        <Link href="/settings/language" className="text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline">
          {LOCALE_NAMES[locale]}
        </Link>
      </SettingsRow>
    </SettingsSection>
  )
}

/* -------------------------------------------------------------------------- */
/*  Members                                                                    */
/* -------------------------------------------------------------------------- */

const ROLES: Member["role"][] = ["Owner", "Admin", "Manager", "Member", "Viewer"]
const ALL = ROLES
const EDITORS: Member["role"][] = ["Owner", "Admin", "Manager", "Member"]
const ADMINS: Member["role"][] = ["Owner", "Admin"]
/** What the API enforces for each role. */
const PERMS: { key: MessageKey; roles: Member["role"][] }[] = [
  { key: "workspaceSettings.perms.view", roles: ALL },
  { key: "workspaceSettings.perms.edit", roles: EDITORS },
  { key: "workspaceSettings.perms.customise", roles: EDITORS },
  { key: "workspaceSettings.perms.members", roles: ADMINS },
  { key: "workspaceSettings.perms.api", roles: ADMINS },
  { key: "workspaceSettings.perms.rename", roles: ["Owner"] },
]

const STATUS_TAG: Record<Member["status"], { label: MessageKey; color: "amber" | "red" } | null> = {
  active: null,
  invited: { label: "workspaceSettings.invited", color: "amber" },
  disabled: { label: "workspaceSettings.deactivated", color: "red" },
}

export function MembersSettings() {
  const members = useMembers()
  const meId = useCurrentUserId()
  const { isAdmin } = useRole()
  const [open, setOpen] = useState(false)
  const [email, setEmail] = useState("")
  const [name, setName] = useState("")
  const [role, setRole] = useState<Member["role"]>("Member")
  const [sending, setSending] = useState(false)
  const [invited, setInvited] = useState<{ email: string; password: string } | null>(null)
  const t = useT()

  async function invite() {
    setSending(true)
    const password = await dataActions.inviteMember({ email, name: name.trim() || undefined, role })
    setSending(false)
    if (password === null) return
    setOpen(false)
    setInvited({ email, password })
    setEmail("")
    setName("")
  }

  return (
    <div className="flex flex-col gap-[var(--gap)]">
      <section className="surface">
        <header className="flex items-center justify-between border-b px-[var(--pad)] py-4">
          <div>
            <h2 className="text-base font-semibold">{t("workspaceSettings.members")}</h2>
            <p className="mt-0.5 text-sm text-muted-foreground">
              {t("workspaceSettings.peopleCount", { count: members.filter((m) => m.status !== "disabled").length })}
            </p>
          </div>
          {isAdmin && (
            <Button size="sm" onClick={() => setOpen(true)}>
              <Plus /> {t("workspaceSettings.invite")}
            </Button>
          )}
        </header>
        <ul className="divide-y">
          {members.map((m) => {
            const tag = STATUS_TAG[m.status]
            const locked = !isAdmin || m.role === "Owner" || m.id === meId || m.status === "disabled"
            return (
              <li key={m.id} className="flex items-center gap-3 px-[var(--pad)] py-3">
                <MemberAvatar member={m} size="md" />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">
                    {m.name} {m.id === meId && <span className="text-muted-foreground">{t("workspaceSettings.you")}</span>}
                  </p>
                  <p className="truncate text-xs text-muted-foreground">{m.email}</p>
                </div>
                {tag && <Tag color={tag.color}>{t(tag.label)}</Tag>}
                <Select value={m.role} onValueChange={(v) => dataActions.updateMember(m.id, { role: v as Member["role"] })} disabled={locked}>
                  <SelectTrigger size="sm" className="h-8 w-28">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {ROLES.filter((r) => r !== "Owner" || m.role === "Owner").map((r) => (
                      <SelectItem key={r} value={r}>
                        {t(`roles.${r}`)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="ghost" size="icon-sm" disabled={locked} aria-label={t("workspaceSettings.memberOptions")}>
                      <MoreHorizontal />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem variant="destructive" onSelect={() => dataActions.removeMember(m.id)}>
                      <Trash2 /> {t("workspaceSettings.deactivate")}
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </li>
            )
          })}
        </ul>
      </section>

      <section className="surface overflow-hidden">
        <header className="border-b px-[var(--pad)] py-4">
          <h2 className="text-base font-semibold">{t("workspaceSettings.rolePermissions")}</h2>
          <p className="mt-0.5 text-sm text-muted-foreground">{t("workspaceSettings.rolePermissionsDescription")}</p>
        </header>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[36rem] text-sm">
            <thead>
              <tr className="border-b text-left text-xs uppercase tracking-wider text-subtle-foreground">
                <th className="px-[var(--pad)] py-2.5 font-medium">{t("workspaceSettings.permission")}</th>
                {ROLES.map((r) => (
                  <th key={r} className="px-2 py-2.5 text-center font-medium">
                    {t(`roles.${r}`)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y">
              {PERMS.map((p) => (
                <tr key={p.key}>
                  <td className="px-[var(--pad)] py-2.5">{t(p.key)}</td>
                  {ROLES.map((r) => (
                    <td key={r} className="px-2 py-2.5 text-center">
                      <span className={p.roles.includes(r) ? "inline-block size-2 rounded-full bg-brand" : "inline-block size-2 rounded-full bg-foreground/10"} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t("workspaceSettings.inviteTitle")}</DialogTitle>
            <DialogDescription>{t("workspaceSettings.inviteDescription")}</DialogDescription>
          </DialogHeader>
          <form
            id="invite-member"
            className="grid gap-3"
            onSubmit={(e) => {
              e.preventDefault()
              void invite()
            }}
          >
            <div className="grid gap-1.5">
              <Label className="text-xs">{t("workspaceSettings.email")}</Label>
              <Input value={email} onChange={(e) => setEmail(e.target.value)} placeholder={t("security.emailPlaceholder")} autoFocus />
            </div>
            <div className="grid gap-1.5">
              <Label className="text-xs">{t("workspaceSettings.name")}</Label>
              <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={t("workspaceSettings.optional")} />
            </div>
            <div className="grid gap-1.5">
              <Label className="text-xs">{t("workspaceSettings.role")}</Label>
              <Select value={role} onValueChange={(v) => setRole(v as Member["role"])}>
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {ROLES.filter((r) => r !== "Owner").map((r) => (
                    <SelectItem key={r} value={r}>
                      {t(`roles.${r}`)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </form>
          <DialogFooter>
            <Button type="submit" form="invite-member" disabled={sending || !/^\S+@\S+\.\S+$/.test(email)}>
              {sending ? t("workspaceSettings.inviting") : t("workspaceSettings.invite")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <SecretDialog
        secret={invited && { value: invited.password }}
        title={t("workspaceSettings.canSignIn", { email: invited?.email ?? "" })}
        hint={t("workspaceSettings.passwordHint")}
        onClose={() => setInvited(null)}
      />
    </div>
  )
}

/* -------------------------------------------------------------------------- */
/*  Notifications (stored in the member's preferences, read by the server)     */
/* -------------------------------------------------------------------------- */

type Channel = { inApp: boolean; email: boolean }
const EVENTS: { key: "stage" | "assigned" | "mention" | "reminder" | "integration" | "digest"; inApp: boolean; email: boolean }[] = [
  { key: "stage", inApp: true, email: true },
  { key: "assigned", inApp: true, email: true },
  { key: "mention", inApp: true, email: false },
  { key: "reminder", inApp: true, email: true },
  { key: "integration", inApp: false, email: false },
  { key: "digest", inApp: false, email: true },
]

export function NotificationSettings() {
  const saved = useSession((s) => s.preferences.notifications) as Record<string, Partial<Channel>> | undefined
  const t = useT()
  const state = useMemo(
    () => Object.fromEntries(EVENTS.map((e) => [e.key, { inApp: saved?.[e.key]?.inApp ?? e.inApp, email: saved?.[e.key]?.email ?? e.email }])) as Record<string, Channel>,
    [saved],
  )
  const toggle = (key: string, channel: keyof Channel, value: boolean) => {
    const next = { ...state, [key]: { ...state[key], [channel]: value } }
    savePreferences({ notifications: next }).catch((err) => toast.error(t("workspaceSettings.notificationsFailed"), { description: errorText(err) }))
  }
  return (
    <section className="surface overflow-hidden">
      <header className="border-b px-[var(--pad)] py-4">
        <h2 className="text-base font-semibold">{t("workspaceSettings.notifications")}</h2>
        <p className="mt-0.5 text-sm text-muted-foreground">{t("workspaceSettings.notificationsDescription")}</p>
      </header>
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b text-left text-xs uppercase tracking-wider text-subtle-foreground">
            <th className="px-[var(--pad)] py-2.5 font-medium">{t("workspaceSettings.event")}</th>
            <th className="w-24 py-2.5 text-center font-medium">{t("workspaceSettings.inApp")}</th>
            <th className="w-24 py-2.5 text-center font-medium">{t("workspaceSettings.email")}</th>
          </tr>
        </thead>
        <tbody className="divide-y">
          {EVENTS.map((e) => (
            <tr key={e.key}>
              <td className="px-[var(--pad)] py-3">
                <span className="block">{t(`workspaceSettings.events.${e.key}.label`)}</span>
                <span className="block text-xs text-muted-foreground">{t(`workspaceSettings.events.${e.key}.hint`)}</span>
              </td>
              {(["inApp", "email"] as const).map((c) => (
                <td key={c} className="py-3 text-center">
                  <Switch checked={state[e.key][c]} onCheckedChange={(v) => toggle(e.key, c, v)} />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  )
}

/* -------------------------------------------------------------------------- */
/*  API keys & webhooks                                                        */
/* -------------------------------------------------------------------------- */

function ApiKeys() {
  const [keys, setKeys] = useState<ApiKey[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [name, setName] = useState("")
  const [creating, setCreating] = useState(false)
  const [token, setToken] = useState<string | null>(null)
  const t = useT()

  useEffect(() => {
    integrationsApi.listKeys().then(setKeys, (err) => setError(errorText(err)))
  }, [])

  async function create() {
    setCreating(true)
    try {
      const { token, ...key } = await integrationsApi.createKey(name.trim() || t("workspaceSettings.defaultKeyName"))
      setKeys((k) => [key, ...(k ?? [])])
      setToken(token)
      setName("")
    } catch (err) {
      toast.error(t("workspaceSettings.keyFailed"), { description: errorText(err) })
    } finally {
      setCreating(false)
    }
  }

  async function revoke(k: ApiKey) {
    try {
      const saved = await integrationsApi.revokeKey(k.id)
      setKeys((ks) => (ks ?? []).map((x) => (x.id === k.id ? { ...x, ...saved } : x)))
      toast(t("workspaceSettings.keyRevoked", { name: k.name }))
    } catch (err) {
      toast.error(t("workspaceSettings.revokeFailed"), { description: errorText(err) })
    }
  }

  return (
    <section className="surface">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b px-[var(--pad)] py-4">
        <div>
          <h2 className="text-base font-semibold">{t("workspaceSettings.apiKeys")}</h2>
          <p className="mt-0.5 text-sm text-muted-foreground">{t("workspaceSettings.apiKeysDescription", { path: "/api/v1/external", header: "X-API-Key" })}</p>
        </div>
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault()
            void create()
          }}
        >
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={t("workspaceSettings.keyNamePlaceholder")} className="h-8 w-56 text-sm" />
          <Button size="sm" type="submit" disabled={creating}>
            <KeyRound /> {t("workspaceSettings.createKey")}
          </Button>
        </form>
      </header>
      {error && <p className="px-[var(--pad)] py-4 text-sm text-destructive">{error}</p>}
      {keys?.length === 0 && <p className="px-[var(--pad)] py-6 text-center text-sm text-muted-foreground">{t("workspaceSettings.noKeys")}</p>}
      <ul className="divide-y">
        {(keys ?? []).map((k) => (
          <li key={k.id} className="flex flex-wrap items-center gap-3 px-[var(--pad)] py-3">
            <KeyRound className="size-4 text-muted-foreground" />
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium">{k.name}</p>
              <p className="text-xs text-muted-foreground">
                {t("workspaceSettings.created", { date: formatDate(k.created_at, { dateStyle: "medium" }) })} ·{" "}
                {k.last_used_at ? t("workspaceSettings.lastUsed", { ago: timeAgo(k.last_used_at) }) : t("workspaceSettings.neverUsed")}
                {k.expires_at && ` · ${t("workspaceSettings.expires", { date: formatDate(k.expires_at, { dateStyle: "medium" }) })}`}
              </p>
            </div>
            {!k.is_active && <Tag color="red">{t("workspaceSettings.revoked")}</Tag>}
            <code className="rounded-md bg-muted px-2 py-1 font-mono text-xs">{k.prefix}••••••••</code>
            {k.is_active && (
              <Button variant="ghost" size="icon-sm" onClick={() => void revoke(k)} aria-label={t("workspaceSettings.revoke")} className="hover:text-destructive">
                <Trash2 />
              </Button>
            )}
          </li>
        ))}
      </ul>
      <SecretDialog
        secret={token ? { value: token } : null}
        title={t("workspaceSettings.copyKey")}
        hint={t("workspaceSettings.copyKeyHint")}
        onClose={() => setToken(null)}
      />
    </section>
  )
}

function Webhooks() {
  const [hooks, setHooks] = useState<WebhookSub[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [open, setOpen] = useState(false)
  const [url, setUrl] = useState("https://")
  const [events, setEvents] = useState<string[]>(["record.created"])
  const [secret, setSecret] = useState<string | null>(null)
  const t = useT()

  useEffect(() => {
    integrationsApi.listWebhooks().then(setHooks, (err) => setError(errorText(err)))
  }, [])

  async function create() {
    try {
      const { secret, ...hook } = await integrationsApi.createWebhook({ url: url.trim(), events })
      setHooks((h) => [hook, ...(h ?? [])])
      setOpen(false)
      setUrl("https://")
      setSecret(secret)
    } catch (err) {
      toast.error(t("workspaceSettings.endpointAddFailed"), { description: errorText(err) })
    }
  }

  async function patch(h: WebhookSub, body: { is_active: boolean }) {
    setHooks((hs) => (hs ?? []).map((x) => (x.id === h.id ? { ...x, ...body } : x)))
    try {
      await integrationsApi.updateWebhook(h.id, body)
    } catch (err) {
      setHooks((hs) => (hs ?? []).map((x) => (x.id === h.id ? h : x)))
      toast.error(t("workspaceSettings.endpointUpdateFailed"), { description: errorText(err) })
    }
  }

  async function remove(h: WebhookSub) {
    setHooks((hs) => (hs ?? []).filter((x) => x.id !== h.id))
    try {
      await integrationsApi.deleteWebhook(h.id)
    } catch (err) {
      setHooks((hs) => [h, ...(hs ?? [])])
      toast.error(t("workspaceSettings.endpointDeleteFailed"), { description: errorText(err) })
    }
  }

  return (
    <section className="surface">
      <header className="flex items-center justify-between border-b px-[var(--pad)] py-4">
        <div>
          <h2 className="text-base font-semibold">{t("workspaceSettings.webhooks")}</h2>
          <p className="mt-0.5 text-sm text-muted-foreground">{t("workspaceSettings.webhooksDescription", { header: "X-Lemko-Signature" })}</p>
        </div>
        <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
          <Webhook /> {t("workspaceSettings.addEndpoint")}
        </Button>
      </header>
      {error && <p className="px-[var(--pad)] py-4 text-sm text-destructive">{error}</p>}
      {hooks?.length === 0 && <p className="px-[var(--pad)] py-6 text-center text-sm text-muted-foreground">{t("workspaceSettings.noEndpoints")}</p>}
      <ul className="divide-y">
        {(hooks ?? []).map((h) => (
          <li key={h.id} className="flex items-center gap-3 px-[var(--pad)] py-3">
            <Webhook className="size-4 text-muted-foreground" />
            <div className="min-w-0 flex-1">
              <p className="truncate font-mono text-xs">{h.url}</p>
              <p className="truncate text-xs text-muted-foreground">{h.events.join(", ")}</p>
            </div>
            <Switch checked={h.is_active} onCheckedChange={(v) => void patch(h, { is_active: v })} aria-label={t("workspaceSettings.activeLabel")} />
            <Button variant="ghost" size="icon-sm" onClick={() => void remove(h)} aria-label={t("common.delete")} className="hover:text-destructive">
              <Trash2 />
            </Button>
          </li>
        ))}
      </ul>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t("workspaceSettings.addWebhookTitle")}</DialogTitle>
            <DialogDescription>{t("workspaceSettings.addWebhookDescription")}</DialogDescription>
          </DialogHeader>
          <div className="grid gap-3">
            <div className="grid gap-1.5">
              <Label className="text-xs">{t("workspaceSettings.url")}</Label>
              <Input value={url} onChange={(e) => setUrl(e.target.value)} className="font-mono text-sm" autoFocus />
            </div>
            <div className="grid gap-1.5">
              <Label className="text-xs">{t("workspaceSettings.eventsLabel")}</Label>
              <div className="grid grid-cols-2 gap-1.5">
                {WEBHOOK_EVENTS.map((ev) => (
                  <label key={ev} className="flex items-center gap-2 font-mono text-xs">
                    <Checkbox checked={events.includes(ev)} onCheckedChange={(v) => setEvents((s) => (v ? [...s, ev] : s.filter((x) => x !== ev)))} />
                    {ev}
                  </label>
                ))}
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button disabled={!/^https?:\/\/\S+\.\S+/.test(url) || !events.length} onClick={() => void create()}>
              {t("workspaceSettings.addEndpoint")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <SecretDialog
        secret={secret ? { value: secret } : null}
        title={t("workspaceSettings.signingSecret")}
        hint={t("workspaceSettings.signingSecretHint")}
        onClose={() => setSecret(null)}
      />
    </section>
  )
}

export function IntegrationsSettings() {
  const connections = useWorkspace((s) => s.integrations)
  const { isAdmin } = useRole()
  const t = useT()
  return (
    <div className="flex flex-col gap-[var(--gap)]">
      <SettingsSection title={t("workspaceSettings.connectedApps")} description={t("workspaceSettings.connectedAppsDescription")}>
        <SettingsRow label={t("workspaceSettings.connectedCount", { count: Object.keys(connections).length })} hint={Object.values(connections).map((c) => c.account).join(" · ") || t("workspaceSettings.nothingConnected")}>
          <Button size="sm" asChild>
            <a href="/integrations">{t("workspaceSettings.openStore")}</a>
          </Button>
        </SettingsRow>
      </SettingsSection>
      {isAdmin ? (
        <>
          <ApiKeys />
          <Webhooks />
        </>
      ) : (
        <SettingsSection title={t("workspaceSettings.apiAndWebhooks")}>
          <OnlyOwnerAndAdmins />
        </SettingsSection>
      )}
    </div>
  )
}

/* -------------------------------------------------------------------------- */
/*  Import & export                                                            */
/* -------------------------------------------------------------------------- */

function download(name: string, data: unknown) {
  const a = document.createElement("a")
  a.href = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }))
  a.download = name
  a.click()
  setTimeout(() => URL.revokeObjectURL(a.href), 1000)
}

export function DataSettings() {
  const file = useRef<HTMLInputElement>(null)
  const { isAdmin } = useRole()
  const [busy, setBusy] = useState<string | null>(null)
  const [confirmReset, setConfirmReset] = useState(false)
  const t = useT()

  async function run(key: string, action: () => Promise<unknown>, done: string, failed: string) {
    setBusy(key)
    try {
      await action()
      toast.success(done)
    } catch (err) {
      toast.error(failed, { description: errorText(err) })
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="flex flex-col gap-[var(--gap)]">
      <SettingsSection title={t("workspaceSettings.configuration")} description={t("workspaceSettings.configurationDescription")}>
        <SettingsRow label={t("workspaceSettings.exportConfig")}>
          <Button
            variant="outline"
            size="sm"
            disabled={busy === "export"}
            onClick={() => void run("export", async () => download("lemko-workspace.json", await workspaceApi.exportConfig()), t("workspaceSettings.exported"), t("workspaceSettings.exportFailed"))}
          >
            <Download /> {t("workspaceSettings.exportJson")}
          </Button>
        </SettingsRow>
        <SettingsRow label={t("workspaceSettings.importConfig")} hint={isAdmin ? t("workspaceSettings.importHint") : t("workspaceSettings.importAdminsOnly")}>
          <>
            <input
              ref={file}
              type="file"
              accept="application/json"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0]
                e.target.value = ""
                if (!f) return
                void run(
                  "import",
                  async () => {
                    let json: unknown
                    try {
                      json = JSON.parse(await f.text())
                    } catch {
                      throw new Error(t("workspaceSettings.invalidJson"))
                    }
                    await importWorkspace(json)
                  },
                  t("workspaceSettings.imported"),
                  t("workspaceSettings.importFailed"),
                )
              }}
            />
            <Button variant="outline" size="sm" disabled={!isAdmin || busy === "import"} onClick={() => file.current?.click()}>
              <Upload /> {t("workspaceSettings.importJson")}
            </Button>
          </>
        </SettingsRow>
      </SettingsSection>
      <SettingsSection title={t("workspaceSettings.records")}>
        <SettingsRow label={t("workspaceSettings.exportRecords")} hint={t("workspaceSettings.exportRecordsHint")}>
          <Button variant="outline" size="sm" onClick={() => download("lemko-records.json", dataStore.get().records)}>
            <Download /> {t("workspaceSettings.export")}
          </Button>
        </SettingsRow>
        <SettingsRow label={t("workspaceSettings.resetWorkspace")} hint={t("workspaceSettings.resetHint")}>
          <Button variant="destructive" size="sm" disabled={!isAdmin || busy === "reset"} onClick={() => setConfirmReset(true)}>
            <RotateCcw /> {t("workspaceSettings.reset")}
          </Button>
        </SettingsRow>
      </SettingsSection>

      <Dialog open={confirmReset} onOpenChange={setConfirmReset}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t("workspaceSettings.resetConfirmTitle")}</DialogTitle>
            <DialogDescription>{t("workspaceSettings.resetConfirmDescription")}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmReset(false)}>
              {t("common.cancel")}
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                setConfirmReset(false)
                void run("reset", resetWorkspace, t("workspaceSettings.resetDone"), t("workspaceSettings.resetFailed"))
              }}
            >
              {t("workspaceSettings.reset")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
