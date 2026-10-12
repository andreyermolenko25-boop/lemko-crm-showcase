"""
Вложения: метаданные в БД, байты в storage.

Нишевый контейнер сохраняет id файла в extra_data сущности,
ядро не знает про «фото до/после» или рентген.
"""

from __future__ import annotations

import re
import uuid
from pathlib import Path

from sqlalchemy import select
from sqlalchemy.orm import Session

import models
from core.errors import DomainError
from core.config import settings
from scheduling import get_appointment, get_client
from storage import StorageError, get_storage

_SAFE_NAME = re.compile(r"[^A-Za-z0-9._-]+")
_MIME_EXT = {
    "image/jpeg": ".jpg",
    "image/jpg": ".jpg",
    "image/png": ".png",
    "image/webp": ".webp",
    "image/heic": ".heic",
    "image/gif": ".gif",
    "application/pdf": ".pdf",
    "application/dicom": ".dcm",
}


class AttachmentError(DomainError):
    status_code = 400


def _mime_allowed(mime: str) -> bool:
    mime = mime.lower().strip()
    for allowed in settings.STORAGE_ALLOWED_MIME:
        if allowed.endswith("/*"):
            if mime.startswith(allowed[:-1]):
                return True
        elif mime == allowed:
            return True
    return False


def _extension(filename: str | None, mime: str) -> str:
    if filename:
        suffix = Path(filename).suffix.lower()
        if suffix in {".jpg", ".jpeg", ".png", ".webp", ".heic", ".gif", ".pdf", ".dcm"}:
            return ".jpg" if suffix == ".jpeg" else suffix
    return _MIME_EXT.get(mime.lower(), "")


def _safe_filename(name: str | None) -> str | None:
    if not name:
        return None
    cleaned = _SAFE_NAME.sub("_", Path(name).name).strip("._")
    return cleaned[:255] or None


def require_parent(
    db: Session,
    *,
    company_id: int,
    entity_type: models.AttachmentEntityType,
    entity_id: int,
) -> None:
    if entity_type is models.AttachmentEntityType.CLIENT:
        client = get_client(
            db, company_id=company_id, client_id=entity_id, active_only=False
        )
        if client is None:
            raise AttachmentError(
                "parent_not_found",
                "Клиент не найден",
                status_code=404,
            )
        return
    if entity_type is models.AttachmentEntityType.APPOINTMENT:
        visit = get_appointment(
            db, company_id=company_id, appointment_id=entity_id
        )
        if visit is None:
            raise AttachmentError(
                "parent_not_found",
                "Визит не найден",
                status_code=404,
            )
        return
    if entity_type is models.AttachmentEntityType.COMPANY:
        # Логотип воркспейса: родитель — сама компания тенанта.
        if entity_id != company_id:
            raise AttachmentError(
                "parent_not_found",
                "Компания не найдена",
                status_code=404,
            )
        return
    note = db.scalars(
        select(models.ClientNote).where(
            models.ClientNote.id == entity_id,
            models.ClientNote.company_id == company_id,
        )
    ).first()
    if note is None:
        raise AttachmentError(
            "parent_not_found",
            "Заметка не найдена",
            status_code=404,
        )


def create_attachment(
    db: Session,
    *,
    company_id: int,
    actor_user_id: int,
    entity_type: models.AttachmentEntityType,
    entity_id: int,
    data: bytes,
    mime_type: str | None,
    filename: str | None,
) -> models.Attachment:
    if not data:
        raise AttachmentError(
            "empty_file",
            "Файл пустой",
            status_code=422,
        )
    if len(data) > settings.STORAGE_MAX_BYTES:
        raise AttachmentError(
            "file_too_large",
            f"Файл больше {settings.STORAGE_MAX_BYTES} байт",
            status_code=413,
        )
    mime = (mime_type or "application/octet-stream").split(";")[0].strip().lower()
    if not _mime_allowed(mime):
        raise AttachmentError(
            "mime_not_allowed",
            f"Тип {mime} нельзя загрузить в ядро",
            status_code=415,
        )
    require_parent(
        db, company_id=company_id, entity_type=entity_type, entity_id=entity_id
    )

    ext = _extension(filename, mime)
    key = f"{company_id}/{entity_type.value}/{entity_id}/{uuid.uuid4().hex}{ext}"
    if settings.STORAGE_S3_PREFIX and settings.STORAGE_BACKEND == "s3":
        key = f"{settings.STORAGE_S3_PREFIX.rstrip('/')}/{key}"

    storage = get_storage()
    try:
        storage.save(key=key, data=data, mime_type=mime)
    except StorageError as exc:
        raise AttachmentError(
            "storage_failed",
            str(exc),
            status_code=503,
        ) from exc

    row = models.Attachment(
        company_id=company_id,
        entity_type=entity_type,
        entity_id=entity_id,
        storage_key=key,
        file_url="",
        mime_type=mime,
        size_bytes=len(data),
        original_filename=_safe_filename(filename),
        created_by_user_id=actor_user_id,
    )
    db.add(row)
    db.flush()
    row.file_url = f"/companies/{company_id}/attachments/{row.id}/content"
    return row


def list_attachments(
    db: Session,
    *,
    company_id: int,
    entity_type: models.AttachmentEntityType | None = None,
    entity_id: int | None = None,
    limit: int = 50,
    offset: int = 0,
) -> list[models.Attachment]:
    if entity_id is not None and entity_type is None:
        raise AttachmentError(
            "entity_type_required",
            "Для фильтра по entity_id нужен entity_type",
            status_code=422,
        )
    if entity_type is not None and entity_id is not None:
        require_parent(
            db, company_id=company_id, entity_type=entity_type, entity_id=entity_id
        )
    stmt = select(models.Attachment).where(models.Attachment.company_id == company_id)
    if entity_type is not None:
        stmt = stmt.where(models.Attachment.entity_type == entity_type)
    if entity_id is not None:
        stmt = stmt.where(models.Attachment.entity_id == entity_id)
    stmt = (
        stmt.order_by(models.Attachment.created_at.desc(), models.Attachment.id.desc())
        .limit(limit)
        .offset(offset)
    )
    return list(db.scalars(stmt))


def get_attachment(
    db: Session, *, company_id: int, attachment_id: int
) -> models.Attachment:
    row = db.scalars(
        select(models.Attachment).where(
            models.Attachment.id == attachment_id,
            models.Attachment.company_id == company_id,
        )
    ).first()
    if row is None:
        raise AttachmentError(
            "attachment_not_found",
            "Файл не найден",
            status_code=404,
        )
    return row


def delete_attachment(
    db: Session, *, company_id: int, attachment_id: int
) -> None:
    row = get_attachment(db, company_id=company_id, attachment_id=attachment_id)
    key = row.storage_key
    db.delete(row)
    db.flush()
    try:
        get_storage().delete(key=key)
    except StorageError:
        # Строка уже снята; сирота на диске лучше, чем битая ссылка в API.
        return
