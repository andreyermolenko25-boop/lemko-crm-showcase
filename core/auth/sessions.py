"""
Серверные сессии.

JWT живёт 15 минут и несёт sid. Сама сессия — строка auth_sessions: её можно
отозвать (выход, «выйти на других устройствах», смена пароля, админ отключил
сотрудника), у неё есть таймаут простоя по политике воркспейса и абсолютный
срок жизни. Проверка — одно чтение по первичному ключу на запрос; last_seen
пишется не чаще раза в SESSION_TOUCH_SECONDS.
"""

from __future__ import annotations

import secrets
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone

from sqlalchemy import select, update
from sqlalchemy.orm import Session

import models
from core.auth.policy import SecurityPolicy
from core.config import settings
from core.request_context import fingerprint_user_agent
from core.security import create_access_token

# Окно «недавнего входа» для чувствительных действий (смена email, 2FA, ключи).
REAUTH_WINDOW = timedelta(minutes=10)


@dataclass(frozen=True)
class TokenPair:
    access_token: str
    expires_in: int
    session_id: str
    token_type: str = "bearer"


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _aware(value: datetime) -> datetime:
    return value if value.tzinfo else value.replace(tzinfo=timezone.utc)


def create_session(
    db: Session,
    user: models.User,
    *,
    method: str,
    mfa: bool,
    policy: SecurityPolicy,
    ip_address: str | None,
    user_agent: str | None,
) -> models.AuthSession:
    now = utcnow()
    lifetime = max(timedelta(hours=settings.SESSION_ABSOLUTE_HOURS), timedelta(seconds=policy.idle_seconds))
    row = models.AuthSession(
        id=secrets.token_urlsafe(32),
        user_id=user.id,
        company_id=user.company_id,
        method=method,
        mfa=mfa,
        ip_address=ip_address,
        user_agent=(user_agent or "")[:512] or None,
        ua_fingerprint=fingerprint_user_agent(user_agent),
        created_at=now,
        last_seen_at=now,
        reauth_at=now,
        expires_at=now + lifetime,
    )
    db.add(row)
    db.flush()
    return row


def issue_token(user: models.User, session: models.AuthSession) -> TokenPair:
    token, expires_in = create_access_token(
        user_id=user.id,
        company_id=user.company_id,
        role=user.role.value,
        session_id=session.id,
        ip_address=session.ip_address,
        ua_fingerprint=session.ua_fingerprint,
    )
    return TokenPair(access_token=token, expires_in=expires_in, session_id=session.id)


def session_problem(session: models.AuthSession | None, user: models.User, policy: SecurityPolicy) -> str | None:
    """Почему сессия недействительна (код ошибки) или None."""
    if session is None or session.user_id != user.id:
        return "session_revoked"
    if session.revoked_at is not None:
        return "session_revoked"
    now = utcnow()
    if _aware(session.expires_at) <= now:
        return "session_expired"
    if _aware(session.last_seen_at) + timedelta(seconds=policy.idle_seconds) <= now:
        return "session_idle"
    return None


def touch(db: Session, session: models.AuthSession) -> None:
    """last_seen не чаще раза в минуту: на каждый запрос писать в БД незачем."""
    now = utcnow()
    if _aware(session.last_seen_at) + timedelta(seconds=settings.SESSION_TOUCH_SECONDS) <= now:
        db.execute(
            update(models.AuthSession).where(models.AuthSession.id == session.id).values(last_seen_at=now)
        )
        db.commit()
        session.last_seen_at = now


def recently_authenticated(session: models.AuthSession) -> bool:
    stamp = session.reauth_at or session.created_at
    return _aware(stamp) + REAUTH_WINDOW > utcnow()


def revoke(db: Session, session: models.AuthSession, reason: str) -> None:
    if session.revoked_at is None:
        session.revoked_at = utcnow()
        session.revoke_reason = reason


def revoke_all(db: Session, *, user_id: int, reason: str, except_id: str | None = None) -> int:
    stmt = (
        update(models.AuthSession)
        .where(models.AuthSession.user_id == user_id, models.AuthSession.revoked_at.is_(None))
        .values(revoked_at=utcnow(), revoke_reason=reason)
    )
    if except_id:
        stmt = stmt.where(models.AuthSession.id != except_id)
    return db.execute(stmt).rowcount or 0


def active_sessions(db: Session, *, user_id: int) -> list[models.AuthSession]:
    now = utcnow()
    return list(
        db.scalars(
            select(models.AuthSession)
            .where(
                models.AuthSession.user_id == user_id,
                models.AuthSession.revoked_at.is_(None),
                models.AuthSession.expires_at > now,
            )
            .order_by(models.AuthSession.last_seen_at.desc())
            .limit(50)
        )
    )


def known_device(db: Session, *, user_id: int, ua_fingerprint: str | None) -> bool:
    """Был ли уже вход с этого браузера/устройства (для письма о новом устройстве)."""
    if not ua_fingerprint:
        return False
    return (
        db.scalar(
            select(models.AuthSession.id)
            .where(models.AuthSession.user_id == user_id, models.AuthSession.ua_fingerprint == ua_fingerprint)
            .limit(1)
        )
        is not None
    )
