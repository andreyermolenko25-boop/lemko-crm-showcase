"use client"

import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react"
import { motion } from "motion/react"
import * as SliderPrimitive from "@radix-ui/react-slider"
import { Check, Pipette } from "lucide-react"
import { cn } from "@/lib/utils"
import { springs } from "@/lib/core/motion"
import { hexToHsv, hexToOklch, hsvToHex, oklchToHex, type Hsv } from "@/lib/core/color"
import { ACCENTS, ACCENT_SHADES, accentChromaOf, accentHueOf, prefsStore, setPrefs, usePrefs, type AccentKey, type Prefs } from "@/lib/core/prefs"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { SettingsRow } from "@/components/settings/shared"
import { useT } from "@/components/i18n-provider"

/* ------------------------------------------------------------------ */
/*  Colour maths                                                       */
/* ------------------------------------------------------------------ */

/** Lemko's own accent. */
const DEFAULT_ACCENT: AccentKey = "emerald"

/** The popular colours under the picker, Lemko's own first. */
const POPULAR: AccentKey[] = ["emerald", "blue", "indigo", "violet", "pink", "red", "orange", "graphite"]

/** Presets are shown and matched at the base shade. */
const BASE_L = ACCENT_SHADES[2].l

const HUE_STRIP = "linear-gradient(90deg, #f00 0%, #ff0 16.67%, #0f0 33.33%, #0ff 50%, #00f 66.67%, #f0f 83.33%, #f00 100%)"

const norm180 = (d: number) => ((((d + 180) % 360) + 360) % 360) - 180
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))
const round = (v: number, places: number) => Math.round(v * 10 ** places) / 10 ** places

function lightOf(p: Prefs): number {
  if (p.accent === "custom" && typeof p.accentLight === "number") return p.accentLight
  return (ACCENT_SHADES.find((s) => s.key === p.accentShade) ?? ACCENT_SHADES[2]).l
}

/** The accent as it shows in the light theme, as #RRGGBB. */
const accentHex = (p: Prefs) => oklchToHex({ l: lightOf(p), c: accentChromaOf(p), h: accentHueOf(p) }).toUpperCase()

function presetHex(key: AccentKey): string {
  const a = ACCENTS.find((x) => x.key === key) ?? ACCENTS[0]
  return oklchToHex({ l: BASE_L, c: a.c, h: a.h }).toUpperCase()
}

function choosePreset(key: AccentKey) {
  setPrefs({ accent: key, accentHue: undefined, accentChroma: undefined, accentLight: undefined, accentShade: "base" })
}

/**
 * A picked, typed or eyedropped colour becomes the accent as it is; very light
 * or very dark ones are pulled in so text on the accent stays readable. A
 * preset's own colour becomes that preset.
 */
function applyHex(hex: string): boolean {
  const o = hexToOklch(hex)
  if (!o) return false
  const preset = ACCENTS.find((a) => Math.abs(o.l - BASE_L) < 0.006 && Math.abs(a.c - o.c) < 0.006 && Math.abs(norm180(a.h - o.h)) < 1.5)
  if (preset) choosePreset(preset.key)
  else
    setPrefs({
      accent: "custom",
      accentHue: round(o.h, 1),
      accentChroma: round(o.c, 3),
      accentLight: round(clamp(o.l, 0.25, 0.9), 3),
      accentShade: "base",
    })
  return true
}

/* ------------------------------------------------------------------ */
/*  Picker parts                                                       */
/* ------------------------------------------------------------------ */

