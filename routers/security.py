"""
Settings → Security: всё, что на странице безопасности, — на сервере.

Email и телефон с кодами, пароль, Google/Microsoft/Apple, аутентификатор,
SMS-коды, passkeys, резервные коды, активные сессии, история входов и
политика воркспейса. Чувствительные изменения требуют недавнего входа
или подтверждения (step-up, код reauth_required → интерфейс спрашивает пароль).
"""

from __future__ import annotations

from datetime import timedelta

from fastapi import APIRouter, Depends, HTTPException, Request, status
from sqlalchemy import select
from sqlalchemy.orm import Session

import models
import notifications
import schemas
from core import crypto, ratelimit
from core.auth import AuthError, email_is_taken, write_auth_log
from core.auth import mfa, oauth
from core.auth.policy import check_password, ip_allowed, policy_for, save_policy
from core.auth.sessions import (
    active_sessions,
    recently_authenticated,
    revoke_all,
    session_problem,
    utcnow,
)
from core.database import get_db
from core.deps import current_session, get_current_company, get_current_user, require_recent_auth
from core.request_context import client_ip, client_user_agent, describe_device
from core.security import hash_password, verify_password

router = APIRouter(prefix="/auth/security", tags=["security"])
sessions_router = APIRouter(prefix="/auth/sessions", tags=["security"])
policy_router = APIRouter(prefix="/companies/{company_id}/security-policy", tags=["security"])

CODE_TTL = timedelta(minutes=10)


def _err(exc: AuthError) -> HTTPException:
    return HTTPException(status_code=exc.status_code, detail=exc.as_detail(), headers=exc.headers)


def _overview(db: Session, user: models.User, session: models.AuthSession) -> schemas.SecurityOverview:
    linked = {row.provider for row in oauth.identities_of(db, user.id)}
    return schemas.SecurityOverview(
        email=notifications.user_email(user),
        email_verified=user.email_verified_at is not None,
        phone=user.phone if user.phone_verified_at else None,
        phone_verified=user.phone_verified_at is not None,
        has_password=bool(user.hashed_password),
        password_changed_at=user.password_changed_at,
        totp=bool(user.totp_enabled_at and user.totp_secret),
        sms=bool(user.sms_mfa_enabled and user.phone_verified_at),
        sms_available=mfa.sms_available(),
        passkeys=[
            schemas.PasskeyOut(id=k.id, name=k.name, added_at=k.created_at, last_used_at=k.last_used_at)
            for k in mfa.passkeys_of(db, user.id)
        ],
        backup_codes_left=len(user.backup_codes or []),
        social={provider: provider in linked for provider in oauth.PROVIDERS},
        providers=oauth.configured_providers(),
        reauth_required=not recently_authenticated(session),
    )


def _log(db: Session, request: Request, user: models.User, detail: str) -> None:
    write_auth_log(
        db, status=models.AuthLogStatus.SUCCESS, user=user,
        ip_address=client_ip(request), user_agent=client_user_agent(request),
        detail=detail, commit=False,
    )


def _notify(db: Session, user: models.User, subject: str, text: str) -> None:
    address = notifications.user_email(user)
    if address:
        mfa.send_security_email(db, company_id=user.company_id, to=address, subject=subject, text=text)


def _bad_code(code: str, message: str, status_code: int = 400) -> HTTPException:
    return HTTPException(status_code=status_code, detail={"code": code, "message": message})


@router.get("", response_model=schemas.SecurityOverview)
def overview(
    user: models.User = Depends(get_current_user),
    session: models.AuthSession = Depends(current_session),
    db: Session = Depends(get_db),
) -> schemas.SecurityOverview:
    return _overview(db, user, session)


# --------------------------------------------------------------------------- #
#  Подтверждение личности (step-up)
# --------------------------------------------------------------------------- #

