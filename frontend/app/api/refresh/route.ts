import { NextResponse } from "next/server"
import {
  applySessionCookie,
  backendUnavailable,
  clearSessionCookie,
  fetchBackend,
  forbiddenOrigin,
  forwardClientHeaders,
  readSessionToken,
  sameOrigin,
} from "@/lib/session-cookie"

/** Silent refresh — продлевает session cookie ещё на TTL JWT (~15 мин). */
export async function POST(req: Request) {
  if (!sameOrigin(req)) return forbiddenOrigin()
  const token = await readSessionToken()
  if (!token) {
    return NextResponse.json({ detail: "No session" }, { status: 401 })
  }

  const upstream = await fetchBackend("/auth/refresh", {
    method: "POST",
    headers: {
      ...forwardClientHeaders(req),
      Authorization: `Bearer ${token}`,
    },
    cache: "no-store",
  })
  // Сессию не сбрасываем: бэкенд просто недоступен, токен может быть ещё валиден.
  if (!upstream) return backendUnavailable()

  const text = await upstream.text()
  let data: unknown = null
  if (text) {
    try {
      data = JSON.parse(text)
    } catch {
      data = { detail: text }
    }
  }

  if (!upstream.ok) {
    const res = NextResponse.json(data ?? { detail: "Refresh failed" }, { status: upstream.status })
    clearSessionCookie(res)
    return res
  }

  const nextToken =
    data && typeof data === "object" && "access_token" in data
      ? String((data as { access_token: string }).access_token)
      : null

  if (!nextToken) {
    const res = NextResponse.json({ detail: "No access_token" }, { status: 502 })
    clearSessionCookie(res)
    return res
  }

  const res = NextResponse.json({
    ok: true,
    expires_in:
      data && typeof data === "object" && "expires_in" in data
        ? (data as { expires_in: number }).expires_in
        : 900,
  })
  applySessionCookie(res, nextToken)
  return res
}
