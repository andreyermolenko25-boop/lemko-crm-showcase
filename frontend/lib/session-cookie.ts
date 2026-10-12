/**
 * Строгие session-cookie для JWT на домене Next.js.
 * Без maxAge/expires — браузер удаляет куку при закрытии вкладки/окна.
 *
 * Только server / Route Handlers (next/headers).
 */

import { cookies } from "next/headers"
import { NextResponse } from "next/server"
import { MFA_COOKIE, OAUTH_COOKIE, SESSION_COOKIE } from "@/lib/session-constants"

export { SESSION_COOKIE } from "@/lib/session-constants"

/** Как в ТЗ: secure только в production (локальный HTTP — COOKIE_SECURE=false). */
export function cookieSecure(): boolean {
  if (process.env.COOKIE_SECURE != null) {
    return ["1", "true", "yes"].includes(process.env.COOKIE_SECURE.toLowerCase())
  }
  return process.env.NODE_ENV === "production"
}

/**
 * Опции Set-Cookie. maxAge и expires НЕ задаём — это session cookie.
 */
export function sessionCookieOptions() {
  return {
    httpOnly: true as const,
    secure: cookieSecure(),
    sameSite: "strict" as const,
    path: "/",
  }
}

export function applySessionCookie(res: NextResponse, token: string): void {
  res.cookies.set({
    name: SESSION_COOKIE,
    value: token,
    ...sessionCookieOptions(),
    // намеренно без maxAge / expires
  })
}

export function clearSessionCookie(res: NextResponse): void {
  res.cookies.set({
    name: SESSION_COOKIE,
    value: "",
    ...sessionCookieOptions(),
    maxAge: 0,
  })
}

/** Второй шаг входа: mfa_token живёт 5 минут в httpOnly-куке, JS его не видит. */
export function applyMfaCookie(res: NextResponse, token: string): void {
  res.cookies.set({ name: MFA_COOKIE, value: token, ...sessionCookieOptions(), path: "/api/login", maxAge: 300 })
}

export function clearMfaCookie(res: NextResponse): void {
  res.cookies.set({ name: MFA_COOKIE, value: "", ...sessionCookieOptions(), path: "/api/login", maxAge: 0 })
}

/**
 * OAuth state: SameSite=Lax — кука должна дойти на callback, куда браузер
 * возвращается редиректом с google.com / microsoftonline.com / apple.com.
 */
export function applyOauthCookie(res: NextResponse, state: string): void {
  res.cookies.set({ name: OAUTH_COOKIE, value: state, httpOnly: true, secure: cookieSecure(), sameSite: "lax", path: "/api/oauth", maxAge: 600 })
}

export function clearOauthCookie(res: NextResponse): void {
  res.cookies.set({ name: OAUTH_COOKIE, value: "", httpOnly: true, secure: cookieSecure(), sameSite: "lax", path: "/api/oauth", maxAge: 0 })
}

export async function readCookie(name: string): Promise<string | null> {
  const jar = await cookies()
  return jar.get(name)?.value ?? null
}

export async function readSessionToken(): Promise<string | null> {
  return readCookie(SESSION_COOKIE)
}

/** FastAPI origin as seen from the Next.js server (API_URL, e.g. http://backend:8000 in Docker). */
export function backendOrigin(): string {
  return (process.env.API_URL || "http://localhost:8000").replace(/\/$/, "")
}

/**
 * fetch к FastAPI. null — бэкенд недоступен (не запущен / неверный API_URL),
 * вместо необработанного исключения и пустого 500 в браузере.
 */
export async function fetchBackend(path: string, init: RequestInit): Promise<Response | null> {
  const url = `${backendOrigin()}${path}`
  try {
    return await fetch(url, init)
  } catch (err) {
    console.error(`[bff] backend unreachable: ${url}`, err)
    return null
  }
}

export function backendUnavailable(): NextResponse {
  return NextResponse.json(
    { detail: { code: "backend_unavailable", message: `API server is unreachable (${backendOrigin()}). Is the backend running?` } },
    { status: 502 },
  )
}

/**
 * IP клиента. Каждый доверенный прокси (ALB, CloudFront) дописывает в
 * X-Forwarded-For адрес, с которого к нему пришли, поэтому клиент — запись
 * TRUST_PROXY_HOPS-я справа. Всё левее мог написать сам клиент.
 * Без прокси Next.js кладёт туда адрес сокета (если заголовка не было).
 */
export function clientIp(req: Request): string {
  const hops = Math.max(1, Number(process.env.TRUST_PROXY_HOPS || "1") || 1)
  const list = (req.headers.get("x-forwarded-for") || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
  return list[Math.max(0, list.length - hops)] || ""
}

export function forwardClientHeaders(req: Request): HeadersInit {
  const ip = clientIp(req)
  return {
    // multipart (загрузка логотипа) должен дойти со своим boundary.
    "Content-Type": req.headers.get("content-type") || "application/json",
    "User-Agent": req.headers.get("user-agent") || "lemko-frontend",
    ...(ip ? { "X-Forwarded-For": ip } : {}),
  }
}

/**
 * CSRF-защита в глубину (кроме SameSite=Strict): изменяющие запросы принимаются
 * только со своего origin. Браузер всегда шлёт Origin для POST/PUT/PATCH/DELETE.
 */
export function sameOrigin(req: Request): boolean {
  const origin = req.headers.get("origin")
  if (!origin) return req.method === "GET" || req.method === "HEAD"
  const host = req.headers.get("x-forwarded-host") || req.headers.get("host")
  try {
    return new URL(origin).host === host
  } catch {
    return false
  }
}

export function forbiddenOrigin(): NextResponse {
  return NextResponse.json({ detail: { code: "bad_origin", message: "Cross-origin request blocked" } }, { status: 403 })
}

/** Ответ бэкенда: JSON или текст. */
export async function readUpstream(upstream: Response): Promise<unknown> {
  const text = await upstream.text()
  if (!text) return null
  try {
    return JSON.parse(text)
  } catch {
    return { detail: text }
  }
}

type LoginPayload = {
  access_token?: string | null
  expires_in?: number | null
  mfa_required?: boolean
  mfa_token?: string | null
  mfa_methods?: string[]
}

/**
 * Превращает ответ бэкенда о входе (пароль, код, ссылка, Google…) в ответ
 * браузеру: токен — только в httpOnly-куку, mfa_token — тоже в куку.
 */
export function loginResult(data: unknown, extra: Record<string, unknown> = {}): NextResponse {
  const body = (data ?? {}) as LoginPayload
  if (body.mfa_required && body.mfa_token) {
    const res = NextResponse.json({ ok: false, mfa_required: true, methods: body.mfa_methods ?? [], ...extra })
    applyMfaCookie(res, body.mfa_token)
    return res
  }
  if (!body.access_token) {
    return NextResponse.json({ detail: { code: "login_failed", message: "No access_token from backend" } }, { status: 502 })
  }
  const res = NextResponse.json({ ok: true, expires_in: body.expires_in ?? 900, ...extra })
  applySessionCookie(res, body.access_token)
  clearMfaCookie(res)
  return res
}
