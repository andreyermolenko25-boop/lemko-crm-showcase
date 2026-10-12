"use client"

import { useEffect, useRef, useState } from "react"
import { AnimatePresence, motion } from "motion/react"
import * as SliderPrimitive from "@radix-ui/react-slider"
import { RotateCcw } from "lucide-react"
import { cn } from "@/lib/utils"
import { springs } from "@/lib/core/motion"
import {
  DEFAULT_TEXT_SIZE,
  TEXT_SIZE_MAX,
  TEXT_SIZE_MIN,
  TEXT_SIZE_PRESETS,
  clampTextSize,
  setPrefs,
  usePrefs,
} from "@/lib/core/prefs"
import { useT } from "@/components/i18n-provider"
import { Button } from "@/components/ui/button"

/*
 * The control is measured in px, not rem: the size it changes is 1rem of the
 * whole UI, so a rem-sized slider would grow under the pointer while dragged.
 */
const THUMB = 18
const TICKS = Array.from({ length: TEXT_SIZE_MAX - TEXT_SIZE_MIN + 1 }, (_, i) => TEXT_SIZE_MIN + i)
const at = (n: number) => (n - TEXT_SIZE_MIN) / (TEXT_SIZE_MAX - TEXT_SIZE_MIN)
/** Same inset Radix gives the thumb, so ticks sit exactly under its centre. */
const inset = (p: number) => `calc(${THUMB / 2}px + (100% - ${THUMB}px) * ${p})`

/** The number rolls up when it grows and down when it shrinks. */
function RollingValue({ value, className }: { value: number; className?: string }) {
  const last = useRef(value)
  const dir = value >= last.current ? 1 : -1
  useEffect(() => {
    last.current = value
  }, [value])
  return (
    <span className={cn("relative inline-flex overflow-hidden tabular-nums", className)}>
      <AnimatePresence mode="popLayout" initial={false} custom={dir}>
        <motion.span
          key={value}
          custom={dir}
          variants={{
            enter: (d: number) => ({ y: d * 12, opacity: 0, filter: "blur(2px)" }),
            center: { y: 0, opacity: 1, filter: "blur(0px)" },
            exit: (d: number) => ({ y: d * -12, opacity: 0, filter: "blur(2px)" }),
          }}
          initial="enter"
          animate="center"
          exit="exit"
          transition={springs.snappy}
        >
          {value}
        </motion.span>
      </AnimatePresence>
    </span>
  )
}

function StepButton({ label, disabled, onClick, large }: { label: string; disabled: boolean; onClick: () => void; large?: boolean }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className="flex size-[32px] shrink-0 items-center justify-center rounded-full border border-border bg-card font-semibold text-muted-foreground outline-none transition-[color,border-color,transform] duration-200 hover:border-border-strong hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring active:scale-90 disabled:pointer-events-none disabled:opacity-35"
    >
      <span aria-hidden className={large ? "text-[17px] leading-none" : "text-[11px] leading-none"}>
        A
      </span>
    </button>
  )
}

/**
 * Text size: a slider over every size from 12 to 24 px (arrow keys, Home/End
 * work), − / + for one step, and five one-tap presets. Every change applies to
 * the whole workspace at once.
 */
