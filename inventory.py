"""
Каталог услуг и склад.

Модули связаны через ServiceMaterial — «рецепт» услуги: сколько каких
позиций списывать при одном оказании. Списание происходит не в момент
записи клиента, а когда визит переходит в in_progress / completed:
до этого материалы ещё на полке, и отмена записи ничего не должна трогать.

Ошибки здесь — доменные исключения без HTTP (core.errors): общий обработчик
превращает их в 404/409 с конкретным текстом причины.
"""

from __future__ import annotations

from datetime import datetime, timezone
from decimal import Decimal

from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session, selectinload

import models
from core.errors import DomainError

QUANTITY_CONSTRAINT = "ck_inventory_items_quantity_non_negative"
NAME_CONSTRAINTS = (
    "uq_services_company_name",
    "uq_inventory_items_company_name",
)

# Статусы, при которых услуга считается оказанной и материалы должны быть списаны.
CONSUMING_STATUSES: frozenset[models.AppointmentStatus] = frozenset(
    {
        models.AppointmentStatus.IN_PROGRESS,
        models.AppointmentStatus.COMPLETED,
    }
)


# --------------------------------------------------------------------------- #
#  Ошибки с конкретной причиной
# --------------------------------------------------------------------------- #

class CatalogError(DomainError):
    """Базовая ошибка каталога/склада. status_code и code уходят в ответ API."""

    status_code = 409

    def __init__(
        self,
        code: str,
        message: str,
        *,
        shortages: list[dict] | None = None,
        **extra: object,
    ) -> None:
        if shortages:
            extra["shortages"] = shortages
        super().__init__(code, message, **extra)


class ServiceNotFoundError(CatalogError):
    status_code = 404

    def __init__(self, service_id: int) -> None:
        super().__init__(
            "service_not_found",
            f"Услуга с id={service_id} не найдена в этой компании "
            f"или отключена. Проверь прайс-лист.",
            service_id=service_id,
        )


class InventoryItemNotFoundError(CatalogError):
    status_code = 404

    def __init__(self, item_id: int) -> None:
        super().__init__(
            "inventory_item_not_found",
            f"Складская позиция с id={item_id} не найдена в этой компании "
            f"или отключена.",
            inventory_item_id=item_id,
        )


class CannotProvideServiceError(CatalogError):
    """Услугу оказать нельзя: нет материала, он отключён или остатка не хватает."""

    def __init__(self, service: models.Service, shortages: list[dict]) -> None:
        reasons = "; ".join(item["message"] for item in shortages)
        super().__init__(
            "cannot_provide_service",
            f"Нельзя оказать услугу «{service.name}»: {reasons}",
            shortages=shortages,
            service_id=service.id,
            service_name=service.name,
        )


class DuplicateNameError(CatalogError):
    def __init__(self, kind: str, name: str) -> None:
        noun = "Услуга" if kind == "service" else "Складская позиция"
        super().__init__(
            "duplicate_name",
            f"{noun} с названием «{name}» уже есть в этой компании",
            name=name,
        )


class InsufficientStockError(CatalogError):
    def __init__(self, item: models.InventoryItem, delta: Decimal) -> None:
        after = item.quantity + delta
        super().__init__(
            "insufficient_stock",
            (
                f"Недостаточно «{item.name}» на складе: есть {item.quantity} {item.unit.value}, "
                f"попытка изменить на {delta} {item.unit.value} дала бы {after} {item.unit.value}."
            ),
            inventory_item_id=item.id,
            name=item.name,
            available=str(item.quantity),
            unit=item.unit.value,
        )


# --------------------------------------------------------------------------- #
#  Выборка внутри тенанта
# --------------------------------------------------------------------------- #

def _service_load_options():
    return (
        selectinload(models.Service.materials).selectinload(models.ServiceMaterial.item),
    )


def get_service(
    db: Session,
    *,
    company_id: int,
    service_id: int,
    active_only: bool = True,
) -> models.Service | None:
    stmt = (
        select(models.Service)
        .options(*_service_load_options())
        .where(
            models.Service.id == service_id,
            models.Service.company_id == company_id,
        )
    )
    if active_only:
        stmt = stmt.where(models.Service.is_active.is_(True))
    return db.scalars(stmt).first()


def require_service(
    db: Session,
    *,
    company_id: int,
    service_id: int,
    active_only: bool = True,
) -> models.Service:
    service = get_service(
        db, company_id=company_id, service_id=service_id, active_only=active_only
    )
    if service is None:
        raise ServiceNotFoundError(service_id)
    return service


