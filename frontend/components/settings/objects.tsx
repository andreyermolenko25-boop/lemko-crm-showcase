"use client"

import Link from "next/link"
import { useState } from "react"
import { useRouter } from "next/navigation"
import { motion } from "motion/react"
import { ChevronRight, Plus, Search } from "lucide-react"
import { cn } from "@/lib/utils"
import { COLOR_KEYS, type ColorKey } from "@/lib/core/types"
import { ICON_NAMES, Icon } from "@/lib/core/icons"
import { useData } from "@/lib/core/data"
import { useEntities, workspaceActions } from "@/lib/core/workspace"
import { useModuleName } from "@/lib/core/schema-i18n"
import { slugKey } from "@/lib/core/slug"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { IconTile, Tag } from "@/components/crm/primitives"
import { SettingsSection } from "@/components/settings/shared"
import { useT } from "@/components/i18n-provider"

export function IconColorPicker({ icon, color, onIcon, onColor }: { icon: string; color: ColorKey; onIcon: (i: string) => void; onColor: (c: ColorKey) => void }) {
  const t = useT()
  const [query, setQuery] = useState("")
  const names = ICON_NAMES.filter((n) => n.includes(query.trim().toLowerCase()))
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap gap-2">
        {COLOR_KEYS.map((c) => (
          <button key={c} type="button" onClick={() => onColor(c)} aria-label={t(`objects.colors.${c}`)} aria-pressed={color === c} className="relative flex size-7 items-center justify-center">
            {color === c && <motion.span layoutId="color-ring" className="absolute inset-0 rounded-full ring-2 ring-foreground/50" transition={{ type: "spring", stiffness: 520, damping: 36 }} />}
            <span data-color={c} className={cn("tag-dot size-5 rounded-full transition-transform", color === c ? "scale-90" : "hover:scale-110")} />
          </button>
        ))}
      </div>
      <div className="rounded-xl border bg-card">
        <div className="flex h-9 items-center gap-2 border-b px-2.5">
          <Search className="size-3.5 text-muted-foreground" />
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t("objects.searchIcons")} className="w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground/70" />
        </div>
        <div className="grid max-h-40 grid-cols-[repeat(auto-fill,minmax(2.25rem,1fr))] gap-1 overflow-y-auto p-1.5">
          {names.map((n) => (
            <button
              key={n}
              type="button"
              onClick={() => onIcon(n)}
              title={n}
              data-color={icon === n ? color : undefined}
              className={cn("relative flex h-9 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-accent hover:text-foreground", icon === n && "text-foreground")}
            >
              {icon === n && <motion.span layoutId="icon-pick" data-color={color} className="icon-tile absolute inset-0 rounded-lg" transition={{ type: "spring", stiffness: 520, damping: 36 }} />}
              <Icon name={n} className={cn("relative size-4", icon === n && "icon-pick-on")} />
            </button>
          ))}
          {names.length === 0 && <p className="col-span-full py-4 text-center text-xs text-muted-foreground">{t("objects.noIcons")}</p>}
        </div>
      </div>
    </div>
  )
}

type Template = { key: "services" | "vehicles" | "patients" | "courses" | "properties" | "projects"; icon: string; color: ColorKey }

const TEMPLATES: Template[] = [
  { key: "services", icon: "sparkles", color: "teal" },
  { key: "vehicles", icon: "car", color: "blue" },
  { key: "patients", icon: "stethoscope", color: "green" },
  { key: "courses", icon: "graduation", color: "violet" },
  { key: "properties", icon: "home", color: "amber" },
  { key: "projects", icon: "kanban", color: "indigo" },
]

const DEFAULT_COLUMNS = [
  { key: "name", icon: "file" },
  { key: "status", icon: "circle" },
  { key: "owner", icon: "user" },
] as const

