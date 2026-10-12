"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import {
  AlertTriangle,
  CheckCircle2,
  Copy,
  Download,
  Fingerprint,
  KeyRound,
  Laptop,
  LogOut,
  Mail,
  MessageSquare,
  Monitor,
  Phone,
  Plus,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
  Smartphone,
  Trash2,
} from "lucide-react"
import { toast } from "sonner"
import { cn } from "@/lib/utils"
import { ApiError } from "@/lib/api"
import { startOAuth, type OAuthProvider } from "@/lib/auth"
import { securityApi, type LoginEvent, type SecurityOverview, type SecurityPolicy, type SessionInfo } from "@/lib/core/backend"
import { timeAgo } from "@/lib/core/format"
import { createPasskey, passkeysSupported } from "@/lib/webauthn"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { InputOTP, InputOTPGroup, InputOTPSeparator, InputOTPSlot } from "@/components/ui/input-otp"
import { Tag } from "@/components/crm/primitives"
import { SettingsRow, SettingsSection } from "@/components/settings/shared"
import { ProviderIcon } from "@/components/auth-card"
import { useI18n, useT } from "@/components/i18n-provider"

/* -------------------------------------------------------------------------- */
/*  Step-up: sensitive changes ask for the password (or a 2FA code) when the    */
/*  last confirmation is older than 10 minutes — the server answers             */
/*  `reauth_required`, we ask and repeat the request once.                      */
/* -------------------------------------------------------------------------- */

type Reauth = { resolve: () => void; reject: (e: unknown) => void }
type Guard = <T>(action: () => Promise<T>) => Promise<T>

function errorMessage(err: unknown, fallback: string) {
  if (err instanceof ApiError) return err.message
  if (err instanceof Error && err.message !== "cancelled") return err.message
  return fallback
}

