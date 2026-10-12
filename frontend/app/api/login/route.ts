import { NextResponse } from "next/server"
import {
  backendUnavailable,
  fetchBackend,
  forbiddenOrigin,
  forwardClientHeaders,
  loginResult,
  readUpstream,
  sameOrigin,
} from "@/lib/session-cookie"

/** Вход по паролю. JWT и mfa_token уходят только в httpOnly-куки. */
export async function POST(req: Request) {
  if (!sameOrigin(req)) return forbiddenOrigin()
  let body: unknown
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ detail: { code: "invalid_json", message: "Invalid JSON" } }, { status: 400 })
  }

  const upstream = await fetchBackend("/auth/login", {
    method: "POST",
    headers: forwardClientHeaders(req),
    body: JSON.stringify(body),
    cache: "no-store",
  })
  if (!upstream) return backendUnavailable()

  const data = await readUpstream(upstream)
  if (!upstream.ok) {
    return NextResponse.json(data ?? { detail: { code: "login_failed", message: "Login failed" } }, { status: upstream.status })
  }
  return loginResult(data)
}