export function TextSizeSteps({ className }: { className?: string }) {
  const t = useT()
  const size = clampTextSize(usePrefs((p) => p.textSize))
  const [dragging, setDragging] = useState(false)
  const set = (n: number) => setPrefs({ textSize: clampTextSize(n) })

  return (
    <div className={cn("flex w-[340px] max-w-full flex-col gap-[10px]", className)}>
      <div className="flex items-center gap-[10px]">
        <StepButton label={t("textSize.smaller")} disabled={size <= TEXT_SIZE_MIN} onClick={() => set(size - 1)} />
        <SliderPrimitive.Root
          min={TEXT_SIZE_MIN}
          max={TEXT_SIZE_MAX}
          step={1}
          value={[size]}
          onValueChange={([n]) => set(n)}
          onPointerDown={() => setDragging(true)}
          onPointerUp={() => setDragging(false)}
          onPointerCancel={() => setDragging(false)}
          onBlur={() => setDragging(false)}
          className="relative flex h-[34px] min-w-0 flex-1 touch-none select-none items-center"
        >
          <SliderPrimitive.Track className="relative h-[4px] grow rounded-full bg-muted">
            <SliderPrimitive.Range className="absolute h-full rounded-full bg-foreground" />
          </SliderPrimitive.Track>
          {/* A mark for every size; the default one is taller. */}
          <span aria-hidden className="pointer-events-none absolute inset-x-0 bottom-0 h-[8px]">
            {TICKS.map((n) => (
              <span
                key={n}
                className={cn(
                  "absolute bottom-0 w-px -translate-x-1/2 rounded-full transition-colors duration-200",
                  n === DEFAULT_TEXT_SIZE ? "h-[8px]" : "h-[4px]",
                  n <= size ? "bg-foreground/55" : "bg-border-strong",
                )}
                style={{ left: inset(at(n)) }}
              />
            ))}
          </span>
          <SliderPrimitive.Thumb
            aria-label={t("textSize.label")}
            aria-valuetext={`${size} px`}
            className="relative block size-[18px] rounded-full border-[3px] border-card bg-foreground shadow-[0_0_0_1px_oklch(0_0_0/12%),0_2px_6px_oklch(0_0_0/22%)] outline-none transition-transform duration-200 hover:scale-110 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-card active:scale-110"
          >
            {/* While dragging, a bubble above the thumb shows the size itself. */}
            <AnimatePresence>
              {dragging && (
                <motion.span
                  initial={{ opacity: 0, y: 6, scale: 0.85 }}
                  animate={{ opacity: 1, y: 0, scale: 1 }}
                  exit={{ opacity: 0, y: 4, scale: 0.9 }}
                  transition={springs.snappy}
                  className="pointer-events-none absolute bottom-[calc(100%+10px)] left-1/2 -ml-[26px] flex h-[40px] w-[52px] origin-bottom items-center justify-center rounded-[10px] bg-foreground font-semibold leading-none text-background shadow-[0_8px_20px_-8px_oklch(0_0_0/45%)]"
                >
                  <span style={{ fontSize: Math.min(size, 22) }}>Aa</span>
                </motion.span>
              )}
            </AnimatePresence>
          </SliderPrimitive.Thumb>
        </SliderPrimitive.Root>
        <StepButton large label={t("textSize.larger")} disabled={size >= TEXT_SIZE_MAX} onClick={() => set(size + 1)} />
        <span className="flex w-[46px] shrink-0 items-baseline justify-end gap-[2px] text-[14px] font-semibold leading-[20px]">
          <RollingValue value={size} className="h-[20px]" />
          <span className="text-[11px] font-medium text-muted-foreground">px</span>
        </span>
      </div>

      <div role="group" aria-label={t("textSize.presets")} className="grid grid-cols-5 gap-[6px]">
        {TEXT_SIZE_PRESETS.map((n, i) => {
          const on = n === size
          return (
            <button
              key={n}
              type="button"
              aria-pressed={on}
              aria-label={n === DEFAULT_TEXT_SIZE ? `${n} px · ${t("textSize.default")}` : `${n} px`}
              title={n === DEFAULT_TEXT_SIZE ? t("textSize.default") : undefined}
              onClick={() => set(n)}
              className={cn(
                "relative flex h-[48px] flex-col items-center justify-center gap-[3px] rounded-[10px] border leading-none outline-none transition-[border-color,background-color,color,box-shadow,transform] duration-200 hover:-translate-y-px focus-visible:ring-2 focus-visible:ring-ring active:translate-y-0 active:scale-[0.97]",
                on
                  ? "border-foreground bg-card text-foreground shadow-[0_0_0_1px_var(--foreground)]"
                  : "border-border bg-elevated text-muted-foreground hover:border-border-strong hover:bg-card hover:text-foreground",
              )}
            >
              <span aria-hidden className="font-semibold" style={{ fontSize: 12 + i * 2 }}>
                Aa
              </span>
              <span className="flex items-center gap-[3px] text-[10px] font-medium tabular-nums opacity-80">
                {n}
                {n === DEFAULT_TEXT_SIZE && <span aria-hidden className="size-[4px] rounded-full bg-current" />}
              </span>
            </button>
          )
        })}
      </div>
    </div>
  )
}

/** The popover body behind the toolbar's "text size" button. */
export function TextSizePanel() {
  const t = useT()
  const size = clampTextSize(usePrefs((p) => p.textSize))
  const isDefault = size === DEFAULT_TEXT_SIZE
  return (
    <div className="flex flex-col gap-[14px]">
      <div className="min-w-0">
        <p className="text-[14px] font-semibold leading-[20px]">{t("textSize.label")}</p>
        <p className="text-[12px] leading-[16px] text-muted-foreground">{t("textSize.description")}</p>
      </div>
      <TextSizeSteps className="w-full" />
      {/* Real text at the chosen size (it is in rem, so it follows live). */}
      <p className="rounded-[10px] border bg-background px-3 py-2.5 text-sm leading-relaxed text-pretty">{t("textSize.preview")}</p>
      <Button variant="ghost" size="xs" className="self-start" disabled={isDefault} onClick={() => setPrefs({ textSize: DEFAULT_TEXT_SIZE })}>
        <RotateCcw /> {isDefault ? t("textSize.default") : t("textSize.reset")}
      </Button>
    </div>
  )
}
