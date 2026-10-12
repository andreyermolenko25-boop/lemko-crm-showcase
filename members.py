"""
Участники воркспейса (сотрудники с логином) в терминах UI: роли Owner / Admin /
Manager / Member / Viewer, должность, статус «приглашён» до первого входа.
"""

from __future__ import annotations

import secrets

from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

import models
import notifications
import outbox
import schemas
import softdelete
from core.errors import DomainError
from core.security import hash_password

ROLE_TO_UI = {
    models.UserRole.OWNER: "Owner",
    models.UserRole.ADMIN: "Admin",
    models.UserRole.MANAGER: "Manager",
    models.UserRole.STAFF: "Member",
    models.UserRole.VIEWER: "Viewer",
}
UI_TO_ROLE = {label: role for role, label in ROLE_TO_UI.items()}
# Служебные ключи preferences, которые клиент не перезаписывает.
SERVER_PREFERENCES = frozenset({"inboxReadAt", "digestSentAt"})


class MemberError(DomainError):
    status_code = 409


def logged_in_ids(db: Session, *, company_id: int) -> set[int]:
    """Кто хоть раз входил: остальные — «приглашены»."""
    return set(
        db.scalars(
            select(models.AuthLog.user_id)
            .where(
                models.AuthLog.company_id == company_id,
                models.AuthLog.status == models.AuthLogStatus.SUCCESS,
                models.AuthLog.user_id.is_not(None),
            )
            .distinct()
        )
    )


def member_out(user: models.User, logged_in: set[int]) -> schemas.MemberOut:
    if not user.is_active:
        state = "disabled"
    elif user.id in logged_in:
        state = "active"
    else:
        state = "invited"
    return schemas.MemberOut(
        id=f"u_{user.id}",
        name=notifications.display_name(user),
        email=notifications.user_email(user) or "",
        role=ROLE_TO_UI[user.role],
        title=user.job_title or "",
        status=state,
    )


def list_members(db: Session, *, company_id: int) -> list[schemas.MemberOut]:
    users = db.scalars(
        select(models.User)
        .where(models.User.company_id == company_id, models.is_alive(models.User))
        .order_by(models.User.id)
    )
    logged_in = logged_in_ids(db, company_id=company_id)
    return [member_out(user, logged_in) for user in users]


def invite(
    db: Session,
    *,
    company: models.Company,
    actor: models.User,
    email: str,
    role: str,
    name: str | None = None,
    title: str | None = None,
) -> tuple[models.User, str]:
    """
    Учётная запись с временным паролем. Пароль показывается пригласившему один
    раз; в письмо он не попадает — только приглашение войти.
    """
    email = email.strip().lower()
    taken = db.scalar(
        select(func.count())
        .select_from(models.User)
        .where(func.lower(models.User.username) == email, models.is_alive(models.User))
    )
    if taken:
        raise MemberError("email_taken", "Этот email уже используется")
    password = secrets.token_urlsafe(9)
    user = models.User(
        company_id=company.id,
        username=email,
        email=email,
        full_name=(name or "").strip() or None,
        job_title=(title or "").strip() or None,
        role=UI_TO_ROLE[role],
        hashed_password=hash_password(password),
    )
    try:
        with db.begin_nested():
            db.add(user)
            db.flush()
    except IntegrityError as exc:
        raise MemberError("email_taken", "Этот email уже используется") from exc
    outbox.enqueue(
        db,
        company_id=company.id,
        event_type=models.NotificationEventType.MEMBER_INVITED,
        recipient_kind=models.NotificationRecipientKind.USER,
        recipient_id=user.id,
        payload={
            "subject": f"{notifications.display_name(actor)} invited you to {company.name}",
            "text": (
                f"You've been added to the {company.name} workspace in Lemko CRM as {role}. "
                f"Sign in with {email} and the temporary password {notifications.display_name(actor)} shared with you."
            ),
        },
    )
    return user, password


def update(
    db: Session,
    *,
    company: models.Company,
    actor: models.User,
    target: models.User,
    changes: dict,
) -> models.User:
    """Имя и должность правит сам сотрудник или админ; роль — владелец/админ."""
    is_admin = actor.role in (models.UserRole.OWNER, models.UserRole.ADMIN)
    if not is_admin and actor.id != target.id:
        raise MemberError("forbidden", "Править чужой профиль может владелец или администратор", status_code=403)
    if "name" in changes:
        target.full_name = (changes["name"] or "").strip() or None
    if "title" in changes:
        target.job_title = (changes["title"] or "").strip() or None
    if changes.get("role"):
        if not is_admin:
            raise MemberError("forbidden", "Роль меняет владелец или администратор", status_code=403)
        softdelete.change_role(
            db, company_id=company.id, target=target, actor=actor, role=UI_TO_ROLE[changes["role"]]
        )
    return target


def merge_preferences(user: models.User, patch: dict) -> None:
    clean = {key: value for key, value in patch.items() if key not in SERVER_PREFERENCES}
    user.preferences = {**(user.preferences or {}), **clean}