@router.post("/reauth", status_code=204)
def reauth(
    payload: schemas.ReauthRequest,
    request: Request,
    user: models.User = Depends(get_current_user),
    session: models.AuthSession = Depends(current_session),
    db: Session = Depends(get_db),
) -> None:
    key = f"reauth:user:{user.id}"
    ratelimit.check(db, key, limit=5, window=900)
    ok = False
    if payload.password and user.hashed_password:
        ok = verify_password(payload.password, user.hashed_password)
    elif payload.code:
        ok = mfa.check_user_totp(user, payload.code) or mfa.use_backup_code(user, payload.code)
    if not ok:
        ratelimit.hit(db, key, limit=10 ** 9, window=900)
        write_auth_log(
            db, status=models.AuthLogStatus.FAILURE, user=user, ip_address=client_ip(request),
            user_agent=client_user_agent(request), detail="reauth_failed",
        )
        raise _bad_code("invalid_credentials", "Неверный пароль или код", 401)
    session.reauth_at = utcnow()
    ratelimit.reset(db, key)
    db.commit()


# --------------------------------------------------------------------------- #
#  Пароль
# --------------------------------------------------------------------------- #

@router.post("/password", status_code=204)
def change_password(
    payload: schemas.PasswordChangeRequest,
    request: Request,
    user: models.User = Depends(get_current_user),
    session: models.AuthSession = Depends(current_session),
    db: Session = Depends(get_db),
) -> None:
    key = f"password:user:{user.id}"
    ratelimit.check(db, key, limit=5, window=900)
    if user.hashed_password:
        if not verify_password(payload.current_password or "", user.hashed_password):
            ratelimit.hit(db, key, limit=10 ** 9, window=900)
            raise _bad_code("wrong_password", "Текущий пароль указан неверно")
    elif not recently_authenticated(session):
        raise _bad_code("reauth_required", "Подтверди личность", 403)
    try:
        check_password(payload.new_password, policy_for(user.company), email=notifications.user_email(user))
    except AuthError as exc:
        raise _err(exc) from exc
    user.hashed_password = hash_password(payload.new_password)
    user.password_changed_at = utcnow()
    if payload.sign_out_others:
        revoke_all(db, user_id=user.id, reason="password_changed", except_id=session.id)
    _log(db, request, user, "password_changed")
    _notify(db, user, "Your Lemko password was changed", "The password of your Lemko account was just changed. If it wasn't you, reset it right away.")
    ratelimit.reset(db, key)
    db.commit()


# --------------------------------------------------------------------------- #
#  Email
# --------------------------------------------------------------------------- #

@router.post("/email/start", status_code=202)
def email_start(
    payload: schemas.EmailOnlyRequest,
    user: models.User = Depends(get_current_user),
    _session: models.AuthSession = Depends(require_recent_auth),
    db: Session = Depends(get_db),
) -> dict:
    ratelimit.hit(db, f"email-code:user:{user.id}", limit=5, window=3600)
    if email_is_taken(db, payload.email, except_user_id=user.id):
        raise _bad_code("email_taken", "Этот email уже используется", 409)
    code = crypto.numeric_code()
    mfa.create_challenge(db, purpose=mfa.EMAIL_CHANGE, ttl=CODE_TTL, user=user, code=code, data={"email": payload.email})
    mfa.send_security_email(
        db,
        company_id=user.company_id,
        to=payload.email,
        subject=f"Lemko verification code: {code}",
        text=f"Your Lemko verification code is {code}. It expires in 10 minutes. Do not share it with anyone.",
    )
    db.commit()
    return {"sent_to": payload.email}


@router.post("/email/confirm", response_model=schemas.SecurityOverview)
def email_confirm(
    payload: schemas.CodeRequest,
    request: Request,
    user: models.User = Depends(get_current_user),
    session: models.AuthSession = Depends(current_session),
    db: Session = Depends(get_db),
) -> schemas.SecurityOverview:
    row = mfa.latest_challenge(db, mfa.EMAIL_CHANGE, user.id)
    if row is None:
        raise _bad_code("code_expired", "Код устарел, запроси новый")
    if not mfa.check_code(row, payload.code):
        db.commit()
        raise _bad_code("code_invalid", "Неверный код")
    new_email = str(row.data["email"])
    if email_is_taken(db, new_email, except_user_id=user.id):
        raise _bad_code("email_taken", "Этот email уже используется", 409)
    old_email = notifications.user_email(user)
    mfa.consume(row)
    user.email = new_email
    # Логин владельцев и приглашённых — email: меняется вместе с адресом.
    if "@" in user.username:
        user.username = new_email
    user.email_verified_at = utcnow()
    _log(db, request, user, "email_changed")
    if old_email and old_email != new_email:
        mfa.send_security_email(
            db, company_id=user.company_id, to=old_email,
            subject="Your Lemko email was changed",
            text=f"The email of your Lemko account was changed to {new_email}. If it wasn't you, contact your workspace owner immediately.",
        )
    db.commit()
    return _overview(db, user, session)


