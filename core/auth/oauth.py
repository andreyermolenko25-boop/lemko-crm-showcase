"""
Вход через Google / Microsoft / Apple (OpenID Connect, authorization code).

- state одноразовый (auth_challenges), живёт 10 минут; BFF дополнительно
  кладёт его в httpOnly-куку и сверяет на callback — защита от login CSRF;
- PKCE (S256) для Google и Microsoft, nonce в id_token для всех;
- id_token проверяется подписью по JWKS провайдера, aud = client_id, iss, exp.

Вход возможен только в аккаунт, к которому провайдер привязан заранее
(Settings → Security). Автопривязка по email не делается: иначе владелец
чужого почтового ящика у провайдера получил бы доступ к аккаунту.
"""

from __future__ import annotations

import base64
import hashlib
import json
import secrets
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import timedelta
from typing import Any

import jwt
from sqlalchemy import select
from sqlalchemy.orm import Session

import models
from core.auth import mfa
from core.auth.exceptions import AuthError
from core.config import settings

PROVIDERS = ("google", "microsoft", "apple")
STATE_TTL = timedelta(minutes=10)
_jwk_clients: dict[str, jwt.PyJWKClient] = {}


def _endpoints(provider: str) -> dict[str, Any]:
    if provider == "google":
        return {
            "auth": "https://accounts.google.com/o/oauth2/v2/auth",
            "token": "https://oauth2.googleapis.com/token",
            "jwks": "https://www.googleapis.com/oauth2/v3/certs",
            "issuers": ("https://accounts.google.com", "accounts.google.com"),
            "scope": "openid email",
            "pkce": True,
            "client_id": settings.OAUTH_GOOGLE_CLIENT_ID,
        }
    if provider == "microsoft":
        tenant = settings.OAUTH_MICROSOFT_TENANT
        return {
            "auth": f"https://login.microsoftonline.com/{tenant}/oauth2/v2.0/authorize",
            "token": f"https://login.microsoftonline.com/{tenant}/oauth2/v2.0/token",
            "jwks": f"https://login.microsoftonline.com/{tenant}/discovery/v2.0/keys",
            "issuers": None,  # у multi-tenant iss содержит tid — проверяется по шаблону
            "scope": "openid email profile",
            "pkce": True,
            "client_id": settings.OAUTH_MICROSOFT_CLIENT_ID,
        }
    if provider == "apple":
        return {
            "auth": "https://appleid.apple.com/auth/authorize",
            "token": "https://appleid.apple.com/auth/token",
            "jwks": "https://appleid.apple.com/auth/keys",
            "issuers": ("https://appleid.apple.com",),
            # Без scope Apple разрешает response_mode=query (нужен только sub).
            "scope": "",
            "pkce": False,
            "client_id": settings.OAUTH_APPLE_CLIENT_ID,
        }
    raise AuthError("unknown_provider", "Неизвестный провайдер", status_code=404)


def configured(provider: str) -> bool:
    if provider == "google":
        return bool(settings.OAUTH_GOOGLE_CLIENT_ID and settings.OAUTH_GOOGLE_CLIENT_SECRET)
    if provider == "microsoft":
        return bool(settings.OAUTH_MICROSOFT_CLIENT_ID and settings.OAUTH_MICROSOFT_CLIENT_SECRET)
    if provider == "apple":
        return bool(
            settings.OAUTH_APPLE_CLIENT_ID
            and settings.OAUTH_APPLE_TEAM_ID
            and settings.OAUTH_APPLE_KEY_ID
            and settings.OAUTH_APPLE_PRIVATE_KEY
        )
    return False


def configured_providers() -> dict[str, bool]:
    return {provider: configured(provider) for provider in PROVIDERS}


def _client_secret(provider: str) -> str:
    if provider == "google":
        return settings.OAUTH_GOOGLE_CLIENT_SECRET or ""
    if provider == "microsoft":
        return settings.OAUTH_MICROSOFT_CLIENT_SECRET or ""
    # Apple: client_secret — короткоживущий JWT, подписанный ключом .p8 (ES256).
    now = int(time.time())
    return jwt.encode(
        {
            "iss": settings.OAUTH_APPLE_TEAM_ID,
            "iat": now,
            "exp": now + 300,
            "aud": "https://appleid.apple.com",
            "sub": settings.OAUTH_APPLE_CLIENT_ID,
        },
        settings.OAUTH_APPLE_PRIVATE_KEY,
        algorithm="ES256",
        headers={"kid": settings.OAUTH_APPLE_KEY_ID},
    )


def redirect_uri(provider: str) -> str:
    return f"{settings.PUBLIC_APP_URL}/api/oauth/{provider}/callback"


