"""
Журнал действий: кто, что, когда изменил.

Пишется слушателем сессии в той же транзакции, что INSERT/UPDATE/DELETE.
HTTP-чтение не логируем. Пароли в снимок не попадают.
"""

from __future__ import annotations

from contextvars import ContextVar, Token
from dataclasses import dataclass, field
from datetime import date, datetime
from decimal import Decimal
from enum import Enum
from typing import Any

from sqlalchemy import event, inspect, insert, select
from sqlalchemy.orm import Mapper, Session

import models

# Служебные таблицы: лог самого себя, внутренний outbox и служебные таблицы
# безопасности (сессии, коды, лимиты) — их история в auth_logs, а снимки
# содержали бы хэши кодов и challenge.
_SKIP_TABLES = frozenset(
    {
        "audit_logs", "notification_outbox", "activities", "activity_reads", "saved_views",
        "auth_sessions", "auth_challenges", "rate_limit_counters", "webauthn_credentials", "user_identities",
    }
)
_REDACT = frozenset(
    {"hashed_password", "key_hash", "secret_key", "secret", "totp_secret", "backup_codes", "totp_last_step"}
)
_NOISE = frozenset({"updated_at"})

_PENDING_KEY = "_audit_pending"


@dataclass
class RequestContext:
    actor_user_id: int | None = None
    company_id: int | None = None
    ip: str | None = None
    method: str | None = None
    path: str | None = None


_request_ctx: ContextVar[RequestContext] = ContextVar(
    "audit_request_ctx", default=RequestContext()
)


def bind_request(*, ip: str | None, method: str | None, path: str | None) -> Token:
    return _request_ctx.set(RequestContext(ip=ip, method=method, path=path))


def reset_request(token: Token) -> None:
    _request_ctx.reset(token)


def set_actor(user: models.User, session: Session | None = None) -> None:
    current = _request_ctx.get()
    ctx = RequestContext(
        actor_user_id=user.id,
        company_id=user.company_id,
        ip=current.ip,
        method=current.method,
        path=current.path,
    )
    _request_ctx.set(ctx)
    if session is not None:
        attach_session(session, actor=user)


def attach_session(session: Session, actor: models.User | None = None) -> None:
    """Копирует контекст запроса в session.info — flush идёт в том же потоке."""
    ctx = _request_ctx.get()
    session.info.setdefault("audit_ip", ctx.ip)
    session.info.setdefault("audit_method", ctx.method)
    session.info.setdefault("audit_path", ctx.path)
    if actor is not None:
        session.info["audit_actor_id"] = actor.id
        session.info["audit_company_id"] = actor.company_id
    elif ctx.actor_user_id is not None:
        session.info.setdefault("audit_actor_id", ctx.actor_user_id)
        session.info.setdefault("audit_company_id", ctx.company_id)