# --------------------------------------------------------------------------- #
#  Телефон и SMS-коды
# --------------------------------------------------------------------------- #

@router.post("/phone/start", status_code=202)
def phone_start(
    payload: schemas.PhoneStartRequest,
    user: models.User = Depends(get_current_user),
    _session: models.AuthSession = Depends(require_recent_auth),
    db: Session = Depends(get_db),
) -> dict:
    ratelimit.hit(db, f"sms:user:{user.id}", limit=5, window=3600)
    code = crypto.numeric_code()
    mfa.create_challenge(db, purpose=mfa.PHONE_LINK, ttl=CODE_TTL, user=user, code=code, data={"phone": payload.phone})
    try:
        mfa.send_sms(db, company_id=user.company_id, to=payload.phone, text=f"Lemko code: {code}. Do not share it.")
    except AuthError as exc:
        raise _err(exc) from exc
    db.commit()
    return {"sent_to": mfa.mask_phone(payload.phone)}


@router.post("/phone/confirm", response_model=schemas.SecurityOverview)
def phone_confirm(
    payload: schemas.CodeRequest,
    request: Request,
    user: models.User = Depends(get_current_user),
    session: models.AuthSession = Depends(current_session),
    db: Session = Depends(get_db),
) -> schemas.SecurityOverview:
    row = mfa.latest_challenge(db, mfa.PHONE_LINK, user.id)
    if row is None:
        raise _bad_code("code_expired", "Код устарел, запроси новый")
    if not mfa.check_code(row, payload.code):
        db.commit()
        raise _bad_code("code_invalid", "Неверный код")
    mfa.consume(row)
    user.phone = str(row.data["phone"])
    user.phone_verified_at = utcnow()
    _log(db, request, user, "phone_linked")
    db.commit()
    return _overview(db, user, session)


@router.delete("/phone", response_model=schemas.SecurityOverview)
def phone_remove(
    request: Request,
    user: models.User = Depends(get_current_user),
    session: models.AuthSession = Depends(require_recent_auth),
    db: Session = Depends(get_db),
) -> schemas.SecurityOverview:
    user.phone = None
    user.phone_verified_at = None
    user.sms_mfa_enabled = False
    _log(db, request, user, "phone_removed")
    db.commit()
    return _overview(db, user, session)


@router.put("/sms", response_model=schemas.SecurityOverview)
def sms_toggle(
    payload: schemas.ToggleRequest,
    request: Request,
    user: models.User = Depends(get_current_user),
    session: models.AuthSession = Depends(require_recent_auth),
    db: Session = Depends(get_db),
) -> schemas.SecurityOverview:
    if payload.enabled and not (user.phone and user.phone_verified_at):
        raise _bad_code("phone_not_linked", "Сначала привяжи телефон")
    if payload.enabled and not mfa.sms_available():
        raise _bad_code("sms_unavailable", "Отправка SMS не настроена", 503)
    user.sms_mfa_enabled = payload.enabled
    if payload.enabled and not user.backup_codes:
        mfa.new_backup_codes(user)
    _log(db, request, user, f"sms_{'on' if payload.enabled else 'off'}")
    db.commit()
    return _overview(db, user, session)


# --------------------------------------------------------------------------- #
#  Приложение-аутентификатор и резервные коды
# --------------------------------------------------------------------------- #

