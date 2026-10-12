"use client"

import { useEffect, useMemo, useState } from "react"
import { useRouter } from "next/navigation"
import { useTheme } from "next-themes"
import { CornerDownLeft, Languages, Moon, Palette, PanelLeft, Plus, Settings, Sun } from "lucide-react"
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog"
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList, CommandSeparator } from "@/components/ui/command"
import { Icon } from "@/lib/core/icons"
import { ui, uiStore, useUi } from "@/lib/core/ui"
import { useData } from "@/lib/core/data"
import { useEntities } from "@/lib/core/workspace"
import { useNavItems } from "@/lib/core/nav"
import { prefsStore, setPrefs } from "@/lib/core/prefs"
import { Kbd, Monogram } from "@/components/crm/primitives"
import { useT } from "@/components/i18n-provider"
import { nounInSentence } from "@/lib/i18n/text"

export function CommandPalette() {
  const open = useUi((s) => s.commandOpen)
  const router = useRouter()
  const { setTheme, resolvedTheme } = useTheme()
  const entities = useEntities()
  const records = useData((s) => s.records)
  const { visible } = useNavItems()
  const [query, setQuery] = useState("")
  const t = useT()

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault()
        ui.openCommand(!uiStore.get().commandOpen)
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [])

  const results = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (q.length < 1) return []
    const out: { entity: (typeof entities)[number]; id: string; title: string; sub: string }[] = []
    for (const e of entities) {
      for (const r of records[e.key] ?? []) {
        const title = String(r[e.primaryField] ?? "")
        const sub = e.secondaryField ? String(r[e.secondaryField] ?? "") : ""
        if (title.toLowerCase().includes(q) || String(r.email ?? "").toLowerCase().includes(q)) {
          out.push({ entity: e, id: r.id, title, sub })
          if (out.length > 40) return out
        }
      }
    }
    return out
  }, [query, entities, records])

  const run = (fn: () => void) => {
    ui.openCommand(false)
    setQuery("")
    fn()
  }

  return (
    <Dialog open={open} onOpenChange={(o) => ui.openCommand(o)}>
      <DialogContent showCloseButton={false} className="top-[18%] translate-y-0 overflow-hidden p-0 sm:max-w-[38rem]">
        <DialogTitle className="sr-only">{t("palette.title")}</DialogTitle>
        <DialogDescription className="sr-only">{t("palette.description")}</DialogDescription>
        <Command shouldFilter={true} className="bg-popover **:data-[slot=command-input-wrapper]:h-12 [&_[cmdk-group-heading]]:px-2.5 [&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:font-semibold [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-wider [&_[cmdk-item]]:rounded-lg [&_[cmdk-item]]:px-2.5 [&_[cmdk-item]]:py-2">
          <CommandInput value={query} onValueChange={setQuery} placeholder={t("palette.placeholder")} className="h-12" />
          <CommandList className="max-h-[26rem] p-1.5">
            <CommandEmpty>{t("palette.noResults", { query })}</CommandEmpty>
            {results.length > 0 && (
              <CommandGroup heading={t("palette.records")}>
                {results.map((r) => (
                  <CommandItem key={`${r.entity.key}-${r.id}`} value={`${r.title} ${r.sub} ${r.entity.label} ${r.id}`} onSelect={() => run(() => router.push(`/o/${r.entity.key}/${r.id}`))}>
                    <Monogram name={r.title} size="sm" square={r.entity.key !== "contacts"} />
                    <span className="min-w-0 flex-1 truncate">{r.title}</span>
                    <span className="text-xs text-muted-foreground">{r.entity.labelSingular}</span>
                  </CommandItem>
                ))}
              </CommandGroup>
            )}
            <CommandGroup heading={t("palette.goTo")}>
              {visible.map((n) => (
                <CommandItem key={n.id} value={`go ${n.label}`} onSelect={() => run(() => router.push(n.href))}>
                  <Icon name={n.icon} className="text-muted-foreground" />
                  {n.label}
                </CommandItem>
              ))}
              <CommandItem value={`go settings ${t("nav.settings")}`} onSelect={() => run(() => router.push("/settings"))}>
                <Settings className="text-muted-foreground" /> {t("nav.settings")}
              </CommandItem>
            </CommandGroup>
            <CommandSeparator className="my-1" />
            <CommandGroup heading={t("palette.create")}>
              {entities.map((e) => (
                <CommandItem key={e.key} value={`create new ${t("palette.newRecord", { name: nounInSentence(e.labelSingular) })}`} onSelect={() => run(() => ui.openCreate(e.key))}>
                  <Plus className="text-muted-foreground" /> {t("palette.newRecord", { name: nounInSentence(e.labelSingular) })}
                </CommandItem>
              ))}
            </CommandGroup>
            <CommandGroup heading={t("palette.preferences")}>
              <CommandItem value={`toggle theme dark light ${t("palette.switchToLight")} ${t("palette.switchToDark")}`} onSelect={() => run(() => setTheme(resolvedTheme === "dark" ? "light" : "dark"))}>
                {resolvedTheme === "dark" ? <Sun className="text-muted-foreground" /> : <Moon className="text-muted-foreground" />}
                {resolvedTheme === "dark" ? t("palette.switchToLight") : t("palette.switchToDark")}
              </CommandItem>
              <CommandItem value={`toggle sidebar collapse ${t("palette.toggleSidebar")}`} onSelect={() => run(() => setPrefs({ sidebarCollapsed: !prefsStore.get().sidebarCollapsed }))}>
                <PanelLeft className="text-muted-foreground" /> {t("palette.toggleSidebar")}
              </CommandItem>
              <CommandItem value={`customize appearance accent theme ${t("palette.customizeAppearance")}`} onSelect={() => run(() => router.push("/settings/appearance"))}>
                <Palette className="text-muted-foreground" /> {t("palette.customizeAppearance")}
              </CommandItem>
              <CommandItem value={`language locale ${t("palette.changeLanguage")}`} onSelect={() => run(() => router.push("/settings/language"))}>
                <Languages className="text-muted-foreground" /> {t("palette.changeLanguage")}
              </CommandItem>
            </CommandGroup>
          </CommandList>
          <div className="flex items-center gap-3 border-t px-3 py-2 text-xs text-muted-foreground">
            <span className="flex items-center gap-1">
              <Kbd>↑</Kbd>
              <Kbd>↓</Kbd> {t("palette.navigate")}
            </span>
            <span className="flex items-center gap-1">
              <Kbd>
                <CornerDownLeft className="size-3" />
              </Kbd>
              {t("palette.open")}
            </span>
            <span className="ml-auto flex items-center gap-1">
              <Kbd>esc</Kbd> {t("palette.close")}
            </span>
          </div>
        </Command>
      </DialogContent>
    </Dialog>
  )
}

