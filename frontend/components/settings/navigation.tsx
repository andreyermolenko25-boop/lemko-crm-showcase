"use client"

import { useState } from "react"
import { Eye, EyeOff, GripVertical, Star, X } from "lucide-react"
import { cn } from "@/lib/utils"
import { useNavItems } from "@/lib/core/nav"
import { Icon } from "@/lib/core/icons"
import { useWorkspace, workspaceActions } from "@/lib/core/workspace"
import { Button } from "@/components/ui/button"
import { SettingsSection } from "@/components/settings/shared"
import { useT } from "@/components/i18n-provider"

export function NavigationSettings() {
  const { all } = useNavItems()
  const hidden = useWorkspace((s) => s.nav.hidden)
  const favorites = useWorkspace((s) => s.nav.favorites)
  const [drag, setDrag] = useState<string | null>(null)
  const t = useT()

  return (
    <div className="flex flex-col gap-[var(--gap)]">
      <SettingsSection title={t("navigationSettings.itemsTitle")} description={t("navigationSettings.itemsDescription")}>
        <ul className="p-2">
          {all.map((item) => {
            const off = hidden.includes(item.id)
            return (
              <li
                key={item.id}
                draggable
                onDragStart={() => setDrag(item.id)}
                onDragOver={(e) => {
                  e.preventDefault()
                  if (!drag || drag === item.id) return
                  const ids = all.map((i) => i.id).filter((i) => i !== drag)
                  ids.splice(ids.indexOf(item.id), 0, drag)
                  workspaceActions.setNavOrder(ids)
                }}
                onDragEnd={() => setDrag(null)}
                className={cn("flex h-11 items-center gap-3 rounded-lg px-2 hover:bg-elevated", drag === item.id && "opacity-50")}
              >
                <GripVertical className="size-4 cursor-grab text-subtle-foreground" />
                <span className="flex size-7 items-center justify-center rounded-lg border bg-elevated">
                  <Icon name={item.icon} className="size-3.5" />
                </span>
                <span className={cn("flex-1 text-sm font-medium", off && "text-muted-foreground line-through")}>{item.label}</span>
                <span className="text-xs text-muted-foreground">{item.kind === "entity" ? t("navigationSettings.object") : t("navigationSettings.page")}</span>
                <Button variant="ghost" size="icon-sm" onClick={() => workspaceActions.toggleNavHidden(item.id)} aria-label={off ? t("navigationSettings.show") : t("navigationSettings.hide")} disabled={item.id === "page:home"}>
                  {off ? <EyeOff /> : <Eye />}
                </Button>
              </li>
            )
          })}
        </ul>
        <div className="flex justify-end px-[var(--pad)] py-3">
          <Button variant="ghost" size="sm" onClick={() => workspaceActions.setNavOrder([])}>
            {t("navigationSettings.resetOrder")}
          </Button>
        </div>
      </SettingsSection>
      <SettingsSection title={t("navigationSettings.favoritesTitle")} description={t("navigationSettings.favoritesDescription")}>
        {favorites.length === 0 ? (
          <p className="px-[var(--pad)] py-6 text-center text-xs text-muted-foreground">{t("navigationSettings.nothingPinned")}</p>
        ) : (
          <ul className="p-2">
            {favorites.map((f) => (
              <li key={f.id} className="flex h-11 items-center gap-3 rounded-lg px-2 hover:bg-elevated">
                <Star className="size-4 fill-warning text-warning" />
                <span className="flex-1 truncate text-sm font-medium">{f.label}</span>
                <Button variant="ghost" size="icon-sm" onClick={() => workspaceActions.toggleFavorite(f)} aria-label={t("navigationSettings.unpin")}>
                  <X />
                </Button>
              </li>
            ))}
          </ul>
        )}
      </SettingsSection>
    </div>
  )
}
