"use client"

import Link from "next/link"
import { useParams } from "next/navigation"
import { ChevronRight } from "lucide-react"
import { useEntity } from "@/lib/core/workspace"
import { useRecord } from "@/lib/core/data"
import { RecordDetail } from "@/components/crm/record-detail"
import { EmptyState } from "@/components/crm/primitives"
import { useT } from "@/components/i18n-provider"

export default function RecordRoute() {
  const { entity: key, id } = useParams<{ entity: string; id: string }>()
  const entity = useEntity(key)
  const record = useRecord(key, id)
  const t = useT()
  if (!entity || !record) return <EmptyState icon="archive" title={t("record.notFound")} description={t("record.notFoundHint")} />
  return (
    <div className="flex flex-col gap-4">
      <nav className="flex items-center gap-1 text-xs text-muted-foreground">
        <Link href={`/o/${entity.key}`} className="hover:text-foreground">
          {entity.label}
        </Link>
        <ChevronRight className="size-3" />
        <span className="truncate text-foreground">{String(record[entity.primaryField] ?? "")}</span>
      </nav>
      <RecordDetail entity={entity} record={record} />
    </div>
  )
}
