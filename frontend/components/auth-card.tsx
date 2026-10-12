"use client"

import type React from "react"
import Link from "next/link"
import { useRouter, useSearchParams } from "next/navigation"
import { useEffect, useState } from "react"
import { AnimatePresence, motion } from "motion/react"
import { Building2, Mail, Lock, Eye, EyeOff, ArrowRight, CircleAlert, CircleCheck, Fingerprint, KeyRound, MessageSquare, Smartphone } from "lucide-react"
import { cn } from "@/lib/utils"
import { ApiError } from "@/lib/api"
import {
  fetchProviders,
  login,
  registerStudio,
  requestMagicLink,
  sendLoginSms,
  startOAuth,
  verifyMfa,
  verifyPasskey,
  type AuthProviders,
  type LoginStep,
  type MfaMethod,
  type OAuthProvider,
} from "@/lib/auth"
import { describeApiError } from "@/lib/i18n/errors"
import { passkeysSupported } from "@/lib/webauthn"
import { useT } from "@/components/i18n-provider"
import { InputOTP, InputOTPGroup, InputOTPSeparator, InputOTPSlot } from "@/components/ui/input-otp"

type Props = {
  mode: "login" | "register"
}

type FieldErrors = {
  companyName?: string
  email?: string
  password?: string
}

const MIN_PASSWORD = 10
const GRID_COLS: Record<number, string> = { 1: "", 2: "grid-cols-2", 3: "grid-cols-3" }

function FieldError({ message }: { message?: string }) {
  return (
    <AnimatePresence mode="wait">
      {message ? (
        <motion.p
          key={message}
          role="alert"
          initial={{ opacity: 0, y: -4, height: 0 }}
          animate={{ opacity: 1, y: 0, height: "auto" }}
          exit={{ opacity: 0, y: -2, height: 0 }}
          transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
          className="overflow-hidden text-xs font-medium text-rose-500 dark:text-rose-400"
        >
          <span className="mt-1.5 inline-flex items-center gap-1.5">
            <CircleAlert className="size-3 shrink-0 opacity-80" />
            {message}
          </span>
        </motion.p>
      ) : null}
    </AnimatePresence>
  )
}

export function Field({
  icon: Icon,
  label,
  type = "text",
  placeholder,
  toggle,
  name,
  value,
  onChange,
  autoComplete,
  error,
  aside,
}: {
  icon: typeof Mail
  label: string
  type?: string
  placeholder: string
  toggle?: boolean
  name: string
  value: string
  onChange: (value: string) => void
  autoComplete?: string
  error?: string
  aside?: React.ReactNode
}) {
  const t = useT()
  const [show, setShow] = useState(false)
  const inputType = toggle ? (show ? "text" : "password") : type
  return (
    <label className="flex flex-col gap-1.5">
      <span className="flex items-center justify-between text-sm font-medium text-muted-foreground">
        {label}
        {aside}
      </span>
      <motion.div
        animate={error ? { x: [0, -4, 4, -2, 2, 0] } : { x: 0 }}
        transition={error ? { duration: 0.36, ease: "easeOut" } : undefined}
        className={cn(
          "flex h-11 items-center gap-2.5 rounded-xl border border-input bg-card px-3.5 transition-[box-shadow,border-color] duration-200 focus-within:border-brand/60 focus-within:ring-3 focus-within:ring-ring/25",
          error &&
            "border-destructive/50 ring-3 ring-destructive/10",
        )}
      >
        <Icon
          className={cn(
            "size-4 shrink-0 transition-colors",
            error ? "text-rose-500" : "text-muted-foreground",
          )}
        />
        <input
          name={name}
          type={inputType}
          placeholder={placeholder}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          autoComplete={autoComplete}
          aria-invalid={Boolean(error)}
          className="w-full bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground/60"
        />
        {toggle && (
          <button
            type="button"
            onClick={() => setShow((s) => !s)}
            aria-label={show ? t("auth.hidePassword") : t("auth.showPassword")}
            className="rounded-lg p-0.5 text-muted-foreground transition-colors hover:text-foreground"
          >
            {show ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
          </button>
        )}
      </motion.div>
      <FieldError message={error} />
    </label>
  )
}

export function FormBanner({ message, tone = "error" }: { message: string | null; tone?: "error" | "success" }) {
  return (
    <AnimatePresence mode="wait">
      {message ? (
        <motion.div
          key={message}
          role={tone === "error" ? "alert" : "status"}
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -4 }}
          transition={{ duration: 0.24, ease: [0.22, 1, 0.36, 1] }}
          className={cn(
            "flex items-start gap-2.5 rounded-2xl border px-3.5 py-3 text-sm",
            tone === "error"
              ? "border-rose-500/15 bg-rose-500/[0.07] text-rose-600 dark:text-rose-300"
              : "border-emerald-500/20 bg-emerald-500/[0.07] text-emerald-700 dark:text-emerald-300",
          )}
        >
          {tone === "error" ? <CircleAlert className="mt-0.5 size-4 shrink-0 opacity-90" /> : <CircleCheck className="mt-0.5 size-4 shrink-0 opacity-90" />}
          <p className="min-w-0 leading-snug">{message}</p>
        </motion.div>
      ) : null}
    </AnimatePresence>
  )
}

