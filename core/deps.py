"""
Зависимости FastAPI для авторизации и изоляции тенантов.

Цепочка:
    токен (cookie или Bearer) -> get_current_user -> get_current_company
Тенант только из JWT (cid), не из тела запроса.

IP и User-Agent из JWT сверяются с текущим запросом —
при расхождении сессия сбрасывается (401).
"""

from __future__ import annotations

from collections.abc import Callable

import jwt
from fastapi import Depends, Header, HTTPException, Path, Request, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy.orm import Session

import audit
import integrations
import models
from core.auth import mfa, write_auth_log
from core.auth.policy import ip_allowed, policy_for
from core.auth.sessions import recently_authenticated, revoke, session_problem, touch
from core.config import settings
from core.database import get_db
from core.request_context import client_ip, client_user_agent, fingerprint_user_agent
from core.security import decode_access_token
from core.session_cookies import COOKIE_NAME

bearer_scheme = HTTPBearer(
    auto_error=False,
    description="Access-токен из POST /auth/login (cookie lemko_session или Authorization: Bearer)",
)


def _unauthorized(code: str, message: str) -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail={"code": code, "message": message},
        headers={"WWW-Authenticate": "Bearer"},
    )


def _subscription_forbidden() -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_403_FORBIDDEN,
        detail={"code": "subscription_expired", "message": "Подписка истекла. Доступ ограничен."},
    )


def assert_company_subscription_active(company: models.Company) -> None:
    """Бросает 403, если trial истёк или статус inactive."""
    from datetime import datetime, timezone

    sub_status = company.subscription_status
    if sub_status == models.SubscriptionStatus.INACTIVE:
        raise _subscription_forbidden()
    if sub_status == models.SubscriptionStatus.TRIAL:
        ends = company.trial_ends_at
        if ends is not None and ends.tzinfo is None:
            ends = ends.replace(tzinfo=timezone.utc)
        now = datetime.now(timezone.utc)
        if ends is None or ends < now:
            raise _subscription_forbidden()


def extract_access_token(
    request: Request,
    credentials: HTTPAuthorizationCredentials | None,
) -> str | None:
    """Bearer имеет приоритет (тесты/API), иначе session cookie."""
    if credentials is not None and credentials.credentials:
        return credentials.credentials
    cookie_token = request.cookies.get(COOKIE_NAME)
    if cookie_token:
        return cookie_token
    return None


def assert_session_binding(
    payload: dict,
    request: Request,
    *,
    db: Session,
    user: models.User | None = None,
) -> None:
    """
    Сверяет отпечаток User-Agent (и IP в строгом режиме SESSION_BIND_IP)
    с моментом выдачи токена. Расхождение → 401 (возможная кража сессии).
    """
    current_ip = client_ip(request)
    current_uaf = fingerprint_user_agent(client_user_agent(request))
    token_ip = payload.get("ip")
    token_uaf = payload.get("uaf")

    ip_mismatch = settings.SESSION_BIND_IP and bool(token_ip) and token_ip != current_ip
    ua_mismatch = bool(token_uaf) and token_uaf != current_uaf
    if not ip_mismatch and not ua_mismatch:
        return

    reason = "ip_mismatch" if ip_mismatch else "ua_mismatch"
    if ip_mismatch and ua_mismatch:
        reason = "ip_ua_mismatch"

    write_auth_log(
        db,
        status=models.AuthLogStatus.REJECTED,
        user=user,
        ip_address=current_ip,
        user_agent=client_user_agent(request),
        detail=reason,
    )
    raise _unauthorized("session_rebound", "Сессия сброшена: изменился IP или устройство")


