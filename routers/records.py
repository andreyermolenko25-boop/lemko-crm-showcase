"""
Записи любого объекта CRM в едином формате (см. records.py).

GET    /companies/{id}/records?entities=deals,contacts — пачка объектов за раз
GET    /companies/{id}/records/{entity}
POST   /companies/{id}/records/{entity}               {"values": {...}}
GET    /companies/{id}/records/{entity}/{record_id}
PATCH  /companies/{id}/records/{entity}/{record_id}   {"values": {...}} — только изменённые поля
DELETE /companies/{id}/records/{entity}/{record_id}
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, Query, status
from sqlalchemy.orm import Session

import models
import records
import schemas
from core.database import get_db
from core.deps import get_current_company, get_current_user, require_editor

router = APIRouter(prefix="/companies/{company_id}/records", tags=["records"])


def _ctx(db: Session, company: models.Company, user: models.User) -> records.Ctx:
    return records.Ctx(db, company, user)


@router.get("", response_model=dict[str, list[dict[str, Any]]])
def list_many(
    entities: str = Query(..., description="Ключи объектов через запятую"),
    company: models.Company = Depends(get_current_company),
    user: models.User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict[str, list[dict[str, Any]]]:
    ctx = _ctx(db, company, user)
    keys = [key.strip() for key in entities.split(",") if key.strip()][:50]
    return {key: records.list_records(ctx, key) for key in keys}


@router.get("/{entity}", response_model=schemas.RecordPage)
def list_records(
    entity: str,
    company: models.Company = Depends(get_current_company),
    user: models.User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> schemas.RecordPage:
    items = records.list_records(_ctx(db, company, user), entity)
    return schemas.RecordPage(items=items, total=len(items))


@router.post("/{entity}", response_model=dict[str, Any], status_code=status.HTTP_201_CREATED)
def create_record(
    entity: str,
    payload: schemas.RecordValues,
    company: models.Company = Depends(get_current_company),
    user: models.User = Depends(require_editor),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    record = records.create_record(_ctx(db, company, user), entity, payload.values)
    db.commit()
    return record


@router.get("/{entity}/{record_id}", response_model=dict[str, Any])
def read_record(
    entity: str,
    record_id: str,
    company: models.Company = Depends(get_current_company),
    user: models.User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    return records.get_record(_ctx(db, company, user), entity, record_id)


@router.patch("/{entity}/{record_id}", response_model=dict[str, Any])
def update_record(
    entity: str,
    record_id: str,
    payload: schemas.RecordValues,
    company: models.Company = Depends(get_current_company),
    user: models.User = Depends(require_editor),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    record = records.update_record(_ctx(db, company, user), entity, record_id, payload.values)
    db.commit()
    return record


@router.delete("/{entity}/{record_id}", response_model=schemas.DeletedRecord)
def delete_record(
    entity: str,
    record_id: str,
    company: models.Company = Depends(get_current_company),
    user: models.User = Depends(require_editor),
    db: Session = Depends(get_db),
) -> schemas.DeletedRecord:
    archived = records.delete_record(_ctx(db, company, user), entity, record_id)
    db.commit()
    return schemas.DeletedRecord(record=archived)
