"use client"

import { useEffect, useMemo, useState } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import type { RecordValue } from "@/lib/core/types"
import { currentUserId, dataActions } from "@/lib/core/data"
import { ui, useUi } from "@/lib/core/ui"
import { useEntity } from "@/lib/core/workspace"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { FieldInput } from "@/components/crm/field-input"
import { IconTile } from "@/components/crm/primitives"
import { useT } from "@/components/i18n-provider"
import { nounInSentence } from "@/lib/i18n/text"

// Schedule, stock and catalogue records are not people or companies.

/** Global "create record" dialog — opened via ui.openCreate(entityKey). */
export function CreateRecordDialog() {
  const create = useUi((s) => s.create)
  const entity = useEntity(create?.entity)
  const router = useRouter()
  const [values, setValues] = useState<Record<string, RecordValue>>({})
  const [another, setAnother] = useState(false)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState(false)
  const t = useT()

  const defaults = useMemo(() => {
    if (!entity) return {}
    const d: Record<string, RecordValue> = {}
    for (const f of entity.fields) {
      if ((f.type === "status" || f.type === "select") && f.key === entity.stageField) d[f.key] = f.options?.[0]?.value
      if (f.type === "user" && !f.readOnly) d[f.key] = currentUserId()
    }
    return { ...d, ...create?.defaults }
  }, [entity, create])

  useEffect(() => {
    setValues(defaults)
    setErrors({})
  }, [defaults])

  if (!entity) return null
  // Read-only fields (lifetime value, stock status…) are computed by the server.
  const fields = entity.fields.filter((f) => !f.readOnly && (f.type !== "longtext" || f.key === "notes" || f.key === "description"))

  async function submit() {
    if (!entity || saving) return
    const errs: Record<string, string> = {}
    for (const f of fields) {
      const v = values[f.key]
      if (f.required && (v === undefined || v === null || v === "")) errs[f.key] = t("recordForm.required")
    }
    setErrors(errs)
    if (Object.keys(errs).length) return
    setSaving(true)
    const rec = await dataActions.create(entity, values)
    setSaving(false)
    // On failure the error toast is already shown — keep the dialog open to fix the input.
    if (!rec) return
    toast.success(t("recordForm.created", { name: entity.labelSingular }), {
      action: { label: t("common.open"), onClick: () => router.push(`/o/${entity.key}/${rec.id}`) },
    })
    if (another) setValues(defaults)
    else ui.closeCreate()
  }

  return (
    <Dialog open={!!create} onOpenChange={(o) => !o && ui.closeCreate()}>
      <DialogContent className="flex max-h-[88dvh] flex-col gap-0 p-0 sm:max-w-xl">
        <DialogHeader className="flex-row items-center gap-3 border-b p-5 text-left">
          <IconTile icon={entity.icon} color={entity.color} />
          <div>
            <DialogTitle className="text-base">{t("recordForm.title", { name: nounInSentence(entity.labelSingular) })}</DialogTitle>
            <DialogDescription className="text-xs">{t("recordForm.description")}</DialogDescription>
          </div>
        </DialogHeader>
        <form
          id="create-record"
          className="grid flex-1 grid-cols-1 gap-x-4 gap-y-3.5 overflow-y-auto p-5 sm:grid-cols-2"
          onSubmit={(e) => {
            e.preventDefault()
            void submit()
          }}
        >
          {fields.map((f, i) => (
            <label key={f.key} className={f.type === "longtext" || f.key === entity.primaryField ? "flex flex-col gap-1.5 sm:col-span-2" : "flex flex-col gap-1.5"}>
              <span className="flex items-center gap-1 text-sm font-medium text-muted-foreground">
                {f.label}
                {f.required && <span className="text-destructive">*</span>}
                {errors[f.key] && <span className="ml-auto text-destructive">{errors[f.key]}</span>}
              </span>
              <FieldInput field={f} value={values[f.key]} autoFocus={i === 0} onChange={(v) => setValues((s) => ({ ...s, [f.key]: v }))} />
            </label>
          ))}
        </form>
        <DialogFooter className="items-center border-t p-4 sm:justify-between">
          <label className="flex items-center gap-2 text-sm text-muted-foreground">
            <Checkbox checked={another} onCheckedChange={(v) => setAnother(Boolean(v))} />
            {t("recordForm.createAnother")}
          </label>
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => ui.closeCreate()}>
              {t("common.cancel")}
            </Button>
            <Button type="submit" form="create-record" disabled={saving}>
              {saving ? t("recordForm.saving") : t("recordForm.create", { name: nounInSentence(entity.labelSingular) })}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
