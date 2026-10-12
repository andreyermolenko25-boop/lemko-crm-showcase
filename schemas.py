"""
Pydantic-схемы (v2): контракт API, отделённый от моделей БД.

Ключевая идея валидации extra_data:
клиент API присылает произвольный JSON-объект, а сервер сам определяет нишу
по company_id и прогоняет данные через нужную схему из реестра EXTRA_DATA_SCHEMAS.
Чтобы подключить новую нишу, достаточно:
  1) добавить значение в models.Niche;
  2) описать здесь класс *ExtraData;
  3) зарегистрировать его в EXTRA_DATA_SCHEMAS.
Никаких if/elif по коду проекта.
"""

from __future__ import annotations

import re
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal
from typing import Annotated, Any
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

try:
    import tzdata  # noqa: F401  — таблица IANA; на Windows без неё ZoneInfo пустой
except ImportError:
    pass

from pydantic import BaseModel, ConfigDict, EmailStr, Field, field_validator, model_validator
from pydantic.alias_generators import to_camel

from models import (
    AppointmentPaymentStatus,
    AppointmentStatus,
    AttachmentEntityType,
    AuditAction,
    MeasurementUnit,
    Niche,
    PaymentMethod,
    StockMovementReason,
    SubscriptionStatus,
    TransactionKind,
    TransactionStatus,
    UserRole,
    WebhookEvent,
)
from core.security import BCRYPT_MAX_BYTES

# Телефон приводим к единому виду: только цифры и ведущий "+".
PHONE_RE = re.compile(r"^\+?\d{7,15}$")


class ORMModel(BaseModel):
    """Базовый класс для схем ответа: разрешает читать данные из ORM-объектов."""

    model_config = ConfigDict(from_attributes=True)


# --------------------------------------------------------------------------- #
#  extra_data: схемы под конкретные ниши
# --------------------------------------------------------------------------- #

class StrictExtraData(BaseModel):
    """
    База для нишевых схем.

    extra="forbid" — намеренно строго: опечатка в имени поля ("plate_numbr")
    вернёт 422, а не тихо запишется в JSONB мусором.
    """

    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)


class DetailingExtraData(StrictExtraData):
    """Специфика детейлинга: данные автомобиля клиента."""

    car_brand: str | None = Field(default=None, max_length=64, description="Марка авто")
    car_model: str | None = Field(default=None, max_length=64, description="Модель авто")
    car_year: int | None = Field(default=None, ge=1950, le=2100, description="Год выпуска")
    plate_number: str | None = Field(default=None, max_length=16, description="Госномер")
    vin: str | None = Field(default=None, min_length=17, max_length=17, description="VIN")
    color: str | None = Field(default=None, max_length=32)
    notes: str | None = Field(default=None, max_length=2000)

    @field_validator("plate_number", "vin")
    @classmethod
    def _upper(cls, value: str | None) -> str | None:
        """Госномер и VIN храним в верхнем регистре — иначе поиск не совпадёт."""
        return value.upper().replace(" ", "") if value else value


class DentistryExtraData(StrictExtraData):
    """Специфика стоматологии: медицинская карта клиента."""

    medical_card_no: str | None = Field(default=None, max_length=32, description="Номер медкарты")
    birth_date: date | None = Field(default=None, description="Дата рождения")
    allergies: list[str] = Field(default_factory=list, description="Аллергии")
    chronic_diseases: list[str] = Field(default_factory=list, description="Хронические заболевания")
    blood_type: str | None = Field(default=None, max_length=8)
    # Карта зубов: {"36": "пломба", "37": "удалён"}
    teeth_map: dict[str, str] = Field(default_factory=dict)
    notes: str | None = Field(default=None, max_length=2000)

    @field_validator("birth_date")
    @classmethod
    def _not_in_future(cls, value: date | None) -> date | None:
        if value and value > date.today():
            raise ValueError("Дата рождения не может быть в будущем")
        return value


class OtherExtraData(BaseModel):
    """Универсальная ниша: произвольный JSON без строгой схемы."""

    model_config = ConfigDict(extra="allow")


class DetailingAppointmentExtra(StrictExtraData):
    """Специфика визита в детейлинге."""

    service_type: str | None = Field(default=None, max_length=64, description="Тип работ")
    coating: str | None = Field(default=None, max_length=64, description="Состав/покрытие")
    body_zones: list[str] = Field(default_factory=list, description="Зоны кузова")
    mileage: int | None = Field(default=None, ge=0, le=2_000_000, description="Пробег, км")


class DentistryAppointmentExtra(StrictExtraData):
    """Специфика визита в стоматологии."""

    procedure: str | None = Field(default=None, max_length=128, description="Процедура")
    teeth: list[str] = Field(default_factory=list, description="Номера зубов, напр. ['36','37']")
    anesthesia: bool | None = Field(default=None, description="Требуется анестезия")
    x_ray_required: bool | None = None


# Реестры "ниша -> схема extra_data". Единственные точки расширения:
# добавил нишу в models.Niche -> описал схему -> зарегистрировал здесь.
CLIENT_EXTRA_SCHEMAS: dict[Niche, type[BaseModel]] = {
    Niche.DETAILING: DetailingExtraData,
    Niche.DENTISTRY: DentistryExtraData,
    Niche.OTHER: OtherExtraData,
}

APPOINTMENT_EXTRA_SCHEMAS: dict[Niche, type[BaseModel]] = {
    Niche.DETAILING: DetailingAppointmentExtra,
    Niche.DENTISTRY: DentistryAppointmentExtra,
    Niche.OTHER: OtherExtraData,
}

# Заявка из директа/формы: те же нишевые поля, что у карточки клиента.
# Контейнер ниши может подменить реестр, ядро не знает про «капот» или «кариес».
LEAD_EXTRA_SCHEMAS: dict[Niche, type[BaseModel]] = CLIENT_EXTRA_SCHEMAS


