"use client"

import Link from "next/link"
import { useEffect, useMemo, useRef, useState } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { Check, Copy, ExternalLink, Mail, MoreHorizontal, Phone, Plus, Trash2 } from "lucide-react"
import { cn } from "@/lib/utils"
import type { Activity, ActivityKind, CrmRecord, EntityDef, FieldDef, RecordValue } from "@/lib/core/types"
import { activitiesApi } from "@/lib/core/backend"
import { dataActions, memberById, useData } from "@/lib/core/data"
import { useEntities } from "@/lib/core/workspace"
import { timeAgo, formatDateTime } from "@/lib/core/format"
import { ui } from "@/lib/core/ui"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { FieldInput } from "@/components/crm/field-input"
import { FieldValue, RecordAvatar } from "@/components/crm/field-value"
import { ActivityIcon } from "@/components/crm/activity-icon"
import { EmptyState, IconTile, MemberAvatar, Panel, SectionLabel } from "@/components/crm/primitives"
import { FavoriteToggle } from "@/components/shell/sidebar"
import { useT } from "@/components/i18n-provider"
import { joinActivityText, useActivityText } from "@/lib/core/activity-text"

const INSTANT = new Set(["select", "status", "multiselect", "user", "relation", "boolean", "rating"])

/** Click-to-edit field row. Pickers commit instantly, text commits on blur / Enter. */
export function InlineField({ entity, record, field, layout = "row" }: { entity: EntityDef; record: CrmRecord; field: FieldDef; layout?: "row" | "stack" }) {
  const [editing, setEditing] = useState(false)
  if (field.readOnly) {
    return (
      <div className={cn("grid items-center gap-x-3 gap-y-1", layout === "row" ? "grid-cols-[8.5rem_1fr]" : "grid-cols-1")}>
        <span className="truncate text-xs text-muted-foreground" title={field.description}>{field.label}</span>
        <span className="flex min-h-8 min-w-0 items-center text-sm">
          <FieldValue field={field} value={record[field.key]} />
        </span>
      </div>
    )
  }
  return <EditableField entity={entity} record={record} field={field} layout={layout} editing={editing} setEditing={setEditing} />
}

function EditableField({
  entity,
  record,
  field,
  layout,
  editing,
  setEditing,
}: {
  entity: EntityDef
  record: CrmRecord
  field: FieldDef
  layout: "row" | "stack"
  editing: boolean
  setEditing: (v: boolean) => void
}) {
  const [draft, setDraft] = useState<RecordValue>(record[field.key])
  const wrap = useRef<HTMLDivElement>(null)
  const t = useT()

  const commit = (v: RecordValue) => {
    if (v !== record[field.key]) dataActions.update(entity, record.id, { [field.key]: v })
  }

  return (
    <div className={cn("group/field grid items-center gap-x-3 gap-y-1", layout === "row" ? "grid-cols-[8.5rem_1fr]" : "grid-cols-1")}>
      <span className="truncate text-xs text-muted-foreground">{field.label}</span>
      {editing ? (
        <div
          ref={wrap}
          onBlur={(e) => {
            if (INSTANT.has(field.type)) return
            if (wrap.current?.contains(e.relatedTarget as Node)) return
            commit(draft)
            setEditing(false)
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && field.type !== "longtext") {
              commit(draft)
              setEditing(false)
            }
            if (e.key === "Escape") setEditing(false)
          }}
        >
          <FieldInput
            field={field}
            value={draft}
            autoFocus
            onChange={(v) => {
              setDraft(v)
              if (INSTANT.has(field.type)) {
                commit(v)
                if (field.type !== "multiselect") setEditing(false)
              }
            }}
          />
          {INSTANT.has(field.type) && (
            <button className="mt-1 text-xs text-muted-foreground hover:text-foreground" onClick={() => setEditing(false)}>
              {t("common.done")}
            </button>
          )}
        </div>
      ) : (
        <button
          onClick={() => {
            if (field.type === "boolean") return commit(!record[field.key])
            setDraft(record[field.key])
            setEditing(true)
          }}
          className="-mx-2 flex min-h-8 min-w-0 items-center rounded-md px-2 text-left text-sm transition-colors hover:bg-accent"
        >
          <FieldValue field={field} value={record[field.key]} />
        </button>
      )}
    </div>
  )
}

