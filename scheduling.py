"""
Логика расписания: поиск пересечений и проверки принадлежности тенанту.

Здесь только работа с БД и никакого HTTP: ошибки — SchedulingError с кодом
причины (core.errors превращает их в ответ). Запись, перенос и смены живут
здесь, чтобы REST API, внешний API, приём заявок и records.py вели себя одинаково.

Как определяется пересечение
----------------------------
    Интервал визита полуоткрытый: [starts_at, ends_at).
Две записи A и B пересекаются, если одновременно верно:
    A.starts_at < B.ends_at  И  A.ends_at > B.starts_at

    существующая:      |-------- 10:00 – 11:00 --------|
    новая (конфликт):          |----- 10:30 – 11:30 -----|   starts < end, ends > start
    новая (ок):                                        |--- 11:00 – 12:00 ---|

Стык границ (11:00) конфликтом НЕ считается — иначе нельзя было бы поставить
клиентов подряд без искусственных зазоров.

Смена vs визит (гонки)
----------------------
Проверки в Python без блокировки не сериализуются: админ видит «визитов нет»
и удаляет смену, клиент видит смену и вставляет визит. Поэтому:

  * запись визита берёт покрывающую смену SELECT FOR UPDATE и держит её
    до COMMIT;
  * удаление/укорочение смены тоже блокирует строку смены, и только потом
    смотрит визиты;
  * PostgreSQL дублирует инвариант constraint-триггерами с FOR UPDATE внутри.
Порядок блокировок один: сначала смена, потом визит — иначе взаимная блокировка.
"""

from __future__ import annotations

from datetime import date, datetime, time, timedelta
from decimal import Decimal
from typing import Any
from zoneinfo import ZoneInfo

try:
    import tzdata  # noqa: F401
except ImportError:
    pass

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

import inventory
import models
import outbox
import schemas
from core.errors import DomainError


class SchedulingError(DomainError):
    status_code = 409

# Имя EXCLUDE-ограничения из миграции: по нему отличаем нарушение
# "двойная запись" от любых других ошибок целостности.
OVERLAP_CONSTRAINT_NAME = "excl_appointments_master_overlap"
SHIFT_OVERLAP_CONSTRAINT_NAME = "excl_work_shifts_master_overlap"
OUTSIDE_SHIFT_TRIGGER = "outside_shift"
SHIFT_HAS_APPOINTMENTS_TRIGGER = "shift_has_appointments"


def find_conflicts(
    db: Session,
    *,
    company_id: int,
    user_id: int,
    starts_at: datetime,
    ends_at: datetime,
    exclude_appointment_id: int | None = None,
) -> list[models.Appointment]:
    """
    Возвращает записи мастера, пересекающиеся с интервалом [starts_at, ends_at).

    Отменённые визиты не учитываются: их слот свободен.
    exclude_appointment_id нужен при переносе — сама переносимая запись
    не должна конфликтовать с собой же.

    Запрос попадает в индекс ix_appointments_user_starts.
    """
    stmt = (
        select(models.Appointment)
        .where(
            models.Appointment.company_id == company_id,
            models.Appointment.user_id == user_id,
            models.Appointment.status.in_(models.BLOCKING_APPOINTMENT_STATUSES),
            models.Appointment.starts_at < ends_at,
            models.Appointment.ends_at > starts_at,
        )
        .order_by(models.Appointment.starts_at)
    )
    if exclude_appointment_id is not None:
        stmt = stmt.where(models.Appointment.id != exclude_appointment_id)

    return list(db.scalars(stmt))


def is_overlap_violation(error: IntegrityError) -> bool:
    """
    True, если ошибка целостности — это именно наложение записей.

    Нужно потому, что проверка find_conflicts() не защищает от гонки:
    два одновременных запроса могут увидеть свободный слот и оба вставить
    запись. Тогда вторую вставку отклонит EXCLUDE-ограничение в PostgreSQL,
    и мы должны распознать это, чтобы вернуть 409, а не 500.
    """
    return OVERLAP_CONSTRAINT_NAME in str(getattr(error, "orig", error))


