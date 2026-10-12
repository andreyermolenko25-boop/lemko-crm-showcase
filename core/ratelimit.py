"""
Ограничение частоты: фиксированное окно в PostgreSQL.

Один атомарный UPSERT на проверку — без Redis и без гонок между воркерами
uvicorn/контейнерами. Используется только на дорогих/опасных путях (вход,
коды, восстановление), поэтому нагрузку на БД не создаёт.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

from sqlalchemy import case, delete, select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.orm import Session

import models
from core.errors import DomainError

_TABLE = models.RateLimitCounter.__table__


class RateLimited(DomainError):
    status_code = 429


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _retry_after(start: datetime, window: int, now: datetime) -> int:
    return max(1, int((start + timedelta(seconds=window) - now).total_seconds()))


def hit(db: Session, key: str, *, limit: int, window: int) -> None:
    """Засчитывает попытку; сверх лимита — RateLimited (429) с retry_after."""
    now = _now()
    cutoff = now - timedelta(seconds=window)
    expired = _TABLE.c.window_start < cutoff
    stmt = (
        insert(_TABLE)
        .values(key=key[:200], window_start=now, count=1)
        .on_conflict_do_update(
            index_elements=[_TABLE.c.key],
            set_={
                "count": case((expired, 1), else_=_TABLE.c.count + 1),
                "window_start": case((expired, now), else_=_TABLE.c.window_start),
            },
        )
        .returning(_TABLE.c.count, _TABLE.c.window_start)
    )
    count, start = db.execute(stmt).one()
    # Счётчик фиксируется даже если запрос дальше упадёт.
    db.commit()
    if count > limit:
        raise_limited(_retry_after(start, window, now))


def check(db: Session, key: str, *, limit: int, window: int) -> None:
    """Проверка без засчитывания (перед проверкой пароля: считаем только неудачи)."""
    row = db.execute(
        select(_TABLE.c.count, _TABLE.c.window_start).where(_TABLE.c.key == key[:200])
    ).first()
    if row is None:
        return
    now = _now()
    count, start = row
    if start >= now - timedelta(seconds=window) and count >= limit:
        raise_limited(_retry_after(start, window, now))


def reset(db: Session, key: str) -> None:
    db.execute(delete(_TABLE).where(_TABLE.c.key == key[:200]))


def raise_limited(retry_after: int) -> None:
    raise RateLimited(
        "too_many_attempts",
        "Слишком много попыток. Повтори позже.",
        retry_after=retry_after,
    )


def prune(db: Session, *, older_than: timedelta = timedelta(days=1)) -> int:
    """Старые окна — уборка воркером."""
    result = db.execute(delete(_TABLE).where(_TABLE.c.window_start < _now() - older_than))
    return result.rowcount or 0