def validate_extra_data(
    niche: Niche,
    raw: dict[str, Any] | None,
    registry: dict[Niche, type[BaseModel]] | None = None,
) -> dict[str, Any]:
    """
    Проверяет extra_data по схеме соответствующей ниши и возвращает
    нормализованный dict, готовый к записи в JSONB.

    registry позволяет использовать разные наборы схем для разных сущностей:
    по умолчанию — карточка клиента, для визитов передаём APPOINTMENT_EXTRA_SCHEMAS.

    Бросает pydantic.ValidationError — на уровне FastAPI её удобно
    превратить в 422 (см. main.py).
    """
    schemas_by_niche = registry if registry is not None else CLIENT_EXTRA_SCHEMAS
    schema = schemas_by_niche.get(niche, OtherExtraData)
    model = schema.model_validate(raw or {})
    # mode="json" нужен, чтобы date/Decimal стали JSON-совместимыми типами.
    # exclude_none убирает незаполненные поля, не раздувая JSONB.
    return model.model_dump(mode="json", exclude_none=True)


def validate_iana_timezone(value: str) -> str:
    """
    Принимает только IANA-имена (Europe/Berlin, Asia/Tokyo).
    Именно их понимает PostgreSQL в AT TIME ZONE.
    """
    try:
        ZoneInfo(value)
    except ZoneInfoNotFoundError as exc:
        raise ValueError(
            f"Неизвестный часовой пояс «{value}». Используй IANA, например Europe/Berlin"
        ) from exc
    return value


class IntakeSettings(BaseModel):
    """
    Настройки приёма заявок для конкретной компании.

    Коннектор шлёт сырой webhook в raw_payload; field_map раскладывает ключи
    в поля ядра. Нишевые поля — extra_data, схема в LEAD_EXTRA_SCHEMAS.
    """

    model_config = ConfigDict(extra="forbid")

    auto_create_client: bool = True
    auto_create_appointment: bool = False
    merge_by_phone: bool = True
    merge_by_handle: bool = True
    default_master_user_id: int | None = Field(default=None, ge=1)
    notify_user_id: int | None = Field(default=None, ge=1)
    default_title: str | None = Field(default=None, max_length=255)
    field_map: dict[str, str] = Field(
        default_factory=dict,
        description=(
            "Ключ из raw_payload → поле ядра: name, phone, handle, message_text "
            "или extra_data.<поле ниши>. Пример: {'tel': 'phone', 'auto': 'extra_data.car_brand'}"
        ),
    )


# --------------------------------------------------------------------------- #
#  Company
# --------------------------------------------------------------------------- #

class CompanyBase(BaseModel):
    name: Annotated[str, Field(min_length=2, max_length=255)]
    niche: Niche = Niche.OTHER
    timezone: Annotated[str, Field(max_length=64)] = "UTC"

    @field_validator("timezone")
    @classmethod
    def _tz(cls, value: str) -> str:
        return validate_iana_timezone(value)


class CompanyCreate(CompanyBase):
    """
    Регистрация нового тенанта.

    Вместе с компанией обязательно создаётся её владелец: иначе получилась бы
    компания, в которую невозможно войти (некому выдать первый токен).
    """

    settings: dict[str, Any] = Field(default_factory=dict)
    intake_settings: dict[str, Any] = Field(default_factory=dict)
    owner: "UserCreate"

    @field_validator("intake_settings")
    @classmethod
    def _intake(cls, value: dict[str, Any]) -> dict[str, Any]:
        return IntakeSettings.model_validate(value).model_dump(mode="json")


class CompanyUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=2, max_length=255)
    settings: dict[str, Any] | None = None
    intake_settings: dict[str, Any] | None = None
    timezone: str | None = Field(default=None, max_length=64)
    is_active: bool | None = None

    @field_validator("timezone")
    @classmethod
    def _tz(cls, value: str | None) -> str | None:
        return validate_iana_timezone(value) if value is not None else None

    @field_validator("intake_settings")
    @classmethod
    def _intake(cls, value: dict[str, Any] | None) -> dict[str, Any] | None:
        if value is None:
            return None
        return IntakeSettings.model_validate(value).model_dump(mode="json")


class CompanyRead(ORMModel, CompanyBase):
    id: int
    settings: dict[str, Any]
    intake_settings: dict[str, Any]
    is_active: bool
    subscription_status: SubscriptionStatus
    trial_ends_at: datetime | None
    created_at: datetime


# --------------------------------------------------------------------------- #
#  User
# --------------------------------------------------------------------------- #

class UserBase(BaseModel):
    username: Annotated[str, Field(min_length=3, max_length=150)]
    role: UserRole = UserRole.MANAGER


class UserCreate(UserBase):
    # Пароль принимаем на входе, но никогда не возвращаем в ответах.
    password: Annotated[str, Field(min_length=8, max_length=256)]

    @field_validator("password")
    @classmethod
    def _check_password_bytes(cls, value: str) -> str:
        """
        bcrypt учитывает только первые 72 БАЙТА пароля, а кириллица в UTF-8
        занимает 2 байта на символ. Проверяем именно байты, иначе длинный
        русский пароль молча обрезался бы.
        """
        if len(value.encode("utf-8")) > BCRYPT_MAX_BYTES:
            raise ValueError(
                f"Пароль не должен превышать {BCRYPT_MAX_BYTES} байт "
                f"(кириллица — 2 байта на символ)"
            )
        return value


class UserRead(ORMModel, UserBase):
    id: int
    company_id: int
    is_active: bool
    deleted_at: datetime | None = None
    created_at: datetime


class UserUpdate(BaseModel):
    """Смена роли и блокировка. Пароль здесь не меняем."""

    role: UserRole | None = None
    is_active: bool | None = None


# CompanyCreate ссылается на UserCreate до его объявления — дособираем модель.
CompanyCreate.model_rebuild()


class CompanyRegisterResult(BaseModel):
    """Результат регистрации: сама компания и её владелец."""

    company: CompanyRead
    owner: UserRead