def get_item(
    db: Session,
    *,
    company_id: int,
    item_id: int,
    active_only: bool = True,
    for_update: bool = False,
) -> models.InventoryItem | None:
    stmt = select(models.InventoryItem).where(
        models.InventoryItem.id == item_id,
        models.InventoryItem.company_id == company_id,
    )
    if active_only:
        stmt = stmt.where(models.InventoryItem.is_active.is_(True))
    if for_update:
        stmt = stmt.with_for_update()
    return db.scalars(stmt).first()


def require_item(
    db: Session,
    *,
    company_id: int,
    item_id: int,
    active_only: bool = True,
    for_update: bool = False,
) -> models.InventoryItem:
    item = get_item(
        db,
        company_id=company_id,
        item_id=item_id,
        active_only=active_only,
        for_update=for_update,
    )
    if item is None:
        raise InventoryItemNotFoundError(item_id)
    return item


def is_quantity_violation(error: IntegrityError) -> bool:
    return QUANTITY_CONSTRAINT in str(getattr(error, "orig", error))


def is_duplicate_name(error: IntegrityError) -> bool:
    text = str(getattr(error, "orig", error))
    return any(name in text for name in NAME_CONSTRAINTS)


# --------------------------------------------------------------------------- #
#  Прайс-лист и складские позиции: создание и правка
# --------------------------------------------------------------------------- #

def _save(db: Session, *, kind: str, name: str, apply) -> None:
    """Изменения и flush в SAVEPOINT: дубль названия → DuplicateNameError, сессия цела."""
    try:
        with db.begin_nested():
            apply()
            db.flush()
    except IntegrityError as exc:
        if is_duplicate_name(exc):
            raise DuplicateNameError(kind, name) from exc
        raise


def create_service(
    db: Session,
    *,
    company_id: int,
    name: str,
    base_price: Decimal,
    duration_minutes: int,
    description: str | None = None,
    materials: list[tuple[int, Decimal]] | None = None,
    custom_fields: dict | None = None,
) -> models.Service:
    service = models.Service(
        company_id=company_id,
        name=name,
        description=description,
        base_price=base_price,
        duration_minutes=duration_minutes,
        custom_fields=custom_fields or {},
    )

    def apply() -> None:
        db.add(service)
        if materials:
            db.flush()
            set_materials(db, company_id=company_id, service=service, materials=materials)

    _save(db, kind="service", name=name, apply=apply)
    return service


def update_service(db: Session, *, service: models.Service, changes: dict) -> models.Service:
    def apply() -> None:
        for field, value in changes.items():
            setattr(service, field, value)

    _save(db, kind="service", name=changes.get("name") or service.name, apply=apply)
    return service


def archive_service(service: models.Service) -> None:
    """Из прайс-листа и записи — да, из истории визитов — нет."""
    service.is_active = False
    service.deleted_at = datetime.now(timezone.utc)


def create_item(
    db: Session,
    *,
    company_id: int,
    name: str,
    unit: models.MeasurementUnit,
    sku: str | None = None,
    low_stock_threshold: Decimal | None = None,
    initial_quantity: Decimal = Decimal("0"),
    created_by_user_id: int | None = None,
    custom_fields: dict | None = None,
) -> models.InventoryItem:
    """Начальный остаток проводится приходом — журнал сходится с остатком с первого дня."""
    item = models.InventoryItem(
        company_id=company_id,
        name=name,
        sku=sku,
        unit=unit,
        quantity=Decimal("0"),
        low_stock_threshold=low_stock_threshold,
        custom_fields=custom_fields or {},
    )

    def apply() -> None:
        db.add(item)
        if initial_quantity > 0:
            db.flush()
            apply_movement(
                db,
                item=item,
                delta=initial_quantity,
                reason=models.StockMovementReason.PURCHASE,
                created_by_user_id=created_by_user_id,
                note="Начальный остаток при создании позиции",
            )

    _save(db, kind="inventory", name=name, apply=apply)
    return item


def update_item(
    db: Session, *, item: models.InventoryItem, changes: dict
) -> models.InventoryItem:
    def apply() -> None:
        for field, value in changes.items():
            setattr(item, field, value)

    _save(db, kind="inventory", name=changes.get("name") or item.name, apply=apply)
    return item


def archive_item(item: models.InventoryItem) -> None:
    item.is_active = False
    item.deleted_at = datetime.now(timezone.utc)


# --------------------------------------------------------------------------- #
#  Рецепт услуги
# --------------------------------------------------------------------------- #

