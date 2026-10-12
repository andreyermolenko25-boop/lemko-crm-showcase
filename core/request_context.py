"""IP и User-Agent из входящего HTTP-запроса."""

from __future__ import annotations

import hashlib
import ipaddress
from functools import lru_cache

from fastapi import Request

from core.config import settings


@lru_cache(maxsize=1)
def _trusted_networks() -> tuple[ipaddress.IPv4Network | ipaddress.IPv6Network, ...]:
    return tuple(ipaddress.ip_network(cidr, strict=False) for cidr in settings.TRUSTED_PROXY_CIDRS)


def _is_trusted(host: str | None) -> bool:
    if not host:
        return False
    try:
        address = ipaddress.ip_address(host)
    except ValueError:
        # "testclient" и прочие не-IP (тесты, unix-сокет) — локальный вызов.
        return True
    return any(address in network for network in _trusted_networks())


def client_ip(request: Request) -> str | None:
    """
    Реальный IP клиента. X-Forwarded-For учитывается, только если запрос пришёл
    от доверенного прокси (BFF, балансировщик): иначе любой подставит чужой IP
    заголовком и обойдёт привязку сессии, лимиты и allowlist. Цепочку читаем
    справа налево и берём первый адрес не из доверенных сетей.
    """
    peer = request.client.host if request.client is not None else None
    forwarded = request.headers.get("x-forwarded-for")
    if forwarded and _is_trusted(peer):
        hops = [item.strip() for item in forwarded.split(",") if item.strip()]
        for hop in reversed(hops):
            if not _is_trusted(hop):
                return hop[:64]
        if hops:
            return hops[0][:64]
    return peer[:64] if peer else None


def client_user_agent(request: Request) -> str | None:
    raw = request.headers.get("user-agent")
    if not raw:
        return None
    return raw.strip()[:512] or None


def fingerprint_user_agent(user_agent: str | None) -> str | None:
    """Короткий хэш UA для JWT (не тащим всю строку в payload)."""
    if not user_agent:
        return None
    return hashlib.sha256(user_agent.encode("utf-8")).hexdigest()[:32]


def describe_device(user_agent: str | None) -> str:
    """«Chrome on Windows» — для списка сессий и истории входов."""
    ua = (user_agent or "").lower()
    if not ua:
        return "Unknown device"
    if "edg/" in ua:
        browser = "Edge"
    elif "opr/" in ua or "opera" in ua:
        browser = "Opera"
    elif "firefox/" in ua:
        browser = "Firefox"
    elif "chrome/" in ua or "crios/" in ua:
        browser = "Chrome"
    elif "safari/" in ua:
        browser = "Safari"
    elif "python" in ua or "httpx" in ua or "curl" in ua:
        browser = "API client"
    else:
        browser = "Browser"
    if "iphone" in ua or "ipad" in ua:
        system = "iOS"
    elif "android" in ua:
        system = "Android"
    elif "windows" in ua:
        system = "Windows"
    elif "mac os" in ua or "macintosh" in ua:
        system = "macOS"
    elif "linux" in ua:
        system = "Linux"
    else:
        return browser
    return f"{browser} on {system}"
