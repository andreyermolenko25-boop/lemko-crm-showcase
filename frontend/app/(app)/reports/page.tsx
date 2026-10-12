"use client"

import { useMemo, useState } from "react"
import { BarChart3, LineChart as LineIcon, MoreHorizontal, PieChart as PieIcon, Plus, Table2, Trash2, Pencil } from "lucide-react"
import { Bar, BarChart, CartesianGrid, Cell, Line, LineChart, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts"
import { cn } from "@/lib/utils"
import type { EntityDef } from "@/lib/core/types"
import { useData, useMembers } from "@/lib/core/data"
import { useReportRows } from "@/lib/core/analytics"
import { useEntities, useWorkspace, workspaceActions, type ReportDef } from "@/lib/core/workspace"
import { uid } from "@/lib/core/store"
import { formatMoney, formatNumber } from "@/lib/core/format"
import { seriesColor } from "@/lib/core/chart-colors"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { EmptyState, PageHeader, Panel } from "@/components/crm/primitives"
import { useT } from "@/components/i18n-provider"
import { nounInSentence } from "@/lib/i18n/text"
import { useDefaultName } from "@/lib/core/schema-i18n"

const CHARTS: { key: ReportDef["chart"]; icon: typeof BarChart3 }[] = [
  { key: "bar", icon: BarChart3 },
  { key: "line", icon: LineIcon },
  { key: "pie", icon: PieIcon },
  { key: "table", icon: Table2 },
]

/** Server rows (stats.report) → chart data with labels from the data model. */
function useReportData(report: ReportDef, entity: EntityDef | undefined) {
  const { data: rows, error } = useReportRows(report)
  const members = useMembers()
  const records = useData((s) => s.records)
  const t = useT()
  const data = useMemo(() => {
    if (!entity || !rows) return []
    const field = entity.fields.find((f) => f.key === report.groupBy)
    const label = (key: string | null) => {
      if (key === null) return "—"
      if (field?.options) return field.options.find((o) => o.value === key)?.label ?? key
      if (field?.type === "user") return members.find((m) => m.id === key)?.name ?? key
      if (field?.type === "boolean") return key === "true" ? t("common.yes") : t("common.no")
      if (field?.type === "relation") {
        const target = (records[field.relation ?? ""] ?? []).find((r) => r.id === key)
        return target ? String(target.name ?? target.title ?? target.number ?? target.subject ?? target.address ?? key) : key
      }
      return key
    }
    return rows.map((row, i) => ({ name: label(row.key), fill: seriesColor(i), value: row.value }))
  }, [entity, rows, report.groupBy, members, records, t])
  return { data, error, loaded: rows !== undefined }
}

function ReportChart({ report, entity, height = 240 }: { report: ReportDef; entity?: EntityDef; height?: number }) {
  const { data, error, loaded } = useReportData(report, entity)
  const money = report.metric !== "count" && entity?.fields.find((f) => f.key === report.metricField)?.type === "currency"
  const fmt = (v: number) => (money ? formatMoney(v, { compact: true }) : formatNumber(v, true))
  const t = useT()
  if (error) return <p className="py-10 text-center text-xs text-muted-foreground">{error}</p>
  if (!loaded) return <div className="mx-auto my-10 size-4 animate-spin rounded-full border-2 border-border border-t-foreground" aria-label={t("common.loading")} />
  if (!data.length) return <p className="py-10 text-center text-xs text-muted-foreground">{t("reports.noData")}</p>
  const tooltip = (
    <Tooltip
      cursor={{ fill: "var(--chart-grid)" }}
      contentStyle={{ background: "var(--popover)", border: "1px solid var(--border)", borderRadius: 10, fontSize: "0.875rem" }}
      labelStyle={{ color: "var(--foreground)", fontWeight: 600 }}
      itemStyle={{ color: "var(--muted-foreground)" }}
      formatter={(v: number) => fmt(v)}
    />
  )
  if (report.chart === "table") {
    const total = data.reduce((s, d) => s + d.value, 0)
    return (
      <table className="w-full text-sm">
        <tbody className="divide-y">
          {data.map((d) => (
            <tr key={d.name}>
              <td className="py-2.5"><span className="flex items-center gap-2"><span className="size-2 rounded-full" style={{ background: d.fill }} />{d.name}</span></td>
              <td className="w-1/3 py-2.5">
                <div className="h-1.5 rounded-full bg-foreground/[0.06]">
                  <div className="h-full rounded-full" style={{ width: `${(d.value / total) * 100}%`, background: d.fill }} />
                </div>
              </td>
              <td className="py-2.5 text-right font-semibold tabular">{fmt(d.value)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    )
  }
  return (
    <>
    <div style={{ height: report.chart === "pie" ? height - 36 : height }}>
      <ResponsiveContainer width="100%" height="100%">
        {report.chart === "pie" ? (
          <PieChart>
            <Pie data={data} dataKey="value" nameKey="name" innerRadius="58%" outerRadius="88%" paddingAngle={2} stroke="var(--card)" strokeWidth={2}>
              {data.map((d) => (
                <Cell key={d.name} fill={d.fill} />
              ))}
            </Pie>
            {tooltip}
          </PieChart>
        ) : report.chart === "line" ? (
          <LineChart data={data} margin={{ left: -8, right: 8, top: 8 }}>
            <CartesianGrid vertical={false} stroke="var(--chart-grid)" strokeDasharray="4 4" />
            <XAxis dataKey="name" tickLine={false} axisLine={false} tickMargin={8} interval={0} />
            <YAxis tickLine={false} axisLine={false} tickFormatter={fmt} width={54} />
            {tooltip}
            <Line dataKey="value" stroke="var(--series-1)" strokeWidth={2} dot={{ r: 4, fill: "var(--series-1)", stroke: "var(--card)", strokeWidth: 2 }} />
          </LineChart>
        ) : (
          <BarChart data={data} margin={{ left: -8, right: 8, top: 8 }}>
            <CartesianGrid vertical={false} stroke="var(--chart-grid)" strokeDasharray="4 4" />
            <XAxis dataKey="name" tickLine={false} axisLine={false} tickMargin={8} interval={0} />
            <YAxis tickLine={false} axisLine={false} tickFormatter={fmt} width={54} />
            {tooltip}
            <Bar dataKey="value" radius={[6, 6, 2, 2]} maxBarSize={44}>
              {data.map((d) => (
                <Cell key={d.name} fill={d.fill} />
              ))}
            </Bar>
          </BarChart>
        )}
      </ResponsiveContainer>
    </div>
    {report.chart === "pie" && (
      <ul className="mt-3 flex flex-wrap justify-center gap-x-4 gap-y-1.5">
        {data.map((d) => (
          <li key={d.name} className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <span className="size-2 rounded-full" style={{ background: d.fill }} />
            {d.name} <span className="font-semibold text-foreground tabular">{fmt(d.value)}</span>
          </li>
        ))}
      </ul>
    )}
    </>
  )
}

function ReportBuilder({ initial, open, onOpenChange }: { initial: ReportDef | null; open: boolean; onOpenChange: (o: boolean) => void }) {
  const entities = useEntities()
  const t = useT()
  const [r, setR] = useState<ReportDef>(
    () => initial ?? { id: uid("rep"), name: t("reports.newReport"), entity: entities[0]?.key ?? "deals", groupBy: "", metric: "count", chart: "bar" },
  )
  const entity = entities.find((e) => e.key === r.entity)
  const groupable = entity?.fields.filter((f) => ["select", "status", "user", "relation", "boolean", "text"].includes(f.type)) ?? []
  const numeric = entity?.fields.filter((f) => ["currency", "number", "percent", "rating"].includes(f.type)) ?? []
  const effective = { ...r, groupBy: r.groupBy || groupable[0]?.key || "" }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>{initial ? t("reports.editReport") : t("reports.newReport")}</DialogTitle>
          <DialogDescription>{t("reports.builderDescription")}</DialogDescription>
        </DialogHeader>
        <div className="grid gap-5 md:grid-cols-[15rem_1fr]">
          <div className="flex flex-col gap-3">
            <div className="grid gap-1.5">
              <Label className="text-xs">{t("reports.name")}</Label>
              <Input value={r.name} onChange={(e) => setR({ ...r, name: e.target.value })} />
            </div>
            <div className="grid gap-1.5">
              <Label className="text-xs">{t("reports.object")}</Label>
              <Select value={r.entity} onValueChange={(v) => setR({ ...r, entity: v, groupBy: "", metricField: undefined })}>
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {entities.map((e) => (
                    <SelectItem key={e.key} value={e.key}>
                      {e.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-1.5">
              <Label className="text-xs">{t("reports.groupBy")}</Label>
              <Select value={effective.groupBy} onValueChange={(v) => setR({ ...r, groupBy: v })}>
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {groupable.map((f) => (
                    <SelectItem key={f.key} value={f.key}>
                      {f.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-1.5">
              <Label className="text-xs">{t("reports.measure")}</Label>
              <Select
                value={r.metric === "count" ? "count" : `${r.metric}:${r.metricField}`}
                onValueChange={(v) => {
                  if (v === "count") return setR({ ...r, metric: "count", metricField: undefined })
                  const [m, f] = v.split(":")
                  setR({ ...r, metric: m as ReportDef["metric"], metricField: f })
                }}
              >
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="count">{t("reports.countOfRecords")}</SelectItem>
                  {numeric.flatMap((f) => [
                    <SelectItem key={`sum:${f.key}`} value={`sum:${f.key}`}>
                      {t("reports.sumOf", { field: f.label })}
                    </SelectItem>,
                    <SelectItem key={`avg:${f.key}`} value={`avg:${f.key}`}>
                      {t("reports.averageOf", { field: f.label })}
                    </SelectItem>,
                  ])}
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-1.5">
              <Label className="text-xs">{t("reports.visualisation")}</Label>
              <div className="grid grid-cols-4 gap-1.5">
                {CHARTS.map((c) => (
                  <button
                    key={c.key}
                    onClick={() => setR({ ...r, chart: c.key })}
                    className={cn(
                      "flex h-14 flex-col items-center justify-center gap-1 rounded-lg border text-xs transition-colors",
                      r.chart === c.key ? "border-foreground/50 bg-accent font-medium" : "text-muted-foreground hover:bg-accent/60",
                    )}
                  >
                    <c.icon className="size-4" />
                    {t(`reports.charts.${c.key}`)}
                  </button>
                ))}
              </div>
            </div>
          </div>
          <div className="rounded-xl border bg-elevated/50 p-4">
            <p className="mb-3 text-xs font-semibold text-muted-foreground">{t("reports.livePreview")}</p>
            <ReportChart report={effective} entity={entity} height={280} />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t("common.cancel")}
          </Button>
          <Button
            onClick={async () => {
              if (await workspaceActions.saveReport(effective)) onOpenChange(false)
            }}
          >
            {t("reports.saveReport")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export default function ReportsPage() {
  const reports = useWorkspace((s) => s.reports)
  const entities = useEntities()
  const [editing, setEditing] = useState<ReportDef | null>(null)
  const [open, setOpen] = useState(false)
  const t = useT()
  const dn = useDefaultName()

  return (
    <div className="flex flex-col gap-[var(--gap)]">
      <PageHeader
        icon="chart-line"
        title={t("reports.title")}
        description={t("reports.description")}
        actions={
          <Button
            size="sm"
            onClick={() => {
              setEditing(null)
              setOpen(true)
            }}
          >
            <Plus /> {t("reports.newReport")}
          </Button>
        }
      />
      {reports.length === 0 && (
        <div className="surface">
          <EmptyState icon="pie-chart" title={t("reports.noReports")} description={t("reports.noReportsHint")} />
        </div>
      )}
      <div className="grid gap-[var(--gap)] lg:grid-cols-2">
        {reports.map((r) => {
          const entity = entities.find((e) => e.key === r.entity)
          const groupLabel = entity?.fields.find((f) => f.key === r.groupBy)?.label ?? r.groupBy
          const metricField = entity?.fields.find((f) => f.key === r.metricField)?.label ?? ""
          const metricLabel = r.metric === "count" ? t("reports.count") : t(r.metric === "sum" ? "reports.sumShort" : "reports.avgShort", { field: metricField })
          return (
            <Panel
              key={r.id}
              title={dn(r.name)}
              subtitle={entity ? t("reports.subtitle", { object: entity.label, metric: metricLabel, group: nounInSentence(groupLabel) }) : t("reports.notInstalled")}
              actions={
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="ghost" size="icon-sm" aria-label={t("reports.options")}>
                      <MoreHorizontal />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem
                      onSelect={() => {
                        setEditing(r)
                        setOpen(true)
                      }}
                    >
                      <Pencil /> {t("common.edit")}
                    </DropdownMenuItem>
                    <DropdownMenuItem variant="destructive" onSelect={() => workspaceActions.removeReport(r.id)}>
                      <Trash2 /> {t("common.delete")}
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              }
            >
              <ReportChart report={r} entity={entity} />
            </Panel>
          )
        })}
      </div>
      {open && <ReportBuilder key={editing?.id ?? "new"} initial={editing} open={open} onOpenChange={setOpen} />}
    </div>
  )
}
