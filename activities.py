"""
Лента событий: что происходило с записями и что адресовано сотруднику.

Изменения записей сервер пишет сам (records → events), поэтому в ленте видно
и правки коллег, и действия автоматизаций, и записи из внешнего API. Заметки,
звонки, письма и встречи добавляют сотрудники (POST /activities).

Прочитанность: всё не новее preferences.inboxReadAt прочитано («прочитать всё»
двигает границу), новее — по точечным отметкам в activity_reads. Свои действия
сотрудник видит прочитанными.

Заголовок события (title) — готовая английская фраза для старых клиентов и
писем. Интерфейс строит фразу на языке сотрудника из meta.event и meta.params:
ключи объекта, поля и значения он переводит по своей схеме, а подписи,
сохранённые рядом (noun, fieldLabel…), — запасной вариант для своих объектов.
"""

from __future__ import annotations

import re
from datetime import datetime, timezone
from typing import Any

from sqlalchemy import and_, delete, exists, func, or_, select
from sqlalchemy.orm import Session

import models
import workspace

# Типы, которые сотрудник может добавить в ленту записи вручную.
MANUAL_KINDS = frozenset({"note", "call", "email", "meeting", "comment"})

# Событие из настроек уведомлений → что в ленте ему соответствует.
NOTIFICATION_EVENTS = ("stage", "assigned", "mention", "reminder", "integration", "digest")
DEFAULT_NOTIFICATIONS: dict[str, dict[str, bool]] = {
    "stage": {"inApp": True, "email": True},
    "assigned": {"inApp": True, "email": True},
    "mention": {"inApp": True, "email": False},
    "reminder": {"inApp": True, "email": True},
    "integration": {"inApp": False, "email": False},
    "digest": {"inApp": False, "email": True},
}
EXTERNAL_SOURCES = frozenset({"api", "integration"})
# Производные поля пересчитываются сами — отдельным событием их не пишем.
DERIVED_FIELDS = frozenset({"paid", "ltv", "closedAt"})

MENTION_RE = re.compile(r"@([\w.\-]+(?:\s[\w.\-]+)?)", re.UNICODE)


def notification_prefs(user: models.User) -> dict[str, dict[str, bool]]:
    saved = (user.preferences or {}).get("notifications") or {}
    return {
        event: {**DEFAULT_NOTIFICATIONS[event], **(saved.get(event) or {})}
        for event in NOTIFICATION_EVENTS
    }


def wants(user: models.User, event: str, channel: str) -> bool:
    return bool(notification_prefs(user)[event][channel])


def log(
    db: Session,
    *,
    company_id: int,
    entity: str,
    record_id: str,
    kind: str,
    title: str,
    body: str | None = None,
    actor_user_id: int | None = None,
    recipient_user_id: int | None = None,
    meta: dict[str, Any] | None = None,
    event: str | None = None,
    params: dict[str, Any] | None = None,
) -> models.Activity:
    """event + params — из чего интерфейс соберёт заголовок на языке сотрудника."""
    meta = dict(meta or {})
    if event:
        meta["event"] = event
        meta["params"] = params or {}
    row = models.Activity(
        company_id=company_id,
        entity=entity,
        record_id=record_id,
        kind=kind,
        title=title[:500],
        body=body,
        actor_user_id=actor_user_id,
        recipient_user_id=recipient_user_id,
        meta=meta,
    )
    db.add(row)
    return row


def record_params(entity_def: dict[str, Any] | None, entity: str, record: dict[str, Any]) -> dict[str, Any]:
    """Общие параметры событий записи: название (может не быть) и подпись объекта."""
    return {
        "title": workspace.record_name(entity_def, record),
        "noun": workspace.singular(entity_def, entity),
    }


def log_change(ctx, change, entity_def: dict[str, Any] | None) -> None:
    """Событие записи: создание, смена стадии, правка полей, удаление."""
    record = change.after or change.before or {}
    title = workspace.record_title(entity_def, record)
    noun = workspace.singular(entity_def, change.entity)
    params = record_params(entity_def, change.entity, record)
    common = {
        "company_id": ctx.company.id,
        "entity": change.entity,
        "record_id": change.record_id,
        "actor_user_id": ctx.actor_id,
        "meta": {"source": ctx.source},
    }
    if change.action == "created":
        log(ctx.db, kind="created", title=f"{noun} created · {title}", event="record.created", params=params, **common)
        return
    if change.action == "deleted":
        log(ctx.db, kind="deleted", title=f"{noun} deleted · {title}", event="record.deleted", params=params, **common)
        return

    stage_key = (entity_def or {}).get("stageField")
    keys: list[str] = []
    labels: list[str] = []
    for key in change.changed:
        if key in DERIVED_FIELDS:
            continue
        field = workspace.field_def(entity_def, key)
        if field is None:
            continue
        if key == stage_key:
            label = workspace.option_label(field, record.get(key))
            field_label = str(field.get("label") or key)
            log(
                ctx.db,
                kind="stage",
                title=f"{field_label} → {label} · {title}",
                event="record.stage",
                params={**params, "field": key, "fieldLabel": field_label, "to": record.get(key), "toLabel": label},
                **{**common, "meta": {**common["meta"], "field": key, "to": record.get(key)}},
            )
        else:
            keys.append(key)
            labels.append(str(field.get("label") or key))
    if labels:
        log(
            ctx.db,
            kind="updated",
            title=f"{', '.join(labels)} updated · {title}",
            event="record.updated",
            params={**params, "fields": keys, "fieldLabels": labels},
            **{**common, "meta": {**common["meta"], "fields": [k for k in change.changed if k not in DERIVED_FIELDS]}},
        )


