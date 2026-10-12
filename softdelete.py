"""
Мягкое удаление сотрудников и клиентов, смена роли сотрудника.

DELETE не вызывает SQL DELETE: ставит deleted_at, чтобы CASCADE не снёс
визиты и кассу. Операционные списки прячут строку; отчёты её видят.
"""

from __future__ import annotations

from datetime import datetime, timezone

from sqlalchemy import func, select
from sqlalchemy.orm import Session

import models
from core.errors import DomainError


class SoftDeleteError(DomainError):
    status_code = 409


def mark_deleted(obj: models.User | models.Client) -> None:
    obj.deleted_at = datetime.now(timezone.utc)
    obj.is_active = False


def restore(obj: models.User | models.Client) -> None:
    obj.deleted_at = None
    obj.is_active = True


def open_appointments_count(
    db: Session,
    *,
    company_id: int,
    user_id: int | None = None,
    client_id: int | None = None,
) -> int:
    """Визиты, которые ещё занимают слот: запланированные и идущие сейчас."""
    now = datetime.now(timezone.utc)
    stmt = select(func.count()).select_from(models.Appointment).where(
        models.Appointment.company_id == company_id,
        models.Appointment.status.in_(
            (
                models.AppointmentStatus.SCHEDULED,
                models.AppointmentStatus.IN_PROGRESS,
            )
        ),
        models.Appointment.ends_at > now,
    )
    if user_id is not None:
        stmt = stmt.where(models.Appointment.user_id == user_id)
    if client_id is not None:
        stmt = stmt.where(models.Appointment.client_id == client_id)
    return int(db.scalar(stmt) or 0)


def living_owners_count(db: Session, *, company_id: int) -> int:
    return int(
        db.scalar(
            select(func.count())
            .select_from(models.User)
            .where(
                models.User.company_id == company_id,
                models.User.role == models.UserRole.OWNER,
                models.User.is_active.is_(True),
                models.is_alive(models.User),
            )
        )
        or 0
    )


def get_user(
    db: Session,
    *,
    company_id: int,
    user_id: int,
    include_deleted: bool = False,
) -> models.User | None:
    stmt = select(models.User).where(
        models.User.id == user_id,
        models.User.company_id == company_id,
    )
    if not include_deleted:
        stmt = stmt.where(models.is_alive(models.User))
    return db.scalars(stmt).first()


def archive_user(
    db: Session,
    *,
    company_id: int,
    target: models.User,
    actor: models.User,
) -> models.User:
    if target.id == actor.id:
        raise SoftDeleteError(
            "cannot_delete_self",
            "Нельзя удалить собственную учётную запись",
        )
    if target.role == models.UserRole.OWNER and actor.role != models.UserRole.OWNER:
        raise SoftDeleteError(
            "cannot_delete_owner",
            "Владельца может удалить только другой владелец",
            status_code=403,
        )
    if (
        target.role == models.UserRole.OWNER
        and target.is_active
        and living_owners_count(db, company_id=company_id) <= 1
    ):
        raise SoftDeleteError(
            "last_owner",
            "Нельзя удалить последнего владельца",
        )
    open_count = open_appointments_count(
        db, company_id=company_id, user_id=target.id
    )
    if open_count:
        raise SoftDeleteError(
            "has_open_appointments",
            "Сначала отмените или перенесите будущие визиты мастера",
            count=open_count,
        )
    mark_deleted(target)
    return target


def change_role(
    db: Session,
    *,
    company_id: int,
    target: models.User,
    actor: models.User,
    role: models.UserRole | None = None,
    is_active: bool | None = None,
) -> models.User:
    """
    Смена роли и блокировка: владельца назначает только владелец,
    последнего живого владельца нельзя понизить или отключить.
    """
    new_role = role if role is not None else target.role
    new_active = is_active if is_active is not None else target.is_active
    if new_role == models.UserRole.OWNER and actor.role != models.UserRole.OWNER:
        raise SoftDeleteError(
            "owner_only",
            "Назначить владельца может только другой владелец",
            status_code=403,
        )
    losing_owner = (
        target.role == models.UserRole.OWNER
        and target.is_active
        and (new_role != models.UserRole.OWNER or not new_active)
    )
    if losing_owner and living_owners_count(db, company_id=company_id) <= 1:
        raise SoftDeleteError(
            "last_owner",
            "Нельзя понизить или отключить последнего владельца",
        )
    target.role = new_role
    target.is_active = new_active
    return target


def archive_client(
    db: Session, *, company_id: int, client: models.Client
) -> models.Client:
    open_count = open_appointments_count(
        db, company_id=company_id, client_id=client.id
    )
    if open_count:
        raise SoftDeleteError(
            "has_open_appointments",
            "Сначала отмените или перенесите будущие визиты клиента",
            count=open_count,
        )
    mark_deleted(client)
    return client
