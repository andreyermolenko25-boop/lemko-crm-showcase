"""
Конфигурация воркспейса и синхронизированная схема объектов.

Определения объектов (поля, стадии, сумма, ответственный) собирает фронт из
модулей и правок воркспейса и присылает сюда (PUT /workspace/schema). Сервер
по ним подписывает события ленты, считает виджеты и выполняет автоматизации —
не дублируя каталог модулей у себя.
"""

from __future__ import annotations

from typing import Any

from sqlalchemy.orm import Session

import models

# Значения стадий, которые считаются закрытыми (как во фронтенде).
CLOSED_WON = frozenset({"won", "completed", "paid", "done", "solved", "sold"})
CLOSED_LOST = frozenset({"lost", "cancelled", "churned"})
CLOSED = CLOSED_WON | CLOSED_LOST

NUMERIC_TYPES = frozenset({"number", "currency", "percent", "rating"})
DATE_TYPES = frozenset({"date", "datetime"})

# Ключи config, которые редактирует UI (всё остальное отбрасывается).
CONFIG_KEYS = (
    "enabledModules",
    "customEntities",
    "overrides",
    "nav",
    "packages",
    "color",
    "niche",
    "logoAttachmentId",
)

_CACHE_KEY = "workspace_schema"


def get_settings(db: Session, company_id: int, *, create: bool = False) -> models.WorkspaceSettings | None:
    row = db.get(models.WorkspaceSettings, company_id)
    if row is None and create:
        row = models.WorkspaceSettings(company_id=company_id, config={}, schema=[])
        db.add(row)
        db.flush()
    return row


def entity_defs(db: Session, company_id: int) -> dict[str, dict[str, Any]]:
    """Схема объектов тенанта (кэш на сессию: одно чтение на запрос)."""
    cache: dict[int, dict[str, dict[str, Any]]] = db.info.setdefault(_CACHE_KEY, {})
    if company_id not in cache:
        row = db.get(models.WorkspaceSettings, company_id)
        cache[company_id] = {
            item["key"]: item for item in (row.schema if row else []) if isinstance(item, dict) and item.get("key")
        }
    return cache[company_id]


def forget_schema(db: Session, company_id: int) -> None:
    db.info.get(_CACHE_KEY, {}).pop(company_id, None)


def entity_def(db: Session, company_id: int, key: str) -> dict[str, Any] | None:
    return entity_defs(db, company_id).get(key)


def field_def(entity: dict[str, Any] | None, key: str | None) -> dict[str, Any] | None:
    if not entity or not key:
        return None
    return next((f for f in entity.get("fields", []) if f.get("key") == key), None)


def option_label(field: dict[str, Any] | None, value: Any) -> str:
    if field:
        for option in field.get("options") or []:
            if option.get("value") == value:
                return str(option.get("label") or value)
    return "" if value is None else str(value)


def singular(entity: dict[str, Any] | None, key: str) -> str:
    if entity and entity.get("labelSingular"):
        return str(entity["labelSingular"])
    return key[:-1].capitalize() if key.endswith("s") else key.capitalize()


def record_name(entity: dict[str, Any] | None, record: dict[str, Any]) -> str | None:
    """Название записи из её полей; None — названия нет (интерфейс подставит своё)."""
    primary = (entity or {}).get("primaryField")
    for key in (primary, "name", "title", "number", "subject", "address"):
        if key and record.get(key) not in (None, ""):
            return str(record[key])
    return None


def record_title(entity: dict[str, Any] | None, record: dict[str, Any]) -> str:
    return record_name(entity, record) or "Untitled"
