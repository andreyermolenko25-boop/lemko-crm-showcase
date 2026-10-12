"""
Точка входа API Lemko CRM.

Схема БД больше не создаётся кодом: ею управляет Alembic.
Перед первым запуском и после каждого изменения models.py выполняй:
    alembic revision --autogenerate -m "что изменилось"
    alembic upgrade head

Изоляция тенантов: company_id никогда не приходит из тела запроса, он берётся
из подписанного JWT (см. core.deps) и сверяется с company_id в URL.

Бизнес-логика живёт в модулях (scheduling, inventory, crm, finance, records…);
их доменные ошибки превращает в ответы core.errors.
"""

from datetime import datetime

from fastapi import Depends, FastAPI, File, Form, HTTPException, Path, Query, UploadFile, status
from fastapi.responses import FileResponse, RedirectResponse
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

import attachments
import audit
import crm
import finance
import inventory
import models
import schemas
import scheduling
import softdelete
from core.auth import trial_ends_at
from core.database import get_db
from core.deps import get_current_company, get_current_user, require_roles
from core.errors import install_error_handlers
from core.middleware import setup_core_middleware
from core.security import hash_password
from routers import activities as activities_router
from routers import analytics as analytics_router
from routers import auth as auth_router
from routers import external as external_router
from routers import integrations as integrations_router
from routers import members as members_router
from routers import records as records_router
from routers import security as security_router
from routers import workspace as workspace_router
from core import ratelimit
from core.config import settings
from core.request_context import client_ip
from fastapi import Request
from storage import get_storage

app = FastAPI(
    title="Lemko CRM API",
    version="0.4.0",
    description=(
        "Мульти-тенантное ядро CRM. Порядок работы: "
        "POST /auth/register (студия) -> POST /auth/login (токен) -> "
        "кнопка Authorize в Swagger -> остальные эндпоинты."
    ),
    # Карта API не публикуется в проде: меньше поверхности для разведки.
    docs_url="/docs" if settings.DEBUG else None,
    redoc_url="/redoc" if settings.DEBUG else None,
    openapi_url="/openapi.json" if settings.DEBUG else None,
)

setup_core_middleware(app)
install_error_handlers(app)

app.include_router(auth_router.router)
app.include_router(integrations_router.router)
app.include_router(external_router.router)
# Схема-ориентированный UI: объекты, конфигурация воркспейса, лента, аналитика.
app.include_router(records_router.router)
app.include_router(workspace_router.router)
app.include_router(activities_router.router)
app.include_router(analytics_router.router)
app.include_router(members_router.router)
app.include_router(security_router.router)
app.include_router(security_router.sessions_router)
app.include_router(security_router.policy_router)


@app.get("/", tags=["service"])
def root() -> dict[str, str]:
    return {"message": "Сервер Lemko CRM успешно запущен!", "status": "OK"}


def _as_utc(value: datetime | None, field_name: str) -> datetime | None:
    """Приводит фильтр-параметр к UTC, требуя указанный часовой пояс."""
    if value is None:
        return None
    try:
        return schemas.require_aware_utc(value)
    except ValueError as exc:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail={"code": "invalid_datetime", "message": f"{field_name}: {exc}", "field": field_name},
        )


def _allow_deleted(actor: models.User, include_deleted: bool) -> bool:
    if not include_deleted:
        return False
    if actor.role not in (models.UserRole.OWNER, models.UserRole.ADMIN):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail={"code": "archive_forbidden", "message": "Архив доступен владельцу и администратору"},
        )
    return True


# --------------------------------------------------------------------------- #
#  Регистрация компании (тенанта) — legacy; предпочитай POST /auth/register
# --------------------------------------------------------------------------- #

@app.post(
    "/companies",
    response_model=schemas.CompanyRegisterResult,
    status_code=status.HTTP_201_CREATED,
    tags=["companies"],
)
def register_company(
    payload: schemas.CompanyCreate,
    request: Request,
    db: Session = Depends(get_db),
) -> schemas.CompanyRegisterResult:
    """
    Регистрирует нового клиента SaaS вместе с его владельцем.

    Единственный публичный эндпоинт создания данных: он решает проблему
    "первого пользователя", ведь все остальные требуют токен.
    Ограничено по IP, как и /auth/register.
    """
    ratelimit.hit(db, f"register:ip:{client_ip(request)}", limit=10, window=3600)
    company = models.Company(
        name=payload.name,
        niche=payload.niche,
        settings=payload.settings,
        timezone=payload.timezone,
        intake_settings=payload.intake_settings,
        subscription_status=models.SubscriptionStatus.TRIAL,
        trial_ends_at=trial_ends_at(),
    )
    owner = models.User(
        username=payload.owner.username,
        # Роль владельца форсируем: при регистрации нельзя создать сразу
        # сотрудника с урезанными правами и остаться без администратора.
        role=models.UserRole.OWNER,
        hashed_password=hash_password(payload.owner.password),
    )
    company.users.append(owner)  # company_id проставится каскадом при flush

    db.add(company)
    db.commit()
    db.refresh(company)
    db.refresh(owner)

    return schemas.CompanyRegisterResult(
        company=schemas.CompanyRead.model_validate(company),
        owner=schemas.UserRead.model_validate(owner),
    )


@app.get(
    "/companies/{company_id}",
    response_model=schemas.CompanyRead,
    tags=["companies"],
)
def read_company(
    company: models.Company = Depends(get_current_company),
) -> models.Company:
    return company