def set_materials(
    db: Session,
    *,
    company_id: int,
    service: models.Service,
    materials: list[tuple[int, Decimal]],
) -> models.Service:
    """
    Полностью заменяет рецепт услуги.

    Каждая позиция должна принадлежать той же компании и быть активной —
    иначе в рецепт попал бы чужой или уже снятый с продажи материал.
    """
    seen: set[int] = set()
    rows: list[models.ServiceMaterial] = []
    for item_id, quantity in materials:
        if item_id in seen:
            raise CatalogError(
                "duplicate_material",
                f"Материал id={item_id} указан в рецепте дважды. "
                f"Объедини нормы в одну строку.",
                inventory_item_id=item_id,
            )
        seen.add(item_id)
        item = require_item(db, company_id=company_id, item_id=item_id)
        rows.append(
            models.ServiceMaterial(
                company_id=company_id,
                inventory_item_id=item.id,
                quantity=quantity,
            )
        )

    service.materials.clear()
    db.flush()  # чтобы UNIQUE (service_id, item_id) не сработал на «старых» строках
    service.materials.extend(rows)
    db.flush()
    db.refresh(service, attribute_names=["materials"])
    return service


# --------------------------------------------------------------------------- #
#  Движения по складу
# --------------------------------------------------------------------------- #

def apply_movement(
    db: Session,
    *,
    item: models.InventoryItem,
    delta: Decimal,
    reason: models.StockMovementReason,
    appointment_id: int | None = None,
    created_by_user_id: int | None = None,
    note: str | None = None,
) -> models.StockMovement:
    """
    Меняет остаток и пишет строку в журнал.

    Остаток правится только здесь. Прямой UPDATE inventory_items.quantity
    из обработчика — путь к расхождению журнала и факта.
    """
    if delta == 0:
        raise CatalogError("invalid_delta", "Количество движения не может быть нулевым")

    new_quantity = item.quantity + delta
    if new_quantity < 0:
        raise InsufficientStockError(item, delta)

    item.quantity = new_quantity
    movement = models.StockMovement(
        company_id=item.company_id,
        inventory_item_id=item.id,
        delta=delta,
        reason=reason,
        appointment_id=appointment_id,
        created_by_user_id=created_by_user_id,
        note=note,
    )
    db.add(movement)
    return movement


def _net_consumed(db: Session, appointment_id: int) -> Decimal:
    """Сумма всех списаний и возвратов по визиту. Отрицательная — материалы ещё «на клиенте»."""
    value = db.scalar(
        select(func.coalesce(func.sum(models.StockMovement.delta), 0)).where(
            models.StockMovement.appointment_id == appointment_id,
            models.StockMovement.reason.in_(
                (
                    models.StockMovementReason.CONSUMPTION,
                    models.StockMovementReason.RETURN,
                )
            ),
        )
    )
    return Decimal(value)


# --------------------------------------------------------------------------- #
#  Проверка и списание при оказании услуги
# --------------------------------------------------------------------------- #

def inspect_shortages(
    db: Session,
    *,
    company_id: int,
    service: models.Service,
    locked_items: dict[int, models.InventoryItem] | None = None,
) -> list[dict]:
    """
    Собирает причины, по которым услугу сейчас оказать нельзя.

    Каждая позиция рецепта проверяется отдельно: так в одном ответе
    видно и «керамики нет на складе», и «микрофибра отключена».
    """
    shortages: list[dict] = []
    for row in service.materials:
        item = (locked_items or {}).get(row.inventory_item_id)
        if item is None:
            item = get_item(
                db,
                company_id=company_id,
                item_id=row.inventory_item_id,
                active_only=False,
            )

        if item is None:
            shortages.append(
                {
                    "code": "material_not_found",
                    "inventory_item_id": row.inventory_item_id,
                    "name": row.item_name or f"id={row.inventory_item_id}",
                    "required": str(row.quantity),
                    "available": None,
                    "unit": row.item_unit.value if row.item_unit else None,
                    "message": (
                        f"Материал «{row.item_name or row.inventory_item_id}» "
                        f"(id={row.inventory_item_id}) нужен для услуги «{service.name}», "
                        f"но его нет на складе этой компании"
                    ),
                }
            )
            continue

        if not item.is_active:
            shortages.append(
                {
                    "code": "material_inactive",
                    "inventory_item_id": item.id,
                    "name": item.name,
                    "required": str(row.quantity),
                    "available": str(item.quantity),
                    "unit": item.unit.value,
                    "message": (
                        f"Материал «{item.name}» отключён и его нельзя списывать "
                        f"на услугу «{service.name}»"
                    ),
                }
            )
            continue

        if item.quantity < row.quantity:
            shortages.append(
                {
                    "code": "insufficient_stock",
                    "inventory_item_id": item.id,
                    "name": item.name,
                    "required": str(row.quantity),
                    "available": str(item.quantity),
                    "unit": item.unit.value,
                    "message": (
                        f"Недостаточно «{item.name}»: нужно {row.quantity} {item.unit.value}, "
                        f"на складе {item.quantity} {item.unit.value}"
                    ),
                }
            )
    return shortages


