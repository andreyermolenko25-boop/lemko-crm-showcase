"use client"

import Link from "next/link"
import { useParams } from "next/navigation"
import { useEntity } from "@/lib/core/workspace"
import { EntityPage } from "@/components/views/entity-page"
import { EmptyState } from "@/components/crm/primitives"
import { Button } from "@/components/ui/button"
import { useT } from "@/components/i18n-provider"

export default function EntityRoute() {
  const { entity: key } = useParams<{ entity: string }>()
  const entity = useEntity(key)
  const t = useT()
  if (!entity) {
    return (
      <EmptyState
        icon="boxes"
        title={t("entityRoute.unavailable")}
        description={t("entityRoute.unavailableHint")}
        action={
          <Button asChild size="sm">
            <Link href="/apps">{t("entityRoute.browseApps")}</Link>
          </Button>
        }
      />
    )
  }
  return <EntityPage entity={entity} />
}
