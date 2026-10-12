"use client"

import { useCallback, useMemo } from "react"
import { useI18n } from "@/components/i18n-provider"
import { formatDate, formatLocale, formatMoney } from "@/lib/core/format"
import type { Activity, EntityDef } from "@/lib/core/types"
import { useEntities } from "@/lib/core/workspace"
import type { Translator } from "@/lib/i18n/translate"

/**
 * Feed sentences in the interface language. The server stores what happened
 * (`event` + `params`: object, field and option keys, record title) next to a
 * ready English `title`; the sentence is built here from the localized schema,
 * so renamed objects and translated options read the way the workspace sees
 * them. Events written before that (no `event`) show the stored title.
 */

export type ActivityText = {
  /** What happened: "Deal created", "Stage → Won". */
  head: string
  /** Which record it was about (empty when unknown). */
  subject: string
  /** Text under the headline: generated for notifications, the member's own text for notes. */
  body?: string | null
}

type Params = Record<string, unknown>

const LOGGED_KINDS = ["note", "call", "email", "meeting", "comment"] as const

function str(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined
}

function fromTitle(a: Activity): ActivityText {
  const [head, ...rest] = a.title.split(" · ")
  return { head, subject: rest.join(" · "), body: a.body }
}

function listFormat(items: string[]): string {
  try {
    return new Intl.ListFormat(formatLocale(), { style: "long", type: "conjunction" }).format(items)
  } catch {
    return items.join(", ")
  }
}

function describe(a: Activity, entities: Map<string, EntityDef>, t: Translator["t"]): ActivityText {
  const p: Params = a.params ?? {}
  const entity = entities.get(a.entity)
  const noun = entity?.labelSingular || str(p.noun) || a.entity
  const subject = str(p.title) ?? t("common.untitled")
  const fieldLabel = (key: string | undefined, fallback: unknown) =>
    (key && entity?.fields.find((f) => f.key === key)?.label) || str(fallback) || key || ""

  switch (a.event) {
    case "record.created":
      return { head: t("activity.created", { noun }), subject, body: a.body }
    case "record.deleted":
      return { head: t("activity.deleted", { noun }), subject, body: a.body }
    case "record.stage": {
      const key = str(p.field)
      const field = key ? entity?.fields.find((f) => f.key === key) : undefined
      const option = field?.options?.find((o) => o.value === p.to)
      const value = option?.label || str(p.toLabel) || String(p.to ?? "")
      return { head: t("activity.stage", { field: fieldLabel(key, p.fieldLabel), value }), subject, body: a.body }
    }
    case "record.updated": {
      const keys = Array.isArray(p.fields) ? p.fields.map(String) : []
      const fallbacks = Array.isArray(p.fieldLabels) ? p.fieldLabels : []
      const fields = listFormat(keys.map((key, i) => fieldLabel(key, fallbacks[i])))
      return { head: t("activity.updated", { fields }), subject, body: a.body }
    }
    case "record.logged": {
      const kind = LOGGED_KINDS.find((k) => k === a.kind)
      return { head: kind ? t(`activity.logged.${kind}`) : fromTitle(a).head, subject, body: a.body }
    }
    case "record.assigned": {
      const actor = str(p.actor) ?? t("common.system")
      return {
        head: t("activity.assigned", { noun }),
        subject,
        body: t("activity.assignedBody", { actor, title: subject, noun }),
      }
    }
    case "record.mention":
      return { head: t("activity.mentioned", { actor: str(p.actor) ?? t("common.system") }), subject, body: a.body }
    case "record.reminder": {
      const at = str(p.at)
      // The 12/24-hour choice comes from the member's region, see formatDate.
      const short = formatDate(at, { weekday: "short", hour: "numeric", minute: "2-digit" })
      const long = formatDate(at, { weekday: "long", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" })
      return { head: t("activity.due", { when: short }), subject, body: t("activity.dueBody", { noun, when: long }) }
    }
    case "digest": {
      const lines = Array.isArray(p.lines) ? (p.lines as Params[]) : []
      const body = [
        t("activity.digestIntro", { company: str(p.company) ?? "" }),
        ...lines.map((line) => {
          const label = entities.get(String(line.entity))?.label || str(line.label) || String(line.entity ?? "")
          const parts = [t("activity.digestCreated", { count: Number(line.created ?? 0) })]
          if (line.won) {
            parts.push(
              line.wonTotal != null
                ? t("activity.digestWonAmount", { count: Number(line.won), amount: formatMoney(line.wonTotal) })
                : t("activity.digestWon", { count: Number(line.won) }),
            )
          }
          if (line.mine) parts.push(t("activity.digestMine", { count: Number(line.mine) }))
          return `• ${label}: ${parts.join(", ")}`
        }),
      ].join("\n")
      return { head: t("activity.digest"), subject: "", body }
    }
    default:
      return fromTitle(a)
  }
}

/** (activity) → its headline, record and body in the interface language. */
export function useActivityText(): (a: Activity) => ActivityText {
  const entities = useEntities()
  const { t } = useI18n()
  const byKey = useMemo(() => new Map(entities.map((e) => [e.key, e])), [entities])
  return useCallback((a: Activity) => (a.event ? describe(a, byKey, t) : fromTitle(a)), [byKey, t])
}

/** "Deal created · Acme" — headline and record on one line. */
export function joinActivityText({ head, subject }: ActivityText): string {
  return subject ? `${head} · ${subject}` : head
}
