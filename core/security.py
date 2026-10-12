"""
Примитивы безопасности ядра: хэширование паролей (passlib/bcrypt) и JWT.

Чистые функции без БД и FastAPI. Сессия/регистрация — `core.auth`,
зависимости HTTP — `core.deps`.
"""

from __future__ import annotations

import logging
from datetime import datetime, timedelta, timezone
from typing import Any

import jwt
from passlib.context import CryptContext

from core.config import settings

# passlib 1.7.4 не умеет читать версию bcrypt >= 4.1 и пишет в лог
# "(trapped) error reading bcrypt version". Ошибка перехвачена самим passlib
# и ни на что не влияет — глушим шум в логах.
logging.getLogger("passlib.handlers.bcrypt").setLevel(logging.ERROR)

# Argon2id (рекомендация OWASP): устойчив к перебору на GPU за счёт памяти и при
# этом быстрее bcrypt-12 (~25 мс против ~250 мс на вход). Параметры — минимум
# OWASP (19 MiB, t=2, p=1). Старые bcrypt-хэши проверяются и при входе
# прозрачно перехэшируются (deprecated="auto" + needs_rehash).
pwd_context = CryptContext(
    schemes=["argon2", "bcrypt"],
    deprecated="auto",
    argon2__type="ID",
    argon2__memory_cost=19456,
    argon2__time_cost=2,
    argon2__parallelism=1,
)

# Ограничение длины — защита от DoS огромным паролем (хэширование дорогое).
PASSWORD_MAX_BYTES = 256
# Оставлено для совместимости импортов: схемы ссылаются на это имя.
BCRYPT_MAX_BYTES = PASSWORD_MAX_BYTES

TOKEN_TYPE_ACCESS = "access"


# --------------------------------------------------------------------------- #
#  Пароли
# --------------------------------------------------------------------------- #

def hash_password(password: str) -> str:
    """
    Возвращает bcrypt-хэш пароля (соль генерируется автоматически).

    Слишком длинный пароль отклоняем явно (хэширование намеренно дорогое).
    """
    if len(password.encode("utf-8")) > PASSWORD_MAX_BYTES:
        raise ValueError(f"Пароль не должен превышать {PASSWORD_MAX_BYTES} байт")
    return pwd_context.hash(password)


def verify_password(plain_password: str, hashed_password: str | None) -> bool:
    """
    Сверяет пароль с хэшем.

    Если у пользователя хэша нет (вход только через SSO) — сравнение
    всё равно выполняется на фиктивном хэше, чтобы время ответа не выдавало
    существование учётной записи (защита от timing-атак).
    """
    if not hashed_password:
        pwd_context.dummy_verify()
        return False
    if len(plain_password.encode("utf-8")) > PASSWORD_MAX_BYTES:
        pwd_context.dummy_verify()
        return False
    try:
        return pwd_context.verify(plain_password, hashed_password)
    except ValueError:
        # Битый или обрезанный хэш в БД не должен ронять запрос.
        return False


def needs_rehash(hashed_password: str) -> bool:
    """True, если хэш создан устаревшей схемой и его пора обновить при входе."""
    return pwd_context.needs_update(hashed_password)


# --------------------------------------------------------------------------- #
#  JWT
# --------------------------------------------------------------------------- #

def create_access_token(
    *,
    user_id: int,
    company_id: int,
    role: str,
    session_id: str,
    ip_address: str | None = None,
    ua_fingerprint: str | None = None,
    expires_delta: timedelta | None = None,
) -> tuple[str, int]:
    """
    Собирает access-токен и возвращает (токен, время жизни в секундах).

    company_id кладём внутрь токена намеренно: тенант должен приходить
    из подписанных данных, а не из тела запроса, которое клиент может подменить.

    ip / uaf — привязка сессии к сети и устройству (анти-theft).
    """
    ttl = expires_delta or timedelta(minutes=settings.ACCESS_TOKEN_EXPIRE_MINUTES)
    now = datetime.now(timezone.utc)

    payload: dict[str, Any] = {
        "sub": str(user_id),          # по спецификации JWT sub — строка
        "cid": company_id,            # company_id (тенант)
        "role": role,
        "sid": session_id,            # серверная сессия: отзыв без ожидания exp
        "typ": TOKEN_TYPE_ACCESS,
        "iat": now,
        "exp": now + ttl,
    }
    if ip_address:
        payload["ip"] = ip_address
    if ua_fingerprint:
        payload["uaf"] = ua_fingerprint
    token = jwt.encode(payload, settings.SECRET_KEY, algorithm=settings.JWT_ALGORITHM)
    return token, int(ttl.total_seconds())


def decode_access_token(token: str) -> dict[str, Any]:
    """
    Проверяет подпись и срок действия токена, возвращает payload.

    Бросает jwt.PyJWTError (истёк срок, битая подпись, чужой алгоритм) —
    вызывающий код превращает это в 401.
    """
    payload = jwt.decode(
        token,
        settings.SECRET_KEY,
        algorithms=[settings.JWT_ALGORITHM],   # список фиксирован: защита от подмены alg
        options={"require": ["exp", "sub", "sid"]},
    )
    if payload.get("typ") != TOKEN_TYPE_ACCESS:
        raise jwt.InvalidTokenError("Ожидался access-токен")
    return payload
