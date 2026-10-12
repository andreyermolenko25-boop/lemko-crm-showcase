"""
Личные уведомления сотрудника: «назначили ответственным», «упомянули»,
смена стадии его записи, новые записи из интеграций.

Каждое уведомление — строка ленты с recipient_user_id (её показ «в приложении»
фильтрует activities по настройкам) и, если сотрудник включил email для этого
события, письмо через outbox (доставляет worker.py).
"""

from __future__ import annotations

from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

import activities
import models
import outbox
import workspace


def display_name(user: models.User | None) -> str:
    if user is None:
        return "Someone"
    # Без имени — часть email до @ (логин и есть email); @упоминания её тоже понимают.
    return user.full_name or user.username.split("@")[0]


def user_email(user: models.User) -> str | None:
    return user.email or (user.username if "@" in user.username else None)


def member_id(value: Any) -> int | None:
    """"u_3" → 3."""
    if isinstance(value, str) and value.startswith("u_") and value[2:].isdigit():
        return int(value[2:])
    return None


def _member(db: Session, company_id: int, user_id: int | None) -> models.User | None:
    if user_id is None:
        return None
    return db.scalars(
        select(models.User).where(
            models.User.id == user_id,
            models.User.company_id == company_id,
            models.User.is_active.is_(True),
            models.is_alive(models.User),
        )
    ).first()


def email_user(db: Session, *, company_id: int, user: models.User, subject: str, text: str) -> None:
    if user_email(user) is None:
        return
    outbox.enqueue(
        db,
        company_id=company_id,
        event_type=models.NotificationEventType.USER_NOTIFICATION,
        recipient_kind=models.NotificationRecipientKind.USER,
        recipient_id=user.id,
        payload={"subject": subject, "text": text},
    )


def notify(
    db: Session,
    *,
    company_id: int,
    user: models.User,
    event: str,
    entity: str,
    record_id: str,
    title: str,
    body: str | None = None,
    actor_user_id: int | None = None,
    meta: dict[str, Any] | None = None,
    params: dict[str, Any] | None = None,
) -> None:
    """params — для заголовка на языке сотрудника; код события в ленте — «record.<event>»."""
    activities.log(
        db,
        company_id=company_id,
        entity=entity,
        record_id=record_id,
        kind=event,
        title=title,
        body=body,
        actor_user_id=actor_user_id,
        recipient_user_id=user.id,
        meta=meta,
        event=f"record.{event}" if params is not None else None,
        params=params,
    )
    if activities.wants(user, event, "email"):
        email_user(db, company_id=company_id, user=user, subject=title, text=body or title)


def on_change(ctx, change, entity_def: dict[str, Any] | None) -> None:
    record = change.after
    if record is None or entity_def is None:
        return
    title = workspace.record_title(entity_def, record)
    noun = workspace.singular(entity_def, change.entity)
    owner_key = entity_def.get("ownerField")
    owner = _member(ctx.db, ctx.company.id, member_id(record.get(owner_key))) if owner_key else None

    if owner and owner_key in change.changed and owner.id != ctx.actor_id:
        notify(
            ctx.db,
            company_id=ctx.company.id,
            user=owner,
            event="assigned",
            entity=change.entity,
            record_id=change.record_id,
            title=f"{noun} assigned to you · {title}",
            body=f"{display_name(ctx.actor)} made you responsible for {noun.lower()} “{title}”.",
            actor_user_id=ctx.actor_id,
            params={**activities.record_params(entity_def, change.entity, record), "actor": display_name(ctx.actor)},
        )

    stage_key = entity_def.get("stageField")
    if (
        change.action == "updated"
        and owner
        and stage_key in change.changed
        and owner.id != ctx.actor_id
        and activities.wants(owner, "stage", "email")
    ):
        field = workspace.field_def(entity_def, stage_key)
        label = workspace.option_label(field, record.get(stage_key))
        email_user(
            ctx.db,
            company_id=ctx.company.id,
            user=owner,
            subject=f"{(field or {}).get('label', stage_key)} → {label} · {title}",
            text=f"{display_name(ctx.actor)} moved {noun.lower()} “{title}” to {label}.",
        )

    if change.action == "created" and ctx.source in activities.EXTERNAL_SOURCES:
        members = ctx.db.scalars(
            select(models.User).where(
                models.User.company_id == ctx.company.id,
                models.User.is_active.is_(True),
                models.is_alive(models.User),
            )
        )
        for member in members:
            if activities.wants(member, "integration", "email"):
                email_user(
                    ctx.db,
                    company_id=ctx.company.id,
                    user=member,
                    subject=f"New {noun.lower()} from an integration · {title}",
                    text=f"{noun} “{title}” was created via {ctx.source}.",
                )


def on_mentions(ctx, *, entity: str, record_id: str, record_title: str, text: str) -> None:
    for user in activities.mentioned_users(ctx.db, company_id=ctx.company.id, text=text):
        if user.id == ctx.actor_id:
            continue
        notify(
            ctx.db,
            company_id=ctx.company.id,
            user=user,
            event="mention",
            entity=entity,
            record_id=record_id,
            title=f"{display_name(ctx.actor)} mentioned you · {record_title}",
            body=text,
            actor_user_id=ctx.actor_id,
            params={"title": record_title, "actor": display_name(ctx.actor)},
        )
