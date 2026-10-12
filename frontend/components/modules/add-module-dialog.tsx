"use client"

import { useRef, useState } from "react"
import { AnimatePresence, motion } from "motion/react"
import { ArrowLeft, ArrowRight, FileJson, Link2, UploadCloud } from "lucide-react"
import { toast } from "sonner"
import { cn } from "@/lib/utils"
import type { ColorKey } from "@/lib/core/types"
import { workspaceActions, type PackageManifest } from "@/lib/core/workspace"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { IconTile } from "@/components/crm/primitives"
import { useT } from "@/components/i18n-provider"

type Mode = "pick" | "file" | "url"

/**
 * Manually add a module: a JSON manifest (uploaded or fetched from a URL) with
 * the objects and views it brings.
 *
 *   { "name": "Clinic", "version": "1.0.0",
 *     "entities": [{ "key": "patients", "label": "Patients", "fields": [{ "key": "name", "label": "Name", "type": "text" }] }],
 *     "views": [{ "entity": "patients", "name": "All patients", "type": "table", "columns": ["name"] }] }
 */
export function AddModuleDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const t = useT()
  const [mode, setMode] = useState<Mode>("pick")
  const [value, setValue] = useState("")
  const [file, setFile] = useState<File | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [over, setOver] = useState(false)
  const input = useRef<HTMLInputElement>(null)

  const reset = () => {
    setMode("pick")
    setValue("")
    setFile(null)
    setError(null)
  }

  const install = async () => {
    setBusy(true)
    setError(null)
    try {
      let text: string
      let origin: string
      if (mode === "file") {
        if (!file) return
        text = await file.text()
        origin = file.name
      } else {
        origin = value.trim()
        const res = await fetch(origin)
        if (!res.ok) throw new Error(t("apps.add.urlStatus", { status: res.status }))
        text = await res.text()
      }
      let manifest: PackageManifest
      try {
        manifest = JSON.parse(text)
      } catch {
        throw new Error(t("apps.add.invalidJson"))
      }
      const pkg = await workspaceActions.installPackage(manifest, mode === "file" ? "file" : "url", origin)
      toast.success(t("apps.installedFind", { name: pkg.name }))
      onOpenChange(false)
      reset()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const canInstall = !busy && (mode === "file" ? Boolean(file) : /^https?:\/\/\S+/.test(value.trim()))
  const options: { mode: Mode; icon: string; color: ColorKey; title: string; desc: string }[] = [
    { mode: "file", icon: "package", color: "blue", title: t("apps.add.uploadTitle"), desc: t("apps.add.uploadDesc") },
    { mode: "url", icon: "plug", color: "teal", title: t("apps.add.urlTitle"), desc: t("apps.add.urlDesc") },
  ]
  const step = { initial: { opacity: 0, x: 16 }, animate: { opacity: 1, x: 0 }, exit: { opacity: 0, x: -16 }, transition: { duration: 0.22, ease: [0.22, 1, 0.36, 1] as const } }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        onOpenChange(o)
        if (!o) reset()
      }}
    >
      <DialogContent className="gap-0 overflow-hidden p-0 sm:max-w-lg">
        <div className="relative border-b px-6 pb-5 pt-6">
          <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(70%_130%_at_0%_0%,color-mix(in_oklch,var(--brand)_14%,transparent),transparent_70%)]" />
          <DialogHeader className="relative flex-row items-center gap-3 text-left">
            <IconTile icon={mode === "file" ? "package" : mode === "url" ? "plug" : "boxes"} color={mode === "url" ? "teal" : "blue"} size="lg" />
            <div>
              <DialogTitle className="text-lg">{mode === "pick" ? t("apps.add.pickTitle") : mode === "file" ? t("apps.add.uploadTitle") : t("apps.add.urlTitle")}</DialogTitle>
              <DialogDescription>{t("apps.add.description")}</DialogDescription>
            </div>
          </DialogHeader>
          <div className="relative mt-4 flex gap-1.5" aria-hidden>
            {[0, 1].map((i) => (
              <span key={i} className="h-1 flex-1 overflow-hidden rounded-full bg-foreground/8">
                <motion.span
                  className="block h-full rounded-full bg-brand"
                  initial={false}
                  animate={{ width: i === 0 || mode !== "pick" ? "100%" : "0%" }}
                  transition={{ duration: 0.35, ease: [0.22, 1, 0.36, 1] }}
                />
              </span>
            ))}
          </div>
        </div>

        <div className="p-6">
          <AnimatePresence mode="wait" initial={false}>
            {mode === "pick" ? (
              <motion.div key="pick" {...step} className="flex flex-col gap-2.5">
                {options.map((o, i) => (
                  <motion.button
                    key={o.mode}
                    initial={{ opacity: 0, y: 8 }}
                    animate={{ opacity: 1, y: 0, transition: { delay: 0.05 + i * 0.05 } }}
                    whileHover={{ y: -2 }}
                    whileTap={{ scale: 0.985 }}
                    onClick={() => setMode(o.mode)}
                    className="group flex items-center gap-3.5 rounded-2xl border bg-card p-4 text-left shadow-xs transition-[border-color,box-shadow] hover:border-brand/40 hover:shadow-[var(--shadow-pop)]"
                  >
                    <IconTile icon={o.icon} color={o.color} size="lg" />
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm font-semibold">{o.title}</span>
                      <span className="block text-xs text-muted-foreground">{o.desc}</span>
                    </span>
                    <ArrowRight className="size-4 text-muted-foreground transition-transform group-hover:translate-x-0.5 group-hover:text-foreground" />
                  </motion.button>
                ))}
              </motion.div>
            ) : mode === "file" ? (
              <motion.div
                key="file"
                {...step}
                onDragOver={(e) => {
                  e.preventDefault()
                  setOver(true)
                }}
                onDragLeave={() => setOver(false)}
                onDrop={(e) => {
                  e.preventDefault()
                  setOver(false)
                  setFile(e.dataTransfer.files[0] ?? null)
                }}
                onClick={() => input.current?.click()}
                className={cn(
                  "relative flex cursor-pointer flex-col items-center gap-3 overflow-hidden rounded-2xl border-2 border-dashed p-10 text-center transition-colors",
                  over ? "border-brand bg-brand/5" : file ? "border-brand/50 bg-brand-soft/30" : "hover:border-brand/60",
                )}
              >
                <input ref={input} type="file" accept=".json,application/json" className="hidden" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
                <motion.span
                  key={file ? "file" : "empty"}
                  initial={{ scale: 0.6, opacity: 0 }}
                  animate={{ scale: 1, opacity: 1, y: over ? -4 : 0 }}
                  transition={{ type: "spring", stiffness: 380, damping: 18 }}
                  className={cn("flex size-14 items-center justify-center rounded-2xl", file ? "bg-brand text-brand-foreground" : "bg-muted text-muted-foreground")}
                >
                  {file ? <FileJson className="size-6" /> : <UploadCloud className="size-6" />}
                </motion.span>
                <p className="text-sm font-semibold">{file ? file.name : over ? t("apps.add.releaseToAttach") : t("apps.add.dropManifest")}</p>
                <p className="text-xs text-muted-foreground">{file ? t("apps.add.readyToInstall", { size: (file.size / 1024).toFixed(1) }) : "manifest.json"}</p>
              </motion.div>
            ) : (
              <motion.div key="url" {...step} className="grid gap-1.5">
                <Label className="text-xs">{t("apps.add.manifestUrl")}</Label>
                <div className="flex h-11 items-center gap-2.5 rounded-xl border bg-card px-3.5 focus-within:border-brand/60 focus-within:ring-3 focus-within:ring-ring/20">
                  <Link2 className="size-4 shrink-0 text-muted-foreground" />
                  <input
                    autoFocus
                    value={value}
                    onChange={(e) => setValue(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && canInstall && void install()}
                    placeholder="https://raw.githubusercontent.com/acme/lemko-clinic/main/manifest.json"
                    className="w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground/60"
                  />
                </div>
                <p className="text-xs text-muted-foreground">{t("apps.add.urlHint")}</p>
              </motion.div>
            )}
          </AnimatePresence>

          <AnimatePresence>
            {error && (
              <motion.p
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: "auto" }}
                exit={{ opacity: 0, height: 0 }}
                className="mt-4 overflow-hidden rounded-xl bg-destructive/10 px-3 py-2 text-xs text-destructive"
              >
                {error}
              </motion.p>
            )}
          </AnimatePresence>
        </div>

        {mode !== "pick" && (
          <DialogFooter className="border-t px-6 py-4">
            <Button variant="ghost" onClick={() => setMode("pick")}>
              <ArrowLeft /> {t("common.back")}
            </Button>
            <Button disabled={!canInstall} onClick={() => void install()}>
              {busy ? t("apps.add.installing") : t("apps.install")}
            </Button>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  )
}
