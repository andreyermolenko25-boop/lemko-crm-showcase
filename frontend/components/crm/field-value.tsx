"use client"

import Link from "next/link"
import { Check, ExternalLink, Star } from "lucide-react"
import { cn } from "@/lib/utils"
import type { CrmRecord, EntityDef, FieldDef, RecordValue } from "@/lib/core/types"
import { formatDate, formatDateTime, formatMoney, formatNumber } from "@/lib/core/format"
import { findRecord, memberById } from "@/lib/core/data"
import { resolveLocalizedEntities } from "@/lib/core/workspace"
import { MemberAvatar, MiniProgress, Monogram, Tag } from "@/components/crm/primitives"

export function relationTitle(entityKey: string | undefined, id: unknown): string {
  if (!entityKey || !id) return ""
  const rec = findRecord(entityKey, id)
  if (!rec) return ""
  const target = resolveLocalizedEntities().find((e) => e.key === entityKey)
  return String((target && rec[target.primaryField]) ?? rec.name ?? rec.id)
}

/** Read-only rendering of any field type — used in tables, cards, boards, detail. */
export function FieldValue({ field, value, compact, className }: { field: FieldDef; value: RecordValue; compact?: boolean; className?: string }) {
  const empty = value === null || value === undefined || value === "" || (Array.isArray(value) && value.length === 0)
  if (empty && field.type !== "boolean") return <span className={cn("text-subtle-foreground", className)}>—</span>

  switch (field.type) {
    case "currency":
      return <span className={cn("font-medium tabular", className)}>{formatMoney(value, { compact })}</span>
    case "number":
      return <span className={cn("tabular", className)}>{formatNumber(value)}</span>
    case "percent":
      return (
        <span className={cn("flex min-w-0 items-center gap-2", className)}>
          <MiniProgress value={Number(value)} className="w-14" />
          <span className="text-xs font-medium tabular text-muted-foreground">{Number(value)}%</span>
        </span>
      )
    case "status":
    case "select": {
      const opt = field.options?.find((o) => o.value === value)
      return <Tag color={opt?.color} dot={field.type === "status"} className={className}>{opt?.label ?? String(value)}</Tag>
    }
    case "multiselect": {
      const vals = Array.isArray(value) ? value : [String(value)]
      return (
        <span className={cn("flex min-w-0 gap-1 overflow-hidden", className)}>
          {vals.map((v) => {
            const opt = field.options?.find((o) => o.value === v)
            return <Tag key={v} color={opt?.color}>{opt?.label ?? v}</Tag>
          })}
        </span>
      )
    }
    case "date":
      return <span className={cn("tabular", className)}>{formatDate(value, { month: "short", day: "2-digit", year: compact ? undefined : "numeric" })}</span>
    case "datetime":
      return <span className={cn("tabular", className)}>{formatDateTime(value)}</span>
    case "boolean":
      return (
        <span
          className={cn(
            "inline-flex size-4 items-center justify-center rounded border",
            value ? "border-brand bg-brand text-brand-foreground" : "border-border-strong",
            className,
          )}
        >
          {value ? <Check className="size-3" strokeWidth={3} /> : null}
        </span>
      )
    case "email":
      return <a href={`mailto:${value}`} onClick={(e) => e.stopPropagation()} className={cn("truncate hover:text-brand hover:underline", className)}>{String(value)}</a>
    case "phone":
      return <a href={`tel:${value}`} onClick={(e) => e.stopPropagation()} className={cn("truncate tabular hover:text-brand", className)}>{String(value)}</a>
    case "url":
      return (
        <a href={`https://${String(value).replace(/^https?:\/\//, "")}`} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()} className={cn("inline-flex min-w-0 items-center gap-1 truncate hover:text-brand", className)}>
          <span className="truncate">{String(value).replace(/^https?:\/\//, "")}</span>
          <ExternalLink className="size-3 shrink-0 opacity-60" />
        </a>
      )
    case "user":
      return <MemberAvatar member={memberById(value)} withName={!compact} className={className} />
    case "relation": {
      const title = relationTitle(field.relation, value)
      if (!title) return <span className="text-subtle-foreground">—</span>
      return (
        <Link
          href={`/o/${field.relation}/${value}`}
          onClick={(e) => e.stopPropagation()}
          className={cn("inline-flex min-w-0 items-center gap-1.5 rounded-md hover:text-brand", className)}
        >
          <Monogram name={title} size="xs" square />
          <span className="truncate">{title}</span>
        </Link>
      )
    }
    case "rating":
      return (
        <span className={cn("inline-flex gap-0.5", className)}>
          {Array.from({ length: 5 }, (_, i) => (
            <Star key={i} className={cn("size-3.5", i < Number(value) ? "fill-warning text-warning" : "text-foreground/15")} />
          ))}
        </span>
      )
    case "longtext":
      return <span className={cn("line-clamp-2 text-muted-foreground", className)}>{String(value)}</span>
    default:
      return <span className={cn("truncate", className)}>{String(value)}</span>
  }
}

export function RecordAvatar({ entity, record, size = "md" }: { entity: EntityDef; record: CrmRecord; size?: "sm" | "md" | "lg" | "xl" }) {
  const isPerson = entity.key === "contacts"
  return <Monogram name={record[entity.primaryField]} size={size} square={!isPerson} color={isPerson ? undefined : undefined} />
}