export function StageStepper({ entity, record }: { entity: EntityDef; record: CrmRecord }) {
  const field = entity.fields.find((f) => f.key === entity.stageField)
  if (!field?.options) return null
  const current = field.options.findIndex((o) => o.value === record[field.key])
  const locked = Boolean(field.readOnly)
  return (
    // Wraps into rows in narrow spaces (the peek drawer) instead of hiding stages behind a scroll.
    <div className="grid w-full grid-cols-[repeat(auto-fit,minmax(8rem,1fr))] gap-1">
      {field.options.map((o, i) => {
        const done = i < current
        const active = i === current
        return (
          <button
            key={o.value}
            disabled={locked}
            title={o.label}
            onClick={() => dataActions.update(entity, record.id, { [field.key]: o.value })}
            className={cn(
              "flex h-8 min-w-0 items-center justify-center gap-1.5 rounded-lg border px-3 text-xs font-medium transition-colors",
              active && "border-transparent bg-primary text-primary-foreground",
              done && "border-border bg-elevated text-foreground",
              !active && !done && "border-dashed text-muted-foreground hover:border-border-strong hover:text-foreground",
            )}
          >
            {done && <Check className="size-3 shrink-0" />}
            <span className="truncate">{o.label}</span>
          </button>
        )
      })}
    </div>
  )
}

function Composer({ entity, record, onSaved }: { entity: EntityDef; record: CrmRecord; onSaved: () => void }) {
  const [kind, setKind] = useState<ActivityKind>("note")
  const [text, setText] = useState("")
  const [saving, setSaving] = useState(false)
  const t = useT()
  const save = async () => {
    if (!text.trim() || saving) return
    setSaving(true)
    const saved = await dataActions.addNote(entity, record.id, text.trim(), kind)
    setSaving(false)
    if (saved) {
      setText("")
      onSaved()
    }
  }
  const kinds: { k: ActivityKind; label: string }[] = [
    { k: "note", label: t("record.note") },
    { k: "call", label: t("record.logCall") },
    { k: "email", label: t("record.email") },
    { k: "meeting", label: t("record.meeting") },
  ]
  return (
    <div className="rounded-xl border bg-card">
      <div className="flex gap-1 border-b p-1.5">
        {kinds.map((x) => (
          <button
            key={x.k}
            onClick={() => setKind(x.k)}
            className={cn("h-7 rounded-md px-2.5 text-xs font-medium transition-colors", kind === x.k ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground")}
          >
            {x.label}
          </button>
        ))}
      </div>
      <Textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={kind === "call" || kind === "email" || kind === "meeting" ? t(`record.describe.${kind}`) : t("record.notePlaceholder")}
        className="min-h-20 resize-none rounded-none border-0 bg-transparent shadow-none focus-visible:ring-0"
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void save()
        }}
      />
      <div className="flex items-center justify-between p-2 pt-0">
        <span className="pl-1 text-xs text-subtle-foreground">{t("record.saveHint")}</span>
        <Button size="sm" disabled={!text.trim() || saving} onClick={() => void save()}>
          {t("common.save")}
        </Button>
      </div>
    </div>
  )
}

/** The record's own history from the server (the global feed only keeps the latest events). */
function useRecordActivities(entity: string, recordId: string, limit: number) {
  const feed = useData((s) => s.activities)
  const [items, setItems] = useState<Activity[]>([])
  const [version, setVersion] = useState(0)
  useEffect(() => {
    let alive = true
    activitiesApi.list({ entity, recordId, limit }).then(
      (page) => alive && setItems(page.items),
      () => undefined,
    )
    return () => {
      alive = false
    }
  }, [entity, recordId, limit, feed, version])
  return { items, reload: () => setVersion((v) => v + 1) }
}

export function Timeline({ entity, record, limit }: { entity: EntityDef; record: CrmRecord; limit?: number }) {
  const { items, reload } = useRecordActivities(entity.key, record.id, limit ?? 100)
  const t = useT()
  const describe = useActivityText()
  return (
    <div className="flex flex-col gap-4">
      <Composer entity={entity} record={record} onSaved={reload} />
      {items.length === 0 ? (
        <p className="py-6 text-center text-xs text-muted-foreground">{t("record.noActivity")}</p>
      ) : (
        <ol className="relative flex flex-col gap-4 before:absolute before:bottom-2 before:left-4 before:top-2 before:w-px before:bg-border">
          {items.map((a) => {
            const text = describe(a)
            return (
              <li key={a.id} className="relative flex gap-3">
                <ActivityIcon kind={a.kind} className="z-10" />
                <div className="min-w-0 flex-1 pt-1">
                  <p className="text-sm">
                    <span className="font-medium">{memberById(a.actor)?.name ?? t("common.system")}</span>{" "}
                    <span className="text-muted-foreground">· {joinActivityText(text)}</span>
                  </p>
                  {text.body && <p className="mt-1.5 whitespace-pre-line rounded-lg border bg-elevated p-3 text-sm leading-relaxed">{text.body}</p>}
                  <p className="mt-1 text-xs text-subtle-foreground" title={formatDateTime(a.at)}>
                    {timeAgo(a.at)}
                  </p>
                </div>
              </li>
            )
          })}
          {/* Records that existed before the feed (imports) have no "created" event of their own. */}
          {!items.some((a) => a.kind === "created") && (
            <li className="relative flex gap-3">
              <ActivityIcon kind="created" className="z-10" />
              <p className="pt-2 text-sm text-muted-foreground">{t("record.recordCreated", { ago: timeAgo(record.createdAt) })}</p>
            </li>
          )}
        </ol>
      )}
    </div>
  )
}