/** Saturation left → right, brightness bottom → top, for the hue on the strip below. */
function SaturationPlane({ hsv, hex, label, onChange }: { hsv: Hsv; hex: string; label: string; onChange: (next: Hsv) => void }) {
  const ref = useRef<HTMLDivElement>(null)

  const at = (e: PointerEvent<HTMLDivElement>) => {
    const r = ref.current?.getBoundingClientRect()
    if (!r) return
    onChange({ h: hsv.h, s: clamp((e.clientX - r.left) / r.width, 0, 1), v: 1 - clamp((e.clientY - r.top) / r.height, 0, 1) })
  }

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = e.shiftKey ? 0.1 : 0.02
    const ds = e.key === "ArrowRight" ? step : e.key === "ArrowLeft" ? -step : 0
    const dv = e.key === "ArrowUp" ? step : e.key === "ArrowDown" ? -step : 0
    if (!ds && !dv) return
    e.preventDefault()
    onChange({ h: hsv.h, s: clamp(hsv.s + ds, 0, 1), v: clamp(hsv.v + dv, 0, 1) })
  }

  return (
    <div
      ref={ref}
      role="slider"
      tabIndex={0}
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(hsv.s * 100)}
      aria-valuetext={`${Math.round(hsv.s * 100)}%, ${Math.round(hsv.v * 100)}%`}
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId)
        at(e)
      }}
      onPointerMove={(e) => {
        if (e.currentTarget.hasPointerCapture(e.pointerId)) at(e)
      }}
      onKeyDown={onKeyDown}
      className="group/plane relative h-36 w-full cursor-crosshair touch-none select-none rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-popover"
      style={{ background: `linear-gradient(to top, #000, transparent), linear-gradient(to right, #fff, hsl(${hsv.h} 100% 50%))` }}
    >
      <span aria-hidden className="pointer-events-none absolute inset-0 rounded-[inherit] shadow-[inset_0_0_0_1px_oklch(0_0_0/8%)]" />
      <span
        aria-hidden
        className="pointer-events-none absolute size-4 -translate-x-1/2 -translate-y-1/2 rounded-full border-[2.5px] border-white shadow-[0_0_0_1px_oklch(0_0_0/18%),0_1px_4px_oklch(0_0_0/30%)] transition-transform duration-150 group-active/plane:scale-125"
        style={{ left: `${hsv.s * 100}%`, top: `${(1 - hsv.v) * 100}%`, background: hex }}
      />
    </div>
  )
}

function HueStrip({ hue, label, onChange }: { hue: number; label: string; onChange: (h: number) => void }) {
  return (
    <SliderPrimitive.Root min={0} max={360} step={1} value={[hue]} onValueChange={([h]) => onChange(h)} className="relative flex h-4 min-w-0 flex-1 touch-none select-none items-center">
      <SliderPrimitive.Track className="relative h-2.5 grow rounded-full shadow-[inset_0_0_0_1px_oklch(0_0_0/8%)]" style={{ background: HUE_STRIP }} />
      <SliderPrimitive.Thumb
        aria-label={label}
        className="block size-4 rounded-full border-[2.5px] border-white shadow-[0_0_0_1px_oklch(0_0_0/18%),0_1px_4px_oklch(0_0_0/30%)] outline-none transition-transform duration-150 hover:scale-110 focus-visible:ring-2 focus-visible:ring-ring active:scale-125"
        style={{ background: `hsl(${hue} 100% 50%)` }}
      />
    </SliderPrimitive.Root>
  )
}

type EyeDropperCtor = new () => { open: () => Promise<{ sRGBHex: string }> }

/** Only Chromium has the EyeDropper API; checked after mount so SSR and hydration agree. */
function useEyeDropper() {
  const [ctor, setCtor] = useState<EyeDropperCtor | null>(null)
  useEffect(() => {
    const c = (window as unknown as { EyeDropper?: EyeDropperCtor }).EyeDropper
    if (c) setCtor(() => c)
  }, [])
  return ctor
}

