"use client"

import Link from "next/link"
import { useRouter } from "next/navigation"
import { useState } from "react"
import {
  AlignLeft,
  ArrowLeft,
  AtSign,
  Calendar,
  CalendarClock,
  CircleDot,
  Eye,
  EyeOff,
  GripVertical,
  Hash,
  Link2,
  List,
  ListChecks,
  Lock,
  Percent,
  Phone,
  Plus,
  Star,
  ToggleLeft,
  Trash2,
  Type,
  User,
  Wallet,
  Globe,
  X,
} from "lucide-react"
import { toast } from "sonner"
import { cn } from "@/lib/utils"
import { COLOR_KEYS, type ColorKey, type EntityDef, type FieldDef, type FieldOption, type FieldType } from "@/lib/core/types"
import { useEntities, useEntity, useEntityAllFields, workspaceActions } from "@/lib/core/workspace"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { IconTile, Tag } from "@/components/crm/primitives"
import { SettingsRow, SettingsSection } from "@/components/settings/shared"
import { IconColorPicker } from "@/components/settings/objects"
import { useT } from "@/components/i18n-provider"
import { slugKey } from "@/lib/core/slug"

/** Field types; names and hints are in objects.fieldTypes.<type>. */
export const FIELD_TYPES: { type: FieldType; icon: typeof Type }[] = [
  { type: "text", icon: Type },
  { type: "longtext", icon: AlignLeft },
  { type: "number", icon: Hash },
  { type: "currency", icon: Wallet },
  { type: "percent", icon: Percent },
  { type: "select", icon: List },
  { type: "multiselect", icon: ListChecks },
  { type: "status", icon: CircleDot },
  { type: "date", icon: Calendar },
  { type: "datetime", icon: CalendarClock },
  { type: "boolean", icon: ToggleLeft },
  { type: "email", icon: AtSign },
  { type: "phone", icon: Phone },
  { type: "url", icon: Globe },
  { type: "user", icon: User },
  { type: "relation", icon: Link2 },
  { type: "rating", icon: Star },
]
const typeMeta = (t: FieldType) => FIELD_TYPES.find((x) => x.type === t) ?? FIELD_TYPES[0]

function OptionsEditor({ options, onChange }: { options: FieldOption[]; onChange: (o: FieldOption[]) => void }) {
  const t = useT()
  return (
    <div className="flex flex-col gap-1.5">
      {options.map((o, i) => (
        <div key={o.value} className="flex items-center gap-1.5">
          <Popover>
            <PopoverTrigger asChild>
              <button data-color={o.color} className="tag-dot size-5 shrink-0 rounded-full" aria-label={t("objects.colour")} />
            </PopoverTrigger>
            <PopoverContent className="w-auto p-2">
              <div className="grid grid-cols-5 gap-1.5">
                {COLOR_KEYS.map((c) => (
                  <button key={c} data-color={c} onClick={() => onChange(options.map((x, j) => (j === i ? { ...x, color: c } : x)))} className="tag-dot size-6 rounded-full" aria-label={t(`objects.colors.${c}`)} />
                ))}
              </div>
            </PopoverContent>
          </Popover>
          <Input className="h-8" value={o.label} onChange={(e) => onChange(options.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))} />
          <Button variant="ghost" size="icon-xs" onClick={() => onChange(options.filter((_, j) => j !== i))} aria-label={t("objects.removeOption")}>
            <X />
          </Button>
        </div>
      ))}
      <Button
        variant="ghost"
        size="xs"
        className="self-start"
        onClick={() => onChange([...options, { value: `opt_${Date.now().toString(36)}`, label: t("objects.optionN", { n: options.length + 1 }), color: COLOR_KEYS[(options.length + 1) % COLOR_KEYS.length] }])}
      >
        <Plus /> {t("objects.addOption")}
      </Button>
    </div>
  )
}