export function SubmitButton({ pending, children }: { pending?: boolean; children: React.ReactNode }) {
  const t = useT()
  return (
    <motion.button
      type="submit"
      disabled={pending}
      whileTap={{ scale: 0.985 }}
      className="flex h-11 items-center justify-center gap-2 rounded-xl bg-primary px-5 text-sm font-semibold text-primary-foreground transition-colors hover:bg-primary/88 disabled:pointer-events-none disabled:opacity-60"
    >
      {pending ? t("auth.pleaseWait") : children}
    </motion.button>
  )
}

export function CardShell({ title, subtitle, children }: { title: string; subtitle?: string; children: React.ReactNode }) {
  const t = useT()
  return (
    <motion.div
      initial={{ opacity: 0, y: 14, scale: 0.98 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      transition={{ duration: 0.4, ease: [0.22, 1, 0.36, 1] }}
      className="surface w-full max-w-[25rem] overflow-hidden rounded-2xl shadow-[var(--shadow-pop)]"
    >
      <div className="relative px-7 pb-8 pt-8 sm:px-8">
        <div className="relative mb-7">
          <p className="mb-2 text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground">{t("auth.brand")}</p>
          <h1 className="text-[1.65rem] font-semibold tracking-tight text-foreground">{title}</h1>
          {subtitle && <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">{subtitle}</p>}
        </div>
        {children}
      </div>
    </motion.div>
  )
}

export function isValidEmail(value: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)
}

function errorText(err: unknown, fallback: string): string {
  return err instanceof ApiError ? err.message : fallback
}

const PROVIDER_LABEL: Record<OAuthProvider, string> = { google: "Google", microsoft: "Microsoft", apple: "Apple" }

export function ProviderIcon({ provider }: { provider: OAuthProvider }) {
  if (provider === "google") {
    return (
      <svg viewBox="0 0 24 24" className="size-4" aria-hidden="true">
        <path fill="#4285F4" d="M22.6 12.2c0-.8-.1-1.5-.2-2.2H12v4.2h5.9a5 5 0 0 1-2.2 3.3v2.7h3.6c2.1-1.9 3.3-4.8 3.3-8Z" />
        <path fill="#34A853" d="M12 23c3 0 5.5-1 7.3-2.7l-3.6-2.7c-1 .7-2.2 1.1-3.7 1.1-2.9 0-5.3-1.9-6.2-4.5H2.1v2.8A11 11 0 0 0 12 23Z" />
        <path fill="#FBBC05" d="M5.8 14.2a6.6 6.6 0 0 1 0-4.3V7.1H2.1a11 11 0 0 0 0 9.9l3.7-2.8Z" />
        <path fill="#EA4335" d="M12 5.4c1.6 0 3.1.6 4.2 1.7l3.2-3.2A11 11 0 0 0 2.1 7.1l3.7 2.8C6.7 7.3 9.1 5.4 12 5.4Z" />
      </svg>
    )
  }
  if (provider === "microsoft") {
    return (
      <svg viewBox="0 0 24 24" className="size-4" aria-hidden="true">
        <path fill="#F25022" d="M2 2h9.5v9.5H2z" />
        <path fill="#7FBA00" d="M12.5 2H22v9.5h-9.5z" />
        <path fill="#00A4EF" d="M2 12.5h9.5V22H2z" />
        <path fill="#FFB900" d="M12.5 12.5H22V22h-9.5z" />
      </svg>
    )
  }
  return (
    <svg viewBox="0 0 24 24" className="size-4 fill-current" aria-hidden="true">
      <path d="M16.4 12.6c0-2.6 2.1-3.8 2.2-3.9a4.8 4.8 0 0 0-3.8-2c-1.6-.2-3.1.9-3.9.9-.8 0-2-.9-3.4-.9a5 5 0 0 0-4.2 2.6c-1.8 3.1-.5 7.7 1.3 10.2.9 1.2 1.9 2.6 3.2 2.6 1.3-.1 1.8-.8 3.3-.8 1.6 0 2 .8 3.4.8s2.3-1.3 3.1-2.5c1-1.4 1.4-2.8 1.4-2.9 0 0-2.6-1-2.6-4.1ZM13.9 5c.7-.8 1.2-2 1-3.1-1 .1-2.2.7-2.9 1.5-.6.7-1.2 1.9-1 3 1.1.1 2.2-.6 2.9-1.4Z" />
    </svg>
  )
}

/* -------------------------------------------------------------------------- */
/*  Second step: authenticator / SMS / passkey / backup code                    */
/* -------------------------------------------------------------------------- */

const METHOD_ORDER: MfaMethod[] = ["passkey", "totp", "sms", "backup"]

export function SixDigits({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <InputOTP autoFocus maxLength={6} value={value} onChange={onChange} containerClassName="justify-center" inputMode="numeric" autoComplete="one-time-code">
      <InputOTPGroup>
        {[0, 1, 2].map((i) => (
          <InputOTPSlot key={i} index={i} className="size-11 text-base" />
        ))}
      </InputOTPGroup>
      <InputOTPSeparator />
      <InputOTPGroup>
        {[3, 4, 5].map((i) => (
          <InputOTPSlot key={i} index={i} className="size-11 text-base" />
        ))}
      </InputOTPGroup>
    </InputOTP>
  )
}

export function MfaStep({ methods, onDone, onRestart }: { methods: MfaMethod[]; onDone: () => void; onRestart: () => void }) {
  const t = useT()
  const available = METHOD_ORDER.filter((m) => methods.includes(m) && (m !== "passkey" || passkeysSupported()))
  const [method, setMethod] = useState<MfaMethod>(available[0] ?? "backup")
  const [code, setCode] = useState("")
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [smsTo, setSmsTo] = useState<string | null>(null)
  const [cooldown, setCooldown] = useState(0)

  useEffect(() => {
    if (cooldown <= 0) return
    const timer = window.setTimeout(() => setCooldown((c) => c - 1), 1000)
    return () => window.clearTimeout(timer)
  }, [cooldown])

  async function finish(step: Promise<LoginStep>) {
    setPending(true)
    setError(null)
    try {
      const result = await step
      if (result.done) onDone()
    } catch (err) {
      setCode("")
      setError(errorText(err, t("auth.errors.generic")))
      if (err instanceof ApiError && err.code === "mfa_expired") window.setTimeout(onRestart, 1500)
    } finally {
      setPending(false)
    }
  }

  async function sendSms() {
    setPending(true)
    setError(null)
    try {
      setSmsTo(await sendLoginSms())
      setCooldown(30)
    } catch (err) {
      setError(errorText(err, t("auth.errors.generic")))
    } finally {
      setPending(false)
    }
  }

  async function confirmPasskey() {
    setPending(true)
    setError(null)
    try {
      const result = await verifyPasskey()
      if (result.done) onDone()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("auth.mfa.passkeyFailed"))
    } finally {
      setPending(false)
    }
  }

  // Six digits typed → verify right away.
  useEffect(() => {
    if ((method === "totp" || (method === "sms" && smsTo)) && code.length === 6 && !pending) {
      void finish(verifyMfa(method, code))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [code])

  const hint =
    method === "totp"
      ? t("auth.mfa.totpHint")
      : method === "sms"
        ? smsTo
          ? t("auth.mfa.smsSentTo", { phone: smsTo })
          : t("auth.mfa.smsHint")
        : method === "passkey"
          ? t("auth.mfa.passkeyHint")
          : t("auth.mfa.backupHint")

  const switchLabel: Record<MfaMethod, string> = {
    passkey: t("auth.mfa.usePasskey"),
    totp: t("auth.mfa.useTotp"),
    sms: t("auth.mfa.useSms"),
    backup: t("auth.mfa.useBackup"),
  }
  const switchIcon: Record<MfaMethod, typeof Mail> = { passkey: Fingerprint, totp: Smartphone, sms: MessageSquare, backup: KeyRound }

  return (
    <CardShell title={t("auth.mfa.title")} subtitle={hint}>
      <form
        noValidate
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault()
          if (method === "passkey") void confirmPasskey()
          else if (method === "sms" && !smsTo) void sendSms()
          else void finish(verifyMfa(method, code))
        }}
      >
        {(method === "totp" || (method === "sms" && smsTo)) && <SixDigits value={code} onChange={setCode} />}
        {method === "backup" && (
          <input
            autoFocus
            value={code}
            onChange={(e) => setCode(e.target.value.toUpperCase())}
            placeholder="XXXX-XXXX"
            autoComplete="one-time-code"
            className="h-11 rounded-xl border border-input bg-card px-3.5 text-center font-mono text-base tracking-[0.2em] outline-none focus:border-brand/60 focus:ring-3 focus:ring-ring/25"
          />
        )}
        <FormBanner message={error} />
        {method === "passkey" ? (
          <SubmitButton pending={pending}>
            <Fingerprint className="size-4" /> {t("auth.mfa.usePasskey")}
          </SubmitButton>
        ) : method === "sms" && !smsTo ? (
          <SubmitButton pending={pending}>{t("auth.mfa.sendSms")}</SubmitButton>
        ) : (
          <SubmitButton pending={pending}>{t("auth.mfa.verify")}</SubmitButton>
        )}
        {method === "sms" && smsTo && (
          <button type="button" disabled={cooldown > 0 || pending} onClick={() => void sendSms()} className="text-xs text-muted-foreground enabled:hover:text-foreground disabled:opacity-60">
            {cooldown > 0 ? t("auth.mfa.resendIn", { seconds: cooldown }) : t("security.resend")}
          </button>
        )}
      </form>

      {available.length > 1 && (
        <div className="mt-5 flex flex-col gap-1 border-t pt-4">
          {available
            .filter((m) => m !== method)
            .map((m) => {
              const Icon = switchIcon[m]
              return (
                <button
                  key={m}
                  type="button"
                  onClick={() => {
                    setMethod(m)
                    setCode("")
                    setError(null)
                  }}
                  className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                >
                  <Icon className="size-4" />
                  {switchLabel[m]}
                </button>
              )
            })}
        </div>
      )}
      <button type="button" onClick={onRestart} className="mt-4 w-full text-center text-sm font-medium text-muted-foreground underline-offset-4 hover:text-foreground hover:underline">
        {t("auth.backToSignIn")}
      </button>
    </CardShell>
  )
}

/* -------------------------------------------------------------------------- */
/*  Sign in / register                                                          */
/* -------------------------------------------------------------------------- */

export function AuthCard({ mode }: Props) {
  const t = useT()
  const isLogin = mode === "login"
  const router = useRouter()
  const params = useSearchParams()
  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const [companyName, setCompanyName] = useState("")
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({})
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const [mfa, setMfa] = useState<MfaMethod[] | null>(null)
  const [providers, setProviders] = useState<AuthProviders | null>(null)

  // Back from Google / Microsoft / Apple: second step or an error to show.
  useEffect(() => {
    if (!isLogin) return
    if (params.get("step") === "mfa") {
      setMfa((params.get("methods") || "").split(",").filter(Boolean) as MfaMethod[])
    }
    const code = params.get("error")
    if (code) setError(describeApiError(400, { code }).message)
    void fetchProviders()
      .then(setProviders)
      .catch(() => setProviders(null))
  }, [isLogin, params])

  function validate(needPassword = true): boolean {
    const next: FieldErrors = {}
    if (!isLogin && !companyName.trim()) {
      next.companyName = t("auth.errors.workspaceRequired")
    }
    if (!email.trim()) {
      next.email = t("auth.errors.emailRequired")
    } else if (!isValidEmail(email.trim())) {
      next.email = t("auth.errors.emailInvalid")
    }
    if (needPassword) {
      if (!password) {
        next.password = t("auth.errors.passwordRequired")
      } else if (!isLogin && password.length < MIN_PASSWORD) {
        next.password = t("auth.errors.passwordShort")
      }
    }
    setFieldErrors(next)
    return Object.keys(next).length === 0
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    setNotice(null)
    if (!validate()) return

    setPending(true)
    try {
      if (!isLogin) {
        await registerStudio({
          email: email.trim(),
          password,
          company_name: companyName.trim(),
        })
      }
      const step = await login({ username: email.trim(), password })
      if (step.done) router.replace("/")
      else setMfa(step.methods)
    } catch (err) {
      setError(errorText(err, t("auth.errors.generic")))
    } finally {
      setPending(false)
    }
  }

  async function sendMagicLink() {
    setError(null)
    setNotice(null)
    if (!validate(false)) return
    setPending(true)
    try {
      await requestMagicLink(email.trim())
      setNotice(t("auth.magic.sent", { email: email.trim() }))
    } catch (err) {
      setError(errorText(err, t("auth.errors.generic")))
    } finally {
      setPending(false)
    }
  }

  async function oauth(provider: OAuthProvider) {
    setError(null)
    setPending(true)
    try {
      await startOAuth(provider, "login")
    } catch (err) {
      setError(errorText(err, t("auth.errors.generic")))
      setPending(false)
    }
  }

  if (mfa) {
    return (
      <MfaStep
        methods={mfa}
        onDone={() => router.replace("/")}
        onRestart={() => {
          setMfa(null)
          setPassword("")
          router.replace("/login")
        }}
      />
    )
  }

  const configured = (Object.keys(PROVIDER_LABEL) as OAuthProvider[]).filter((p) => providers?.oauth[p])

  return (
    <CardShell
      title={isLogin ? t("auth.welcomeBack") : t("auth.createWorkspace")}
      subtitle={isLogin ? t("auth.signInSubtitle") : t("auth.registerSubtitle")}
    >
      <form method="post" noValidate onSubmit={handleSubmit} className="relative flex flex-col gap-3.5">
        {!isLogin && (
          <Field
            icon={Building2}
            label={t("auth.workspaceName")}
            name="company_name"
            placeholder={t("auth.workspacePlaceholder")}
            value={companyName}
            onChange={(v) => {
              setCompanyName(v)
              setFieldErrors((prev) => ({ ...prev, companyName: undefined }))
            }}
            autoComplete="organization"
            error={fieldErrors.companyName}
          />
        )}
        <Field
          icon={Mail}
          label={t("auth.email")}
          type="email"
          name="email"
          placeholder={t("auth.emailPlaceholder")}
          value={email}
          onChange={(v) => {
            setEmail(v)
            setFieldErrors((prev) => ({ ...prev, email: undefined }))
            setError(null)
          }}
          autoComplete="email"
          error={fieldErrors.email}
        />
        <Field
          icon={Lock}
          label={t("auth.password")}
          name="password"
          placeholder="••••••••"
          toggle
          value={password}
          onChange={(v) => {
            setPassword(v)
            setFieldErrors((prev) => ({ ...prev, password: undefined }))
            setError(null)
          }}
          autoComplete={isLogin ? "current-password" : "new-password"}
          error={fieldErrors.password}
          aside={
            isLogin ? (
              <Link href="/forgot-password" className="text-xs font-medium text-foreground/80 underline-offset-4 hover:text-foreground hover:underline">
                {t("auth.forgotPassword")}
              </Link>
            ) : undefined
          }
        />

        <FormBanner message={error} />
        <FormBanner message={notice} tone="success" />

        <motion.button
          type="submit"
          disabled={pending}
          whileTap={{ scale: 0.985 }}
          className="mt-1.5 flex h-11 items-center justify-center gap-2 rounded-xl bg-primary px-5 text-sm font-semibold text-primary-foreground transition-colors hover:bg-primary/88 disabled:pointer-events-none disabled:opacity-60"
        >
          {pending ? t("auth.pleaseWait") : isLogin ? t("auth.signIn") : t("auth.createAccount")}
          {!pending && <ArrowRight className="size-4" />}
        </motion.button>
      </form>

      {isLogin && (
        <div className="mt-5 flex flex-col gap-2.5">
          <div className="flex items-center gap-3 text-xs text-muted-foreground">
            <span className="h-px flex-1 bg-border" />
            {t("auth.orContinueWith")}
            <span className="h-px flex-1 bg-border" />
          </div>
          {configured.length > 0 && (
            <div className={cn("grid gap-2", GRID_COLS[configured.length])}>
              {configured.map((p) => (
                <button
                  key={p}
                  type="button"
                  disabled={pending}
                  onClick={() => void oauth(p)}
                  aria-label={t("auth.continueWith", { provider: PROVIDER_LABEL[p] })}
                  className="flex h-10 items-center justify-center gap-2 rounded-xl border border-input bg-card text-sm font-medium transition-colors hover:bg-accent disabled:opacity-60"
                >
                  <ProviderIcon provider={p} />
                  {configured.length === 1 ? t("auth.continueWith", { provider: PROVIDER_LABEL[p] }) : PROVIDER_LABEL[p]}
                </button>
              ))}
            </div>
          )}
          <button
            type="button"
            disabled={pending}
            onClick={() => void sendMagicLink()}
            className="flex h-10 items-center justify-center gap-2 rounded-xl border border-input bg-card text-sm font-medium transition-colors hover:bg-accent disabled:opacity-60"
          >
            <Mail className="size-4" />
            {t("auth.emailLink")}
          </button>
        </div>
      )}

      <p className="relative mt-6 text-center text-sm text-muted-foreground">
        {isLogin ? t("auth.noAccount") : t("auth.haveAccount")}{" "}
        <Link
          href={isLogin ? "/register" : "/login"}
          className="font-medium text-foreground underline-offset-4 transition-colors hover:underline"
        >
          {isLogin ? t("auth.signUp") : t("auth.signIn")}
        </Link>
      </p>
    </CardShell>
  )
}
