"use client"

import { useMemo, useState } from "react"
import { Check, CheckCircle2, ExternalLink, KeyRound, Loader2, Lock, Phone, RefreshCw, Search, Settings2, ShieldCheck, Unplug } from "lucide-react"
import { toast } from "sonner"
import { cn } from "@/lib/utils"
import { INTEGRATION_CATEGORIES, INTEGRATIONS, localizeIntegration, type IntegrationDef } from "@/lib/core/integrations"
import { useI18n, useT } from "@/components/i18n-provider"
import { useWorkspace, workspaceActions } from "@/lib/core/workspace"
import { useMe } from "@/lib/core/data"
import { timeAgo } from "@/lib/core/format"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { PageHeader, SectionLabel, Tag } from "@/components/crm/primitives"
import { AppMark } from "@/components/integrations/app-mark"

/* -------------------------------------------------------------------------- */
/*  Connect flow: consent → authorising → configure                              */
/* -------------------------------------------------------------------------- */

function ConnectDialog({ app, onClose }: { app: IntegrationDef; onClose: () => void }) {
  const me = useMe()
  const [step, setStep] = useState<"consent" | "auth" | "configure">("consent")
  const [account, setAccount] = useState(app.auth === "oauth" ? (me?.email ?? "") : "")
  const [settings, setSettings] = useState<Record<string, boolean>>(() => Object.fromEntries(app.settings.map((s) => [s.key, Boolean(s.default)])))
  const t = useT()

  const [busy, setBusy] = useState(false)

  // The connection (account + sync settings) is stored on the server; provider
  // OAuth / token exchange is not implemented, so authorising records the account.
  const authorise = async () => {
    setBusy(true)
    setStep("auth")
    // Never keep a pasted key around as the account label — only its tail.
    const label = app.auth === "apikey" ? `${app.name} ••••${account.trim().slice(-4)}` : account.trim() || t("integrations.accountLabel", { name: app.name })
    const saved = await workspaceActions.connectIntegration(app.id, label, settings)
    setBusy(false)
    setStep(saved ? "configure" : "consent")
  }
  const finish = async () => {
    setBusy(true)
    workspaceActions.updateIntegration(app.id, { settings })
    await workspaceActions.syncIntegration(app.id)
    setBusy(false)
    toast.success(t("integrations.connected", { name: app.name }))
    onClose()
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader className="items-center text-center sm:text-center">
          <div className="flex items-center gap-3">
            <span className="flex size-12 items-center justify-center rounded-2xl border bg-card">
              <ShieldCheck className="size-5" />
            </span>
            <span className="h-px w-8 bg-border-strong" />
            <AppMark app={app} size="lg" />
          </div>
          <DialogTitle className="mt-2">
            {step === "configure" ? t("integrations.isConnected", { name: app.name }) : t("integrations.connect", { name: app.name })}
          </DialogTitle>
          <DialogDescription>
            {step === "consent" && (app.provider ? t("integrations.consent", { provider: app.provider }) : t("integrations.consentGeneric"))}
            {step === "auth" && t("integrations.saving")}
            {step === "configure" && t("integrations.chooseSync")}
          </DialogDescription>
        </DialogHeader>

        {step === "consent" && (
          <div className="flex flex-col gap-4">
            <div className="rounded-xl border p-3.5">
              <SectionLabel className="mb-2">{t("integrations.willBeAble")}</SectionLabel>
              <ul className="flex flex-col gap-2">
                {app.permissions.map((p) => (
                  <li key={p} className="flex gap-2 text-sm">
                    <Check className="mt-0.5 size-3.5 shrink-0 text-success" />
                    {p}
                  </li>
                ))}
              </ul>
            </div>
            {app.auth !== "oauth" && (
              <div className="grid gap-1.5">
                <Label className="text-xs">{app.auth === "phone" ? t("integrations.phoneLabel") : t("integrations.keyLabel")}</Label>
                <div className="relative">
                  {app.auth === "phone" ? (
                    <Phone className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
                  ) : (
                    <KeyRound className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
                  )}
                  <Input value={account} onChange={(e) => setAccount(e.target.value)} className="pl-8 font-mono text-sm" placeholder={app.auth === "phone" ? "+48 500 000 000" : "sk_live_…"} />
                </div>
              </div>
            )}
            <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <Lock className="size-3" /> {t("integrations.disconnectHint")}
            </p>
          </div>
        )}
        {step === "auth" && (
          <div className="flex flex-col items-center gap-3 py-6">
            <Loader2 className="size-6 animate-spin text-muted-foreground" />
          </div>
        )}
        {step === "configure" && (
          <div className="flex flex-col gap-1">
            <div className="mb-2 flex items-center gap-2 rounded-lg bg-success/10 px-3 py-2 text-sm text-success">
              <CheckCircle2 className="size-4" /> {account || app.name}
            </div>
            {app.settings.length === 0 && <p className="text-center text-xs text-muted-foreground">{t("integrations.noOptions")}</p>}
            {app.settings.map((s) => (
              <label key={s.key} className="flex items-center justify-between gap-3 rounded-lg px-1 py-2">
                <span>
                  <span className="block text-sm font-medium">{s.label}</span>
                  {s.hint && <span className="block text-xs text-muted-foreground">{s.hint}</span>}
                </span>
                <Switch checked={settings[s.key]} onCheckedChange={(v) => setSettings((x) => ({ ...x, [s.key]: v }))} />
              </label>
            ))}
          </div>
        )}

        <DialogFooter>
          {step === "consent" && (
            <>
              <Button variant="outline" onClick={onClose}>
                {t("common.cancel")}
              </Button>
              <Button onClick={() => void authorise()} disabled={busy || (app.auth !== "oauth" && account.trim().length < 4)}>
                {app.auth === "oauth" ? t("integrations.continueWith", { name: app.provider ?? app.name }) : t("integrations.connectButton")}
              </Button>
            </>
          )}
          {step === "configure" && (
            <Button onClick={() => void finish()} disabled={busy}>
              {t("integrations.finish")}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/* -------------------------------------------------------------------------- */
/*  Manage connected integration                                                 */
/* -------------------------------------------------------------------------- */

function ManageSheet({ app, onClose }: { app: IntegrationDef; onClose: () => void }) {
  const conn = useWorkspace((s) => s.integrations[app.id])
  const [syncing, setSyncing] = useState(false)
  const t = useT()
  if (!conn) return null
  const log = [
    conn.lastSyncedAt && { at: conn.lastSyncedAt, text: t("integrations.lastSync") },
    { at: conn.connectedAt, text: t("integrations.connectedAs", { account: conn.account }) },
  ].filter((l): l is { at: string; text: string } => Boolean(l))
  return (
    <Sheet open onOpenChange={(o) => !o && onClose()}>
      <SheetContent className="w-full gap-0 overflow-y-auto sm:max-w-md">
        <SheetHeader className="gap-3 border-b p-6">
          <AppMark app={app} size="lg" />
          <div>
            <SheetTitle className="text-lg">{app.name}</SheetTitle>
            <SheetDescription>{app.tagline}</SheetDescription>
          </div>
        </SheetHeader>
        <div className="flex flex-col gap-6 p-6">
          <div className="rounded-xl border p-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium">{conn.account}</p>
                <p className="text-xs text-muted-foreground">{t("integrations.connectedAgo", { ago: timeAgo(conn.connectedAt) })}</p>
              </div>
              <Tag color={syncing ? "blue" : conn.status === "connected" ? "green" : conn.status === "syncing" ? "blue" : "red"} dot>
                {syncing || conn.status === "syncing" ? t("integrations.syncing") : conn.status === "connected" ? t("integrations.healthy") : t("integrations.error")}
              </Tag>
            </div>
            <Button
              variant="outline"
              size="sm"
              className="mt-3 w-full"
              disabled={syncing}
              onClick={async () => {
                setSyncing(true)
                await workspaceActions.syncIntegration(app.id)
                setSyncing(false)
              }}
            >
              <RefreshCw className={cn(syncing && "animate-spin")} /> {t("integrations.syncNow")}
            </Button>
          </div>
          {app.settings.length > 0 && (
            <div>
              <SectionLabel className="mb-2">{t("integrations.syncSettings")}</SectionLabel>
              <div className="flex flex-col">
                {app.settings.map((s) => (
                  <label key={s.key} className="flex items-center justify-between gap-3 py-2">
                    <span>
                      <span className="block text-sm font-medium">{s.label}</span>
                      {s.hint && <span className="block text-xs text-muted-foreground">{s.hint}</span>}
                    </span>
                    <Switch
                      checked={Boolean(conn.settings[s.key])}
                      onCheckedChange={(v) => workspaceActions.updateIntegration(app.id, { settings: { ...conn.settings, [s.key]: v } })}
                    />
                  </label>
                ))}
              </div>
            </div>
          )}
          <div>
            <SectionLabel className="mb-2">{t("integrations.history")}</SectionLabel>
            <ul className="flex flex-col gap-2">
              {log.map((l) => (
                <li key={l.at} className="flex justify-between text-sm">
                  <span>{l.text}</span>
                  <span className="text-xs text-muted-foreground">{timeAgo(l.at)}</span>
                </li>
              ))}
            </ul>
          </div>
          <div>
            <SectionLabel className="mb-2">{t("integrations.permissionsGranted")}</SectionLabel>
            <ul className="flex flex-col gap-1.5">
              {app.permissions.map((p) => (
                <li key={p} className="flex gap-2 text-xs text-muted-foreground">
                  <Check className="size-3.5 shrink-0 text-success" />
                  {p}
                </li>
              ))}
            </ul>
          </div>
          <Button
            variant="outline"
            className="text-destructive"
            onClick={() => {
              workspaceActions.disconnectIntegration(app.id)
              toast(t("integrations.disconnected", { name: app.name }))
              onClose()
            }}
          >
            <Unplug /> {t("integrations.disconnect")}
          </Button>
        </div>
      </SheetContent>
    </Sheet>
  )
}

/* -------------------------------------------------------------------------- */

export default function IntegrationsPage() {
  const connections = useWorkspace((s) => s.integrations)
  const [q, setQ] = useState("")
  const [cat, setCat] = useState<string>("All")
  const [connecting, setConnecting] = useState<IntegrationDef | null>(null)
  const [managing, setManaging] = useState<IntegrationDef | null>(null)
  const { t, maybe, schema } = useI18n()
  const catLabel = (c: string) => maybe(`integrations.categories.${c}`) ?? c

  const apps = useMemo(() => INTEGRATIONS.map((i) => localizeIntegration(i, schema)), [schema])
  const connected = apps.filter((i) => connections[i.id])
  const list = useMemo(
    () =>
      apps.filter(
        (i) =>
          (cat === "All" || (cat === "Popular" ? i.popular : cat === "Connected" ? connections[i.id] : i.category === cat)) &&
          `${i.name} ${i.tagline} ${i.category} ${maybe(`integrations.categories.${i.category}`) ?? ""}`.toLowerCase().includes(q.toLowerCase()),
      ),
    [apps, cat, q, connections, maybe],
  )
  const cats = ["All", "Popular", "Connected", ...INTEGRATION_CATEGORIES]

  return (
    <div className="flex flex-col gap-[var(--gap)]">
      <PageHeader
        icon="plug"
        title={t("integrations.title")}
        description={t("integrations.description")}
        actions={
          <Button variant="outline" size="sm" asChild>
            <a href="/settings/integrations">
              <Settings2 /> {t("integrations.apiWebhooks")}
            </a>
          </Button>
        }
      />

      {connected.length > 0 && (
        <section className="surface p-[var(--pad)]">
          <div className="mb-3 flex items-center justify-between">
            <SectionLabel>{t("integrations.connectedCount", { count: connected.length })}</SectionLabel>
          </div>
          <div className="flex flex-wrap gap-2">
            {connected.map((app) => {
              const c = connections[app.id]
              return (
                <button key={app.id} onClick={() => setManaging(app)} className="flex items-center gap-2.5 rounded-xl border bg-elevated/60 py-2 pl-2 pr-3 text-left transition-colors hover:border-border-strong">
                  <AppMark app={app} size="sm" />
                  <span>
                    <span className="block text-sm font-medium">{app.name}</span>
                    <span className="flex items-center gap-1 text-xs text-muted-foreground">
                      <span className={cn("size-1.5 rounded-full", c.status === "connected" ? "bg-success" : c.status === "syncing" ? "animate-pulse bg-info" : "bg-destructive")} />
                      {c.status === "syncing" ? t("integrations.syncingEllipsis") : c.account}
                    </span>
                  </span>
                </button>
              )
            })}
          </div>
        </section>
      )}

      <div className="grid gap-[var(--gap)] lg:grid-cols-[13rem_minmax(0,1fr)]">
        <aside className="flex flex-col gap-3">
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("integrations.searchApps")} className="h-8 pl-8 text-sm" />
          </div>
          <nav className="flex gap-1 overflow-x-auto scrollbar-none lg:flex-col">
            {cats.map((c) => (
              <button
                key={c}
                onClick={() => setCat(c)}
                className={cn(
                  "flex h-8 shrink-0 items-center justify-between gap-3 rounded-lg px-2.5 text-sm transition-colors",
                  cat === c ? "bg-card font-medium shadow-[var(--shadow-card)] ring-1 ring-border" : "text-muted-foreground hover:bg-accent hover:text-foreground",
                )}
              >
                {catLabel(c)}
                {c === "Connected" && <span className="text-xs tabular">{connected.length}</span>}
              </button>
            ))}
          </nav>
        </aside>

        <div className="grid content-start gap-[var(--gap)] sm:grid-cols-2 2xl:grid-cols-3">
          {list.map((app) => {
            const conn = connections[app.id]
            return (
              <section key={app.id} className="surface flex flex-col gap-3 p-[var(--pad)] transition-colors hover:border-border-strong">
                <div className="flex items-start gap-3">
                  <AppMark app={app} />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <p className="truncate text-sm font-semibold">{app.name}</p>
                      {app.popular && !conn && <Tag color="amber">{t("integrations.popular")}</Tag>}
                      {conn && <Tag color="green" dot>{t("integrations.connectedTag")}</Tag>}
                    </div>
                    <p className="text-xs text-muted-foreground">{catLabel(app.category)}</p>
                  </div>
                </div>
                <p className="line-clamp-2 text-sm text-muted-foreground">{app.description}</p>
                <div className="mt-auto flex items-center justify-between border-t pt-3">
                  <span className="flex items-center gap-1 text-xs text-muted-foreground">
                    {app.auth === "oauth" ? <ShieldCheck className="size-3" /> : app.auth === "phone" ? <Phone className="size-3" /> : <KeyRound className="size-3" />}
                    {t(`integrations.auth.${app.auth}`)}
                  </span>
                  {conn ? (
                    <Button variant="outline" size="sm" onClick={() => setManaging(app)}>
                      <Settings2 /> {t("integrations.manage")}
                    </Button>
                  ) : (
                    <Button size="sm" onClick={() => setConnecting(app)}>
                      {t("integrations.connectButton")}
                    </Button>
                  )}
                </div>
              </section>
            )
          })}
          <section className="flex flex-col justify-between gap-3 rounded-[calc(var(--radius)*1.25)] border border-dashed p-[var(--pad)]">
            <div>
              <p className="text-sm font-semibold">{t("integrations.missing")}</p>
              <p className="mt-1 text-xs text-muted-foreground">{t("integrations.missingHint")}</p>
            </div>
            <Button variant="outline" size="sm" asChild>
              <a href="/settings/integrations">
                <ExternalLink /> {t("integrations.apiWebhooks")}
              </a>
            </Button>
          </section>
        </div>
      </div>

      {connecting && <ConnectDialog app={connecting} onClose={() => setConnecting(null)} />}
      {managing && <ManageSheet app={managing} onClose={() => setManaging(null)} />}
    </div>
  )
}