function Related({ entity, record }: { entity: EntityDef; record: CrmRecord }) {
  const entities = useEntities()
  const all = useData((s) => s.records)
  const t = useT()
  const groups = useMemo(
    () =>
      entities
        .flatMap((e) =>
          e.fields
            .filter((f) => f.type === "relation" && f.relation === entity.key)
            .map((f) => ({ e, f, rows: (all[e.key] ?? []).filter((r) => r[f.key] === record.id) })),
        )
        .filter((g) => g.rows.length > 0),
    [entities, all, entity.key, record.id],
  )
  if (!groups.length) return <EmptyState icon="workflow" title={t("record.noRelated")} description={t("record.noRelatedHint")} />
  return (
    <div className="flex flex-col gap-4">
      {groups.map(({ e, f, rows }) => (
        <div key={`${e.key}-${f.key}`} className="rounded-xl border">
          <div className="flex items-center justify-between border-b px-3.5 py-2.5">
            <div className="flex items-center gap-2">
              <IconTile icon={e.icon} color={e.color} size="sm" />
              <span className="text-sm font-semibold">{e.label}</span>
              <span className="text-xs text-muted-foreground">{t("record.via", { field: f.label, count: rows.length })}</span>
            </div>
            <Button variant="ghost" size="xs" onClick={() => ui.openCreate(e.key, { [f.key]: record.id })}>
              <Plus /> {t("common.add")}
            </Button>
          </div>
          <ul className="divide-y">
            {rows.slice(0, 8).map((r) => {
              const extra = e.fields.find((x) => x.key === (e.amountField ?? e.stageField))
              const stage = e.fields.find((x) => x.key === e.stageField)
              return (
                <li key={r.id}>
                  <button onClick={() => ui.peek(e.key, r.id)} className="flex w-full items-center gap-3 px-3.5 py-2.5 text-left hover:bg-accent/50">
                    <span className="min-w-0 flex-1 truncate text-sm font-medium">{String(r[e.primaryField] ?? "")}</span>
                    {extra && extra !== stage && <FieldValue field={extra} value={r[extra.key]} compact className="text-xs" />}
                    {stage && <FieldValue field={stage} value={r[stage.key]} />}
                  </button>
                </li>
              )
            })}
          </ul>
        </div>
      ))}
    </div>
  )
}

