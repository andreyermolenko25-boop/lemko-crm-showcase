"use client"

import Link from "next/link"
import { useEffect, useMemo, useState } from "react"
import { Download, Plus, Settings2 } from "lucide-react"
import type { EntityDef, ViewDef } from "@/lib/core/types"
import { displayValue, queryRecords, useRecords } from "@/lib/core/data"
import { useWorkspace, workspaceActions } from "@/lib/core/workspace"
import { formatMoney } from "@/lib/core/format"
import { ui } from "@/lib/core/ui"
import { Button } from "@/components/ui/button"
import { PageHeader } from "@/components/crm/primitives"
import { FavoriteToggle } from "@/components/shell/sidebar"
import { FieldsButton, FilterButton, GroupButton, SearchBox, SortButton, ViewTabs } from "@/components/views/view-toolbar"
import { TableView } from "@/components/views/table-view"
import { BoardView } from "@/components/views/board-view"
import { GalleryView } from "@/components/views/gallery-view"
import { ListView } from "@/components/views/list-view"
import { CalendarView } from "@/components/views/calendar-view"
import { useT } from "@/components/i18n-provider"
import { nounInSentence } from "@/lib/i18n/text"
import { useDefaultName } from "@/lib/core/schema-i18n"

const EMPTY_VIEWS: ViewDef[] = []
// Visits and shifts are booked through the schedule; stock and services are tied to the till.

function exportCsv(entity: EntityDef, rows: ReturnType<typeof queryRecords>) {
  const header = entity.fields.map((f) => f.label)
  const esc = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v)
  const lines = [header.map(esc).join(",")]
  for (const r of rows) lines.push(entity.fields.map((f) => esc(displayValue(entity, r, f.key))).join(","))
  const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8" })
  const a = document.createElement("a")
  a.href = URL.createObjectURL(blob)
  a.download = `${entity.key}-${new Date().toISOString().slice(0, 10)}.csv`
  a.click()
  URL.revokeObjectURL(a.href)
}

export function EntityPage({ entity }: { entity: EntityDef }) {
  const records = useRecords(entity.key)
  const views = useWorkspace((s) => s.views[entity.key]) ?? EMPTY_VIEWS
  const activeId = useWorkspace((s) => s.activeView[entity.key])
  const [search, setSearch] = useState("")
  const t = useT()
  const dn = useDefaultName()

  useEffect(() => workspaceActions.ensureViews(entity), [entity])

  const view = views.find((v) => v.id === activeId) ?? views[0]
  const rows = useMemo(
    () => (view ? queryRecords(entity, records, { search, filters: view.filters, sort: view.sort }) : []),
    [entity, records, search, view],
  )
  const amountField = entity.fields.find((f) => f.key === entity.amountField)
  const total = amountField ? rows.reduce((s, r) => s + (Number(r[amountField.key]) || 0), 0) : null

  if (!view) return null

  return (
    <div className="flex flex-col gap-[var(--gap)]">
      <PageHeader
        icon={entity.icon}
        color={entity.color}
        title={entity.label}
        description={
          <span className="tabular">
            {/* "12 records" until a search or filter hides some; then "3 of 12 records". */}
            {rows.length === records.length
              ? t("views.recordsCount", { count: records.length })
              : t("views.countOf", { shown: rows.length, total: records.length, count: records.length })}
            {total !== null && <> · {t("views.total", { amount: formatMoney(total, { compact: true }) })}</>}
          </span>
        }
        actions={
          <>
            <FavoriteToggle fav={{ id: `view:${view.id}`, label: `${entity.label} · ${dn(view.name)}`, href: `/o/${entity.key}`, icon: entity.icon }} />
            <Button variant="outline" size="sm" asChild>
              <Link href={`/settings/objects/${entity.key}`}>
                <Settings2 /> {t("views.customize")}
              </Link>
            </Button>
            <Button variant="outline" size="sm" onClick={() => exportCsv(entity, rows)}>
              <Download /> {t("views.export")}
            </Button>
            <Button size="sm" onClick={() => ui.openCreate(entity.key)}>
              <Plus /> {t("views.newRecord", { name: nounInSentence(entity.labelSingular) })}
            </Button>
          </>
        }
      />

      {/* The controls wrap as one group under the tabs when both don't fit on a line. */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b pb-3">
        <ViewTabs entity={entity} views={views} active={view} />
        <div className="flex flex-wrap items-center gap-2">
          <SearchBox value={search} onChange={setSearch} placeholder={t("views.searchIn", { name: nounInSentence(entity.label) })} />
          <FilterButton entity={entity} view={view} />
          <SortButton entity={entity} view={view} />
          {(view.type === "board" || view.type === "list") && <GroupButton entity={entity} view={view} />}
          {view.type !== "calendar" && <FieldsButton entity={entity} view={view} />}
        </div>
      </div>

      <div key={view.id} className="rise min-w-0">
        {view.type === "table" && <TableView entity={entity} view={view} records={rows} />}
        {view.type === "board" && <BoardView entity={entity} view={view} records={rows} />}
        {view.type === "gallery" && <GalleryView entity={entity} view={view} records={rows} />}
        {view.type === "list" && <ListView entity={entity} view={view} records={rows} />}
        {view.type === "calendar" && <CalendarView entity={entity} view={view} records={rows} />}
      </div>

    </div>
  )
}
