"""
Объекты CRM для схема-ориентированного UI: один формат записи для всех.

Запись — плоский dict: {"id", "createdAt", "updatedAt", <ключ поля>: значение}.
Ключи полей совпадают с FieldDef.key во фронтенде (lib/modules/*).

Где живут данные:
  * contacts → clients, services → services, products → inventory_items,
    appointments → appointments, shifts → work_shifts — свои таблицы с бизнес-
    правилами (уникальный телефон, смены, склад, пересечения визитов). Поля,
    которых у таблицы нет (теги, ответственный, кастомные поля), — в custom_fields;
  * всё остальное (сделки, компании, задачи, счета, кастомные объекты) —
    crm_records.data.

Идентификаторы с префиксом коллекции (cl_12, ap_7, r_40, сотрудники u_3), чтобы
связи и URL были однозначны между объектами.

После каждой записи вызывается events.record_changed: лента, уведомления,
вебхуки record.*.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from decimal import Decimal, InvalidOperation
from typing import Any, ClassVar
from zoneinfo import ZoneInfo

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

import crm
import events
import finance
import inventory
import models
import scheduling
import schemas
import softdelete
import workspace
from core.errors import DomainError

ENTITY_KEY_RE = re.compile(r"^[a-z][a-z0-9_]{0,63}$")
SYSTEM_KEYS = frozenset({"id", "createdAt", "updatedAt", "closedAt"})
DEFAULT_DURATION = timedelta(minutes=60)


class RecordError(DomainError):
    status_code = 422


def not_found(entity: str, record_id: str) -> RecordError:
    return RecordError(
        "record_not_found",
        f"Запись {record_id} не найдена",
        status_code=404,
        entity=entity,
        record_id=record_id,
    )


# --------------------------------------------------------------------------- #
#  Контекст и изменения
# --------------------------------------------------------------------------- #

@dataclass
class Ctx:
    db: Session
    company: models.Company
    actor: models.User | None
    # ui | api | automation | integration — от источника зависят автоматизации и лента.
    source: str = "ui"

    @property
    def actor_id(self) -> int | None:
        return self.actor.id if self.actor else None

    @property
    def tz(self) -> ZoneInfo:
        return ZoneInfo(self.company.timezone or "UTC")


@dataclass
class Change:
    entity: str
    record_id: str
    action: str  # created | updated | deleted
    before: dict[str, Any] | None
    after: dict[str, Any] | None
    changed: list[str] = field(default_factory=list)

    @classmethod
    def diff(cls, entity: str, before: dict[str, Any], after: dict[str, Any]) -> "Change":
        keys = (set(before) | set(after)) - SYSTEM_KEYS
        changed = sorted(k for k in keys if before.get(k) != after.get(k))
        return cls(entity, after["id"], "updated", before, after, changed)


# --------------------------------------------------------------------------- #
#  Значения
# --------------------------------------------------------------------------- #

def iso(value: datetime | None) -> str | None:
    return value.astimezone(timezone.utc).isoformat().replace("+00:00", "Z") if value else None


def _blank(value: Any) -> bool:
    return value is None or value == "" or value == []


def _text(value: Any) -> str | None:
    return None if _blank(value) else str(value).strip() or None


def _number(key: str, value: Any) -> Decimal | None:
    if _blank(value):
        return None
    try:
        number = Decimal(str(value))
    except (InvalidOperation, ValueError) as exc:
        raise RecordError("invalid_value", f"«{key}»: ожидается число", field=key) from exc
    if not number.is_finite():
        raise RecordError("invalid_value", f"«{key}»: ожидается число", field=key)
    return number


def _phone(value: Any) -> str | None:
    """Телефон контакта (необязателен) в едином формате: +48500000000."""
    if _blank(value):
        return None
    try:
        return schemas.normalize_phone(str(value))
    except ValueError as exc:
        raise RecordError("invalid_value", "Телефон: 7–15 цифр, допустим ведущий «+»", field="phone") from exc


def _float(value: Decimal | None) -> float | None:
    return float(value) if value is not None else None


def _moment(key: str, value: Any, tz: ZoneInfo) -> datetime | None:
    """ISO-строка → aware UTC. Время без пояса считаем временем компании."""
    if _blank(value):
        return None
    try:
        parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except ValueError as exc:
        raise RecordError("invalid_value", f"«{key}»: ожидается дата и время", field=key) from exc
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=tz)
    return parsed.astimezone(timezone.utc)


def ref(value: Any, prefix: str) -> int | None:
    """"cl_12" → 12 (None, если это не ссылка на эту коллекцию)."""
    if not isinstance(value, str) or not value.startswith(f"{prefix}_"):
        return None
    tail = value[len(prefix) + 1:]
    return int(tail) if tail.isdigit() and int(tail) > 0 else None


def _require_ref(key: str, value: Any, prefix: str, message: str) -> int:
    pk = ref(value, prefix)
    if pk is None:
        raise RecordError("invalid_value", message, field=key)
    return pk


def _normalize_generic(entity: dict[str, Any] | None, values: dict[str, Any]) -> dict[str, Any]:
    """
    Значения объекта без своей таблицы — по типам полей из схемы воркспейса.
    Неизвестные ключи сохраняются как есть: поле могли добавить, а схема ещё
    не синхронизировалась.
    """
    out: dict[str, Any] = {}
    for key, value in values.items():
        if key in SYSTEM_KEYS:
            continue
        kind = (workspace.field_def(entity, key) or {}).get("type")
        if _blank(value):
            out[key] = None
        elif kind in workspace.NUMERIC_TYPES:
            out[key] = _float(_number(key, value))
        elif kind == "boolean":
            out[key] = bool(value)
        elif kind == "multiselect":
            out[key] = [str(v) for v in (value if isinstance(value, list) else [value])]
        elif kind is not None:
            out[key] = value if isinstance(value, (str, int, float, bool)) else str(value)
        else:
            out[key] = value
    return out


def _split(values: dict[str, Any], native: frozenset[str], read_only: frozenset[str]) -> tuple[dict, dict]:
    own, custom = {}, {}
    for key, value in values.items():
        if key in SYSTEM_KEYS or key in read_only:
            continue
        (own if key in native else custom)[key] = value
    return own, custom


def _merge_custom(current: dict[str, Any], patch: dict[str, Any]) -> dict[str, Any]:
    merged = {**(current or {})}
    for key, value in patch.items():
        if _blank(value):
            merged.pop(key, None)
        else:
            merged[key] = value
    return merged


def _stamps(row: Any) -> dict[str, Any]:
    return {"createdAt": iso(row.created_at), "updatedAt": iso(row.updated_at or row.created_at)}


# --------------------------------------------------------------------------- #
#  Объекты со своей таблицей
# --------------------------------------------------------------------------- #

class NativeAdapter:
    entity: ClassVar[str]
    prefix: ClassVar[str]
    native: ClassVar[frozenset[str]]
    read_only: ClassVar[frozenset[str]] = frozenset()

    def list(self, ctx: Ctx) -> list[dict[str, Any]]:
        raise NotImplementedError

    def row(self, ctx: Ctx, pk: int) -> Any:
        raise NotImplementedError

    def read(self, ctx: Ctx, row: Any) -> dict[str, Any]:
        return self.to_records(ctx, [row])[0]

    def to_records(self, ctx: Ctx, rows: list[Any]) -> list[dict[str, Any]]:
        raise NotImplementedError

    def create(self, ctx: Ctx, own: dict[str, Any], custom: dict[str, Any]) -> Any:
        raise NotImplementedError

    def update(self, ctx: Ctx, row: Any, own: dict[str, Any], custom: dict[str, Any]) -> None:
        raise NotImplementedError

    def delete(self, ctx: Ctx, row: Any) -> bool:
        """True — запись ушла из списков, False — заархивирована, но видна (визит отменён)."""
        raise NotImplementedError

    def get(self, ctx: Ctx, record_id: str) -> Any:
        pk = ref(record_id, self.prefix)
        row = self.row(ctx, pk) if pk is not None else None
        if row is None:
            raise not_found(self.entity, record_id)
        return row


class ContactsAdapter(NativeAdapter):
    entity = "contacts"
    prefix = "cl"
    native = frozenset({"name", "phone", "email", "notes"})
    read_only = frozenset({"ltv"})

    def _query(self, ctx: Ctx):
        return select(models.Client).where(
            models.Client.company_id == ctx.company.id, models.is_alive(models.Client)
        )

    def list(self, ctx):
        rows = list(ctx.db.scalars(self._query(ctx).order_by(models.Client.created_at.desc())))
        return self.to_records(ctx, rows)

    def row(self, ctx, pk):
        return ctx.db.scalars(self._query(ctx).where(models.Client.id == pk)).first()

    def to_records(self, ctx, rows):
        ltv = finance.net_paid_by_client(ctx.db, company_id=ctx.company.id) if rows else {}
        return [
            {
                **(row.custom_fields or {}),
                "id": f"cl_{row.id}",
                **_stamps(row),
                "name": row.name,
                "phone": row.phone,
                "email": row.email,
                "notes": row.notes,
                "ltv": float(ltv.get(row.id, finance.ZERO)),
            }
            for row in rows
        ]

    def create(self, ctx, own, custom):
        if _blank(own.get("name")):
            raise RecordError("required", "Укажите имя", field="name")
        return crm.create_client(
            ctx.db,
            company=ctx.company,
            name=str(own["name"]).strip(),
            phone=_phone(own.get("phone")),
            email=_text(own.get("email")),
            notes=_text(own.get("notes")),
            custom_fields=_merge_custom({}, custom),
        )

    def update(self, ctx, row, own, custom):
        changes: dict[str, Any] = {}
        if "name" in own:
            if _blank(own["name"]):
                raise RecordError("required", "Поле «name» обязательно", field="name")
            changes["name"] = str(own["name"]).strip()
        if "phone" in own:
            changes["phone"] = _phone(own["phone"])
        for key in ("email", "notes"):
            if key in own:
                changes[key] = _text(own[key])
        if custom:
            changes["custom_fields"] = _merge_custom(row.custom_fields, custom)
        crm.update_client(ctx.db, company=ctx.company, client=row, changes=changes)

    def delete(self, ctx, row):
        softdelete.archive_client(ctx.db, company_id=ctx.company.id, client=row)
        return True


class ServicesAdapter(NativeAdapter):
    entity = "services"
    prefix = "sv"
    native = frozenset({"name", "price", "duration", "active"})

    def _query(self, ctx: Ctx):
        return select(models.Service).where(
            models.Service.company_id == ctx.company.id, models.is_alive(models.Service)
        )

    def list(self, ctx):
        return self.to_records(ctx, list(ctx.db.scalars(self._query(ctx).order_by(models.Service.name))))

    def row(self, ctx, pk):
        return ctx.db.scalars(self._query(ctx).where(models.Service.id == pk)).first()

    def to_records(self, ctx, rows):
        return [
            {
                **(row.custom_fields or {}),
                "id": f"sv_{row.id}",
                **_stamps(row),
                "name": row.name,
                "price": float(row.base_price),
                "duration": row.duration_minutes,
                "active": row.is_active,
            }
            for row in rows
        ]

    @staticmethod
    def _duration(value: Any) -> int:
        minutes = int(_number("duration", value) or 60)
        if not 5 <= minutes <= 1440:
            raise RecordError("invalid_value", "Длительность — от 5 до 1440 минут", field="duration")
        return minutes

    @staticmethod
    def _price(value: Any) -> Decimal:
        price = _number("price", value) or Decimal("0")
        if price < 0:
            raise RecordError("invalid_value", "Цена не может быть отрицательной", field="price")
        return price.quantize(Decimal("0.01"))

    def create(self, ctx, own, custom):
        if _blank(own.get("name")):
            raise RecordError("required", "Укажите название услуги", field="name")
        service = inventory.create_service(
            ctx.db,
            company_id=ctx.company.id,
            name=str(own["name"]).strip(),
            base_price=self._price(own.get("price")),
            duration_minutes=self._duration(own.get("duration")),
            custom_fields=_merge_custom({}, custom),
        )
        if own.get("active") is False:
            service.is_active = False
        return service

    def update(self, ctx, row, own, custom):
        changes: dict[str, Any] = {}
        if "name" in own:
            if _blank(own["name"]):
                raise RecordError("required", "Укажите название услуги", field="name")
            changes["name"] = str(own["name"]).strip()
        if "price" in own:
            changes["base_price"] = self._price(own["price"])
        if "duration" in own:
            changes["duration_minutes"] = self._duration(own["duration"])
        if "active" in own:
            changes["is_active"] = bool(own["active"])
        if custom:
            changes["custom_fields"] = _merge_custom(row.custom_fields, custom)
        inventory.update_service(ctx.db, service=row, changes=changes)

    def delete(self, ctx, row):
        inventory.archive_service(row)
        return True


class ProductsAdapter(NativeAdapter):
    entity = "products"
    prefix = "inv"
    native = frozenset({"name", "sku", "stock", "minStock", "unit"})
    read_only = frozenset({"stockStatus"})

    def _query(self, ctx: Ctx):
        return select(models.InventoryItem).where(
            models.InventoryItem.company_id == ctx.company.id,
            models.is_alive(models.InventoryItem),
        )

    def list(self, ctx):
        return self.to_records(
            ctx, list(ctx.db.scalars(self._query(ctx).order_by(models.InventoryItem.name)))
        )

    def row(self, ctx, pk):
        return ctx.db.scalars(self._query(ctx).where(models.InventoryItem.id == pk)).first()

    def to_records(self, ctx, rows):
        out = []
        for row in rows:
            stock = row.quantity or Decimal("0")
            out.append(
                {
                    **(row.custom_fields or {}),
                    "id": f"inv_{row.id}",
                    **_stamps(row),
                    "name": row.name,
                    "sku": row.sku,
                    "stock": float(stock),
                    "minStock": _float(row.low_stock_threshold),
                    "unit": row.unit.value,
                    "stockStatus": "out" if stock <= 0 else "low" if row.is_low_stock else "ok",
                }
            )
        return out

    @staticmethod
    def _unit(value: Any) -> models.MeasurementUnit:
        try:
            return models.MeasurementUnit(value or "pcs")
        except ValueError as exc:
            raise RecordError("invalid_value", "Неизвестная единица измерения", field="unit") from exc

    @staticmethod
    def _threshold(value: Any) -> Decimal | None:
        threshold = _number("minStock", value)
        if threshold is not None and threshold < 0:
            raise RecordError("invalid_value", "Минимальный остаток не может быть отрицательным", field="minStock")
        return threshold

    def create(self, ctx, own, custom):
        if _blank(own.get("name")):
            raise RecordError("required", "Укажите название позиции", field="name")
        stock = _number("stock", own.get("stock")) or Decimal("0")
        if stock < 0:
            raise RecordError("invalid_value", "Остаток не может быть отрицательным", field="stock")
        return inventory.create_item(
            ctx.db,
            company_id=ctx.company.id,
            name=str(own["name"]).strip(),
            sku=_text(own.get("sku")),
            unit=self._unit(own.get("unit")),
            low_stock_threshold=self._threshold(own.get("minStock")),
            initial_quantity=stock,
            created_by_user_id=ctx.actor_id,
            custom_fields=_merge_custom({}, custom),
        )

    def update(self, ctx, row, own, custom):
        # Остаток меняется только движением по журналу склада (корректировка).
        if "stock" in own:
            target = _number("stock", own["stock"]) or Decimal("0")
            delta = target - row.quantity
            if delta != 0:
                item = inventory.require_item(
                    ctx.db, company_id=ctx.company.id, item_id=row.id, active_only=False, for_update=True
                )
                try:
                    with ctx.db.begin_nested():
                        inventory.apply_movement(
                            ctx.db,
                            item=item,
                            delta=delta,
                            reason=models.StockMovementReason.ADJUSTMENT,
                            created_by_user_id=ctx.actor_id,
                            note="Правка остатка в CRM",
                        )
                        ctx.db.flush()
                except IntegrityError as exc:
                    if inventory.is_quantity_violation(exc):
                        raise inventory.InsufficientStockError(item, delta) from exc
                    raise
        changes: dict[str, Any] = {}
        if "name" in own:
            if _blank(own["name"]):
                raise RecordError("required", "Укажите название позиции", field="name")
            changes["name"] = str(own["name"]).strip()
        if "sku" in own:
            changes["sku"] = _text(own["sku"])
        if "minStock" in own:
            changes["low_stock_threshold"] = self._threshold(own["minStock"])
        if "unit" in own:
            changes["unit"] = self._unit(own["unit"])
        if custom:
            changes["custom_fields"] = _merge_custom(row.custom_fields, custom)
        inventory.update_item(ctx.db, item=row, changes=changes)

    def delete(self, ctx, row):
        inventory.archive_item(row)
        return True


class AppointmentsAdapter(NativeAdapter):
    entity = "appointments"
    prefix = "ap"
    native = frozenset({"title", "client", "service", "startsAt", "endsAt", "staff", "price", "status", "notes"})
    read_only = frozenset({"paid"})

    def _query(self, ctx: Ctx):
        return select(models.Appointment).where(models.Appointment.company_id == ctx.company.id)

    def list(self, ctx):
        return self.to_records(
            ctx, list(ctx.db.scalars(self._query(ctx).order_by(models.Appointment.starts_at)))
        )

    def row(self, ctx, pk):
        return ctx.db.scalars(self._query(ctx).where(models.Appointment.id == pk)).first()

    def to_records(self, ctx, rows):
        paid = finance.net_paid_for_appointments(
            ctx.db, company_id=ctx.company.id, appointment_ids=[row.id for row in rows]
        )
        return [
            {
                **(row.custom_fields or {}),
                "id": f"ap_{row.id}",
                **_stamps(row),
                "closedAt": iso(row.ends_at) if row.status == models.AppointmentStatus.COMPLETED else None,
                "title": row.title or "Appointment",
                "client": f"cl_{row.client_id}",
                "service": f"sv_{row.service_id}" if row.service_id else None,
                "startsAt": iso(row.starts_at),
                "endsAt": iso(row.ends_at),
                "staff": f"u_{row.user_id}",
                "price": _float(row.price),
                "paid": float(paid.get(row.id, finance.ZERO)),
                "status": row.status.value,
                "notes": row.notes,
            }
            for row in rows
        ]

    @staticmethod
    def _status(value: Any) -> models.AppointmentStatus:
        try:
            return models.AppointmentStatus(value)
        except ValueError as exc:
            raise RecordError("invalid_value", "Неизвестный статус визита", field="status") from exc

    def _duration_of(self, ctx: Ctx, service_id: int | None) -> timedelta:
        if service_id is None:
            return DEFAULT_DURATION
        service = inventory.get_service(ctx.db, company_id=ctx.company.id, service_id=service_id, active_only=False)
        return timedelta(minutes=service.duration_minutes) if service else DEFAULT_DURATION

    def create(self, ctx, own, custom):
        starts_at = _moment("startsAt", own.get("startsAt"), ctx.tz)
        if starts_at is None:
            raise RecordError("required", "Выберите время начала", field="startsAt")
        service_id = ref(own.get("service"), "sv")
        ends_at = _moment("endsAt", own.get("endsAt"), ctx.tz) or starts_at + self._duration_of(ctx, service_id)
        appointment = scheduling.book_appointment(
            ctx.db,
            company=ctx.company,
            client_id=_require_ref("client", own.get("client"), "cl", "Выберите клиента"),
            user_id=_require_ref("staff", own.get("staff"), "u", "Выберите сотрудника"),
            starts_at=starts_at,
            ends_at=ends_at,
            service_id=service_id,
            title=_text(own.get("title")),
            price=_number("price", own.get("price")),
            notes=_text(own.get("notes")),
            custom_fields=_merge_custom({}, custom),
        )
        status = own.get("status")
        if status and status != models.AppointmentStatus.SCHEDULED.value:
            scheduling.change_appointment(
                ctx.db,
                company=ctx.company,
                appointment=appointment,
                changes={"status": self._status(status)},
                actor_user_id=ctx.actor_id,
            )
        return appointment

    def update(self, ctx, row, own, custom):
        if "client" in own and ref(own["client"], "cl") != row.client_id:
            raise RecordError("invalid_value", "Клиента существующего визита изменить нельзя", field="client")
        changes: dict[str, Any] = {}
        if "startsAt" in own:
            starts_at = _moment("startsAt", own["startsAt"], ctx.tz)
            if starts_at is None:
                raise RecordError("required", "Время начала обязательно", field="startsAt")
            changes["starts_at"] = starts_at
            # Перенос сохраняет длительность, если конец не прислали явно.
            changes["ends_at"] = starts_at + (row.ends_at - row.starts_at)
        if "endsAt" in own and own["endsAt"]:
            changes["ends_at"] = _moment("endsAt", own["endsAt"], ctx.tz)
        if "staff" in own:
            changes["user_id"] = _require_ref("staff", own["staff"], "u", "Выберите сотрудника")
        if "service" in own:
            changes["service_id"] = ref(own["service"], "sv")
        if "status" in own:
            changes["status"] = self._status(own["status"])
        if "title" in own:
            changes["title"] = _text(own["title"])
        if "price" in own:
            changes["price"] = _number("price", own["price"])
        if "notes" in own:
            changes["notes"] = _text(own["notes"])
        if custom:
            changes["custom_fields"] = _merge_custom(row.custom_fields, custom)
        scheduling.change_appointment(
            ctx.db, company=ctx.company, appointment=row, changes=changes, actor_user_id=ctx.actor_id
        )

    def delete(self, ctx, row):
        # Визиты не удаляются (касса и склад ссылаются на них) — отменяются.
        scheduling.change_appointment(
            ctx.db,
            company=ctx.company,
            appointment=row,
            changes={"status": models.AppointmentStatus.CANCELLED},
            actor_user_id=ctx.actor_id,
        )
        return False


class ShiftsAdapter(NativeAdapter):
    entity = "shifts"
    prefix = "sh"
    native = frozenset({"staff", "startsAt", "endsAt", "title"})

    def _query(self, ctx: Ctx):
        return select(models.WorkShift).where(models.WorkShift.company_id == ctx.company.id)

    def list(self, ctx):
        return self.to_records(
            ctx, list(ctx.db.scalars(self._query(ctx).order_by(models.WorkShift.starts_at)))
        )

    def row(self, ctx, pk):
        return ctx.db.scalars(self._query(ctx).where(models.WorkShift.id == pk)).first()

    def to_records(self, ctx, rows):
        return [
            {
                **(row.custom_fields or {}),
                "id": f"sh_{row.id}",
                **_stamps(row),
                "title": row.title or "Shift",
                "staff": f"u_{row.user_id}",
                "startsAt": iso(row.starts_at),
                "endsAt": iso(row.ends_at),
            }
            for row in rows
        ]

    def create(self, ctx, own, custom):
        starts_at = _moment("startsAt", own.get("startsAt"), ctx.tz)
        ends_at = _moment("endsAt", own.get("endsAt"), ctx.tz)
        if starts_at is None or ends_at is None:
            raise RecordError("required", "Укажите начало и конец смены", field="startsAt")
        return scheduling.create_shift(
            ctx.db,
            company_id=ctx.company.id,
            user_id=_require_ref("staff", own.get("staff"), "u", "Выберите сотрудника"),
            starts_at=starts_at,
            ends_at=ends_at,
            title=_text(own.get("title")),
            custom_fields=_merge_custom({}, custom),
        )

    def update(self, ctx, row, own, custom):
        changes: dict[str, Any] = {}
        if "startsAt" in own:
            changes["starts_at"] = _moment("startsAt", own["startsAt"], ctx.tz)
            if "endsAt" not in own:
                changes["ends_at"] = changes["starts_at"] + (row.ends_at - row.starts_at)
        if "endsAt" in own:
            changes["ends_at"] = _moment("endsAt", own["endsAt"], ctx.tz)
        if None in (changes.get("starts_at", row.starts_at), changes.get("ends_at", row.ends_at)):
            raise RecordError("required", "Укажите начало и конец смены", field="startsAt")
        if "staff" in own:
            changes["user_id"] = _require_ref("staff", own["staff"], "u", "Выберите сотрудника")
        if "title" in own:
            changes["title"] = _text(own["title"])
        if custom:
            changes["custom_fields"] = _merge_custom(row.custom_fields, custom)
        scheduling.change_shift(ctx.db, shift=row, changes=changes)

    def delete(self, ctx, row):
        scheduling.delete_shift(ctx.db, shift=row)
        return True


NATIVE: dict[str, NativeAdapter] = {
    adapter.entity: adapter
    for adapter in (ContactsAdapter(), ServicesAdapter(), ProductsAdapter(), AppointmentsAdapter(), ShiftsAdapter())
}


# --------------------------------------------------------------------------- #
#  Объекты без своей таблицы (crm_records)
# --------------------------------------------------------------------------- #

def _generic_query(ctx: Ctx, entity: str):
    return select(models.CrmRecord).where(
        models.CrmRecord.company_id == ctx.company.id,
        models.CrmRecord.entity == entity,
        models.is_alive(models.CrmRecord),
    )


def _generic_record(row: models.CrmRecord) -> dict[str, Any]:
    return {
        **(row.data or {}),
        "id": f"r_{row.id}",
        **_stamps(row),
        "closedAt": iso(row.closed_at),
    }


def _generic_row(ctx: Ctx, entity: str, record_id: str) -> models.CrmRecord:
    pk = ref(record_id, "r")
    row = ctx.db.scalars(_generic_query(ctx, entity).where(models.CrmRecord.id == pk)).first() if pk else None
    if row is None:
        raise not_found(entity, record_id)
    return row


def _sync_closed_at(entity_def: dict[str, Any] | None, row: models.CrmRecord) -> None:
    """Когда запись вошла в закрытую стадию — для медианы цикла сделки."""
    stage = (entity_def or {}).get("stageField")
    if not stage:
        return
    closed = (row.data or {}).get(stage) in workspace.CLOSED
    if closed and row.closed_at is None:
        row.closed_at = datetime.now(timezone.utc)
    elif not closed:
        row.closed_at = None


# --------------------------------------------------------------------------- #
#  Публичный API
# --------------------------------------------------------------------------- #

def check_entity(entity: str) -> None:
    if not ENTITY_KEY_RE.match(entity):
        raise RecordError("invalid_entity", f"Некорректный ключ объекта «{entity}»", status_code=404)


def list_records(ctx: Ctx, entity: str) -> list[dict[str, Any]]:
    check_entity(entity)
    adapter = NATIVE.get(entity)
    if adapter is not None:
        return adapter.list(ctx)
    rows = ctx.db.scalars(_generic_query(ctx, entity).order_by(models.CrmRecord.created_at.desc()))
    return [_generic_record(row) for row in rows]


def get_record(ctx: Ctx, entity: str, record_id: str) -> dict[str, Any]:
    check_entity(entity)
    adapter = NATIVE.get(entity)
    if adapter is not None:
        return adapter.read(ctx, adapter.get(ctx, record_id))
    return _generic_record(_generic_row(ctx, entity, record_id))


def create_record(ctx: Ctx, entity: str, values: dict[str, Any]) -> dict[str, Any]:
    check_entity(entity)
    adapter = NATIVE.get(entity)
    if adapter is not None:
        own, custom = _split(values, adapter.native, adapter.read_only)
        row = adapter.create(ctx, own, custom)
        ctx.db.flush()
        ctx.db.refresh(row)
        record = adapter.read(ctx, row)
    else:
        entity_def = workspace.entity_def(ctx.db, ctx.company.id, entity)
        row = models.CrmRecord(
            company_id=ctx.company.id,
            entity=entity,
            data=_normalize_generic(entity_def, values),
            created_by_user_id=ctx.actor_id,
        )
        _sync_closed_at(entity_def, row)
        ctx.db.add(row)
        ctx.db.flush()
        ctx.db.refresh(row)
        record = _generic_record(row)
    events.record_changed(ctx, Change(entity, record["id"], "created", None, record, sorted(set(record) - SYSTEM_KEYS)))
    return record


def update_record(ctx: Ctx, entity: str, record_id: str, patch: dict[str, Any]) -> dict[str, Any]:
    check_entity(entity)
    adapter = NATIVE.get(entity)
    if adapter is not None:
        row = adapter.get(ctx, record_id)
        before = adapter.read(ctx, row)
        own, custom = _split(patch, adapter.native, adapter.read_only)
        if own or custom:
            adapter.update(ctx, row, own, custom)
            ctx.db.flush()
            ctx.db.refresh(row)
        after = adapter.read(ctx, row)
    else:
        row = _generic_row(ctx, entity, record_id)
        before = _generic_record(row)
        entity_def = workspace.entity_def(ctx.db, ctx.company.id, entity)
        row.data = {**(row.data or {}), **_normalize_generic(entity_def, patch)}
        _sync_closed_at(entity_def, row)
        ctx.db.flush()
        ctx.db.refresh(row)
        after = _generic_record(row)
    change = Change.diff(entity, before, after)
    if change.changed:
        events.record_changed(ctx, change)
    return after


def delete_record(ctx: Ctx, entity: str, record_id: str) -> dict[str, Any] | None:
    """None — запись удалена; dict — заархивирована и остаётся в списках (визит отменён)."""
    check_entity(entity)
    adapter = NATIVE.get(entity)
    if adapter is not None:
        row = adapter.get(ctx, record_id)
        before = adapter.read(ctx, row)
        removed = adapter.delete(ctx, row)
        ctx.db.flush()
        if not removed:
            ctx.db.refresh(row)
            after = adapter.read(ctx, row)
            events.record_changed(ctx, Change.diff(entity, before, after))
            return after
    else:
        row = _generic_row(ctx, entity, record_id)
        before = _generic_record(row)
        row.deleted_at = datetime.now(timezone.utc)
        ctx.db.flush()
    events.record_changed(ctx, Change(entity, record_id, "deleted", before, None, []))
    return None


def native_created(ctx: Ctx, entity: str, row: Any) -> None:
    """Запись создана в обход records (внешний API, приём заявок) — события те же."""
    adapter = NATIVE[entity]
    ctx.db.flush()
    record = adapter.read(ctx, row)
    events.record_changed(ctx, Change(entity, record["id"], "created", None, record, sorted(set(record) - SYSTEM_KEYS)))