/* Live preview: how the new table shows up in the sidebar and as a table. */
function ObjectPreview({ label, icon, color }: { label: string; icon: string; color: ColorKey }) {
  const t = useT()
  const name = label.trim() || t("objects.yourTable")
  return (
    <div className="flex h-full flex-col gap-4 p-5">
      <p className="text-2xs font-semibold uppercase tracking-[0.14em] text-subtle-foreground">{t("objects.previewTitle")}</p>
      <div className="rounded-xl border bg-sidebar p-1.5">
        <div className="flex items-center gap-2.5 rounded-lg bg-accent px-2 py-1.5 text-sm font-medium">
          <motion.span key={`${icon}-${color}`} initial={{ scale: 0.6, rotate: -12 }} animate={{ scale: 1, rotate: 0 }} transition={{ type: "spring", stiffness: 420, damping: 18 }}>
            <IconTile icon={icon} color={color} size="sm" />
          </motion.span>
          <span className="truncate">{name}</span>
        </div>
        <div className="flex items-center gap-2.5 px-2 py-1.5 text-sm text-muted-foreground">
          <span className="size-6 rounded-md bg-foreground/5" />
          <span className="h-2 w-16 rounded-full bg-foreground/8" />
        </div>
      </div>
      <div className="overflow-hidden rounded-xl border bg-card">
        <div className="flex items-center gap-2.5 border-b px-3 py-2.5">
          <IconTile icon={icon} color={color} />
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold">{name}</p>
            <p className="text-2xs text-muted-foreground">{t("objects.recordsCount", { count: 0 })}</p>
          </div>
        </div>
        <div className="grid grid-cols-3 border-b bg-elevated/60 text-2xs font-medium text-muted-foreground">
          {DEFAULT_COLUMNS.map((c) => (
            <span key={c.key} className="flex items-center gap-1 truncate px-2 py-1.5">
              <Icon name={c.icon} className="size-3 shrink-0" />
              {t(`objects.defaults.${c.key}`)}
            </span>
          ))}
        </div>
        {[0, 1, 2].map((r) => (
          <motion.div
            key={r}
            initial={{ opacity: 0, x: -6 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ delay: 0.15 + r * 0.06 }}
            className="grid grid-cols-3 items-center border-b py-2 last:border-0"
          >
            <span className="mx-2 h-2 rounded-full bg-foreground/10" />
            <span className="mx-2">
              <Tag color={(["green", "amber", "gray"] as const)[r]}>{t(`objects.defaults.${(["active", "paused", "archived"] as const)[r]}`)}</Tag>
            </span>
            <span className="mx-2 size-4 rounded-full bg-foreground/10" />
          </motion.div>
        ))}
      </div>
      <p className="mt-auto text-xs leading-relaxed text-muted-foreground">{t("objects.previewNote")}</p>
    </div>
  )
}

function NewObjectDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const router = useRouter()
  const t = useT()
  const entities = useEntities()
  const [label, setLabel] = useState("")
  const [singular, setSingular] = useState("")
  const [icon, setIcon] = useState("star")
  const [color, setColor] = useState<ColorKey>("blue")
  const key = slugKey(label)
  const taken = entities.some((e) => e.key === key)
  const tplLabel = (k: Template["key"]) => t(`objects.templates.${k}.label`)
  const templates = TEMPLATES.filter((tpl) => !entities.some((e) => e.label.toLowerCase() === tplLabel(tpl.key).toLowerCase()))

  const reset = () => {
    setLabel("")
    setSingular("")
    setIcon("star")
    setColor("blue")
  }

  const create = () => {
    const e = workspaceActions.createEntity({
      key,
      label: label.trim(),
      labelSingular: singular.trim() || label.trim(),
      icon,
      color,
      primaryField: "name",
      fields: [
        { key: "name", label: t("objects.defaults.name"), type: "text", required: true, system: true },
        { key: "status", label: t("objects.defaults.status"), type: "status", options: [
          { value: "active", label: t("objects.defaults.active"), color: "green" },
          { value: "paused", label: t("objects.defaults.paused"), color: "amber" },
          { value: "archived", label: t("objects.defaults.archived"), color: "gray" },
        ] },
        { key: "owner", label: t("objects.defaults.owner"), type: "user" },
        { key: "notes", label: t("objects.defaults.notes"), type: "longtext" },
      ],
      stageField: "status",
      ownerField: "owner",
    })
    onOpenChange(false)
    reset()
    router.push(`/settings/objects/${e.key}`)
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        onOpenChange(o)
        if (!o) reset()
      }}
    >
      <DialogContent className="gap-0 overflow-hidden p-0 sm:max-w-3xl">
        <div className="grid md:grid-cols-[1fr_18rem]">
          <form
            className="flex min-w-0 flex-col gap-5 p-6"
            onSubmit={(e) => {
              e.preventDefault()
              if (key && !taken) create()
            }}
          >
            <DialogHeader className="text-left">
              <DialogTitle className="text-lg">{t("objects.newTableTitle")}</DialogTitle>
              <DialogDescription>{t("objects.newTableDescription")}</DialogDescription>
            </DialogHeader>

            {templates.length > 0 && (
              <div className="flex flex-col gap-2">
                <Label className="text-xs text-muted-foreground">{t("objects.startFrom")}</Label>
                <div className="flex flex-wrap gap-1.5">
                  {templates.map((tpl, i) => (
                    <motion.button
                      key={tpl.key}
                      type="button"
                      initial={{ opacity: 0, y: 6 }}
                      animate={{ opacity: 1, y: 0, transition: { delay: i * 0.04 } }}
                      whileTap={{ scale: 0.96 }}
                      onClick={() => {
                        setLabel(tplLabel(tpl.key))
                        setSingular(t(`objects.templates.${tpl.key}.singular`))
                        setIcon(tpl.icon)
                        setColor(tpl.color)
                      }}
                      className={cn(
                        "flex h-8 items-center gap-1.5 rounded-full border bg-card pl-1 pr-3 text-xs font-medium transition-colors hover:border-border-strong hover:bg-elevated",
                        label === tplLabel(tpl.key) && "border-brand/50 bg-brand-soft/50",
                      )}
                    >
                      <IconTile icon={tpl.icon} color={tpl.color} size="sm" className="rounded-full" />
                      {tplLabel(tpl.key)}
                    </motion.button>
                  ))}
                </div>
              </div>
            )}

            <div className="grid grid-cols-2 gap-3">
              <div className="grid gap-1.5">
                <Label className="text-xs">{t("objects.pluralName")}</Label>
                <Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder={t("objects.pluralPlaceholder")} autoFocus />
              </div>
              <div className="grid gap-1.5">
                <Label className="text-xs">{t("objects.singularHint")}</Label>
                <Input value={singular} onChange={(e) => setSingular(e.target.value)} placeholder={t("objects.singularPlaceholder")} />
              </div>
            </div>

            <div className="grid gap-1.5">
              <Label className="text-xs">{t("objects.iconAndColour")}</Label>
              <IconColorPicker icon={icon} color={color} onIcon={setIcon} onColor={setColor} />
            </div>

            <div className="flex flex-wrap items-center justify-between gap-3 border-t pt-4">
              <p className="min-h-4 text-xs text-muted-foreground">
                {key && (
                  <>
                    {t("objects.apiKey")} <code className="rounded bg-muted px-1 py-0.5 font-mono">{key}</code>
                    {taken && <span className="text-destructive"> {t("objects.alreadyExists")}</span>}
                  </>
                )}
              </p>
              <div className="flex gap-2">
                <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
                  {t("common.cancel")}
                </Button>
                <Button type="submit" disabled={!key || taken}>
                  <Plus /> {t("objects.createTable")}
                </Button>
              </div>
            </div>
          </form>
          <div className="hidden border-l bg-elevated/40 md:block">
            <ObjectPreview label={label} icon={icon} color={color} />
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}

export function ObjectsSettings() {
  const t = useT()
  const moduleName = useModuleName()
  const entities = useEntities()
  const records = useData((s) => s.records)
  const [open, setOpen] = useState(false)
  return (
    <>
      <SettingsSection title={t("objects.title")} description={t("objects.description")}>
        <ul>
          {entities.map((e) => (
            <li key={e.key}>
              <Link href={`/settings/objects/${e.key}`} className="flex items-center gap-3 px-[var(--pad)] py-3.5 transition-colors hover:bg-elevated">
                <IconTile icon={e.icon} color={e.color} />
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium">{e.label}</p>
                  <p className="text-xs text-muted-foreground">
                    {t("objects.fieldsCount", { count: e.fields.length })} · {t("objects.recordsCount", { count: records[e.key]?.length ?? 0 })}
                  </p>
                </div>
                <Tag color={e.custom ? "violet" : e.module === "core" ? "green" : "blue"}>{e.custom ? t("objects.custom") : (moduleName(e.module) ?? e.module)}</Tag>
                <ChevronRight className="size-4 text-muted-foreground" />
              </Link>
            </li>
          ))}
        </ul>
        <div className="px-[var(--pad)] py-3">
          <Button size="sm" onClick={() => setOpen(true)}>
            <Plus /> {t("objects.newTable")}
          </Button>
        </div>
      </SettingsSection>
      <NewObjectDialog open={open} onOpenChange={setOpen} />
    </>
  )
}
