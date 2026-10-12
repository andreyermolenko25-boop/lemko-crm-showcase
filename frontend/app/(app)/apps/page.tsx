"use client"

import { useEffect, useMemo, useState } from "react"
import { Check, FileArchive, Link2, Package, Plus, Search, Trash2 } from "lucide-react"
import { toast } from "sonner"
import { cn } from "@/lib/utils"
import type { ModuleManifest } from "@/lib/core/types"
import { listModules } from "@/lib/modules"
import { useWorkspace, workspaceActions } from "@/lib/core/workspace"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Switch } from "@/components/ui/switch"
import { timeAgo } from "@/lib/core/format"
import { AddModuleDialog } from "@/components/modules/add-module-dialog"
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { IconTile, PageHeader, SectionLabel, Tag } from "@/components/crm/primitives"
import { useI18n, useT } from "@/components/i18n-provider"
import { useLocalizeModule } from "@/lib/core/schema-i18n"

function ModuleSheet({ mod, onClose }: { mod: ModuleManifest; onClose: () => void }) {
  const enabled = useWorkspace((s) => s.enabledModules.includes(mod.id))
  const { t, maybe } = useI18n()
  return (
    <Sheet open onOpenChange={(o) => !o && onClose()}>
      <SheetContent className="w-full gap-0 overflow-y-auto sm:max-w-lg">
        <SheetHeader className="gap-4 border-b p-6">
          <IconTile icon={mod.icon} color={mod.color} size="lg" />
          <div>
            <SheetTitle className="text-lg">{mod.name}</SheetTitle>
            <SheetDescription>{mod.description}</SheetDescription>
          </div>
          <div className="flex items-center gap-2">
            <Tag>{maybe(`apps.categories.${mod.category}`) ?? mod.category}</Tag>
            <Tag>v{mod.version}</Tag>
            {mod.core && <Tag color="green">{t("apps.alwaysOn")}</Tag>}
          </div>
        </SheetHeader>
        <div className="flex flex-col gap-6 p-6">
          {mod.niches && (
            <div>
              <SectionLabel className="mb-2">{t("apps.builtFor")}</SectionLabel>
              <div className="flex flex-wrap gap-1.5">
                {mod.niches.map((n) => (
                  <Tag key={n}>{n}</Tag>
                ))}
              </div>
            </div>
          )}
          <div>
            <SectionLabel className="mb-2">{t("apps.addsObjects")}</SectionLabel>
            <div className="flex flex-col gap-2.5">
              {mod.entities.map((e) => (
                <div key={e.key} className="rounded-xl border p-3.5">
                  <div className="flex items-center gap-2.5">
                    <IconTile icon={e.icon} color={e.color} size="sm" />
                    <span className="text-sm font-medium">{e.label}</span>
                    <span className="text-xs text-muted-foreground">{t("apps.fieldsCount", { count: e.fields.length })}</span>
                  </div>
                  <div className="mt-2.5 flex flex-wrap gap-1">
                    {e.fields.map((f) => (
                      <span key={f.key} className="rounded-md bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
                        {f.label}
                      </span>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>
          <div>
            <SectionLabel className="mb-2">{t("apps.alsoIncludes")}</SectionLabel>
            <ul className="flex flex-col gap-1.5 text-sm text-muted-foreground">
              <li className="flex gap-2"><Check className="mt-0.5 size-3.5 text-brand" />{t("apps.viewsIncluded", { count: mod.views?.length ?? 0 })}</li>
              <li className="flex gap-2"><Check className="mt-0.5 size-3.5 text-brand" />{t("apps.worksWith")}</li>
              <li className="flex gap-2"><Check className="mt-0.5 size-3.5 text-brand" />{t("apps.extensible")}</li>
            </ul>
          </div>
          {!mod.core && (
            <Button
              variant={enabled ? "outline" : "default"}
              onClick={() => {
                if (enabled) workspaceActions.disableModule(mod.id)
                else workspaceActions.enableModule(mod.id)
                toast.success(t(enabled ? "apps.disabledKept" : "apps.installed", { name: mod.name }))
              }}
            >
              {enabled ? t("apps.disableModule") : t("apps.installModule")}
            </Button>
          )}
        </div>
      </SheetContent>
    </Sheet>
  )
}

function Installed({ onDetails }: { onDetails: (m: ModuleManifest) => void }) {
  const enabled = useWorkspace((s) => s.enabledModules)
  const packages = useWorkspace((s) => s.packages)
  const localize = useLocalizeModule()
  const t = useT()
  const mods = listModules().filter((m) => enabled.includes(m.id)).map(localize)
  const SRC: Record<string, typeof Package> = { file: FileArchive, url: Link2 }
  return (
    <div className="flex flex-col gap-[var(--gap)]">
      <section className="surface">
        <header className="border-b px-[var(--pad)] py-3.5">
          <h2 className="text-base font-semibold">{t("apps.fromCatalogue")}</h2>
        </header>
        <ul className="divide-y">
          {mods.map((m) => (
            <li key={m.id} className="flex items-center gap-3 px-[var(--pad)] py-3">
              <IconTile icon={m.icon} color={m.color} />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium">{m.name}</p>
                <p className="text-xs text-muted-foreground">
                  {m.entities.map((e) => e.label).join(", ")} · v{m.version}
                </p>
              </div>
              <Button variant="ghost" size="sm" onClick={() => onDetails(m)}>
                {t("apps.details")}
              </Button>
              {m.core ? (
                <Tag color="green">{t("apps.core")}</Tag>
              ) : (
                <Switch checked onCheckedChange={() => (workspaceActions.disableModule(m.id), toast(t("apps.disabled", { name: m.name })))} aria-label={t("apps.disableNamed", { name: m.name })} />
              )}
            </li>
          ))}
        </ul>
      </section>
      <section className="surface">
        <header className="border-b px-[var(--pad)] py-3.5">
          <h2 className="text-base font-semibold">{t("apps.addedManually")}</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">{t("apps.addedManuallyHint")}</p>
        </header>
        {packages.length === 0 ? (
          <p className="px-[var(--pad)] py-8 text-center text-xs text-muted-foreground">{t("apps.noPackages")}</p>
        ) : (
          <ul className="divide-y">
            {packages.map((p) => {
              const I = SRC[p.source] ?? Package
              return (
                <li key={p.id} className="flex items-center gap-3 px-[var(--pad)] py-3">
                  <span className="flex size-8 items-center justify-center rounded-lg bg-muted">
                    <I className="size-4" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium">
                      {p.name} <span className="text-xs font-normal text-muted-foreground">v{p.version}</span>
                    </p>
                    <p className="truncate font-mono text-xs text-muted-foreground">
                      {p.origin} · {t("apps.objectsCount", { count: (p.entities ?? []).length })}
                    </p>
                  </div>
                  <span className="hidden text-xs text-muted-foreground sm:inline">{timeAgo(p.installedAt)}</span>
                  <Switch checked={p.enabled} onCheckedChange={(v) => workspaceActions.updatePackage(p.id, { enabled: v })} aria-label={t("apps.enabled")} />
                  <Button variant="ghost" size="icon-sm" aria-label={t("apps.uninstall")} onClick={() => workspaceActions.removePackage(p.id)}>
                    <Trash2 />
                  </Button>
                </li>
              )
            })}
          </ul>
        )}
      </section>
    </div>
  )
}

type AppsTab = "catalog" | "installed"

export default function AppsPage() {
  const enabled = useWorkspace((s) => s.enabledModules)
  const packages = useWorkspace((s) => s.packages)
  const [tab, setTab] = useState<AppsTab>("catalog")
  const [adding, setAdding] = useState(false)
  const [q, setQ] = useState("")
  const [cat, setCat] = useState("All")
  const [open, setOpen] = useState<ModuleManifest | null>(null)
  const { t, maybe } = useI18n()
  const localize = useLocalizeModule()
  const modules = useMemo(() => listModules().map(localize), [localize])
  const cats = ["All", ...new Set(modules.map((m) => m.category))]

  useEffect(() => {
    const fromUrl = new URLSearchParams(window.location.search).get("tab")
    if (fromUrl === "installed" || fromUrl === "catalog") setTab(fromUrl)
  }, [])

  const filtered = useMemo(
    () =>
      modules.filter(
        (m) =>
          (cat === "All" || m.category === cat) &&
          `${m.name} ${m.tagline} ${(m.niches ?? []).join(" ")}`.toLowerCase().includes(q.toLowerCase()),
      ),
    [modules, cat, q],
  )

  const TABS: { key: AppsTab; count?: number }[] = [
    { key: "catalog" },
    { key: "installed", count: enabled.length + packages.length },
  ]

  return (
    <div className="flex flex-col gap-[var(--gap)]">
      <PageHeader
        icon="boxes"
        title={t("apps.title")}
        description={t("apps.description")}
        actions={
          <Button size="sm" onClick={() => setAdding(true)}>
            <Plus /> {t("apps.addModule")}
          </Button>
        }
      />

      <div className="flex items-center gap-1 border-b">
        {TABS.map((tb) => (
          <button
            key={tb.key}
            onClick={() => setTab(tb.key)}
            className={cn(
              "relative flex h-9 items-center gap-1.5 px-3 text-sm font-medium transition-colors",
              tab === tb.key ? "text-foreground after:absolute after:inset-x-2 after:-bottom-px after:h-0.5 after:rounded-full after:bg-foreground" : "text-muted-foreground hover:text-foreground",
            )}
          >
            {t(`apps.tabs.${tb.key}`)}
            {tb.count !== undefined && <span className="rounded-md bg-muted px-1.5 text-xs tabular">{tb.count}</span>}
          </button>
        ))}
      </div>

      {tab === "installed" && <Installed onDetails={setOpen} />}
      {tab === "catalog" && (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("apps.searchPlaceholder")} className="h-8 w-64 pl-8 text-sm" />
            </div>
            <div className="flex flex-wrap gap-1">
              {cats.map((c) => (
                <button
                  key={c}
                  onClick={() => setCat(c)}
                  className={cn("h-8 rounded-lg px-3 text-sm font-medium transition-colors", cat === c ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-accent")}
                >
                  {maybe(`apps.categories.${c}`) ?? c}
                </button>
              ))}
            </div>
          </div>

          <div className="grid gap-[var(--gap)] md:grid-cols-2 xl:grid-cols-3">
            {filtered.map((m) => {
              const on = enabled.includes(m.id)
              return (
                <section key={m.id} className="surface flex flex-col gap-4 p-[var(--pad)] transition-colors hover:border-border-strong">
                  <div className="flex items-start gap-3">
                    <IconTile icon={m.icon} color={m.color} size="lg" />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <p className="truncate text-sm font-semibold">{m.name}</p>
                        {on && <Tag color="green" dot>{m.core ? t("apps.core") : t("apps.installedTag")}</Tag>}
                      </div>
                      <p className="mt-0.5 text-xs text-muted-foreground">{m.tagline}</p>
                    </div>
                  </div>
                  <p className="line-clamp-2 text-sm text-muted-foreground">{m.description}</p>
                  <div className="flex flex-wrap gap-1">
                    {m.entities.map((e) => (
                      <Tag key={e.key}>{e.label}</Tag>
                    ))}
                  </div>
                  <div className="mt-auto flex items-center justify-between border-t pt-3">
                    <span className="text-xs text-muted-foreground">
                      {maybe(`apps.categories.${m.category}`) ?? m.category} · v{m.version}
                    </span>
                    <div className="flex gap-1.5">
                      <Button variant="ghost" size="sm" onClick={() => setOpen(m)}>
                        {t("apps.details")}
                      </Button>
                      {!m.core && (
                        <Button
                          size="sm"
                          variant={on ? "outline" : "default"}
                          onClick={() => {
                            if (on) workspaceActions.disableModule(m.id)
                            else workspaceActions.enableModule(m.id)
                            toast.success(t(on ? "apps.disabledKept" : "apps.installedFind", { name: m.name }))
                          }}
                        >
                          {on ? t("apps.disable") : (<><Plus /> {t("apps.install")}</>)}
                        </Button>
                      )}
                    </div>
                  </div>
                </section>
              )
            })}
          </div>
        </>
      )}
      {open && <ModuleSheet mod={open} onClose={() => setOpen(null)} />}
      <AddModuleDialog open={adding} onOpenChange={setAdding} />
    </div>
  )
}