def get_master(db: Session, *, company_id: int, user_id: int) -> models.User | None:
    """
    Ищет сотрудника-мастера внутри компании.

    Фильтр по company_id обязателен: иначе можно было бы записать клиента
    к мастеру из чужой компании, просто подставив его id.
    Уволенный (deleted_at) и отключённый не попадают в расписание.
    """
    stmt = select(models.User).where(
        models.User.id == user_id,
        models.User.company_id == company_id,
        models.User.is_active.is_(True),
        models.is_alive(models.User),
    )
    return db.scalars(stmt).first()


def get_user(
    db: Session, *, company_id: int, user_id: int
) -> models.User | None:
    """Сотрудник компании без фильтра is_active — для снимка в outbox."""
    stmt = select(models.User).where(
        models.User.id == user_id,
        models.User.company_id == company_id,
    )
    return db.scalars(stmt).first()


def get_client(
    db: Session,
    *,
    company_id: int,
    client_id: int,
    active_only: bool = True,
    include_deleted: bool = False,
) -> models.Client | None:
    """Ищет клиента внутри компании (та же логика изоляции, что и выше)."""
    stmt = select(models.Client).where(
        models.Client.id == client_id,
        models.Client.company_id == company_id,
    )
    if not include_deleted:
        stmt = stmt.where(models.is_alive(models.Client))
    if active_only:
        stmt = stmt.where(models.Client.is_active.is_(True))
    return db.scalars(stmt).first()


def get_appointment(
    db: Session, *, company_id: int, appointment_id: int
) -> models.Appointment | None:
    """Ищет запись внутри компании."""
    stmt = select(models.Appointment).where(
        models.Appointment.id == appointment_id,
        models.Appointment.company_id == company_id,
    )
    return db.scalars(stmt).first()


def is_shift_overlap_violation(error: IntegrityError) -> bool:
    return SHIFT_OVERLAP_CONSTRAINT_NAME in str(getattr(error, "orig", error))


def is_outside_shift_violation(error: IntegrityError) -> bool:
    return OUTSIDE_SHIFT_TRIGGER in str(getattr(error, "orig", error))


def is_shift_has_appointments_violation(error: IntegrityError) -> bool:
    return SHIFT_HAS_APPOINTMENTS_TRIGGER in str(getattr(error, "orig", error))


def covering_shift(
    db: Session,
    *,
    company_id: int,
    user_id: int,
    starts_at: datetime,
    ends_at: datetime,
    exclude_shift_id: int | None = None,
    for_update: bool = False,
) -> models.WorkShift | None:
    """
    Смена, внутри которой целиком лежит визит.

    Полуоткрытые интервалы: визит 17:00–18:00 входит в смену до 18:00,
    визит 17:00–18:01 — уже нет.

    Ночная смена 20:00–08:00 следующего дня — одна строка с ends_at на
    следующих сутках; tstzrange это покрывает без отдельного «дня недели».

    for_update=True — запись визита: блокируем строку смены, чтобы параллельное
    удаление ждало и либо увидело визит, либо мы увидели исчезнувшую смену.
    """
    stmt = (
        select(models.WorkShift)
        .where(
            models.WorkShift.company_id == company_id,
            models.WorkShift.user_id == user_id,
            models.WorkShift.starts_at <= starts_at,
            models.WorkShift.ends_at >= ends_at,
        )
        .order_by(models.WorkShift.starts_at)
        .limit(1)
    )
    if exclude_shift_id is not None:
        stmt = stmt.where(models.WorkShift.id != exclude_shift_id)
    if for_update:
        stmt = stmt.with_for_update()
    return db.scalars(stmt).first()


def nearby_shifts(
    db: Session,
    *,
    company_id: int,
    user_id: int,
    starts_at: datetime,
    ends_at: datetime,
) -> list[models.WorkShift]:
    """Смены, которые пересекаются с окном визита — для текста ошибки."""
    stmt = (
        select(models.WorkShift)
        .where(
            models.WorkShift.company_id == company_id,
            models.WorkShift.user_id == user_id,
            models.WorkShift.starts_at < ends_at,
            models.WorkShift.ends_at > starts_at,
        )
        .order_by(models.WorkShift.starts_at)
        .limit(5)
    )
    return list(db.scalars(stmt))


