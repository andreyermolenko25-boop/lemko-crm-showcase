"""
Публичный HTTP-слой авторизации. Бизнес-логика — в `core.auth`.

Сессия: JWT (15 мин) с id серверной сессии. Браузер получает его только
в httpOnly-куке от BFF Next.js; refresh продлевает куку, пока серверная
сессия жива (не отозвана, не простаивает дольше политики, не истекла).
"""

from __future__ import annotations

import jwt
from fastapi import APIRouter, Depends, HTTPException, Request, Response
from fastapi.security import HTTPAuthorizationCredentials
from sqlalchemy.orm import Session

import models
import notifications
import schemas
from core import ratelimit
from core.auth import (
    AuthError,
    LoginResult,
    authenticate_user,
    complete_login,
    passkey_login_options,
    register_studio,
    reset_password,
    send_login_sms,
    start_magic_link,
    start_password_reset,
    verify_magic_link,
    verify_mfa,
    write_auth_log,
)
from core.auth import mfa, oauth
from core.auth.policy import policy_for
from core.auth.sessions import issue_token, revoke
from core.database import get_db
from core.deps import bearer_scheme, current_session, extract_access_token, get_current_user
from core.request_context import client_ip, client_user_agent
from core.security import decode_access_token
from core.session_cookies import clear_session_cookie, set_session_cookie

router = APIRouter(prefix="/auth", tags=["auth"])


def _http_error(exc: AuthError) -> HTTPException:
    return HTTPException(
        status_code=exc.status_code,
        detail=exc.as_detail(),
        headers=exc.headers,
    )


def _login_response(result: LoginResult, response: Response) -> schemas.LoginResponse:
    if result.token is None:
        return schemas.LoginResponse(
            mfa_required=True,
            mfa_token=result.mfa_token,
            mfa_methods=list(result.mfa_methods),
        )
    set_session_cookie(response, result.token.access_token)
    return schemas.LoginResponse(
        access_token=result.token.access_token,
        token_type=result.token.token_type,
        expires_in=result.token.expires_in,
    )


@router.post(
    "/register",
    response_model=schemas.RegisterResponse,
    status_code=201,
)
def register(
    payload: schemas.RegisterRequest,
    request: Request,
    db: Session = Depends(get_db),
) -> schemas.RegisterResponse:
    """Создаёт студию и владельца через core.auth.register_studio."""
    try:
        ratelimit.hit(db, f"register:ip:{client_ip(request)}", limit=10, window=3600)
        result = register_studio(
            db,
            email=payload.email,
            password=payload.password,
            company_name=payload.company_name,
        )
    except AuthError as exc:
        raise _http_error(exc) from exc

    return schemas.RegisterResponse(
        company=schemas.CompanyRead.model_validate(result.company),
        owner=schemas.UserRead.model_validate(result.owner),
    )


@router.post("/login", response_model=schemas.LoginResponse)
def login(
    payload: schemas.LoginRequest,
    request: Request,
    response: Response,
    db: Session = Depends(get_db),
) -> schemas.LoginResponse:
    """Пароль → JWT в строгой session-cookie или второй шаг (mfa_required)."""
    try:
        result = authenticate_user(
            db,
            username=payload.username,
            password=payload.password,
            company_id=payload.company_id,
            ip_address=client_ip(request),
            user_agent=client_user_agent(request),
        )
    except AuthError as exc:
        raise _http_error(exc) from exc
    return _login_response(result, response)


# --------------------------------------------------------------------------- #
#  Второй шаг входа
# --------------------------------------------------------------------------- #

@router.post("/mfa/verify", response_model=schemas.LoginResponse)
def mfa_verify(
    payload: schemas.MfaVerifyRequest,
    request: Request,
    response: Response,
    db: Session = Depends(get_db),
) -> schemas.LoginResponse:
    try:
        result = verify_mfa(
            db,
            mfa_token=payload.mfa_token,
            method=payload.method,
            code=payload.code,
            credential=payload.credential,
            ip_address=client_ip(request),
            user_agent=client_user_agent(request),
        )
    except AuthError as exc:
        raise _http_error(exc) from exc
    return _login_response(result, response)


@router.post("/mfa/sms")
def mfa_send_sms(payload: schemas.MfaTokenRequest, db: Session = Depends(get_db)) -> dict:
    try:
        return {"sent_to": send_login_sms(db, mfa_token=payload.mfa_token)}
    except AuthError as exc:
        raise _http_error(exc) from exc


@router.post("/mfa/passkey/options")
def mfa_passkey_options(payload: schemas.MfaTokenRequest, db: Session = Depends(get_db)) -> dict:
    try:
        return passkey_login_options(db, mfa_token=payload.mfa_token)
    except AuthError as exc:
        raise _http_error(exc) from exc


# --------------------------------------------------------------------------- #
#  Восстановление пароля, вход по ссылке
# --------------------------------------------------------------------------- #

@router.post("/password/forgot", status_code=202)
def password_forgot(payload: schemas.EmailOnlyRequest, request: Request, db: Session = Depends(get_db)) -> dict:
    """Всегда 202 — по ответу нельзя узнать, зарегистрирован ли адрес."""
    try:
        start_password_reset(db, email=payload.email, ip_address=client_ip(request))
    except AuthError as exc:
        raise _http_error(exc) from exc
    return {"ok": True}


@router.post("/password/reset", status_code=204)
def password_reset(payload: schemas.PasswordResetRequest, request: Request, db: Session = Depends(get_db)) -> None:
    try:
        reset_password(
            db,
            token=payload.token,
            new_password=payload.new_password,
            ip_address=client_ip(request),
            user_agent=client_user_agent(request),
        )
    except AuthError as exc:
        raise _http_error(exc) from exc


