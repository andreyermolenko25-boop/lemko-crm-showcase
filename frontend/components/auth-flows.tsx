"use client"

import type React from "react"
import Link from "next/link"
import { useRouter, useSearchParams } from "next/navigation"
import { useEffect, useRef, useState } from "react"
import { Lock, Mail } from "lucide-react"
import { ApiError } from "@/lib/api"
import { markTabSession, requestPasswordReset, resetPassword, verifyMagicLink, type MfaMethod } from "@/lib/auth"
import { useT } from "@/components/i18n-provider"
import { CardShell, Field, FormBanner, MfaStep, SubmitButton, isValidEmail } from "@/components/auth-card"

function BackLink() {
  const t = useT()
  return (
    <Link href="/login" className="mt-6 block text-center text-sm font-medium text-muted-foreground underline-offset-4 hover:text-foreground hover:underline">
      {t("auth.backToSignIn")}
    </Link>
  )
}

function Spinner() {
  return <span className="mx-auto block size-5 animate-spin rounded-full border-2 border-border border-t-foreground" />
}

/** /forgot-password — email with a reset link (the answer never says whether the account exists). */
export function ForgotPasswordCard() {
  const t = useT()
  const [email, setEmail] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [sent, setSent] = useState<string | null>(null)
  const [pending, setPending] = useState(false)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    if (!isValidEmail(email.trim())) {
      setError(t("auth.errors.emailInvalid"))
      return
    }
    setPending(true)
    try {
      await requestPasswordReset(email.trim())
      setSent(t("auth.forgot.sent", { email: email.trim() }))
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("auth.errors.generic"))
    } finally {
      setPending(false)
    }
  }

  return (
    <CardShell title={t("auth.forgot.title")} subtitle={t("auth.forgot.subtitle")}>
      <form noValidate onSubmit={submit} className="flex flex-col gap-3.5">
        <Field icon={Mail} label={t("auth.email")} type="email" name="email" placeholder={t("auth.emailPlaceholder")} value={email} onChange={setEmail} autoComplete="email" />
        <FormBanner message={error} />
        <FormBanner message={sent} tone="success" />
        <SubmitButton pending={pending}>{t("auth.forgot.send")}</SubmitButton>
      </form>
      <BackLink />
    </CardShell>
  )
}

/** /reset-password?token=… — new password from the emailed link. */
export function ResetPasswordCard() {
  const t = useT()
  const router = useRouter()
  const token = useSearchParams().get("token") ?? ""
  const [password, setPassword] = useState("")
  const [confirm, setConfirm] = useState("")
  const [error, setError] = useState<string | null>(token ? null : t("auth.reset.missingToken"))
  const [done, setDone] = useState(false)
  const [pending, setPending] = useState(false)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    if (!token) {
      setError(t("auth.reset.missingToken"))
      return
    }
    if (password.length < 10) {
      setError(t("auth.errors.passwordShort"))
      return
    }
    if (password !== confirm) {
      setError(t("auth.reset.mismatch"))
      return
    }
    setPending(true)
    try {
      await resetPassword(token, password)
      setDone(true)
      window.setTimeout(() => router.replace("/login"), 2500)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("auth.errors.generic"))
    } finally {
      setPending(false)
    }
  }

  return (
    <CardShell title={t("auth.reset.title")} subtitle={t("auth.reset.subtitle")}>
      {done ? (
        <FormBanner message={t("auth.reset.done")} tone="success" />
      ) : (
        <form noValidate onSubmit={submit} className="flex flex-col gap-3.5">
          <Field icon={Lock} label={t("auth.reset.newPassword")} name="password" placeholder="••••••••" toggle value={password} onChange={setPassword} autoComplete="new-password" />
          <Field icon={Lock} label={t("auth.reset.confirm")} name="confirm" placeholder="••••••••" toggle value={confirm} onChange={setConfirm} autoComplete="new-password" />
          <FormBanner message={error} />
          <SubmitButton pending={pending}>{t("auth.reset.submit")}</SubmitButton>
        </form>
      )}
      <BackLink />
    </CardShell>
  )
}

/** /login/magic?token=… — signs in with the emailed link (may still ask for 2FA). */
export function MagicLinkCard() {
  const t = useT()
  const router = useRouter()
  const token = useSearchParams().get("token") ?? ""
  const [error, setError] = useState<string | null>(null)
  const [mfa, setMfa] = useState<MfaMethod[] | null>(null)
  const started = useRef(false)

  useEffect(() => {
    // The link is single-use: React's dev double-effect must not spend it twice.
    if (started.current) return
    started.current = true
    if (!token) {
      setError(t("auth.magic.invalid"))
      return
    }
    verifyMagicLink(token)
      .then((step) => (step.done ? router.replace("/") : setMfa(step.methods)))
      .catch((err) => setError(err instanceof ApiError ? err.message : t("auth.magic.invalid")))
  }, [token, router, t])

  if (mfa) return <MfaStep methods={mfa} onDone={() => router.replace("/")} onRestart={() => router.replace("/login")} />
  return (
    <CardShell title={error ? t("auth.magic.title") : t("auth.magic.signingIn")}>
      {error ? <FormBanner message={error} /> : <Spinner />}
      <BackLink />
    </CardShell>
  )
}

/** /login/complete — back from Google / Microsoft / Apple with a session cookie. */
export function CompleteSignIn() {
  const t = useT()
  const router = useRouter()
  useEffect(() => {
    markTabSession()
    router.replace("/")
  }, [router])
  return (
    <CardShell title={t("auth.completing")}>
      <Spinner />
    </CardShell>
  )
}