def get_shift(
    db: Session,
    *,
    company_id: int,
    shift_id: int,
    for_update: bool = False,
) -> models.WorkShift | None:
    stmt = select(models.WorkShift).where(
        models.WorkShift.id == shift_id,
        models.WorkShift.company_id == company_id,
    )
    if for_update:
        stmt = stmt.with_for_update()
    return db.scalars(stmt).first()


def find_shift_conflicts(
    db: Session,
    *,
    company_id: int,
    user_id: int,
    starts_at: datetime,
    ends_at: datetime,
    exclude_shift_id: int | None = None,
) -> list[models.WorkShift]:
    stmt = (
        select(models.WorkShift)
        .where(
            models.WorkShift.company_id == company_id,
            models.WorkShift.user_id == user_id,
            models.WorkShift.starts_at < ends_at,
            models.WorkShift.ends_at > starts_at,
        )
        .order_by(models.WorkShift.starts_at)
    )
    if exclude_shift_id is not None:
        stmt = stmt.where(models.WorkShift.id != exclude_shift_id)
    return list(db.scalars(stmt))


def require_covering_shift(
    db: Session,
    *,
    company_id: int,
    user_id: int,
    starts_at: datetime,
    ends_at: datetime,
) -> models.WorkShift:
    shift = covering_shift(
        db,
        company_id=company_id,
        user_id=user_id,
        starts_at=starts_at,
        ends_at=ends_at,
        for_update=True,
    )
    if shift is not None:
        return shift
    nearby = nearby_shifts(
        db,
        company_id=company_id,
        user_id=user_id,
        starts_at=starts_at,
        ends_at=ends_at,
    )
    if nearby:
        first = nearby[0]
        message = (
            "Визит не помещается в смену мастера. "
            f"Ближайшая смена {first.starts_at:%H:%M}–{first.ends_at:%H:%M} UTC"
        )
    else:
        message = "Мастер в это время не работает: смены, покрывающей визит, нет"
    raise SchedulingError(
        "outside_shift",
        message,
        nearby_shifts=[
            {
                "id": item.id,
                "starts_at": item.starts_at.isoformat(),
                "ends_at": item.ends_at.isoformat(),
                "title": item.title,
            }
            for item in nearby
        ],
    )


def appointments_left_uncovered(
    db: Session,
    *,
    company_id: int,
    user_id: int,
    old_starts_at: datetime,
    old_ends_at: datetime,
    exclude_shift_id: int,
    replacement_starts_at: datetime | None = None,
    replacement_ends_at: datetime | None = None,
) -> list[models.Appointment]:
    """
    Визиты, которые целиком лежали в старой смене и после правки/удаления
    смены больше никуда не влезут.
    """
    stmt = (
        select(models.Appointment)
        .where(
            models.Appointment.company_id == company_id,
            models.Appointment.user_id == user_id,
            models.Appointment.status.in_(models.BLOCKING_APPOINTMENT_STATUSES),
            models.Appointment.starts_at >= old_starts_at,
            models.Appointment.ends_at <= old_ends_at,
        )
        .order_by(models.Appointment.starts_at)
        .with_for_update()
    )
    uncovered: list[models.Appointment] = []
    for appointment in db.scalars(stmt):
        if (
            replacement_starts_at is not None
            and replacement_ends_at is not None
            and replacement_starts_at <= appointment.starts_at
            and appointment.ends_at <= replacement_ends_at
        ):
            continue
        if covering_shift(
            db,
            company_id=company_id,
            user_id=user_id,
            starts_at=appointment.starts_at,
            ends_at=appointment.ends_at,
            exclude_shift_id=exclude_shift_id,
        ):
            continue
        uncovered.append(appointment)
    return uncovered


