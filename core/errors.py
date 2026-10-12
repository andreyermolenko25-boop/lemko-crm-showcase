"""
Доменные ошибки ядра и их превращение в HTTP-ответы.

Модули бизнес-логики (scheduling, inventory, crm, records…) не знают про
FastAPI: они бросают наследника DomainError с кодом причины, а обработчик
ниже отдаёт его как {"detail": {"code", "message", …}} с нужным статусом.
"""

from __future__ import annotations

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from pydantic import ValidationError


class DomainError(Exception):
    """Ошибка с машинным кодом причины. status_code и детали уходят в ответ API."""

    status_code = 400

    def __init__(
        self,
        code: str,
        message: str,
        *,
        status_code: int | None = None,
        **extra: object,
    ) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        if status_code is not None:
            self.status_code = status_code
        self.extra = extra

    def as_detail(self) -> dict:
        return {"code": self.code, "message": self.message, **self.extra}


def install_error_handlers(app: FastAPI) -> None:
    async def domain_error(_request: Request, exc: DomainError) -> JSONResponse:
        return JSONResponse(status_code=exc.status_code, content={"detail": exc.as_detail()})

    async def validation_error(_request: Request, exc: ValidationError) -> JSONResponse:
        # Нишевые схемы extra_data валидируются уже внутри обработчика:
        # ответ тот же, что у штатной валидации тела запроса.
        return JSONResponse(
            status_code=422,
            content={"detail": exc.errors(include_url=False, include_context=False)},
        )

    app.add_exception_handler(DomainError, domain_error)
    app.add_exception_handler(ValidationError, validation_error)
