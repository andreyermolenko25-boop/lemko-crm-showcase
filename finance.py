"""
Касса: транзакции и баланс визита.

Это ядро, не ниша. Деньги считаются одинаково в детейлинге и в стоматологии.
Как выглядит чек или эквайринг — extra_data транзакции, его заполнит
контейнер ниши, не новая таблица.

Баланс визита не хранится колонкой: due берётся из Appointment.price
(снимок на момент записи), paid — сумма completed-транзакций. Иначе
любая правка прайса или гонка двух оплат разъехалась бы с фактом.
"""

from __future__ import annotations

from dataclasses import dataclass
from decimal import Decimal

from sqlalchemy import case, func, select
from sqlalchemy.orm import Session

import models
from core.errors import DomainError
from scheduling import get_client

ZERO = Decimal("0.00")


class FinanceError(DomainError):
    status_code = 409


class ClientNotFoundError(FinanceError):
    status_code = 404

    def __init__(self, client_id: int) -> None:
        super().__init__(
            "client_not_found",
            f"Клиент с id={client_id} не найден в этой компании",
            client_id=client_id,
        )


class AppointmentNotFoundError(FinanceError):
    status_code = 404

    def __init__(self, appointment_id: int) -> None:
        super().__init__(
            "appointment_not_found",
            f"Визит с id={appointment_id} не найден в этой компании",
            appointment_id=appointment_id,
        )


class TransactionNotFoundError(FinanceError):
    status_code = 404

    def __init__(self, transaction_id: int) -> None:
        super().__init__(
            "transaction_not_found",
            f"Транзакция с id={transaction_id} не найдена",
            transaction_id=transaction_id,
        )


@dataclass(frozen=True)
class AppointmentBalance:
    """Сводка по визиту. Считается на лету, в таблицу не пишется."""

    due: Decimal
    paid: Decimal
    remaining: Decimal
    status: models.AppointmentPaymentStatus


def _money(value: Decimal | int | str | None) -> Decimal:
    if value is None:
        return ZERO
    return Decimal(value).quantize(ZERO)


def _signed_sql():
    """SQL-выражение: payment → +amount, refund → −amount. Только completed."""
    return func.coalesce(
        func.sum(
            case(
                (
                    models.Transaction.kind == models.TransactionKind.PAYMENT,
                    models.Transaction.amount,
                ),
                else_=-models.Transaction.amount,
            )
        ),
        0,
    )


def net_paid_for_appointments(
    db: Session,
    *,
    company_id: int,
    appointment_ids: list[int],
) -> dict[int, Decimal]:
    """Пакетный net paid по визитам — чтобы список расписания не делал N+1."""
    if not appointment_ids:
        return {}
    stmt = (
        select(models.Transaction.appointment_id, _signed_sql())
        .where(
            models.Transaction.company_id == company_id,
            models.Transaction.appointment_id.in_(appointment_ids),
            models.Transaction.status == models.TransactionStatus.COMPLETED,
        )
        .group_by(models.Transaction.appointment_id)
    )
    return {row[0]: _money(row[1]) for row in db.execute(stmt)}


def net_paid_for_appointment(
    db: Session, *, company_id: int, appointment_id: int
) -> Decimal:
    return net_paid_for_appointments(
        db, company_id=company_id, appointment_ids=[appointment_id]
    ).get(appointment_id, ZERO)


def net_paid_for_client(db: Session, *, company_id: int, client_id: int) -> Decimal:
    """LTV: все completed-платежи минус возвраты по клиенту, с визитом и без."""
    stmt = select(_signed_sql()).where(
        models.Transaction.company_id == company_id,
        models.Transaction.client_id == client_id,
        models.Transaction.status == models.TransactionStatus.COMPLETED,
    )
    return _money(db.scalar(stmt))


def net_paid_by_client(db: Session, *, company_id: int) -> dict[int, Decimal]:
    """LTV всех клиентов компании одним GROUP BY — для списков и отчётов."""
    stmt = (
        select(models.Transaction.client_id, _signed_sql())
        .where(
            models.Transaction.company_id == company_id,
            models.Transaction.status == models.TransactionStatus.COMPLETED,
        )
        .group_by(models.Transaction.client_id)
    )
    return {row[0]: _money(row[1]) for row in db.execute(stmt)}


def appointment_balance(
    appointment: models.Appointment,
    paid: Decimal,
) -> AppointmentBalance:
    due = _money(appointment.price)
    paid = _money(paid)
    remaining = due - paid

    if paid == ZERO and due == ZERO:
        status = models.AppointmentPaymentStatus.PAID
    elif paid == ZERO:
        status = models.AppointmentPaymentStatus.UNPAID
    elif paid < due:
        status = models.AppointmentPaymentStatus.PARTIAL
    elif paid == due:
        status = models.AppointmentPaymentStatus.PAID
    else:
        status = models.AppointmentPaymentStatus.OVERPAID

    return AppointmentBalance(due=due, paid=paid, remaining=remaining, status=status)


