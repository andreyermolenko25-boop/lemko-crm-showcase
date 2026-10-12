"""
Модели БД (SQLAlchemy 2.0).

Архитектура multi-tenant: "одна база / одна схема / общие таблицы"
(shared database, shared schema). Тенант — это Company (компания-клиент SaaS).
Каждая бизнес-таблица несёт company_id, и любой запрос ОБЯЗАН фильтроваться по нему.

Специфика ниши (детейлинг, стоматология, ...) не создаёт отдельных таблиц:
она живёт в JSONB-поле extra_data. Благодаря этому подключение новой ниши
не требует миграций схемы — достаточно описать её Pydantic-схему в schemas.py.
"""

from __future__ import annotations

import enum
from datetime import datetime
from decimal import Decimal
from typing import Any

from sqlalchemy import (
    BigInteger,
    Boolean,
    LargeBinary,
    CheckConstraint,
    DateTime,
    Enum as SAEnum,
    ForeignKey,
    Index,
    Integer,
    Numeric,
    String,
    Text,
    UniqueConstraint,
    func,
    literal_column,
    text,
)
from sqlalchemy.dialects.postgresql import JSONB, ExcludeConstraint
from sqlalchemy.orm import Mapped, mapped_column, relationship

from core.database import Base


# --------------------------------------------------------------------------- #
#  Перечисления (справочники)
# --------------------------------------------------------------------------- #

class Niche(str, enum.Enum):
    """Ниша бизнеса. Определяет, какой набор полей ожидается в extra_data."""

    DETAILING = "detailing"    # детейлинг / автосервис
    DENTISTRY = "dentistry"    # стоматология
    OTHER = "other"            # универсальный режим без строгой валидации


class UserRole(str, enum.Enum):
    """Роль сотрудника внутри своей компании (доступ к системе)."""

    OWNER = "owner"        # владелец компании, полный доступ
    ADMIN = "admin"        # администратор / управляющий
    MANAGER = "manager"    # менеджер, работает с клиентами и записями
    STAFF = "staff"        # исполнитель (мастер детейлинга, врач)
    VIEWER = "viewer"      # только просмотр (бухгалтер, наблюдатель)


class SubscriptionStatus(str, enum.Enum):
    """Статус подписки SaaS-тенанта."""

    TRIAL = "trial"          # демо-доступ
    ACTIVE = "active"        # оплаченная подписка
    INACTIVE = "inactive"    # заблокирован / истёк


class AppointmentStatus(str, enum.Enum):
    """Статус визита."""

    SCHEDULED = "scheduled"        # запланирован
    IN_PROGRESS = "in_progress"    # в работе
    COMPLETED = "completed"        # завершён
    CANCELLED = "cancelled"        # отменён


# Статусы, которые РЕАЛЬНО занимают время в расписании мастера.
# Отменённая запись слот освобождает, завершённая — нет (она уже состоялась).
BLOCKING_APPOINTMENT_STATUSES: tuple[AppointmentStatus, ...] = (
    AppointmentStatus.SCHEDULED,
    AppointmentStatus.IN_PROGRESS,
    AppointmentStatus.COMPLETED,
)


class MeasurementUnit(str, enum.Enum):
    """
    Единица измерения складской позиции.

    Хранение ведётся ровно в той единице, что указана у позиции: керамика —
    в миллилитрах, микрофибра — в штуках. Нормы расхода в ServiceMaterial
    задаются в этой же единице, поэтому пересчёты (л -> мл) в системе не нужны.
    """

    ML = "ml"       # миллилитр
    L = "l"         # литр
    G = "g"         # грамм
    KG = "kg"       # килограмм
    PCS = "pcs"     # штука
    PACK = "pack"   # упаковка


class StockMovementReason(str, enum.Enum):
    """Причина движения по складу — основа для отчётов и разбора расхождений."""

    PURCHASE = "purchase"          # приход от поставщика
    CONSUMPTION = "consumption"    # списание при оказании услуги
    RETURN = "return"              # возврат при отмене уже завершённого визита
    ADJUSTMENT = "adjustment"      # корректировка по инвентаризации
    WRITE_OFF = "write_off"        # порча, брак, истёк срок


class TransactionKind(str, enum.Enum):
    """Направление денег. Знак в БД не храним: сумма всегда положительная."""

    PAYMENT = "payment"    # приход (клиент платит)
    REFUND = "refund"      # возврат клиенту


class TransactionStatus(str, enum.Enum):
    """Проведена ли операция. В баланс визита входят только completed."""

    PENDING = "pending"        # ещё не прошла (перевод в пути, холд)
    COMPLETED = "completed"    # деньги реально сменились
    CANCELLED = "cancelled"    # отменили до проведения


class PaymentMethod(str, enum.Enum):
    """
    Способ оплаты — общее ядро, не ниша.

    Как именно оформлен чек (эквайринг, рассрочка, ДМС) живёт в extra_data
    транзакции и подключается контейнером ниши, не новой колонкой.
    """

    CASH = "cash"
    CARD = "card"
    TRANSFER = "transfer"
    OTHER = "other"


class AppointmentPaymentStatus(str, enum.Enum):
    """Сводка по визиту: не хранится, считается из цены визита и транзакций."""

    UNPAID = "unpaid"        # не поступило ничего
    PARTIAL = "partial"      # есть оплаты, долг ещё висит
    PAID = "paid"            # покрыто ровно (или визит без цены и без оплат)
    OVERPAID = "overpaid"    # заплатили больше, чем цена визита


class NotificationEventType(str, enum.Enum):
    """Бизнес-события ядра, из которых потом собирают уведомления и вебхуки."""

    APPOINTMENT_CREATED = "appointment_created"
    APPOINTMENT_RESCHEDULED = "appointment_rescheduled"
    APPOINTMENT_CANCELLED = "appointment_cancelled"
    CLIENT_CREATED = "client_created"
    CLIENT_UPDATED = "client_updated"
    # Объекты CRM (любая сущность UI: сделки, задачи, кастомные объекты).
    RECORD_CREATED = "record_created"
    RECORD_UPDATED = "record_updated"
    RECORD_DELETED = "record_deleted"
    # Письма сотрудникам.
    MEMBER_INVITED = "member_invited"
    USER_NOTIFICATION = "user_notification"
    # Письма и SMS безопасности: коды, ссылки входа и сброса пароля, новое устройство.
    SECURITY = "security"
    WEEKLY_DIGEST = "weekly_digest"


class OutboxStatus(str, enum.Enum):
    """Ядро ставит только pending. Дальше строку забирает воркер, не HTTP-запрос."""

    PENDING = "pending"
    PROCESSING = "processing"
    SENT = "sent"
    FAILED = "failed"


class NotificationRecipientKind(str, enum.Enum):
    """Кому адресована строка outbox."""

    CLIENT = "client"      # клиент бизнеса (email из карточки)
    USER = "user"          # сотрудник (email профиля)
    WEBHOOK = "webhook"    # подписка тенанта (recipient_id = webhooks.id)
    EMAIL = "email"        # произвольный адрес из payload["to"]
    HTTP = "http"          # произвольный URL из payload["url"]
    SMS = "sms"            # номер из payload["to"] (коды подтверждения)


class WebhookEvent(str, enum.Enum):
    """События подписки вебхука (dotted). Нишевых имён нет."""

    APPOINTMENT_CREATED = "appointment.created"
    APPOINTMENT_RESCHEDULED = "appointment.rescheduled"
    APPOINTMENT_CANCELLED = "appointment.cancelled"
    CLIENT_CREATED = "client.created"
    CLIENT_UPDATED = "client.updated"
    RECORD_CREATED = "record.created"
    RECORD_UPDATED = "record.updated"
    RECORD_DELETED = "record.deleted"


class AuditAction(str, enum.Enum):
    """Тип записи в журнале. Чтения не пишем — иначе лог утонет в GET."""

    CREATED = "created"
    UPDATED = "updated"
    DELETED = "deleted"