@app.patch(
    "/companies/{company_id}",
    response_model=schemas.CompanyRead,
    tags=["companies"],
)
def update_company(
    payload: schemas.CompanyUpdate,
    company: models.Company = Depends(get_current_company),
    _: models.User = Depends(require_roles(models.UserRole.OWNER)),
    db: Session = Depends(get_db),
) -> models.Company:
    """Часовой пояс, имя, настройки. Только владелец: от пояса зависят графики по дням."""
    for field, value in payload.model_dump(exclude_unset=True).items():
        setattr(company, field, value)
    db.commit()
    db.refresh(company)
    return company


@app.get(
    "/companies/{company_id}/audit-logs",
    response_model=list[schemas.AuditLogRead],
    tags=["audit"],
)
def list_audit_logs(
    company: models.Company = Depends(get_current_company),
    _: models.User = Depends(require_roles(models.UserRole.OWNER, models.UserRole.ADMIN)),
    db: Session = Depends(get_db),
    entity_type: str | None = Query(default=None, max_length=64),
    entity_id: int | None = Query(default=None, ge=1),
    actor_user_id: int | None = Query(default=None, ge=1),
    action: models.AuditAction | None = Query(default=None),
    date_from: datetime | None = Query(default=None),
    date_to: datetime | None = Query(default=None),
    limit: int = Query(default=50, ge=1, le=200),
    offset: int = Query(default=0, ge=0),
) -> list[models.AuditLog]:
    """Журнал изменений тенанта. Чтения не пишутся; строки нельзя править."""
    return audit.list_logs(
        db,
        company_id=company.id,
        entity_type=entity_type,
        entity_id=entity_id,
        actor_user_id=actor_user_id,
        action=action,
        date_from=_as_utc(date_from, "date_from"),
        date_to=_as_utc(date_to, "date_to"),
        limit=limit,
        offset=offset,
    )


# --------------------------------------------------------------------------- #
#  Вложения
# --------------------------------------------------------------------------- #

@app.post(
    "/companies/{company_id}/attachments",
    response_model=schemas.AttachmentRead,
    status_code=status.HTTP_201_CREATED,
    tags=["attachments"],
)
def upload_attachment(
    company: models.Company = Depends(get_current_company),
    user: models.User = Depends(get_current_user),
    db: Session = Depends(get_db),
    file: UploadFile = File(...),
    entity_type: models.AttachmentEntityType = Form(...),
    entity_id: int = Form(..., ge=1),
) -> models.Attachment:
    """
    Единая загрузка файла: фото до/после, рентген, PDF-акт, логотип воркспейса.
    Ниша потом кладёт attachment.id в extra_data визита/клиента.
    """
    row = attachments.create_attachment(
        db,
        company_id=company.id,
        actor_user_id=user.id,
        entity_type=entity_type,
        entity_id=entity_id,
        data=file.file.read(),
        mime_type=file.content_type,
        filename=file.filename,
    )
    db.commit()
    db.refresh(row)
    return row


@app.get(
    "/companies/{company_id}/attachments",
    response_model=list[schemas.AttachmentRead],
    tags=["attachments"],
)
def list_attachments(
    company: models.Company = Depends(get_current_company),
    db: Session = Depends(get_db),
    entity_type: models.AttachmentEntityType | None = Query(default=None),
    entity_id: int | None = Query(default=None, ge=1),
    limit: int = Query(default=50, ge=1, le=200),
    offset: int = Query(default=0, ge=0),
) -> list[models.Attachment]:
    return attachments.list_attachments(
        db,
        company_id=company.id,
        entity_type=entity_type,
        entity_id=entity_id,
        limit=limit,
        offset=offset,
    )


@app.get(
    "/companies/{company_id}/attachments/{attachment_id}",
    response_model=schemas.AttachmentRead,
    tags=["attachments"],
)
def read_attachment(
    attachment_id: int = Path(..., ge=1),
    company: models.Company = Depends(get_current_company),
    db: Session = Depends(get_db),
) -> models.Attachment:
    return attachments.get_attachment(db, company_id=company.id, attachment_id=attachment_id)


@app.get(
    "/companies/{company_id}/attachments/{attachment_id}/content",
    tags=["attachments"],
)
def download_attachment(
    attachment_id: int = Path(..., ge=1),
    company: models.Company = Depends(get_current_company),
    db: Session = Depends(get_db),
):
    """Байты файла. Локальный диск — поток, S3/MinIO — временный URL."""
    row = attachments.get_attachment(db, company_id=company.id, attachment_id=attachment_id)
    storage = get_storage()
    path = storage.open_path(key=row.storage_key)
    if path is not None:
        return FileResponse(
            path,
            media_type=row.mime_type,
            filename=row.original_filename or path.name,
        )
    url = storage.presign_get(key=row.storage_key)
    if url:
        return RedirectResponse(url, status_code=status.HTTP_307_TEMPORARY_REDIRECT)
    raise HTTPException(
        status_code=status.HTTP_404_NOT_FOUND,
        detail={"code": "blob_missing", "message": "Файл не найден в хранилище"},
    )


@app.delete(
    "/companies/{company_id}/attachments/{attachment_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    tags=["attachments"],
)
def delete_attachment(
    attachment_id: int = Path(..., ge=1),
    company: models.Company = Depends(get_current_company),
    _: models.User = Depends(
        require_roles(models.UserRole.OWNER, models.UserRole.ADMIN, models.UserRole.MANAGER)
    ),
    db: Session = Depends(get_db),
) -> None:
    attachments.delete_attachment(db, company_id=company.id, attachment_id=attachment_id)
    db.commit()


# --------------------------------------------------------------------------- #
#  Сотрудники
# --------------------------------------------------------------------------- #