@router.post("/magic/start", status_code=202)
def magic_start(payload: schemas.EmailOnlyRequest, request: Request, db: Session = Depends(get_db)) -> dict:
    try:
        start_magic_link(db, email=payload.email, ip_address=client_ip(request))
    except AuthError as exc:
        raise _http_error(exc) from exc
    return {"ok": True}


@router.post("/magic/verify", response_model=schemas.LoginResponse)
def magic_verify(
    payload: schemas.LinkTokenRequest,
    request: Request,
    response: Response,
    db: Session = Depends(get_db),
) -> schemas.LoginResponse:
    try:
        result = verify_magic_link(
            db, token=payload.token, ip_address=client_ip(request), user_agent=client_user_agent(request)
        )
    except AuthError as exc:
        raise _http_error(exc) from exc
    return _login_response(result, response)


# --------------------------------------------------------------------------- #
#  Google / Microsoft / Apple
# --------------------------------------------------------------------------- #

@router.get("/providers")
def providers() -> dict:
    """Какие способы входа настроены на сервере (кнопки на странице входа)."""
    return {"oauth": oauth.configured_providers(), "sms": mfa.sms_available()}


@router.post("/oauth/{provider}/start", response_model=schemas.OAuthStartOut)
def oauth_start(provider: str, request: Request, db: Session = Depends(get_db)) -> schemas.OAuthStartOut:
    try:
        ratelimit.hit(db, f"oauth:ip:{client_ip(request)}", limit=30, window=600)
        url, state = oauth.start(db, provider, intent="login")
    except AuthError as exc:
        raise _http_error(exc) from exc
    return schemas.OAuthStartOut(url=url, state=state)


@router.post("/oauth/{provider}/callback", response_model=schemas.OAuthCallbackOut)
def oauth_callback(
    provider: str,
    payload: schemas.OAuthCallbackRequest,
    request: Request,
    response: Response,
    db: Session = Depends(get_db),
) -> schemas.OAuthCallbackOut:
    ip, ua = client_ip(request), client_user_agent(request)
    try:
        row, claims = oauth.finish(db, provider, code=payload.code, state=payload.state)
        if row.data.get("intent") == "link":
            user = db.get(models.User, row.user_id) if row.user_id else None
            if user is None:
                raise AuthError("oauth_state_invalid", "Сессия входа устарела", status_code=400)
            oauth.link(db, user, provider, claims)
            write_auth_log(db, status=models.AuthLogStatus.SUCCESS, user=user, ip_address=ip, user_agent=ua, detail=f"link:{provider}")
            return schemas.OAuthCallbackOut(linked=True, provider=provider)
        user = oauth.user_for(db, provider, claims)
        if user is None:
            write_auth_log(
                db, status=models.AuthLogStatus.FAILURE, username=str(claims.get("email") or provider),
                ip_address=ip, user_agent=ua, detail=f"oauth_not_linked:{provider}",
            )
            raise AuthError(
                "oauth_not_linked",
                "Этот аккаунт не привязан. Войди паролем и привяжи его в настройках безопасности.",
                status_code=400,
            )
        result = complete_login(db, user, method=provider, ip=ip, ua=ua)
    except AuthError as exc:
        raise _http_error(exc) from exc
    base = _login_response(result, response)
    return schemas.OAuthCallbackOut(**base.model_dump(), provider=provider)


# --------------------------------------------------------------------------- #
#  Сессия
# --------------------------------------------------------------------------- #

@router.post("/refresh", response_model=schemas.TokenResponse)
def refresh_session(
    response: Response,
    user: models.User = Depends(get_current_user),
    session: models.AuthSession = Depends(current_session),
) -> schemas.TokenResponse:
    """
    Silent refresh: новый JWT той же серверной сессии (ещё ~15 минут).
    Отозванная или простаивающая сессия сюда не доходит — get_current_user даст 401.
    """
    token = issue_token(user, session)
    set_session_cookie(response, token.access_token)
    return schemas.TokenResponse(
        access_token=token.access_token,
        token_type=token.token_type,
        expires_in=token.expires_in,
    )


@router.post("/logout", status_code=204)
def logout(
    request: Request,
    response: Response,
    credentials: HTTPAuthorizationCredentials | None = Depends(bearer_scheme),
    db: Session = Depends(get_db),
) -> None:
    """Отзывает серверную сессию и стирает cookie. Пишет AuthLog."""
    ip = client_ip(request)
    ua = client_user_agent(request)
    raw = extract_access_token(request, credentials)
    user: models.User | None = None
    if raw:
        try:
            payload = decode_access_token(raw)
            user = db.get(models.User, int(payload["sub"]))
            session = db.get(models.AuthSession, str(payload.get("sid") or ""))
            if session is not None and user is not None and session.user_id == user.id:
                revoke(db, session, "logout")
        except (jwt.PyJWTError, KeyError, TypeError, ValueError):
            user = None

    write_auth_log(
        db,
        status=models.AuthLogStatus.LOGOUT,
        user=user,
        ip_address=ip,
        user_agent=ua,
        detail="logout",
    )
    clear_session_cookie(response)


@router.get("/me", response_model=schemas.MeRead)
def read_current_user(
    user: models.User = Depends(get_current_user),
    session: models.AuthSession = Depends(current_session),
    db: Session = Depends(get_db),
) -> schemas.MeRead:
    methods = mfa.mfa_methods(db, user)
    policy = policy_for(user.company)
    base = schemas.UserRead.model_validate(user).model_dump()
    return schemas.MeRead(
        **base,
        email=notifications.user_email(user),
        mfa_enabled=bool(methods),
        mfa_enrollment_required=policy.require2fa and not session.mfa and not methods,
    )