export function RecordActions({ entity, record, onDeleted }: { entity: EntityDef; record: CrmRecord; onDeleted?: () => void }) {
  const t = useT()
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="icon-sm" aria-label={t("record.moreActions")}>
          <MoreHorizontal />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-48">
        <DropdownMenuItem
          onSelect={() => {
            navigator.clipboard?.writeText(`${window.location.origin}/o/${entity.key}/${record.id}`)
            toast(t("record.linkCopied"))
          }}
        >
          <Copy /> {t("record.copyLink")}
        </DropdownMenuItem>
        <DropdownMenuItem
          onSelect={async () => {
            const values = Object.fromEntries(entity.fields.filter((f) => !f.readOnly).map((f) => [f.key, record[f.key]]))
            const copy = await dataActions.create(entity, { ...values, [entity.primaryField]: `${record[entity.primaryField]} ${t("record.copySuffix")}` })
            if (copy) toast.success(t("record.duplicated"))
          }}
        >
          <Plus /> {t("common.duplicate")}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          variant="destructive"
          onSelect={() => {
            dataActions.remove(entity, [record.id])
            toast(t("record.deleted", { name: entity.labelSingular }))
            onDeleted?.()
          }}
        >
          <Trash2 /> {t("common.delete")}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

export function RecordHeader({ entity, record, compact }: { entity: EntityDef; record: CrmRecord; compact?: boolean }) {
  const secondary = entity.fields.find((f) => f.key === entity.secondaryField)
  const owner = entity.ownerField ? memberById(record[entity.ownerField]) : undefined
  const amount = entity.fields.find((f) => f.key === entity.amountField)
  const t = useT()
  return (
    <div className="flex min-w-0 items-start gap-3.5">
      <RecordAvatar entity={entity} record={record} size={compact ? "lg" : "xl"} />
      <div className="min-w-0 flex-1">
        <h1 className={cn("truncate font-semibold tracking-tight", compact ? "text-lg" : "text-2xl")}>{String(record[entity.primaryField] ?? t("common.untitled"))}</h1>
        <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted-foreground">
          <span className="inline-flex items-center gap-1.5">
            <IconTile icon={entity.icon} color={entity.color} size="sm" className="size-5 [&_svg]:size-3" />
            {entity.labelSingular}
          </span>
          {secondary && record[secondary.key] ? <FieldValue field={secondary} value={record[secondary.key]} /> : null}
          {amount && record[amount.key] ? <FieldValue field={amount} value={record[amount.key]} className="text-foreground" /> : null}
          {owner && <MemberAvatar member={owner} withName size="xs" />}
        </div>
      </div>
    </div>
  )
}

/** Full record workspace: header, stage, activity / related tabs, details panel. */
export function RecordDetail({ entity, record }: { entity: EntityDef; record: CrmRecord }) {
  const router = useRouter()
  const email = record.email as string | undefined
  const phone = record.phone as string | undefined
  const t = useT()
  return (
    <div className="flex flex-col gap-[var(--gap)]">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <RecordHeader entity={entity} record={record} />
        <div className="flex items-center gap-2">
          <FavoriteToggle fav={{ id: `rec:${record.id}`, label: String(record[entity.primaryField]), href: `/o/${entity.key}/${record.id}`, icon: entity.icon }} />
          {email && (
            <Button variant="outline" size="sm" asChild>
              <a href={`mailto:${email}`}>
                <Mail /> {t("record.email")}
              </a>
            </Button>
          )}
          {phone && (
            <Button variant="outline" size="sm" asChild>
              <a href={`tel:${phone}`}>
                <Phone /> {t("record.call")}
              </a>
            </Button>
          )}
          <RecordActions entity={entity} record={record} onDeleted={() => router.push(`/o/${entity.key}`)} />
        </div>
      </div>
      {entity.stageField && <StageStepper entity={entity} record={record} />}
      <div className="grid gap-[var(--gap)] xl:grid-cols-[1fr_24rem]">
        <Panel className="order-2 xl:order-1" bodyClassName="pt-1">
          <Tabs defaultValue="activity" className="gap-4">
            <TabsList className="h-9">
              <TabsTrigger value="activity" className="px-3">{t("record.activity")}</TabsTrigger>
              <TabsTrigger value="related" className="px-3">{t("record.related")}</TabsTrigger>
              <TabsTrigger value="fields" className="px-3 xl:hidden">{t("record.details")}</TabsTrigger>
            </TabsList>
            <TabsContent value="activity">
              <Timeline entity={entity} record={record} />
            </TabsContent>
            <TabsContent value="related">
              <Related entity={entity} record={record} />
            </TabsContent>
            <TabsContent value="fields" className="xl:hidden">
              <div className="flex flex-col gap-1">
                {entity.fields.map((f) => (
                  <InlineField key={f.key} entity={entity} record={record} field={f} />
                ))}
              </div>
            </TabsContent>
          </Tabs>
        </Panel>
        <Panel title={t("record.details")} subtitle={t("record.clickToEdit")} className="order-1 h-fit xl:order-2 max-xl:hidden">
          <div className="flex flex-col gap-1">
            {entity.fields.map((f) => (
              <InlineField key={f.key} entity={entity} record={record} field={f} />
            ))}
          </div>
          <div className="mt-4 border-t pt-3">
            <SectionLabel>{t("record.system")}</SectionLabel>
            <dl className="mt-2 grid grid-cols-[8.5rem_1fr] gap-y-1.5 text-xs">
              <dt className="text-muted-foreground">{t("record.created")}</dt>
              <dd>{formatDateTime(record.createdAt)}</dd>
              <dt className="text-muted-foreground">{t("record.updated")}</dt>
              <dd>{timeAgo(record.updatedAt)}</dd>
              <dt className="text-muted-foreground">{t("record.id")}</dt>
              <dd className="truncate font-mono text-xs">{record.id}</dd>
            </dl>
          </div>
        </Panel>
      </div>
    </div>
  )
}

export function OpenFullPage({ href }: { href: string }) {
  const t = useT()
  return (
    <Button variant="outline" size="sm" asChild>
      <Link href={href}>
        <ExternalLink /> {t("common.open")}
      </Link>
    </Button>
  )
}
