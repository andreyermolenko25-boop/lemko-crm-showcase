"use client"

import { useEntity } from "@/lib/core/workspace"
import { useRecord } from "@/lib/core/data"
import { ui, useUi } from "@/lib/core/ui"
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet"
import { InlineField, OpenFullPage, RecordActions, RecordHeader, StageStepper, Timeline } from "@/components/crm/record-detail"
import { SectionLabel } from "@/components/crm/primitives"
import { useT } from "@/components/i18n-provider"

/** Side drawer preview of any record — opened from tables, boards, widgets. */
export function RecordPeek() {
  const peek = useUi((s) => s.peek)
  const entity = useEntity(peek?.entity)
  const record = useRecord(peek?.entity ?? "", peek?.id ?? "")
  const open = Boolean(peek && entity && record)
  const t = useT()

  return (
    <Sheet open={open} onOpenChange={(o) => !o && ui.closePeek()}>
      <SheetContent side="right" className="w-full gap-0 overflow-y-auto p-0 sm:max-w-[34rem]">
        <SheetTitle className="sr-only">{entity?.labelSingular ?? t("common.record")}</SheetTitle>
        <SheetDescription className="sr-only">{t("common.recordPreview")}</SheetDescription>
        {entity && record && (
          <>
            <div className="sticky top-0 z-10 flex flex-col gap-4 border-b bg-popover/95 p-5 pr-12 backdrop-blur">
              <RecordHeader entity={entity} record={record} compact />
              <div className="flex gap-2">
                <span onClick={() => ui.closePeek()}>
                  <OpenFullPage href={`/o/${entity.key}/${record.id}`} />
                </span>
                <RecordActions entity={entity} record={record} onDeleted={() => ui.closePeek()} />
              </div>
            </div>
            <div className="flex flex-col gap-6 p-5">
              {entity.stageField && <StageStepper entity={entity} record={record} />}
              <div className="flex flex-col gap-1">
                <SectionLabel className="mb-1">{t("common.details")}</SectionLabel>
                {entity.fields.map((f) => (
                  <InlineField key={f.key} entity={entity} record={record} field={f} />
                ))}
              </div>
              <div className="flex flex-col gap-3">
                <SectionLabel>{t("common.activity")}</SectionLabel>
                <Timeline entity={entity} record={record} limit={12} />
              </div>
            </div>
          </>
        )}
      </SheetContent>
    </Sheet>
  )
}
