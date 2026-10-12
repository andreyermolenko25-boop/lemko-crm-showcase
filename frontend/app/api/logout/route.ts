import { NextResponse } from "next/server"
import {
  backendOrigin,
  clearSessionCookie,
  forbiddenOrigin,
  forwardClientHeaders,
  readSessionToken,
  sameOrigin,
} from "@/lib/session-cookie"

export async function POST(req: Request) {
  if (!sameOrigin(req)) return forbiddenOrigin()
  const token = await readSessionToken()

  if (token) {
    try {
      await fetch(`${backendOrigin()}/auth/logout`, {
        method: "POST",
        headers: {
          ...forwardClientHeaders(req),
          Authorization: `Bearer ${token}`,
        },
        cache: "no-store",
      })
    } catch {
      // куку чистим в любом случае
    }
  }

  const res = new NextResponse(null, { status: 204 })
  clearSessionCookie(res)
  return res
}