# --------------------------------------------------------------------------- #
#  Авторизация
# --------------------------------------------------------------------------- #

class LoginRequest(BaseModel):
    """
    Вход по email/логину.

    company_id опционален: для SaaS-владельцев email уникален глобально,
    тенант определяется по username. Для старых сотрудников с общим логином
    «admin» внутри клиники — передай company_id явно.
    """

    model_config = ConfigDict(str_strip_whitespace=True)

    username: Annotated[str, Field(min_length=3, max_length=150)]
    password: Annotated[str, Field(min_length=1, max_length=256)]
    company_id: Annotated[int, Field(ge=1)] | None = None


class RegisterRequest(BaseModel):
    """Публичная регистрация нового тенанта (студии) и её владельца."""

    model_config = ConfigDict(str_strip_whitespace=True)

    email: EmailStr
    password: Annotated[str, Field(min_length=8, max_length=256)]
    company_name: Annotated[str, Field(min_length=2, max_length=255)]

    @field_validator("email")
    @classmethod
    def _normalize_email(cls, value: EmailStr) -> str:
        return str(value).strip().lower()

    @field_validator("password")
    @classmethod
    def _password_bytes(cls, value: str) -> str:
        if len(value.encode("utf-8")) > BCRYPT_MAX_BYTES:
            raise ValueError(
                f"Пароль не должен превышать {BCRYPT_MAX_BYTES} байт "
                f"(кириллица — 2 байта на символ)"
            )
        return value


class RegisterResponse(BaseModel):
    """Ответ регистрации: студия + владелец (без токена — вход отдельно)."""

    company: CompanyRead
    owner: UserRead


class TokenResponse(BaseModel):
    """Ответ на успешный вход (формат, привычный для OAuth2-клиентов)."""

    access_token: str
    token_type: str = "bearer"
    expires_in: int = Field(description="Время жизни токена в секундах")


class LoginResponse(BaseModel):
    """
    Вход: либо токен сессии, либо второй шаг (mfa_required + mfa_token).
    BFF кладёт и токен, и mfa_token в httpOnly-куки — JS их не видит.
    """

    access_token: str | None = None
    token_type: str = "bearer"
    expires_in: int | None = None
    mfa_required: bool = False
    mfa_token: str | None = None
    mfa_methods: list[str] = Field(default_factory=list)


class MfaTokenRequest(BaseModel):
    mfa_token: Annotated[str, Field(min_length=10, max_length=200)]


class MfaVerifyRequest(MfaTokenRequest):
    method: Annotated[str, Field(pattern="^(totp|sms|backup|passkey)$")]
    code: Annotated[str, Field(max_length=32)] | None = None
    credential: dict[str, Any] | None = None


class EmailOnlyRequest(BaseModel):
    email: EmailStr

    @field_validator("email")
    @classmethod
    def _normalize_email(cls, value: EmailStr) -> str:
        return str(value).strip().lower()


class LinkTokenRequest(BaseModel):
    token: Annotated[str, Field(min_length=10, max_length=200)]


class PasswordResetRequest(LinkTokenRequest):
    new_password: Annotated[str, Field(min_length=1, max_length=256)]


class OAuthStartOut(BaseModel):
    url: str
    state: str


class OAuthCallbackRequest(BaseModel):
    code: Annotated[str, Field(min_length=1, max_length=4096)]
    state: Annotated[str, Field(min_length=10, max_length=200)]


class OAuthCallbackOut(LoginResponse):
    linked: bool = False
    provider: str | None = None


class MeRead(UserRead):
    """Профиль текущей сессии + требования политики безопасности."""

    email: str | None = None
    mfa_enabled: bool = False
    mfa_enrollment_required: bool = False


# --------------------------------------------------------------------------- #
#  Settings → Security
# --------------------------------------------------------------------------- #

class PasskeyOut(BaseModel):
    id: int
    name: str
    added_at: datetime
    last_used_at: datetime | None = None


class SecurityOverview(BaseModel):
    email: str | None
    email_verified: bool
    phone: str | None
    phone_verified: bool
    has_password: bool
    password_changed_at: datetime | None
    totp: bool
    sms: bool
    sms_available: bool
    passkeys: list[PasskeyOut]
    backup_codes_left: int
    social: dict[str, bool]
    providers: dict[str, bool]
    reauth_required: bool


class SessionOut(BaseModel):
    id: str
    device: str
    ip: str | None
    method: str
    created_at: datetime
    last_seen_at: datetime
    current: bool


class LoginHistoryItem(BaseModel):
    at: datetime
    event: str
    method: str
    status: str
    ip: str | None
    device: str


class ReauthRequest(BaseModel):
    password: Annotated[str, Field(max_length=256)] | None = None
    code: Annotated[str, Field(max_length=32)] | None = None


class PasswordChangeRequest(BaseModel):
    current_password: Annotated[str, Field(max_length=256)] | None = None
    new_password: Annotated[str, Field(min_length=1, max_length=256)]
    sign_out_others: bool = True


class CodeRequest(BaseModel):
    code: Annotated[str, Field(min_length=4, max_length=32)]


class PhoneStartRequest(BaseModel):
    phone: Annotated[str, Field(min_length=7, max_length=20)]

    @field_validator("phone")
    @classmethod
    def _phone(cls, value: str) -> str:
        cleaned = re.sub(r"[\s()\-]", "", value)
        if not re.fullmatch(r"\+[1-9]\d{6,14}", cleaned):
            raise ValueError("Телефон в международном формате: +48500600700")
        return cleaned


class ToggleRequest(BaseModel):
    enabled: bool


class TotpSetupOut(BaseModel):
    secret: str
    otpauth_uri: str
    qr: str


class BackupCodesOut(BaseModel):
    codes: list[str]


class PasskeyCreateRequest(BaseModel):
    name: Annotated[str, Field(max_length=100)] = "Passkey"
    credential: dict[str, Any]