def _require_user(db: Session, company_id: int, user_id: int, *, include_deleted: bool = False):
    target = softdelete.get_user(
        db, company_id=company_id, user_id=user_id, include_deleted=include_deleted
    )
    if target is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={"code": "member_not_found", "message": "Сотрудник не найден в этой компании"},
        )
    return target


@app.post(
    "/companies/{company_id}/users",
    response_model=schemas.UserRead,
    status_code=status.HTTP_201_CREATED,
    tags=["users"],
)
def create_user(
    payload: schemas.UserCreate,
    company: models.Company = Depends(get_current_company),
    actor: models.User = Depends(require_roles(models.UserRole.OWNER, models.UserRole.ADMIN)),
    db: Session = Depends(get_db),
) -> models.User:
    """Создаёт сотрудника. Доступно только владельцу и администратору."""
    if payload.role == models.UserRole.OWNER and actor.role != models.UserRole.OWNER:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail={"code": "owner_assign_forbidden", "message": "Назначить владельца может только другой владелец"},
        )
    user = models.User(
        company_id=company.id,
        username=payload.username,
        role=payload.role,
        hashed_password=hash_password(payload.password),
    )
    db.add(user)
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={"code": "username_taken", "message": "Сотрудник с таким логином уже есть в этой компании"},
        )
    db.refresh(user)
    return user


@app.get(
    "/companies/{company_id}/users",
    response_model=list[schemas.UserRead],
    tags=["users"],
)
def list_users(
    company: models.Company = Depends(get_current_company),
    actor: models.User = Depends(get_current_user),
    db: Session = Depends(get_db),
    include_deleted: bool = Query(default=False),
    limit: int = Query(default=50, ge=1, le=200),
    offset: int = Query(default=0, ge=0),
) -> list[models.User]:
    """Живые сотрудники. include_deleted — только владелец/админ, для кадровой истории."""
    stmt = select(models.User).where(models.User.company_id == company.id)
    if not _allow_deleted(actor, include_deleted):
        stmt = stmt.where(models.is_alive(models.User))
    stmt = stmt.order_by(models.User.username).limit(limit).offset(offset)
    return list(db.scalars(stmt))


@app.get(
    "/companies/{company_id}/users/{user_id}",
    response_model=schemas.UserRead,
    tags=["users"],
)
def read_user(
    user_id: int = Path(..., ge=1),
    company: models.Company = Depends(get_current_company),
    actor: models.User = Depends(get_current_user),
    db: Session = Depends(get_db),
    include_deleted: bool = Query(default=False),
) -> models.User:
    return _require_user(
        db, company.id, user_id, include_deleted=_allow_deleted(actor, include_deleted)
    )


@app.delete(
    "/companies/{company_id}/users/{user_id}",
    response_model=schemas.UserRead,
    tags=["users"],
)
def delete_user(
    user_id: int = Path(..., ge=1),
    company: models.Company = Depends(get_current_company),
    actor: models.User = Depends(require_roles(models.UserRole.OWNER, models.UserRole.ADMIN)),
    db: Session = Depends(get_db),
) -> models.User:
    """
    Увольнение: deleted_at, не SQL DELETE. Визиты и касса остаются.
    Из расписания мастер пропадает (новые записи и смены — 404).
    """
    target = _require_user(db, company.id, user_id)
    softdelete.archive_user(db, company_id=company.id, target=target, actor=actor)
    db.commit()
    db.refresh(target)
    return target


@app.post(
    "/companies/{company_id}/users/{user_id}/restore",
    response_model=schemas.UserRead,
    tags=["users"],
)
def restore_user(
    user_id: int = Path(..., ge=1),
    company: models.Company = Depends(get_current_company),
    _: models.User = Depends(require_roles(models.UserRole.OWNER, models.UserRole.ADMIN)),
    db: Session = Depends(get_db),
) -> models.User:
    target = _require_user(db, company.id, user_id, include_deleted=True)
    if target.deleted_at is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={"code": "archived_member_not_found", "message": "Архивный сотрудник не найден"},
        )
    softdelete.restore(target)
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={"code": "username_taken", "message": "Сотрудник с таким логином уже есть в этой компании"},
        )
    db.refresh(target)
    return target


@app.patch(
    "/companies/{company_id}/users/{user_id}",
    response_model=schemas.UserRead,
    tags=["users"],
)
def update_user(
    payload: schemas.UserUpdate,
    user_id: int = Path(..., ge=1),
    company: models.Company = Depends(get_current_company),
    actor: models.User = Depends(require_roles(models.UserRole.OWNER, models.UserRole.ADMIN)),
    db: Session = Depends(get_db),
) -> models.User:
    """Смена роли и блокировка."""
    target = _require_user(db, company.id, user_id)
    softdelete.change_role(
        db, company_id=company.id, target=target, actor=actor, **payload.model_dump(exclude_unset=True)
    )
    db.commit()
    db.refresh(target)
    return target


# --------------------------------------------------------------------------- #
#  Клиенты бизнеса
# --------------------------------------------------------------------------- #

@app.post(
    "/companies/{company_id}/clients",
    response_model=schemas.ClientRead,
    status_code=status.HTTP_201_CREATED,
    tags=["clients"],
)
def create_client(
    payload: schemas.ClientCreate,
    company: models.Company = Depends(get_current_company),
    db: Session = Depends(get_db),
) -> models.Client:
    """
    Создаёт клиента. extra_data проверяется схемой ниши компании (детейлинг —
    авто, стоматология — медкарта); company_id подставляет сервер.
    """
    client = crm.create_client(db, company=company, **payload.model_dump())
    db.commit()
    db.refresh(client)
    return client


