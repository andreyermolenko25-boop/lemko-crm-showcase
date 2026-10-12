import { NextResponse } from "next/server"
import { MFA_COOKIE } from "@/lib/session-constants"
import {
  backendUnavailable,
  clearMfaCookie,
  fetchBackend,
  forbiddenOrigin,
  forwardClientHeaders,
  loginResult,
  readCookie,
  readUpstream,
  sameOrigin,
} from "@/lib/session-cookie"

type Ctx = { params: Promise<{ action: string }> }

/**
 * Второй шаг входа и вход по ссылке:
 *   POST /api/login/verify   {method, code?, credential?} — код 2FA / passkey
 *   POST /api/login/sms                                    — прислать SMS-код
 *   POST /api/login/passkey                                — опции WebAuthn
 *   POST /api/login/magic    {token}                       — ссылка из письма
 * mfa_token берётся из httpOnly-куки, браузерный JS его не видит.
 */
export async function POST(req: Request, ctx: Ctx) {
  if (!sameOrigin(req)) return forbiddenOrigin()
  const { action } = await ctx.params
  let body: Record<string, unknown> = {}
  try {
    body = ((await req.json()) as Record<string, unknown>) ?? {}
  } catch {
    body = {}
  }

  let path: string
  let payload: Record<string, unknown>
  if (action === "magic") {
    path = "/auth/magic/verify"
    payload = { token: body.token }
  } else {
    const mfaToken = await readCookie(MFA_COOKIE)
    if (!mfaToken) {
      return NextResponse.json({ detail: { code: "mfa_expired", message: "Sign-in step expired" } }, { status: 401 })
    }
    if (action === "verify") {
      path = "/auth/mfa/verify"
      payload = { mfa_token: mfaToken, method: body.method, code: body.code ?? null, credential: body.credential ?? null }
    } else if (action === "sms") {
      path = "/auth/mfa/sms"
      payload = { mfa_token: mfaToken }
    } else if (action === "passkey") {
      path = "/auth/mfa/passkey/options"
      payload = { mfa_token: mfaToken }
    } else {
      return NextResponse.json({ detail: { code: "not_found", message: "Not found" } }, { status: 404 })
    }
  }

  const upstream = await fetchBackend(path, {
    method: "POST",
    headers: { ...forwardClientHeaders(req), "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    cache: "no-store",
  })
  if (!upstream) return backendUnavailable()
  const data = await readUpstream(upstream)

  if (!upstream.ok) {
    const res = NextResponse.json(data ?? { detail: { code: "login_failed" } }, { status: upstream.status })
    // Проверка сгорела — начинать вход заново.
    const code = (data as { detail?: { code?: string } } | null)?.detail?.code
    if (code === "mfa_expired") clearMfaCookie(res)
    return res
  }
  if (action === "sms" || action === "passkey") return NextResponse.json(data)
  return loginResult(data)
}