def balance_for(
    db: Session, *, company_id: int, appointment: models.Appointment
) -> AppointmentBalance:
    paid = net_paid_for_appointment(
        db, company_id=company_id, appointment_id=appointment.id
    )
    return appointment_balance(appointment, paid)


def create_transaction(
    db: Session,
    *,
    company_id: int,
    client_id: int,
    amount: Decimal,
    kind: models.TransactionKind,
    method: models.PaymentMethod,
    status: models.TransactionStatus,
    appointment_id: int | None,
    created_by_user_id: int | None,
    comment: str | None,
    extra_data: dict,
) -> models.Transaction:
    """
    Проводит операцию и проверяет инварианты кассы.

    Возврат не может превысить уже оплаченное по визиту (или по клиенту,
    если визита нет). Строка визита блокируется FOR UPDATE — иначе два
    одновременных возврата уйдут в минус по кассе.
    """
    client = get_client(
        db, company_id=company_id, client_id=client_id, active_only=False
    )
    if client is None or not client.is_active:
        raise ClientNotFoundError(client_id)

    appointment: models.Appointment | None = None
    if appointment_id is not None:
        appointment = db.scalars(
            select(models.Appointment)
            .where(
                models.Appointment.id == appointment_id,
                models.Appointment.company_id == company_id,
            )
            .with_for_update()
        ).first()
        if appointment is None:
            raise AppointmentNotFoundError(appointment_id)
        if appointment.client_id != client_id:
            raise FinanceError(
                "client_mismatch",
                (
                    f"Клиент id={client_id} не совпадает с клиентом визита "
                    f"id={appointment_id} (client_id={appointment.client_id})"
                ),
                client_id=client_id,
                appointment_id=appointment_id,
            )

    amount = _money(amount)
    if amount <= ZERO:
        raise FinanceError("invalid_amount", "Сумма должна быть больше нуля")

    counts = status == models.TransactionStatus.COMPLETED
    if counts and kind == models.TransactionKind.REFUND:
        if appointment is not None:
            already = net_paid_for_appointment(
                db, company_id=company_id, appointment_id=appointment.id
            )
        else:
            already = net_paid_for_client(
                db, company_id=company_id, client_id=client_id
            )
        if already - amount < ZERO:
            raise FinanceError(
                "refund_exceeds_paid",
                (
                    f"Нельзя вернуть {amount}: оплачено {already}, "
                    f"возврат ушёл бы в минус"
                ),
                paid=str(already),
                refund=str(amount),
            )

    txn = models.Transaction(
        company_id=company_id,
        client_id=client_id,
        appointment_id=appointment_id,
        amount=amount,
        kind=kind,
        status=status,
        method=method,
        created_by_user_id=created_by_user_id,
        comment=comment,
        extra_data=extra_data,
    )
    db.add(txn)
    db.flush()
    return txn


def update_transaction_status(
    db: Session,
    *,
    company_id: int,
    transaction_id: int,
    new_status: models.TransactionStatus,
) -> models.Transaction:
    """Провести или отменить pending-операцию. Completed трогать нельзя."""
    txn = db.scalars(
        select(models.Transaction)
        .where(
            models.Transaction.id == transaction_id,
            models.Transaction.company_id == company_id,
        )
        .with_for_update()
    ).first()
    if txn is None:
        raise TransactionNotFoundError(transaction_id)

    if txn.status == new_status:
        return txn
    if txn.status != models.TransactionStatus.PENDING:
        raise FinanceError(
            "transaction_immutable",
            (
                f"Транзакцию в статусе {txn.status.value} нельзя менять. "
                "Ошибочную completed-оплату исправляют так: полный возврат "
                "(refund) на ту же сумму, затем новая оплата с правильной суммой."
            ),
            transaction_id=txn.id,
            status=txn.status.value,
            correction="refund_then_create",
        )

    if (
        new_status == models.TransactionStatus.COMPLETED
        and txn.kind == models.TransactionKind.REFUND
    ):
        if txn.appointment_id is not None:
            already = net_paid_for_appointment(
                db, company_id=company_id, appointment_id=txn.appointment_id
            )
        else:
            already = net_paid_for_client(
                db, company_id=company_id, client_id=txn.client_id
            )
        if already - txn.amount < ZERO:
            raise FinanceError(
                "refund_exceeds_paid",
                (
                    f"Нельзя провести возврат {txn.amount}: оплачено {already}"
                ),
                paid=str(already),
                refund=str(txn.amount),
            )

    txn.status = new_status
    return txn
