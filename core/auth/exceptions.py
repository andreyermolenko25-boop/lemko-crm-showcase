"""Доменные ошибки авторизации / регистрации (без FastAPI)."""

from __future__ import annotations


class AuthError(Exception):
    """
    Ошибка auth-сервиса. Роутер превращает в HTTPException.

    code — машинная причина: по ней фронтенд показывает текст на языке
    интерфейса, message остаётся для Swagger и логов.
    """

    def __init__(
        self,
        code: str,
        message: str,
        *,
        status_code: int = 400,
        headers: dict[str, str] | None = None,
        **extra: object,
    ) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.status_code = status_code
        self.headers = headers
        self.extra = extra

    def as_detail(self) -> dict:
        return {"code": self.code, "message": self.message, **self.extra}