@app.patch(
    "/companies/{company_id}/clients/{client_id}",
    response_model=schemas.ClientRead,
    tags=["clients"],
)
def update_client(
    payload: schemas.ClientUpdate,
    client_id: int = Path(..., ge=1),
    company: models.Company = Depends(get_current_company),
    db: Session = Depends(get_db),
) -> models.Client:
    """Обновление карточки клиента (имя, телефон, extra_data)."""
    client = crm.require_client(db, company_id=company.id, client_id=client_id)
    crm.update_client(
        db, company=company, client=client, changes=payload.model_dump(exclude_unset=True)
    )
    db.commit()
    db.refresh(client)
    return client


@app.get(
    "/companies/{company_id}/clients",
    response_model=schemas.PaginatedClients,
    tags=["clients"],
)
def list_clients(
    company: models.Company = Depends(get_current_company),
    actor: models.User = Depends(get_current_user),
    db: Session = Depends(get_db),
    search: str | None = Query(default=None, description="Поиск по имени, телефону или госномеру"),
    include_deleted: bool = Query(default=False),
    limit: int = Query(default=50, ge=1, le=200),
    offset: int = Query(default=0, ge=0),
) -> schemas.PaginatedClients:
    """Список клиентов компании с пагинацией. Фильтр по company_id обязателен всегда."""
    items, total = crm.list_clients(
        db,
        company_id=company.id,
        search=search,
        include_deleted=_allow_deleted(actor, include_deleted),
        limit=limit,
        offset=offset,
    )
    return schemas.PaginatedClients(
        total=total,
        items=[schemas.ClientRead.model_validate(c) for c in items],
    )


@app.get(
    "/companies/{company_id}/clients/{client_id}",
    response_model=schemas.ClientRead,
    tags=["clients"],
)
def read_client(
    client_id: int = Path(..., ge=1),
    company: models.Company = Depends(get_current_company),
    actor: models.User = Depends(get_current_user),
    db: Session = Depends(get_db),
    include_deleted: bool = Query(default=False),
) -> models.Client:
    return crm.require_client(
        db,
        company_id=company.id,
        client_id=client_id,
        include_deleted=_allow_deleted(actor, include_deleted),
    )


@app.get(
    "/companies/{company_id}/clients/{client_id}/profile",
    response_model=schemas.ClientProfileRead,
    tags=["clients"],
)
def read_client_profile(
    client_id: int = Path(..., ge=1),
    company: models.Company = Depends(get_current_company),
    actor: models.User = Depends(get_current_user),
    db: Session = Depends(get_db),
    include_deleted: bool = Query(default=False),
    notes_limit: int = Query(default=20, ge=1, le=100),
    notes_offset: int = Query(default=0, ge=0),
) -> schemas.ClientProfileRead:
    """
    Карточка клиента для администратора: LTV, визиты, % отмен, долг, заметки.
    Цифры считаются из визитов и кассы, а не хранятся.
    """
    client = crm.require_client(
        db,
        company_id=company.id,
        client_id=client_id,
        include_deleted=_allow_deleted(actor, include_deleted),
    )
    stats = crm.client_stats(db, company_id=company.id, client_id=client_id)
    notes, notes_total = crm.list_notes(
        db, company_id=company.id, client_id=client_id, limit=notes_limit, offset=notes_offset
    )
    return schemas.ClientProfileRead(
        client=schemas.ClientRead.model_validate(client),
        visits_total=stats.visits_total,
        visits_completed=stats.visits_completed,
        visits_cancelled=stats.visits_cancelled,
        visits_upcoming=stats.visits_upcoming,
        cancellation_rate=stats.cancellation_rate,
        ltv=stats.ltv,
        outstanding_debt=stats.outstanding_debt,
        last_visit_at=stats.last_visit_at,
        next_visit_at=stats.next_visit_at,
        notes=[schemas.ClientNoteRead.model_validate(note) for note in notes],
        notes_total=notes_total,
    )


@app.post(
    "/companies/{company_id}/clients/{client_id}/notes",
    response_model=schemas.ClientNoteRead,
    status_code=status.HTTP_201_CREATED,
    tags=["clients"],
)
def create_client_note(
    payload: schemas.ClientNoteCreate,
    client_id: int = Path(..., ge=1),
    company: models.Company = Depends(get_current_company),
    user: models.User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> models.ClientNote:
    note = crm.add_note(
        db,
        company_id=company.id,
        client_id=client_id,
        author_user_id=user.id,
        body=payload.body,
        is_pinned=payload.is_pinned,
    )
    db.commit()
    db.refresh(note)
    return note


@app.get(
    "/companies/{company_id}/clients/{client_id}/notes",
    response_model=list[schemas.ClientNoteRead],
    tags=["clients"],
)
def list_client_notes(
    client_id: int = Path(..., ge=1),
    company: models.Company = Depends(get_current_company),
    db: Session = Depends(get_db),
    limit: int = Query(default=50, ge=1, le=200),
    offset: int = Query(default=0, ge=0),
) -> list[models.ClientNote]:
    notes, _total = crm.list_notes(
        db, company_id=company.id, client_id=client_id, limit=limit, offset=offset
    )
    return notes


@app.delete(
    "/companies/{company_id}/clients/{client_id}/notes/{note_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    tags=["clients"],
)
def delete_client_note(
    client_id: int = Path(..., ge=1),
    note_id: int = Path(..., ge=1),
    company: models.Company = Depends(get_current_company),
    db: Session = Depends(get_db),
) -> None:
    crm.delete_note(db, company_id=company.id, client_id=client_id, note_id=note_id)
    db.commit()


@app.delete(
    "/companies/{company_id}/clients/{client_id}",
    response_model=schemas.ClientRead,
    tags=["clients"],
)
def delete_client(
    client_id: int = Path(..., ge=1),
    company: models.Company = Depends(get_current_company),
    _: models.User = Depends(
        require_roles(models.UserRole.OWNER, models.UserRole.ADMIN, models.UserRole.MANAGER)
    ),
    db: Session = Depends(get_db),
) -> models.Client:
    """Архив: визиты и оплаты остаются, из операционных списков клиент исчезает."""
    client = crm.require_client(db, company_id=company.id, client_id=client_id)
    softdelete.archive_client(db, company_id=company.id, client=client)
    db.commit()
    db.refresh(client)
    return client


@app.post(
    "/companies/{company_id}/clients/{client_id}/restore",
    response_model=schemas.ClientRead,
    tags=["clients"],
)
def restore_client(
    client_id: int = Path(..., ge=1),
    company: models.Company = Depends(get_current_company),
    _: models.User = Depends(
        require_roles(models.UserRole.OWNER, models.UserRole.ADMIN, models.UserRole.MANAGER)
    ),
    db: Session = Depends(get_db),
) -> models.Client:
    client = crm.require_client(
        db, company_id=company.id, client_id=client_id, include_deleted=True
    )
    if client.deleted_at is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={"code": "archived_client_not_found", "message": "Архивный клиент не найден"},
        )
    softdelete.restore(client)
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise crm.DuplicatePhoneError(client.phone)
    db.refresh(client)
    return client