function HexField({ value, onCommit }: { value: string; onCommit: (hex: string) => void }) {
  const t = useT()
  /** What is being typed; null while the field just shows the colour. */
  const [draft, setDraft] = useState<string | null>(null)
  const valid = draft === null || hexToOklch(draft) !== null
  return (
    <label
      className={cn(
        "flex h-8 min-w-0 flex-1 items-center gap-2 rounded-lg border bg-card px-2.5 transition-[border-color,box-shadow] duration-200 focus-within:border-border-strong focus-within:ring-2 focus-within:ring-ring/40",
        !valid && "border-destructive/60 focus-within:ring-destructive/30",
      )}
    >
      <span className="text-2xs font-medium text-subtle-foreground">HEX</span>
      <input
        value={draft ?? value}
        onChange={(e) => {
          const v = e.target.value.slice(0, 7)
          setDraft(v)
          // A complete colour applies while typing, so the workspace previews it.
          if (/^#?[0-9a-f]{6}$/i.test(v.trim())) onCommit(v)
        }}
        onFocus={(e) => {
          setDraft(value)
          e.currentTarget.select()
        }}
        onBlur={() => {
          if (draft !== null && hexToOklch(draft)) onCommit(draft)
          setDraft(null)
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur()
          if (e.key === "Escape" && draft !== null) {
            // First Escape drops the edit; the next one closes the popover.
            e.stopPropagation()
            setDraft(null)
            e.currentTarget.blur()
          }
        }}
        spellCheck={false}
        autoComplete="off"
        aria-label={t("appearance.hex")}
        aria-invalid={!valid}
        className="tabular min-w-0 flex-1 bg-transparent font-mono text-xs uppercase tracking-wide outline-none"
      />
    </label>
  )
}

/** The popular colours; the ring glides to the choice. Arrow keys move it. */
function PopularColors({ onPick }: { onPick: (key: AccentKey) => void }) {
  const t = useT()
  const accent = usePrefs((p) => p.accent)
  const index = POPULAR.indexOf(accent as AccentKey)
  return (
    <div
      role="radiogroup"
      aria-label={t("appearance.popularColors")}
      className="grid grid-cols-8 gap-1.5"
      onKeyDown={(e) => {
        const step = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 0
        if (!step) return
        e.preventDefault()
        const next = (Math.max(index, 0) + step + POPULAR.length) % POPULAR.length
        onPick(POPULAR[next])
        e.currentTarget.querySelectorAll<HTMLButtonElement>("[role=radio]")[next]?.focus()
      }}
    >
      {POPULAR.map((key, i) => {
        const on = accent === key
        const a = ACCENTS.find((x) => x.key === key) ?? ACCENTS[0]
        const name = t(`appearance.accents.${key}`) + (key === DEFAULT_ACCENT ? ` · ${t("appearance.defaultColor")}` : "")
        return (
          <button
            key={key}
            type="button"
            role="radio"
            aria-checked={on}
            aria-label={name}
            title={name}
            tabIndex={on || (index < 0 && i === 0) ? 0 : -1}
            onClick={() => onPick(key)}
            className="relative aspect-square rounded-md outline-none transition-transform duration-300 ease-[cubic-bezier(0.34,1.56,0.64,1)] hover:scale-110 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-popover active:scale-90"
          >
            <span
              aria-hidden
              className="absolute inset-0 rounded-[inherit] bg-[oklch(0.56_var(--sw-c)_var(--sw-h))] shadow-[inset_0_0_0_1px_oklch(0_0_0/10%)] dark:bg-[oklch(0.74_var(--sw-c)_var(--sw-h))]"
              style={{ ["--sw-c" as string]: a.c, ["--sw-h" as string]: a.h }}
            />
            {on && (
              <motion.span
                layoutId="accent-popular-ring"
                aria-hidden
                transition={springs.snappy}
                className="pointer-events-none absolute -inset-[3px] flex items-center justify-center rounded-[8px] shadow-[0_0_0_1.5px_var(--foreground)]"
              >
                <Check className="size-3 text-white drop-shadow-[0_1px_1px_oklch(0_0_0/30%)] dark:text-black dark:drop-shadow-none" strokeWidth={3} />
              </motion.span>
            )}
          </button>
        )
      })}
    </div>
  )
}

/* ------------------------------------------------------------------ */
/*  The popover                                                        */
/* ------------------------------------------------------------------ */

/**
 * Saturation/brightness plane, hue strip, HEX field (with an eyedropper where
 * the browser has one) and the popular colours. Mounted only while open, so it
 * starts from the accent in use.
 */
function AccentPicker() {
  const t = useT()
  const [hsv, setHsv] = useState<Hsv>(() => hexToHsv(accentHex(prefsStore.get())) ?? { h: 152, s: 0.7, v: 0.6 })
  const dropper = useEyeDropper()
  const hex = hsvToHex(hsv).toUpperCase()

  // Dragging fires faster than frames; the workspace recolours once per frame.
  const frame = useRef(0)
  const pending = useRef<string | null>(null)
  useEffect(
    () => () => {
      if (!frame.current) return
      cancelAnimationFrame(frame.current)
      if (pending.current) applyHex(pending.current)
    },
    [],
  )
  const drag = (next: Hsv) => {
    setHsv(next)
    pending.current = hsvToHex(next)
    if (!frame.current)
      frame.current = requestAnimationFrame(() => {
        frame.current = 0
        if (pending.current) applyHex(pending.current)
        pending.current = null
      })
  }
  const jump = (nextHex: string) => {
    if (!applyHex(nextHex)) return
    setHsv((cur) => hexToHsv(nextHex, cur.h) ?? cur)
  }

  const pick = async () => {
    if (!dropper) return
    try {
      const { sRGBHex } = await new dropper().open()
      jump(sRGBHex)
    } catch {
      /* Escape closes the eyedropper without a colour. */
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <SaturationPlane hsv={hsv} hex={hex} label={t("appearance.saturationBrightness")} onChange={drag} />
      <div className="flex items-center gap-2.5">
        {dropper && (
          <button
            type="button"
            onClick={pick}
            aria-label={t("appearance.eyedropper")}
            title={t("appearance.eyedropper")}
            className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground outline-none transition-[color,background-color,transform] duration-200 hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring active:scale-90"
          >
            <Pipette className="size-3.5" />
          </button>
        )}
        <HueStrip hue={hsv.h} label={t("appearance.hue")} onChange={(h) => drag({ ...hsv, h })} />
      </div>
      <HexField value={hex} onCommit={jump} />
      <div className="flex flex-col gap-2 border-t pt-3">
        <p className="text-2xs font-medium uppercase tracking-[0.12em] text-subtle-foreground">{t("appearance.popularColors")}</p>
        <PopularColors
          onPick={(key) => {
            choosePreset(key)
            setHsv((cur) => hexToHsv(presetHex(key), cur.h) ?? cur)
          }}
        />
      </div>
    </div>
  )
}

/**
 * The accent swatch. Hovering it peeks the picker; clicking (or touching the
 * picker) keeps it open until a click outside or Escape.
 */
function AccentSwatch({ label }: { label: string }) {
  const [open, setOpen] = useState(false)
  const pinned = useRef(false)
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)
  useEffect(() => () => clearTimeout(timer.current), [])

  const later = (fn: () => void, ms: number) => {
    clearTimeout(timer.current)
    timer.current = setTimeout(fn, ms)
  }
  const hoverIn = (e: PointerEvent) => {
    if (e.pointerType !== "mouse") return
    if (open) clearTimeout(timer.current)
    else later(() => setOpen(true), 90)
  }
  const hoverOut = (e: PointerEvent) => {
    if (e.pointerType !== "mouse" || pinned.current) return
    later(() => setOpen(false), open ? 220 : 0)
  }

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        clearTimeout(timer.current)
        if (!next) pinned.current = false
        setOpen(next)
      }}
    >
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={label}
          onPointerEnter={hoverIn}
          onPointerLeave={hoverOut}
          onClick={(e) => {
            // A click on a peeking picker keeps it open instead of closing it.
            if (open && !pinned.current) e.preventDefault()
            pinned.current = true
          }}
          className="group/swatch relative size-8 shrink-0 rounded-lg outline-none transition-transform duration-300 ease-[cubic-bezier(0.34,1.56,0.64,1)] hover:scale-105 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-card active:scale-95"
        >
          <span aria-hidden className="absolute inset-0 rounded-[inherit] bg-brand shadow-[inset_0_0_0_1px_oklch(0_0_0/10%)] transition-colors duration-300" />
          <span
            aria-hidden
            className="pointer-events-none absolute -inset-[3px] scale-90 rounded-[11px] opacity-0 shadow-[0_0_0_1.5px_var(--foreground)] transition-[opacity,transform] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] group-data-[state=open]/swatch:scale-100 group-data-[state=open]/swatch:opacity-100"
          />
        </button>
      </PopoverTrigger>
      <PopoverContent
        side="bottom"
        align="end"
        sideOffset={8}
        collisionPadding={12}
        onOpenAutoFocus={(e) => {
          // A peek on hover leaves focus where it is.
          if (!pinned.current) e.preventDefault()
        }}
        onPointerEnter={hoverIn}
        onPointerLeave={hoverOut}
        onPointerDown={() => {
          pinned.current = true
        }}
        className="w-60 rounded-2xl p-3"
      >
        <AccentPicker />
      </PopoverContent>
    </Popover>
  )
}

/** "Accent colour" with the current colour's swatch; the picker opens from it. */
export function AccentColorRow() {
  const t = useT()
  const accent = usePrefs((p) => p.accent)
  const hex = usePrefs(accentHex)
  const name =
    accent === "custom"
      ? `${t("appearance.custom")} · ${hex}`
      : t(`appearance.accents.${accent}`) + (accent === DEFAULT_ACCENT ? ` · ${t("appearance.defaultColor")}` : "")
  return (
    <SettingsRow label={t("appearance.accentColor")} hint={name}>
      <AccentSwatch label={`${t("appearance.accentColor")}: ${name}`} />
    </SettingsRow>
  )
}
