"use client"

import { useEffect, useMemo, useState } from "react"
import { analyticsApi } from "@/lib/core/backend"
import { useData } from "@/lib/core/data"
import { useUi } from "@/lib/core/ui"

/**
 * Widget and report numbers come from the server (stats.py). Requests made in
 * the same tick are batched into one POST per dashboard; results refresh when
 * the period changes or any record changes.
 */

type Pending = {
  id: string
  type: string
  config: Record<string, unknown>
  resolve: (data: unknown) => void
  reject: (err: Error) => void
}

const queues = new Map<string, Pending[]>()
let seq = 0

function flush(periodKey: string) {
  const items = queues.get(periodKey) ?? []
  queues.delete(periodKey)
  const [year, month] = periodKey.split("-").map(Number)
  analyticsApi
    .widgets(
      { year, month },
      items.map(({ id, type, config }) => ({ id, type, config })),
    )
    .then(
      ({ results }) => {
        for (const item of items) {
          const result = results[item.id]
          if (result?.data) item.resolve(result.data)
          else item.reject(new Error(result?.error?.message ?? "No data"))
        }
      },
      (err) => items.forEach((item) => item.reject(err instanceof Error ? err : new Error(String(err)))),
    )
}

function requestWidget(type: string, config: Record<string, unknown>, year: number, month: number): Promise<unknown> {
  const periodKey = `${year}-${month}`
  return new Promise((resolve, reject) => {
    const queue = queues.get(periodKey) ?? []
    if (!queue.length) setTimeout(() => flush(periodKey), 25)
    queue.push({ id: `w${++seq}`, type, config, resolve, reject })
    queues.set(periodKey, queue)
  })
}

export type Loadable<T> = { data: T | undefined; error: string | null; loading: boolean }

/** Server-computed data of one dashboard widget for the selected period. */
export function useWidgetData<T>(type: string, config: Record<string, unknown>): Loadable<T> {
  const period = useUi((s) => s.period)
  const records = useData((s) => s.records)
  const configKey = JSON.stringify(config)
  const key = `${type}|${configKey}|${period.year}-${period.month}`
  const [state, setState] = useState<{ key: string; data?: T; error: string | null }>({ key: "", error: null })

  useEffect(() => {
    let alive = true
    // ui.period.month is 0-based (Date#getMonth); the API takes 1–12.
    requestWidget(type, JSON.parse(configKey), period.year, period.month + 1).then(
      (data) => alive && setState({ key, data: data as T, error: null }),
      (err: Error) => alive && setState((s) => ({ key, data: s.data, error: err.message })),
    )
    return () => {
      alive = false
    }
  }, [key, type, configKey, period, records])

  return { data: state.data, error: state.error, loading: state.key !== key }
}

export type ReportRow = { key: string | null; value: number }

/** Grouped report rows (count / sum / avg by a field), computed on the server. */
export function useReportRows(q: { entity: string; groupBy: string; metric: string; metricField?: string | null }): Loadable<ReportRow[]> {
  const records = useData((s) => s.records)
  const query = useMemo(() => ({ entity: q.entity, groupBy: q.groupBy, metric: q.metric, metricField: q.metricField ?? null }), [q.entity, q.groupBy, q.metric, q.metricField])
  const key = JSON.stringify(query)
  const [state, setState] = useState<{ key: string; data?: ReportRow[]; error: string | null }>({ key: "", error: null })

  useEffect(() => {
    if (!query.groupBy) return
    let alive = true
    const timer = setTimeout(() => {
      analyticsApi.report(query).then(
        ({ rows }) => alive && setState({ key, data: rows, error: null }),
        (err: Error) => alive && setState({ key, data: undefined, error: err.message }),
      )
    }, 150)
    return () => {
      alive = false
      clearTimeout(timer)
    }
  }, [key, query, records])

  return { data: state.data, error: state.error, loading: state.key !== key }
}
