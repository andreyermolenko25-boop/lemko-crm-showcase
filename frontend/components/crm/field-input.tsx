"use client"

import { useMemo, useState, type ReactNode } from "react"
import { Check, ChevronsUpDown, Star, X } from "lucide-react"
import { cn } from "@/lib/utils"
import type { FieldDef, RecordValue } from "@/lib/core/types"
import { useMembers, useRecords } from "@/lib/core/data"
import { useEntity } from "@/lib/core/workspace"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Switch } from "@/components/ui/switch"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command"
import { MemberAvatar, Monogram, Tag } from "@/components/crm/primitives"
import { relationTitle } from "@/components/crm/field-value"
import { useT } from "@/components/i18n-provider"
import { nounInSentence } from "@/lib/i18n/text"

type PickerOption = { value: string; label: string; render?: ReactNode; keywords?: string }

export function OptionPicker({
  value,
  options,
  onChange,
  multiple,
  placeholder,
  renderValue,
  className,
}: {
  value: string | string[] | null | undefined
  options: PickerOption[]
  onChange: (v: string | string[] | null) => void
  multiple?: boolean
  placeholder?: string
  renderValue?: (v: string) => ReactNode
  className?: string
}) {
  const [open, setOpen] = useState(false)
  const t = useT()
  const selected = useMemo(() => (Array.isArray(value) ? value : value ? [value] : []), [value])
  const byValue = useMemo(() => new Map(options.map((o) => [o.value, o])), [options])

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={cn(
            "flex min-h-[var(--control-h)] w-full items-center gap-2 rounded-lg border border-input bg-card px-2.5 py-1 text-left text-sm transition-colors hover:border-border-strong",
            className,
          )}
        >
          <span className="flex min-w-0 flex-1 flex-wrap items-center gap-1">
            {selected.length === 0 && <span className="text-muted-foreground">{placeholder ?? t("fields.select")}</span>}
            {selected.map((v) => (
              <span key={v} className="min-w-0">
                {renderValue ? renderValue(v) : (byValue.get(v)?.render ?? byValue.get(v)?.label ?? v)}
              </span>
            ))}
          </span>
          {selected.length > 0 && !multiple ? (
            <X
              className="size-3.5 shrink-0 text-muted-foreground hover:text-foreground"
              onClick={(e) => {
                e.stopPropagation()
                onChange(null)
              }}
            />
          ) : (
            <ChevronsUpDown className="size-3.5 shrink-0 text-muted-foreground" />
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-[var(--radix-popover-trigger-width)] min-w-56 p-0" align="start">
        <Command>
          <CommandInput placeholder={t("fields.search")} />
          <CommandList className="max-h-64">
            <CommandEmpty>{t("fields.nothingFound")}</CommandEmpty>
            <CommandGroup>
              {options.map((o) => {
                const isSel = selected.includes(o.value)
                return (
                  <CommandItem
                    key={o.value}
                    value={`${o.label} ${o.keywords ?? ""} ${o.value}`}
                    onSelect={() => {
                      if (multiple) {
                        onChange(isSel ? selected.filter((s) => s !== o.value) : [...selected, o.value])
                      } else {
                        onChange(o.value)
                        setOpen(false)
                      }
                    }}
                  >
                    <span className="min-w-0 flex-1 truncate">{o.render ?? o.label}</span>
                    <Check className={cn("size-3.5", isSel ? "opacity-100" : "opacity-0")} />
                  </CommandItem>
                )
              })}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}

function UserPicker({ value, onChange }: { value: RecordValue; onChange: (v: RecordValue) => void }) {
  const members = useMembers()
  const t = useT()
  return (
    <OptionPicker
      value={value as string}
      onChange={(v) => onChange(v as string | null)}
      placeholder={t("fields.assign")}
      // Deactivated people keep their old assignments but can't get new ones.
      options={members
        .filter((m) => m.status !== "disabled" || m.id === value)
        .map((m) => ({ value: m.id, label: m.name, keywords: m.email, render: <MemberAvatar member={m} withName size="xs" /> }))}
    />
  )
}

function RelationPicker({ field, value, onChange }: { field: FieldDef; value: RecordValue; onChange: (v: RecordValue) => void }) {
  const target = useEntity(field.relation)
  const records = useRecords(field.relation)
  const t = useT()
  const options = useMemo(
    () =>
      records.slice(0, 300).map((r) => {
        const title = String((target && r[target.primaryField]) ?? r.id)
        return {
          value: r.id,
          label: title,
          render: (
            <span className="flex items-center gap-2">
              <Monogram name={title} size="xs" square />
              <span className="truncate">{title}</span>
            </span>
          ),
        }
      }),
    [records, target],
  )
  return (
    <OptionPicker
      value={value as string}
      onChange={(v) => onChange(v as string | null)}
      placeholder={target ? t("fields.linkNamed", { name: nounInSentence(target.labelSingular) }) : t("fields.link")}
      options={options}
      renderValue={(v) => (
        <span className="flex items-center gap-2">
          <Monogram name={relationTitle(field.relation, v)} size="xs" square />
          <span className="truncate">{relationTitle(field.relation, v)}</span>
        </span>
      )}
    />
  )
}

function toLocalInput(value: RecordValue, withTime: boolean) {
  if (!value) return ""
  const d = new Date(String(value))
  if (Number.isNaN(d.getTime())) return ""
  const pad = (n: number) => String(n).padStart(2, "0")
  const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
  return withTime ? `${date}T${pad(d.getHours())}:${pad(d.getMinutes())}` : date
}

/** Editable control for any field type. */
export function FieldInput({
  field,
  value,
  onChange,
  autoFocus,
}: {
  field: FieldDef
  value: RecordValue
  onChange: (v: RecordValue) => void
  autoFocus?: boolean
}) {
  const t = useT()
  switch (field.type) {
    case "longtext":
      return <Textarea autoFocus={autoFocus} value={String(value ?? "")} onChange={(e) => onChange(e.target.value)} rows={3} placeholder={t("fields.addDetails")} />
    case "number":
    case "currency":
    case "percent":
      return (
        <Input
          autoFocus={autoFocus}
          type="number"
          inputMode="decimal"
          value={value === null || value === undefined ? "" : String(value)}
          onChange={(e) => onChange(e.target.value === "" ? null : Number(e.target.value))}
          className="tabular"
        />
      )
    case "date":
    case "datetime":
      return (
        <Input
          autoFocus={autoFocus}
          type={field.type === "date" ? "date" : "datetime-local"}
          value={toLocalInput(value, field.type === "datetime")}
          onChange={(e) => onChange(e.target.value ? new Date(e.target.value).toISOString() : null)}
        />
      )
    case "boolean":
      return <Switch checked={Boolean(value)} onCheckedChange={(v) => onChange(v)} />
    case "select":
    case "status":
    case "multiselect":
      return (
        <OptionPicker
          multiple={field.type === "multiselect"}
          value={value as string | string[]}
          onChange={(v) => onChange(v)}
          options={(field.options ?? []).map((o) => ({ value: o.value, label: o.label, render: <Tag color={o.color} dot={field.type === "status"}>{o.label}</Tag> }))}
        />
      )
    case "user":
      return <UserPicker value={value} onChange={onChange} />
    case "relation":
      return <RelationPicker field={field} value={value} onChange={onChange} />
    case "rating":
      return (
        <div className="flex h-[var(--control-h)] items-center gap-1">
          {Array.from({ length: 5 }, (_, i) => (
            <button key={i} type="button" onClick={() => onChange(i + 1 === Number(value) ? 0 : i + 1)} aria-label={t("fields.stars", { count: i + 1 })}>
              <Star className={cn("size-4.5 transition-colors", i < Number(value) ? "fill-warning text-warning" : "text-foreground/20 hover:text-foreground/40")} />
            </button>
          ))}
        </div>
      )
    default:
      return (
        <Input
          autoFocus={autoFocus}
          type={field.type === "email" ? "email" : field.type === "phone" ? "tel" : "text"}
          value={String(value ?? "")}
          onChange={(e) => onChange(e.target.value)}
          placeholder={field.type === "url" ? t("fields.urlPlaceholder") : undefined}
        />
      )
  }
}