function ReauthDialog({ pending, hasPassword, onDone }: { pending: Reauth | null; hasPassword: boolean; onDone: () => void }) {
  const t = useT()
  const [mode, setMode] = useState<"password" | "code">(hasPassword ? "password" : "code")
  const [value, setValue] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const close = (ok: boolean) => {
    if (pending) {
      if (ok) pending.resolve()
      else pending.reject(new Error("cancelled"))
    }
    setValue("")
    setError(null)
    onDone()
  }
  const submit = async () => {
    setBusy(true)
    setError(null)
    try {
      await securityApi.reauth(mode === "password" ? { password: value } : { code: value })
      close(true)
    } catch (err) {
      setError(errorMessage(err, t("auth.errors.generic")))
    } finally {
      setBusy(false)
    }
  }
  return (
    <Dialog open={pending !== null} onOpenChange={(o) => !o && close(false)}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>{t("security.reauthTitle")}</DialogTitle>
          <DialogDescription>{mode === "password" ? t("security.reauthPassword") : t("security.reauthCode")}</DialogDescription>
        </DialogHeader>
        <form
          className="grid gap-3"
          onSubmit={(e) => {
            e.preventDefault()
            void submit()
          }}
        >
          <Input
            autoFocus
            type={mode === "password" ? "password" : "text"}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            autoComplete={mode === "password" ? "current-password" : "one-time-code"}
            placeholder={mode === "password" ? "••••••••" : "123456"}
          />
          {error && <p className="text-xs text-destructive">{error}</p>}
          {hasPassword && (
            <button type="button" className="self-start text-xs text-muted-foreground hover:text-foreground" onClick={() => setMode(mode === "password" ? "code" : "password")}>
              {mode === "password" ? t("security.useCode") : t("security.usePassword")}
            </button>
          )}
          <DialogFooter>
            <Button type="submit" className="w-full" disabled={!value || busy}>
              {t("security.reauthContinue")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

/* -------------------------------------------------------------------------- */

function Otp({ value, onChange }: { value: string; onChange: (v: string) => void }) {
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

function useCountdown(active: boolean, seconds = 30) {
  const [left, setLeft] = useState(seconds)
  useEffect(() => {
    if (!active) return
    setLeft(seconds)
    const t = setInterval(() => setLeft((l) => (l > 0 ? l - 1 : 0)), 1000)
    return () => clearInterval(t)
  }, [active, seconds])
  return [left, () => setLeft(seconds)] as const
}

const COUNTRIES = [
  { code: "+48", label: "🇵🇱 +48" },
  { code: "+380", label: "🇺🇦 +380" },
  { code: "+49", label: "🇩🇪 +49" },
  { code: "+44", label: "🇬🇧 +44" },
  { code: "+1", label: "🇺🇸 +1" },
  { code: "+7", label: "🇰🇿 +7" },
]

type DialogProps = { open: boolean; onOpenChange: (o: boolean) => void; guard: Guard; onChanged: (s: SecurityOverview) => void }

function PhoneDialog({ open, onOpenChange, guard, onChanged }: DialogProps) {
  const [step, setStep] = useState<"number" | "code">("number")
  const [cc, setCc] = useState("+48")
  const [num, setNum] = useState("")
  const [code, setCode] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [left, restart] = useCountdown(step === "code")
  const t = useT()
  const phone = `${cc}${num.replace(/\s/g, "")}`
  const close = () => {
    onOpenChange(false)
    setStep("number")
    setCode("")
    setError(null)
  }
  const send = async () => {
    setBusy(true)
    setError(null)
    try {
      await guard(() => securityApi.startPhone(phone))
      setStep("code")
      restart()
      return true
    } catch (err) {
      setError(errorMessage(err, t("auth.errors.generic")))
      return false
    } finally {
      setBusy(false)
    }
  }
  const verify = async () => {
    setBusy(true)
    setError(null)
    try {
      onChanged(await securityApi.confirmPhone(code))
      toast.success(t("security.phoneLinked"))
      close()
    } catch (err) {
      setCode("")
      setError(errorMessage(err, t("auth.errors.generic")))
    } finally {
      setBusy(false)
    }
  }
  return (
    <Dialog open={open} onOpenChange={(o) => (o ? onOpenChange(o) : close())}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>{step === "number" ? t("security.linkPhone") : t("security.enterCode")}</DialogTitle>
          <DialogDescription>
            {step === "number" ? t("security.phoneDescription") : t("security.codeSentTo", { target: `${cc} ${num}` })}
          </DialogDescription>
        </DialogHeader>
        {step === "number" ? (
          <div className="flex gap-2">
            <Select value={cc} onValueChange={setCc}>
              <SelectTrigger className="w-28">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {COUNTRIES.map((c) => (
                  <SelectItem key={c.code} value={c.code}>
                    {c.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Input autoFocus inputMode="tel" value={num} onChange={(e) => setNum(e.target.value.replace(/[^\d ]/g, ""))} placeholder="500 600 700" className="tabular" />
          </div>
        ) : (
          <div className="flex flex-col items-center gap-3">
            <Otp value={code} onChange={setCode} />
            <button
              disabled={left > 0 || busy}
              onClick={() => void send().then((ok) => ok && toast(t("security.newCodeSent")))}
              className="text-xs text-muted-foreground enabled:hover:text-foreground disabled:opacity-60"
            >
              {left > 0 ? t("security.resendIn", { seconds: left }) : t("security.resend")}
            </button>
          </div>
        )}
        {error && <p className="text-center text-xs text-destructive">{error}</p>}
        <DialogFooter>
          {step === "number" ? (
            <Button className="w-full" disabled={num.replace(/\s/g, "").length < 6 || busy} onClick={() => void send()}>
              {t("security.sendCode")}
            </Button>
          ) : (
            <Button className="w-full" disabled={code.length < 6 || busy} onClick={() => void verify()}>
              {t("security.verifyLink")}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function EmailDialog({ open, onOpenChange, guard, onChanged, initial }: DialogProps & { initial: string }) {
  const [step, setStep] = useState<"email" | "code">("email")
  const [email, setEmail] = useState(initial)
  const [code, setCode] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const t = useT()
  useEffect(() => {
    if (open) setEmail(initial)
  }, [open, initial])
  const close = () => {
    onOpenChange(false)
    setStep("email")
    setCode("")
    setError(null)
  }
  const send = async () => {
    setBusy(true)
    setError(null)
    try {
      await guard(() => securityApi.startEmail(email.trim()))
      setStep("code")
    } catch (err) {
      setError(errorMessage(err, t("auth.errors.generic")))
    } finally {
      setBusy(false)
    }
  }
  const confirm = async () => {
    setBusy(true)
    setError(null)
    try {
      onChanged(await securityApi.confirmEmail(code))
      toast.success(t("security.emailUpdated"))
      close()
    } catch (err) {
      setCode("")
      setError(errorMessage(err, t("auth.errors.generic")))
    } finally {
      setBusy(false)
    }
  }
  return (
    <Dialog open={open} onOpenChange={(o) => (o ? onOpenChange(o) : close())}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>{step === "email" ? t("security.changeEmail") : t("security.confirmEmail")}</DialogTitle>
          <DialogDescription>{step === "email" ? t("security.emailDescription") : t("security.enterCodeSentTo", { email })}</DialogDescription>
        </DialogHeader>
        {step === "email" ? (
          <Input autoFocus type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder={t("security.emailPlaceholder")} />
        ) : (
          <Otp value={code} onChange={setCode} />
        )}
        {error && <p className="text-center text-xs text-destructive">{error}</p>}
        <DialogFooter>
          {step === "email" ? (
            <Button className="w-full" disabled={!/^\S+@\S+\.\S+$/.test(email) || busy} onClick={() => void send()}>
              {t("security.sendCode")}
            </Button>
          ) : (
            <Button className="w-full" disabled={code.length < 6 || busy} onClick={() => void confirm()}>
              {t("security.confirm")}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function strength(pw: string) {
  let s = 0
  if (pw.length >= 10) s++
  if (/[A-Z]/.test(pw) && /[a-z]/.test(pw)) s++
  if (/\d/.test(pw)) s++
  if (/[^A-Za-z0-9]/.test(pw)) s++
  return s
}

function PasswordDialog({ open, onOpenChange, hasPassword, onSaved }: { open: boolean; onOpenChange: (o: boolean) => void; hasPassword: boolean; onSaved: () => void }) {
  const [cur, setCur] = useState("")
  const [next, setNext] = useState("")
  const [confirm, setConfirm] = useState("")
  const [logoutOthers, setLogoutOthers] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const s = strength(next)
  const t = useT()
  const labels = [t("security.strength.tooWeak"), t("security.strength.weak"), t("security.strength.fair"), t("security.strength.good"), t("security.strength.strong")]
  const colors = ["bg-destructive", "bg-destructive", "bg-warning", "bg-series-1", "bg-success"]
  const save = async () => {
    setBusy(true)
    setError(null)
    try {
      await securityApi.changePassword({ current_password: hasPassword ? cur : undefined, new_password: next, sign_out_others: logoutOthers })
      toast.success(t("security.passwordChanged"))
      onOpenChange(false)
      setCur("")
      setNext("")
      setConfirm("")
      onSaved()
    } catch (err) {
      setError(errorMessage(err, t("auth.errors.generic")))
    } finally {
      setBusy(false)
    }
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>{t("security.changePassword")}</DialogTitle>
          <DialogDescription>{t("security.passwordRules")}</DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          {hasPassword && (
            <div className="grid gap-1.5">
              <Label className="text-xs">{t("security.currentPassword")}</Label>
              <Input type="password" value={cur} onChange={(e) => setCur(e.target.value)} autoComplete="current-password" />
            </div>
          )}
          <div className="grid gap-1.5">
            <Label className="text-xs">{t("security.newPassword")}</Label>
            <Input type="password" value={next} onChange={(e) => setNext(e.target.value)} autoComplete="new-password" />
            <div className="flex items-center gap-2">
              <div className="flex flex-1 gap-1">
                {[0, 1, 2, 3].map((i) => (
                  <span key={i} className={cn("h-1 flex-1 rounded-full", i < s ? colors[s] : "bg-foreground/10")} />
                ))}
              </div>
              <span className="w-20 text-right text-xs text-muted-foreground">{next ? labels[s] : ""}</span>
            </div>
          </div>
          <div className="grid gap-1.5">
            <Label className="text-xs">{t("security.confirmPassword")}</Label>
            <Input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" aria-invalid={Boolean(confirm) && confirm !== next} />
          </div>
          <label className="flex items-center justify-between text-sm">
            {t("security.signOutOthersSwitch")}
            <Switch checked={logoutOthers} onCheckedChange={setLogoutOthers} />
          </label>
          {error && <p className="text-xs text-destructive">{error}</p>}
        </div>
        <DialogFooter>
          <Button className="w-full" disabled={(hasPassword && !cur) || s < 2 || next !== confirm || busy} onClick={() => void save()}>
            {t("security.updatePassword")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function BackupCodesView({ codes }: { codes: string[] }) {
  const t = useT()
  return (
    <div className="flex flex-col gap-3">
      <p className="rounded-lg border border-warning/40 bg-warning/[0.08] px-3 py-2 text-xs">{t("security.backupShownOnce")}</p>
      <div className="grid grid-cols-2 gap-2 rounded-xl border bg-elevated p-4 font-mono text-sm tracking-wider">
        {codes.map((c) => (
          <span key={c} className="text-center">
            {c}
          </span>
        ))}
      </div>
      <div className="flex justify-end gap-2">
        <Button variant="outline" onClick={() => (navigator.clipboard?.writeText(codes.join("\n")), toast(t("security.codesCopied")))}>
          <Copy /> {t("common.copy")}
        </Button>
        <Button
          onClick={() => {
            const a = document.createElement("a")
            a.href = URL.createObjectURL(new Blob([codes.join("\n")], { type: "text/plain" }))
            a.download = "lemko-backup-codes.txt"
            a.click()
            setTimeout(() => URL.revokeObjectURL(a.href), 1000)
          }}
        >
          <Download /> {t("security.download")}
        </Button>
      </div>
    </div>
  )
}

function TotpDialog({ open, onOpenChange, guard, onEnabled }: { open: boolean; onOpenChange: (o: boolean) => void; guard: Guard; onEnabled: () => void }) {
  const [setup, setSetup] = useState<{ secret: string; qr: string } | null>(null)
  const [code, setCode] = useState("")
  const [codes, setCodes] = useState<string[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const t = useT()
  const started = useRef(false)

  useEffect(() => {
    if (!open) {
      started.current = false
      setSetup(null)
      setCodes(null)
      setCode("")
      setError(null)
      return
    }
    if (started.current) return
    started.current = true
    guard(() => securityApi.setupTotp())
      .then((s) => setSetup({ secret: s.secret, qr: s.qr }))
      .catch((err) => {
        const message = errorMessage(err, "")
        if (message) setError(message)
        else onOpenChange(false)
      })
  }, [open, guard, onOpenChange])

  const enable = async () => {
    setBusy(true)
    setError(null)
    try {
      const result = await securityApi.enableTotp(code)
      toast.success(t("security.twoFaEnabled"))
      onEnabled()
      if (result.codes.length) setCodes(result.codes)
      else onOpenChange(false)
    } catch (err) {
      setCode("")
      setError(errorMessage(err, t("auth.errors.generic")))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{codes ? t("security.backupCodes") : t("security.setupAuthenticator")}</DialogTitle>
          <DialogDescription>{codes ? t("security.backupDescription") : t("security.authenticatorDescription")}</DialogDescription>
        </DialogHeader>
        {codes ? (
          <BackupCodesView codes={codes} />
        ) : (
          <div className="flex flex-col items-center gap-4">
            {setup ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={setup.qr} alt={t("security.qrCode")} className="size-44 rounded-lg bg-white p-1" />
            ) : (
              <span className="flex size-44 items-center justify-center rounded-lg border">
                <span className="size-5 animate-spin rounded-full border-2 border-border border-t-foreground" />
              </span>
            )}
            {setup && (
              <div className="flex items-center gap-2 rounded-lg border bg-elevated px-3 py-1.5">
                <code className="font-mono text-xs tracking-wider">{setup.secret}</code>
                <Button variant="ghost" size="icon-xs" onClick={() => (navigator.clipboard?.writeText(setup.secret.replace(/\s/g, "")), toast(t("security.secretCopied")))} aria-label={t("security.copySecret")}>
                  <Copy />
                </Button>
              </div>
            )}
            <Otp value={code} onChange={setCode} />
            {error && <p className="text-center text-xs text-destructive">{error}</p>}
          </div>
        )}
        <DialogFooter>
          {codes ? (
            <Button className="w-full" onClick={() => onOpenChange(false)}>
              {t("common.done")}
            </Button>
          ) : (
            <Button className="w-full" disabled={!setup || code.length < 6 || busy} onClick={() => void enable()}>
              {t("security.verifyEnable")}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function BackupCodesDialog({ open, onOpenChange, guard, left, onGenerated }: { open: boolean; onOpenChange: (o: boolean) => void; guard: Guard; left: number; onGenerated: () => void }) {
  const [codes, setCodes] = useState<string[] | null>(null)
  const [busy, setBusy] = useState(false)
  const t = useT()
  useEffect(() => {
    if (!open) setCodes(null)
  }, [open])
  const generate = async () => {
    setBusy(true)
    try {
      const result = await guard(() => securityApi.backupCodes())
      setCodes(result.codes)
      toast(t("security.codesRegenerated"))
      onGenerated()
    } catch (err) {
      const message = errorMessage(err, "")
      if (message) toast.error(message)
    } finally {
      setBusy(false)
    }
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t("security.backupCodes")}</DialogTitle>
          <DialogDescription>{t("security.backupDescription")}</DialogDescription>
        </DialogHeader>
        {codes ? (
          <BackupCodesView codes={codes} />
        ) : (
          <p className="rounded-xl border bg-elevated p-4 text-sm text-muted-foreground">
            {left > 0 ? t("security.codesLeft", { count: left }) : t("security.backupEmpty")}
          </p>
        )}
        <DialogFooter className="sm:justify-between">
          <Button variant="ghost" disabled={busy} onClick={() => void generate()}>
            <RefreshCw /> {t("security.backupGenerate")}
          </Button>
          <Button onClick={() => onOpenChange(false)}>{t("common.done")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function PasskeyDialog({ open, onOpenChange, guard, onChanged }: DialogProps) {
  const t = useT()
  const [name, setName] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    if (open) {
      setName("")
      setError(null)
    }
  }, [open])
  const add = async () => {
    setBusy(true)
    setError(null)
    try {
      const options = await guard(() => securityApi.passkeyOptions())
      const credential = await createPasskey(options)
      onChanged(await securityApi.addPasskey(name.trim() || t("security.passkeys"), credential))
      toast.success(t("security.passkeyAdded"))
      onOpenChange(false)
    } catch (err) {
      if (err instanceof DOMException && (err.name === "NotAllowedError" || err.name === "AbortError")) setError(t("security.passkeyCancelled"))
      else setError(errorMessage(err, t("security.passkeyCancelled")))
    } finally {
      setBusy(false)
    }
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>{t("security.addPasskey")}</DialogTitle>
          <DialogDescription>{t("security.passkeysHint")}</DialogDescription>
        </DialogHeader>
        <div className="grid gap-1.5">
          <Label className="text-xs">{t("security.passkeyName")}</Label>
          <Input autoFocus value={name} maxLength={100} onChange={(e) => setName(e.target.value)} placeholder={t("security.passkeyNamePlaceholder")} />
        </div>
        {error && <p className="text-xs text-destructive">{error}</p>}
        <DialogFooter>
          <Button className="w-full" disabled={busy} onClick={() => void add()}>
            <Fingerprint /> {t("security.addPasskey")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/* -------------------------------------------------------------------------- */

const PROVIDERS: { key: OAuthProvider; label: string }[] = [
  { key: "google", label: "Google" },
  { key: "microsoft", label: "Microsoft" },
  { key: "apple", label: "Apple" },
]

function deviceIcon(device: string) {
  if (/iOS|Android/.test(device)) return Smartphone
  if (/Windows|Linux/.test(device)) return Monitor
  return Laptop
}

export function SecuritySettings() {
  const t = useT()
  const { maybe } = useI18n()
  const [sec, setSec] = useState<SecurityOverview | null>(null)
  const [sessions, setSessions] = useState<SessionInfo[]>([])
  const [history, setHistory] = useState<LoginEvent[]>([])
  const [policy, setPolicy] = useState<SecurityPolicy | null>(null)
  const [allowlist, setAllowlist] = useState("")
  const [loadError, setLoadError] = useState<string | null>(null)
  const [dialog, setDialog] = useState<null | "phone" | "email" | "password" | "totp" | "codes" | "passkey">(null)
  const [reauth, setReauth] = useState<Reauth | null>(null)

  const load = useCallback(async () => {
    try {
      const [overview, list, events, rules] = await Promise.all([securityApi.overview(), securityApi.sessions(), securityApi.history(), securityApi.policy()])
      setSec(overview)
      setSessions(list)
      setHistory(events)
      setPolicy(rules)
      setAllowlist(rules.ipAllowlist)
      setLoadError(null)
    } catch (err) {
      setLoadError(errorMessage(err, t("security.loadFailed")))
    }
  }, [t])

  useEffect(() => {
    void load()
    // Back from Google / Microsoft / Apple after linking.
    const linked = new URLSearchParams(window.location.search).get("linked")
    if (linked) {
      toast.success(t("security.linked", { provider: linked[0].toUpperCase() + linked.slice(1) }))
      window.history.replaceState(null, "", window.location.pathname)
    }
  }, [load, t])

  /** Runs a sensitive request; asks to confirm identity once if the server wants it. */
  const guard: Guard = useCallback(async (action) => {
    try {
      return await action()
    } catch (err) {
      if (!(err instanceof ApiError && err.code === "reauth_required")) throw err
      await new Promise<void>((resolve, reject) => setReauth({ resolve, reject }))
      return action()
    }
  }, [])

  const run = async (action: () => Promise<SecurityOverview | void>, done?: string) => {
    try {
      const next = await guard(action)
      if (next) setSec(next)
      if (done) toast.success(done)
    } catch (err) {
      const message = errorMessage(err, "")
      if (message) toast.error(message)
    }
  }

  const savePolicy = async (patch: Partial<Omit<SecurityPolicy, "can_edit">>) => {
    if (!policy) return
    const previous = policy
    setPolicy({ ...policy, ...patch })
    try {
      const saved = await guard(() => securityApi.updatePolicy(patch))
      setPolicy(saved)
      setAllowlist(saved.ipAllowlist)
      toast.success(t("security.policySaved"))
    } catch (err) {
      setPolicy(previous)
      const message = errorMessage(err, "")
      if (message) toast.error(message)
    }
  }

  if (loadError) {
    return (
      <div className="flex items-center justify-between gap-3 rounded-xl border border-destructive/30 bg-destructive/[0.06] px-4 py-3 text-sm">
        {loadError}
        <Button size="sm" variant="outline" onClick={() => void load()}>
          {t("common.retry")}
        </Button>
      </div>
    )
  }
  if (!sec || !policy) {
    return (
      <div className="flex justify-center py-16">
        <span className="size-5 animate-spin rounded-full border-2 border-border border-t-foreground" aria-label={t("common.loading")} />
      </div>
    )
  }

  const twoFa = sec.totp || sec.sms || sec.passkeys.length > 0
  const methodLabel = (method: string) =>
    method
      .split("+")
      .map((m) => maybe(`security.methods.${m}`) ?? m)
      .join(" + ")

  return (
    <div className="flex flex-col gap-[var(--gap)]">
      {/* Status */}
      <div className={cn("flex items-start gap-3 rounded-xl border p-4", twoFa ? "border-success/30 bg-success/[0.06]" : "border-warning/40 bg-warning/[0.08]")}>
        {twoFa ? <ShieldCheck className="mt-0.5 size-5 text-success" /> : <ShieldAlert className="mt-0.5 size-5 text-warning" />}
        <div className="flex-1">
          <p className="text-sm font-semibold">{twoFa ? t("security.protected") : t("security.turnOn2fa")}</p>
          <p className="text-xs text-muted-foreground">{twoFa ? t("security.protectedHint") : t("security.turnOnHint")}</p>
        </div>
        {!sec.totp && (
          <Button size="sm" variant={twoFa ? "outline" : "default"} onClick={() => setDialog("totp")}>
            {twoFa ? t("security.addAuthenticator") : t("security.enable2fa")}
          </Button>
        )}
      </div>

      <SettingsSection title={t("security.signInContact")} description={t("security.signInContactDescription")}>
        <SettingsRow label={t("security.email")} hint={sec.email_verified ? t("security.emailVerified") : t("security.notVerified")}>
          <div className="flex items-center gap-2">
            <span className="flex items-center gap-1.5 text-sm">
              <Mail className="size-3.5 text-muted-foreground" />
              {sec.email ?? "—"}
            </span>
            {sec.email_verified && <CheckCircle2 className="size-4 text-success" aria-label={t("security.verified")} />}
            <Button variant="outline" size="sm" onClick={() => setDialog("email")}>
              {sec.email && !sec.email_verified ? t("security.verifyEmail") : t("security.change")}
            </Button>
          </div>
        </SettingsRow>
        <SettingsRow label={t("security.phone")} hint={sec.phone ? t("security.phoneVerified") : sec.sms_available ? t("security.phoneMissing") : t("security.smsUnavailable")}>
          {sec.phone ? (
            <div className="flex items-center gap-2">
              <span className="flex items-center gap-1.5 text-sm tabular">
                <Phone className="size-3.5 text-muted-foreground" />
                {sec.phone}
              </span>
              <CheckCircle2 className="size-4 text-success" />
              <Button variant="outline" size="sm" disabled={!sec.sms_available} onClick={() => setDialog("phone")}>
                {t("security.change")}
              </Button>
              <Button variant="ghost" size="icon-sm" aria-label={t("security.removePhone")} onClick={() => void run(() => securityApi.removePhone())}>
                <Trash2 />
              </Button>
            </div>
          ) : (
            <Button size="sm" disabled={!sec.sms_available} onClick={() => setDialog("phone")}>
              <Plus /> {t("security.linkPhoneButton")}
            </Button>
          )}
        </SettingsRow>
        <SettingsRow
          label={t("security.password")}
          hint={sec.password_changed_at ? t("security.lastChanged", { ago: timeAgo(sec.password_changed_at) }) : undefined}
        >
          <Button variant="outline" size="sm" onClick={() => setDialog("password")}>
            <KeyRound /> {t("security.changePassword")}
          </Button>
        </SettingsRow>
        <SettingsRow label={t("security.social")} hint={t("security.socialHint")}>
          <div className="flex flex-wrap gap-2">
            {PROVIDERS.map(({ key, label }) => {
              const linked = sec.social[key]
              const available = sec.providers[key]
              return (
                <Button
                  key={key}
                  variant="outline"
                  size="sm"
                  disabled={!linked && !available}
                  title={!linked && !available ? t("security.notConfigured") : undefined}
                  onClick={() =>
                    linked
                      ? void run(() => securityApi.unlinkSocial(key), t("security.unlinked", { provider: label }))
                      : void guard(() => startOAuth(key, "link")).catch((err) => {
                          const message = errorMessage(err, "")
                          if (message) toast.error(message)
                        })
                  }
                  className={cn(linked && "border-success/40")}
                >
                  {linked ? <CheckCircle2 className="text-success" /> : <ProviderIcon provider={key} />}
                  {label}
                </Button>
              )
            })}
          </div>
        </SettingsRow>
      </SettingsSection>

      <SettingsSection title={t("security.twoFa")} description={t("security.twoFaDescription")}>
        <SettingsRow label={t("security.authenticatorApp")} hint={t("security.authenticatorHint")}>
          <div className="flex items-center gap-2">
            {sec.totp && <Tag color="green" dot>{t("security.on")}</Tag>}
            <Button
              variant={sec.totp ? "outline" : "default"}
              size="sm"
              onClick={() => (sec.totp ? void run(() => securityApi.disableTotp(), t("security.authenticatorRemoved")) : setDialog("totp"))}
            >
              {sec.totp ? t("common.remove") : t("security.setUp")}
            </Button>
          </div>
        </SettingsRow>
        <SettingsRow
          label={t("security.smsCodes")}
          hint={!sec.sms_available ? t("security.smsUnavailable") : sec.phone ? t("security.smsTo", { phone: sec.phone }) : t("security.linkPhoneFirst")}
        >
          <Switch
            disabled={!sec.phone || !sec.sms_available}
            checked={sec.sms}
            onCheckedChange={(v) => void run(() => securityApi.setSms(v), v ? t("security.smsEnabled") : t("security.smsDisabled"))}
          />
        </SettingsRow>
        <SettingsRow label={t("security.passkeys")} hint={passkeysSupported() ? t("security.passkeysHint") : t("security.passkeyUnsupported")} stack>
          <div className="flex flex-col gap-2">
            {sec.passkeys.map((k) => (
              <div key={k.id} className="flex items-center gap-3 rounded-lg border px-3 py-2">
                <Fingerprint className="size-4 text-muted-foreground" />
                <span className="flex-1 text-sm">{k.name}</span>
                <span className="text-xs text-muted-foreground">
                  {k.last_used_at ? t("security.lastUsed", { ago: timeAgo(k.last_used_at) }) : t("security.added", { ago: timeAgo(k.added_at) })}
                </span>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  aria-label={t("security.removePasskey")}
                  onClick={() => void run(() => securityApi.removePasskey(k.id), t("security.passkeyRemoved"))}
                >
                  <Trash2 />
                </Button>
              </div>
            ))}
            <Button variant="outline" size="sm" className="self-start" disabled={!passkeysSupported()} onClick={() => setDialog("passkey")}>
              <Plus /> {t("security.addPasskey")}
            </Button>
          </div>
        </SettingsRow>
        <SettingsRow label={t("security.backupCodes")} hint={t("security.codesLeft", { count: sec.backup_codes_left })}>
          <Button variant="outline" size="sm" onClick={() => setDialog("codes")}>
            {t("security.viewCodes")}
          </Button>
        </SettingsRow>
      </SettingsSection>

      <section className="surface">
        <header className="flex items-center justify-between border-b px-[var(--pad)] py-4">
          <div>
            <h2 className="text-base font-semibold">{t("security.activeSessions")}</h2>
            <p className="mt-0.5 text-sm text-muted-foreground">{t("security.activeSessionsDescription")}</p>
          </div>
          <Button
            variant="outline"
            size="sm"
            disabled={sessions.length < 2}
            onClick={async () => {
              try {
                await securityApi.revokeOthers()
                setSessions((s) => s.filter((x) => x.current))
                toast.success(t("security.signedOutOthers"))
              } catch (err) {
                toast.error(errorMessage(err, t("auth.errors.generic")))
              }
            }}
          >
            <LogOut /> {t("security.signOutOthers")}
          </Button>
        </header>
        <ul className="divide-y">
          {sessions.map((s) => {
            const Icon = deviceIcon(s.device)
            return (
              <li key={s.id} className="flex items-center gap-3 px-[var(--pad)] py-3">
                <span className="flex size-9 items-center justify-center rounded-lg bg-muted">
                  <Icon className="size-4" />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium">
                    {s.device} {s.current && <Tag color="green" className="ml-1">{t("security.thisDevice")}</Tag>}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {[methodLabel(s.method), s.ip, s.current ? t("security.activeNow") : timeAgo(s.last_seen_at)].filter(Boolean).join(" · ")}
                  </p>
                </div>
                {!s.current && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={async () => {
                      try {
                        await securityApi.revokeSession(s.id)
                        setSessions((x) => x.filter((y) => y.id !== s.id))
                        toast.success(t("security.sessionSignedOut"))
                      } catch (err) {
                        toast.error(errorMessage(err, t("auth.errors.generic")))
                      }
                    }}
                  >
                    {t("security.signOut")}
                  </Button>
                )}
              </li>
            )
          })}
        </ul>
      </section>

      <section className="surface overflow-hidden">
        <header className="border-b px-[var(--pad)] py-4">
          <h2 className="text-base font-semibold">{t("security.loginHistory")}</h2>
          <p className="mt-0.5 text-sm text-muted-foreground">{t("security.loginHistoryDescription")}</p>
        </header>
        {history.length === 0 ? (
          <p className="px-[var(--pad)] py-6 text-sm text-muted-foreground">{t("security.noHistory")}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[34rem] text-sm">
              <tbody className="divide-y">
                {history.map((h, i) => (
                  <tr key={`${h.at}-${i}`}>
                    <td className="px-[var(--pad)] py-2.5">
                      <span className="flex items-center gap-2">
                        {h.status === "success" ? (
                          <CheckCircle2 className="size-4 text-success" />
                        ) : (
                          <AlertTriangle className={cn("size-4", h.status === "blocked" ? "text-destructive" : "text-warning")} />
                        )}
                        {maybe(`security.events.${h.event}`) ?? h.event}
                      </span>
                    </td>
                    <td className="py-2.5 text-muted-foreground">{methodLabel(h.method)}</td>
                    <td className="py-2.5 text-muted-foreground">{[h.device, h.ip].filter(Boolean).join(" · ")}</td>
                    <td className="py-2.5">
                      <Tag color={h.status === "success" ? "green" : h.status === "blocked" ? "red" : "amber"}>{t(`security.statuses.${h.status}`)}</Tag>
                    </td>
                    <td className="px-[var(--pad)] py-2.5 text-right text-xs text-muted-foreground">{timeAgo(h.at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <SettingsSection title={t("security.policy")} description={policy.can_edit ? t("security.policyDescription") : t("security.policyReadOnly")}>
        <SettingsRow label={t("security.require2fa")} hint={t("security.require2faHint")}>
          <Switch disabled={!policy.can_edit} checked={policy.require2fa} onCheckedChange={(v) => void savePolicy({ require2fa: v })} />
        </SettingsRow>
        <SettingsRow label={t("security.allowedMethods")}>
          <div className="flex flex-wrap gap-1.5">
            {(["password", "google", "microsoft", "apple", "magic"] as const).map((k) => (
              <button
                key={k}
                disabled={!policy.can_edit}
                onClick={() => void savePolicy({ methods: { ...policy.methods, [k]: !policy.methods[k] } })}
                className={cn(
                  "h-7 rounded-lg border px-2.5 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-60",
                  policy.methods[k] ? "border-foreground/40 bg-accent" : "text-muted-foreground",
                )}
              >
                {t(`security.methods.${k}`)}
              </button>
            ))}
          </div>
        </SettingsRow>
        <SettingsRow label={t("security.idleTimeout")}>
          <Select disabled={!policy.can_edit} value={policy.timeout} onValueChange={(v) => void savePolicy({ timeout: v })}>
            <SelectTrigger className="w-36">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {(["15m", "1h", "8h", "24h", "7d"] as const).map((v) => (
                <SelectItem key={v} value={v}>
                  {t(`security.timeouts.${v}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </SettingsRow>
        <SettingsRow label={t("security.minLength")}>
          <Select disabled={!policy.can_edit} value={policy.minLength} onValueChange={(v) => void savePolicy({ minLength: v })}>
            <SelectTrigger className="w-36">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {["8", "10", "12", "16"].map((v) => (
                <SelectItem key={v} value={v}>
                  {t("security.characters", { count: Number(v) })}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </SettingsRow>
        <SettingsRow label={t("security.newDeviceAlert")} hint={t("security.newDeviceAlertHint")}>
          <Switch disabled={!policy.can_edit} checked={policy.newDeviceAlert} onCheckedChange={(v) => void savePolicy({ newDeviceAlert: v })} />
        </SettingsRow>
        <SettingsRow label={t("security.ipAllowlist")} hint={t("security.ipAllowlistHint")} stack>
          <div className="flex flex-col gap-2">
            <Textarea
              disabled={!policy.can_edit}
              value={allowlist}
              onChange={(e) => setAllowlist(e.target.value)}
              placeholder={"91.198.0.0/16\n83.12.44.10"}
              className="font-mono text-xs"
              rows={3}
            />
            {policy.can_edit && allowlist !== policy.ipAllowlist && (
              <Button size="sm" className="self-start" onClick={() => void savePolicy({ ipAllowlist: allowlist })}>
                {t("security.saveAllowlist")}
              </Button>
            )}
          </div>
        </SettingsRow>
      </SettingsSection>

      <div className="flex items-center gap-2 rounded-xl border border-dashed p-4 text-xs text-muted-foreground">
        <MessageSquare className="size-4" />
        {t("security.auditNote")}
      </div>

      <PhoneDialog open={dialog === "phone"} onOpenChange={(o) => setDialog(o ? "phone" : null)} guard={guard} onChanged={setSec} />
      <EmailDialog open={dialog === "email"} onOpenChange={(o) => setDialog(o ? "email" : null)} guard={guard} onChanged={setSec} initial={sec.email && !sec.email_verified ? sec.email : ""} />
      <PasswordDialog open={dialog === "password"} onOpenChange={(o) => setDialog(o ? "password" : null)} hasPassword={sec.has_password} onSaved={() => void load()} />
      <TotpDialog open={dialog === "totp"} onOpenChange={(o) => setDialog(o ? "totp" : null)} guard={guard} onEnabled={() => void load()} />
      <BackupCodesDialog open={dialog === "codes"} onOpenChange={(o) => setDialog(o ? "codes" : null)} guard={guard} left={sec.backup_codes_left} onGenerated={() => void load()} />
      <PasskeyDialog open={dialog === "passkey"} onOpenChange={(o) => setDialog(o ? "passkey" : null)} guard={guard} onChanged={setSec} />
      <ReauthDialog pending={reauth} hasPassword={sec.has_password} onDone={() => setReauth(null)} />
    </div>
  )
}

/** Full-screen gate when the workspace policy requires 2FA and this member has none yet. */
export function MfaEnrollmentGate({ onDone }: { onDone: () => void }) {
  const t = useT()
  const [open, setOpen] = useState<null | "totp" | "passkey">(null)
  const enrolled = useRef(false)
  // Right after sign-in the session counts as freshly confirmed — no step-up needed.
  const guard: Guard = useCallback((action) => action(), [])
  return (
    <div className="flex min-h-dvh items-center justify-center bg-background px-6">
      <div className="surface w-full max-w-md rounded-2xl p-8 text-center shadow-[var(--shadow-pop)]">
        <ShieldAlert className="mx-auto size-8 text-warning" />
        <h1 className="mt-4 text-xl font-semibold">{t("security.enrollTitle")}</h1>
        <p className="mt-2 text-sm text-muted-foreground">{t("security.enrollText")}</p>
        <div className="mt-6 flex flex-col gap-2">
          <Button onClick={() => setOpen("totp")}>
            <Smartphone /> {t("security.setupAuthenticator")}
          </Button>
          {passkeysSupported() && (
            <Button variant="outline" onClick={() => setOpen("passkey")}>
              <Fingerprint /> {t("security.addPasskey")}
            </Button>
          )}
        </div>
      </div>
      <TotpDialog
        open={open === "totp"}
        onOpenChange={(o) => {
          setOpen(o ? "totp" : null)
          // Let the member save the backup codes before the app opens.
          if (!o && enrolled.current) onDone()
        }}
        guard={guard}
        onEnabled={() => {
          enrolled.current = true
        }}
      />
      <PasskeyDialog open={open === "passkey"} onOpenChange={(o) => setOpen(o ? "passkey" : null)} guard={guard} onChanged={onDone} />
    </div>
  )
}