class SecurityPolicyOut(BaseModel):
    require2fa: bool
    methods: dict[str, bool]
    timeout: str
    minLength: str
    newDeviceAlert: bool
    ipAllowlist: str
    can_edit: bool = False


class SecurityPolicyPatch(BaseModel):
    require2fa: bool | None = None
    methods: dict[str, bool] | None = None
    timeout: str | None = None
    minLength: str | int | None = None
    newDeviceAlert: bool | None = None
    ipAllowlist: Annotated[str, Field(max_length=8000)] | None = None


# --------------------------------------------------------------------------- #
#  Client
# --------------------------------------------------------------------------- #

def normalize_phone(value: str) -> str:
    """Чистит телефон от пробелов, скобок и дефисов и проверяет формат."""
    cleaned = re.sub(r"[\s()\-]", "", value)
    if not PHONE_RE.match(cleaned):
        raise ValueError("Телефон должен содержать 7–15 цифр, допустим ведущий '+'")
    return cleaned


class ClientBase(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True)

    name: Annotated[str, Field(min_length=1, max_length=255)]
    phone: Annotated[str, Field(min_length=7, max_length=32)]
    email: EmailStr | None = None
    notes: str | None = None

    @field_validator("phone")
    @classmethod
    def _check_phone(cls, value: str) -> str:
        return normalize_phone(value)


class ClientCreate(ClientBase):
    """
    Схема создания клиента.

    company_id здесь СОЗНАТЕЛЬНО отсутствует: тенант определяется сервером
    (из токена сотрудника), иначе клиент API смог бы записать данные
    в чужую компанию.

    extra_data остаётся "сырым" dict — его валидирует validate_extra_data()
    уже после того, как известна ниша компании.
    """

    extra_data: dict[str, Any] = Field(default_factory=dict)


class ClientUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=255)
    phone: str | None = Field(default=None, min_length=7, max_length=32)
    email: EmailStr | None = None
    notes: str | None = None
    extra_data: dict[str, Any] | None = None
    is_active: bool | None = None

    @field_validator("phone")
    @classmethod
    def _check_phone(cls, value: str | None) -> str | None:
        return normalize_phone(value) if value is not None else None


class ClientRead(ORMModel, ClientBase):
    # Контакт из почты, формы или импорта может быть без телефона.
    phone: str | None = None
    id: int
    company_id: int

    @field_validator("phone")
    @classmethod
    def _check_phone(cls, value: str | None) -> str | None:
        return value
    extra_data: dict[str, Any]
    is_active: bool
    deleted_at: datetime | None = None
    created_at: datetime


class PaginatedClients(BaseModel):
    """Страница списка клиентов: total нужен фронту для виртуального скролла."""

    total: int = Field(ge=0)
    items: list[ClientRead]


# --------------------------------------------------------------------------- #
#  Appointment (записи на приём)
# --------------------------------------------------------------------------- #

# Разумные границы длительности визита: страхуют от опечатки в дате,
# из-за которой запись заняла бы у мастера полгода.
MIN_APPOINTMENT_DURATION = timedelta(minutes=5)
MAX_APPOINTMENT_DURATION = timedelta(hours=12)


def require_aware_utc(value: datetime) -> datetime:
    """
    Требует datetime с часовым поясом и приводит его к UTC.

    Наивное время отклоняем осознанно: "10:00" без пояса от клиента из другого
    города превратилось бы в чужие 10:00 UTC, и запись молча уехала бы
    на пару часов. Лучше явная ошибка, чем тихо перепутанное расписание.
    """
    if value.tzinfo is None or value.utcoffset() is None:
        raise ValueError(
            "Укажи часовой пояс, например 2026-09-16T10:00:00+02:00 или ...Z"
        )
    return value.astimezone(timezone.utc)


def validate_interval(starts_at: datetime, ends_at: datetime) -> None:
    """Общая проверка интервала для создания и переноса записи."""
    if ends_at <= starts_at:
        raise ValueError("Время окончания должно быть позже времени начала")
    duration = ends_at - starts_at
    if duration < MIN_APPOINTMENT_DURATION:
        raise ValueError(
            f"Визит короче {int(MIN_APPOINTMENT_DURATION.total_seconds() // 60)} минут"
        )
    if duration > MAX_APPOINTMENT_DURATION:
        raise ValueError(
            f"Визит длиннее {int(MAX_APPOINTMENT_DURATION.total_seconds() // 3600)} часов"
        )


MIN_SHIFT_DURATION = timedelta(minutes=30)
MAX_SHIFT_DURATION = timedelta(hours=24)


def validate_shift_interval(starts_at: datetime, ends_at: datetime) -> None:
    if ends_at <= starts_at:
        raise ValueError("Смена должна заканчиваться позже начала")
    duration = ends_at - starts_at
    if duration < MIN_SHIFT_DURATION:
        raise ValueError(
            f"Смена короче {int(MIN_SHIFT_DURATION.total_seconds() // 60)} минут"
        )
    if duration > MAX_SHIFT_DURATION:
        raise ValueError(
            f"Смена длиннее {int(MAX_SHIFT_DURATION.total_seconds() // 3600)} часов"
        )
    # Ночь 20:00–08:00 следующего дня здесь валидна: сравниваются timestamptz,
    # а не календарные даты. Две даты в сетке — забота ответа (segments).


class AppointmentBase(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True)

    starts_at: datetime = Field(description="Начало визита, с часовым поясом")
    ends_at: datetime = Field(description="Конец визита (не включается в интервал)")
    title: str | None = Field(default=None, max_length=255, description="Услуга")
    price: Decimal | None = Field(default=None, ge=0, max_digits=10, decimal_places=2)
    notes: str | None = Field(default=None, max_length=4000)

    @field_validator("starts_at", "ends_at")
    @classmethod
    def _aware_utc(cls, value: datetime) -> datetime:
        return require_aware_utc(value)


