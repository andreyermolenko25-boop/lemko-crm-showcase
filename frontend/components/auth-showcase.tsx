"use client"

import type React from "react"
import { useEffect, useState } from "react"
import { AnimatePresence, motion, useReducedMotion, animate } from "motion/react"
import { ArrowUpRight, CalendarCheck, CheckCircle2, Receipt, Sparkles, Workflow } from "lucide-react"
import { useT } from "@/components/i18n-provider"
import { duration, easing, stagger } from "@/lib/core/motion"

const WORDS = ["bookings", "invoicing", "projects", "support", "inventory"] as const

const POINTS = [
  { icon: CalendarCheck, key: "modules" },
  { icon: Sparkles, key: "tables" },
  { icon: Workflow, key: "dashboards" },
] as const

/** One surface for every card: white, hairline border, a barely-there shadow. */
const CARD = "rounded-2xl border border-border bg-card shadow-[var(--shadow-card)]"

function RotatingWord() {
  const t = useT()
  const [i, setI] = useState(0)
  useEffect(() => {
    const timer = setInterval(() => setI((n) => (n + 1) % WORDS.length), 2800)
    return () => clearInterval(timer)
  }, [])
  return (
    <span className="relative inline-grid overflow-hidden align-bottom">
      <AnimatePresence mode="popLayout" initial={false}>
        <motion.span
          key={WORDS[i]}
          initial={{ y: "100%", opacity: 0 }}
          animate={{ y: "0%", opacity: 1 }}
          exit={{ y: "-100%", opacity: 0 }}
          transition={{ duration: duration.slow, ease: easing.smooth }}
          className="col-start-1 row-start-1 pb-1"
        >
          {t(`auth.aside.words.${WORDS[i]}`)}
        </motion.span>
      </AnimatePresence>
    </span>
  )
}

function CountUp({ to, prefix = "", suffix = "", decimals = 0 }: { to: number; prefix?: string; suffix?: string; decimals?: number }) {
  const [v, setV] = useState(0)
  useEffect(() => {
    const c = animate(0, to, { duration: 1.6, delay: 0.4, ease: easing.smooth, onUpdate: setV })
    return () => c.stop()
  }, [to])
  return (
    <span className="tabular">
      {prefix}
      {v.toFixed(decimals)}
      {suffix}
    </span>
  )
}

const SPARK = "M0 46 C 18 44, 26 30, 44 32 S 70 40, 84 26 S 112 18, 128 22 S 156 6, 176 8 S 196 4, 210 2"

function RevenueCard() {
  const t = useT()
  return (
    <div className={`w-[19rem] p-4 ${CARD}`}>
      <div className="flex items-center justify-between">
        <p className="text-xs font-medium text-muted-foreground">{t("auth.aside.revenueTitle")}</p>
        <span className="flex items-center gap-0.5 rounded-full border border-border px-1.5 py-0.5 text-2xs font-semibold text-foreground">
          <ArrowUpRight className="size-3" /> 18.2%
        </span>
      </div>
      <p className="mt-1 text-2xl font-semibold tracking-tight">
        <CountUp to={12.48} prefix="€" suffix="M" decimals={2} />
      </p>
      <svg viewBox="0 0 210 50" className="mt-3 h-14 w-full overflow-visible" aria-hidden>
        <motion.path
          d={SPARK}
          fill="none"
          stroke="var(--foreground)"
          strokeWidth="2"
          strokeLinecap="round"
          initial={{ pathLength: 0 }}
          animate={{ pathLength: 1 }}
          transition={{ delay: 0.3, duration: 1.6, ease: easing.smooth }}
        />
        <motion.circle
          cx="210"
          cy="2"
          r="3.5"
          fill="var(--foreground)"
          initial={{ scale: 0 }}
          animate={{ scale: [0, 1.3, 1] }}
          transition={{ delay: 1.7, duration: duration.slow }}
        />
      </svg>
    </div>
  )
}

