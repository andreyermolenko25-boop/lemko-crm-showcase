"""Публичный API ядра авторизации."""

from core.auth.exceptions import AuthError
from core.auth.service import (
    LoginResult,
    RegisterResult,
    authenticate_user,
    complete_login,
    email_is_taken,
    find_login_user,
    passkey_login_options,
    register_studio,
    reset_password,
    send_login_sms,
    start_magic_link,
    start_password_reset,
    trial_ends_at,
    verify_magic_link,
    verify_mfa,
    write_auth_log,
)
from core.auth.sessions import TokenPair

__all__ = [
    "AuthError",
    "LoginResult",
    "RegisterResult",
    "TokenPair",
    "authenticate_user",
    "complete_login",
    "email_is_taken",
    "find_login_user",
    "passkey_login_options",
    "register_studio",
    "reset_password",
    "send_login_sms",
    "start_magic_link",
    "start_password_reset",
    "trial_ends_at",
    "verify_magic_link",
    "verify_mfa",
    "write_auth_log",
]