class AppointmentCreate(AppointmentBase):
    """
    Создание записи.

    company_id, как и везде, не принимается: тенант берётся из токена.
    А вот client_id и user_id обязательны — и оба проверяются на
    принадлежность той же компании (см. scheduling.py).
    """

    client_id: Annotated[int, Field(ge=1)]
    user_id: Annotated[int, Field(ge=1, description="ID мастера")]
    # Если задан — визит привязан к прайс-листу. Title и price подставятся
    # из услуги, если их не передали явно. Материалы спишутся не при записи,
    # а при переводе визита в in_progress / completed (см. inventory.py).
    service_id: int | None = Field(default=None, ge=1)
    extra_data: dict[str, Any] = Field(default_factory=dict)

    @model_validator(mode="after")
    def _check_interval(self) -> "AppointmentCreate":
        validate_interval(self.starts_at, self.ends_at)
        return self


class AppointmentUpdate(BaseModel):
    """
    Перенос записи, смена мастера или статуса.

    Все поля опциональны: можно прислать только status (например, "completed")
    или только новое время. Итоговый интервал проверяется в обработчике,
    потому что здесь ещё неизвестны текущие значения из БД.
    """

    model_config = ConfigDict(str_strip_whitespace=True)

    starts_at: datetime | None = None
    ends_at: datetime | None = None
    user_id: int | None = Field(default=None, ge=1, description="Передать другому мастеру")
    service_id: int | None = Field(default=None, ge=1)
    status: AppointmentStatus | None = None
    title: str | None = Field(default=None, max_length=255)
    price: Decimal | None = Field(default=None, ge=0, max_digits=10, decimal_places=2)
    notes: str | None = Field(default=None, max_length=4000)
    extra_data: dict[str, Any] | None = None

    @field_validator("starts_at", "ends_at")
    @classmethod
    def _aware_utc(cls, value: datetime | None) -> datetime | None:
        return require_aware_utc(value) if value is not None else None


class AppointmentPaymentRead(BaseModel):
    """Баланс визита. Считается из price визита и completed-транзакций."""

    due: Decimal
    paid: Decimal
    remaining: Decimal
    status: AppointmentPaymentStatus


class AppointmentRead(ORMModel):
    id: int
    company_id: int
    client_id: int
    user_id: int
    starts_at: datetime
    ends_at: datetime
    # Считается моделью (Appointment.duration_minutes), в БД не хранится.
    duration_minutes: int
    status: AppointmentStatus
    service_id: int | None
    title: str | None
    price: Decimal | None
    notes: str | None
    extra_data: dict[str, Any]
    created_at: datetime
    # default — чтобы model_validate с ORM не падал; эндпоинты всегда
    # подставляют посчитанный баланс через _appointment_read.
    payment: AppointmentPaymentRead = Field(
        default_factory=lambda: AppointmentPaymentRead(
            due=Decimal("0.00"),
            paid=Decimal("0.00"),
            remaining=Decimal("0.00"),
            status=AppointmentPaymentStatus.UNPAID,
        )
    )


class AppointmentConflict(ORMModel):
    """Краткое описание мешающей записи — возвращается в теле ошибки 409."""

    id: int
    starts_at: datetime
    ends_at: datetime
    status: AppointmentStatus
    client_id: int


# --------------------------------------------------------------------------- #
#  Services (прайс-лист)
# --------------------------------------------------------------------------- #

Qty = Annotated[Decimal, Field(gt=0, max_digits=12, decimal_places=3)]


class ServiceMaterialInput(BaseModel):
    """Одна строка «рецепта» услуги: какой материал и сколько списывать."""

    inventory_item_id: Annotated[int, Field(ge=1)]
    quantity: Qty


class ServiceMaterialRead(ORMModel):
    id: int
    inventory_item_id: int
    quantity: Decimal
    # Имя и единица — чтобы фронту не делать второй запрос за каждой позицией.
    item_name: str | None = None
    item_unit: MeasurementUnit | None = None


class ServiceCreate(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True)

    name: Annotated[str, Field(min_length=1, max_length=255)]
    description: str | None = Field(default=None, max_length=4000)
    base_price: Annotated[Decimal, Field(ge=0, max_digits=10, decimal_places=2)]
    duration_minutes: Annotated[int, Field(ge=5, le=1440)]
    # Рецепт можно задать сразу при создании услуги.
    materials: list[ServiceMaterialInput] = Field(default_factory=list)


class ServiceUpdate(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True)

    name: str | None = Field(default=None, min_length=1, max_length=255)
    description: str | None = Field(default=None, max_length=4000)
    base_price: Decimal | None = Field(default=None, ge=0, max_digits=10, decimal_places=2)
    duration_minutes: int | None = Field(default=None, ge=5, le=1440)
    is_active: bool | None = None


class ServiceMaterialsReplace(BaseModel):
    """Полная замена рецепта услуги. Пустой список = услуга без расходников."""

    materials: list[ServiceMaterialInput]


class ServiceRead(ORMModel):
    id: int
    company_id: int
    name: str
    description: str | None
    base_price: Decimal
    duration_minutes: int
    is_active: bool
    materials: list[ServiceMaterialRead] = Field(default_factory=list)
    created_at: datetime


# --------------------------------------------------------------------------- #
#  Inventory (склад)
# --------------------------------------------------------------------------- #

class InventoryItemCreate(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True)

    name: Annotated[str, Field(min_length=1, max_length=255)]
    sku: str | None = Field(default=None, max_length=64)
    unit: MeasurementUnit
    # Начальный остаток проводится как приход (purchase), а не пишется в обход журнала.
    initial_quantity: Decimal = Field(default=Decimal("0"), ge=0, max_digits=12, decimal_places=3)
    low_stock_threshold: Decimal | None = Field(
        default=None, ge=0, max_digits=12, decimal_places=3
    )