class AuthLogStatus(str, enum.Enum):
    """Результат попытки входа / обновления сессии."""

    SUCCESS = "success"
    FAILURE = "failure"
    REFRESH = "refresh"
    LOGOUT = "logout"
    REJECTED = "rejected"  # IP/UA mismatch или прочий сброс сессии


class AttachmentEntityType(str, enum.Enum):
    """К чему прикреплён файл. Ниша не добавляет свои типы — только id в extra_data."""

    CLIENT = "client"
    APPOINTMENT = "appointment"
    NOTE = "note"
    COMPANY = "company"    # логотип воркспейса


# ВАЖНО: values_callable заставляет SQLAlchemy хранить в PostgreSQL значения
# ("detailing"), а не имена членов enum ("DETAILING").
def _pg_enum(
    enum_cls: type[enum.Enum], type_name: str, *, create_type: bool = True
) -> SAEnum:
    return SAEnum(
        enum_cls,
        name=type_name,
        values_callable=lambda e: [member.value for member in e],
        create_type=create_type,
    )


def _str_enum(enum_cls: type[enum.Enum], length: int = 32) -> SAEnum:
    """
    Enum, хранящийся строкой (VARCHAR без CHECK). Новое значение в Python
    не требует ALTER TYPE — для списков, которые растут вместе с продуктом.
    """
    return SAEnum(
        enum_cls,
        native_enum=False,
        create_constraint=False,
        length=length,
        values_callable=lambda e: [member.value for member in e],
    )


# --------------------------------------------------------------------------- #
#  Миксины: переиспользуемые куски для всех будущих таблиц
# --------------------------------------------------------------------------- #

class TimestampMixin:
    """Служебные метки времени. Заполняются на стороне БД."""

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
        nullable=False,
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
        onupdate=func.now(),
        nullable=False,
    )


class TenantMixin:
    """
    Признак принадлежности тенанту.

    Наследуй этот миксин для КАЖДОЙ новой бизнес-сущности (заказы, визиты,
    услуги, платежи) — так company_id и индекс по нему появятся автоматически.
    """

    company_id: Mapped[int] = mapped_column(
        ForeignKey("companies.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )


class SoftDeleteMixin:
    """
    Критичные сущности (сотрудник, клиент) не удаляются физически:
    иначе CASCADE снёс бы визиты и кассу. Операционные GET фильтруют
    deleted_at IS NULL; отчёты джойнят без этого фильтра.
    """

    deleted_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True),
        nullable=True,
    )


def is_alive(model: type) -> Any:
    """Условие «строка не в архиве» для операционных выборок."""
    return model.deleted_at.is_(None)


# --------------------------------------------------------------------------- #
#  Ядро: компании (тенанты)
# --------------------------------------------------------------------------- #

class Company(TimestampMixin, Base):
    """Компания-клиент SaaS. Корень изоляции данных."""

    __tablename__ = "companies"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    name: Mapped[str] = mapped_column(String(255), nullable=False)

    # Ниша задаёт "профиль" компании: набор полей extra_data, шаблоны услуг и т.п.
    niche: Mapped[Niche] = mapped_column(
        _pg_enum(Niche, "niche_enum"),
        nullable=False,
        default=Niche.OTHER,
        server_default=Niche.OTHER.value,
    )

    # Прочие тумблеры тенанта (валюта, включённые модули) — JSONB,
    # чтобы не плодить колонки. Часовой пояс — отдельная колонка timezone:
    # от неё зависит GROUP BY календарному дню в PostgreSQL.
    settings: Mapped[dict[str, Any]] = mapped_column(
        JSONB,
        nullable=False,
        default=dict,
        server_default=text("'{}'::jsonb"),
    )
    # IANA-имя, например Europe/Berlin. Хранение всегда UTC; пояс нужен,
    # чтобы GROUP BY календарному дню не съезжал на полночь UTC.
    timezone: Mapped[str] = mapped_column(
        String(64),
        nullable=False,
        default="UTC",
        server_default="UTC",
    )
    # Правила приёма заявок из директа/форм: автосоздание клиента, маппинг полей.
    # Нишевые поля заявки — extra_data лида, не новые колонки.
    intake_settings: Mapped[dict[str, Any]] = mapped_column(
        JSONB,
        nullable=False,
        default=dict,
        server_default=text("'{}'::jsonb"),
    )
    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)

    # SaaS-подписка: trial 14 дней при регистрации, далее active/inactive.
    subscription_status: Mapped[SubscriptionStatus] = mapped_column(
        _pg_enum(SubscriptionStatus, "subscription_status_enum"),
        nullable=False,
        default=SubscriptionStatus.TRIAL,
        server_default=SubscriptionStatus.TRIAL.value,
    )
    trial_ends_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True),
        nullable=True,
        comment="Конец демо-доступа (UTC)",
    )

    users: Mapped[list["User"]] = relationship(
        back_populates="company",
        cascade="all, delete-orphan",
        passive_deletes=True,
    )
    clients: Mapped[list["Client"]] = relationship(
        back_populates="company",
        cascade="all, delete-orphan",
        passive_deletes=True,
    )
    appointments: Mapped[list["Appointment"]] = relationship(
        back_populates="company",
        cascade="all, delete-orphan",
        passive_deletes=True,
    )
    services: Mapped[list["Service"]] = relationship(
        back_populates="company",
        cascade="all, delete-orphan",
        passive_deletes=True,
    )
    inventory_items: Mapped[list["InventoryItem"]] = relationship(
        back_populates="company",
        cascade="all, delete-orphan",
        passive_deletes=True,
    )
    stock_movements: Mapped[list["StockMovement"]] = relationship(
        back_populates="company",
        cascade="all, delete-orphan",
        passive_deletes=True,
    )
    service_materials: Mapped[list["ServiceMaterial"]] = relationship(
        back_populates="company",
        cascade="all, delete-orphan",
        passive_deletes=True,
    )
    transactions: Mapped[list["Transaction"]] = relationship(
        back_populates="company",
        cascade="all, delete-orphan",
        passive_deletes=True,
    )
    client_notes: Mapped[list["ClientNote"]] = relationship(
        back_populates="company",
        cascade="all, delete-orphan",
        passive_deletes=True,
    )
    work_shifts: Mapped[list["WorkShift"]] = relationship(
        back_populates="company",
        cascade="all, delete-orphan",
        passive_deletes=True,
    )
    notification_outbox: Mapped[list["NotificationOutbox"]] = relationship(
        back_populates="company",
        cascade="all, delete-orphan",
        passive_deletes=True,
    )
    audit_logs: Mapped[list["AuditLog"]] = relationship(
        back_populates="company",
        cascade="all, delete-orphan",
        passive_deletes=True,
    )
    attachments: Mapped[list["Attachment"]] = relationship(
        back_populates="company",
        cascade="all, delete-orphan",
        passive_deletes=True,
    )
    api_keys: Mapped[list["ApiKey"]] = relationship(
        back_populates="company",
        cascade="all, delete-orphan",
        passive_deletes=True,
    )
    webhooks: Mapped[list["Webhook"]] = relationship(
        back_populates="company",
        cascade="all, delete-orphan",
        passive_deletes=True,
    )
    workspace: Mapped["WorkspaceSettings | None"] = relationship(
        back_populates="company",
        cascade="all, delete-orphan",
        passive_deletes=True,
        uselist=False,
    )

    def __repr__(self) -> str:
        return f"<Company id={self.id} name={self.name!r} niche={self.niche.value}>"


# --------------------------------------------------------------------------- #
#  Сотрудники компании
# --------------------------------------------------------------------------- #