function AddFieldDialog({ entity, open, onOpenChange }: { entity: EntityDef; open: boolean; onOpenChange: (o: boolean) => void }) {
  const entities = useEntities()
  const t = useT()
  const [type, setType] = useState<FieldType | null>(null)
  const [label, setLabel] = useState("")
  const [options, setOptions] = useState<FieldOption[]>(() => [
    { value: "a", label: t("objects.optionN", { n: 1 }), color: "blue" },
    { value: "b", label: t("objects.optionN", { n: 2 }), color: "green" },
  ])
  const [relation, setRelation] = useState(entities[0]?.key ?? "")
  const reset = () => {
    setType(null)
    setLabel("")
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        onOpenChange(o)
        if (!o) reset()
      }}
    >
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{type ? t("objects.newFieldTitle", { type: t(`objects.fieldTypes.${type}.label`) }) : t("objects.addField")}</DialogTitle>
          <DialogDescription>{type ? t(`objects.fieldTypes.${type}.hint`) : t("objects.chooseType", { object: entity.label })}</DialogDescription>
        </DialogHeader>
        {!type ? (
          <div className="grid max-h-[55dvh] grid-cols-2 gap-1.5 overflow-y-auto sm:grid-cols-3">
            {FIELD_TYPES.map((ft) => (
              <button key={ft.type} onClick={() => setType(ft.type)} className="flex items-center gap-2.5 rounded-lg border p-2.5 text-left transition-colors hover:border-border-strong hover:bg-elevated">
                <span className="flex size-7 items-center justify-center rounded-md bg-muted">
                  <ft.icon className="size-3.5" />
                </span>
                <span className="min-w-0">
                  <span className="block text-sm font-medium">{t(`objects.fieldTypes.${ft.type}.label`)}</span>
                  <span className="block truncate text-xs text-muted-foreground">{t(`objects.fieldTypes.${ft.type}.hint`)}</span>
                </span>
              </button>
            ))}
          </div>
        ) : (
          <div className="flex flex-col gap-4">
            <div className="grid gap-1.5">
              <Label className="text-xs">{t("objects.fieldName")}</Label>
              <Input autoFocus value={label} onChange={(e) => setLabel(e.target.value)} placeholder={t("objects.fieldNamePlaceholder")} />
            </div>
            {(type === "select" || type === "multiselect" || type === "status") && (
              <div className="grid gap-1.5">
                <Label className="text-xs">{t("objects.options")}</Label>
                <OptionsEditor options={options} onChange={setOptions} />
              </div>
            )}
            {type === "relation" && (
              <div className="grid gap-1.5">
                <Label className="text-xs">{t("objects.linksTo")}</Label>
                <Select value={relation} onValueChange={setRelation}>
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
            )}
          </div>
        )}
        {type && (
          <DialogFooter>
            <Button variant="ghost" onClick={() => setType(null)}>
              <ArrowLeft /> {t("objects.types")}
            </Button>
            <Button
              disabled={!label.trim()}
              onClick={() => {
                const base = slugKey(label) || "field"
                const key = entity.fields.some((f) => f.key === base) ? `${base}_${Date.now().toString(36).slice(-3)}` : base
                const field: FieldDef = {
                  key,
                  label: label.trim(),
                  type,
                  ...(type === "select" || type === "multiselect" || type === "status" ? { options: options.map((o, i) => ({ ...o, value: o.value.length < 3 ? `${key}_${i}` : o.value })) } : {}),
                  ...(type === "relation" ? { relation } : {}),
                }
                workspaceActions.addField(entity.key, field)
                toast.success(t("objects.fieldAdded", { name: field.label }))
                onOpenChange(false)
                reset()
              }}
            >
              {t("objects.addField")}
            </Button>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  )
}

function FieldRow({ entity, field, dragProps, dragging }: { entity: EntityDef; field: FieldDef & { hidden?: boolean }; dragProps: React.ComponentProps<"li">; dragging: boolean }) {
  const meta = typeMeta(field.type)
  const t = useT()
  const target = useEntity(field.relation)
  const typeLabel = t(`objects.fieldTypes.${meta.type}.label`)
  const isPrimary = field.key === entity.primaryField
  const setOptions = (options: FieldOption[]) =>
    field.custom ? workspaceActions.updateCustomField(entity.key, field.key, { options }) : workspaceActions.overrideField(entity.key, field.key, { options })
  return (
    <li {...dragProps} className={cn("flex items-center gap-3 px-[var(--pad)] py-2.5 hover:bg-elevated", dragging && "opacity-50", field.hidden && "opacity-60")}>
      <GripVertical className="size-4 shrink-0 cursor-grab text-subtle-foreground" />
      <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-muted" title={typeLabel}>
        <meta.icon className="size-3.5" />
      </span>
      <Input
        defaultValue={field.label}
        onBlur={(e) => {
          const v = e.target.value.trim()
          if (!v || v === field.label) return
          if (field.custom) workspaceActions.updateCustomField(entity.key, field.key, { label: v })
          else workspaceActions.overrideField(entity.key, field.key, { label: v })
        }}
        className="h-8 max-w-56 border-transparent bg-transparent shadow-none hover:border-input focus:bg-card"
      />
      <span className="hidden text-xs text-muted-foreground sm:inline">{typeLabel}</span>
      {field.relation && <span className="hidden text-xs text-muted-foreground md:inline">→ {target?.label ?? field.relation}</span>}
      <div className="ml-auto flex items-center gap-1">
        {field.options && (
          <Popover>
            <PopoverTrigger asChild>
              <button className="hidden items-center gap-1 md:flex">
                {field.options.slice(0, 3).map((o) => (
                  <Tag key={o.value} color={o.color}>
                    {o.label}
                  </Tag>
                ))}
                {field.options.length > 3 && <span className="text-xs text-muted-foreground">+{field.options.length - 3}</span>}
              </button>
            </PopoverTrigger>
            <PopoverContent className="w-72" align="end">
              <p className="mb-2 text-xs font-semibold text-muted-foreground">{t("objects.options")}</p>
              <OptionsEditor options={field.options} onChange={setOptions} />
            </PopoverContent>
          </Popover>
        )}
        {field.system && <Lock className="mx-1 size-3.5 text-subtle-foreground" aria-label={t("objects.systemField")} />}
        {field.custom && <Tag color="violet">{t("objects.custom")}</Tag>}
        <Button
          variant="ghost"
          size="icon-sm"
          disabled={isPrimary}
          onClick={() => workspaceActions.overrideField(entity.key, field.key, { hidden: !field.hidden })}
          aria-label={field.hidden ? t("objects.showField") : t("objects.hideField")}
        >
          {field.hidden ? <EyeOff /> : <Eye />}
        </Button>
        <Button variant="ghost" size="icon-sm" disabled={!field.custom} onClick={() => workspaceActions.removeField(entity.key, field.key)} aria-label={t("objects.deleteField")} className="hover:text-destructive">
          <Trash2 />
        </Button>
      </div>
    </li>
  )
}