class InventoryItemUpdate(BaseModel):
    """
    Правка карточки. Количество здесь менять нельзя — только через движения
    (приход / списание / корректировка), иначе журнал склада разъедется с остатком.
    """

    model_config = ConfigDict(str_strip_whitespace=True)

    name: str | None = Field(default=None, min_length=1, max_length=255)
    sku: str | None = Field(default=None, max_length=64)
    low_stock_threshold: Decimal | None = Field(
        default=None, ge=0, max_digits=12, decimal_places=3
    )
    is_active: bool | None = None


class InventoryItemRead(ORMModel):
    id: int
    company_id: int
    name: str
    sku: str | None
    unit: MeasurementUnit
    quantity: Decimal
    low_stock_threshold: Decimal | None
    is_low_stock: bool
    is_active: bool
    created_at: datetime


class StockMovementCreate(BaseModel):
    """
    Ручное движение: приход, корректировка, списание брака.
    Расход на услугу и возврат при отмене делает система сама.
    """

    delta: Annotated[Decimal, Field(max_digits=12, decimal_places=3)]
    reason: StockMovementReason
    note: str | None = Field(default=None, max_length=500)

    @field_validator("delta")
    @classmethod
    def _not_zero(cls, value: Decimal) -> Decimal:
        if value == 0:
            raise ValueError("Количество движения не может быть нулевым")
        return value

    @model_validator(mode="after")
    def _reason_matches_sign(self) -> "StockMovementCreate":
        if self.reason == StockMovementReason.PURCHASE and self.delta <= 0:
            raise ValueError("Приход должен быть с положительным количеством")
        if self.reason == StockMovementReason.WRITE_OFF and self.delta >= 0:
            raise ValueError("Списание брака должно быть с отрицательным количеством")
        if self.reason in (
            StockMovementReason.CONSUMPTION,
            StockMovementReason.RETURN,
        ):
            raise ValueError(
                "Расход и возврат по услуге проводятся системой автоматически, "
                "а не этим эндпоинтом"
            )
        return self


class StockMovementRead(ORMModel):
    id: int
    company_id: int
    inventory_item_id: int
    delta: Decimal
    reason: StockMovementReason
    appointment_id: int | None
    created_by_user_id: int | None
    note: str | None
    created_at: datetime


class StockShortage(BaseModel):
    """Одна позиция, из-за которой услугу оказать нельзя."""

    code: str
    inventory_item_id: int | None = None
    name: str
    required: Decimal | None = None
    available: Decimal | None = None
    unit: MeasurementUnit | None = None
    message: str


# --------------------------------------------------------------------------- #
#  Касса
# --------------------------------------------------------------------------- #

Money = Annotated[Decimal, Field(gt=0, max_digits=12, decimal_places=2)]


class TransactionCreate(BaseModel):
    """
    Проведение оплаты или возврата.

    client_id обязателен всегда. appointment_id — если платёж привязан к визиту
    (тогда клиент должен совпадать с клиентом визита).
    """

    client_id: Annotated[int, Field(ge=1)]
    appointment_id: int | None = Field(default=None, ge=1)
    amount: Money
    kind: TransactionKind = TransactionKind.PAYMENT
    method: PaymentMethod = PaymentMethod.CASH
    status: TransactionStatus = TransactionStatus.COMPLETED
    comment: str | None = Field(default=None, max_length=500)
    extra_data: dict[str, Any] = Field(default_factory=dict)


class TransactionStatusUpdate(BaseModel):
    status: TransactionStatus


class TransactionRead(ORMModel):
    id: int
    company_id: int
    client_id: int
    appointment_id: int | None
    amount: Decimal
    kind: TransactionKind
    status: TransactionStatus
    method: PaymentMethod
    created_by_user_id: int | None
    comment: str | None
    extra_data: dict[str, Any]
    created_at: datetime


# --------------------------------------------------------------------------- #
#  Профиль клиента
# --------------------------------------------------------------------------- #

class ClientNoteCreate(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True)

    body: Annotated[str, Field(min_length=1, max_length=4000)]
    is_pinned: bool = False


class ClientNoteRead(ORMModel):
    id: int
    company_id: int
    client_id: int
    author_user_id: int | None
    body: str
    is_pinned: bool
    created_at: datetime


class ClientProfileRead(BaseModel):
    """Карточка клиента для администратора: человек + деньги + надёжность."""

    client: ClientRead
    visits_total: int
    visits_completed: int
    visits_cancelled: int
    visits_upcoming: int
    cancellation_rate: Decimal
    ltv: Decimal
    outstanding_debt: Decimal
    last_visit_at: datetime | None
    next_visit_at: datetime | None
    notes: list[ClientNoteRead] = Field(default_factory=list)
    notes_total: int = 0


# --------------------------------------------------------------------------- #
#  Смены
# --------------------------------------------------------------------------- #

class WorkShiftCreate(BaseModel):
    user_id: Annotated[int, Field(ge=1)]
    starts_at: datetime
    ends_at: datetime
    title: str | None = Field(default=None, max_length=128)

    @field_validator("starts_at", "ends_at")
    @classmethod
    def _aware_utc(cls, value: datetime) -> datetime:
        return require_aware_utc(value)

    @model_validator(mode="after")
    def _interval(self) -> "WorkShiftCreate":
        validate_shift_interval(self.starts_at, self.ends_at)
        return self


class WorkShiftUpdate(BaseModel):
    starts_at: datetime | None = None
    ends_at: datetime | None = None
    title: str | None = Field(default=None, max_length=128)

    @field_validator("starts_at", "ends_at")
    @classmethod
    def _aware_utc(cls, value: datetime | None) -> datetime | None:
        return require_aware_utc(value) if value is not None else None

    @model_validator(mode="after")
    def _interval(self) -> "WorkShiftUpdate":
        if self.starts_at is not None and self.ends_at is not None:
            validate_shift_interval(self.starts_at, self.ends_at)
        return self


class WorkShiftConflict(ORMModel):
    id: int
    user_id: int
    starts_at: datetime
    ends_at: datetime
    title: str | None


class WorkShiftDaySegment(BaseModel):
    """Кусок смены, попадающий в один календарный день пояса компании."""

    date: date
    starts_at: datetime
    ends_at: datetime