# --------------------------------------------------------------------------- #
#  Прайс-лист (услуги)
# --------------------------------------------------------------------------- #

def _service_read(db: Session, company_id: int, service_id: int) -> models.Service:
    return inventory.require_service(
        db, company_id=company_id, service_id=service_id, active_only=False
    )


@app.post(
    "/companies/{company_id}/services",
    response_model=schemas.ServiceRead,
    status_code=status.HTTP_201_CREATED,
    tags=["services"],
)
def create_service(
    payload: schemas.ServiceCreate,
    company: models.Company = Depends(get_current_company),
    db: Session = Depends(get_db),
) -> models.Service:
    """Добавляет услугу в прайс-лист. Рецепт материалов можно передать сразу."""
    service = inventory.create_service(
        db,
        company_id=company.id,
        name=payload.name,
        description=payload.description,
        base_price=payload.base_price,
        duration_minutes=payload.duration_minutes,
        materials=[(row.inventory_item_id, row.quantity) for row in payload.materials],
    )
    db.commit()
    return _service_read(db, company.id, service.id)


@app.get(
    "/companies/{company_id}/services",
    response_model=list[schemas.ServiceRead],
    tags=["services"],
)
def list_services(
    company: models.Company = Depends(get_current_company),
    db: Session = Depends(get_db),
    include_inactive: bool = Query(default=False),
) -> list[models.Service]:
    stmt = (
        select(models.Service)
        .options(*inventory._service_load_options())
        .where(models.Service.company_id == company.id, models.is_alive(models.Service))
        .order_by(models.Service.name)
    )
    if not include_inactive:
        stmt = stmt.where(models.Service.is_active.is_(True))
    return list(db.scalars(stmt).unique())


@app.get(
    "/companies/{company_id}/services/{service_id}",
    response_model=schemas.ServiceRead,
    tags=["services"],
)
def read_service(
    service_id: int = Path(..., ge=1),
    company: models.Company = Depends(get_current_company),
    db: Session = Depends(get_db),
) -> models.Service:
    return _service_read(db, company.id, service_id)


@app.patch(
    "/companies/{company_id}/services/{service_id}",
    response_model=schemas.ServiceRead,
    tags=["services"],
)
def update_service(
    payload: schemas.ServiceUpdate,
    service_id: int = Path(..., ge=1),
    company: models.Company = Depends(get_current_company),
    db: Session = Depends(get_db),
) -> models.Service:
    service = _service_read(db, company.id, service_id)
    inventory.update_service(db, service=service, changes=payload.model_dump(exclude_unset=True))
    db.commit()
    db.refresh(service)
    return _service_read(db, company.id, service.id)


@app.put(
    "/companies/{company_id}/services/{service_id}/materials",
    response_model=schemas.ServiceRead,
    tags=["services"],
)
def replace_service_materials(
    payload: schemas.ServiceMaterialsReplace,
    service_id: int = Path(..., ge=1),
    company: models.Company = Depends(get_current_company),
    db: Session = Depends(get_db),
) -> models.Service:
    """
    Заменяет рецепт услуги целиком. Несуществующая или чужая складская
    позиция — 404 с конкретным inventory_item_id.
    """
    service = _service_read(db, company.id, service_id)
    inventory.set_materials(
        db,
        company_id=company.id,
        service=service,
        materials=[(row.inventory_item_id, row.quantity) for row in payload.materials],
    )
    db.commit()
    return _service_read(db, company.id, service_id)


# --------------------------------------------------------------------------- #
#  Склад
# --------------------------------------------------------------------------- #

