"""
Лента событий воркспейса и записи (Inbox, колокольчик, таймлайн записи).
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, Query, status
from sqlalchemy.orm import Session

import activities
import models
import notifications
import records
import schemas
import workspace
from core.database import get_db
from core.deps import get_current_company, get_current_user, require_editor

router = APIRouter(prefix="/companies/{company_id}/activities", tags=["activities"])


def activity_out(row: models.Activity, read: bool) -> schemas.ActivityOut:
    return schemas.ActivityOut(
        id=str(row.id),
        kind=row.kind,
        entity=row.entity,
        record_id=row.record_id,
        actor=f"u_{row.actor_user_id}" if row.actor_user_id else None,
        at=row.created_at,
        title=row.title,
        body=row.body,
        read=read,
        personal=row.recipient_user_id is not None,
        source=(row.meta or {}).get("source"),
        event=(row.meta or {}).get("event"),
        params=(row.meta or {}).get("params"),
    )


@router.get("", response_model=schemas.ActivityPage)
def list_activities(
    company: models.Company = Depends(get_current_company),
    user: models.User = Depends(get_current_user),
    db: Session = Depends(get_db),
    limit: int = Query(default=100, ge=1, le=500),
    before_id: int | None = Query(default=None, ge=1),
    entity: str | None = Query(default=None, max_length=64),
    record_id: str | None = Query(default=None, max_length=64),
) -> schemas.ActivityPage:
    _ = company
    rows = activities.feed(db, user=user, limit=limit, before_id=before_id, entity=entity, record_id=record_id)
    return schemas.ActivityPage(
        items=[activity_out(row, read) for row, read in rows],
        unread=activities.unread_count(db, user=user),
    )


@router.post("", response_model=schemas.ActivityOut, status_code=status.HTTP_201_CREATED)
def add_activity(
    payload: schemas.ActivityIn,
    company: models.Company = Depends(get_current_company),
    user: models.User = Depends(require_editor),
    db: Session = Depends(get_db),
) -> schemas.ActivityOut:
    """Заметка, звонок, письмо, встреча или комментарий к записи. @упоминания уведомляют коллег."""
    ctx = records.Ctx(db, company, user)
    record = records.get_record(ctx, payload.entity, payload.record_id)
    entity_def = workspace.entity_def(db, company.id, payload.entity)
    title = workspace.record_title(entity_def, record)
    label = {"note": "Note", "call": "Call", "email": "Email", "meeting": "Meeting", "comment": "Comment"}[payload.kind]
    row = activities.log(
        db,
        company_id=company.id,
        entity=payload.entity,
        record_id=payload.record_id,
        kind=payload.kind,
        title=f"{label} · {title}",
        body=payload.body,
        actor_user_id=user.id,
        meta={"source": "ui"},
        event="record.logged",
        params=activities.record_params(entity_def, payload.entity, record),
    )
    notifications.on_mentions(ctx, entity=payload.entity, record_id=payload.record_id, record_title=title, text=payload.body)
    db.commit()
    db.refresh(row)
    return activity_out(row, True)


@router.post("/read", status_code=status.HTTP_204_NO_CONTENT)
def mark_read(
    payload: schemas.ActivityReadIn,
    company: models.Company = Depends(get_current_company),
    user: models.User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> None:
    _ = company
    ids = [int(item) for item in payload.ids if item.isdigit()]
    activities.mark_read(db, user=user, activity_ids=ids)
    db.commit()


@router.post("/read-all", status_code=status.HTTP_204_NO_CONTENT)
def mark_all_read(
    company: models.Company = Depends(get_current_company),
    user: models.User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> None:
    _ = company
    activities.mark_all_read(db, user=user)
    db.commit()