class WorkShiftRead(ORMModel):
    id: int
    company_id: int
    user_id: int
    starts_at: datetime
    ends_at: datetime
    title: str | None
    created_at: datetime
    timezone: str
    spans_midnight: bool
    segments: list[WorkShiftDaySegment]


class AuditLogRead(ORMModel):
    """Строка журнала. Менять и удалять через API нельзя."""

    id: int
    company_id: int
    actor_user_id: int | None
    action: AuditAction
    entity_type: str
    entity_id: int | None
    changes: dict[str, Any]
    snapshot: dict[str, Any]
    request_ip: str | None
    request_method: str | None
    request_path: str | None
    created_at: datetime


class AttachmentRead(ORMModel):
    """Метаданные файла. Байты — GET .../content. Ниша хранит id в extra_data."""

    id: int
    company_id: int
    entity_type: AttachmentEntityType
    entity_id: int
    file_url: str
    mime_type: str
    size_bytes: int
    original_filename: str | None
    created_by_user_id: int | None
    created_at: datetime


# --------------------------------------------------------------------------- #
#  Интеграции: API-ключи и вебхуки
# --------------------------------------------------------------------------- #

class ApiKeyCreate(BaseModel):
    name: Annotated[str, Field(min_length=1, max_length=128)]
    expires_at: datetime | None = None

    @field_validator("expires_at")
    @classmethod
    def _aware(cls, value: datetime | None) -> datetime | None:
        return require_aware_utc(value) if value is not None else None


class ApiKeyListItem(ORMModel):
    """Список ключей: без хэша и без сырого токена."""

    id: int
    name: str
    prefix: str
    is_active: bool
    expires_at: datetime | None
    last_used_at: datetime | None
    created_at: datetime


class ApiKeyRead(ORMModel):
    """Метаданные ключа. Сырой токен сюда никогда не попадает."""

    id: int
    company_id: int
    name: str
    prefix: str
    is_active: bool
    expires_at: datetime | None
    last_used_at: datetime | None
    created_at: datetime
    created_by_user_id: int | None


class ApiKeyCreated(ApiKeyRead):
    """Ответ на создание: token показывается ровно один раз."""

    token: str = Field(description="Сырой lmk_… — сохрани сейчас, повторно не отдадим")


class ApiKeyUpdate(BaseModel):
    name: Annotated[str, Field(min_length=1, max_length=128)] | None = None
    is_active: bool | None = None
    expires_at: datetime | None = None

    @field_validator("expires_at")
    @classmethod
    def _aware(cls, value: datetime | None) -> datetime | None:
        return require_aware_utc(value) if value is not None else None


class WebhookCreate(BaseModel):
    url: Annotated[str, Field(min_length=8, max_length=1024)]
    events: list[WebhookEvent] = Field(min_length=1)
    description: str | None = Field(default=None, max_length=255)


class WebhookUpdate(BaseModel):
    url: Annotated[str, Field(min_length=8, max_length=1024)] | None = None
    events: list[WebhookEvent] | None = Field(default=None, min_length=1)
    is_active: bool | None = None
    description: str | None = Field(default=None, max_length=255)
    rotate_secret: bool = False


class WebhookRead(ORMModel):
    """secret в обычном чтении не отдаём — только при create/rotate."""

    id: int
    company_id: int
    url: str
    events: list[str]
    is_active: bool
    description: str | None
    created_at: datetime
    updated_at: datetime


class WebhookCreated(WebhookRead):
    secret: str = Field(
        description="Секрет HMAC; сохрани и сверяй X-Lemko-Signature"
    )


# --------------------------------------------------------------------------- #
#  Схема-ориентированный UI (records, workspace, лента, аналитика)
#
#  Эти схемы отдают camelCase — в том же формате, что записи и конфигурация
#  фронтенда (ViewDef, DashboardDef, …), чтобы UI не перекладывал ключи.
# --------------------------------------------------------------------------- #


Json = dict[str, Any]


class UIModel(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True, from_attributes=True)


class RecordValues(BaseModel):
    values: Json = Field(default_factory=dict)


class RecordPage(BaseModel):
    items: list[Json]
    total: int


class DeletedRecord(BaseModel):
    """record — заархивированная, но видимая запись (отменённый визит); null — удалена."""

    record: Json | None = None


class FieldOptionSchema(BaseModel):
    value: str
    label: str = ""
    color: str | None = None


class FieldSchema(BaseModel):
    key: Annotated[str, Field(min_length=1, max_length=64)]
    label: str = ""
    type: str = "text"
    options: list[FieldOptionSchema] | None = None
    relation: str | None = None


class EntitySchema(UIModel):
    """Разрешённое определение объекта: модуль + правки воркспейса."""

    key: Annotated[str, Field(pattern=r"^[a-z][a-z0-9_]{0,63}$")]
    label: str = ""
    label_singular: str = ""
    primary_field: str = "name"
    stage_field: str | None = None
    date_field: str | None = None
    amount_field: str | None = None
    owner_field: str | None = None
    fields: list[FieldSchema] = Field(default_factory=list)


class WorkspaceConfigPatch(BaseModel):
    """Ключи верхнего уровня заменяются целиком; отсутствующие не трогаются."""

    config: Json


class SavedViewIn(UIModel):
    entity: Annotated[str, Field(pattern=r"^[a-z][a-z0-9_]{0,63}$")]
    name: Annotated[str, Field(min_length=1, max_length=255)]
    type: Annotated[str, Field(pattern=r"^(table|board|gallery|calendar|list)$")]
    columns: list[str] = Field(default_factory=list)
    widths: dict[str, float] | None = None
    filters: list[Json] = Field(default_factory=list)
    sort: Json | None = None
    group_by: str | None = None
    row_height: str | None = None
    shared: bool = True
    position: int = 0


