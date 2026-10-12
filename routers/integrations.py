"""
Управление интеграциями тенанта (JWT OWNER/ADMIN).

Пути без company_id в URL: тенант берётся из токена сотрудника.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Path, status
from sqlalchemy.orm import Session

import integrations
import models
import schemas
from core.database import get_db
from core.deps import require_roles

router = APIRouter(prefix="/integrations", tags=["integrations"])

_ADMIN = (models.UserRole.OWNER, models.UserRole.ADMIN)


@router.post(
    "/api-keys",
    response_model=schemas.ApiKeyCreated,
    status_code=status.HTTP_201_CREATED,
)
def create_api_key(
    payload: schemas.ApiKeyCreate,
    actor: models.User = Depends(require_roles(*_ADMIN)),
    db: Session = Depends(get_db),
) -> schemas.ApiKeyCreated:
    """
    Генерирует `lmk_…`. Сырой ключ в ответе один раз — в БД только bcrypt + prefix.
    """
    row, raw = integrations.create_api_key(
        db,
        company_id=actor.company_id,
        name=payload.name,
        created_by_user_id=actor.id,
        expires_at=payload.expires_at,
    )
    db.commit()
    db.refresh(row)
    return schemas.ApiKeyCreated(
        **schemas.ApiKeyRead.model_validate(row).model_dump(),
        token=raw,
    )


@router.get("/api-keys", response_model=list[schemas.ApiKeyListItem])
def list_api_keys(
    actor: models.User = Depends(require_roles(*_ADMIN)),
    db: Session = Depends(get_db),
) -> list[models.ApiKey]:
    return integrations.list_api_keys(db, company_id=actor.company_id)


@router.patch("/api-keys/{api_key_id}", response_model=schemas.ApiKeyListItem)
def update_api_key(
    payload: schemas.ApiKeyUpdate,
    api_key_id: int = Path(..., ge=1),
    actor: models.User = Depends(require_roles(*_ADMIN)),
    db: Session = Depends(get_db),
) -> models.ApiKey:
    row = integrations.get_api_key(
        db, company_id=actor.company_id, api_key_id=api_key_id
    )
    if row is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={"code": "api_key_not_found", "message": "API-ключ не найден"},
        )
    for field, value in payload.model_dump(exclude_unset=True).items():
        setattr(row, field, value)
    db.commit()
    db.refresh(row)
    return row


@router.delete("/api-keys/{api_key_id}", response_model=schemas.ApiKeyListItem)
def revoke_api_key(
    api_key_id: int = Path(..., ge=1),
    actor: models.User = Depends(require_roles(*_ADMIN)),
    db: Session = Depends(get_db),
) -> models.ApiKey:
    """Отзыв: is_active=false. Строку оставляем для аудита."""
    row = integrations.get_api_key(
        db, company_id=actor.company_id, api_key_id=api_key_id
    )
    if row is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={"code": "api_key_not_found", "message": "API-ключ не найден"},
        )
    integrations.revoke_api_key(row)
    db.commit()
    db.refresh(row)
    return row


@router.post(
    "/webhooks",
    response_model=schemas.WebhookCreated,
    status_code=status.HTTP_201_CREATED,
)
def create_webhook(
    payload: schemas.WebhookCreate,
    actor: models.User = Depends(require_roles(*_ADMIN)),
    db: Session = Depends(get_db),
) -> schemas.WebhookCreated:
    row = integrations.create_webhook(
        db,
        company_id=actor.company_id,
        url=payload.url,
        events=payload.events,
        description=payload.description,
    )
    db.commit()
    db.refresh(row)
    return schemas.WebhookCreated(
        **schemas.WebhookRead.model_validate(row).model_dump(),
        secret=integrations.webhook_secret(row),
    )


@router.get("/webhooks", response_model=list[schemas.WebhookRead])
def list_webhooks(
    actor: models.User = Depends(require_roles(*_ADMIN)),
    db: Session = Depends(get_db),
) -> list[models.Webhook]:
    return integrations.list_webhooks(db, company_id=actor.company_id)


@router.get("/webhooks/{webhook_id}", response_model=schemas.WebhookRead)
def read_webhook(
    webhook_id: int = Path(..., ge=1),
    actor: models.User = Depends(require_roles(*_ADMIN)),
    db: Session = Depends(get_db),
) -> models.Webhook:
    row = integrations.get_webhook(
        db, company_id=actor.company_id, webhook_id=webhook_id
    )
    if row is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={"code": "webhook_not_found", "message": "Вебхук не найден"},
        )
    return row


@router.patch(
    "/webhooks/{webhook_id}",
    response_model=schemas.WebhookCreated | schemas.WebhookRead,
)
def update_webhook(
    payload: schemas.WebhookUpdate,
    webhook_id: int = Path(..., ge=1),
    actor: models.User = Depends(require_roles(*_ADMIN)),
    db: Session = Depends(get_db),
) -> schemas.WebhookCreated | models.Webhook:
    row = integrations.get_webhook(
        db, company_id=actor.company_id, webhook_id=webhook_id
    )
    if row is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={"code": "webhook_not_found", "message": "Вебхук не найден"},
        )
    new_secret = integrations.update_webhook(
        row,
        url=payload.url,
        events=payload.events,
        is_active=payload.is_active,
        description=payload.description,
        rotate_secret=payload.rotate_secret,
    )
    db.commit()
    db.refresh(row)
    if new_secret is not None:
        return schemas.WebhookCreated(
            **schemas.WebhookRead.model_validate(row).model_dump(),
            secret=new_secret,
        )
    return row


@router.delete("/webhooks/{webhook_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_webhook(
    webhook_id: int = Path(..., ge=1),
    actor: models.User = Depends(require_roles(*_ADMIN)),
    db: Session = Depends(get_db),
) -> None:
    row = integrations.get_webhook(
        db, company_id=actor.company_id, webhook_id=webhook_id
    )
    if row is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={"code": "webhook_not_found", "message": "Вебхук не найден"},
        )
    integrations.delete_webhook(db, row)
    db.commit()
