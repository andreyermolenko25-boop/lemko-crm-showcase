"""
Участники воркспейса и профиль текущего сотрудника (имя, должность, email,
личные настройки интерфейса и уведомлений).
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Path, status
from sqlalchemy.orm import Session

import members
import models
import schemas
import softdelete
from core.database import get_db
from core.deps import get_current_company, get_current_user, require_roles

router = APIRouter(prefix="/companies/{company_id}", tags=["members"])

_ADMIN = (models.UserRole.OWNER, models.UserRole.ADMIN)


def _target(db: Session, company_id: int, member_id: str) -> models.User:
    user_id = int(member_id[2:]) if member_id.startswith("u_") and member_id[2:].isdigit() else None
    target = softdelete.get_user(db, company_id=company_id, user_id=user_id) if user_id else None
    if target is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail={"code": "member_not_found", "message": "Участник не найден"})
    return target


def _member(db: Session, user: models.User) -> schemas.MemberOut:
    return members.member_out(user, members.logged_in_ids(db, company_id=user.company_id))


@router.get("/members", response_model=list[schemas.MemberOut])
def list_members(
    company: models.Company = Depends(get_current_company),
    _: models.User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> list[schemas.MemberOut]:
    return members.list_members(db, company_id=company.id)


@router.post("/members/invite", response_model=schemas.MemberInvited, status_code=status.HTTP_201_CREATED)
def invite_member(
    payload: schemas.MemberInvite,
    company: models.Company = Depends(get_current_company),
    actor: models.User = Depends(require_roles(*_ADMIN)),
    db: Session = Depends(get_db),
) -> schemas.MemberInvited:
    user, password = members.invite(
        db,
        company=company,
        actor=actor,
        email=str(payload.email),
        role=payload.role,
        name=payload.name,
        title=payload.title,
    )
    db.commit()
    db.refresh(user)
    return schemas.MemberInvited(member=_member(db, user), temporary_password=password)


@router.patch("/members/{member_id}", response_model=schemas.MemberOut)
def update_member(
    payload: schemas.MemberPatch,
    member_id: str = Path(..., max_length=32),
    company: models.Company = Depends(get_current_company),
    actor: models.User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> schemas.MemberOut:
    target = _target(db, company.id, member_id)
    members.update(db, company=company, actor=actor, target=target, changes=payload.model_dump(exclude_unset=True))
    db.commit()
    db.refresh(target)
    return _member(db, target)


@router.delete("/members/{member_id}", status_code=status.HTTP_204_NO_CONTENT)
def remove_member(
    member_id: str = Path(..., max_length=32),
    company: models.Company = Depends(get_current_company),
    actor: models.User = Depends(require_roles(*_ADMIN)),
    db: Session = Depends(get_db),
) -> None:
    """Архив сотрудника: вход закрыт, история визитов и записей остаётся."""
    softdelete.archive_user(db, company_id=company.id, target=_target(db, company.id, member_id), actor=actor)
    db.commit()


@router.get("/me", response_model=schemas.ProfileOut)
def read_profile(
    company: models.Company = Depends(get_current_company),
    user: models.User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> schemas.ProfileOut:
    return schemas.ProfileOut(member=_member(db, user), company_id=company.id, preferences=user.preferences or {})


@router.patch("/me", response_model=schemas.ProfileOut)
def update_profile(
    payload: schemas.ProfilePatch,
    company: models.Company = Depends(get_current_company),
    user: models.User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> schemas.ProfileOut:
    changes = payload.model_dump(exclude_unset=True)
    members.update(
        db,
        company=company,
        actor=user,
        target=user,
        changes={key: changes[key] for key in ("name", "title") if key in changes},
    )
    if "email" in changes:
        user.email = str(changes["email"]).lower() if changes["email"] else None
    if changes.get("preferences") is not None:
        members.merge_preferences(user, changes["preferences"])
    db.commit()
    db.refresh(user)
    return schemas.ProfileOut(member=_member(db, user), company_id=company.id, preferences=user.preferences or {})