def get_current_user(
    request: Request,
    credentials: HTTPAuthorizationCredentials | None = Depends(bearer_scheme),
    db: Session = Depends(get_db),
) -> models.User:
    """Достаёт сотрудника из токена и проверяет, что он ещё имеет доступ."""
    raw = extract_access_token(request, credentials)
    if not raw:
        raise _unauthorized("not_authenticated", "Требуется авторизация")

    try:
        payload = decode_access_token(raw)
    except jwt.ExpiredSignatureError:
        raise _unauthorized("token_expired", "Срок действия токена истёк")
    except jwt.PyJWTError:
        raise _unauthorized("invalid_token", "Некорректный токен")

    try:
        user_id = int(payload["sub"])
    except (KeyError, TypeError, ValueError):
        raise _unauthorized("invalid_token", "Некорректный токен")

    user = db.get(models.User, user_id)
    if user is None or user.deleted_at is not None:
        raise _unauthorized("user_not_found", "Пользователь не найден")

    if user.company_id != payload.get("cid"):
        raise _unauthorized("token_company_mismatch", "Токен выдан для другой компании")

    assert_session_binding(payload, request, db=db, user=user)

    if not user.is_active:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail={"code": "account_disabled", "message": "Учётная запись отключена"},
        )
    if not user.company.is_active:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail={"code": "company_blocked", "message": "Компания заблокирована"},
        )

    # Серверная сессия: отозвана / истекла / простой дольше политики → 401.
    policy = policy_for(user.company)
    session = db.get(models.AuthSession, str(payload.get("sid") or ""))
    problem = session_problem(session, user, policy)
    if problem:
        if session is not None and session.revoked_at is None:
            revoke(db, session, problem)
            db.commit()
        raise _unauthorized(problem, "Сессия завершена, войди снова")
    if not ip_allowed(policy, client_ip(request)):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail={"code": "ip_not_allowed", "message": "Доступ с этого IP запрещён политикой воркспейса"},
        )
    touch(db, session)
    request.state.auth_session = session

    # Политика «2FA для всех»: без второго фактора доступны только /auth/*
    # (настроить аутентификатор, выйти).
    if policy.require2fa and not session.mfa and not request.url.path.startswith("/auth/"):
        if not mfa.mfa_methods(db, user):
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail={"code": "mfa_enrollment_required", "message": "Включи двухфакторный вход, чтобы продолжить"},
            )
    audit.set_actor(user, db)
    return user


def current_session(request: Request, user: models.User = Depends(get_current_user)) -> models.AuthSession:
    return request.state.auth_session


def require_recent_auth(session: models.AuthSession = Depends(current_session)) -> models.AuthSession:
    """Step-up: смена email, 2FA, ключей и политики — только после недавнего входа/подтверждения."""
    if not recently_authenticated(session):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail={"code": "reauth_required", "message": "Подтверди личность паролем или кодом"},
        )
    return session


def get_active_tenant(
    user: models.User = Depends(get_current_user),
) -> models.Company:
    """
    Тенант с действующей подпиской (trial не истёк / active).

    inactive или просроченный trial → 403.
    """
    company = user.company
    assert_company_subscription_active(company)
    return company


def get_current_company(
    company_id: int = Path(..., ge=1, description="ID компании-тенанта"),
    company: models.Company = Depends(get_active_tenant),
) -> models.Company:
    """Сверяет company_id из пути с активным тенантом токена (иначе 404)."""
    if company.id != company_id:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={"code": "company_not_found", "message": "Компания не найдена"},
        )
    return company


def require_roles(*roles: models.UserRole) -> Callable[[models.User], models.User]:
    allowed = set(roles)

    def dependency(user: models.User = Depends(get_current_user)) -> models.User:
        if user.role not in allowed:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail={"code": "forbidden", "message": "Недостаточно прав для этой операции"},
            )
        return user

    return dependency


# Все роли, кроме «только просмотр»: могут менять записи и настройки воркспейса.
EDITOR_ROLES = tuple(role for role in models.UserRole if role != models.UserRole.VIEWER)


def require_editor(user: models.User = Depends(get_current_user)) -> models.User:
    return require_roles(*EDITOR_ROLES)(user)


def get_api_key_tenant(
    x_api_key: str | None = Header(
        default=None,
        alias="X-API-Key",
        description="Токен интеграции `lmk_…` (обходит JWT)",
    ),
    db: Session = Depends(get_db),
) -> integrations.ApiKeyTenant:
    """Внешний доступ по API-ключу без JWT."""
    if not x_api_key:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail={
                "code": "missing_api_key",
                "message": "Требуется заголовок X-API-Key",
            },
            headers={"WWW-Authenticate": "ApiKey"},
        )
    try:
        tenant = integrations.authenticate_api_key(db, x_api_key)
    except integrations.IntegrationError as exc:
        raise HTTPException(
            status_code=exc.status_code,
            detail=exc.as_detail(),
            headers={"WWW-Authenticate": "ApiKey"},
        ) from exc
    assert_company_subscription_active(tenant.company)
    db.info["audit_company_id"] = tenant.company.id
    db.info["audit_actor_id"] = None
    return tenant


def require_api_scope(
    scope: str,
) -> Callable[[integrations.ApiKeyTenant], integrations.ApiKeyTenant]:
    def dependency(
        tenant: integrations.ApiKeyTenant = Depends(get_api_key_tenant),
    ) -> integrations.ApiKeyTenant:
        try:
            integrations.require_scope(tenant, scope)
        except integrations.IntegrationError as exc:
            raise HTTPException(
                status_code=exc.status_code, detail=exc.as_detail()
            ) from exc
        return tenant

    return dependency
