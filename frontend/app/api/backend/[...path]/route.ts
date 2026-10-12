import { NextRequest, NextResponse } from "next/server"
import {
  backendUnavailable,
  clearSessionCookie,
  fetchBackend,
  forbiddenOrigin,
  forwardClientHeaders,
  readSessionToken,
  sameOrigin,
} from "@/lib/session-cookie"

type Ctx = { params: Promise<{ path: string[] }> }

/**
 * BFF-прокси: читает httpOnly session cookie и ходит в FastAPI с Bearer.
 * Браузер никогда не видит JWT.
 */
/**
 * Эндпоинты, которые кладут JWT в тело ответа. Через общий прокси их не
 * пускаем: иначе токен прочитал бы браузерный JS (и любой XSS). Для них есть
 * отдельные BFF-маршруты (/api/login, /api/refresh, /api/oauth/*).
 */
const TOKEN_ENDPOINTS = /^auth\/(login|refresh|mfa\/|magic\/verify|oauth\/[^/]+\/callback)/

async function proxy(req: NextRequest, ctx: Ctx) {
  const segments = (await ctx.params).path ?? []
  const suffix = segments.join("/")
  const url = new URL(req.url)

  if (TOKEN_ENDPOINTS.test(suffix) || segments.some((s) => s === ".." || s.includes("\\"))) {
    return NextResponse.json({ detail: { code: "not_found", message: "Not found" } }, { status: 404 })
  }
  if (!sameOrigin(req)) return forbiddenOrigin()

  const token = await readSessionToken()
  const headers = new Headers(forwardClientHeaders(req))

  // Не форсим JSON Content-Type на GET/без тела
  if (req.method === "GET" || req.method === "HEAD") {
    headers.delete("Content-Type")
  }

  if (token) {
    headers.set("Authorization", `Bearer ${token}`)
  }

  const init: RequestInit = {
    method: req.method,
    headers,
    cache: "no-store",
  }

  if (req.method !== "GET" && req.method !== "HEAD") {
    const body = await req.arrayBuffer()
    if (body.byteLength) init.body = body
  }

  const upstream = await fetchBackend(`/${suffix}${url.search}`, init)
  if (!upstream) return backendUnavailable()
  const resHeaders = new Headers()
  for (const name of ["content-type", "content-disposition", "cache-control"]) {
    const value = upstream.headers.get(name)
    if (value) resHeaders.set(name, value)
  }

  const res = new NextResponse(upstream.body, {
    status: upstream.status,
    headers: resHeaders,
  })

  if (upstream.status === 401) {
    clearSessionCookie(res)
  }

  return res
}

export const GET = proxy
export const POST = proxy
export const PUT = proxy
export const PATCH = proxy
export const DELETE = proxy