def local_shift_segments(
    starts_at: datetime,
    ends_at: datetime,
    tz_name: str,
) -> list[tuple[date, datetime, datetime]]:
    """
    Куски смены по календарным дням в поясе компании.

    Ночная смена 20:00–08:00 даёт два сегмента: вечер стартового дня и утро
    следующего. Сетка календаря должна рисовать оба, а не группировать
    только по DATE(starts_at).

    Конец ровно в локальную полночь считается полуоткрытым: смена 20:00–00:00
    занимает только стартовый день.
    """
    tz = ZoneInfo(tz_name)
    start_local = starts_at.astimezone(tz)
    end_local = ends_at.astimezone(tz)
    last_occupied = end_local
    if (
        end_local.hour == 0
        and end_local.minute == 0
        and end_local.second == 0
        and end_local.microsecond == 0
    ):
        last_occupied = end_local - timedelta(microseconds=1)
    day = start_local.date()
    last_day = last_occupied.date()
    segments: list[tuple[date, datetime, datetime]] = []
    while day <= last_day:
        day_start = datetime.combine(day, time.min, tzinfo=tz)
        day_end = datetime.combine(day + timedelta(days=1), time.min, tzinfo=tz)
        seg_start = max(starts_at, day_start)
        seg_end = min(ends_at, day_end)
        if seg_start < seg_end:
            segments.append((day, seg_start, seg_end))
        day += timedelta(days=1)
    return segments


# --------------------------------------------------------------------------- #
#  Запись, перенос и смены
# --------------------------------------------------------------------------- #

def slot_taken(conflicts: list[models.Appointment]) -> SchedulingError:
    """409 со списком мешающих записей: фронт сразу покажет, кто стоит в слоте."""
    return SchedulingError(
        "slot_taken",
        "Мастер уже занят в это время",
        conflicts=[
            schemas.AppointmentConflict.model_validate(item).model_dump(mode="json")
            for item in conflicts
        ],
    )


def _not_found(code: str, message: str) -> SchedulingError:
    return SchedulingError(code, message, status_code=404)


def _check_interval(validate, starts_at: datetime, ends_at: datetime) -> None:
    try:
        validate(starts_at, ends_at)
    except ValueError as exc:
        raise SchedulingError("invalid_interval", str(exc), status_code=422) from exc


def require_master(db: Session, *, company_id: int, user_id: int) -> models.User:
    master = get_master(db, company_id=company_id, user_id=user_id)
    if master is None:
        raise _not_found("master_not_found", "Мастер не найден в этой компании")
    return master


def require_appointment(
    db: Session, *, company_id: int, appointment_id: int
) -> models.Appointment:
    appointment = get_appointment(db, company_id=company_id, appointment_id=appointment_id)
    if appointment is None:
        raise _not_found("appointment_not_found", "Запись не найдена")
    return appointment


def require_shift(
    db: Session, *, company_id: int, shift_id: int, for_update: bool = False
) -> models.WorkShift:
    shift = get_shift(db, company_id=company_id, shift_id=shift_id, for_update=for_update)
    if shift is None:
        raise _not_found("shift_not_found", "Смена не найдена")
    return shift


def _ensure_slot(
    db: Session,
    *,
    company_id: int,
    user_id: int,
    starts_at: datetime,
    ends_at: datetime,
    exclude_appointment_id: int | None = None,
) -> None:
    conflicts = find_conflicts(
        db,
        company_id=company_id,
        user_id=user_id,
        starts_at=starts_at,
        ends_at=ends_at,
        exclude_appointment_id=exclude_appointment_id,
    )
    if conflicts:
        raise slot_taken(conflicts)
    require_covering_shift(
        db, company_id=company_id, user_id=user_id, starts_at=starts_at, ends_at=ends_at
    )


