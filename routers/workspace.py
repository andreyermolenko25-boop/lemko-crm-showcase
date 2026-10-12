"""
Всё, что пользователь настраивает в UI воркспейса: модули, объекты и поля,
навигация, представления, дашборды, отчёты, подключённые приложения.
Раньше это лежало в localStorage браузера — теперь общее для команды
и переживает смену устройства.
"""

from __future__ import annotations

import json
from datetime import datetime, timezone
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Path, status
from sqlalchemy import delete, or_, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

import models
import schemas
import workspace
from core.database import get_db
from core.deps import get_current_company, get_current_user, require_editor, require_roles

router = APIRouter(prefix="/companies/{company_id}", tags=["workspace"])

_ADMIN = (models.UserRole.OWNER, models.UserRole.ADMIN)
MAX_CONFIG_BYTES = 1_000_000
VIEW_CONFIG_KEYS = ("columns", "widths", "filters", "sort", "group_by", "row_height")


# --------------------------------------------------------------------------- #
#  Сериализация
# --------------------------------------------------------------------------- #

def view_out(row: models.SavedView) -> dict[str, Any]:
    config = row.config or {}
    return {
        "id": str(row.id),
        "entity": row.entity,
        "name": row.name,
        "type": row.type,
        "columns": config.get("columns", []),
        "widths": config.get("widths"),
        "filters": config.get("filters", []),
        "sort": config.get("sort"),
        "groupBy": config.get("group_by"),
        "rowHeight": config.get("row_height"),
        "shared": row.owner_user_id is None,
        "position": row.position,
    }


def dashboard_out(row: models.Dashboard) -> schemas.DashboardOut:
    return schemas.DashboardOut(id=str(row.id), name=row.name, icon=row.icon, widgets=row.widgets or [])


def report_out(row: models.Report) -> schemas.ReportOut:
    return schemas.ReportOut(
        id=str(row.id),
        name=row.name,
        entity=row.entity,
        group_by=row.group_by,
        metric=row.metric,
        metric_field=row.metric_field,
        chart=row.chart,
    )


def integration_out(row: models.IntegrationConnection) -> schemas.IntegrationOut:
    return schemas.IntegrationOut(
        id=row.app,
        account=row.account,
        status=row.status,
        settings=row.settings or {},
        connected_at=row.created_at,
        last_synced_at=row.last_synced_at,
    )


def _clean_config(raw: dict[str, Any]) -> dict[str, Any]:
    config = {key: raw[key] for key in workspace.CONFIG_KEYS if key in raw}
    if len(json.dumps(config, default=str)) > MAX_CONFIG_BYTES:
        raise HTTPException(status_code=status.HTTP_413_CONTENT_TOO_LARGE, detail={"code": "config_too_large", "message": "Конфигурация слишком большая"})
    return config


def _view_row(company_id: int, payload: schemas.SavedViewIn, owner_user_id: int | None) -> models.SavedView:
    data = payload.model_dump()
    return models.SavedView(
        company_id=company_id,
        entity=payload.entity,
        name=payload.name,
        type=payload.type,
        config={key: data[key] for key in VIEW_CONFIG_KEYS},
        owner_user_id=None if payload.shared else owner_user_id,
        position=payload.position,
    )


def _ordered(db: Session, model, company_id: int):
    return list(
        db.scalars(select(model).where(model.company_id == company_id).order_by(model.position, model.id))
    )


def workspace_out(db: Session, company: models.Company, user: models.User) -> schemas.WorkspaceOut:
    settings = workspace.get_settings(db, company.id)
    views = db.scalars(
        select(models.SavedView)
        .where(
            models.SavedView.company_id == company.id,
            or_(models.SavedView.owner_user_id.is_(None), models.SavedView.owner_user_id == user.id),
        )
        .order_by(models.SavedView.position, models.SavedView.id)
    )
    return schemas.WorkspaceOut(
        initialized=settings is not None,
        company=schemas.CompanySummary(
            id=company.id,
            name=company.name,
            plan=company.subscription_status.value.capitalize(),
            timezone=company.timezone,
            trial_ends_at=company.trial_ends_at,
        ),
        config=settings.config if settings else {},
        views=[view_out(v) for v in views],
        dashboards=[dashboard_out(d) for d in _ordered(db, models.Dashboard, company.id)],
        reports=[report_out(r) for r in _ordered(db, models.Report, company.id)],
        integrations=[
            integration_out(c)
            for c in db.scalars(
                select(models.IntegrationConnection).where(models.IntegrationConnection.company_id == company.id)
            )
        ],
    )


