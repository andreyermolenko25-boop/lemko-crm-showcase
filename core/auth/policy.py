"""
Политика безопасности воркспейса (Settings → Security → Workspace policy).

Хранится в companies.settings["security"]. Применяется сервером: 2FA для всех,
разрешённые способы входа, таймаут простоя, минимальная длина пароля,
письмо о входе с нового устройства, allowlist IP.
"""

from __future__ import annotations

import ipaddress
from dataclasses import dataclass, field
from functools import lru_cache
from typing import Any

import models
from core.auth.exceptions import AuthError

TIMEOUTS = {"15m": 15 * 60, "1h": 3600, "8h": 8 * 3600, "24h": 24 * 3600, "7d": 7 * 24 * 3600}
MIN_LENGTHS = (8, 10, 12, 16)
METHODS = ("password", "google", "microsoft", "apple", "magic")
SETTINGS_KEY = "security"

# Самые частые пароли из утечек: короткий список ловит основную массу перебора.
COMMON_PASSWORDS = frozenset(
    {
        "password", "password1", "password123", "123456789", "1234567890", "12345678",
        "qwerty123", "qwertyuiop", "1q2w3e4r", "1q2w3e4r5t", "iloveyou", "admin123",
        "welcome1", "letmein123", "abc123456", "11111111", "00000000", "passw0rd",
        "qwerty12345", "zaq12wsx", "football1", "monkey123", "dragon123", "sunshine1",
    }
)


@dataclass(frozen=True)
class SecurityPolicy:
    require2fa: bool = False
    methods: dict[str, bool] = field(
        default_factory=lambda: {"password": True, "google": True, "microsoft": True, "apple": True, "magic": False}
    )
    timeout: str = "8h"
    min_length: int = 10
    new_device_alert: bool = True
    ip_allowlist: tuple[str, ...] = ()

    @property
    def idle_seconds(self) -> int:
        return TIMEOUTS.get(self.timeout, TIMEOUTS["8h"])

    def allows(self, method: str) -> bool:
        return bool(self.methods.get(method, False))

    def as_api(self) -> dict[str, Any]:
        return {
            "require2fa": self.require2fa,
            "methods": dict(self.methods),
            "timeout": self.timeout,
            "minLength": str(self.min_length),
            "newDeviceAlert": self.new_device_alert,
            "ipAllowlist": "\n".join(self.ip_allowlist),
        }


def policy_for(company: models.Company) -> SecurityPolicy:
    raw = (company.settings or {}).get(SETTINGS_KEY) or {}
    base = SecurityPolicy()
    methods = {**base.methods, **{k: bool(v) for k, v in (raw.get("methods") or {}).items() if k in METHODS}}
    timeout = raw.get("timeout") if raw.get("timeout") in TIMEOUTS else base.timeout
    try:
        min_length = int(raw.get("minLength", base.min_length))
    except (TypeError, ValueError):
        min_length = base.min_length
    if min_length not in MIN_LENGTHS:
        min_length = base.min_length
    return SecurityPolicy(
        require2fa=bool(raw.get("require2fa", base.require2fa)),
        methods=methods,
        timeout=timeout,
        min_length=min_length,
        new_device_alert=bool(raw.get("newDeviceAlert", base.new_device_alert)),
        ip_allowlist=tuple(raw.get("ipAllowlist") or ()),
    )


def parse_allowlist(text: str) -> tuple[str, ...]:
    """Строки «91.198.0.0/16» или «83.12.44.10»; комментарии после # игнорируются."""
    out: list[str] = []
    for line in (text or "").replace(",", "\n").splitlines():
        item = line.split("#", 1)[0].strip()
        if not item:
            continue
        try:
            out.append(str(ipaddress.ip_network(item, strict=False)))
        except ValueError as exc:
            raise AuthError("invalid_ip_allowlist", f"Неверный адрес или сеть: {item}", status_code=422) from exc
    if len(out) > 200:
        raise AuthError("invalid_ip_allowlist", "Не больше 200 сетей", status_code=422)
    return tuple(out)


def save_policy(company: models.Company, patch: dict[str, Any]) -> SecurityPolicy:
    current = policy_for(company).as_api()
    current["ipAllowlist"] = list(policy_for(company).ip_allowlist)
    if "require2fa" in patch:
        current["require2fa"] = bool(patch["require2fa"])
    if "methods" in patch and isinstance(patch["methods"], dict):
        current["methods"] = {**current["methods"], **{k: bool(v) for k, v in patch["methods"].items() if k in METHODS}}
    if "timeout" in patch:
        if patch["timeout"] not in TIMEOUTS:
            raise AuthError("invalid_value", "Неизвестный таймаут", status_code=422)
        current["timeout"] = patch["timeout"]
    if "minLength" in patch:
        try:
            value = int(patch["minLength"])
        except (TypeError, ValueError) as exc:
            raise AuthError("invalid_value", "Неверная длина пароля", status_code=422) from exc
        if value not in MIN_LENGTHS:
            raise AuthError("invalid_value", "Неверная длина пароля", status_code=422)
        current["minLength"] = value
    if "newDeviceAlert" in patch:
        current["newDeviceAlert"] = bool(patch["newDeviceAlert"])
    if "ipAllowlist" in patch:
        current["ipAllowlist"] = list(parse_allowlist(str(patch["ipAllowlist"] or "")))
    # Без единого способа входа воркспейс заблокирует сам себя.
    if not any(current["methods"].get(m) for m in METHODS):
        raise AuthError("no_login_method", "Оставь хотя бы один способ входа", status_code=422)
    current["minLength"] = int(current["minLength"])
    company.settings = {**(company.settings or {}), SETTINGS_KEY: current}
    return policy_for(company)


@lru_cache(maxsize=256)
def _networks(entries: tuple[str, ...]) -> tuple[ipaddress.IPv4Network | ipaddress.IPv6Network, ...]:
    return tuple(ipaddress.ip_network(item, strict=False) for item in entries)


def ip_allowed(policy: SecurityPolicy, ip: str | None) -> bool:
    if not policy.ip_allowlist:
        return True
    if not ip:
        return False
    try:
        address = ipaddress.ip_address(ip)
    except ValueError:
        return False
    return any(address in network for network in _networks(policy.ip_allowlist))


def check_password(password: str, policy: SecurityPolicy, *, email: str | None = None) -> None:
    """Длина по политике, не совпадает с email, не из списка самых частых."""
    if len(password) < policy.min_length:
        raise AuthError(
            "password_too_short",
            f"Пароль должен быть не короче {policy.min_length} символов",
            status_code=422,
            min_length=policy.min_length,
        )
    lowered = password.lower()
    if lowered in COMMON_PASSWORDS or len(set(password)) < 4:
        raise AuthError("password_too_common", "Этот пароль слишком простой", status_code=422)
    if email and lowered == email.lower():
        raise AuthError("password_too_common", "Пароль не должен совпадать с email", status_code=422)
