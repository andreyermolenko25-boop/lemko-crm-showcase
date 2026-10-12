"""
Transactional outbox уведомлений.

Ядро не вызывает SMS и почту. В той же транзакции, что и визит, оно кладёт
строку status=pending. HTTP-ответ уходит сразу: доставку забирает воркер.
"""

from __future__ import annotations

from datetime import datetime
from typing import Any

from sqlalchemy.orm import Session

import models


def appointment_payload(
    *,
    company: models.Company,
    appointment: models.Appointment,
    client: models.Client,
    master: models.User,
    previous_starts_at: datetime | None = None,
    previous_ends_at: datetime | None = None,
    previous_master_id: int | None = None,
) -> dict[str, Any]:
    """Снимок на момент события: воркеру не нужно заново собирать визит."""
    payload: dict[str, Any] = {
        "appointment_id": appointment.id,
        "starts_at": appointment.starts_at.isoformat(),
        "ends_at": appointment.ends_at.isoformat(),
        "timezone": company.timezone,
        "title": appointment.title,
        "status": appointment.status.value,
        "master": {"id": master.id, "username": master.username},
        "client": {
            "id": client.id,
            "name": client.name,
            "phone": client.phone,
        },
    }
    if previous_starts_at is not None:
        payload["previous"] = {
            "starts_at": previous_starts_at.isoformat(),
            "ends_at": previous_ends_at.isoformat() if previous_ends_at else None,
            "master_id": previous_master_id,
        }
    return payload


def enqueue(
    db: Session,
    *,
    company_id: int,
    event_type: models.NotificationEventType,
    recipient_kind: models.NotificationRecipientKind,
    recipient_id: int,
    payload: dict[str, Any],
    appointment_id: int | None = None,
) -> models.NotificationOutbox:
    row = models.NotificationOutbox(
        company_id=company_id,
        event_type=event_type,
        status=models.OutboxStatus.PENDING,
        recipient_kind=recipient_kind,
        recipient_id=recipient_id,
        appointment_id=appointment_id,
        payload=payload,
    )
    db.add(row)
    return row


def enqueue_appointment_event(
    db: Session,
    *,
    company: models.Company,
    appointment: models.Appointment,
    client: models.Client,
    master: models.User,
    event_type: models.NotificationEventType,
    previous_starts_at: datetime | None = None,
    previous_ends_at: datetime | None = None,
    previous_master_id: int | None = None,
) -> list[models.NotificationOutbox]:
    """
    Две строки: клиенту и мастеру. Одна транзакция с INSERT визита.

    Не коммитит и никуда не ходит по сети.
    """
    payload = appointment_payload(
        company=company,
        appointment=appointment,
        client=client,
        master=master,
        previous_starts_at=previous_starts_at,
        previous_ends_at=previous_ends_at,
        previous_master_id=previous_master_id,
    )
    recipients = (
        (models.NotificationRecipientKind.CLIENT, client.id),
        (models.NotificationRecipientKind.USER, master.id),
    )
    return [
        enqueue(
            db,
            company_id=company.id,
            event_type=event_type,
            recipient_kind=kind,
            recipient_id=recipient_id,
            payload=payload,
            appointment_id=appointment.id,
        )
        for kind, recipient_id in recipients
    ] + _enqueue_webhooks_safe(
        db,
        company_id=company.id,
        event_type=event_type,
        payload=payload,
        appointment_id=appointment.id,
    )


def _enqueue_webhooks_safe(
    db: Session,
    *,
    company_id: int,
    event_type: models.NotificationEventType,
    payload: dict[str, Any],
    appointment_id: int | None = None,
) -> list[models.NotificationOutbox]:
    # Ленивый импорт: integrations тянет models, цикл не нужен при старте.
    import integrations

    return integrations.enqueue_webhooks(
        db,
        company_id=company_id,
        event_type=event_type,
        payload=payload,
        appointment_id=appointment_id,
    )