def _json_safe(value: Any, *, key: str | None = None) -> Any:
    if key in _REDACT:
        return "***"
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    if isinstance(value, Decimal):
        return str(value)
    if isinstance(value, datetime):
        return value.isoformat()
    if isinstance(value, date):
        return value.isoformat()
    if isinstance(value, Enum):
        return value.value
    if isinstance(value, dict):
        return {str(k): _json_safe(v, key=str(k)) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [_json_safe(item) for item in value]
    return str(value)


def _column_snapshot(obj: object) -> dict[str, Any]:
    mapper: Mapper = inspect(obj).mapper
    data: dict[str, Any] = {}
    for column in mapper.column_attrs:
        key = column.key
        data[key] = _json_safe(getattr(obj, key), key=key)
    return data


def _changed_fields(obj: object) -> dict[str, Any]:
    state = inspect(obj)
    changes: dict[str, Any] = {}
    for attr in state.mapper.column_attrs:
        key = attr.key
        if key in _NOISE:
            continue
        history = state.attrs[key].history
        if not history.has_changes():
            continue
        old = history.deleted[0] if history.deleted else None
        new = history.added[0] if history.added else getattr(obj, key)
        changes[key] = {
            "old": _json_safe(old, key=key),
            "new": _json_safe(new, key=key),
        }
    return changes


def _company_id_of(obj: object) -> int | None:
    if isinstance(obj, models.Company):
        return obj.id
    return getattr(obj, "company_id", None)


def _should_skip(obj: object) -> bool:
    table = getattr(obj, "__tablename__", None)
    return table is None or table in _SKIP_TABLES


def _actor_and_request(session: Session) -> tuple[int | None, int | None, RequestContext]:
    ctx = _request_ctx.get()
    return (
        session.info.get("audit_actor_id", ctx.actor_user_id),
        session.info.get("audit_company_id", ctx.company_id),
        RequestContext(
            actor_user_id=session.info.get("audit_actor_id", ctx.actor_user_id),
            company_id=session.info.get("audit_company_id", ctx.company_id),
            ip=session.info.get("audit_ip", ctx.ip),
            method=session.info.get("audit_method", ctx.method),
            path=session.info.get("audit_path", ctx.path),
        ),
    )


@dataclass
class _Pending:
    action: models.AuditAction
    obj: object
    changes: dict[str, Any] = field(default_factory=dict)
    snapshot: dict[str, Any] = field(default_factory=dict)


@event.listens_for(Session, "before_flush")
def _collect_audit(session: Session, flush_context, instances) -> None:  # noqa: ARG001
    pending: list[_Pending] = list(session.info.get(_PENDING_KEY, []))
    seen = {id(item.obj) for item in pending}

    for obj in session.new:
        if _should_skip(obj) or id(obj) in seen:
            continue
        pending.append(
            _Pending(
                action=models.AuditAction.CREATED,
                obj=obj,
                snapshot=_column_snapshot(obj),
            )
        )
        seen.add(id(obj))

    for obj in session.dirty:
        if _should_skip(obj) or id(obj) in seen:
            continue
        if not session.is_modified(obj, include_collections=False):
            continue
        changes = _changed_fields(obj)
        if not changes:
            continue
        pending.append(
            _Pending(action=models.AuditAction.UPDATED, obj=obj, changes=changes)
        )
        seen.add(id(obj))

    for obj in session.deleted:
        if _should_skip(obj) or id(obj) in seen:
            continue
        pending.append(
            _Pending(
                action=models.AuditAction.DELETED,
                obj=obj,
                snapshot=_column_snapshot(obj),
            )
        )
        seen.add(id(obj))

    session.info[_PENDING_KEY] = pending


@event.listens_for(Session, "after_flush")
def _write_audit(session: Session, flush_context) -> None:  # noqa: ARG001
    pending: list[_Pending] = session.info.pop(_PENDING_KEY, [])
    if not pending:
        return

    actor_id, fallback_company, ctx = _actor_and_request(session)
    deleted_company_ids = {
        obj.id for obj in session.deleted if isinstance(obj, models.Company)
    }
    deleted_user_ids = {
        obj.id for obj in session.deleted if isinstance(obj, models.User)
    }
    rows: list[dict[str, Any]] = []
    for item in pending:
        entity_id = getattr(item.obj, "id", None)
        company_id = _company_id_of(item.obj) or fallback_company
        if company_id is None or company_id in deleted_company_ids:
            # Тенант уходит вместе с CASCADE журнала — новые строки туда не вставить.
            continue
        snapshot = (
            _column_snapshot(item.obj)
            if item.action is models.AuditAction.CREATED
            else dict(item.snapshot)
        )
        row_actor = actor_id
        if row_actor in deleted_user_ids:
            row_actor = None
        rows.append(
            {
                "company_id": company_id,
                "actor_user_id": row_actor,
                "action": item.action,
                "entity_type": item.obj.__tablename__,
                "entity_id": entity_id,
                "changes": item.changes,
                "snapshot": snapshot,
                "request_ip": ctx.ip,
                "request_method": ctx.method,
                "request_path": ctx.path,
            }
        )
    if not rows:
        return
    # Core INSERT: та же транзакция, без второго прохода ORM-слушателя.
    session.execute(insert(models.AuditLog.__table__), rows)


def list_logs(
    db: Session,
    *,
    company_id: int,
    entity_type: str | None = None,
    entity_id: int | None = None,
    actor_user_id: int | None = None,
    action: models.AuditAction | None = None,
    date_from: datetime | None = None,
    date_to: datetime | None = None,
    limit: int = 50,
    offset: int = 0,
) -> list[models.AuditLog]:
    stmt = select(models.AuditLog).where(models.AuditLog.company_id == company_id)
    if entity_type is not None:
        stmt = stmt.where(models.AuditLog.entity_type == entity_type)
    if entity_id is not None:
        stmt = stmt.where(models.AuditLog.entity_id == entity_id)
    if actor_user_id is not None:
        stmt = stmt.where(models.AuditLog.actor_user_id == actor_user_id)
    if action is not None:
        stmt = stmt.where(models.AuditLog.action == action)
    if date_from is not None:
        stmt = stmt.where(models.AuditLog.created_at >= date_from)
    if date_to is not None:
        stmt = stmt.where(models.AuditLog.created_at < date_to)
    stmt = (
        stmt.order_by(models.AuditLog.created_at.desc(), models.AuditLog.id.desc())
        .limit(limit)
        .offset(offset)
    )
    return list(db.scalars(stmt))
