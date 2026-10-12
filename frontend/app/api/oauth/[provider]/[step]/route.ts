import { NextResponse } from "next/server"
import { OAUTH_COOKIE } from "@/lib/session-constants"
import {
  applyMfaCookie,
  applyOauthCookie,
  applySessionCookie,
  backendUnavailable,
  clearOauthCookie,
  fetchBackend,
  forbiddenOrigin,
  forwardClientHeaders,
  readCookie,
  readSessionToken,
  readUpstream,
  sameOrigin,
} from "@/lib/session-cookie"

type Ctx = { params: Promise<{ provider: string; step: string }> }

const PROVIDERS = new Set(["google", "microsoft", "apple"])

/**
 * POST /api/oauth/{provider}/start  {intent: "login" | "link"}
 *   → {url}; state — в httpOnly-куку (SameSite=Lax), браузер уходит на url.
 */
export async function POST(req: Request, ctx: Ctx) {
  if (!sameOrigin(req)) return forbiddenOrigin()
  const { provider, step } = await ctx.params
  if (step !== "start" || !PROVIDERS.has(provider)) {
    return NextResponse.json({ detail: { code: "not_found" } }, { status: 404 })
  }
  const body = ((await req.json().catch(() => ({}))) ?? {}) as { intent?: string }
  const link = body.intent === "link"
  const headers: Record<string, string> = { ...(forwardClientHeaders(req) as Record<string, string>), "Content-Type": "application/json" }
  if (link) {
    const token = await readSessionToken()
    if (!token) return NextResponse.json({ detail: { code: "not_authenticated" } }, { status: 401 })
    headers.Authorization = `Bearer ${token}`
  }
  const upstream = await fetchBackend(link ? `/auth/security/social/${provider}/start` : `/auth/oauth/${provider}/start`, {
    method: "POST",
    headers,
    cache: "no-store",
  })
  if (!upstream) return backendUnavailable()
  const data = (await readUpstream(upstream)) as { url?: string; state?: string } | null
  if (!upstream.ok || !data?.url || !data.state) {
    return NextResponse.json(data ?? { detail: { code: "oauth_failed" } }, { status: upstream.ok ? 502 : upstream.status })
  }
  const res = NextResponse.json({ url: data.url })
  applyOauthCookie(res, data.state)
  return res
}

function redirect(req: Request, path: string): NextResponse {
  // За балансировщиком req.url может содержать внутренний адрес — берём публичный.
  const base = process.env.PUBLIC_APP_URL || req.url
  const res = NextResponse.redirect(new URL(path, base), 303)
  clearOauthCookie(res)
  return res
}

/** GET /api/oauth/{provider}/callback?code&state — сюда возвращает провайдер. */
export async function GET(req: Request, ctx: Ctx) {
  const { provider, step } = await ctx.params
  if (step !== "callback" || !PROVIDERS.has(provider)) return redirect(req, "/login?error=oauth_failed")
  const url = new URL(req.url)
  const code = url.searchParams.get("code")
  const state = url.searchParams.get("state")
  const expected = await readCookie(OAUTH_COOKIE)
  // state должен совпасть с кукой этого браузера: чужой callback (login CSRF) не пройдёт.
  if (!code || !state || !expected || state !== expected) {
    return redirect(req, "/login?error=oauth_state_invalid")
  }

  const upstream = await fetchBackend(`/auth/oauth/${provider}/callback`, {
    method: "POST",
    headers: { ...forwardClientHeaders(req), "Content-Type": "application/json" },
    body: JSON.stringify({ code, state }),
    cache: "no-store",
  })
  if (!upstream) return backendUnavailable()
  const data = (await readUpstream(upstream)) as {
    linked?: boolean
    access_token?: string | null
    mfa_required?: boolean
    mfa_token?: string | null
    mfa_methods?: string[]
    detail?: { code?: string }
  } | null

  if (!upstream.ok) {
    const reason = data?.detail?.code || "oauth_failed"
    return redirect(req, `/login?error=${encodeURIComponent(reason)}`)
  }
  if (data?.linked) return redirect(req, `/settings/security?linked=${provider}`)
  if (data?.mfa_required && data.mfa_token) {
    const res = redirect(req, `/login?step=mfa&methods=${encodeURIComponent((data.mfa_methods ?? []).join(","))}`)
    applyMfaCookie(res, data.mfa_token)
    return res
  }
  if (!data?.access_token) return redirect(req, "/login?error=oauth_failed")
  // Страница /login/complete ставит маркер вкладки и открывает приложение.
  const res = redirect(req, "/login/complete")
  applySessionCookie(res, data.access_token)
  return res
}