def mentioned_users(db: Session, *, company_id: int, text: str) -> list[models.User]:
    """@Имя, @Имя Фамилия или @логин → живые сотрудники компании."""
    tokens = {token.lower() for token in MENTION_RE.findall(text or "")}
    if not tokens:
        return []
    users = db.scalars(
        select(models.User).where(models.User.company_id == company_id, models.is_alive(models.User))
    )
    found = []
    for user in users:
        handles = {user.username.lower(), user.username.split("@")[0].lower()}
        if user.full_name:
            full = user.full_name.lower()
            handles |= {full, full.split(" ")[0]}
        # «@anna please» захватывает два слова — сверяем и первое отдельно.
        if any(token in handles or token.split(" ")[0] in handles for token in tokens):
            found.append(user)
    return found


# --------------------------------------------------------------------------- #
#  Чтение
# --------------------------------------------------------------------------- #

def _read_at(user: models.User) -> datetime | None:
    raw = (user.preferences or {}).get("inboxReadAt")
    try:
        return datetime.fromisoformat(raw) if raw else None
    except ValueError:
        return None


def _hidden_filter(user: models.User):
    """Что сотрудник отключил «в приложении» в настройках уведомлений."""
    prefs = notification_prefs(user)
    clauses = []
    if not prefs["stage"]["inApp"]:
        clauses.append(models.Activity.kind != "stage")
    for event in ("assigned", "mention", "reminder", "digest"):
        if not prefs[event]["inApp"]:
            clauses.append(models.Activity.kind != event)
    if not prefs["integration"]["inApp"]:
        clauses.append(
            ~and_(
                models.Activity.kind == "created",
                models.Activity.meta["source"].astext.in_(sorted(EXTERNAL_SOURCES)),
            )
        )
    return and_(*clauses) if clauses else None


def _visible(user: models.User):
    cond = and_(
        models.Activity.company_id == user.company_id,
        or_(models.Activity.recipient_user_id.is_(None), models.Activity.recipient_user_id == user.id),
    )
    hidden = _hidden_filter(user)
    return and_(cond, hidden) if hidden is not None else cond


def _is_read_expr(user: models.User):
    read_at = _read_at(user)
    marked = exists().where(
        models.ActivityRead.activity_id == models.Activity.id,
        models.ActivityRead.user_id == user.id,
    )
    own = models.Activity.actor_user_id == user.id
    return or_(own, marked, models.Activity.created_at <= read_at) if read_at else or_(own, marked)


def feed(
    db: Session,
    *,
    user: models.User,
    limit: int = 100,
    before_id: int | None = None,
    entity: str | None = None,
    record_id: str | None = None,
) -> list[tuple[models.Activity, bool]]:
    is_read = _is_read_expr(user)
    stmt = select(models.Activity, is_read).where(_visible(user))
    if entity:
        stmt = stmt.where(models.Activity.entity == entity)
    if record_id:
        stmt = stmt.where(models.Activity.record_id == record_id)
    if before_id:
        stmt = stmt.where(models.Activity.id < before_id)
    stmt = stmt.order_by(models.Activity.created_at.desc(), models.Activity.id.desc()).limit(limit)
    return [(row, bool(read)) for row, read in db.execute(stmt)]


def unread_count(db: Session, *, user: models.User) -> int:
    stmt = select(func.count()).select_from(models.Activity).where(_visible(user), ~_is_read_expr(user))
    return int(db.scalar(stmt) or 0)


def mark_read(db: Session, *, user: models.User, activity_ids: list[int]) -> None:
    ids = list(
        db.scalars(
            select(models.Activity.id).where(
                models.Activity.id.in_(activity_ids), _visible(user)
            )
        )
    )
    existing = set(
        db.scalars(
            select(models.ActivityRead.activity_id).where(
                models.ActivityRead.user_id == user.id, models.ActivityRead.activity_id.in_(ids)
            )
        )
    )
    for activity_id in ids:
        if activity_id not in existing:
            db.add(models.ActivityRead(activity_id=activity_id, user_id=user.id))


def mark_all_read(db: Session, *, user: models.User) -> None:
    now = datetime.now(timezone.utc)
    user.preferences = {**(user.preferences or {}), "inboxReadAt": now.isoformat()}
    db.execute(delete(models.ActivityRead).where(models.ActivityRead.user_id == user.id))