export function ObjectEditor({ entity }: { entity: EntityDef }) {
  const router = useRouter()
  const fields = useEntityAllFields(entity.key)
  const [adding, setAdding] = useState(false)
  const [drag, setDrag] = useState<string | null>(null)
  const t = useT()

  return (
    <div className="flex flex-col gap-[var(--gap)]">
      <Link href="/settings/objects" className="flex w-fit items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
        <ArrowLeft className="size-3.5" /> {t("objects.allObjects")}
      </Link>
      <SettingsSection title={entity.label} description={entity.description ?? t("objects.defaultDescription")}>
        <SettingsRow label={t("objects.iconColour")}>
          <Popover>
            <PopoverTrigger asChild>
              <button className="rounded-xl ring-offset-2 ring-offset-card hover:ring-2 hover:ring-border-strong">
                <IconTile icon={entity.icon} color={entity.color} size="lg" />
              </button>
            </PopoverTrigger>
            <PopoverContent className="w-80" align="end">
              <IconColorPicker
                icon={entity.icon}
                color={entity.color}
                onIcon={(icon) => workspaceActions.overrideEntity(entity.key, { icon })}
                onColor={(color: ColorKey) => workspaceActions.overrideEntity(entity.key, { color })}
              />
            </PopoverContent>
          </Popover>
        </SettingsRow>
        <SettingsRow label={t("objects.name")} hint={t("objects.nameHint")}>
          <div className="flex gap-2">
            <Input className="w-36" defaultValue={entity.label} onBlur={(e) => e.target.value.trim() && workspaceActions.overrideEntity(entity.key, { label: e.target.value.trim() })} aria-label={t("objects.plural")} />
            <Input className="w-36" defaultValue={entity.labelSingular} onBlur={(e) => e.target.value.trim() && workspaceActions.overrideEntity(entity.key, { labelSingular: e.target.value.trim() })} aria-label={t("objects.singular")} />
          </div>
        </SettingsRow>
      </SettingsSection>

      <section className="surface">
        <header className="flex items-center justify-between gap-3 border-b px-[var(--pad)] py-4">
          <div>
            <h2 className="text-base font-semibold">{t("objects.fields")}</h2>
            <p className="mt-0.5 text-sm text-muted-foreground">{t("objects.fieldsDescription")}</p>
          </div>
          <Button size="sm" onClick={() => setAdding(true)}>
            <Plus /> {t("objects.addField")}
          </Button>
        </header>
        <ul className="divide-y">
          {fields.map((f) => (
            <FieldRow
              key={f.key}
              entity={entity}
              field={f}
              dragging={drag === f.key}
              dragProps={{
                draggable: true,
                onDragStart: () => setDrag(f.key),
                onDragEnd: () => setDrag(null),
                onDragOver: (e) => {
                  e.preventDefault()
                  if (!drag || drag === f.key) return
                  const order = fields.map((x) => x.key).filter((k) => k !== drag)
                  order.splice(order.indexOf(f.key), 0, drag)
                  workspaceActions.reorderFields(entity.key, order)
                },
              }}
            />
          ))}
        </ul>
      </section>

      {entity.custom && (
        <SettingsSection title={t("objects.dangerZone")}>
          <SettingsRow label={t("objects.deleteObject")} hint={t("objects.deleteObjectHint")}>
            <Button
              variant="destructive"
              size="sm"
              onClick={() => {
                workspaceActions.deleteEntity(entity.key)
                router.push("/settings/objects")
              }}
            >
              <Trash2 /> {t("objects.deleteNamed", { name: entity.label })}
            </Button>
          </SettingsRow>
        </SettingsSection>
      )}
      <AddFieldDialog entity={entity} open={adding} onOpenChange={setAdding} />
    </div>
  )
}
