"use client"

import { useState } from "react"
import { Download, LayoutGrid, MoreHorizontal, Pencil, Plus, Trash2 } from "lucide-react"
import { toast } from "sonner"
import { cn } from "@/lib/utils"
import { useWidgetData } from "@/lib/core/analytics"
import { useEntity, useWorkspace, workspaceActions } from "@/lib/core/workspace"
import { usePrefs } from "@/lib/core/prefs"
import { useMe } from "@/lib/core/data"
import { Icon } from "@/lib/core/icons"
import { ui } from "@/lib/core/ui"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { DashboardBoard } from "@/components/dashboard/dashboard-board"
import { useT } from "@/components/i18n-provider"
import type { MessageKey } from "@/lib/i18n/translate"
import { useDefaultName } from "@/lib/core/schema-i18n"

function greeting(): MessageKey {
  const h = new Date().getHours()
  if (h < 5) return "home.greetings.night"
  if (h < 12) return "home.greetings.morning"
  if (h < 18) return "home.greetings.afternoon"
  return "home.greetings.evening"
}

function MyDay() {
  const { data } = useWidgetData<{ openAssigned: number; dueToday: number }>("my_day", {})
  const t = useT()
  if (!data) return <p className="mt-0.5 h-5 text-sm text-muted-foreground" />
  const parts = [
    data.dueToday ? t("home.dueToday", { count: data.dueToday }) : t("home.nothingDue"),
    t("home.openAssigned", { count: data.openAssigned }),
  ]
  return <p className="mt-0.5 text-sm text-muted-foreground">{parts.join(" · ")}</p>
}

export default function HomePage() {
  const dashboards = useWorkspace((s) => s.dashboards)
  const showGreeting = usePrefs((p) => p.showGreeting)
  const [activeId, setActiveId] = useState<string | null>(null)
  const [editing, setEditing] = useState(false)
  const [renaming, setRenaming] = useState<string | null>(null)
  const active = dashboards.find((d) => d.id === activeId) ?? dashboards[0]
  const me = useMe()
  const hasDeals = Boolean(useEntity("deals"))
  const t = useT()
  const dn = useDefaultName()

  const exportJson = () => {
    const blob = new Blob([JSON.stringify(active, null, 2)], { type: "application/json" })
    const a = document.createElement("a")
    a.href = URL.createObjectURL(blob)
    a.download = `dashboard-${active.name.toLowerCase()}.json`
    a.click()
  }

  return (
    <div className="flex flex-col gap-[var(--gap)]">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          {showGreeting ? (
            <>
              <h1 className="text-2xl font-semibold tracking-tight">
                {t("home.greeting", { greeting: t(greeting()), name: me?.name.split(" ")[0] ?? "" })}
              </h1>
              <MyDay />
            </>
          ) : (
            <h1 className="text-2xl font-semibold tracking-tight">{dn(active?.name)}</h1>
          )}
        </div>
        <div className="flex items-center gap-2">
          {!editing && (
            <Button variant="outline" onClick={() => setEditing(true)}>
              <LayoutGrid /> {t("home.customize")}
            </Button>
          )}
          <Button variant="outline" onClick={exportJson}>
            <Download /> {t("home.export")}
          </Button>
          {hasDeals && (
            <Button variant="outline" onClick={() => ui.openCreate("deals")}>
              <Plus /> {t("home.newDeal")}
            </Button>
          )}
        </div>
      </div>

      {dashboards.length > 0 && (
        <div className="flex items-center gap-1 overflow-x-auto border-b pb-px scrollbar-none">
          {dashboards.map((d) => (
            <div key={d.id} className="flex shrink-0 items-center">
              {renaming === d.id ? (
                <Input
                  autoFocus
                  defaultValue={dn(d.name)}
                  className="mb-1 h-8 w-40"
                  onBlur={(e) => {
                    const name = e.target.value.trim()
                    if (name && name !== dn(d.name)) workspaceActions.saveDashboard({ ...d, name })
                    setRenaming(null)
                  }}
                  onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
                />
              ) : (
                <button
                  onClick={() => setActiveId(d.id)}
                  className={cn(
                    "relative flex h-9 items-center gap-1.5 px-3 text-sm font-medium transition-colors",
                    d.id === active?.id ? "text-foreground after:absolute after:inset-x-2 after:-bottom-px after:h-0.5 after:rounded-full after:bg-foreground" : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  <Icon name={d.icon} className="size-3.5" />
                  {dn(d.name)}
                </button>
              )}
              {d.id === active?.id && !renaming && (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <button className="flex size-6 items-center justify-center rounded-md text-muted-foreground hover:bg-accent" aria-label={t("home.dashboardOptions")}>
                      <MoreHorizontal className="size-3.5" />
                    </button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="start">
                    <DropdownMenuItem onSelect={() => setRenaming(d.id)}>
                      <Pencil /> {t("common.rename")}
                    </DropdownMenuItem>
                    <DropdownMenuItem onSelect={() => setEditing(true)}>
                      <LayoutGrid /> {t("home.editLayout")}
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      variant="destructive"
                      disabled={dashboards.length < 2}
                      onSelect={() => {
                        workspaceActions.removeDashboard(d.id)
                        setActiveId(null)
                      }}
                    >
                      <Trash2 /> {t("common.delete")}
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              )}
            </div>
          ))}
          <button
            onClick={async () => {
              const created = await workspaceActions.createDashboard({ name: t("home.newDashboard"), icon: "gauge", widgets: [] })
              if (!created) return
              setActiveId(created.id)
              setEditing(true)
              toast(t("home.dashboardCreated"))
            }}
            className="flex h-9 shrink-0 items-center gap-1 px-2 text-sm text-muted-foreground hover:text-foreground"
          >
            <Plus className="size-3.5" /> {t("home.new")}
          </button>
        </div>
      )}

      {active && <DashboardBoard key={active.id} dashboard={active} editing={editing} onExitEdit={() => setEditing(false)} />}
    </div>
  )
}