def _booking_conflict(
    db: Session,
    exc: IntegrityError,
    *,
    company_id: int,
    user_id: int,
    starts_at: datetime,
    ends_at: datetime,
    exclude_appointment_id: int | None = None,
) -> Exception:
    """
    Проигранная гонка (EXCLUDE / триггер смены сработали между проверкой и
    вставкой) → та же понятная 409, что и при обычной проверке.
    """
    if is_overlap_violation(exc):
        return slot_taken(
            find_conflicts(
                db,
                company_id=company_id,
                user_id=user_id,
                starts_at=starts_at,
                ends_at=ends_at,
                exclude_appointment_id=exclude_appointment_id,
            )
        )
    if is_outside_shift_violation(exc):
        return SchedulingError(
            "outside_shift",
            "Мастер в это время не работает: смены, покрывающей визит, нет",
        )
    if inventory.is_quantity_violation(exc):
        return SchedulingError(
            "insufficient_stock",
            "Недостаточно материалов на складе (гонка с другим визитом)",
        )
    return exc


def book_appointment(
    db: Session,
    *,
    company: models.Company,
    client_id: int,
    user_id: int,
    starts_at: datetime,
    ends_at: datetime,
    service_id: int | None = None,
    title: str | None = None,
    price: Decimal | None = None,
    notes: str | None = None,
    extra_data: dict[str, Any] | None = None,
    custom_fields: dict[str, Any] | None = None,
) -> models.Appointment:
    """
    Записывает клиента к мастеру на [starts_at, ends_at).

    Визит целиком внутри смены мастера; title и price по умолчанию берутся из
    услуги. В той же транзакции — outbox клиенту, мастеру и вебхукам.
    Не коммитит. Вставка — в SAVEPOINT: при проигранной гонке сессия цела.
    """
    _check_interval(schemas.validate_interval, starts_at, ends_at)
    visit_extra = schemas.validate_extra_data(
        company.niche, extra_data, schemas.APPOINTMENT_EXTRA_SCHEMAS
    )
    client = get_client(db, company_id=company.id, client_id=client_id)
    if client is None:
        raise _not_found("client_not_found", "Клиент не найден в этой компании")
    master = require_master(db, company_id=company.id, user_id=user_id)
    service = (
        inventory.require_service(db, company_id=company.id, service_id=service_id)
        if service_id is not None
        else None
    )
    _ensure_slot(db, company_id=company.id, user_id=master.id, starts_at=starts_at, ends_at=ends_at)

    appointment = models.Appointment(
        company_id=company.id,
        client_id=client.id,
        user_id=master.id,
        starts_at=starts_at,
        ends_at=ends_at,
        status=models.AppointmentStatus.SCHEDULED,
        service_id=service.id if service else None,
        title=title if title is not None else (service.name if service else None),
        price=price if price is not None else (service.base_price if service else None),
        notes=notes,
        extra_data=visit_extra,
        custom_fields=custom_fields or {},
    )
    try:
        with db.begin_nested():
            db.add(appointment)
            db.flush()
    except IntegrityError as exc:
        raise _booking_conflict(
            db, exc, company_id=company.id, user_id=master.id, starts_at=starts_at, ends_at=ends_at
        ) from exc
    outbox.enqueue_appointment_event(
        db,
        company=company,
        appointment=appointment,
        client=client,
        master=master,
        event_type=models.NotificationEventType.APPOINTMENT_CREATED,
    )
    return appointment