class User(SoftDeleteMixin, TenantMixin, TimestampMixin, Base):
    """Сотрудник компании. Логин уникален среди живых записей тенанта."""

    __tablename__ = "users"
    __table_args__ = (
        # Уволенный мастер освобождает логин, но строка остаётся для отчётов.
        Index(
            "uq_users_company_username",
            "company_id",
            "username",
            unique=True,
            postgresql_where=text("deleted_at IS NULL"),
        ),
        Index("ix_users_company_deleted", "company_id", "deleted_at"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    username: Mapped[str] = mapped_column(String(150), nullable=False)

    # Пароль храним только в виде хэша (bcrypt/argon2). Nullable — на случай
    # входа через внешний провайдер (OAuth/SSO).
    hashed_password: Mapped[str | None] = mapped_column(String(255), nullable=True)

    role: Mapped[UserRole] = mapped_column(
        _pg_enum(UserRole, "user_role_enum"),
        nullable=False,
        default=UserRole.MANAGER,
        server_default=UserRole.MANAGER.value,
    )
    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)

    # Профиль для UI: имя, должность, email для писем (логин может быть не email).
    full_name: Mapped[str | None] = mapped_column(String(255), nullable=True)
    job_title: Mapped[str | None] = mapped_column(String(255), nullable=True)
    email: Mapped[str | None] = mapped_column(String(255), nullable=True)
    # Личные настройки интерфейса и уведомлений (тема, акцент, избранное, …).
    preferences: Mapped[dict[str, Any]] = mapped_column(
        JSONB,
        nullable=False,
        default=dict,
        server_default=text("'{}'::jsonb"),
    )

    # --- Безопасность входа ---
    email_verified_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    phone: Mapped[str | None] = mapped_column(String(32), nullable=True)
    phone_verified_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    password_changed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    # TOTP-секрет зашифрован AES-GCM (core.crypto); last_step — защита от повтора кода.
    totp_secret: Mapped[str | None] = mapped_column(Text, nullable=True)
    totp_enabled_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    totp_last_step: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
    sms_mfa_enabled: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=False, server_default="false"
    )
    # HMAC-хэши неиспользованных резервных кодов.
    backup_codes: Mapped[list[str]] = mapped_column(
        JSONB, nullable=False, default=list, server_default=text("'[]'::jsonb")
    )

    company: Mapped["Company"] = relationship(back_populates="users")
    # Визиты и смены не каскадятся: удаление мастера — soft delete, история кассы живёт.
    appointments: Mapped[list["Appointment"]] = relationship(
        back_populates="master",
        passive_deletes=True,
    )
    work_shifts: Mapped[list["WorkShift"]] = relationship(
        back_populates="master",
        passive_deletes=True,
    )

    def __repr__(self) -> str:
        return f"<User id={self.id} company_id={self.company_id} username={self.username!r}>"


# --------------------------------------------------------------------------- #
#  Клиенты бизнеса
# --------------------------------------------------------------------------- #

