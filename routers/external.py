"""
Внешний API по X-API-Key.

Без JWT. Без биллинга, удаления сотрудников, финансовых отчётов владельца.
Только чтение/создание визитов и клиентов.
"""

from __future__ import annotations

from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException, Path, Query, status
from sqlalchemy import select
from sqlalchemy.orm import Session

import crm
import models
import schemas
import scheduling
from core.database import get_db
from core.deps import require_api_scope
from integrations import ApiKeyTenant

router = APIRouter(prefix="/api/v1/external", tags=["external"])


def _as_utc(value: datetime | None, field_name: str) -> datetime | None:
    if value is None:
        return None
    try:
        return schemas.require_aware_utc(value)
    except ValueError as exc:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail={"code": "invalid_datetime", "message": f"{field_name}: {exc}", "field": field_name},
        )


@router.get("/appointments", response_model=list[schemas.AppointmentRead])
def list_appointments(
    tenant: ApiKeyTenant = Depends(require_api_scope("appointments:read")),
    db: Session = Depends(get_db),
    user_id: int | None = Query(default=None, ge=1),
    client_id: int | None = Query(default=None, ge=1),
    appointment_status: models.AppointmentStatus | None = Query(
        default=None, alias="status"
    ),
    date_from: datetime | None = Query(default=None),
    date_to: datetime | None = Query(default=None),
    limit: int = Query(default=100, ge=1, le=500),
    offset: int = Query(default=0, ge=0),
) -> list[schemas.AppointmentRead]:
    """Расписание. Баланс визита не отдаём — финансы только сотрудникам."""
    company = tenant.company
    date_from = _as_utc(date_from, "date_from")
    date_to = _as_utc(date_to, "date_to")
    stmt = select(models.Appointment).where(
        models.Appointment.company_id == company.id
    )
    if user_id is not None:
        stmt = stmt.where(models.Appointment.user_id == user_id)
    if client_id is not None:
        stmt = stmt.where(models.Appointment.client_id == client_id)
    if appointment_status is not None:
        stmt = stmt.where(models.Appointment.status == appointment_status)
    if date_from is not None:
        stmt = stmt.where(models.Appointment.ends_at > date_from)
    if date_to is not None:
        stmt = stmt.where(models.Appointment.starts_at < date_to)
    stmt = stmt.order_by(models.Appointment.starts_at).limit(limit).offset(offset)
    return [
        schemas.AppointmentRead.model_validate(item, from_attributes=True)
        for item in db.scalars(stmt)
    ]


@router.get("/appointments/{appointment_id}", response_model=schemas.AppointmentRead)
def read_appointment(
    appointment_id: int = Path(..., ge=1),
    tenant: ApiKeyTenant = Depends(require_api_scope("appointments:read")),
    db: Session = Depends(get_db),
) -> schemas.AppointmentRead:
    appointment = scheduling.require_appointment(
        db, company_id=tenant.company.id, appointment_id=appointment_id
    )
    return schemas.AppointmentRead.model_validate(appointment, from_attributes=True)


@router.post(
    "/appointments",
    response_model=schemas.AppointmentRead,
    status_code=status.HTTP_201_CREATED,
)
def create_appointment(
    payload: schemas.AppointmentCreate,
    tenant: ApiKeyTenant = Depends(require_api_scope("appointments:write")),
    db: Session = Depends(get_db),
) -> schemas.AppointmentRead:
    appointment = scheduling.book_appointment(db, company=tenant.company, **payload.model_dump())
    db.commit()
    db.refresh(appointment)
    return schemas.AppointmentRead.model_validate(appointment, from_attributes=True)


@router.get("/clients", response_model=schemas.PaginatedClients)
def list_clients(
    tenant: ApiKeyTenant = Depends(require_api_scope("clients:read")),
    db: Session = Depends(get_db),
    search: str | None = Query(default=None, description="Поиск по имени, телефону или госномеру"),
    limit: int = Query(default=50, ge=1, le=200),
    offset: int = Query(default=0, ge=0),
) -> schemas.PaginatedClients:
    items, total = crm.list_clients(
        db,
        company_id=tenant.company.id,
        search=search,
        include_deleted=False,
        limit=limit,
        offset=offset,
    )
    return schemas.PaginatedClients(
        total=total,
        items=[schemas.ClientRead.model_validate(c) for c in items],
    )


@router.get("/clients/{client_id}", response_model=schemas.ClientRead)
def read_client(
    client_id: int = Path(..., ge=1),
    tenant: ApiKeyTenant = Depends(require_api_scope("clients:read")),
    db: Session = Depends(get_db),
) -> models.Client:
    return crm.require_client(db, company_id=tenant.company.id, client_id=client_id)


@router.post(
    "/clients",
    response_model=schemas.ClientRead,
    status_code=status.HTTP_201_CREATED,
)
def create_client(
    payload: schemas.ClientCreate,
    tenant: ApiKeyTenant = Depends(require_api_scope("clients:write")),
    db: Session = Depends(get_db),
) -> models.Client:
    client = crm.create_client(db, company=tenant.company, **payload.model_dump())
    db.commit()
    db.refresh(client)
    return client
