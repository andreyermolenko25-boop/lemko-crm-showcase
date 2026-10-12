"use client"

import Link from "next/link"
import { useEffect, useMemo, useState } from "react"
import { ArrowUpRight, MoreHorizontal, Plus } from "lucide-react"
import { Area, CartesianGrid, ComposedChart, Cell, Line, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts"
import { cn } from "@/lib/utils"
import type { CrmRecord, WidgetDef, WidgetProps } from "@/lib/core/types"
import { memberById, useData, useMembers, useRecords } from "@/lib/core/data"
import { useEntity, useWorkspace } from "@/lib/core/workspace"
import { useWidgetData } from "@/lib/core/analytics"
import { formatDate, formatMoney, formatNumber, formatTime, timeAgo } from "@/lib/core/format"
import { ui } from "@/lib/core/ui"
import { Icon } from "@/lib/core/icons"
import { rampColor, seriesColor } from "@/lib/core/chart-colors"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { ActivityIcon } from "@/components/crm/activity-icon"
import { FieldValue, relationTitle } from "@/components/crm/field-value"
import { Delta, Dot, IconTile, MemberAvatar, MiniProgress, Monogram, Panel, SparkBars } from "@/components/crm/primitives"
import { useI18n, useT } from "@/components/i18n-provider"
import { useActivityText } from "@/lib/core/activity-text"
import { nounInSentence } from "@/lib/i18n/text"
import { getLocale, type Translator } from "@/lib/i18n/translate"

/*
 * Every number on these widgets is computed by the server (stats.py) for the
 * period picked in the top bar; widgets only lay it out.
 */

const str = (v: unknown, d = "") => (typeof v === "string" ? v : d)
const num = (v: unknown, d = 0) => (typeof v === "number" ? v : d)

const monthLabel = (key: string) => new Intl.DateTimeFormat(getLocale(), { month: "short" }).format(new Date(`${key}-01T00:00:00`))

function Missing({ entity }: { entity: string }) {
  const t = useT()
  return (
    <Panel className="h-full">
      <p className="m-auto text-center text-xs text-muted-foreground">
        {t("widgets.missing", { name: entity })}
      </p>
    </Panel>
  )
}

function WidgetError({ title, message }: { title?: string; message: string }) {
  return (
    <Panel className="h-full" title={title}>
      <p className="m-auto text-center text-xs text-muted-foreground">{message}</p>
    </Panel>
  )
}

function Loading({ title }: { title?: string }) {
  const t = useT()
  return (
    <Panel className="h-full" title={title}>
      <div className="m-auto size-4 animate-spin rounded-full border-2 border-border border-t-foreground" aria-label={t("widgets.loading")} />
    </Panel>
  )
}

/* -------------------------------------------------------------------------- */
/*  KPI                                                                        */
/* -------------------------------------------------------------------------- */

const KPI_ICONS: Record<string, string> = { sum: "wallet", count: "briefcase", conversion: "target", avg: "receipt" }
/** Default series slot per metric so each KPI keeps a stable colour identity. */
const KPI_SLOT: Record<string, number> = { sum: 0, count: 2, conversion: 6, avg: 1 }

type KpiData = {
  value: number
  format: "money" | "number" | "percent"
  series: number[]
  delta: number | null
  deltaUnit: "%" | "pp"
  caption: { records: number; target?: number; worth?: number; won?: number; closed?: number }
}

function kpiCaption(t: Translator["t"], metric: string, d: KpiData): string {
  const c = d.caption
  if (metric === "conversion") return t("widgets.caption.conversion", { won: c.won ?? 0, closed: c.closed ?? 0 })
  if (metric === "sum" && c.target) return t("widgets.caption.target", { pct: Math.round((d.value / c.target) * 100), target: formatMoney(c.target, { compact: true }) })
  if (metric === "count" && c.worth !== undefined) return t("widgets.caption.worth", { amount: formatMoney(c.worth, { compact: true }) })
  if (metric === "avg") return t("widgets.caption.across", { count: c.records })
  return t("widgets.caption.records", { count: c.records })
}

function KpiWidget({ widget }: WidgetProps) {
  const c = widget.config
  const entity = useEntity(str(c.entity, "deals"))
  const metric = str(c.metric, "count")
  const { data, error } = useWidgetData<KpiData>("kpi", c)
  const t = useT()

  if (!entity) return <Missing entity={str(c.entity)} />
  const kpiColor = seriesColor(typeof c.colorSlot === "number" ? c.colorSlot : (KPI_SLOT[metric] ?? 0))
  const display = !data
    ? "…"
    : data.format === "percent"
      ? `${formatNumber(Math.round(data.value * 10) / 10)}%`
      : data.format === "money"
        ? formatMoney(data.value, { compact: true })
        : formatNumber(data.value)

  return (
    <section className="surface flex h-full flex-col justify-between gap-3 p-[var(--pad)]">
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2.5">
          <span
            className="flex size-7 shrink-0 items-center justify-center rounded-lg border"
            style={{ color: kpiColor, background: `color-mix(in oklch, ${kpiColor} 12%, transparent)`, borderColor: `color-mix(in oklch, ${kpiColor} 22%, transparent)` }}
          >
            <Icon name={str(c.icon) || KPI_ICONS[metric] || entity.icon} className="size-3.5" />
          </span>
          <span className="truncate text-sm font-medium text-muted-foreground">{str(c.label) || widget.title || entity.label}</span>
        </div>
        {data?.delta != null && <Delta value={Math.max(-999, Math.min(999, data.delta))} unit={data.deltaUnit} />}
      </div>
      <div className="flex items-end justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-3xl font-semibold leading-none tracking-tight tabular">{display}</p>
          <p className="mt-1.5 truncate text-xs text-muted-foreground">{error ?? (data ? kpiCaption(t, metric, data) : "")}</p>
        </div>
        {data && <SparkBars values={data.series} className="shrink-0" color={kpiColor} />}
      </div>
    </section>
  )
}

/* -------------------------------------------------------------------------- */
/*  Trend chart                                                                 */
/* -------------------------------------------------------------------------- */

function ChartTooltip({ active, payload, label, money }: { active?: boolean; payload?: { name: string; value: number; color: string }[]; label?: string; money?: boolean }) {
  if (!active || !payload?.length) return null
  return (
    <div className="rounded-lg border bg-popover px-3 py-2 text-xs shadow-[var(--shadow-pop)]">
      <p className="mb-1 font-medium">{label}</p>
      {payload.map((p) => (
        <p key={p.name} className="flex items-center gap-2 text-muted-foreground">
          <span className="size-1.5 rounded-full" style={{ background: p.color }} />
          {p.name}: <span className="font-medium text-foreground tabular">{money ? formatMoney(p.value, { compact: true }) : formatNumber(p.value)}</span>
        </p>
      ))}
    </div>
  )
}

type TrendData = { points: { month: string; actual: number; compare: number }[]; compareKind: "plan" | "previous"; money: boolean }

function TrendWidget({ widget }: WidgetProps) {
  const c = widget.config
  const entity = useEntity(str(c.entity, "deals"))
  const [months, setMonths] = useState(num(c.months, 6) >= 12 ? 12 : 6)
  const t = useT()
  const { data: result, error } = useWidgetData<TrendData>("trend", { ...c, months })
  const data = useMemo(
    () => (result?.points ?? []).map((p) => ({ label: monthLabel(p.month), Actual: Math.round(p.actual), Compare: Math.round(p.compare) })),
    [result],
  )

  if (!entity) return <Missing entity={str(c.entity)} />
  const money = result?.money ?? Boolean(str(c.field) || entity.amountField)
  const compareName = result?.compareKind === "plan" ? t("widgets.plan") : t("widgets.previousPeriod")
  const actualName = t("widgets.actual")

  return (
    <Panel
      className="h-full"
      title={widget.title ?? str(c.title, t("widgets.trend"))}
      subtitle={t(money ? "widgets.cumulativeValue" : "widgets.cumulativeCount", { name: entity.label })}
      actions={
        <div className="flex items-center gap-3">
          <span className="hidden items-center gap-3 text-xs text-muted-foreground sm:flex">
            <span className="flex items-center gap-1.5">
              <span className="size-2 rounded-full bg-series-1" /> {actualName}
            </span>
            <span className="flex items-center gap-1.5">
              <span className="h-0.5 w-3 rounded-full bg-chart-plan" /> {compareName}
            </span>
          </span>
          <div className="flex rounded-lg border p-0.5">
            {[6, 12].map((m) => (
              <button
                key={m}
                onClick={() => setMonths(m)}
                className={cn("h-6 rounded-md px-2 text-xs font-semibold", months === m ? "bg-accent text-foreground" : "text-muted-foreground")}
              >
                {t("widgets.months", { count: m })}
              </button>
            ))}
          </div>
        </div>
      }
    >
      <div className="min-h-44 flex-1">
        {error ? (
          <p className="py-10 text-center text-xs text-muted-foreground">{error}</p>
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={data} margin={{ top: 8, right: 6, left: -12, bottom: 0 }}>
              <defs>
                <linearGradient id={`fill-${widget.id}`} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="var(--series-1)" stopOpacity={0.22} />
                  <stop offset="100%" stopColor="var(--series-1)" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid vertical={false} stroke="var(--chart-grid)" strokeDasharray="4 4" />
              <XAxis dataKey="label" tickLine={false} axisLine={false} tickMargin={10} />
              <YAxis tickLine={false} axisLine={false} width={56} tickFormatter={(v) => (money ? formatMoney(v, { compact: true }) : formatNumber(v, true))} />
              <Tooltip content={<ChartTooltip money={money} />} cursor={{ stroke: "var(--border-strong)" }} />
              <Area type="monotone" dataKey="Actual" name={actualName} stroke="var(--series-1)" strokeWidth={2} fill={`url(#fill-${widget.id})`} dot={false} activeDot={{ r: 4, strokeWidth: 0 }} />
              <Line type="linear" dataKey="Compare" name={compareName} stroke="var(--chart-plan)" strokeWidth={1.5} strokeDasharray="5 4" dot={false} />
            </ComposedChart>
          </ResponsiveContainer>
        )}
      </div>
    </Panel>
  )
}

/* -------------------------------------------------------------------------- */
/*  Funnel                                                                      */
/* -------------------------------------------------------------------------- */

type FunnelData = { stages: { value: string; label: string; count: number }[]; conversion: number; medianCycleDays: number | null }

function FunnelWidget({ widget }: WidgetProps) {
  const c = widget.config
  const entity = useEntity(str(c.entity, "deals"))
  const { data, error } = useWidgetData<FunnelData>("funnel", c)
  const t = useT()
  if (!entity) return <Missing entity={str(c.entity)} />
  const title = widget.title ?? str(c.title, t("widgets.funnel"))
  if (error) return <WidgetError title={title} message={error} />
  if (!data) return <Loading title={title} />
  // Labels come from the (localized) data model; the server sends the English source.
  const stageField = entity.fields.find((f) => f.key === entity.stageField)
  const rows = data.stages.map((s) => ({ ...s, label: stageField?.options?.find((o) => o.value === s.value)?.label ?? s.label }))
  const max = Math.max(1, ...rows.map((r) => r.count))

  return (
    <Panel
      className="h-full"
      title={title}
      subtitle={t("widgets.stageConversion", { name: entity.label })}
      actions={<span className="text-sm font-semibold text-success tabular">{formatNumber(Math.round(data.conversion * 10) / 10)}%</span>}
    >
      <div className="flex flex-1 flex-col justify-center gap-3.5">
        {rows.map((r, i) => (
          <div key={r.value} className="grid grid-cols-[6.5rem_1fr_2.5rem] items-center gap-3">
            <span className="truncate text-xs font-medium">{r.label}</span>
            <div className="h-3 overflow-hidden rounded-full bg-foreground/[0.06]">
              <div className="h-full rounded-full transition-[width] duration-500" style={{ width: `${(r.count / max) * 100}%`, background: rampColor(i, rows.length) }} />
            </div>
            <span className="text-right text-sm font-semibold tabular">{r.count}</span>
          </div>
        ))}
      </div>
      <div className="mt-4 flex items-center justify-between border-t pt-3 text-xs">
        <span className="text-muted-foreground">{t("widgets.medianCycle")}</span>
        <span className="font-semibold tabular">{data.medianCycleDays === null ? "—" : t("widgets.days", { count: data.medianCycleDays, value: formatNumber(data.medianCycleDays) })}</span>
      </div>
    </Panel>
  )
}

/* -------------------------------------------------------------------------- */
/*  Records table                                                               */
/* -------------------------------------------------------------------------- */

/** Server-picked record ids → the records already loaded in the browser, same order. */
function usePicked(entityKey: string | undefined, ids: string[] | undefined): CrmRecord[] {
  const records = useRecords(entityKey)
  return useMemo(() => {
    const byId = new Map(records.map((r) => [r.id, r]))
    return (ids ?? []).map((id) => byId.get(id)).filter(Boolean) as CrmRecord[]
  }, [records, ids])
}

function RecordsWidget({ widget }: WidgetProps) {
  const c = widget.config
  const entity = useEntity(str(c.entity, "deals"))
  const { data } = useWidgetData<{ ids: string[]; open: number }>("records", c)
  const rows = usePicked(entity?.key, data?.ids)
  const t = useT()
  if (!entity) return <Missing entity={str(c.entity)} />
  const stage = entity.fields.find((f) => f.key === entity.stageField)
  const pct = entity.fields.find((f) => f.type === "percent")
  const related = entity.fields.find((f) => f.type === "relation")
  const amount = entity.fields.find((f) => f.key === entity.amountField)
  const date = entity.fields.find((f) => f.key === entity.dateField)

  return (
    <Panel
      className="h-full"
      title={widget.title ?? str(c.title, entity.label)}
      subtitle={data ? t("widgets.largestOf", { count: data.open }) : t("widgets.largestOpen")}
      actions={
        <Link href={`/o/${entity.key}`} className="flex items-center gap-1 text-xs font-medium text-brand hover:underline">
          {t("widgets.allOf", { name: nounInSentence(entity.label) })} <ArrowUpRight className="size-3.5" />
        </Link>
      }
    >
      <div className="-mx-1 overflow-x-auto">
        <table className="w-full min-w-[30rem] text-sm">
          <thead>
            <tr className="border-b text-left text-2xs font-medium uppercase tracking-wider text-subtle-foreground">
              <th className="px-1 pb-2.5 font-medium">{related?.label ?? entity.labelSingular}</th>
              {amount && <th className="px-1 pb-2.5 font-medium">{amount.label}</th>}
              {stage && <th className="px-1 pb-2.5 font-medium">{stage.label}</th>}
              {pct && <th className="px-1 pb-2.5 text-right font-medium">{pct.label}</th>}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const title = (related && relationTitle(related.relation, r[related.key])) || String(r[entity.primaryField])
              const owner = entity.ownerField ? memberById(r[entity.ownerField]) : undefined
              return (
                <tr key={r.id} onClick={() => ui.peek(entity.key, r.id)} className="cursor-pointer border-b last:border-0 hover:bg-elevated/70">
                  <td className="px-1 py-3">
                    <div className="flex items-center gap-3">
                      <Monogram name={title} square size="md" />
                      <div className="min-w-0">
                        <p className="truncate font-medium">{title}</p>
                        <p className="truncate text-xs text-muted-foreground">{owner?.name ?? String(r[entity.primaryField])}</p>
                      </div>
                    </div>
                  </td>
                  {amount && (
                    <td className="px-1 py-3">
                      <p className="font-semibold tabular">{formatMoney(r[amount.key], { compact: true })}</p>
                      {date && r[date.key] ? <p className="text-xs text-muted-foreground tabular">{formatDate(r[date.key])}</p> : null}
                    </td>
                  )}
                  {stage && (
                    <td className="px-1 py-3">
                      <FieldValue field={{ ...stage, type: "select", options: stage.options?.map((o) => ({ ...o, color: "gray" })) }} value={r[stage.key]} />
                    </td>
                  )}
                  {pct && (
                    <td className="px-1 py-3">
                      <div className="ml-auto flex w-20 flex-col items-end gap-1.5">
                        <span className="text-xs font-semibold tabular">{num(r[pct.key])}%</span>
                        <MiniProgress value={num(r[pct.key])} />
                      </div>
                    </td>
                  )}
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </Panel>
  )
}

/* -------------------------------------------------------------------------- */
/*  Agenda (any entity with a date field)                                       */
/* -------------------------------------------------------------------------- */

const TYPE_ICON: Record<string, { icon: string; color: "violet" | "green" | "amber" | "blue" | "teal" | "gray" }> = {
  meeting: { icon: "calendar", color: "violet" },
  call: { icon: "phone", color: "green" },
  todo: { icon: "file", color: "amber" },
  email: { icon: "mail", color: "blue" },
}

function AgendaWidget({ widget }: WidgetProps) {
  const c = widget.config
  const entity = useEntity(str(c.entity, "tasks"))
  const { data } = useWidgetData<{ ids: string[]; today: number }>("agenda", c)
  const rows = usePicked(entity?.key, data?.ids)
  const t = useT()
  if (!entity) return <Missing entity={str(c.entity)} />
  const todayCount = data?.today ?? 0
  const dateOf = (r: CrmRecord) => new Date(String((entity.dateField && r[entity.dateField]) || r.createdAt))
  const related = entity.fields.find((f) => f.type === "relation")

  return (
    <Panel
      className="h-full"
      title={widget.title ?? str(c.title, t("widgets.upcoming", { name: nounInSentence(entity.label) }))}
      subtitle={t("widgets.todayCount", { count: todayCount, name: nounInSentence(entity.label) })}
      actions={
        <Button variant="outline" size="icon-sm" onClick={() => ui.openCreate(entity.key)} aria-label={t("widgets.newNamed", { name: nounInSentence(entity.labelSingular) })}>
          <Plus />
        </Button>
      }
    >
      <ul className="flex flex-1 flex-col divide-y">
        {rows.map((r) => {
          const ti = TYPE_ICON[String(r.type)] ?? { icon: entity.icon, color: entity.color === "amber" ? "amber" : "gray" }
          const d = dateOf(r)
          const isToday = d.toDateString() === new Date().toDateString()
          return (
            <li key={r.id}>
              <button onClick={() => ui.peek(entity.key, r.id)} className="flex w-full items-center gap-3 py-3 text-left">
                <span className="w-10 shrink-0 text-xs text-muted-foreground tabular">{isToday ? formatTime(d) : formatDate(d, { day: "2-digit", month: "short" })}</span>
                <IconTile icon={ti.icon} color={ti.color} size="md" className="rounded-[10px] border bg-elevated" />
                <span className="min-w-0">
                  <span className="block truncate text-sm font-medium">{String(r[entity.primaryField])}</span>
                  <span className="block truncate text-xs text-muted-foreground">
                    {related ? relationTitle(related.relation, r[related.key]) : null}
                  </span>
                </span>
              </button>
            </li>
          )
        })}
        {rows.length === 0 && <li className="py-8 text-center text-xs text-muted-foreground">{t("widgets.nothingScheduled")}</li>}
      </ul>
      <Button asChild variant="secondary" size="sm" className="mt-2 w-full">
        <Link href="/calendar">{t("widgets.openCalendar")}</Link>
      </Button>
    </Panel>
  )
}

/* -------------------------------------------------------------------------- */
/*  Activity                                                                    */
/* -------------------------------------------------------------------------- */

function ActivityWidget({ widget }: WidgetProps) {
  const activities = useData((s) => s.activities)
  const rows = activities.slice(0, num(widget.config.limit, 4))
  const t = useT()
  const describe = useActivityText()
  return (
    <Panel
      className="h-full"
      title={widget.title ?? str(widget.config.title, t("widgets.activity"))}
      subtitle={t("widgets.latestEvents")}
      actions={
        <Button asChild variant="ghost" size="icon-sm" aria-label={t("widgets.openInbox")}>
          <Link href="/inbox">
            <MoreHorizontal />
          </Link>
        </Button>
      }
    >
      <ul className="flex flex-1 flex-col divide-y">
        {rows.map((a) => {
          const { head, subject } = describe(a)
          return (
            <li key={a.id}>
              <Link href={`/o/${a.entity}/${a.recordId}`} className="flex items-center gap-3 py-3">
                <ActivityIcon kind={a.kind} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium">{head}</span>
                  <span className="block truncate text-xs text-muted-foreground">{subject || memberById(a.actor)?.name || t("common.system")}</span>
                </span>
                <span className="shrink-0 text-xs text-muted-foreground">{timeAgo(a.at)}</span>
              </Link>
            </li>
          )
        })}
      </ul>
      <Button asChild variant="secondary" size="sm" className="mt-2 w-full">
        <Link href="/inbox">{t("widgets.showAllActivity")}</Link>
      </Button>
    </Panel>
  )
}

/* -------------------------------------------------------------------------- */
/*  Leaderboard / goal / breakdown / notes                                      */
/* -------------------------------------------------------------------------- */

type LeaderRow = { owner: string; count: number; won: number; value: number }

function LeaderboardWidget({ widget }: WidgetProps) {
  const entity = useEntity(str(widget.config.entity, "deals"))
  const members = useMembers()
  const { data, error } = useWidgetData<{ rows: LeaderRow[]; money: boolean }>("leaderboard", widget.config)
  const t = useT()
  if (!entity) return <Missing entity={str(widget.config.entity)} />
  const title = widget.title ?? str(widget.config.title, t("widgets.leaderboard"))
  if (error) return <WidgetError title={title} message={error} />
  const rows = (data?.rows ?? []).map((r) => ({ ...r, m: memberById(r.owner) })).filter((r) => r.m)
  const max = Math.max(1, ...rows.map((r) => r.value))
  return (
    <Panel className="h-full" title={title} subtitle={t("widgets.wonByOwner", { name: nounInSentence(entity.label) })}>
      <ol className="flex flex-col gap-3">
        {rows.map((r, i) => (
          <li key={r.owner} className="grid grid-cols-[1.25rem_1fr_auto] items-center gap-3">
            <span className="text-xs font-semibold text-subtle-foreground tabular">{i + 1}</span>
            <div className="min-w-0">
              <div className="flex items-center justify-between gap-2">
                <MemberAvatar member={r.m} withName size="xs" className="text-sm font-medium" />
                <span className="text-xs text-muted-foreground tabular">
                  {t("widgets.wonOf", { won: r.won, count: r.count })}
                </span>
              </div>
              <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-foreground/[0.06]">
                <div className="h-full rounded-full" style={{ width: `${(r.value / max) * 100}%`, background: seriesColor(members.indexOf(r.m!)) }} />
              </div>
            </div>
            <span className="w-20 text-right text-sm font-semibold tabular">{data?.money ? formatMoney(r.value, { compact: true }) : formatNumber(r.value)}</span>
          </li>
        ))}
        {data && rows.length === 0 && <li className="py-8 text-center text-xs text-muted-foreground">{t("widgets.noOwners", { name: nounInSentence(entity.label) })}</li>}
      </ol>
    </Panel>
  )
}

function GoalWidget({ widget }: WidgetProps) {
  const entity = useEntity(str(widget.config.entity, "deals"))
  const { data, error } = useWidgetData<{ value: number; target: number; pct: number; range: string; money: boolean }>("goal", widget.config)
  const { t, maybe } = useI18n()
  const title = widget.title ?? str(widget.config.title, t("widgets.goal"))
  if (!entity) return <Missing entity={str(widget.config.entity)} />
  if (error) return <WidgetError title={title} message={error} />
  if (!data) return <Loading title={title} />
  const fmt = (v: number) => (data.money ? formatMoney(v, { compact: true }) : formatNumber(v))
  const R = 52
  const C = 2 * Math.PI * R
  return (
    <Panel className="h-full" title={title} subtitle={t("widgets.wonInRange", { name: nounInSentence(entity.label), range: maybe(`widgets.ranges.${data.range}`) ?? data.range })}>
      <div className="flex flex-1 flex-col items-center justify-center gap-3">
        <div className="relative">
          <svg viewBox="0 0 128 128" className="size-36 -rotate-90">
            <circle cx="64" cy="64" r={R} fill="none" stroke="var(--chart-grid)" strokeWidth="10" />
            <circle cx="64" cy="64" r={R} fill="none" stroke="var(--brand)" strokeWidth="10" strokeLinecap="round" strokeDasharray={C} strokeDashoffset={C - (data.pct / 100) * C} className="transition-[stroke-dashoffset] duration-700" />
          </svg>
          <div className="absolute inset-0 flex flex-col items-center justify-center">
            <span className="text-2xl font-semibold tabular">{data.target ? `${Math.round(data.pct)}%` : fmt(data.value)}</span>
            <span className="text-xs text-muted-foreground">{data.target ? t("widgets.ofGoal") : t("widgets.won")}</span>
          </div>
        </div>
        <p className="text-xs text-muted-foreground tabular">
          {data.target ? (
            <>
              <span className="font-semibold text-foreground">{fmt(data.value)}</span> / {fmt(data.target)}
            </>
          ) : (
            t("widgets.setTarget")
          )}
        </p>
      </div>
    </Panel>
  )
}

type Slice = { value: string; label: string; count: number }

function BreakdownWidget({ widget }: WidgetProps) {
  const entity = useEntity(str(widget.config.entity, "deals"))
  const { data: result, error } = useWidgetData<{ field: string; slices: Slice[]; total: number }>("breakdown", widget.config)
  const field = entity?.fields.find((f) => f.key === (result?.field ?? str(widget.config.field)))
  const t = useT()
  const data = useMemo(
    () => (result?.slices ?? []).map((s, i) => ({ name: field?.options?.find((o) => o.value === s.value)?.label ?? s.label, fill: seriesColor(i), value: s.count })),
    [result, field],
  )
  if (!entity) return <Missing entity={str(widget.config.entity)} />
  const title = widget.title ?? str(widget.config.title, t("widgets.byField", { field: nounInSentence(field?.label ?? t("widgets.fieldFallback")) }))
  if (error) return <WidgetError title={title} message={error} />
  const total = result?.total ?? 0
  return (
    <Panel className="h-full" title={title} subtitle={t("widgets.totalCount", { name: entity.label, count: total })}>
      <div className="flex flex-1 items-center gap-4">
        <div className="size-32 shrink-0">
          <ResponsiveContainer width="100%" height="100%">
            <PieChart>
              <Pie data={data} dataKey="value" nameKey="name" innerRadius="62%" outerRadius="100%" paddingAngle={2} stroke="var(--card)" strokeWidth={2}>
                {data.map((d) => (
                  <Cell key={d.name} fill={d.fill} />
                ))}
              </Pie>
              <Tooltip content={<ChartTooltip />} />
            </PieChart>
          </ResponsiveContainer>
        </div>
        <ul className="flex min-w-0 flex-1 flex-col gap-2">
          {data.map((d) => (
            <li key={d.name} className="flex items-center gap-2 text-xs">
              <span className="size-2 shrink-0 rounded-full" style={{ background: d.fill }} />
              <span className="flex-1 truncate">{d.name}</span>
              <span className="font-semibold tabular">{total ? Math.round((d.value / total) * 100) : 0}%</span>
            </li>
          ))}
        </ul>
      </div>
    </Panel>
  )
}

function NotesWidget({ widget, onConfig }: WidgetProps) {
  const t = useT()
  return (
    <Panel className="h-full" title={widget.title ?? str(widget.config.title, t("widgets.notes"))} subtitle={t("widgets.sharedWithWorkspace")}>
      <Textarea
        defaultValue={str(widget.config.text)}
        onBlur={(e) => onConfig({ text: e.target.value })}
        placeholder={t("widgets.notesPlaceholder")}
        className="min-h-16 flex-1 resize-none border-dashed bg-transparent shadow-none"
      />
    </Panel>
  )
}

function StageSummaryWidget({ widget }: WidgetProps) {
  const entity = useEntity(str(widget.config.entity, "tasks"))
  const field = entity?.fields.find((f) => f.key === entity.stageField)
  const { data } = useWidgetData<{ stages: Slice[]; total: number }>("stages", widget.config)
  const t = useT()
  if (!entity || !field?.options) return <Missing entity={str(widget.config.entity)} />
  const counts = new Map((data?.stages ?? []).map((s) => [s.value, s.count]))
  const total = data?.total ?? 0
  return (
    <Panel
      className="h-full"
      title={widget.title ?? str(widget.config.title, entity.label)}
      subtitle={t("widgets.recordsBy", { count: total, field: nounInSentence(field.label) })}
      actions={<IconTile icon={entity.icon} color={entity.color} size="sm" />}
    >
      <div className="flex h-2.5 overflow-hidden rounded-full">
        {field.options.map((o) => (
          <span key={o.value} data-color={o.color} className="tag-dot h-full" style={{ width: `${((counts.get(o.value) ?? 0) / (total || 1)) * 100}%` }} />
        ))}
      </div>
      <ul className="mt-4 grid grid-cols-2 gap-x-4 gap-y-2.5">
        {field.options.map((o) => (
          <li key={o.value} className="flex items-center gap-2 text-xs">
            <Dot color={o.color} />
            <span className="flex-1 truncate">{o.label}</span>
            <span className="font-semibold tabular">{counts.get(o.value) ?? 0}</span>
          </li>
        ))}
      </ul>
      <Link href={`/o/${entity.key}`} className="mt-auto pt-3 text-xs font-medium text-brand hover:underline">
        {t("widgets.openNamed", { name: nounInSentence(entity.label) })}
      </Link>
    </Panel>
  )
}

/* -------------------------------------------------------------------------- */
/*  Registry                                                                    */
/* -------------------------------------------------------------------------- */

export const WIDGETS: WidgetDef[] = [
  { type: "kpi", name: "KPI", description: "A single metric with trend and sparkline", icon: "gauge", module: "core", defaultSize: { w: 3, h: 1 }, defaultConfig: { entity: "deals", metric: "count" }, component: KpiWidget },
  { type: "trend", name: "Trend chart", description: "Cumulative total by month vs plan or the previous period", icon: "chart-line", module: "core", defaultSize: { w: 8, h: 2 }, defaultConfig: { entity: "deals" }, component: TrendWidget },
  { type: "funnel", name: "Funnel", description: "Stage-by-stage conversion", icon: "bar-chart", module: "core", defaultSize: { w: 4, h: 2 }, defaultConfig: { entity: "deals" }, component: FunnelWidget },
  { type: "records", name: "Top records", description: "Biggest open records with stage & chance", icon: "briefcase", module: "core", defaultSize: { w: 6, h: 2 }, defaultConfig: { entity: "deals", limit: 4 }, component: RecordsWidget },
  { type: "agenda", name: "Agenda", description: "Upcoming items from any dated object", icon: "calendar", module: "core", defaultSize: { w: 3, h: 2 }, defaultConfig: { entity: "tasks" }, component: AgendaWidget },
  { type: "activity", name: "Activity feed", description: "Latest events across the workspace", icon: "activity", module: "core", defaultSize: { w: 3, h: 2 }, defaultConfig: {}, component: ActivityWidget },
  { type: "leaderboard", name: "Leaderboard", description: "Owners ranked by won value", icon: "star", module: "core", defaultSize: { w: 6, h: 2 }, defaultConfig: { entity: "deals" }, component: LeaderboardWidget },
  { type: "goal", name: "Goal", description: "Progress ring towards a target", icon: "target", module: "core", defaultSize: { w: 3, h: 2 }, defaultConfig: { entity: "deals", range: "quarter" }, component: GoalWidget },
  { type: "breakdown", name: "Breakdown", description: "Donut split by any select field", icon: "pie-chart", module: "core", defaultSize: { w: 3, h: 2 }, defaultConfig: { entity: "deals" }, component: BreakdownWidget },
  { type: "stages", name: "Status summary", description: "Distribution across stages for any object", icon: "kanban", module: "core", defaultSize: { w: 4, h: 1 }, defaultConfig: { entity: "tasks" }, component: StageSummaryWidget },
  { type: "notes", name: "Notes", description: "Free text for the team", icon: "file", module: "core", defaultSize: { w: 4, h: 1 }, defaultConfig: { text: "" }, component: NotesWidget },
]

export function getWidget(type: string) {
  return WIDGETS.find((w) => w.type === type)
}

