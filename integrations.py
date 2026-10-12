"""
Интеграции тенанта: API-ключи и исходящие вебхуки.

Ключ `lmk_…` показывается один раз. В БД — bcrypt-хэш + prefix для поиска.
Вебхуки пишутся в outbox той же транзакцией, что и событие; HTTP — воркер.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import secrets
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any
from core import crypto, netguard

from sqlalchemy import select
from sqlalchemy.orm import Session

import models
from core.errors import DomainError
import core.security as security

API_KEY_PREFIX = "lmk_"
API_KEY_BYTES = 32
# UI + lookup: "lmk_" + 4 символа тела = 8.
API_KEY_PREFIX_LEN = 8
WEBHOOK_SECRET_BYTES = 32

EXTERNAL_SCOPES = frozenset(
    {
        "appointments:read",
        "appointments:write",
        "clients:read",
        "clients:write",
    }
)

# NotificationEventType (underscore) → WebhookEvent (dotted).
_NOTIFICATION_TO_WEBHOOK = {
    models.NotificationEventType.APPOINTMENT_CREATED.value: (
        models.WebhookEvent.APPOINTMENT_CREATED.value
    ),
    models.NotificationEventType.APPOINTMENT_RESCHEDULED.value: (
        models.WebhookEvent.APPOINTMENT_RESCHEDULED.value
    ),
    models.NotificationEventType.APPOINTMENT_CANCELLED.value: (
        models.WebhookEvent.APPOINTMENT_CANCELLED.value
    ),
    models.NotificationEventType.CLIENT_CREATED.value: (
        models.WebhookEvent.CLIENT_CREATED.value
    ),
    models.NotificationEventType.CLIENT_UPDATED.value: (
        models.WebhookEvent.CLIENT_UPDATED.value
    ),
    models.NotificationEventType.RECORD_CREATED.value: models.WebhookEvent.RECORD_CREATED.value,
    models.NotificationEventType.RECORD_UPDATED.value: models.WebhookEvent.RECORD_UPDATED.value,
    models.NotificationEventType.RECORD_DELETED.value: models.WebhookEvent.RECORD_DELETED.value,
}

_RECORD_EVENTS = {
    "created": models.NotificationEventType.RECORD_CREATED,
    "updated": models.NotificationEventType.RECORD_UPDATED,
    "deleted": models.NotificationEventType.RECORD_DELETED,
}


class IntegrationError(DomainError):
    status_code = 400


@dataclass(frozen=True)
class ApiKeyTenant:
    """Контекст запроса по X-API-Key: тенант без JWT-сотрудника."""

    company: models.Company
    api_key: models.ApiKey
    scopes: frozenset[str] = EXTERNAL_SCOPES


def hash_api_key(raw_token: str) -> str:
    """Тот же passlib-контекст, что у паролей сотрудников (argon2id, bcrypt — для старых)."""
    return security.hash_password(raw_token)


def verify_api_key(raw_token: str, key_hash: str) -> bool:
    # Modular Crypt Format ($argon2id$…, $2b$…) — проверяет passlib, какой бы схемой ни был хэш.
    if key_hash.startswith("$"):
        return security.verify_password(raw_token, key_hash)
    # Старые sha256-ключи (до миграции на bcrypt) — на всякий случай.
    digest = hashlib.sha256(raw_token.encode("utf-8")).hexdigest()
    return hmac.compare_digest(digest, key_hash)


def generate_api_token() -> tuple[str, str, str]:
    """(сырой токен, bcrypt-hash, prefix для UI/lookup)."""
    body = secrets.token_urlsafe(API_KEY_BYTES)
    raw = f"{API_KEY_PREFIX}{body}"
    prefix = raw[:API_KEY_PREFIX_LEN]
    return raw, hash_api_key(raw), prefix


def create_api_key(
    db: Session,
    *,
    company_id: int,
    name: str,
    created_by_user_id: int | None,
    expires_at: datetime | None = None,
) -> tuple[models.ApiKey, str]:
    name = name.strip()
    if not name:
        raise IntegrationError(
            "empty_name",
            "Название ключа не может быть пустым",
            status_code=422,
        )
    if expires_at is not None and expires_at <= datetime.now(timezone.utc):
        raise IntegrationError(
            "expires_in_past",
            "Срок действия должен быть в будущем",
            status_code=422,
        )
    raw, key_hash, prefix = generate_api_token()
    row = models.ApiKey(
        company_id=company_id,
        name=name,
        key_hash=key_hash,
        prefix=prefix,
        is_active=True,
        expires_at=expires_at,
        created_by_user_id=created_by_user_id,
    )
    db.add(row)
    db.flush()
    return row, raw


def list_api_keys(db: Session, *, company_id: int) -> list[models.ApiKey]:
    stmt = (
        select(models.ApiKey)
        .where(models.ApiKey.company_id == company_id)
        .order_by(models.ApiKey.created_at.desc(), models.ApiKey.id.desc())
    )
    return list(db.scalars(stmt))


def get_api_key(
    db: Session, *, company_id: int, api_key_id: int
) -> models.ApiKey | None:
    return db.scalars(
        select(models.ApiKey).where(
            models.ApiKey.id == api_key_id,
            models.ApiKey.company_id == company_id,
        )
    ).first()


def revoke_api_key(row: models.ApiKey) -> None:
    row.is_active = False


def authenticate_api_key(db: Session, raw_token: str) -> ApiKeyTenant:
    """
    Lookup по prefix, проверка bcrypt, active/expires → тенант.
    """
    token = (raw_token or "").strip()
    if not token.startswith(API_KEY_PREFIX) or len(token) < API_KEY_PREFIX_LEN + 4:
        raise IntegrationError(
            "invalid_api_key",
            "Некорректный API-ключ",
            status_code=401,
        )
    prefix = token[:API_KEY_PREFIX_LEN]
    candidates = list(
        db.scalars(
            select(models.ApiKey).where(models.ApiKey.prefix == prefix)
        )
    )
    row: models.ApiKey | None = None
    for candidate in candidates:
        if verify_api_key(token, candidate.key_hash):
            row = candidate
            break
    if row is None:
        # dummy verify — выравниваем время ответа
        security.verify_password(token, None)
        raise IntegrationError(
            "invalid_api_key",
            "Некорректный API-ключ",
            status_code=401,
        )
    if not row.is_active:
        raise IntegrationError(
            "api_key_revoked",
            "API-ключ отозван",
            status_code=401,
        )
    if row.expires_at is not None and row.expires_at <= datetime.now(timezone.utc):
        raise IntegrationError(
            "api_key_expired",
            "Срок действия API-ключа истёк",
            status_code=401,
        )
    company = db.get(models.Company, row.company_id)
    if company is None or not company.is_active:
        raise IntegrationError(
            "company_blocked",
            "Компания заблокирована",
            status_code=403,
        )
    row.last_used_at = datetime.now(timezone.utc)
    return ApiKeyTenant(company=company, api_key=row)


def require_scope(tenant: ApiKeyTenant, scope: str) -> None:
    if scope not in tenant.scopes:
        raise IntegrationError(
            "scope_denied",
            f"API-ключу недоступна операция «{scope}»",
            status_code=403,
            scope=scope,
        )


def _validate_webhook_url(url: str) -> str:
    # Схема, без логина в URL, не во внутреннюю сеть (SSRF) — core.netguard.
    try:
        return netguard.validate_url(url)
    except netguard.UnsafeUrl as exc:
        raise IntegrationError("invalid_url", str(exc), status_code=422) from exc


def _normalize_events(events: list[str | models.WebhookEvent]) -> list[str]:
    if not events:
        raise IntegrationError(
            "empty_events",
            "Укажи хотя бы одно событие подписки",
            status_code=422,
        )
    # Принимаем и dotted, и legacy underscore.
    allowed = {item.value for item in models.WebhookEvent}
    underscore_to_dotted = {
        dotted.replace(".", "_"): dotted for dotted in allowed
    }
    normalized: list[str] = []
    seen: set[str] = set()
    for item in events:
        value = item.value if isinstance(item, models.WebhookEvent) else str(item)
        if value in underscore_to_dotted:
            value = underscore_to_dotted[value]
        if value not in allowed:
            raise IntegrationError(
                "unknown_event",
                f"Неизвестное событие вебхука: {value}",
                status_code=422,
                event=value,
            )
        if value not in seen:
            seen.add(value)
            normalized.append(value)
    return normalized


def generate_webhook_secret() -> str:
    return secrets.token_urlsafe(WEBHOOK_SECRET_BYTES)


def webhook_secret(row: models.Webhook) -> str:
    """Секрет подписи в открытом виде. В БД он зашифрован (AES-GCM)."""
    return crypto.decrypt_str(row.secret) or ""


def sign_payload(secret: str, body: bytes) -> str:
    """HMAC-SHA256 hex — клиент сверяет с заголовком X-Lemko-Signature."""
    return hmac.new(secret.encode("utf-8"), body, hashlib.sha256).hexdigest()


def create_webhook(
    db: Session,
    *,
    company_id: int,
    url: str,
    events: list[str | models.WebhookEvent],
    description: str | None = None,
) -> models.Webhook:
    row = models.Webhook(
        company_id=company_id,
        url=_validate_webhook_url(url),
        events=_normalize_events(events),
        secret=crypto.encrypt_str(generate_webhook_secret()),
        is_active=True,
        description=(description.strip() if description else None) or None,
    )
    db.add(row)
    db.flush()
    return row


def list_webhooks(db: Session, *, company_id: int) -> list[models.Webhook]:
    stmt = (
        select(models.Webhook)
        .where(models.Webhook.company_id == company_id)
        .order_by(models.Webhook.created_at.desc(), models.Webhook.id.desc())
    )
    return list(db.scalars(stmt))


def get_webhook(
    db: Session, *, company_id: int, webhook_id: int
) -> models.Webhook | None:
    return db.scalars(
        select(models.Webhook).where(
            models.Webhook.id == webhook_id,
            models.Webhook.company_id == company_id,
        )
    ).first()


def update_webhook(
    row: models.Webhook,
    *,
    url: str | None = None,
    events: list[str | models.WebhookEvent] | None = None,
    is_active: bool | None = None,
    description: str | None = None,
    rotate_secret: bool = False,
) -> str | None:
    if url is not None:
        row.url = _validate_webhook_url(url)
    if events is not None:
        row.events = _normalize_events(events)
    if is_active is not None:
        row.is_active = is_active
    if description is not None:
        row.description = description.strip() or None
    new_secret: str | None = None
    if rotate_secret:
        new_secret = generate_webhook_secret()
        row.secret = crypto.encrypt_str(new_secret)
    return new_secret


def delete_webhook(db: Session, row: models.Webhook) -> None:
    db.delete(row)


def active_webhooks_for_event(
    db: Session,
    *,
    company_id: int,
    event: str,
) -> list[models.Webhook]:
    """event — dotted (appointment.created) или underscore из NotificationEventType."""
    dotted = _NOTIFICATION_TO_WEBHOOK.get(event, event)
    aliases = {event, dotted, event.replace(".", "_"), dotted.replace(".", "_")}
    rows = list(
        db.scalars(
            select(models.Webhook).where(
                models.Webhook.company_id == company_id,
                models.Webhook.is_active.is_(True),
            )
        )
    )
    return [
        row
        for row in rows
        if aliases.intersection(set(row.events or []))
    ]


def enqueue_webhooks(
    db: Session,
    *,
    company_id: int,
    event_type: models.NotificationEventType,
    payload: dict[str, Any],
    appointment_id: int | None = None,
) -> list[models.NotificationOutbox]:
    event = event_type.value
    dotted = _NOTIFICATION_TO_WEBHOOK.get(event, event.replace("_", "."))
    hooks = active_webhooks_for_event(db, company_id=company_id, event=event)
    rows: list[models.NotificationOutbox] = []
    for hook in hooks:
        body = {
            "event": dotted,
            "company_id": company_id,
            "webhook_id": hook.id,
            "data": payload,
        }
        rows.append(
            models.NotificationOutbox(
                company_id=company_id,
                event_type=event_type,
                status=models.OutboxStatus.PENDING,
                recipient_kind=models.NotificationRecipientKind.WEBHOOK,
                recipient_id=hook.id,
                appointment_id=appointment_id,
                payload=body,
            )
        )
    for row in rows:
        db.add(row)
    return rows


def enqueue_record_webhooks(db: Session, *, company_id: int, change) -> list[models.NotificationOutbox]:
    """record.created / record.updated / record.deleted для любого объекта CRM."""
    return enqueue_webhooks(
        db,
        company_id=company_id,
        event_type=_RECORD_EVENTS[change.action],
        payload={
            "entity": change.entity,
            "record_id": change.record_id,
            "record": change.after if change.after is not None else change.before,
            "changed": change.changed,
        },
    )


def webhook_delivery_body(payload: dict[str, Any]) -> bytes:
    return json.dumps(
        payload, ensure_ascii=False, separators=(",", ":"), sort_keys=True
    ).encode("utf-8")
