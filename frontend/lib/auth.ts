/**
 * Session: httpOnly cookie set by the BFF routes (app/api/login, refresh,
 * logout) plus a per-tab marker in sessionStorage — closing the tab ends the
 * session even if the browser restores cookies.
 *
 * Sign-in can take two steps: password (or a Google / Microsoft / Apple account,
 * or a link from the email) → second factor when the member has 2FA on. The
 * second-step token lives in an httpOnly cookie too; this module only says
 * "which method" and "which code".
 */

import { ApiError, apiRequest, readBody, safeFetch } from "@/lib/api"
import { TAB_SESSION_KEY, TAB_SESSION_VALUE } from "@/lib/session-constants"
import { t } from "@/lib/i18n/translate"
import { getPasskey } from "@/lib/webauthn"

export type UserMe = {
  id: number
  username: string
  role: string
  company_id: number
  is_active: boolean
  email: string | null
  mfa_enabled: boolean
  /** Workspace policy requires 2FA and this member has not set it up yet. */
  mfa_enrollment_required: boolean
}

export type MfaMethod = "totp" | "sms" | "passkey" | "backup"

/** Result of a sign-in step: done, or the second factor is needed. */
export type LoginStep = { done: true } | { done: false; methods: MfaMethod[] }

export function markTabSession(): void {
  if (typeof window === "undefined") return
  sessionStorage.setItem(TAB_SESSION_KEY, TAB_SESSION_VALUE)
}

export function hasTabSession(): boolean {
  if (typeof window === "undefined") return false
  return sessionStorage.getItem(TAB_SESSION_KEY) === TAB_SESSION_VALUE
}

export function clearSession(): void {
  if (typeof window === "undefined") return
  sessionStorage.removeItem(TAB_SESSION_KEY)
}

export async function registerStudio(payload: { email: string; password: string; company_name: string }) {
  return apiRequest<{ company: { id: number; name: string }; owner: UserMe }>("/auth/register", {
    method: "POST",
    body: payload,
  })
}

async function apiPost<T>(url: string, body?: unknown): Promise<T> {
  const res = await safeFetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "same-origin",
    body: JSON.stringify(body ?? {}),
  })
  const data = await readBody(res)
  if (!res.ok) {
    const err = ApiError.fromResponse(res.status, data)
    // A backend without error codes answers a wrong password with a bare (Russian) message.
    if (res.status === 401 && !err.code) throw new ApiError(401, t("errors.codes.invalid_credentials"), err.detail, "invalid_credentials")
    throw err
  }
  return data as T
}

async function postStep(url: string, body: unknown): Promise<LoginStep> {
  const data = await apiPost<{ ok?: boolean; mfa_required?: boolean; methods?: MfaMethod[] } | null>(url, body)
  if (data?.mfa_required) return { done: false, methods: data.methods ?? [] }
  markTabSession()
  return { done: true }
}

export function login(payload: { username: string; password: string; company_id?: number }): Promise<LoginStep> {
  return postStep("/api/login", payload)
}

/** Second step with a code: authenticator, SMS or a backup code. */
export function verifyMfa(method: Exclude<MfaMethod, "passkey">, code: string): Promise<LoginStep> {
  return postStep("/api/login/verify", { method, code })
}

/** Second step with a passkey (Touch ID, Windows Hello, security key). */
export async function verifyPasskey(): Promise<LoginStep> {
  const options = await apiPost<Record<string, unknown>>("/api/login/passkey")
  const credential = await getPasskey(options)
  return postStep("/api/login/verify", { method: "passkey", credential })
}

/** Sends the sign-in SMS code; returns the masked number. */
export async function sendLoginSms(): Promise<string> {
  const data = await apiPost<{ sent_to: string }>("/api/login/sms")
  return data.sent_to
}

/** Signs in with the one-time link from the email. */
export function verifyMagicLink(token: string): Promise<LoginStep> {
  return postStep("/api/login/magic", { token })
}

export function requestMagicLink(email: string) {
  return apiRequest<{ ok: boolean }>("/auth/magic/start", { method: "POST", body: { email } })
}

export function requestPasswordReset(email: string) {
  return apiRequest<{ ok: boolean }>("/auth/password/forgot", { method: "POST", body: { email } })
}

export function resetPassword(token: string, newPassword: string) {
  return apiRequest<void>("/auth/password/reset", { method: "POST", body: { token, new_password: newPassword } })
}

export type OAuthProvider = "google" | "microsoft" | "apple"
export type AuthProviders = { oauth: Record<OAuthProvider, boolean>; sms: boolean }

export function fetchProviders(): Promise<AuthProviders> {
  return apiRequest<AuthProviders>("/auth/providers")
}

/** Leaves for Google / Microsoft / Apple; they send the browser back to /api/oauth/…/callback. */
export async function startOAuth(provider: OAuthProvider, intent: "login" | "link"): Promise<void> {
  const data = await apiPost<{ url: string }>(`/api/oauth/${provider}/start`, { intent })
  window.location.assign(data.url)
}

export function fetchMe(): Promise<UserMe> {
  return apiRequest<UserMe>("/auth/me")
}

export async function refreshSession(): Promise<boolean> {
  const res = await fetch("/api/refresh", { method: "POST", credentials: "same-origin" })
  return res.ok
}

export async function logout(): Promise<void> {
  try {
    await fetch("/api/logout", { method: "POST", credentials: "same-origin" })
  } finally {
    clearSession()
  }
}