def change_appointment(
    db: Session,
    *,
    company: models.Company,
    appointment: models.Appointment,
    changes: dict[str, Any],
    actor_user_id: int | None = None,
) -> models.Appointment:
    """
    Перенос, передача другому мастеру, смена услуги и статуса. Не коммитит.

    Переход в in_progress / completed списывает материалы по рецепту услуги,
    отмена начатого визита возвращает их. Нехватка — CatalogError с перечнем
    причин, визит статус не меняет.
    """
    previous_starts_at = appointment.starts_at
    previous_ends_at = appointment.ends_at
    previous_master_id = appointment.user_id
    previous_status = appointment.status

    new_starts_at = changes.get("starts_at", appointment.starts_at)
    new_ends_at = changes.get("ends_at", appointment.ends_at)
    new_user_id = changes.get("user_id", appointment.user_id)
    new_status = changes.get("status", appointment.status)
    new_service_id = changes.get("service_id", appointment.service_id)

    if "starts_at" in changes or "ends_at" in changes:
        _check_interval(schemas.validate_interval, new_starts_at, new_ends_at)
    if "user_id" in changes and new_user_id != appointment.user_id:
        require_master(db, company_id=company.id, user_id=new_user_id)
    if "service_id" in changes and new_service_id is not None:
        service = inventory.require_service(db, company_id=company.id, service_id=new_service_id)
        changes.setdefault("title", service.name)
        changes.setdefault("price", service.base_price)
    if "extra_data" in changes:
        changes["extra_data"] = schemas.validate_extra_data(
            company.niche, changes["extra_data"], schemas.APPOINTMENT_EXTRA_SCHEMAS
        )

    will_block = new_status in models.BLOCKING_APPOINTMENT_STATUSES
    was_blocking = appointment.status in models.BLOCKING_APPOINTMENT_STATUSES
    slot_changed = (
        new_starts_at != appointment.starts_at
        or new_ends_at != appointment.ends_at
        or new_user_id != appointment.user_id
    )
    if will_block and (slot_changed or not was_blocking):
        _ensure_slot(
            db,
            company_id=company.id,
            user_id=new_user_id,
            starts_at=new_starts_at,
            ends_at=new_ends_at,
            exclude_appointment_id=appointment.id,
        )

    service_changed = "service_id" in changes and changes["service_id"] != appointment.service_id
    try:
        with db.begin_nested():
            # Смена услуги у уже начатого визита: сначала вернуть старые материалы,
            # потом списать новые — иначе на складе останется «дырка» от прошлого рецепта.
            if service_changed and inventory._net_consumed(db, appointment.id) < 0:
                inventory.restore_for_appointment(
                    db, company=company, appointment=appointment, created_by_user_id=actor_user_id
                )
            for field, value in changes.items():
                setattr(appointment, field, value)
            inventory.sync_stock_with_status(
                db,
                company=company,
                appointment=appointment,
                new_status=new_status,
                created_by_user_id=actor_user_id,
            )
            db.flush()
    except IntegrityError as exc:
        raise _booking_conflict(
            db,
            exc,
            company_id=company.id,
            user_id=new_user_id,
            starts_at=new_starts_at,
            ends_at=new_ends_at,
            exclude_appointment_id=appointment.id,
        ) from exc

    client = get_client(
        db, company_id=company.id, client_id=appointment.client_id, active_only=False
    )
    master = get_user(db, company_id=company.id, user_id=appointment.user_id)
    if client is not None and master is not None:
        event_type = None
        if (
            new_status == models.AppointmentStatus.CANCELLED
            and previous_status != models.AppointmentStatus.CANCELLED
        ):
            event_type = models.NotificationEventType.APPOINTMENT_CANCELLED
        elif slot_changed and new_status != models.AppointmentStatus.CANCELLED:
            event_type = models.NotificationEventType.APPOINTMENT_RESCHEDULED
        if event_type is not None:
            outbox.enqueue_appointment_event(
                db,
                company=company,
                appointment=appointment,
                client=client,
                master=master,
                event_type=event_type,
                previous_starts_at=previous_starts_at if slot_changed else None,
                previous_ends_at=previous_ends_at if slot_changed else None,
                previous_master_id=previous_master_id if slot_changed else None,
            )
    return appointment


def _shift_overlap(conflicts: list[models.WorkShift]) -> SchedulingError:
    return SchedulingError(
        "shift_overlap",
        "Смены одного сотрудника не должны пересекаться",
        conflicts=[
            schemas.WorkShiftConflict.model_validate(item).model_dump(mode="json")
            for item in conflicts
        ],
    )


def _uncovered(appointments: list[models.Appointment]) -> SchedulingError:
    return SchedulingError(
        "shift_has_appointments",
        "Нельзя укоротить или удалить смену: в ней остаются визиты",
        appointments=[
            {
                "id": item.id,
                "starts_at": item.starts_at.isoformat(),
                "ends_at": item.ends_at.isoformat(),
            }
            for item in appointments
        ],
    )