class Client(SoftDeleteMixin, TenantMixin, TimestampMixin, Base):
    """
    Клиент компании (то есть клиент нашего клиента).

    extra_data — "гибкая" часть карточки, зависящая от ниши:
      * detailing: марка/модель/госномер авто;
      * dentistry: номер медкарты, аллергии, диагнозы.
    Структуру валидирует не БД, а Pydantic (см. schemas.EXTRA_DATA_SCHEMAS).

    Уникальность телефона — внутри тенанта (защита от дублей в одной студии).
    """

    __tablename__ = "clients"
    __table_args__ = (
        # UniqueConstraint(company_id, phone) для живых записей (soft-delete friendly).
        Index(
            "uq_clients_company_phone",
            "company_id",
            "phone",
            unique=True,
            postgresql_where=text("deleted_at IS NULL"),
        ),
        Index("ix_clients_company_name", "company_id", "name"),
        Index("ix_clients_extra_data", "extra_data", postgresql_using="gin"),
        Index("ix_clients_company_deleted", "company_id", "deleted_at"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    # Необязателен: контакт из почты, формы или импорта часто приходит только с email.
    phone: Mapped[str | None] = mapped_column(String(32), nullable=True, index=True)
    email: Mapped[str | None] = mapped_column(String(255), nullable=True)
    notes: Mapped[str | None] = mapped_column(Text, nullable=True)

    extra_data: Mapped[dict[str, Any]] = mapped_column(
        JSONB,
        nullable=False,
        default=dict,
        server_default=text("'{}'::jsonb"),
    )
    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    # Поля, которые воркспейс добавил к объекту в UI (теги, владелец,
    # кастомные поля). Не путать с extra_data — его схему задаёт ниша.
    custom_fields: Mapped[dict[str, Any]] = mapped_column(
        JSONB,
        nullable=False,
        default=dict,
        server_default=text("'{}'::jsonb"),
    )

    company: Mapped["Company"] = relationship(back_populates="clients")
    appointments: Mapped[list["Appointment"]] = relationship(
        back_populates="client",
        passive_deletes=True,
    )
    transactions: Mapped[list["Transaction"]] = relationship(
        back_populates="client",
        passive_deletes=True,
    )
    client_notes: Mapped[list["ClientNote"]] = relationship(
        back_populates="client",
        cascade="all, delete-orphan",
        passive_deletes=True,
    )

    def __repr__(self) -> str:
        return f"<Client id={self.id} company_id={self.company_id} name={self.name!r}>"


# --------------------------------------------------------------------------- #
#  Записи на приём (ядро CRM для сферы услуг)
# --------------------------------------------------------------------------- #

class Appointment(TenantMixin, TimestampMixin, Base):
    """
    Визит клиента к конкретному мастеру в конкретный интервал времени.

    Интервал полуоткрытый: [starts_at, ends_at). Запись 10:00–11:00 и запись
    11:00–12:00 НЕ конфликтуют — они лишь соприкасаются границами.

    Пересечения запрещены на двух уровнях:
      1. в коде (scheduling.find_conflicts) — чтобы вернуть понятный 409
         с перечислением конфликтующих записей;
      2. в самой БД (ExcludeConstraint ниже) — как последняя линия обороны.
         Проверка в коде принципиально не спасает от гонки: два параллельных
         запроса могут одновременно увидеть свободный слот и оба вставить
         запись. Ограничение PostgreSQL отсекает такой случай физически.
    """

    __tablename__ = "appointments"
    __table_args__ = (
        # Нулевая и отрицательная длительность недопустимы.
        CheckConstraint("ends_at > starts_at", name="ck_appointments_time_order"),

        # Главная защита от двойной записи одного мастера.
        # tstzrange(...,'[)') — полуоткрытый интервал, && — оператор пересечения.
        # WHERE отсекает отменённые визиты: их слот считается свободным.
        # Требует расширение btree_gist (равенство по int внутри GiST-индекса) —
        # оно создаётся в миграции.
        ExcludeConstraint(
            (literal_column("user_id"), "="),
            (literal_column("tstzrange(starts_at, ends_at, '[)')"), "&&"),
            name="excl_appointments_master_overlap",
            using="gist",
            where=text("status <> 'cancelled'"),
        ),

        # Основные сценарии выборки: расписание компании за период
        # и расписание конкретного мастера за период.
        Index("ix_appointments_company_starts", "company_id", "starts_at"),
        Index("ix_appointments_user_starts", "user_id", "starts_at"),
        Index("ix_appointments_client_starts", "client_id", "starts_at"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)

    # Клиент / услуга / сотрудник: RESTRICT — нельзя удалить, пока есть история визитов.
    # Компанию по-прежнему чистит company_id ON DELETE CASCADE.
    client_id: Mapped[int] = mapped_column(
        ForeignKey("clients.id", ondelete="RESTRICT"),
        nullable=False,
    )
    # Логин мастера (JWT-user). Сохранён для расписания/GiST exclude.
    user_id: Mapped[int] = mapped_column(
        ForeignKey("users.id", ondelete="RESTRICT"),
        nullable=False,
        comment="Мастер / врач с логином (слот расписания)",
    )

    # timezone=True обязателен: расписание без часового пояса — источник
    # ошибок при переходе на летнее время и работе из разных городов.
    starts_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    ends_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)

    status: Mapped[AppointmentStatus] = mapped_column(
        _pg_enum(AppointmentStatus, "appointment_status_enum"),
        nullable=False,
        default=AppointmentStatus.SCHEDULED,
        server_default=AppointmentStatus.SCHEDULED.value,
        index=True,
    )

    # Услуга из прайс-листа. Nullable: консультация / legacy без каталога.
    # RESTRICT: нельзя удалить услугу, пока на неё ссылаются визиты.
    service_id: Mapped[int | None] = mapped_column(
        ForeignKey("services.id", ondelete="RESTRICT"),
        nullable=True,
        index=True,
    )
    title: Mapped[str | None] = mapped_column(
        String(255),
        nullable=True,
        comment="Название услуги: 'Полировка кузова', 'Лечение кариеса'",
    )
    price: Mapped[Decimal | None] = mapped_column(Numeric(10, 2), nullable=True)
    notes: Mapped[str | None] = mapped_column(Text, nullable=True)

    # Нишевая специфика визита (для детейлинга — тип покрытия,
    # для стоматологии — номера зубов). Валидируется в schemas.py.
    extra_data: Mapped[dict[str, Any]] = mapped_column(
        JSONB,
        nullable=False,
        default=dict,
        server_default=text("'{}'::jsonb"),
    )
    # Поля, которые воркспейс добавил к объекту в UI (теги, владелец,
    # кастомные поля). Не путать с extra_data — его схему задаёт ниша.
    custom_fields: Mapped[dict[str, Any]] = mapped_column(
        JSONB,
        nullable=False,
        default=dict,
        server_default=text("'{}'::jsonb"),
    )

    company: Mapped["Company"] = relationship(back_populates="appointments")
    client: Mapped["Client"] = relationship(back_populates="appointments")
    master: Mapped["User"] = relationship(back_populates="appointments")
    service: Mapped["Service | None"] = relationship(back_populates="appointments")

    # Списания и возвраты материалов по этому визиту.
    # Движения не удаляются вместе с визитом (SET NULL в StockMovement),
    # иначе из истории склада пропал бы факт расхода.
    stock_movements: Mapped[list["StockMovement"]] = relationship(
        back_populates="appointment",
        passive_deletes=True,
    )
    transactions: Mapped[list["Transaction"]] = relationship(
        back_populates="appointment",
        passive_deletes=True,
    )

    @property
    def duration_minutes(self) -> int:
        """Длительность визита в минутах — удобно для UI и отчётов."""
        return int((self.ends_at - self.starts_at).total_seconds() // 60)

    def __repr__(self) -> str:
        return (
            f"<Appointment id={self.id} master={self.user_id} "
            f"{self.starts_at:%Y-%m-%d %H:%M}–{self.ends_at:%H:%M} {self.status.value}>"
        )


# --------------------------------------------------------------------------- #
#  Смены мастеров (график работы)
# --------------------------------------------------------------------------- #

class WorkShift(TenantMixin, TimestampMixin, Base):
    """
    Смена сотрудника: когда он вообще принимает клиентов.

    Пересечения записей закрывает Appointment, но без смены система не знает,
    работает ли мастер в 19:00. Визит должен целиком лежать внутри одной смены:
    shift.starts_at <= appointment.starts_at и appointment.ends_at <= shift.ends_at.

    Ночная смена (20:00–08:00 следующих суток) — одна строка: ends_at просто
    больше полуночи. Пересечения смен по-прежнему режет tstzrange, календарю
    фронт должен резать интервал на сегменты по локальным датам компании.
    """

    __tablename__ = "work_shifts"
    __table_args__ = (
        CheckConstraint("ends_at > starts_at", name="ck_work_shifts_time_order"),
        ExcludeConstraint(
            (literal_column("user_id"), "="),
            (literal_column("tstzrange(starts_at, ends_at, '[)')"), "&&"),
            name="excl_work_shifts_master_overlap",
            using="gist",
        ),
        Index("ix_work_shifts_user_starts", "user_id", "starts_at"),
        Index("ix_work_shifts_company_starts", "company_id", "starts_at"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    user_id: Mapped[int] = mapped_column(
        ForeignKey("users.id", ondelete="RESTRICT"),
        nullable=False,
        comment="Сотрудник, на чью смену записывают клиентов",
    )
    starts_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    ends_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    title: Mapped[str | None] = mapped_column(String(128), nullable=True)
    # Поля, которые воркспейс добавил к объекту в UI (теги, владелец,
    # кастомные поля). Не путать с extra_data — его схему задаёт ниша.
    custom_fields: Mapped[dict[str, Any]] = mapped_column(
        JSONB,
        nullable=False,
        default=dict,
        server_default=text("'{}'::jsonb"),
    )

    company: Mapped["Company"] = relationship(back_populates="work_shifts")
    master: Mapped["User"] = relationship(back_populates="work_shifts")

    def __repr__(self) -> str:
        return (
            f"<WorkShift id={self.id} user={self.user_id} "
            f"{self.starts_at:%Y-%m-%d %H:%M}–{self.ends_at:%H:%M}>"
        )


# --------------------------------------------------------------------------- #
#  Каталог услуг (прайс-лист)
# --------------------------------------------------------------------------- #

class Service(SoftDeleteMixin, TenantMixin, TimestampMixin, Base):
    """
    Позиция прайс-листа компании: что продаём, за сколько и как долго делаем.

    Услуги не удаляются физически: is_active=False снимает услугу с записи,
    deleted_at убирает её из прайс-листа. Прошлые визиты на неё ссылаются.
    """

    __tablename__ = "services"
    __table_args__ = (
        UniqueConstraint("company_id", "name", name="uq_services_company_name"),
        CheckConstraint("base_price >= 0", name="ck_services_price_non_negative"),
        CheckConstraint(
            "duration_minutes > 0 AND duration_minutes <= 1440",
            name="ck_services_duration_range",
        ),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    description: Mapped[str | None] = mapped_column(Text, nullable=True)

    base_price: Mapped[Decimal] = mapped_column(
        Numeric(10, 2),
        nullable=False,
        comment="Базовая цена; итоговая цена визита может отличаться",
    )
    duration_minutes: Mapped[int] = mapped_column(
        Integer,
        nullable=False,
        comment="Примерная длительность — подставляется при записи клиента",
    )
    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    # Поля, которые воркспейс добавил к объекту в UI (теги, владелец,
    # кастомные поля). Не путать с extra_data — его схему задаёт ниша.
    custom_fields: Mapped[dict[str, Any]] = mapped_column(
        JSONB,
        nullable=False,
        default=dict,
        server_default=text("'{}'::jsonb"),
    )

    company: Mapped["Company"] = relationship(back_populates="services")
    appointments: Mapped[list["Appointment"]] = relationship(
        back_populates="service",
        passive_deletes=True,
    )

    # Нормы расхода материалов ("рецепт" услуги).
    materials: Mapped[list["ServiceMaterial"]] = relationship(
        back_populates="service",
        cascade="all, delete-orphan",
        passive_deletes=True,
        order_by="ServiceMaterial.id",
    )

    @property
    def price(self) -> Decimal:
        """Алиас ТЗ/UI: цена услуги = base_price в каталоге."""
        return self.base_price

    def __repr__(self) -> str:
        return f"<Service id={self.id} name={self.name!r} price={self.base_price}>"


# --------------------------------------------------------------------------- #
#  Склад
# --------------------------------------------------------------------------- #

class InventoryItem(SoftDeleteMixin, TenantMixin, TimestampMixin, Base):
    """
    Складская позиция: химия, керамика, расходники.

    quantity — текущий остаток в единицах unit. Менять его напрямую не следует:
    любое изменение должно проходить через StockMovement (см. inventory.py),
    иначе остаток разойдётся с историей и разобраться в расхождении будет нельзя.
    """

    __tablename__ = "inventory_items"
    __table_args__ = (
        UniqueConstraint("company_id", "name", name="uq_inventory_items_company_name"),
        # Вторая линия обороны против "ушли в минус": даже если прикладная
        # проверка будет обойдена или проиграет гонку, БД не даст отрицательный
        # остаток (аналогично EXCLUDE-ограничению у записей на приём).
        CheckConstraint("quantity >= 0", name="ck_inventory_items_quantity_non_negative"),
        CheckConstraint(
            "low_stock_threshold IS NULL OR low_stock_threshold >= 0",
            name="ck_inventory_items_threshold_non_negative",
        ),
        Index("ix_inventory_items_company_name", "company_id", "name"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    sku: Mapped[str | None] = mapped_column(String(64), nullable=True, comment="Артикул")

    unit: Mapped[MeasurementUnit] = mapped_column(
        _pg_enum(MeasurementUnit, "measurement_unit_enum"),
        nullable=False,
    )
    # Numeric, а не Float: 0.1 мл в float — это 0.1000000000000000055,
    # и после сотни списаний остаток "поедет".
    quantity: Mapped[Decimal] = mapped_column(
        Numeric(12, 3),
        nullable=False,
        default=Decimal("0"),
        server_default=text("0"),
    )
    low_stock_threshold: Mapped[Decimal | None] = mapped_column(
        Numeric(12, 3),
        nullable=True,
        comment="Порог, ниже которого позиция считается заканчивающейся",
    )
    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    # Поля, которые воркспейс добавил к объекту в UI (теги, владелец,
    # кастомные поля). Не путать с extra_data — его схему задаёт ниша.
    custom_fields: Mapped[dict[str, Any]] = mapped_column(
        JSONB,
        nullable=False,
        default=dict,
        server_default=text("'{}'::jsonb"),
    )

    company: Mapped["Company"] = relationship(back_populates="inventory_items")
    movements: Mapped[list["StockMovement"]] = relationship(
        back_populates="item",
        cascade="all, delete-orphan",
        passive_deletes=True,
    )

    @property
    def is_low_stock(self) -> bool:
        """True, если остаток опустился до порога — повод пополнить запас."""
        if self.low_stock_threshold is None:
            return False
        return self.quantity <= self.low_stock_threshold

    def __repr__(self) -> str:
        return (
            f"<InventoryItem id={self.id} name={self.name!r} "
            f"{self.quantity} {self.unit.value}>"
        )


class StockMovement(TenantMixin, TimestampMixin, Base):
    """
    Движение по складу: приход, расход, корректировка.

    Таблица работает как журнал операций (append-only): остаток позиции —
    это сумма всех её delta. Благодаря журналу всегда видно, кто, когда
    и по какому визиту списал материал, а отмена завершённого визита может
    сделать обратную проводку.
    """

    __tablename__ = "stock_movements"
    __table_args__ = (
        CheckConstraint("delta <> 0", name="ck_stock_movements_delta_not_zero"),
        Index("ix_stock_movements_item_created", "inventory_item_id", "created_at"),
        Index("ix_stock_movements_company_created", "company_id", "created_at"),
        Index("ix_stock_movements_appointment", "appointment_id"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)

    inventory_item_id: Mapped[int] = mapped_column(
        ForeignKey("inventory_items.id", ondelete="CASCADE"),
        nullable=False,
    )
    # Отрицательная delta — расход, положительная — приход.
    delta: Mapped[Decimal] = mapped_column(Numeric(12, 3), nullable=False)
    reason: Mapped[StockMovementReason] = mapped_column(
        _pg_enum(StockMovementReason, "stock_movement_reason_enum"),
        nullable=False,
        index=True,
    )

    # Визит, из-за которого произошло движение (для списаний и возвратов).
    appointment_id: Mapped[int | None] = mapped_column(
        ForeignKey("appointments.id", ondelete="SET NULL"),
        nullable=True,
    )
    # Кто провёл операцию. SET NULL: историю склада нельзя терять
    # из-за удаления сотрудника.
    created_by_user_id: Mapped[int | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"),
        nullable=True,
    )
    note: Mapped[str | None] = mapped_column(String(500), nullable=True)

    company: Mapped["Company"] = relationship(back_populates="stock_movements")
    item: Mapped["InventoryItem"] = relationship(back_populates="movements")
    appointment: Mapped["Appointment | None"] = relationship(back_populates="stock_movements")

    def __repr__(self) -> str:
        return (
            f"<StockMovement id={self.id} item={self.inventory_item_id} "
            f"delta={self.delta} {self.reason.value}>"
        )


# --------------------------------------------------------------------------- #
#  Связь услуга <-> материалы (нормы расхода)
# --------------------------------------------------------------------------- #

class ServiceMaterial(TenantMixin, TimestampMixin, Base):
    """
    Сколько материала нужно на одно оказание услуги — "рецепт" услуги.

    Пример: "Керамика кузова" -> 50 мл керамики + 2 шт микрофибры.
    Количество указывается в единице измерения самой складской позиции.
    """

    __tablename__ = "service_materials"
    __table_args__ = (
        # Один материал не может входить в услугу дважды: иначе непонятно,
        # складывать нормы или заменять одну другой.
        UniqueConstraint(
            "service_id", "inventory_item_id", name="uq_service_materials_service_item"
        ),
        CheckConstraint("quantity > 0", name="ck_service_materials_quantity_positive"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)

    service_id: Mapped[int] = mapped_column(
        ForeignKey("services.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    # RESTRICT: пока материал входит в состав услуги, его нельзя просто удалить —
    # сначала нужно поправить рецепт, иначе услуга станет "нечем оказывать".
    inventory_item_id: Mapped[int] = mapped_column(
        ForeignKey("inventory_items.id", ondelete="RESTRICT"),
        nullable=False,
        index=True,
    )
    quantity: Mapped[Decimal] = mapped_column(
        Numeric(12, 3),
        nullable=False,
        comment="Норма расхода на одно оказание услуги, в единице измерения позиции",
    )

    company: Mapped["Company"] = relationship(back_populates="service_materials")
    service: Mapped["Service"] = relationship(back_populates="materials")
    item: Mapped["InventoryItem"] = relationship()

    @property
    def item_name(self) -> str | None:
        return self.item.name if self.item is not None else None

    @property
    def item_unit(self) -> MeasurementUnit | None:
        return self.item.unit if self.item is not None else None

    def __repr__(self) -> str:
        return (
            f"<ServiceMaterial service={self.service_id} "
            f"item={self.inventory_item_id} qty={self.quantity}>"
        )


# --------------------------------------------------------------------------- #
#  Касса (ядро финансов — одинаково для любой ниши)
# --------------------------------------------------------------------------- #

class Transaction(TenantMixin, TimestampMixin, Base):
    """
    Денежная операция. Единственный источник правды для баланса визита и LTV.

    Сумма всегда > 0, направление задаёт kind. В баланс входят только
    status=completed: pending не считает деньги «уже в кассе».

    appointment_id необязателен: предоплата без визита — тоже ядро
    (абонемент/депозит в нишевом контейнере повесится на extra_data).
    """

    __tablename__ = "transactions"
    __table_args__ = (
        CheckConstraint("amount > 0", name="ck_transactions_amount_positive"),
        Index("ix_transactions_company_client", "company_id", "client_id"),
        Index("ix_transactions_appointment", "appointment_id"),
        Index("ix_transactions_company_created", "company_id", "created_at"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    client_id: Mapped[int] = mapped_column(
        ForeignKey("clients.id", ondelete="RESTRICT"),
        nullable=False,
    )
    appointment_id: Mapped[int | None] = mapped_column(
        ForeignKey("appointments.id", ondelete="SET NULL"),
        nullable=True,
    )

    amount: Mapped[Decimal] = mapped_column(Numeric(12, 2), nullable=False)
    kind: Mapped[TransactionKind] = mapped_column(
        _pg_enum(TransactionKind, "transaction_kind_enum"),
        nullable=False,
    )
    status: Mapped[TransactionStatus] = mapped_column(
        _pg_enum(TransactionStatus, "transaction_status_enum"),
        nullable=False,
        default=TransactionStatus.COMPLETED,
        server_default=TransactionStatus.COMPLETED.value,
        index=True,
    )
    method: Mapped[PaymentMethod] = mapped_column(
        _pg_enum(PaymentMethod, "payment_method_enum"),
        nullable=False,
        default=PaymentMethod.CASH,
        server_default=PaymentMethod.CASH.value,
    )

    created_by_user_id: Mapped[int | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"),
        nullable=True,
    )
    comment: Mapped[str | None] = mapped_column(String(500), nullable=True)

    # Нишевая обёртка платежа (номер чека эквайринга, полис ДМС, …).
    extra_data: Mapped[dict[str, Any]] = mapped_column(
        JSONB,
        nullable=False,
        default=dict,
        server_default=text("'{}'::jsonb"),
    )

    company: Mapped["Company"] = relationship(back_populates="transactions")
    client: Mapped["Client"] = relationship(back_populates="transactions")
    appointment: Mapped["Appointment | None"] = relationship(back_populates="transactions")

    def __repr__(self) -> str:
        return (
            f"<Transaction id={self.id} {self.kind.value} {self.amount} "
            f"{self.status.value}>"
        )


# --------------------------------------------------------------------------- #
#  Заметки по клиенту (ядро CRM-профиля)
# --------------------------------------------------------------------------- #

class ClientNote(TenantMixin, TimestampMixin, Base):
    """
    Текстовая заметка администратора. Не путать с notes (Text) у Client
    и notes у визита: эта таблица — лента заметок по человеку.
    """

    __tablename__ = "client_notes"
    __table_args__ = (
        Index("ix_client_notes_client_created", "client_id", "created_at"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    client_id: Mapped[int] = mapped_column(
        ForeignKey("clients.id", ondelete="RESTRICT"),
        nullable=False,
    )
    author_user_id: Mapped[int | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"),
        nullable=True,
    )
    body: Mapped[str] = mapped_column(Text, nullable=False)
    is_pinned: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)

    company: Mapped["Company"] = relationship(back_populates="client_notes")
    client: Mapped["Client"] = relationship(back_populates="client_notes")

    def __repr__(self) -> str:
        return f"<ClientNote id={self.id} client_id={self.client_id}>"


# --------------------------------------------------------------------------- #
#  Outbox уведомлений
# --------------------------------------------------------------------------- #

class NotificationOutbox(TenantMixin, TimestampMixin, Base):
    """
    Исходящие уведомления. Пишется в той же транзакции, что и визит.

    HTTP-запрос на этом заканчивается: SMS/почту забирает отдельный воркер
    по status=pending. Если внешний сервис лежит, API это не замечает.
    """

    __tablename__ = "notification_outbox"
    __table_args__ = (
        Index("ix_notification_outbox_pending", "status", "created_at"),
        Index("ix_notification_outbox_company_created", "company_id", "created_at"),
        Index("ix_notification_outbox_appointment", "appointment_id"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    event_type: Mapped[NotificationEventType] = mapped_column(
        _str_enum(NotificationEventType, 64),
        nullable=False,
    )
    status: Mapped[OutboxStatus] = mapped_column(
        _pg_enum(OutboxStatus, "outbox_status_enum"),
        nullable=False,
        default=OutboxStatus.PENDING,
        server_default=OutboxStatus.PENDING.value,
    )
    recipient_kind: Mapped[NotificationRecipientKind] = mapped_column(
        _str_enum(NotificationRecipientKind, 16),
        nullable=False,
    )
    recipient_id: Mapped[int] = mapped_column(Integer, nullable=False)
    appointment_id: Mapped[int | None] = mapped_column(
        ForeignKey("appointments.id", ondelete="CASCADE"),
        nullable=True,
    )
    payload: Mapped[dict[str, Any]] = mapped_column(
        JSONB,
        nullable=False,
        default=dict,
        server_default=text("'{}'::jsonb"),
    )
    attempts: Mapped[int] = mapped_column(
        Integer, nullable=False, default=0, server_default="0"
    )
    processed_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True),
        nullable=True,
    )
    last_error: Mapped[str | None] = mapped_column(Text, nullable=True)
    # Повтор после временной ошибки доставки (экспоненциальная пауза воркера).
    retry_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    company: Mapped["Company"] = relationship(back_populates="notification_outbox")
    appointment: Mapped["Appointment | None"] = relationship()

    def __repr__(self) -> str:
        return (
            f"<NotificationOutbox id={self.id} {self.event_type.value} "
            f"{self.recipient_kind.value}={self.recipient_id} {self.status.value}>"
        )


# --------------------------------------------------------------------------- #
#  Журнал действий (append-only)
# --------------------------------------------------------------------------- #

class AuditLog(Base):
    """
    Кто что изменил. Строки не правят и не удаляют через API.

    Пишется слушателем SQLAlchemy в той же транзакции, что и само изменение.
    Нишевых колонок нет: сущность и diff в JSONB.
    """

    __tablename__ = "audit_logs"
    __table_args__ = (
        Index("ix_audit_logs_company_created", "company_id", "created_at"),
        Index("ix_audit_logs_entity", "company_id", "entity_type", "entity_id"),
        Index("ix_audit_logs_actor", "company_id", "actor_user_id"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    company_id: Mapped[int] = mapped_column(
        ForeignKey("companies.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    actor_user_id: Mapped[int | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"),
        nullable=True,
    )
    action: Mapped[AuditAction] = mapped_column(
        _pg_enum(AuditAction, "audit_action_enum"),
        nullable=False,
    )
    entity_type: Mapped[str] = mapped_column(String(64), nullable=False)
    entity_id: Mapped[int | None] = mapped_column(Integer, nullable=True)
    changes: Mapped[dict[str, Any]] = mapped_column(
        JSONB,
        nullable=False,
        default=dict,
        server_default=text("'{}'::jsonb"),
        comment="Для update: {поле: {old, new}}. create/delete — пусто",
    )
    snapshot: Mapped[dict[str, Any]] = mapped_column(
        JSONB,
        nullable=False,
        default=dict,
        server_default=text("'{}'::jsonb"),
        comment="Полный снимок после create или до delete",
    )
    request_ip: Mapped[str | None] = mapped_column(String(64), nullable=True)
    request_method: Mapped[str | None] = mapped_column(String(16), nullable=True)
    request_path: Mapped[str | None] = mapped_column(String(512), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
        nullable=False,
    )

    company: Mapped["Company"] = relationship(back_populates="audit_logs")
    actor: Mapped["User | None"] = relationship()

    def __repr__(self) -> str:
        return (
            f"<AuditLog {self.action.value} {self.entity_type}#{self.entity_id} "
            f"actor={self.actor_user_id}>"
        )


# --------------------------------------------------------------------------- #
#  Журнал аутентификации (login / refresh / logout / reject)
# --------------------------------------------------------------------------- #

class AuthLog(Base):
    """
    События входа и сессии: IP, User-Agent, статус.

    Отдельно от AuditLog (CRUD сущностей), чтобы не смешивать auth-шум
    с бизнес-изменениями.
    """

    __tablename__ = "auth_logs"
    __table_args__ = (
        Index("ix_auth_logs_created", "created_at"),
        Index("ix_auth_logs_user_created", "user_id", "created_at"),
        Index("ix_auth_logs_company_created", "company_id", "created_at"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    user_id: Mapped[int | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"),
        nullable=True,
        index=True,
    )
    company_id: Mapped[int | None] = mapped_column(
        ForeignKey("companies.id", ondelete="SET NULL"),
        nullable=True,
        index=True,
    )
    username: Mapped[str | None] = mapped_column(
        String(255),
        nullable=True,
        comment="Логин из формы (даже при неудачном входе)",
    )
    status: Mapped[AuthLogStatus] = mapped_column(
        _pg_enum(AuthLogStatus, "auth_log_status_enum"),
        nullable=False,
    )
    ip_address: Mapped[str | None] = mapped_column(String(64), nullable=True)
    user_agent: Mapped[str | None] = mapped_column(String(512), nullable=True)
    detail: Mapped[str | None] = mapped_column(String(255), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
        nullable=False,
    )

    user: Mapped["User | None"] = relationship()
    company: Mapped["Company | None"] = relationship()

    def __repr__(self) -> str:
        return f"<AuthLog {self.status.value} user={self.user_id} ip={self.ip_address}>"


# --------------------------------------------------------------------------- #
#  Сессии, одноразовые проверки, ключи доступа, внешние аккаунты
# --------------------------------------------------------------------------- #

class AuthSession(Base):
    """
    Серверная сессия. JWT несёт её id (sid): выход, «выйти на других
    устройствах», смена пароля и таймаут простоя отзывают сессию сразу,
    не дожидаясь истечения токена.
    """

    __tablename__ = "auth_sessions"
    __table_args__ = (Index("ix_auth_sessions_user_active", "user_id", "revoked_at"),)

    id: Mapped[str] = mapped_column(String(43), primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    company_id: Mapped[int] = mapped_column(ForeignKey("companies.id", ondelete="CASCADE"), nullable=False, index=True)
    method: Mapped[str] = mapped_column(String(32), nullable=False)
    mfa: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False, server_default="false")
    ip_address: Mapped[str | None] = mapped_column(String(64), nullable=True)
    user_agent: Mapped[str | None] = mapped_column(String(512), nullable=True)
    ua_fingerprint: Mapped[str | None] = mapped_column(String(32), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    last_seen_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    # Повторное подтверждение личности для чувствительных действий (step-up).
    reauth_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    revoke_reason: Mapped[str | None] = mapped_column(String(32), nullable=True)


class AuthChallenge(Base):
    """
    Одноразовая проверка: второй шаг входа, код на новый email/телефон,
    ссылка восстановления пароля, вход по ссылке, OAuth state, WebAuthn challenge.
    Секрет хранится только HMAC-хэшем; попытки ограничены.
    """

    __tablename__ = "auth_challenges"
    __table_args__ = (
        Index("ix_auth_challenges_token", "token_hash", unique=True),
        Index("ix_auth_challenges_user_purpose", "user_id", "purpose"),
        Index("ix_auth_challenges_expires", "expires_at"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    purpose: Mapped[str] = mapped_column(String(32), nullable=False)
    user_id: Mapped[int | None] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), nullable=True)
    company_id: Mapped[int | None] = mapped_column(ForeignKey("companies.id", ondelete="CASCADE"), nullable=True)
    # Хэш идентификатора проверки (токен ссылки / mfa_token / state).
    token_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    # Хэш кода, который пользователь вводит руками (SMS/email); может отсутствовать.
    code_hash: Mapped[str | None] = mapped_column(String(64), nullable=True)
    data: Mapped[dict[str, Any]] = mapped_column(JSONB, nullable=False, default=dict, server_default=text("'{}'::jsonb"))
    attempts: Mapped[int] = mapped_column(Integer, nullable=False, default=0, server_default="0")
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    consumed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)


class WebAuthnCredential(Base):
    """Ключ доступа (passkey): Touch ID, Windows Hello, аппаратный ключ."""

    __tablename__ = "webauthn_credentials"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    company_id: Mapped[int] = mapped_column(ForeignKey("companies.id", ondelete="CASCADE"), nullable=False)
    credential_id: Mapped[bytes] = mapped_column(LargeBinary, nullable=False, unique=True)
    public_key: Mapped[bytes] = mapped_column(LargeBinary, nullable=False)
    sign_count: Mapped[int] = mapped_column(BigInteger, nullable=False, default=0, server_default="0")
    transports: Mapped[list[str]] = mapped_column(JSONB, nullable=False, default=list, server_default=text("'[]'::jsonb"))
    name: Mapped[str] = mapped_column(String(100), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    last_used_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class UserIdentity(Base):
    """Привязанный внешний аккаунт (Google / Microsoft / Apple) — вход через OIDC."""

    __tablename__ = "user_identities"
    __table_args__ = (UniqueConstraint("provider", "subject", name="uq_user_identities_provider_subject"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    provider: Mapped[str] = mapped_column(String(16), nullable=False)
    subject: Mapped[str] = mapped_column(String(255), nullable=False)
    email: Mapped[str | None] = mapped_column(String(255), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)


class RateLimitCounter(Base):
    """Счётчик попыток в фиксированном окне (вход, коды, восстановление)."""

    __tablename__ = "rate_limit_counters"

    key: Mapped[str] = mapped_column(String(200), primary_key=True)
    window_start: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    count: Mapped[int] = mapped_column(Integer, nullable=False)


# --------------------------------------------------------------------------- #
#  Вложения (файлы и медиа)
# --------------------------------------------------------------------------- #

class Attachment(TenantMixin, TimestampMixin, Base):
    """
    Универсальный файл: фото до/после, рентген, PDF-акт.

    Ниша не создаёт свою таблицу — прикрепляет id вложения к extra_data
    сущности. Байты лежат в storage (диск / S3 / MinIO), здесь метаданные.
    """

    __tablename__ = "attachments"
    __table_args__ = (
        Index(
            "ix_attachments_entity",
            "company_id",
            "entity_type",
            "entity_id",
        ),
        CheckConstraint("size_bytes >= 0", name="ck_attachments_size_non_negative"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    entity_type: Mapped[AttachmentEntityType] = mapped_column(
        _pg_enum(AttachmentEntityType, "attachment_entity_type_enum"),
        nullable=False,
    )
    entity_id: Mapped[int] = mapped_column(Integer, nullable=False)
    storage_key: Mapped[str] = mapped_column(
        String(512),
        nullable=False,
        unique=True,
        comment="Ключ объекта в хранилище; для удаления байт",
    )
    file_url: Mapped[str] = mapped_column(
        String(1024),
        nullable=False,
        comment="URL для скачивания через ядро (с авторизацией)",
    )
    mime_type: Mapped[str] = mapped_column(String(128), nullable=False)
    size_bytes: Mapped[int] = mapped_column(Integer, nullable=False)
    original_filename: Mapped[str | None] = mapped_column(String(255), nullable=True)
    created_by_user_id: Mapped[int | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"),
        nullable=True,
    )

    company: Mapped["Company"] = relationship(back_populates="attachments")

    def __repr__(self) -> str:
        return (
            f"<Attachment id={self.id} {self.entity_type.value}#{self.entity_id} "
            f"{self.mime_type}>"
        )


# --------------------------------------------------------------------------- #
#  Интеграции: API-ключи и вебхуки
# --------------------------------------------------------------------------- #

class ApiKey(TenantMixin, Base):
    """
    Ключ внешней интеграции (Tilda, коннектор мессенджера).

    Сырой токен `lmk_…` показывается один раз при создании. В БД — bcrypt-хэш
    и короткий prefix для UI / lookup. Права ключа уже ядра, не JWT.
    """

    __tablename__ = "api_keys"
    __table_args__ = (
        Index("ix_api_keys_company_active", "company_id", "is_active"),
        UniqueConstraint("prefix", name="uq_api_keys_prefix"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    name: Mapped[str] = mapped_column(
        String(128),
        nullable=False,
        comment='Имя в UI: "Tilda Integration"',
    )
    key_hash: Mapped[str] = mapped_column(
        String(255),
        nullable=False,
        comment="bcrypt от сырого токена; сам токен не храним",
    )
    prefix: Mapped[str] = mapped_column(
        String(16),
        nullable=False,
        comment="Первые 8 символов токена (lmk_xxxx) для UI и поиска",
    )
    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    expires_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True),
        nullable=True,
    )
    last_used_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True),
        nullable=True,
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
        nullable=False,
    )
    created_by_user_id: Mapped[int | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"),
        nullable=True,
    )

    company: Mapped["Company"] = relationship(back_populates="api_keys")

    def __repr__(self) -> str:
        return f"<ApiKey id={self.id} prefix={self.prefix!r} active={self.is_active}>"


class Webhook(TenantMixin, TimestampMixin, Base):
    """
    Исходящий webhook тенанта. Ядро кладёт событие в outbox; HTTP дергает воркер.

    secret — HMAC для подписи тела (заголовок X-Lemko-Signature).
    events — список WebhookEvent.value (appointment.created, …).
    """

    __tablename__ = "webhooks"
    __table_args__ = (
        Index("ix_webhooks_company_active", "company_id", "is_active"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    url: Mapped[str] = mapped_column(String(1024), nullable=False)
    events: Mapped[list[Any]] = mapped_column(
        JSONB,
        nullable=False,
        default=list,
        server_default=text("'[]'::jsonb"),
        comment='Подписка: ["appointment.created", "client.updated"]',
    )
    secret: Mapped[str] = mapped_column(
        String(128),
        nullable=False,
        comment="Секрет HMAC; клиент сверяет подпись payload",
    )
    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    description: Mapped[str | None] = mapped_column(String(255), nullable=True)

    company: Mapped["Company"] = relationship(back_populates="webhooks")

    def __repr__(self) -> str:
        return f"<Webhook id={self.id} url={self.url!r} active={self.is_active}>"


# --------------------------------------------------------------------------- #
#  Схема-ориентированная CRM: настройки воркспейса и объекты UI
# --------------------------------------------------------------------------- #

class WorkspaceSettings(TimestampMixin, Base):
    """
    Конфигурация воркспейса, которую редактируют в UI (одна строка на компанию).

    config — включённые модули, кастомные объекты и поля, переименования,
    навигация, установленные пакеты. schema — разрешённые определения объектов
    (модули + правки), которые синхронизирует фронт: по ним сервер подписывает
    события ленты, считает виджеты и выполняет автоматизации.
    """

    __tablename__ = "workspace_settings"

    company_id: Mapped[int] = mapped_column(
        ForeignKey("companies.id", ondelete="CASCADE"),
        primary_key=True,
    )
    config: Mapped[dict[str, Any]] = mapped_column(
        JSONB, nullable=False, default=dict, server_default=text("'{}'::jsonb")
    )
    schema: Mapped[list[Any]] = mapped_column(
        JSONB, nullable=False, default=list, server_default=text("'[]'::jsonb")
    )

    company: Mapped["Company"] = relationship(back_populates="workspace")


class CrmRecord(SoftDeleteMixin, TenantMixin, TimestampMixin, Base):
    """
    Запись объекта, у которого нет своей таблицы: сделки, компании, задачи,
    счета, проекты, тикеты, объекты недвижимости и любые кастомные объекты.

    Поля — в data (ключи = FieldDef.key из схемы воркспейса). Клиенты, услуги,
    склад, визиты и смены живут в своих таблицах (см. records.py).
    """

    __tablename__ = "crm_records"
    __table_args__ = (
        Index("ix_crm_records_company_entity", "company_id", "entity", "deleted_at"),
        Index("ix_crm_records_data", "data", postgresql_using="gin"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    entity: Mapped[str] = mapped_column(String(64), nullable=False)
    data: Mapped[dict[str, Any]] = mapped_column(
        JSONB, nullable=False, default=dict, server_default=text("'{}'::jsonb")
    )
    created_by_user_id: Mapped[int | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    # Когда запись попала в закрытую стадию (won/lost/done…): длина цикла сделки.
    closed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class Activity(TenantMixin, Base):
    """
    Лента событий: изменения записей, заметки, звонки, письма, уведомления.

    recipient_user_id пуст — событие видно всей команде; задан — личное
    уведомление (назначили ответственным, упомянули, напоминание о задаче).
    """

    __tablename__ = "activities"
    __table_args__ = (
        Index("ix_activities_company_created", "company_id", "created_at"),
        Index("ix_activities_record", "company_id", "entity", "record_id"),
        Index("ix_activities_recipient", "recipient_user_id", "created_at"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    entity: Mapped[str] = mapped_column(String(64), nullable=False)
    record_id: Mapped[str] = mapped_column(String(64), nullable=False)
    kind: Mapped[str] = mapped_column(String(32), nullable=False)
    title: Mapped[str] = mapped_column(String(500), nullable=False)
    body: Mapped[str | None] = mapped_column(Text, nullable=True)
    actor_user_id: Mapped[int | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    recipient_user_id: Mapped[int | None] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), nullable=True
    )
    meta: Mapped[dict[str, Any]] = mapped_column(
        JSONB, nullable=False, default=dict, server_default=text("'{}'::jsonb")
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )


class ActivityRead(Base):
    """
    Прочитанные события сотрудника. «Прочитать всё» не пишет строку на каждое
    событие: двигает preferences.inboxReadAt, а эта таблица хранит только
    точечные отметки новее этой границы.
    """

    __tablename__ = "activity_reads"

    activity_id: Mapped[int] = mapped_column(
        ForeignKey("activities.id", ondelete="CASCADE"), primary_key=True
    )
    user_id: Mapped[int] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), primary_key=True
    )


class SavedView(TenantMixin, TimestampMixin, Base):
    """Сохранённое представление объекта: таблица, канбан, галерея, список, календарь."""

    __tablename__ = "saved_views"
    __table_args__ = (Index("ix_saved_views_company_entity", "company_id", "entity"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    entity: Mapped[str] = mapped_column(String(64), nullable=False)
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    type: Mapped[str] = mapped_column(String(16), nullable=False)
    # columns, widths, filters, sort, groupBy, rowHeight.
    config: Mapped[dict[str, Any]] = mapped_column(
        JSONB, nullable=False, default=dict, server_default=text("'{}'::jsonb")
    )
    # NULL — общее представление команды, иначе личное.
    owner_user_id: Mapped[int | None] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), nullable=True
    )
    position: Mapped[int] = mapped_column(Integer, nullable=False, default=0, server_default="0")


class Dashboard(TenantMixin, TimestampMixin, Base):
    """Дашборд воркспейса: упорядоченный список виджетов с размером и настройками."""

    __tablename__ = "dashboards"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    icon: Mapped[str] = mapped_column(String(64), nullable=False, default="dashboard")
    widgets: Mapped[list[Any]] = mapped_column(
        JSONB, nullable=False, default=list, server_default=text("'[]'::jsonb")
    )
    position: Mapped[int] = mapped_column(Integer, nullable=False, default=0, server_default="0")


class Report(TenantMixin, TimestampMixin, Base):
    """Сохранённый отчёт: объект, группировка, мера и визуализация."""

    __tablename__ = "reports"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    entity: Mapped[str] = mapped_column(String(64), nullable=False)
    group_by: Mapped[str] = mapped_column(String(64), nullable=False)
    metric: Mapped[str] = mapped_column(String(8), nullable=False, default="count")
    metric_field: Mapped[str | None] = mapped_column(String(64), nullable=True)
    chart: Mapped[str] = mapped_column(String(8), nullable=False, default="bar")
    position: Mapped[int] = mapped_column(Integer, nullable=False, default=0, server_default="0")


class IntegrationConnection(TenantMixin, TimestampMixin, Base):
    """Подключённое приложение из магазина интеграций (Gmail, Slack, Stripe…)."""

    __tablename__ = "integration_connections"
    __table_args__ = (
        UniqueConstraint("company_id", "app", name="uq_integration_connections_app"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    app: Mapped[str] = mapped_column(String(64), nullable=False)
    account: Mapped[str] = mapped_column(String(255), nullable=False)
    status: Mapped[str] = mapped_column(String(16), nullable=False, default="connected")
    settings: Mapped[dict[str, Any]] = mapped_column(
        JSONB, nullable=False, default=dict, server_default=text("'{}'::jsonb")
    )
    connected_by_user_id: Mapped[int | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    last_synced_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


# Слушатели журнала вешаются при импорте моделей — любая Session пишет лог,
# не только FastAPI-запрос.
import audit as _audit  # noqa: E402, F401
