"""
HTTP middleware ядра: CORS, заголовки безопасности и привязка запроса
к audit-контексту.
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable

from fastapi import FastAPI, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from starlette.middleware.base import BaseHTTPMiddleware

import audit
from core.config import settings
from core.request_context import client_ip

# API отдаёт только JSON и файлы: ничего не должно исполняться, встраиваться
# во фреймы или кэшироваться по дороге.
_SECURITY_HEADERS = {
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Resource-Policy": "same-site",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=()",
    "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
}


class SecurityHeadersMiddleware(BaseHTTPMiddleware):
    async def dispatch(
        self,
        request: Request,
        call_next: Callable[[Request], Awaitable[Response]],
    ) -> Response:
        response = await call_next(request)
        for name, value in _SECURITY_HEADERS.items():
            response.headers.setdefault(name, value)
        # Swagger в DEBUG грузит скрипты с CDN — ему CSP API не подходит.
        if settings.DEBUG and request.url.path in ("/docs", "/redoc"):
            del response.headers["Content-Security-Policy"]
        if not settings.DEBUG:
            response.headers.setdefault("Strict-Transport-Security", "max-age=63072000; includeSubDomains; preload")
        # Ответы с данными клиентов не кэшируются ни браузером, ни прокси.
        response.headers.setdefault("Cache-Control", "no-store")
        return response


class AuditRequestMiddleware(BaseHTTPMiddleware):
    """IP и путь запроса — в журнал вместе с INSERT/UPDATE/DELETE."""

    async def dispatch(
        self,
        request: Request,
        call_next: Callable[[Request], Awaitable[Response]],
    ) -> Response:
        token = audit.bind_request(
            ip=client_ip(request), method=request.method, path=request.url.path
        )
        try:
            return await call_next(request)
        finally:
            audit.reset_request(token)


def setup_core_middleware(app: FastAPI) -> None:
    """Подключает CORS, заголовки безопасности и audit middleware."""
    if settings.CORS_ORIGINS:
        app.add_middleware(
            CORSMiddleware,
            allow_origins=settings.CORS_ORIGINS,
            allow_credentials=True,
            allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE"],
            allow_headers=["Authorization", "Content-Type", "X-API-Key"],
        )
    app.add_middleware(AuditRequestMiddleware)
    app.add_middleware(SecurityHeadersMiddleware)
