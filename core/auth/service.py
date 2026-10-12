"""
Сервис авторизации ядра: регистрация тенанта, вход, второй фактор, сессии,
восстановление пароля и вход по ссылке.

Без FastAPI — только SQLAlchemy Session и доменные исключения.
HTTP-слой (routers/auth.py) тонкий и зависит от этого модуля.

Каждый вход проходит одну воронку complete_login: allowlist IP → разрешён ли
способ входа политикой → второй фактор (если подключён) → серверная сессия →
письмо о новом устройстве → AuthLog.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

import models
import notifications
from core import ratelimit
from core.auth import mfa
from core.auth.exceptions import AuthError
from core.auth.policy import SecurityPolicy, check_password, ip_allowed, policy_for
from core.auth.sessions import TokenPair, create_session, issue_token, known_device, revoke_all
from core.config import settings
from core.crypto import numeric_code
from core.request_context import describe_device, fingerprint_user_agent
from core.security import hash_password, needs_rehash, verify_password

TRIAL_DAYS = 14
LOGIN_WINDOW = 15 * 60
LOGIN_FAILS_PER_ACCOUNT = 10
LOGIN_FAILS_PER_IP = 50
MFA_FAILS_PER_USER = 10
LINK_REQUESTS_PER_HOUR = 5
MFA_TTL = timedelta(minutes=5)
RESET_TTL = timedelta(minutes=30)
MAGIC_TTL = timedelta(minutes=15)


@dataclass(frozen=True)
class RegisterResult:
    company: models.Company
    owner: models.User


@dataclass(frozen=True)
class LoginResult:
    """Либо выдана сессия (token), либо нужен второй шаг (mfa_token + способы)."""

    token: TokenPair | None = None
    mfa_token: str | None = None
    mfa_methods: tuple[str, ...] = field(default_factory=tuple)


def trial_ends_at(*, days: int = TRIAL_DAYS) -> datetime:
    """Конец демо-доступа (aware UTC)."""
    return datetime.now(timezone.utc) + timedelta(days=days)


def write_auth_log(
    db: Session,
    *,
    status: models.AuthLogStatus,
    username: str | None = None,
    user: models.User | None = None,
    ip_address: str | None = None,
    user_agent: str | None = None,
    detail: str | None = None,
    commit: bool = True,
) -> None:
    row = models.AuthLog(
        user_id=user.id if user else None,
        company_id=user.company_id if user else None,
        username=(username or (user.username if user else None)),
        status=status,
        ip_address=ip_address,
        user_agent=(user_agent[:512] if user_agent else None),
        detail=detail,
    )
    db.add(row)
    if commit:
        db.commit()


def email_is_taken(db: Session, email: str, *, except_user_id: int | None = None) -> bool:
    stmt = select(models.User.id).where(
        func.lower(models.User.username) == email.lower(),
        models.is_alive(models.User),
    )
    if except_user_id is not None:
        stmt = stmt.where(models.User.id != except_user_id)
    return db.scalars(stmt).first() is not None


def register_studio(
    db: Session,
    *,
    email: str,
    password: str,
    company_name: str,
    niche: models.Niche | None = None,
    timezone_name: str = "UTC",
) -> RegisterResult:
    """
    Одна транзакция: Company (trial 14 дней) + User(OWNER).

    email уже должен быть нормализован (lowercase). Хранится в User.username.
    """
    check_password(password, SecurityPolicy(), email=email)
    if email_is_taken(db, email):
        raise AuthError("email_taken", "Email уже занят", status_code=400)

    company = models.Company(
        name=company_name.strip(),
        niche=niche if niche is not None else models.Niche.DETAILING,
        settings={},
        timezone=timezone_name,
        intake_settings={},
        subscription_status=models.SubscriptionStatus.TRIAL,
        trial_ends_at=trial_ends_at(),
    )
    owner = models.User(
        username=email,
        email=email,
        role=models.UserRole.OWNER,
        hashed_password=hash_password(password),
        password_changed_at=datetime.now(timezone.utc),
    )
    company.users.append(owner)
    db.add(company)
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise AuthError("email_taken", "Email уже занят", status_code=400)
    db.refresh(company)
    db.refresh(owner)
    return RegisterResult(company=company, owner=owner)


def find_login_user(
    db: Session,
    *,
    username: str,
    company_id: int | None = None,
) -> models.User | None:
    stmt = select(models.User).where(
        func.lower(models.User.username) == username.strip().lower(),
        models.is_alive(models.User),
    )
    if company_id is not None:
        stmt = stmt.where(models.User.company_id == company_id)

    users = list(db.scalars(stmt))
    if len(users) == 1:
        return users[0]
    if len(users) > 1:
        raise AuthError(
            "company_ambiguous",
            "Укажи company_id: такой логин есть в нескольких студиях",
            status_code=400,
        )
    return None


def _fail(db: Session, key: str, window: int) -> None:
    """Засчитать неудачу. Сам лимит проверяется перед следующей попыткой."""
    ratelimit.hit(db, key, limit=10 ** 9, window=window)


def _ensure_access(db: Session, user: models.User, *, ip: str | None, ua: str | None, username: str | None) -> SecurityPolicy:
    if not user.is_active or user.deleted_at is not None or not user.company.is_active:
        write_auth_log(
            db, status=models.AuthLogStatus.FAILURE, username=username, user=user,
            ip_address=ip, user_agent=ua, detail="access_disabled",
        )
        raise AuthError("access_disabled", "Доступ отключён", status_code=403)
    policy = policy_for(user.company)
    if not ip_allowed(policy, ip):
        write_auth_log(
            db, status=models.AuthLogStatus.REJECTED, username=username, user=user,
            ip_address=ip, user_agent=ua, detail="ip_not_allowed",
        )
        raise AuthError("ip_not_allowed", "Вход с этого IP запрещён политикой воркспейса", status_code=403)
    return policy


def complete_login(
    db: Session,
    user: models.User,
    *,
    method: str,
    ip: str | None,
    ua: str | None,
    mfa_passed: bool = False,
    username: str | None = None,
) -> LoginResult:
    """Общая воронка для пароля, ссылки из письма и Google/Microsoft/Apple."""
    policy = _ensure_access(db, user, ip=ip, ua=ua, username=username)
    if not policy.allows(method):
        write_auth_log(
            db, status=models.AuthLogStatus.REJECTED, username=username, user=user,
            ip_address=ip, user_agent=ua, detail=f"method_not_allowed:{method}",
        )
        raise AuthError("method_not_allowed", "Этот способ входа отключён политикой воркспейса", status_code=403)

    methods = mfa.mfa_methods(db, user)
    if methods and not mfa_passed:
        token, _row = mfa.create_challenge(
            db,
            purpose=mfa.MFA_LOGIN,
            ttl=MFA_TTL,
            user=user,
            data={"method": method},
        )
        db.commit()
        return LoginResult(mfa_token=token, mfa_methods=tuple(methods))

    fingerprint = fingerprint_user_agent(ua)
    had_sessions = db.scalar(select(models.AuthSession.id).where(models.AuthSession.user_id == user.id).limit(1)) is not None
    new_device = had_sessions and not known_device(db, user_id=user.id, ua_fingerprint=fingerprint)
    session = create_session(
        db, user, method=method, mfa=bool(methods), policy=policy, ip_address=ip, user_agent=ua,
    )
    address = notifications.user_email(user)
    if policy.new_device_alert and new_device and address:
        when = datetime.now(timezone.utc).strftime("%d %b %Y, %H:%M UTC")
        mfa.send_security_email(
            db,
            company_id=user.company_id,
            to=address,
            subject="New sign-in to your Lemko account",
            text=(
                f"Your account was signed in from a new device.\n\n"
                f"Device: {describe_device(ua)}\nIP address: {ip or 'unknown'}\nTime: {when}\n\n"
                f"If this wasn't you, change your password and sign out all sessions in "
                f"Settings → Security: {settings.PUBLIC_APP_URL}/settings/security"
            ),
        )
    write_auth_log(
        db, status=models.AuthLogStatus.SUCCESS, username=username, user=user,
        ip_address=ip, user_agent=ua, detail=f"login:{method}{'+mfa' if methods else ''}", commit=False,
    )
    db.commit()
    return LoginResult(token=issue_token(user, session))


def authenticate_user(
    db: Session,
    *,
    username: str,
    password: str,
    company_id: int | None = None,
    ip_address: str | None = None,
    user_agent: str | None = None,
) -> LoginResult:
    """Проверка пароля → сессия или второй шаг. Неверный логин и пароль дают одинаковый ответ."""
    account_key = f"login:acct:{username.strip().lower()}"
    ip_key = f"login:ip:{ip_address}"
    ratelimit.check(db, account_key, limit=LOGIN_FAILS_PER_ACCOUNT, window=LOGIN_WINDOW)
    ratelimit.check(db, ip_key, limit=LOGIN_FAILS_PER_IP, window=LOGIN_WINDOW)

    user = find_login_user(db, username=username, company_id=company_id)
    hashed = user.hashed_password if user else None
    if not verify_password(password, hashed) or user is None:
        _fail(db, account_key, LOGIN_WINDOW)
        _fail(db, ip_key, LOGIN_WINDOW)
        write_auth_log(
            db,
            status=models.AuthLogStatus.FAILURE,
            username=username,
            user=user,
            ip_address=ip_address,
            user_agent=user_agent,
            detail="invalid_credentials",
        )
        raise AuthError(
            "invalid_credentials",
            "Неверный логин или пароль",
            status_code=401,
            headers={"WWW-Authenticate": "Bearer"},
        )

    ratelimit.reset(db, account_key)
    if user.hashed_password and needs_rehash(user.hashed_password):
        user.hashed_password = hash_password(password)
    return complete_login(db, user, method="password", ip=ip_address, ua=user_agent, username=username)


# --------------------------------------------------------------------------- #
#  Второй шаг входа
# --------------------------------------------------------------------------- #

def _mfa_challenge(db: Session, mfa_token: str | None) -> tuple[models.AuthChallenge, models.User]:
    row = mfa.find_challenge(db, mfa.MFA_LOGIN, mfa_token)
    user = db.get(models.User, row.user_id) if row and row.user_id else None
    if row is None or user is None:
        raise AuthError("mfa_expired", "Время подтверждения истекло, войди заново", status_code=401)
    return row, user


def send_login_sms(db: Session, *, mfa_token: str | None) -> str:
    row, user = _mfa_challenge(db, mfa_token)
    if "sms" not in mfa.mfa_methods(db, user):
        raise AuthError("mfa_method_unavailable", "SMS-коды не подключены", status_code=400)
    ratelimit.hit(db, f"sms:user:{user.id}", limit=5, window=3600)
    code = numeric_code()
    mfa.set_code(row, code)
    mfa.send_sms(db, company_id=user.company_id, to=user.phone or "", text=f"Lemko sign-in code: {code}. Do not share it.")
    db.commit()
    return mfa.mask_phone(user.phone) or ""


def passkey_login_options(db: Session, *, mfa_token: str | None) -> dict[str, Any]:
    row, user = _mfa_challenge(db, mfa_token)
    options = mfa.passkey_authentication_options(db, user, row)
    db.commit()
    return options


def verify_mfa(
    db: Session,
    *,
    mfa_token: str | None,
    method: str,
    code: str | None = None,
    credential: dict[str, Any] | None = None,
    ip_address: str | None = None,
    user_agent: str | None = None,
) -> LoginResult:
    row, user = _mfa_challenge(db, mfa_token)
    user_key = f"mfa:user:{user.id}"
    ratelimit.check(db, user_key, limit=MFA_FAILS_PER_USER, window=LOGIN_WINDOW)
    if method not in mfa.mfa_methods(db, user):
        raise AuthError("mfa_method_unavailable", "Этот способ подтверждения не подключён", status_code=400)

    if method == "totp":
        ok = mfa.check_user_totp(user, code or "")
    elif method == "sms":
        ok = mfa.check_code(row, code or "")
    elif method == "backup":
        ok = mfa.use_backup_code(user, code or "")
    else:
        ok = mfa.verify_passkey(db, user, row, credential or {})

    if not ok:
        if method != "sms":  # check_code уже считает попытки
            row.attempts += 1
            if row.attempts >= mfa.MAX_CODE_ATTEMPTS:
                mfa.consume(row)
        db.commit()
        _fail(db, user_key, LOGIN_WINDOW)
        write_auth_log(
            db, status=models.AuthLogStatus.FAILURE, user=user,
            ip_address=ip_address, user_agent=user_agent, detail=f"mfa_failed:{method}",
        )
        raise AuthError("mfa_invalid", "Неверный код подтверждения", status_code=401)

    mfa.consume(row)
    ratelimit.reset(db, user_key)
    return complete_login(
        db, user, method=str(row.data.get("method") or "password"),
        ip=ip_address, ua=user_agent, mfa_passed=True,
    )


# --------------------------------------------------------------------------- #
#  Восстановление пароля и вход по ссылке
# --------------------------------------------------------------------------- #

def _user_by_email(db: Session, email: str) -> models.User | None:
    try:
        return find_login_user(db, username=email)
    except AuthError:
        return None


def start_password_reset(db: Session, *, email: str, ip_address: str | None) -> None:
    """Ответ всегда одинаковый: по нему нельзя узнать, есть ли такой аккаунт."""
    email = email.strip().lower()
    ratelimit.hit(db, f"reset:ip:{ip_address}", limit=20, window=3600)
    ratelimit.hit(db, f"reset:email:{email}", limit=LINK_REQUESTS_PER_HOUR, window=3600)
    user = _user_by_email(db, email)
    address = notifications.user_email(user) if user else None
    if user is None or not address or not user.is_active:
        return
    token, _ = mfa.create_challenge(db, purpose=mfa.PASSWORD_RESET, ttl=RESET_TTL, user=user)
    mfa.send_security_email(
        db,
        company_id=user.company_id,
        to=address,
        subject="Reset your Lemko password",
        text=(
            "Someone asked to reset the password of your Lemko account.\n\n"
            f"Open this link within 30 minutes to choose a new password:\n"
            f"{settings.PUBLIC_APP_URL}/reset-password?token={token}\n\n"
            "If it wasn't you, ignore this email — your password stays the same."
        ),
    )
    db.commit()


def reset_password(db: Session, *, token: str, new_password: str, ip_address: str | None, user_agent: str | None) -> None:
    row = mfa.find_challenge(db, mfa.PASSWORD_RESET, token)
    user = db.get(models.User, row.user_id) if row and row.user_id else None
    if row is None or user is None:
        raise AuthError("link_expired", "Ссылка недействительна или устарела", status_code=400)
    check_password(new_password, policy_for(user.company), email=notifications.user_email(user))
    now = datetime.now(timezone.utc)
    user.hashed_password = hash_password(new_password)
    user.password_changed_at = now
    # Письмо дошло — адрес подтверждён.
    user.email_verified_at = user.email_verified_at or now
    mfa.consume(row)
    revoke_all(db, user_id=user.id, reason="password_reset")
    write_auth_log(
        db, status=models.AuthLogStatus.SUCCESS, user=user, ip_address=ip_address,
        user_agent=user_agent, detail="password_reset", commit=False,
    )
    address = notifications.user_email(user)
    if address:
        mfa.send_security_email(
            db,
            company_id=user.company_id,
            to=address,
            subject="Your Lemko password was changed",
            text="The password of your Lemko account was just reset and all sessions were signed out. "
            "If it wasn't you, contact your workspace owner immediately.",
        )
    db.commit()


def start_magic_link(db: Session, *, email: str, ip_address: str | None) -> None:
    email = email.strip().lower()
    ratelimit.hit(db, f"magic:ip:{ip_address}", limit=20, window=3600)
    ratelimit.hit(db, f"magic:email:{email}", limit=LINK_REQUESTS_PER_HOUR, window=3600)
    user = _user_by_email(db, email)
    address = notifications.user_email(user) if user else None
    if user is None or not address or not user.is_active or not policy_for(user.company).allows("magic"):
        return
    token, _ = mfa.create_challenge(db, purpose=mfa.MAGIC_LINK, ttl=MAGIC_TTL, user=user)
    mfa.send_security_email(
        db,
        company_id=user.company_id,
        to=address,
        subject="Your Lemko sign-in link",
        text=(
            "Open this link within 15 minutes to sign in to Lemko CRM:\n"
            f"{settings.PUBLIC_APP_URL}/login/magic?token={token}\n\n"
            "The link works once. If you didn't ask for it, ignore this email."
        ),
    )
    db.commit()


def verify_magic_link(db: Session, *, token: str, ip_address: str | None, user_agent: str | None) -> LoginResult:
    row = mfa.find_challenge(db, mfa.MAGIC_LINK, token)
    user = db.get(models.User, row.user_id) if row and row.user_id else None
    if row is None or user is None:
        raise AuthError("link_expired", "Ссылка недействительна или устарела", status_code=400)
    mfa.consume(row)
    user.email_verified_at = user.email_verified_at or datetime.now(timezone.utc)
    db.flush()
    return complete_login(db, user, method="magic", ip=ip_address, ua=user_agent)