def consume_for_appointment(
    db: Session,
    *,
    company: models.Company,
    appointment: models.Appointment,
    created_by_user_id: int | None = None,
) -> list[models.StockMovement]:
    """
    Списывает материалы по рецепту услуги визита.

    Идемпотентно: повторный вызов (scheduled -> in_progress -> completed)
    не спишет материалы дважды. Блокирует строки склада FOR UPDATE,
    чтобы два одновременных визита не ушли в минус.
    """
    if appointment.service_id is None:
        return []
    if _net_consumed(db, appointment.id) < 0:
        return []

    service = require_service(
        db, company_id=company.id, service_id=appointment.service_id
    )
    if not service.materials:
        return []

    item_ids = [row.inventory_item_id for row in service.materials]
    locked = {
        item.id: item
        for item in db.scalars(
            select(models.InventoryItem)
            .where(
                models.InventoryItem.id.in_(item_ids),
                models.InventoryItem.company_id == company.id,
            )
            .with_for_update()
        )
    }

    shortages = inspect_shortages(
        db, company_id=company.id, service=service, locked_items=locked
    )
    if shortages:
        raise CannotProvideServiceError(service, shortages)

    movements: list[models.StockMovement] = []
    for row in service.materials:
        item = locked[row.inventory_item_id]
        movements.append(
            apply_movement(
                db,
                item=item,
                delta=-row.quantity,
                reason=models.StockMovementReason.CONSUMPTION,
                appointment_id=appointment.id,
                created_by_user_id=created_by_user_id,
                note=f"Списание по услуге «{service.name}», визит #{appointment.id}",
            )
        )
    return movements


def restore_for_appointment(
    db: Session,
    *,
    company: models.Company,
    appointment: models.Appointment,
    created_by_user_id: int | None = None,
) -> list[models.StockMovement]:
    """
    Возвращает на склад то, что списали по визиту (отмена уже начатой работы).

    Берём фактические списания из журнала, а не текущий рецепт: состав услуги
    могли поменять уже после визита, и возвращать нужно ровно то, что ушло.
    """
    if _net_consumed(db, appointment.id) >= 0:
        return []

    consumed = db.scalars(
        select(models.StockMovement).where(
            models.StockMovement.appointment_id == appointment.id,
            models.StockMovement.reason == models.StockMovementReason.CONSUMPTION,
        )
    )

    # Суммируем на случай повторных списаний (не должно случаться, но безопаснее).
    by_item: dict[int, Decimal] = {}
    for movement in consumed:
        by_item[movement.inventory_item_id] = (
            by_item.get(movement.inventory_item_id, Decimal("0")) + movement.delta
        )

    item_ids = list(by_item)
    locked = {
        item.id: item
        for item in db.scalars(
            select(models.InventoryItem)
            .where(
                models.InventoryItem.id.in_(item_ids),
                models.InventoryItem.company_id == company.id,
            )
            .with_for_update()
        )
    }

    movements: list[models.StockMovement] = []
    for item_id, delta in by_item.items():
        # delta списания отрицательная; возврат — с противоположным знаком.
        item = locked.get(item_id)
        if item is None:
            raise InventoryItemNotFoundError(item_id)
        movements.append(
            apply_movement(
                db,
                item=item,
                delta=-delta,
                reason=models.StockMovementReason.RETURN,
                appointment_id=appointment.id,
                created_by_user_id=created_by_user_id,
                note=f"Возврат при отмене визита #{appointment.id}",
            )
        )
    return movements


def sync_stock_with_status(
    db: Session,
    *,
    company: models.Company,
    appointment: models.Appointment,
    new_status: models.AppointmentStatus,
    created_by_user_id: int | None = None,
) -> None:
    """
    Приводит склад в соответствие новому статусу визита.

    in_progress / completed -> списать (если ещё не списано);
    cancelled               -> вернуть (если уже списано).
    scheduled после отмены  -> ничего: материалы уже на полке.
    """
    if new_status in CONSUMING_STATUSES:
        consume_for_appointment(
            db,
            company=company,
            appointment=appointment,
            created_by_user_id=created_by_user_id,
        )
    elif new_status == models.AppointmentStatus.CANCELLED:
        restore_for_appointment(
            db,
            company=company,
            appointment=appointment,
            created_by_user_id=created_by_user_id,
        )