def start(db: Session, provider: str, *, intent: str, user: models.User | None = None) -> tuple[str, str]:
    """(URL авторизации у провайдера, state)."""
    if provider not in PROVIDERS:
        raise AuthError("unknown_provider", "Неизвестный провайдер", status_code=404)
    if not configured(provider):
        raise AuthError("provider_not_configured", "Вход через этого провайдера не настроен", status_code=400)
    conf = _endpoints(provider)
    verifier = secrets.token_urlsafe(48)
    nonce = secrets.token_urlsafe(16)
    state, _row = mfa.create_challenge(
        db,
        purpose=mfa.OAUTH_STATE,
        ttl=STATE_TTL,
        user=user,
        data={"provider": provider, "intent": intent, "verifier": verifier, "nonce": nonce},
        replace=False,
    )
    params = {
        "client_id": conf["client_id"],
        "redirect_uri": redirect_uri(provider),
        "response_type": "code",
        "state": state,
        "nonce": nonce,
    }
    if conf["scope"]:
        params["scope"] = conf["scope"]
    if provider == "apple":
        params["response_mode"] = "query"
    if provider == "google":
        params["prompt"] = "select_account"
    if conf["pkce"]:
        challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b"=").decode()
        params["code_challenge"] = challenge
        params["code_challenge_method"] = "S256"
    db.commit()
    return f"{conf['auth']}?{urllib.parse.urlencode(params)}", state


def _exchange(provider: str, conf: dict[str, Any], code: str, verifier: str) -> dict[str, Any]:
    form = {
        "grant_type": "authorization_code",
        "code": code,
        "redirect_uri": redirect_uri(provider),
        "client_id": conf["client_id"],
        "client_secret": _client_secret(provider),
    }
    if conf["pkce"]:
        form["code_verifier"] = verifier
    request = urllib.request.Request(
        conf["token"],
        data=urllib.parse.urlencode(form).encode(),
        method="POST",
        headers={"Content-Type": "application/x-www-form-urlencoded", "Accept": "application/json"},
    )
    try:
        with urllib.request.urlopen(request, timeout=10) as response:
            return json.loads(response.read().decode("utf-8"))
    except (urllib.error.URLError, TimeoutError, ValueError) as exc:
        raise AuthError("oauth_failed", "Провайдер не подтвердил вход", status_code=400) from exc


def _verify_id_token(provider: str, conf: dict[str, Any], id_token: str, nonce: str) -> dict[str, Any]:
    client = _jwk_clients.get(provider)
    if client is None:
        client = _jwk_clients[provider] = jwt.PyJWKClient(conf["jwks"], cache_keys=True, lifespan=3600)
    try:
        key = client.get_signing_key_from_jwt(id_token)
        claims = jwt.decode(
            id_token,
            key.key,
            algorithms=["RS256", "ES256"],
            audience=conf["client_id"],
            options={"require": ["exp", "iat", "sub", "iss"]},
            leeway=60,
        )
    except jwt.PyJWTError as exc:
        raise AuthError("oauth_failed", "Провайдер не подтвердил вход", status_code=400) from exc
    issuer = str(claims.get("iss", ""))
    if conf["issuers"] is not None:
        valid_issuer = issuer in conf["issuers"]
    else:
        valid_issuer = issuer.startswith("https://login.microsoftonline.com/") and issuer.endswith("/v2.0")
    if not valid_issuer or claims.get("nonce") != nonce:
        raise AuthError("oauth_failed", "Провайдер не подтвердил вход", status_code=400)
    return claims


def finish(db: Session, provider: str, *, code: str, state: str) -> tuple[models.AuthChallenge, dict[str, Any]]:
    """Проверяет state, меняет code на токены, проверяет id_token. → (state-строка, claims)."""
    row = mfa.find_challenge(db, mfa.OAUTH_STATE, state)
    if row is None or row.data.get("provider") != provider:
        raise AuthError("oauth_state_invalid", "Сессия входа устарела, попробуй ещё раз", status_code=400)
    mfa.consume(row)
    db.commit()
    conf = _endpoints(provider)
    tokens = _exchange(provider, conf, code, row.data.get("verifier", ""))
    id_token = tokens.get("id_token")
    if not id_token:
        raise AuthError("oauth_failed", "Провайдер не подтвердил вход", status_code=400)
    return row, _verify_id_token(provider, conf, id_token, row.data.get("nonce", ""))


def identities_of(db: Session, user_id: int) -> list[models.UserIdentity]:
    return list(db.scalars(select(models.UserIdentity).where(models.UserIdentity.user_id == user_id)))


def link(db: Session, user: models.User, provider: str, claims: dict[str, Any]) -> models.UserIdentity:
    subject = str(claims["sub"])
    existing = db.scalar(
        select(models.UserIdentity).where(
            models.UserIdentity.provider == provider, models.UserIdentity.subject == subject
        )
    )
    if existing is not None and existing.user_id != user.id:
        raise AuthError("oauth_already_linked", "Этот аккаунт уже привязан к другому пользователю", status_code=409)
    if existing is not None:
        return existing
    for row in identities_of(db, user.id):
        if row.provider == provider:
            db.delete(row)
    identity = models.UserIdentity(
        user_id=user.id, provider=provider, subject=subject, email=(claims.get("email") or None)
    )
    db.add(identity)
    return identity


def user_for(db: Session, provider: str, claims: dict[str, Any]) -> models.User | None:
    identity = db.scalar(
        select(models.UserIdentity).where(
            models.UserIdentity.provider == provider, models.UserIdentity.subject == str(claims["sub"])
        )
    )
    if identity is None:
        return None
    user = db.get(models.User, identity.user_id)
    return user if user is not None and user.deleted_at is None else None