class SavedViewPatch(UIModel):
    name: str | None = Field(default=None, min_length=1, max_length=255)
    type: str | None = Field(default=None, pattern=r"^(table|board|gallery|calendar|list)$")
    columns: list[str] | None = None
    widths: dict[str, float] | None = None
    filters: list[Json] | None = None
    sort: Json | None = None
    group_by: str | None = None
    row_height: str | None = None
    shared: bool | None = None
    position: int | None = None


class DashboardIn(UIModel):
    name: Annotated[str, Field(min_length=1, max_length=255)]
    icon: str = "dashboard"
    widgets: list[Json] = Field(default_factory=list)
    position: int = 0


class DashboardPatch(UIModel):
    name: str | None = Field(default=None, min_length=1, max_length=255)
    icon: str | None = None
    widgets: list[Json] | None = None
    position: int | None = None


class DashboardOut(UIModel):
    id: str
    name: str
    icon: str
    widgets: list[Json]


class ReportIn(UIModel):
    name: Annotated[str, Field(min_length=1, max_length=255)]
    entity: Annotated[str, Field(pattern=r"^[a-z][a-z0-9_]{0,63}$")]
    group_by: Annotated[str, Field(min_length=1, max_length=64)]
    metric: Annotated[str, Field(pattern=r"^(count|sum|avg)$")] = "count"
    metric_field: str | None = None
    chart: Annotated[str, Field(pattern=r"^(bar|line|pie|table)$")] = "bar"


class ReportOut(ReportIn):
    id: str


class IntegrationIn(UIModel):
    account: Annotated[str, Field(min_length=1, max_length=255)]
    status: Annotated[str, Field(pattern=r"^(connected|syncing|error)$")] = "connected"
    settings: dict[str, bool] = Field(default_factory=dict)


class IntegrationOut(UIModel):
    id: str  # ключ приложения (gmail, slack, …)
    account: str
    status: str
    settings: dict[str, bool]
    connected_at: datetime
    last_synced_at: datetime | None = None


class CompanySummary(UIModel):
    id: int
    name: str
    plan: str
    timezone: str
    trial_ends_at: datetime | None = None


class WorkspaceOut(UIModel):
    initialized: bool
    company: CompanySummary
    config: Json
    views: list[Json]
    dashboards: list[DashboardOut]
    reports: list[ReportOut]
    integrations: list[IntegrationOut]


class WorkspaceBootstrap(UIModel):
    """Стартовая конфигурация нового воркспейса (её собирает фронт из модулей)."""

    config: Json = Field(default_factory=dict)
    views: list[SavedViewIn] = Field(default_factory=list)
    dashboards: list[DashboardIn] = Field(default_factory=list)
    reports: list[ReportIn] = Field(default_factory=list)


class WorkspaceExport(UIModel):
    config: Json = Field(default_factory=dict)
    views: list[SavedViewIn] = Field(default_factory=list)
    dashboards: list[DashboardIn] = Field(default_factory=list)
    reports: list[ReportIn] = Field(default_factory=list)


class ActivityIn(UIModel):
    entity: Annotated[str, Field(pattern=r"^[a-z][a-z0-9_]{0,63}$")]
    record_id: Annotated[str, Field(min_length=1, max_length=64)]
    kind: Annotated[str, Field(pattern=r"^(note|call|email|meeting|comment)$")] = "note"
    body: Annotated[str, Field(min_length=1, max_length=10_000)]


class ActivityOut(UIModel):
    id: str
    kind: str
    entity: str
    record_id: str
    actor: str | None
    at: datetime
    title: str
    body: str | None = None
    read: bool
    personal: bool = False
    source: str | None = None
    # Из чего интерфейс собирает заголовок на языке сотрудника; у старых событий нет.
    event: str | None = None
    params: dict[str, Any] | None = None


class ActivityPage(UIModel):
    items: list[ActivityOut]
    unread: int


class ActivityReadIn(BaseModel):
    ids: list[str] = Field(min_length=1, max_length=500)


class PeriodIn(BaseModel):
    year: Annotated[int, Field(ge=2000, le=2100)]
    # 1–12 (январь = 1).
    month: Annotated[int, Field(ge=1, le=12)]


class WidgetQuery(BaseModel):
    id: str
    type: str
    config: Json = Field(default_factory=dict)


class WidgetsIn(BaseModel):
    period: PeriodIn
    widgets: list[WidgetQuery] = Field(max_length=100)


class WidgetsOut(BaseModel):
    """id виджета → {"data": …} или {"error": {"code", "message"}}."""

    results: dict[str, Json]


class ReportQuery(UIModel):
    entity: Annotated[str, Field(pattern=r"^[a-z][a-z0-9_]{0,63}$")]
    group_by: Annotated[str, Field(min_length=1, max_length=64)]
    metric: Annotated[str, Field(pattern=r"^(count|sum|avg)$")] = "count"
    metric_field: str | None = None


class ReportRows(BaseModel):
    rows: list[Json]


class MemberOut(UIModel):
    id: str
    name: str
    email: str
    role: str
    title: str
    status: str  # active | invited | disabled


class MemberInvite(UIModel):
    email: EmailStr
    name: str | None = Field(default=None, max_length=255)
    role: Annotated[str, Field(pattern=r"^(Admin|Manager|Member|Viewer)$")] = "Member"
    title: str | None = Field(default=None, max_length=255)


class MemberInvited(UIModel):
    member: MemberOut
    temporary_password: str


class MemberPatch(UIModel):
    name: str | None = Field(default=None, max_length=255)
    title: str | None = Field(default=None, max_length=255)
    role: str | None = Field(default=None, pattern=r"^(Owner|Admin|Manager|Member|Viewer)$")


class ProfileOut(UIModel):
    member: MemberOut
    company_id: int
    preferences: Json


class ProfilePatch(UIModel):
    name: str | None = Field(default=None, max_length=255)
    title: str | None = Field(default=None, max_length=255)
    email: EmailStr | None = None
    # Сливается с сохранёнными ключами верхнего уровня (prefs, favorites, …).
    preferences: Json | None = None


