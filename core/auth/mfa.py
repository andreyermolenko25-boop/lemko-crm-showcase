"""
Второй фактор и одноразовые проверки.

- challenges: второй шаг входа, коды на email/телефон, ссылки сброса пароля и
  входа, OAuth state, WebAuthn challenge. В БД — только HMAC-хэши, попытки
  ограничены, всё одноразовое и с коротким сроком.
- TOTP (RFC 6238): приложение-аутентификатор; секрет зашифрован, повтор кода
  в том же 30-секундном окне отклоняется.
- резервные коды: 10 штук, каждый одноразовый, хранятся хэшами.
- passkeys (WebAuthn) через py_webauthn.
- доставка кодов: письмо или SMS через outbox (воркер), текст с кодом
  стирается из outbox после отправки.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import secrets
import time
from datetime import datetime, timedelta, timezone
from typing import Any
from urllib.parse import quote

import segno
from sqlalchemy import select, update
from sqlalchemy.orm import Session
from webauthn import (
    generate_authentication_options,
    generate_registration_options,
    options_to_json,
    verify_authentication_response,
    verify_registration_response,
)
from webauthn.helpers import base64url_to_bytes, bytes_to_base64url
from webauthn.helpers.exceptions import InvalidAuthenticationResponse, InvalidRegistrationResponse
from webauthn.helpers.structs import (
    AuthenticatorSelectionCriteria,
    AuthenticatorTransport,
    PublicKeyCredentialDescriptor,
    ResidentKeyRequirement,
    UserVerificationRequirement,
)

import models
import notifications
import outbox
from core import crypto
from core.auth.exceptions import AuthError
from core.config import settings

MAX_CODE_ATTEMPTS = 5
ISSUER = "Lemko CRM"

# Назначения проверок.
MFA_LOGIN = "mfa_login"
EMAIL_CHANGE = "email_change"
PHONE_LINK = "phone_link"
TOTP_SETUP = "totp_setup"
PASSKEY_REGISTER = "passkey_register"
PASSWORD_RESET = "password_reset"
MAGIC_LINK = "magic_link"
OAUTH_STATE = "oauth_state"


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _aware(value: datetime) -> datetime:
    return value if value.tzinfo else value.replace(tzinfo=timezone.utc)


# --------------------------------------------------------------------------- #
#  Одноразовые проверки
# --------------------------------------------------------------------------- #

def _code_hash(row: models.AuthChallenge, code: str) -> str:
    # Код привязан к конкретной проверке: тот же код от другой не подойдёт.
    return crypto.token_hash(f"code:{row.purpose}:{row.id}:{(code or '').strip()}")


def create_challenge(
    db: Session,
    *,
    purpose: str,
    ttl: timedelta,
    user: models.User | None = None,
    company_id: int | None = None,
    code: str | None = None,
    data: dict[str, Any] | None = None,
    replace: bool = True,
) -> tuple[str, models.AuthChallenge]:
    """Возвращает (токен, строка). Токен знает только клиент; в БД — хэш."""
    if replace and user is not None:
        db.execute(
            update(models.AuthChallenge)
            .where(
                models.AuthChallenge.user_id == user.id,
                models.AuthChallenge.purpose == purpose,
                models.AuthChallenge.consumed_at.is_(None),
            )
            .values(consumed_at=utcnow())
        )
    token = crypto.url_token()
    row = models.AuthChallenge(
        purpose=purpose,
        user_id=user.id if user else None,
        company_id=user.company_id if user else company_id,
        token_hash=crypto.token_hash(f"{purpose}:{token}"),
        data=data or {},
        expires_at=utcnow() + ttl,
    )
    db.add(row)
    db.flush()
    if code is not None:
        row.code_hash = _code_hash(row, code)
    return token, row


def _active(row: models.AuthChallenge | None) -> models.AuthChallenge | None:
    if row is None or row.consumed_at is not None or _aware(row.expires_at) <= utcnow():
        return None
    return row


def find_challenge(db: Session, purpose: str, token: str | None) -> models.AuthChallenge | None:
    if not token or len(token) > 200:
        return None
    row = db.scalar(
        select(models.AuthChallenge).where(
            models.AuthChallenge.token_hash == crypto.token_hash(f"{purpose}:{token}"),
            models.AuthChallenge.purpose == purpose,
        )
    )
    return _active(row)


def latest_challenge(db: Session, purpose: str, user_id: int) -> models.AuthChallenge | None:
    row = db.scalar(
        select(models.AuthChallenge)
        .where(
            models.AuthChallenge.user_id == user_id,
            models.AuthChallenge.purpose == purpose,
            models.AuthChallenge.consumed_at.is_(None),
        )
        .order_by(models.AuthChallenge.id.desc())
        .limit(1)
    )
    return _active(row)


def set_code(row: models.AuthChallenge, code: str) -> None:
    """Новый код для существующей проверки (повторная отправка SMS при входе)."""
    row.code_hash = _code_hash(row, code)


def check_code(row: models.AuthChallenge, code: str) -> bool:
    """Сверяет введённый код. После MAX_CODE_ATTEMPTS ошибок проверка сгорает."""
    if not row.code_hash:
        return False
    ok = crypto.hashes_equal(row.code_hash, _code_hash(row, code))
    if not ok:
        row.attempts += 1
        if row.attempts >= MAX_CODE_ATTEMPTS:
            row.consumed_at = utcnow()
    return ok


def consume(row: models.AuthChallenge) -> None:
    row.consumed_at = utcnow()


# --------------------------------------------------------------------------- #
#  Доставка кодов и писем безопасности (outbox → воркер)
# --------------------------------------------------------------------------- #

def send_security_email(db: Session, *, company_id: int, to: str, subject: str, text: str) -> None:
    outbox.enqueue(
        db,
        company_id=company_id,
        event_type=models.NotificationEventType.SECURITY,
        recipient_kind=models.NotificationRecipientKind.EMAIL,
        recipient_id=0,
        payload={"to": to, "subject": subject, "text": text, "sensitive": True},
    )


def sms_available() -> bool:
    return settings.SMS_BACKEND != "none"


def send_sms(db: Session, *, company_id: int, to: str, text: str) -> None:
    if not sms_available():
        raise AuthError("sms_unavailable", "Отправка SMS не настроена (SMS_BACKEND)", status_code=503)
    outbox.enqueue(
        db,
        company_id=company_id,
        event_type=models.NotificationEventType.SECURITY,
        recipient_kind=models.NotificationRecipientKind.SMS,
        recipient_id=0,
        payload={"to": to, "text": text, "sensitive": True},
    )


def mask_phone(phone: str | None) -> str | None:
    if not phone:
        return None
    return f"{phone[:3]} ••• {phone[-2:]}" if len(phone) > 6 else "•••"


# --------------------------------------------------------------------------- #
#  TOTP
# --------------------------------------------------------------------------- #

TOTP_PERIOD = 30
TOTP_DIGITS = 6


def new_totp_secret() -> str:
    return base64.b32encode(os.urandom(20)).decode("ascii").rstrip("=")


def _key(secret: str) -> bytes:
    return base64.b32decode(secret + "=" * (-len(secret) % 8))


def _hotp(key: bytes, counter: int) -> str:
    mac = hmac.new(key, counter.to_bytes(8, "big"), hashlib.sha1).digest()
    offset = mac[-1] & 0x0F
    value = (int.from_bytes(mac[offset:offset + 4], "big") & 0x7FFFFFFF) % 10 ** TOTP_DIGITS
    return f"{value:0{TOTP_DIGITS}d}"


def totp_code(secret: str, at: float | None = None) -> str:
    return _hotp(_key(secret), int((at if at is not None else time.time()) // TOTP_PERIOD))


def verify_totp(secret: str, code: str, *, last_step: int | None) -> int | None:
    """Шаг, на котором код верен (±1 окно на рассинхрон часов), или None."""
    code = (code or "").replace(" ", "").strip()
    if len(code) != TOTP_DIGITS or not code.isdigit():
        return None
    key = _key(secret)
    now_step = int(time.time() // TOTP_PERIOD)
    for step in (now_step - 1, now_step, now_step + 1):
        if last_step is not None and step <= last_step:
            continue
        if hmac.compare_digest(_hotp(key, step), code):
            return step
    return None


def otpauth_uri(secret: str, account: str) -> str:
    label = quote(f"{ISSUER}:{account}")
    return f"otpauth://totp/{label}?secret={secret}&issuer={quote(ISSUER)}&algorithm=SHA1&digits={TOTP_DIGITS}&period={TOTP_PERIOD}"


def qr_data_uri(text: str) -> str:
    return segno.make(text, error="m").svg_data_uri(scale=5, border=2)


def user_totp_secret(user: models.User) -> str | None:
    return crypto.decrypt_str(user.totp_secret) if user.totp_secret and user.totp_enabled_at else None


def check_user_totp(user: models.User, code: str) -> bool:
    secret = user_totp_secret(user)
    if not secret:
        return False
    step = verify_totp(secret, code, last_step=user.totp_last_step)
    if step is None:
        return False
    user.totp_last_step = step
    return True


# --------------------------------------------------------------------------- #
#  Резервные коды
# --------------------------------------------------------------------------- #

BACKUP_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"
BACKUP_COUNT = 10


def _normalize_backup(code: str) -> str:
    return "".join(ch for ch in (code or "").upper() if ch.isalnum())


def new_backup_codes(user: models.User) -> list[str]:
    codes = []
    for _ in range(BACKUP_COUNT):
        raw = "".join(secrets.choice(BACKUP_ALPHABET) for _ in range(8))
        codes.append(f"{raw[:4]}-{raw[4:]}")
    user.backup_codes = [crypto.token_hash(f"backup:{_normalize_backup(c)}") for c in codes]
    return codes


def use_backup_code(user: models.User, code: str) -> bool:
    candidate = crypto.token_hash(f"backup:{_normalize_backup(code)}")
    remaining = list(user.backup_codes or [])
    for index, stored in enumerate(remaining):
        if crypto.hashes_equal(stored, candidate):
            del remaining[index]
            user.backup_codes = remaining
            return True
    return False


# --------------------------------------------------------------------------- #
#  Какие факторы есть у пользователя
# --------------------------------------------------------------------------- #

def passkeys_of(db: Session, user_id: int) -> list[models.WebAuthnCredential]:
    return list(
        db.scalars(
            select(models.WebAuthnCredential)
            .where(models.WebAuthnCredential.user_id == user_id)
            .order_by(models.WebAuthnCredential.id)
        )
    )


def mfa_methods(db: Session, user: models.User) -> list[str]:
    """Способы второго шага входа, доступные пользователю (пусто — 2FA выключена)."""
    methods: list[str] = []
    if user.totp_enabled_at and user.totp_secret:
        methods.append("totp")
    if user.sms_mfa_enabled and user.phone and user.phone_verified_at and sms_available():
        methods.append("sms")
    if passkeys_of(db, user.id):
        methods.append("passkey")
    if methods and user.backup_codes:
        methods.append("backup")
    return methods


# --------------------------------------------------------------------------- #
#  Passkeys (WebAuthn)
# --------------------------------------------------------------------------- #

def _descriptors(keys: list[models.WebAuthnCredential]) -> list[PublicKeyCredentialDescriptor]:
    out = []
    for key in keys:
        transports = []
        for item in key.transports or []:
            try:
                transports.append(AuthenticatorTransport(item))
            except ValueError:
                continue
        out.append(PublicKeyCredentialDescriptor(id=key.credential_id, transports=transports or None))
    return out


def passkey_registration_options(db: Session, user: models.User) -> dict[str, Any]:
    options = generate_registration_options(
        rp_id=settings.WEBAUTHN_RP_ID,
        rp_name=settings.WEBAUTHN_RP_NAME,
        user_id=f"lemko-user-{user.id}".encode(),
        user_name=notifications.user_email(user) or user.username,
        user_display_name=notifications.display_name(user),
        exclude_credentials=_descriptors(passkeys_of(db, user.id)),
        authenticator_selection=AuthenticatorSelectionCriteria(
            resident_key=ResidentKeyRequirement.PREFERRED,
            user_verification=UserVerificationRequirement.PREFERRED,
        ),
    )
    create_challenge(
        db,
        purpose=PASSKEY_REGISTER,
        ttl=timedelta(minutes=5),
        user=user,
        data={"challenge": bytes_to_base64url(options.challenge)},
    )
    return json.loads(options_to_json(options))


def register_passkey(db: Session, user: models.User, *, name: str, credential: dict[str, Any]) -> models.WebAuthnCredential:
    row = latest_challenge(db, PASSKEY_REGISTER, user.id)
    if row is None:
        raise AuthError("challenge_expired", "Запрос устарел, попробуй ещё раз", status_code=400)
    consume(row)
    try:
        verified = verify_registration_response(
            credential=credential,
            expected_challenge=base64url_to_bytes(row.data["challenge"]),
            expected_rp_id=settings.WEBAUTHN_RP_ID,
            expected_origin=settings.PUBLIC_APP_URL,
        )
    except (InvalidRegistrationResponse, KeyError, ValueError, TypeError) as exc:
        raise AuthError("passkey_invalid", "Ключ не подтверждён", status_code=400) from exc
    transports = [str(t) for t in ((credential.get("response") or {}).get("transports") or [])][:8]
    key = models.WebAuthnCredential(
        user_id=user.id,
        company_id=user.company_id,
        credential_id=verified.credential_id,
        public_key=verified.credential_public_key,
        sign_count=verified.sign_count,
        transports=transports,
        name=(name or "").strip()[:100] or "Passkey",
    )
    db.add(key)
    return key


def passkey_authentication_options(db: Session, user: models.User, row: models.AuthChallenge) -> dict[str, Any]:
    """Опции для второго шага входа; challenge кладётся в ту же проверку mfa_login."""
    keys = passkeys_of(db, user.id)
    if not keys:
        raise AuthError("passkey_missing", "Нет ключей доступа", status_code=400)
    options = generate_authentication_options(
        rp_id=settings.WEBAUTHN_RP_ID,
        allow_credentials=_descriptors(keys),
        user_verification=UserVerificationRequirement.PREFERRED,
    )
    row.data = {**row.data, "webauthn": bytes_to_base64url(options.challenge)}
    return json.loads(options_to_json(options))


def verify_passkey(db: Session, user: models.User, row: models.AuthChallenge, credential: dict[str, Any]) -> bool:
    challenge = row.data.get("webauthn")
    if not challenge or not isinstance(credential, dict):
        return False
    try:
        raw_id = base64url_to_bytes(str(credential.get("rawId") or credential.get("id") or ""))
    except (ValueError, TypeError):
        return False
    key = db.scalar(
        select(models.WebAuthnCredential).where(
            models.WebAuthnCredential.credential_id == raw_id,
            models.WebAuthnCredential.user_id == user.id,
        )
    )
    if key is None:
        return False
    try:
        verified = verify_authentication_response(
            credential=credential,
            expected_challenge=base64url_to_bytes(challenge),
            expected_rp_id=settings.WEBAUTHN_RP_ID,
            expected_origin=settings.PUBLIC_APP_URL,
            credential_public_key=key.public_key,
            credential_current_sign_count=key.sign_count,
        )
    except (InvalidAuthenticationResponse, ValueError, TypeError, KeyError):
        return False
    key.sign_count = verified.new_sign_count
    key.last_used_at = utcnow()
    # challenge одноразовый.
    row.data = {k: v for k, v in row.data.items() if k != "webauthn"}
    return True