def _shift_conflict(
    db: Session, exc: IntegrityError, *, shift: models.WorkShift, old: tuple[datetime, datetime] | None
) -> Exception:
    if is_shift_overlap_violation(exc):
        return _shift_overlap(
            find_shift_conflicts(
                db,
                company_id=shift.company_id,
                user_id=shift.user_id,
                starts_at=shift.starts_at,
                ends_at=shift.ends_at,
                exclude_shift_id=shift.id,
            )
        )
    if is_shift_has_appointments_violation(exc) and old is not None:
        return _uncovered(
            appointments_left_uncovered(
                db,
                company_id=shift.company_id,
                user_id=shift.user_id,
                old_starts_at=old[0],
                old_ends_at=old[1],
                exclude_shift_id=shift.id,
            )
        )
    return exc


def create_shift(
    db: Session,
    *,
    company_id: int,
    user_id: int,
    starts_at: datetime,
    ends_at: datetime,
    title: str | None = None,
    custom_fields: dict[str, Any] | None = None,
) -> models.WorkShift:
    """Смена, внутри которой можно записывать клиентов к мастеру. Не коммитит."""
    _check_interval(schemas.validate_shift_interval, starts_at, ends_at)
    master = require_master(db, company_id=company_id, user_id=user_id)
    conflicts = find_shift_conflicts(
        db, company_id=company_id, user_id=master.id, starts_at=starts_at, ends_at=ends_at
    )
    if conflicts:
        raise _shift_overlap(conflicts)
    shift = models.WorkShift(
        company_id=company_id,
        user_id=master.id,
        starts_at=starts_at,
        ends_at=ends_at,
        title=title,
        custom_fields=custom_fields or {},
    )
    try:
        with db.begin_nested():
            db.add(shift)
            db.flush()
    except IntegrityError as exc:
        raise _shift_conflict(db, exc, shift=shift, old=None) from exc
    return shift


def change_shift(
    db: Session, *, shift: models.WorkShift, changes: dict[str, Any]
) -> models.WorkShift:
    """Перенос/правка смены: визиты внутри должны остаться покрытыми. Не коммитит."""
    old = (shift.starts_at, shift.ends_at)
    new_user_id = changes.get("user_id", shift.user_id)
    new_starts = changes.get("starts_at", shift.starts_at)
    new_ends = changes.get("ends_at", shift.ends_at)
    _check_interval(schemas.validate_shift_interval, new_starts, new_ends)
    if new_user_id != shift.user_id:
        require_master(db, company_id=shift.company_id, user_id=new_user_id)
    conflicts = find_shift_conflicts(
        db,
        company_id=shift.company_id,
        user_id=new_user_id,
        starts_at=new_starts,
        ends_at=new_ends,
        exclude_shift_id=shift.id,
    )
    if conflicts:
        raise _shift_overlap(conflicts)
    same_master = new_user_id == shift.user_id
    uncovered = appointments_left_uncovered(
        db,
        company_id=shift.company_id,
        user_id=shift.user_id,
        old_starts_at=old[0],
        old_ends_at=old[1],
        exclude_shift_id=shift.id,
        replacement_starts_at=new_starts if same_master else None,
        replacement_ends_at=new_ends if same_master else None,
    )
    if uncovered:
        raise _uncovered(uncovered)
    try:
        with db.begin_nested():
            for field, value in changes.items():
                setattr(shift, field, value)
            db.flush()
    except IntegrityError as exc:
        raise _shift_conflict(db, exc, shift=shift, old=old) from exc
    return shift


def delete_shift(db: Session, *, shift: models.WorkShift) -> None:
    uncovered = appointments_left_uncovered(
        db,
        company_id=shift.company_id,
        user_id=shift.user_id,
        old_starts_at=shift.starts_at,
        old_ends_at=shift.ends_at,
        exclude_shift_id=shift.id,
    )
    if uncovered:
        raise _uncovered(uncovered)
    old = (shift.starts_at, shift.ends_at)
    try:
        with db.begin_nested():
            db.delete(shift)
            db.flush()
    except IntegrityError as exc:
        raise _shift_conflict(db, exc, shift=shift, old=old) from exc