def _get(db: Session, model, company_id: int, item_id: int):
    row = db.get(model, item_id)
    if row is None or row.company_id != company_id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail={"code": "not_found", "message": "Не найдено"})
    return row


# --------------------------------------------------------------------------- #
#  Воркспейс целиком
# --------------------------------------------------------------------------- #

@router.get("/workspace", response_model=schemas.WorkspaceOut)
def read_workspace(
    company: models.Company = Depends(get_current_company),
    user: models.User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> schemas.WorkspaceOut:
    return workspace_out(db, company, user)


@router.post("/workspace/bootstrap", response_model=schemas.WorkspaceOut)
def bootstrap_workspace(
    payload: schemas.WorkspaceBootstrap,
    company: models.Company = Depends(get_current_company),
    user: models.User = Depends(require_editor),
    db: Session = Depends(get_db),
) -> schemas.WorkspaceOut:
    """
    Стартовая конфигурация нового воркспейса. Применяется один раз: если
    воркспейс уже настроен (в т.ч. параллельным запросом), возвращает текущий.
    """
    if workspace.get_settings(db, company.id) is None:
        db.add(models.WorkspaceSettings(company_id=company.id, config=_clean_config(payload.config), schema=[]))
        for view in payload.views:
            db.add(_view_row(company.id, view, user.id))
        for i, dashboard in enumerate(payload.dashboards):
            db.add(models.Dashboard(company_id=company.id, **{**dashboard.model_dump(), "position": i}))
        for i, report in enumerate(payload.reports):
            db.add(models.Report(company_id=company.id, position=i, **report.model_dump()))
        try:
            db.commit()
        except IntegrityError:
            db.rollback()
    return workspace_out(db, company, user)


@router.post("/workspace/reset", response_model=schemas.WorkspaceOut)
def reset_workspace(
    company: models.Company = Depends(get_current_company),
    user: models.User = Depends(require_roles(*_ADMIN)),
    db: Session = Depends(get_db),
) -> schemas.WorkspaceOut:
    """Сброс настройки (модули, объекты, представления, дашборды, отчёты). Записи не трогаются."""
    for model in (models.SavedView, models.Dashboard, models.Report, models.WorkspaceSettings):
        db.execute(delete(model).where(model.company_id == company.id))
    db.commit()
    workspace.forget_schema(db, company.id)
    return workspace_out(db, company, user)


@router.patch("/workspace/config", response_model=dict[str, Any])
def patch_config(
    payload: schemas.WorkspaceConfigPatch,
    company: models.Company = Depends(get_current_company),
    _: models.User = Depends(require_editor),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    settings = workspace.get_settings(db, company.id, create=True)
    settings.config = _clean_config({**(settings.config or {}), **payload.config})
    db.commit()
    return settings.config


@router.put("/workspace/schema", status_code=status.HTTP_204_NO_CONTENT)
def put_schema(
    payload: list[schemas.EntitySchema],
    company: models.Company = Depends(get_current_company),
    _: models.User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> None:
    """Определения объектов, как их видит UI. По ним сервер подписывает ленту и считает виджеты."""
    settings = workspace.get_settings(db, company.id, create=True)
    schema = [entity.model_dump(by_alias=True, exclude_none=True) for entity in payload]
    if settings.schema != schema:
        settings.schema = schema
        db.commit()
    workspace.forget_schema(db, company.id)


@router.get("/workspace/export", response_model=schemas.WorkspaceExport)
def export_workspace(
    company: models.Company = Depends(get_current_company),
    _: models.User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> schemas.WorkspaceExport:
    settings = workspace.get_settings(db, company.id)
    shared_views = db.scalars(
        select(models.SavedView)
        .where(models.SavedView.company_id == company.id, models.SavedView.owner_user_id.is_(None))
        .order_by(models.SavedView.position, models.SavedView.id)
    )
    return schemas.WorkspaceExport(
        config=settings.config if settings else {},
        views=[schemas.SavedViewIn.model_validate({k: v for k, v in view_out(v).items() if k != "id"}) for v in shared_views],
        dashboards=[schemas.DashboardIn(name=d.name, icon=d.icon, widgets=d.widgets) for d in _ordered(db, models.Dashboard, company.id)],
        reports=[schemas.ReportIn.model_validate(report_out(r).model_dump()) for r in _ordered(db, models.Report, company.id)],
    )


@router.post("/workspace/import", response_model=schemas.WorkspaceOut)
def import_workspace(
    payload: schemas.WorkspaceExport,
    company: models.Company = Depends(get_current_company),
    user: models.User = Depends(require_roles(*_ADMIN)),
    db: Session = Depends(get_db),
) -> schemas.WorkspaceOut:
    """Заменяет настройку воркспейса шаблоном из JSON (записи остаются)."""
    for model in (models.SavedView, models.Dashboard, models.Report):
        db.execute(delete(model).where(model.company_id == company.id))
    settings = workspace.get_settings(db, company.id, create=True)
    settings.config = _clean_config(payload.config)
    for view in payload.views:
        db.add(_view_row(company.id, view, user.id))
    for i, dashboard in enumerate(payload.dashboards):
        db.add(models.Dashboard(company_id=company.id, **{**dashboard.model_dump(), "position": i}))
    for i, report in enumerate(payload.reports):
        db.add(models.Report(company_id=company.id, position=i, **report.model_dump()))
    db.commit()
    return workspace_out(db, company, user)


# --------------------------------------------------------------------------- #
#  Представления
# --------------------------------------------------------------------------- #

def _own_view(db: Session, company_id: int, user: models.User, view_id: int) -> models.SavedView:
    row = _get(db, models.SavedView, company_id, view_id)
    if row.owner_user_id not in (None, user.id):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail={"code": "not_found", "message": "Не найдено"})
    return row


@router.post("/views", response_model=dict[str, Any], status_code=status.HTTP_201_CREATED)
def create_view(
    payload: schemas.SavedViewIn,
    company: models.Company = Depends(get_current_company),
    user: models.User = Depends(require_editor),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    row = _view_row(company.id, payload, user.id)
    db.add(row)
    db.commit()
    return view_out(row)


@router.patch("/views/{view_id}", response_model=dict[str, Any])
def update_view(
    payload: schemas.SavedViewPatch,
    view_id: int = Path(..., ge=1),
    company: models.Company = Depends(get_current_company),
    user: models.User = Depends(require_editor),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    row = _own_view(db, company.id, user, view_id)
    changes = payload.model_dump(exclude_unset=True)
    config = dict(row.config or {})
    for key in VIEW_CONFIG_KEYS:
        if key in changes:
            config[key] = changes.pop(key)
    row.config = config
    if "shared" in changes:
        row.owner_user_id = None if changes.pop("shared") else user.id
    for key, value in changes.items():
        setattr(row, key, value)
    db.commit()
    return view_out(row)


@router.delete("/views/{view_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_view(
    view_id: int = Path(..., ge=1),
    company: models.Company = Depends(get_current_company),
    user: models.User = Depends(require_editor),
    db: Session = Depends(get_db),
) -> None:
    db.delete(_own_view(db, company.id, user, view_id))
    db.commit()


# --------------------------------------------------------------------------- #
#  Дашборды, отчёты, свои модули
# --------------------------------------------------------------------------- #

@router.post("/dashboards", response_model=schemas.DashboardOut, status_code=status.HTTP_201_CREATED)
def create_dashboard(
    payload: schemas.DashboardIn,
    company: models.Company = Depends(get_current_company),
    _: models.User = Depends(require_editor),
    db: Session = Depends(get_db),
) -> schemas.DashboardOut:
    row = models.Dashboard(company_id=company.id, **payload.model_dump())
    db.add(row)
    db.commit()
    return dashboard_out(row)


@router.patch("/dashboards/{dashboard_id}", response_model=schemas.DashboardOut)
def update_dashboard(
    payload: schemas.DashboardPatch,
    dashboard_id: int = Path(..., ge=1),
    company: models.Company = Depends(get_current_company),
    _: models.User = Depends(require_editor),
    db: Session = Depends(get_db),
) -> schemas.DashboardOut:
    row = _get(db, models.Dashboard, company.id, dashboard_id)
    for key, value in payload.model_dump(exclude_unset=True).items():
        setattr(row, key, value)
    db.commit()
    return dashboard_out(row)


@router.delete("/dashboards/{dashboard_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_dashboard(
    dashboard_id: int = Path(..., ge=1),
    company: models.Company = Depends(get_current_company),
    _: models.User = Depends(require_editor),
    db: Session = Depends(get_db),
) -> None:
    db.delete(_get(db, models.Dashboard, company.id, dashboard_id))
    db.commit()


@router.post("/reports", response_model=schemas.ReportOut, status_code=status.HTTP_201_CREATED)
def create_report(
    payload: schemas.ReportIn,
    company: models.Company = Depends(get_current_company),
    _: models.User = Depends(require_editor),
    db: Session = Depends(get_db),
) -> schemas.ReportOut:
    # Новый отчёт — первым в списке.
    first = db.scalars(
        select(models.Report.position).where(models.Report.company_id == company.id).order_by(models.Report.position)
    ).first()
    row = models.Report(company_id=company.id, position=(first or 0) - 1, **payload.model_dump())
    db.add(row)
    db.commit()
    return report_out(row)


@router.put("/reports/{report_id}", response_model=schemas.ReportOut)
def update_report(
    payload: schemas.ReportIn,
    report_id: int = Path(..., ge=1),
    company: models.Company = Depends(get_current_company),
    _: models.User = Depends(require_editor),
    db: Session = Depends(get_db),
) -> schemas.ReportOut:
    row = _get(db, models.Report, company.id, report_id)
    for key, value in payload.model_dump().items():
        setattr(row, key, value)
    db.commit()
    return report_out(row)


@router.delete("/reports/{report_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_report(
    report_id: int = Path(..., ge=1),
    company: models.Company = Depends(get_current_company),
    _: models.User = Depends(require_editor),
    db: Session = Depends(get_db),
) -> None:
    db.delete(_get(db, models.Report, company.id, report_id))
    db.commit()


# --------------------------------------------------------------------------- #
#  Подключённые приложения (магазин интеграций)
# --------------------------------------------------------------------------- #

def _connection(db: Session, company_id: int, app: str) -> models.IntegrationConnection | None:
    return db.scalars(
        select(models.IntegrationConnection).where(
            models.IntegrationConnection.company_id == company_id,
            models.IntegrationConnection.app == app,
        )
    ).first()


@router.put("/integrations/{app}", response_model=schemas.IntegrationOut)
def connect_integration(
    payload: schemas.IntegrationIn,
    app: str = Path(..., pattern=r"^[a-z0-9_-]{1,64}$"),
    company: models.Company = Depends(get_current_company),
    user: models.User = Depends(require_editor),
    db: Session = Depends(get_db),
) -> schemas.IntegrationOut:
    row = _connection(db, company.id, app)
    if row is None:
        row = models.IntegrationConnection(company_id=company.id, app=app, connected_by_user_id=user.id)
        db.add(row)
    row.account = payload.account
    row.status = payload.status
    row.settings = payload.settings
    db.commit()
    db.refresh(row)
    return integration_out(row)


@router.post("/integrations/{app}/sync", response_model=schemas.IntegrationOut)
def sync_integration(
    app: str = Path(..., pattern=r"^[a-z0-9_-]{1,64}$"),
    company: models.Company = Depends(get_current_company),
    _: models.User = Depends(require_editor),
    db: Session = Depends(get_db),
) -> schemas.IntegrationOut:
    row = _connection(db, company.id, app)
    if row is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail={"code": "integration_not_connected", "message": "Приложение не подключено"})
    row.status = "connected"
    row.last_synced_at = datetime.now(timezone.utc)
    db.commit()
    db.refresh(row)
    return integration_out(row)


@router.delete("/integrations/{app}", status_code=status.HTTP_204_NO_CONTENT)
def disconnect_integration(
    app: str = Path(..., pattern=r"^[a-z0-9_-]{1,64}$"),
    company: models.Company = Depends(get_current_company),
    _: models.User = Depends(require_editor),
    db: Session = Depends(get_db),
) -> None:
    row = _connection(db, company.id, app)
    if row is not None:
        db.delete(row)
        db.commit()
