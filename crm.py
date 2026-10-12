"""
Клиенты: карточка (создание, правка), профиль (LTV, визиты, надёжность), заметки.

Агрегаты считаются из визитов и транзакций, а не хранятся колонками.
Иначе после возврата или отмены визита пришлось бы помнить, что счётчики
надо пересчитать. Нишевая карточка (авто, медкарта) по-прежнему в extra_data.

LTV и % отмен на карточке одного клиента — нормально. Сортировка
«все клиенты по LTV» этим кодом не делается: для списка нужна агрегация
GROUP BY / materialized view, иначе каждый ряд будет отдельным проходом.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
from decimal import Decimal

from typing import Any

from sqlalchemy import func, or_, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

import integrations
import models
import schemas
from core.errors import DomainError
from finance import ZERO, _money, net_paid_for_appointments, net_paid_for_client
from scheduling import get_client

PHONE_CONSTRAINT = "uq_clients_company_phone"


class CrmError(DomainError):
    status_code = 404


class ClientNotFoundError(CrmError):
    def __init__(self, client_id: int) -> None:
        super().__init__(
            "client_not_found",
            f"Клиент с id={client_id} не найден в этой компании",
            client_id=client_id,
        )


class DuplicatePhoneError(CrmError):
    status_code = 409

    def __init__(self, phone: str) -> None:
        super().__init__(
            "duplicate_phone",
            "Клиент с таким телефоном уже есть в этой компании",
            phone=phone,
        )


class NoteNotFoundError(CrmError):
    def __init__(self, note_id: int) -> None:
        super().__init__(
            "note_not_found",
            f"Заметка с id={note_id} не найдена",
            note_id=note_id,
        )


@dataclass
class ClientStats:
    visits_total: int
    visits_completed: int
    visits_cancelled: int
    visits_upcoming: int
    cancellation_rate: Decimal
    ltv: Decimal
    outstanding_debt: Decimal
    last_visit_at: datetime | None
    next_visit_at: datetime | None


def _client_webhook_payload(client: models.Client) -> dict[str, Any]:
    return {"client_id": client.id, "name": client.name, "phone": client.phone}


def _save_client(db: Session, client: models.Client, apply=None) -> None:
    """Изменения и flush в SAVEPOINT: дубль телефона → 409, сессия остаётся рабочей."""
    try:
        with db.begin_nested():
            if apply is not None:
                apply()
            db.add(client)
            db.flush()
    except IntegrityError as exc:
        if PHONE_CONSTRAINT in str(getattr(exc, "orig", exc)):
            raise DuplicatePhoneError(client.phone) from exc
        raise


def create_client(
    db: Session,
    *,
    company: models.Company,
    name: str,
    phone: str | None,
    email: str | None = None,
    notes: str | None = None,
    extra_data: dict[str, Any] | None = None,
    custom_fields: dict[str, Any] | None = None,
) -> models.Client:
    """
    Новая карточка. extra_data проверяется схемой ниши компании (детейлинг ждёт
    авто, стоматология — медкарту); company_id берётся только у тенанта.
    Телефон необязателен: контакт из письма или формы может прийти только с email.
    """
    client = models.Client(
        company_id=company.id,
        name=name,
        phone=schemas.normalize_phone(phone) if phone else None,
        email=email,
        notes=notes,
        extra_data=schemas.validate_extra_data(company.niche, extra_data),
        custom_fields=custom_fields or {},
    )
    _save_client(db, client)
    integrations.enqueue_webhooks(
        db,
        company_id=company.id,
        event_type=models.NotificationEventType.CLIENT_CREATED,
        payload=_client_webhook_payload(client),
    )
    return client


def update_client(
    db: Session,
    *,
    company: models.Company,
    client: models.Client,
    changes: dict[str, Any],
) -> models.Client:
    if "extra_data" in changes:
        changes["extra_data"] = schemas.validate_extra_data(company.niche, changes["extra_data"])
    if changes.get("phone") is not None:
        changes["phone"] = schemas.normalize_phone(changes["phone"])
    def apply() -> None:
        for field, value in changes.items():
            setattr(client, field, value)

    _save_client(db, client, apply)
    integrations.enqueue_webhooks(
        db,
        company_id=company.id,
        event_type=models.NotificationEventType.CLIENT_UPDATED,
        payload=_client_webhook_payload(client),
    )
    return client


def require_client(
    db: Session,
    *,
    company_id: int,
    client_id: int,
    include_deleted: bool = False,
) -> models.Client:
    client = get_client(
        db,
        company_id=company_id,
        client_id=client_id,
        active_only=False,
        include_deleted=include_deleted,
    )
    if client is None:
        raise ClientNotFoundError(client_id)
    return client


def client_stats(db: Session, *, company_id: int, client_id: int) -> ClientStats:
    """
    Счётчики и деньги клиента.

    cancellation_rate = отменённые / все визиты. Без визитов — 0, а не None:
    админу удобнее сортировать «по надёжности» одним числом.
    outstanding_debt — сумма remaining > 0 по визитам, у которых есть цена.
    Отменённый визит с ненулевой ценой тоже даёт долг (депозит / штраф за no-show);
    если долга быть не должно — обнуляй price при отмене.
    """
    rows = list(
        db.scalars(
            select(models.Appointment).where(
                models.Appointment.company_id == company_id,
                models.Appointment.client_id == client_id,
            )
        )
    )
    now = datetime.now(timezone.utc)

    completed = [a for a in rows if a.status == models.AppointmentStatus.COMPLETED]
    cancelled = [a for a in rows if a.status == models.AppointmentStatus.CANCELLED]
    upcoming = [
        a
        for a in rows
        if a.status in (
            models.AppointmentStatus.SCHEDULED,
            models.AppointmentStatus.IN_PROGRESS,
        )
        and a.starts_at >= now
    ]

    total = len(rows)
    rate = (
        (Decimal(len(cancelled)) / Decimal(total)).quantize(Decimal("0.0001"))
        if total
        else ZERO
    )

    paid_map = net_paid_for_appointments(
        db, company_id=company_id, appointment_ids=[a.id for a in rows]
    )
    debt = ZERO
    for appointment in rows:
        due = _money(appointment.price)
        paid = paid_map.get(appointment.id, ZERO)
        remaining = due - paid
        if remaining > ZERO:
            debt += remaining

    last_completed = max((a.starts_at for a in completed), default=None)
    next_upcoming = min((a.starts_at for a in upcoming), default=None)

    return ClientStats(
        visits_total=total,
        visits_completed=len(completed),
        visits_cancelled=len(cancelled),
        visits_upcoming=len(upcoming),
        cancellation_rate=rate,
        ltv=net_paid_for_client(db, company_id=company_id, client_id=client_id),
        outstanding_debt=debt,
        last_visit_at=last_completed,
        next_visit_at=next_upcoming,
    )


def add_note(
    db: Session,
    *,
    company_id: int,
    client_id: int,
    author_user_id: int | None,
    body: str,
    is_pinned: bool,
) -> models.ClientNote:
    require_client(db, company_id=company_id, client_id=client_id)
    note = models.ClientNote(
        company_id=company_id,
        client_id=client_id,
        author_user_id=author_user_id,
        body=body.strip(),
        is_pinned=is_pinned,
    )
    if not note.body:
        raise CrmError(
            "empty_note",
            "Текст заметки не может быть пустым",
            status_code=422,
        )
    db.add(note)
    db.flush()
    return note


def list_notes(
    db: Session,
    *,
    company_id: int,
    client_id: int,
    limit: int = 50,
    offset: int = 0,
) -> tuple[list[models.ClientNote], int]:
    require_client(db, company_id=company_id, client_id=client_id)
    filters = (
        models.ClientNote.company_id == company_id,
        models.ClientNote.client_id == client_id,
    )
    total = int(db.scalar(select(func.count()).where(*filters)) or 0)
    stmt = (
        select(models.ClientNote)
        .where(*filters)
        .order_by(models.ClientNote.is_pinned.desc(), models.ClientNote.created_at.desc())
        .limit(limit)
        .offset(offset)
    )
    return list(db.scalars(stmt)), total


def list_clients(
    db: Session,
    *,
    company_id: int,
    search: str | None = None,
    include_deleted: bool = False,
    limit: int = 50,
    offset: int = 0,
) -> tuple[list[models.Client], int]:
    """
    Страница клиентов тенанта + total для виртуального скролла.

    search — ilike по имени, телефону и госномеру (extra_data.plate_number).
    """
    filters: list[object] = [models.Client.company_id == company_id]
    if not include_deleted:
        filters.append(models.is_alive(models.Client))

    needle = (search or "").strip()
    if needle:
        pattern = f"%{needle}%"
        filters.append(
            or_(
                models.Client.name.ilike(pattern),
                models.Client.phone.ilike(pattern),
                models.Client.extra_data["plate_number"].astext.ilike(pattern),
            )
        )

    total = int(
        db.scalar(select(func.count()).select_from(models.Client).where(*filters)) or 0
    )
    stmt = (
        select(models.Client)
        .where(*filters)
        .order_by(models.Client.created_at.desc())
        .limit(limit)
        .offset(offset)
    )
    return list(db.scalars(stmt)), total


def delete_note(
    db: Session,
    *,
    company_id: int,
    client_id: int,
    note_id: int,
) -> None:
    note = db.scalars(
        select(models.ClientNote).where(
            models.ClientNote.id == note_id,
            models.ClientNote.company_id == company_id,
            models.ClientNote.client_id == client_id,
        )
    ).first()
    if note is None:
        raise NoteNotFoundError(note_id)
    db.delete(note)