@router.post("/totp/setup", response_model=schemas.TotpSetupOut)
def totp_setup(
    user: models.User = Depends(get_current_user),
    _session: models.AuthSession = Depends(require_recent_auth),
    db: Session = Depends(get_db),
) -> schemas.TotpSetupOut:
    secret = mfa.new_totp_secret()
    mfa.create_challenge(
        db, purpose=mfa.TOTP_SETUP, ttl=timedelta(minutes=15), user=user,
        data={"secret": crypto.encrypt_str(secret)},
    )
    db.commit()
    uri = mfa.otpauth_uri(secret, notifications.user_email(user) or user.username)
    grouped = " ".join(secret[i:i + 4] for i in range(0, len(secret), 4))
    return schemas.TotpSetupOut(secret=grouped, otpauth_uri=uri, qr=mfa.qr_data_uri(uri))


@router.post("/totp/enable", response_model=schemas.BackupCodesOut)
def totp_enable(
    payload: schemas.CodeRequest,
    request: Request,
    user: models.User = Depends(get_current_user),
    session: models.AuthSession = Depends(current_session),
    db: Session = Depends(get_db),
) -> schemas.BackupCodesOut:
    row = mfa.latest_challenge(db, mfa.TOTP_SETUP, user.id)
    if row is None:
        raise _bad_code("code_expired", "Настройка устарела, начни заново")
    secret = crypto.decrypt_str(row.data["secret"]) or ""
    step = mfa.verify_totp(secret, payload.code, last_step=None)
    if step is None:
        row.attempts += 1
        if row.attempts >= mfa.MAX_CODE_ATTEMPTS:
            mfa.consume(row)
        db.commit()
        raise _bad_code("code_invalid", "Неверный код")
    mfa.consume(row)
    user.totp_secret = crypto.encrypt_str(secret)
    user.totp_enabled_at = utcnow()
    user.totp_last_step = step
    codes = mfa.new_backup_codes(user) if not user.backup_codes else []
    # Сессия, в которой включили 2FA, считается подтверждённой вторым фактором.
    session.mfa = True
    _log(db, request, user, "totp_enabled")
    _notify(db, user, "Two-factor sign-in is on", "An authenticator app was added to your Lemko account.")
    db.commit()
    return schemas.BackupCodesOut(codes=codes)


@router.delete("/totp", response_model=schemas.SecurityOverview)
def totp_disable(
    request: Request,
    user: models.User = Depends(get_current_user),
    session: models.AuthSession = Depends(require_recent_auth),
    db: Session = Depends(get_db),
) -> schemas.SecurityOverview:
    user.totp_secret = None
    user.totp_enabled_at = None
    user.totp_last_step = None
    _log(db, request, user, "totp_disabled")
    _notify(db, user, "Authenticator app removed", "The authenticator app was removed from your Lemko account. If it wasn't you, secure your account now.")
    db.commit()
    return _overview(db, user, session)


@router.post("/backup-codes", response_model=schemas.BackupCodesOut)
def backup_codes(
    request: Request,
    user: models.User = Depends(get_current_user),
    _session: models.AuthSession = Depends(require_recent_auth),
    db: Session = Depends(get_db),
) -> schemas.BackupCodesOut:
    codes = mfa.new_backup_codes(user)
    _log(db, request, user, "backup_codes_regenerated")
    db.commit()
    return schemas.BackupCodesOut(codes=codes)


# --------------------------------------------------------------------------- #
#  Passkeys
# --------------------------------------------------------------------------- #

@router.post("/passkeys/options")
def passkey_options(
    user: models.User = Depends(get_current_user),
    _session: models.AuthSession = Depends(require_recent_auth),
    db: Session = Depends(get_db),
) -> dict:
    options = mfa.passkey_registration_options(db, user)
    db.commit()
    return options