function PipelineCard() {
  const t = useT()
  const stages = [
    { key: "lead", v: 86 },
    { key: "qualified", v: 64 },
    { key: "proposal", v: 41 },
    { key: "won", v: 28 },
  ] as const
  return (
    <div className={`w-[15rem] p-4 ${CARD}`}>
      <p className="text-xs font-medium text-muted-foreground">{t("auth.aside.pipeline")}</p>
      <div className="mt-3 flex flex-col gap-2">
        {stages.map((s, i) => (
          <div key={s.key} className="flex items-center gap-2 text-2xs">
            <span className="w-14 shrink-0 truncate text-muted-foreground">{t(`auth.aside.stages.${s.key}`)}</span>
            <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-foreground/[0.07]">
              <motion.div
                className="h-full rounded-full bg-foreground"
                initial={{ width: 0 }}
                animate={{ width: `${s.v}%` }}
                transition={{ delay: 0.5 + i * 0.1, duration: 0.9, ease: easing.smooth }}
              />
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

const TOASTS = [
  { icon: CheckCircle2, key: "dealWon" },
  { icon: CalendarCheck, key: "bookingConfirmed" },
  { icon: Receipt, key: "invoicePaid" },
] as const

function LiveToast() {
  const t = useT()
  const [i, setI] = useState(0)
  useEffect(() => {
    const timer = setInterval(() => setI((n) => (n + 1) % TOASTS.length), 3400)
    return () => clearInterval(timer)
  }, [])
  const toast = TOASTS[i]
  return (
    <div className="h-[3.75rem] w-[16rem]">
      <AnimatePresence mode="wait">
        <motion.div
          key={toast.key}
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -6 }}
          transition={{ duration: duration.normal, ease: easing.smooth }}
          className={`flex items-center gap-3 p-3 ${CARD}`}
        >
          <span className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-border">
            <toast.icon className="size-4" />
          </span>
          <span className="min-w-0 leading-tight">
            <span className="block text-sm font-semibold">{t(`auth.aside.toasts.${toast.key}`)}</span>
            <span className="block truncate text-xs text-muted-foreground">{t(`auth.aside.toasts.${toast.key}Text`)}</span>
          </span>
        </motion.div>
      </AnimatePresence>
    </div>
  )
}

/* Fades a card in, then lets it breathe: a slow, small vertical drift. */
function Float({ children, delay, drift }: { children: React.ReactNode; delay: number; drift: number }) {
  const reduce = useReducedMotion()
  return (
    <motion.div initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: duration.slow, delay, ease: easing.smooth }}>
      <motion.div
        animate={reduce ? undefined : { y: [0, drift, 0] }}
        transition={{ duration: 7 + Math.abs(drift) / 2, repeat: Infinity, ease: "easeInOut", delay: delay + 0.7 }}
      >
        {children}
      </motion.div>
    </motion.div>
  )
}

/* The right-hand panel of the sign-in / sign-up screens. Same language as the marketing site. */
export function AuthShowcase() {
  const t = useT()
  const item = (x = 0, y = 10) => ({
    hidden: { opacity: 0, x, y },
    show: { opacity: 1, x: 0, y: 0, transition: { duration: duration.slow, ease: easing.smooth } },
  })

  return (
    <aside className="relative hidden overflow-hidden border-l border-border bg-elevated lg:flex lg:flex-col lg:justify-center lg:px-12 xl:px-16">
      <motion.div
        className="relative"
        initial="hidden"
        animate="show"
        variants={{ show: { transition: { staggerChildren: stagger.normal + 0.03, delayChildren: 0.1 } } }}
      >
        <motion.p
          variants={item()}
          className="inline-flex items-center gap-2 rounded-full border border-border bg-card px-3 py-1 text-xs font-semibold text-muted-foreground"
        >
          <span className="relative flex size-2">
            <span className="absolute inline-flex size-full animate-ping rounded-full bg-foreground opacity-30" />
            <span className="relative inline-flex size-2 rounded-full bg-foreground" />
          </span>
          {t("auth.aside.eyebrow")}
        </motion.p>

        <motion.h2 variants={item(0, 14)} className="mt-4 text-[2.1rem] font-semibold leading-[1.1] tracking-tight">
          {t("auth.aside.titleLine1")}
          <br />
          <RotatingWord /> {t("auth.aside.titleLine2")}
        </motion.h2>

        <div className="relative mt-9 h-[17rem]">
          <div className="absolute left-0 top-0">
            <Float delay={0.3} drift={-5}>
              <RevenueCard />
            </Float>
          </div>
          <div className="absolute right-0 top-20 xl:right-2">
            <Float delay={0.5} drift={6}>
              <PipelineCard />
            </Float>
          </div>
          <div className="absolute bottom-0 left-0 z-10">
            <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: duration.slow, delay: 0.8, ease: easing.smooth }}>
              <LiveToast />
            </motion.div>
          </div>
        </div>

        <ul className="mt-10 flex flex-col gap-1">
          {POINTS.map((p) => (
            <motion.li
              key={p.key}
              variants={item(-10, 0)}
              className="flex items-center gap-3.5 rounded-xl p-2 transition-colors duration-150 hover:bg-card"
            >
              <span className="flex size-10 shrink-0 items-center justify-center rounded-xl border border-border bg-card">
                <p.icon className="size-[1.1rem]" />
              </span>
              <span className="min-w-0">
                <span className="block text-sm font-semibold">{t(`auth.aside.points.${p.key}Title`)}</span>
                <span className="block text-sm text-muted-foreground">{t(`auth.aside.points.${p.key}Text`)}</span>
              </span>
            </motion.li>
          ))}
        </ul>
      </motion.div>
    </aside>
  )
}
