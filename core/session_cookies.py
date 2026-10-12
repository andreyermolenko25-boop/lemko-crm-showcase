"""
Строгие сессионные куки для JWT.

Без maxAge/expires → Session Cookie (браузер удаляет при закрытии).
"""

from __future__ import annotations

import os

from fastapi import Response

from core.config import settings

COOKIE_NAME = "lemko_session"


def cookie_secure() -> bool:
    """
    Соответствует фронту: secure в production.
    Локальный HTTP (docker): COOKIE_SECURE=false.
    """
    raw = os.getenv("COOKIE_SECURE")
    if raw is not None:
        return raw.lower() in ("1", "true", "yes")
    return not settings.DEBUG


def session_cookie_kwargs() -> dict:
    """Флаги защиты. maxAge/expires намеренно отсутствуют."""
    return {
        "key": COOKIE_NAME,
        "httponly": True,
        "secure": cookie_secure(),
        "samesite": "strict",
        "path": "/",
    }


def set_session_cookie(response: Response, token: str) -> None:
    """Ставит session cookie с JWT. Без max_age / expires."""
    kwargs = session_cookie_kwargs()
    response.set_cookie(value=token, **kwargs)


def clear_session_cookie(response: Response) -> None:
    """Стирает session cookie (logout)."""
    kwargs = session_cookie_kwargs()
    response.delete_cookie(
        key=kwargs["key"],
        path=kwargs["path"],
        secure=kwargs["secure"],
        httponly=kwargs["httponly"],
        samesite=kwargs["samesite"],
    )