@router.post("/passkeys", response_model=schemas.SecurityOverview)
def passkey_add(
    payload: schemas.PasskeyCreateRequest,
    request: Request,
    user: models.User = Depends(get_current_user),
    session: models.AuthSession = Depends(current_session),
    db: Session = Depends(get_db),
) -> schemas.SecurityOverview:
    try:
        mfa.register_passkey(db, user, name=payload.name, credential=payload.credential)
    except AuthError as exc:
        db.commit()
        raise _err(exc) from exc
    if not user.backup_codes:
        mfa.new_backup_codes(user)
    session.mfa = True
    _log(db, request, user, "passkey_added")
    _notify(db, user, "Passkey added", f"A passkey “{payload.name}” was added to your Lemko account.")
    db.commit()
    return _overview(db, user, session)


@router.delete("/passkeys/{passkey_id}", response_model=schemas.SecurityOverview)
def passkey_remove(
    passkey_id: int,
    request: Request,
    user: models.User = Depends(get_current_user),
    session: models.AuthSession = Depends(require_recent_auth),
    db: Session = Depends(get_db),
) -> schemas.SecurityOverview:
    key = db.get(models.WebAuthnCredential, passkey_id)
    if key is None or key.user_id != user.id:
        raise _bad_code("not_found", "Ключ не найден", 404)
    db.delete(key)
    _log(db, request, user, "passkey_removed")
    db.commit()
    return _overview(db, user, session)


# --------------------------------------------------------------------------- #
#  Google / Microsoft / Apple
# --------------------------------------------------------------------------- #

@router.post("/social/{provider}/start", response_model=schemas.OAuthStartOut)
def social_link_start(
    provider: str,
    user: models.User = Depends(get_current_user),
    _session: models.AuthSession = Depends(require_recent_auth),
    db: Session = Depends(get_db),
) -> schemas.OAuthStartOut:
    try:
        url, state = oauth.start(db, provider, intent="link", user=user)
    except AuthError as exc:
        raise _err(exc) from exc
    return schemas.OAuthStartOut(url=url, state=state)


@router.delete("/social/{provider}", response_model=schemas.SecurityOverview)
def social_unlink(
    provider: str,
    request: Request,
    user: models.User = Depends(get_current_user),
    session: models.AuthSession = Depends(require_recent_auth),
    db: Session = Depends(get_db),
) -> schemas.SecurityOverview:
    identities = oauth.identities_of(db, user.id)
    target = [row for row in identities if row.provider == provider]
    if not target:
        raise _bad_code("not_found", "Аккаунт не привязан", 404)
    if not user.hashed_password and len(identities) <= 1:
        raise _bad_code("last_login_method", "Сначала задай пароль — иначе войти будет нечем")
    for row in target:
        db.delete(row)
    _log(db, request, user, f"unlink:{provider}")
    db.commit()
    return _overview(db, user, session)


# --------------------------------------------------------------------------- #
#  История входов
# --------------------------------------------------------------------------- #

def _history_item(row: models.AuthLog) -> schemas.LoginHistoryItem | None:
    detail = row.detail or ""
    method = "password"
    if row.status == models.AuthLogStatus.SUCCESS and detail.startswith("login:"):
        method = detail.split(":", 1)[1]
        event, state = "signedIn", "success"
    elif row.status == models.AuthLogStatus.FAILURE and detail.startswith("mfa_failed"):
        method = detail.split(":", 1)[1] if ":" in detail else "totp"
        event, state = "wrong2fa", "failed"
    elif row.status == models.AuthLogStatus.FAILURE and detail == "invalid_credentials":
        event, state = "failedSignIn", "failed"
    elif row.status == models.AuthLogStatus.REJECTED:
        event, state = "blockedSignIn", "blocked"
    elif row.status == models.AuthLogStatus.SUCCESS and detail in ("password_changed", "password_reset"):
        event, state = "passwordChanged", "success"
    else:
        return None
    return schemas.LoginHistoryItem(
        at=row.created_at,
        event=event,
        method=method,
        status=state,
        ip=row.ip_address,
        device=describe_device(row.user_agent),
    )


