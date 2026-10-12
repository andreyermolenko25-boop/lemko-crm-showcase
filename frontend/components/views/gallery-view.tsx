"use client"

import type { CrmRecord, EntityDef, FieldDef, ViewDef } from "@/lib/core/types"
import { ui } from "@/lib/core/ui"
import { FieldValue, RecordAvatar } from "@/components/crm/field-value"
import { useT } from "@/components/i18n-provider"

export function GalleryView({ entity, view, records }: { entity: EntityDef; view: ViewDef; records: CrmRecord[] }) {
  const fields = view.columns.map((k) => entity.fields.find((f) => f.key === k)).filter((f): f is FieldDef => !!f && f.key !== entity.primaryField)
  const stage = entity.fields.find((f) => f.key === entity.stageField)
  const t = useT()
  return (
    <div className="grid grid-cols-1 gap-[var(--gap)] sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
      {records.map((r) => (
        <button
          key={r.id}
          onClick={() => ui.peek(entity.key, r.id)}
          className="surface group flex flex-col gap-4 p-[var(--pad)] text-left transition-colors hover:border-border-strong"
        >
          <div className="flex items-start gap-3">
            <RecordAvatar entity={entity} record={r} size="lg" />
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-semibold">{String(r[entity.primaryField] ?? t("common.untitled"))}</p>
              {entity.secondaryField && (
                <div className="mt-0.5 truncate text-xs text-muted-foreground">
                  <FieldValue field={entity.fields.find((f) => f.key === entity.secondaryField)!} value={r[entity.secondaryField]} />
                </div>
              )}
            </div>
            {stage && !view.columns.includes(stage.key) && <FieldValue field={stage} value={r[stage.key]} />}
          </div>
          <dl className="grid grid-cols-2 gap-x-3 gap-y-2.5 border-t pt-3.5">
            {fields.slice(0, 6).map((f) => (
              <div key={f.key} className="min-w-0">
                <dt className="text-xs text-subtle-foreground">{f.label}</dt>
                <dd className="mt-0.5 truncate text-sm">
                  <FieldValue field={f} value={r[f.key]} compact />
                </dd>
              </div>
            ))}
          </dl>
        </button>
      ))}
    </div>
  )
}
