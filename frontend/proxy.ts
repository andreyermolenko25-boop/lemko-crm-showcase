import { NextResponse, type NextRequest } from "next/server"

/**
 * Content-Security-Policy с одноразовым nonce на каждый запрос + заголовки
 * безопасности. Скрипт без nonce (внедрённый через XSS) браузер не выполнит;
 * 'strict-dynamic' разрешает только то, что загрузили доверенные скрипты Next.
 * Next.js сам читает nonce из CSP запроса и ставит его на свои <script>.
 */
export function proxy(request: NextRequest) {
  const nonce = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16))))
  const dev = process.env.NODE_ENV !== "production"
  // Тот же признак, что у Secure-куки: локальный docker по HTTP — без HSTS и апгрейда.
  const https = process.env.COOKIE_SECURE != null ? ["1", "true", "yes"].includes(process.env.COOKIE_SECURE.toLowerCase()) : !dev
  const csp = [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${dev ? " 'unsafe-eval'" : ""}`,
    // Стили: Tailwind + инлайн-стили анимаций (motion) и графиков (recharts).
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    // https: — установка пакета модулей по URL (Apps → Add module).
    `connect-src 'self' https:${dev ? " ws:" : ""}`,
    "worker-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    ...(https ? ["upgrade-insecure-requests"] : []),
  ].join("; ")

  const requestHeaders = new Headers(request.headers)
  requestHeaders.set("x-nonce", nonce)
  requestHeaders.set("Content-Security-Policy", csp)

  const response = NextResponse.next({ request: { headers: requestHeaders } })
  response.headers.set("Content-Security-Policy", csp)
  response.headers.set("X-Content-Type-Options", "nosniff")
  response.headers.set("X-Frame-Options", "DENY")
  response.headers.set("Referrer-Policy", "strict-origin-when-cross-origin")
  response.headers.set("Cross-Origin-Opener-Policy", "same-origin")
  // publickey-credentials-* — passkeys в настройках безопасности и при входе.
  response.headers.set(
    "Permissions-Policy",
    "camera=(), microphone=(), geolocation=(), payment=(), usb=(), publickey-credentials-get=(self), publickey-credentials-create=(self)",
  )
  if (https) response.headers.set("Strict-Transport-Security", "max-age=63072000; includeSubDomains; preload")
  return response
}

export const config = {
  matcher: [
    // Страницы. API-маршруты BFF отдают свои заголовки сами;
    // статика Next кэшируется и nonce не нужен.
    {
      source: "/((?!api/|_next/static|_next/image|favicon.ico|icon|apple-icon|.*\\.(?:png|svg|jpg|jpeg|webp|ico|txt)$).*)",
      missing: [
        { type: "header", key: "next-router-prefetch" },
        { type: "header", key: "purpose", value: "prefetch" },
      ],
    },
  ],
}