@router.get("/history", response_model=list[schemas.LoginHistoryItem])
def history(
    user: models.User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> list[schemas.LoginHistoryItem]:
    rows = db.scalars(
        select(models.AuthLog)
        .where(models.AuthLog.user_id == user.id)
        .order_by(models.AuthLog.created_at.desc())
        .limit(120)
    )
    items = [item for item in (_history_item(row) for row in rows) if item is not None]
    return items[:30]


# --------------------------------------------------------------------------- #
#  Активные сессии
# --------------------------------------------------------------------------- #

@sessions_router.get("", response_model=list[schemas.SessionOut])
def list_sessions(
    user: models.User = Depends(get_current_user),
    session: models.AuthSession = Depends(current_session),
    db: Session = Depends(get_db),
) -> list[schemas.SessionOut]:
    policy = policy_for(user.company)
    return [
        schemas.SessionOut(
            # Наружу — только префикс: полный sid входит в токен.
            id=row.id[:12],
            device=describe_device(row.user_agent),
            ip=row.ip_address,
            method=row.method,
            created_at=row.created_at,
            last_seen_at=row.last_seen_at,
            current=row.id == session.id,
        )
        for row in active_sessions(db, user_id=user.id)
        if session_problem(row, user, policy) is None
    ]


@sessions_router.delete("/{session_prefix}", status_code=204)
def revoke_session(
    session_prefix: str,
    request: Request,
    user: models.User = Depends(get_current_user),
    session: models.AuthSession = Depends(current_session),
    db: Session = Depends(get_db),
) -> None:
    if len(session_prefix) < 12:
        raise _bad_code("not_found", "Сессия не найдена", 404)
    for row in active_sessions(db, user_id=user.id):
        if row.id.startswith(session_prefix) and row.id != session.id:
            row.revoked_at = utcnow()
            row.revoke_reason = "signed_out_remotely"
            _log(db, request, user, "session_revoked")
            db.commit()
            return
    raise _bad_code("not_found", "Сессия не найдена", 404)


@sessions_router.post("/revoke-others")
def revoke_others(
    request: Request,
    user: models.User = Depends(get_current_user),
    session: models.AuthSession = Depends(current_session),
    db: Session = Depends(get_db),
) -> dict:
    count = revoke_all(db, user_id=user.id, reason="signed_out_remotely", except_id=session.id)
    _log(db, request, user, "sessions_revoked")
    db.commit()
    return {"revoked": count}


# --------------------------------------------------------------------------- #
#  Политика воркспейса
# --------------------------------------------------------------------------- #

def _policy_out(company: models.Company, user: models.User) -> schemas.SecurityPolicyOut:
    return schemas.SecurityPolicyOut(
        **policy_for(company).as_api(),
        can_edit=user.role in (models.UserRole.OWNER, models.UserRole.ADMIN),
    )


@policy_router.get("", response_model=schemas.SecurityPolicyOut)
def get_policy(
    company: models.Company = Depends(get_current_company),
    user: models.User = Depends(get_current_user),
) -> schemas.SecurityPolicyOut:
    return _policy_out(company, user)


@policy_router.patch("", response_model=schemas.SecurityPolicyOut)
def patch_policy(
    payload: schemas.SecurityPolicyPatch,
    request: Request,
    company: models.Company = Depends(get_current_company),
    user: models.User = Depends(get_current_user),
    _session: models.AuthSession = Depends(require_recent_auth),
    db: Session = Depends(get_db),
) -> schemas.SecurityPolicyOut:
    if user.role not in (models.UserRole.OWNER, models.UserRole.ADMIN):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail={"code": "forbidden", "message": "Политику меняет владелец или администратор"},
        )
    patch = payload.model_dump(exclude_none=True)
    if patch.get("require2fa") and not mfa.mfa_methods(db, user):
        raise _bad_code("enable_2fa_first", "Сначала включи двухфакторный вход для себя", 422)
    try:
        policy = save_policy(company, patch)
    except AuthError as exc:
        raise _err(exc) from exc
    # Allowlist не должен запереть того, кто его сохраняет.
    if not ip_allowed(policy, client_ip(request)):
        db.rollback()
        raise _bad_code("ip_lockout", "Твой текущий IP не входит в список — так ты потеряешь доступ", 422)
    _log(db, request, user, "security_policy_changed")
    db.commit()
    return _policy_out(company, user)