@app.post(
    "/companies/{company_id}/inventory",
    response_model=schemas.InventoryItemRead,
    status_code=status.HTTP_201_CREATED,
    tags=["inventory"],
)
def create_inventory_item(
    payload: schemas.InventoryItemCreate,
    company: models.Company = Depends(get_current_company),
    user: models.User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> models.InventoryItem:
    """Создаёт складскую позицию. Начальный остаток проводится как приход."""
    item = inventory.create_item(
        db,
        company_id=company.id,
        name=payload.name,
        sku=payload.sku,
        unit=payload.unit,
        low_stock_threshold=payload.low_stock_threshold,
        initial_quantity=payload.initial_quantity,
        created_by_user_id=user.id,
    )
    db.commit()
    db.refresh(item)
    return item


@app.get(
    "/companies/{company_id}/inventory",
    response_model=list[schemas.InventoryItemRead],
    tags=["inventory"],
)
def list_inventory(
    company: models.Company = Depends(get_current_company),
    db: Session = Depends(get_db),
    include_inactive: bool = Query(default=False),
    low_stock_only: bool = Query(default=False, description="Только заканчивающиеся позиции"),
) -> list[models.InventoryItem]:
    stmt = (
        select(models.InventoryItem)
        .where(
            models.InventoryItem.company_id == company.id,
            models.is_alive(models.InventoryItem),
        )
        .order_by(models.InventoryItem.name)
    )
    if not include_inactive:
        stmt = stmt.where(models.InventoryItem.is_active.is_(True))
    items = list(db.scalars(stmt))
    if low_stock_only:
        items = [item for item in items if item.is_low_stock]
    return items


@app.get(
    "/companies/{company_id}/inventory/{item_id}",
    response_model=schemas.InventoryItemRead,
    tags=["inventory"],
)
def read_inventory_item(
    item_id: int = Path(..., ge=1),
    company: models.Company = Depends(get_current_company),
    db: Session = Depends(get_db),
) -> models.InventoryItem:
    return inventory.require_item(db, company_id=company.id, item_id=item_id, active_only=False)


@app.patch(
    "/companies/{company_id}/inventory/{item_id}",
    response_model=schemas.InventoryItemRead,
    tags=["inventory"],
)
def update_inventory_item(
    payload: schemas.InventoryItemUpdate,
    item_id: int = Path(..., ge=1),
    company: models.Company = Depends(get_current_company),
    db: Session = Depends(get_db),
) -> models.InventoryItem:
    item = inventory.require_item(db, company_id=company.id, item_id=item_id, active_only=False)
    inventory.update_item(db, item=item, changes=payload.model_dump(exclude_unset=True))
    db.commit()
    db.refresh(item)
    return item


@app.post(
    "/companies/{company_id}/inventory/{item_id}/movements",
    response_model=schemas.StockMovementRead,
    status_code=status.HTTP_201_CREATED,
    tags=["inventory"],
)
def create_stock_movement(
    payload: schemas.StockMovementCreate,
    item_id: int = Path(..., ge=1),
    company: models.Company = Depends(get_current_company),
    user: models.User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> models.StockMovement:
    """Приход, корректировка или списание брака. Расход на услугу — автоматический."""
    item = inventory.require_item(db, company_id=company.id, item_id=item_id, for_update=True)
    movement = inventory.apply_movement(
        db,
        item=item,
        delta=payload.delta,
        reason=payload.reason,
        created_by_user_id=user.id,
        note=payload.note,
    )
    try:
        db.commit()
    except IntegrityError as exc:
        db.rollback()
        if inventory.is_quantity_violation(exc):
            raise inventory.InsufficientStockError(item, payload.delta)
        raise
    db.refresh(movement)
    return movement


@app.get(
    "/companies/{company_id}/inventory/{item_id}/movements",
    response_model=list[schemas.StockMovementRead],
    tags=["inventory"],
)
def list_stock_movements(
    item_id: int = Path(..., ge=1),
    company: models.Company = Depends(get_current_company),
    db: Session = Depends(get_db),
    limit: int = Query(default=100, ge=1, le=500),
    offset: int = Query(default=0, ge=0),
) -> list[models.StockMovement]:
    inventory.require_item(db, company_id=company.id, item_id=item_id, active_only=False)
    stmt = (
        select(models.StockMovement)
        .where(
            models.StockMovement.company_id == company.id,
            models.StockMovement.inventory_item_id == item_id,
        )
        .order_by(models.StockMovement.created_at.desc())
        .limit(limit)
        .offset(offset)
    )
    return list(db.scalars(stmt))


# --------------------------------------------------------------------------- #
#  Смены (график работы)
# --------------------------------------------------------------------------- #

_ROSTER_ROLES = (models.UserRole.OWNER, models.UserRole.ADMIN, models.UserRole.MANAGER)


def _work_shift_read(shift: models.WorkShift, tz_name: str) -> schemas.WorkShiftRead:
    parts = scheduling.local_shift_segments(shift.starts_at, shift.ends_at, tz_name)
    return schemas.WorkShiftRead(
        id=shift.id,
        company_id=shift.company_id,
        user_id=shift.user_id,
        starts_at=shift.starts_at,
        ends_at=shift.ends_at,
        title=shift.title,
        created_at=shift.created_at,
        timezone=tz_name,
        spans_midnight=len(parts) > 1,
        segments=[
            schemas.WorkShiftDaySegment(date=day, starts_at=start, ends_at=end)
            for day, start, end in parts
        ],
    )


@app.post(
    "/companies/{company_id}/work-shifts",
    response_model=schemas.WorkShiftRead,
    status_code=status.HTTP_201_CREATED,
    tags=["work-shifts"],
)
def create_work_shift(
    payload: schemas.WorkShiftCreate,
    company: models.Company = Depends(get_current_company),
    _: models.User = Depends(require_roles(*_ROSTER_ROLES)),
    db: Session = Depends(get_db),
) -> schemas.WorkShiftRead:
    """
    Смена, внутри которой можно записывать клиентов к этому мастеру.

    Ночь 20:00–08:00 следующих суток — нормально: это один интервал timestamptz.
    В ответе segments разбивает его по календарным дням пояса компании.
    """
    shift = scheduling.create_shift(db, company_id=company.id, **payload.model_dump())
    db.commit()
    db.refresh(shift)
    return _work_shift_read(shift, company.timezone)


@app.get(
    "/companies/{company_id}/work-shifts",
    response_model=list[schemas.WorkShiftRead],
    tags=["work-shifts"],
)
def list_work_shifts(
    company: models.Company = Depends(get_current_company),
    user: models.User = Depends(get_current_user),
    db: Session = Depends(get_db),
    user_id: int | None = Query(default=None, ge=1),
    date_from: datetime | None = Query(default=None),
    date_to: datetime | None = Query(default=None),
    limit: int = Query(default=100, ge=1, le=500),
    offset: int = Query(default=0, ge=0),
) -> list[schemas.WorkShiftRead]:
    """
    График смен. Окно date_from/date_to — пересечение интервалов, не DATE(starts_at):
    ночная смена, начавшаяся вчера, попадёт в сетку сегодняшнего утра.
    """
    date_from = _as_utc(date_from, "date_from")
    date_to = _as_utc(date_to, "date_to")
    stmt = (
        select(models.WorkShift)
        .join(models.User, models.User.id == models.WorkShift.user_id)
        .where(models.WorkShift.company_id == company.id, models.is_alive(models.User))
    )
    # Мастер видит только свой график.
    if user.role == models.UserRole.STAFF:
        stmt = stmt.where(models.WorkShift.user_id == user.id)
    elif user_id is not None:
        stmt = stmt.where(models.WorkShift.user_id == user_id)
    if date_from is not None:
        stmt = stmt.where(models.WorkShift.ends_at > date_from)
    if date_to is not None:
        stmt = stmt.where(models.WorkShift.starts_at < date_to)
    stmt = stmt.order_by(models.WorkShift.starts_at).limit(limit).offset(offset)
    return [_work_shift_read(item, company.timezone) for item in db.scalars(stmt)]


@app.patch(
    "/companies/{company_id}/work-shifts/{shift_id}",
    response_model=schemas.WorkShiftRead,
    tags=["work-shifts"],
)
def update_work_shift(
    payload: schemas.WorkShiftUpdate,
    shift_id: int = Path(..., ge=1),
    company: models.Company = Depends(get_current_company),
    _: models.User = Depends(require_roles(*_ROSTER_ROLES)),
    db: Session = Depends(get_db),
) -> schemas.WorkShiftRead:
    shift = scheduling.require_shift(db, company_id=company.id, shift_id=shift_id, for_update=True)
    scheduling.change_shift(db, shift=shift, changes=payload.model_dump(exclude_unset=True))
    db.commit()
    db.refresh(shift)
    return _work_shift_read(shift, company.timezone)


@app.delete(
    "/companies/{company_id}/work-shifts/{shift_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    tags=["work-shifts"],
)
def delete_work_shift(
    shift_id: int = Path(..., ge=1),
    company: models.Company = Depends(get_current_company),
    _: models.User = Depends(require_roles(*_ROSTER_ROLES)),
    db: Session = Depends(get_db),
) -> None:
    shift = scheduling.require_shift(db, company_id=company.id, shift_id=shift_id, for_update=True)
    scheduling.delete_shift(db, shift=shift)
    db.commit()


# --------------------------------------------------------------------------- #
#  Записи на приём
# --------------------------------------------------------------------------- #

def _appointment_read(
    appointment: models.Appointment,
    balance: finance.AppointmentBalance,
) -> schemas.AppointmentRead:
    """ORM-визит + посчитанный баланс → ответ API."""
    payload = schemas.AppointmentRead.model_validate(appointment, from_attributes=True)
    return payload.model_copy(
        update={
            "payment": schemas.AppointmentPaymentRead(
                due=balance.due,
                paid=balance.paid,
                remaining=balance.remaining,
                status=balance.status,
            )
        }
    )


@app.post(
    "/companies/{company_id}/appointments",
    response_model=schemas.AppointmentRead,
    status_code=status.HTTP_201_CREATED,
    tags=["appointments"],
    responses={
        404: {"description": "Нет услуги или клиента/мастера"},
        409: {"description": "Мастер занят или визит вне смены"},
    },
)
def create_appointment(
    payload: schemas.AppointmentCreate,
    company: models.Company = Depends(get_current_company),
    db: Session = Depends(get_db),
) -> schemas.AppointmentRead:
    """
    Записывает клиента к мастеру на интервал [starts_at, ends_at).

    Визит должен целиком лежать внутри смены мастера: нельзя поставить
    клиента на 19:00, если смена кончается в 18:00. В той же транзакции —
    notification_outbox для клиента и мастера; доставку забирает воркер.
    """
    appointment = scheduling.book_appointment(db, company=company, **payload.model_dump())
    db.commit()
    db.refresh(appointment)
    return _appointment_read(
        appointment, finance.balance_for(db, company_id=company.id, appointment=appointment)
    )


@app.get(
    "/companies/{company_id}/appointments",
    response_model=list[schemas.AppointmentRead],
    tags=["appointments"],
)
def list_appointments(
    company: models.Company = Depends(get_current_company),
    db: Session = Depends(get_db),
    user_id: int | None = Query(default=None, ge=1, description="Расписание одного мастера"),
    client_id: int | None = Query(default=None, ge=1, description="История одного клиента"),
    appointment_status: models.AppointmentStatus | None = Query(
        default=None, alias="status", description="Фильтр по статусу"
    ),
    date_from: datetime | None = Query(default=None, description="С какого момента (с часовым поясом)"),
    date_to: datetime | None = Query(default=None, description="До какого момента (не включая)"),
    limit: int = Query(default=100, ge=1, le=500),
    offset: int = Query(default=0, ge=0),
) -> list[schemas.AppointmentRead]:
    """
    Расписание компании с фильтрами. Записи, начавшиеся до date_from,
    но ещё идущие, в выборку попадают.
    """
    date_from = _as_utc(date_from, "date_from")
    date_to = _as_utc(date_to, "date_to")
    stmt = select(models.Appointment).where(models.Appointment.company_id == company.id)
    if user_id is not None:
        stmt = stmt.where(models.Appointment.user_id == user_id)
    if client_id is not None:
        stmt = stmt.where(models.Appointment.client_id == client_id)
    if appointment_status is not None:
        stmt = stmt.where(models.Appointment.status == appointment_status)
    if date_from is not None:
        stmt = stmt.where(models.Appointment.ends_at > date_from)
    if date_to is not None:
        stmt = stmt.where(models.Appointment.starts_at < date_to)
    stmt = stmt.order_by(models.Appointment.starts_at).limit(limit).offset(offset)
    appointments = list(db.scalars(stmt))
    paid_map = finance.net_paid_for_appointments(
        db, company_id=company.id, appointment_ids=[item.id for item in appointments]
    )
    return [
        _appointment_read(item, finance.appointment_balance(item, paid_map.get(item.id, finance.ZERO)))
        for item in appointments
    ]


@app.get(
    "/companies/{company_id}/appointments/{appointment_id}",
    response_model=schemas.AppointmentRead,
    tags=["appointments"],
)
def read_appointment(
    appointment_id: int = Path(..., ge=1),
    company: models.Company = Depends(get_current_company),
    db: Session = Depends(get_db),
) -> schemas.AppointmentRead:
    appointment = scheduling.require_appointment(
        db, company_id=company.id, appointment_id=appointment_id
    )
    return _appointment_read(
        appointment, finance.balance_for(db, company_id=company.id, appointment=appointment)
    )


@app.patch(
    "/companies/{company_id}/appointments/{appointment_id}",
    response_model=schemas.AppointmentRead,
    tags=["appointments"],
    responses={
        404: {"description": "Нет записи, услуги или мастера"},
        409: {"description": "Мастер занят или не хватает материалов на складе"},
    },
)
def update_appointment(
    payload: schemas.AppointmentUpdate,
    appointment_id: int = Path(..., ge=1),
    company: models.Company = Depends(get_current_company),
    user: models.User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> schemas.AppointmentRead:
    """
    Перенос записи, передача другому мастеру, смена услуги и статуса.
    Переход в in_progress / completed списывает материалы по рецепту услуги;
    отмена уже начатого визита возвращает их на склад.
    """
    appointment = scheduling.require_appointment(
        db, company_id=company.id, appointment_id=appointment_id
    )
    scheduling.change_appointment(
        db,
        company=company,
        appointment=appointment,
        changes=payload.model_dump(exclude_unset=True),
        actor_user_id=user.id,
    )
    db.commit()
    db.refresh(appointment)
    return _appointment_read(
        appointment, finance.balance_for(db, company_id=company.id, appointment=appointment)
    )


# --------------------------------------------------------------------------- #
#  Касса
# --------------------------------------------------------------------------- #

@app.post(
    "/companies/{company_id}/transactions",
    response_model=schemas.TransactionRead,
    status_code=status.HTTP_201_CREATED,
    tags=["finance"],
    responses={
        404: {"description": "Нет клиента или визита"},
        409: {"description": "Возврат больше, чем оплачено, или клиент не от визита"},
    },
)
def create_transaction(
    payload: schemas.TransactionCreate,
    company: models.Company = Depends(get_current_company),
    user: models.User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> models.Transaction:
    """
    Приход или возврат. Баланс визита пересчитается сам: он не хранится,
    а складывается из completed-транзакций и snapshot-цены визита.
    """
    txn = finance.create_transaction(
        db,
        company_id=company.id,
        created_by_user_id=user.id,
        **payload.model_dump(),
    )
    db.commit()
    db.refresh(txn)
    return txn


@app.get(
    "/companies/{company_id}/transactions",
    response_model=list[schemas.TransactionRead],
    tags=["finance"],
)
def list_transactions(
    company: models.Company = Depends(get_current_company),
    db: Session = Depends(get_db),
    client_id: int | None = Query(default=None, ge=1),
    appointment_id: int | None = Query(default=None, ge=1),
    kind: models.TransactionKind | None = None,
    txn_status: models.TransactionStatus | None = Query(default=None, alias="status"),
    limit: int = Query(default=100, ge=1, le=500),
    offset: int = Query(default=0, ge=0),
) -> list[models.Transaction]:
    stmt = select(models.Transaction).where(models.Transaction.company_id == company.id)
    if client_id is not None:
        stmt = stmt.where(models.Transaction.client_id == client_id)
    if appointment_id is not None:
        stmt = stmt.where(models.Transaction.appointment_id == appointment_id)
    if kind is not None:
        stmt = stmt.where(models.Transaction.kind == kind)
    if txn_status is not None:
        stmt = stmt.where(models.Transaction.status == txn_status)
    stmt = stmt.order_by(models.Transaction.created_at.desc()).limit(limit).offset(offset)
    return list(db.scalars(stmt))


@app.patch(
    "/companies/{company_id}/transactions/{transaction_id}",
    response_model=schemas.TransactionRead,
    tags=["finance"],
)
def update_transaction(
    payload: schemas.TransactionStatusUpdate,
    transaction_id: int = Path(..., ge=1),
    company: models.Company = Depends(get_current_company),
    db: Session = Depends(get_db),
) -> models.Transaction:
    """Провести или отменить pending-операцию. completed дальше не правят — только refund + новая оплата."""
    txn = finance.update_transaction_status(
        db,
        company_id=company.id,
        transaction_id=transaction_id,
        new_status=payload.status,
    )
    db.commit()
    db.refresh(txn)
    return txn
