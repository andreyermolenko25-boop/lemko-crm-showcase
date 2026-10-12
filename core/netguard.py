"""
Защита исходящих запросов (вебхуки) от SSRF.

Пользователь задаёт URL, а запрос уходит из нашей сети. Без проверки он мог бы
указать http://169.254.169.254/ (метаданные AWS с ключами роли), localhost:5432,
внутренние сервисы VPC. Поэтому:

- при сохранении: схема http/https, без логина в URL, хост не IP из запрещённых
  диапазонов и не localhost;
- при отправке: DNS резолвится один раз, КАЖДЫЙ адрес проверяется, соединение
  открывается именно на проверенный IP (нет окна для DNS rebinding), редиректы
  не выполняются.
"""

from __future__ import annotations

import http.client
import ipaddress
import socket
import ssl
from urllib.parse import urlsplit

from core.config import settings


class UnsafeUrl(ValueError):
    """URL ведёт во внутреннюю сеть или некорректен."""


def _blocked(address: ipaddress.IPv4Address | ipaddress.IPv6Address) -> bool:
    if isinstance(address, ipaddress.IPv6Address) and address.ipv4_mapped is not None:
        address = address.ipv4_mapped
    return (
        address.is_private
        or address.is_loopback
        or address.is_link_local
        or address.is_multicast
        or address.is_reserved
        or address.is_unspecified
        or (isinstance(address, ipaddress.IPv4Address) and address in ipaddress.ip_network("100.64.0.0/10"))
    )


def validate_url(url: str) -> str:
    """Проверка при сохранении (без DNS): возвращает очищенный URL или UnsafeUrl."""
    url = (url or "").strip()
    parts = urlsplit(url)
    if parts.scheme not in ("http", "https") or not parts.hostname:
        raise UnsafeUrl("URL должен начинаться с http:// или https://")
    if parts.username or parts.password:
        raise UnsafeUrl("Логин и пароль в URL не допускаются")
    if settings.WEBHOOK_ALLOW_PRIVATE:
        return url
    host = parts.hostname.lower()
    if host == "localhost" or host.endswith((".localhost", ".local", ".internal")):
        raise UnsafeUrl("Адреса внутренней сети запрещены")
    try:
        address = ipaddress.ip_address(host)
    except ValueError:
        return url  # доменное имя — проверится по DNS при отправке
    if _blocked(address):
        raise UnsafeUrl("Адреса внутренней сети запрещены")
    return url


def _resolve(host: str, port: int) -> str:
    try:
        infos = socket.getaddrinfo(host, port, type=socket.SOCK_STREAM)
    except socket.gaierror as exc:
        raise ConnectionError(f"DNS: {host} не найден") from exc
    addresses = [info[4][0] for info in infos]
    if not addresses:
        raise ConnectionError(f"DNS: {host} не найден")
    if not settings.WEBHOOK_ALLOW_PRIVATE:
        for raw in addresses:
            if _blocked(ipaddress.ip_address(raw.split("%", 1)[0])):
                raise UnsafeUrl("Адрес ведёт во внутреннюю сеть")
    return addresses[0]


def resolve_public(host: str, port: int) -> str:
    """
    IP для соединения с пользовательским хостом (например, SMTP): внутренняя
    сеть запрещена так же, как для вебхуков. Подключаться — именно к этому IP.
    """
    host = (host or "").strip().lower()
    if not host:
        raise UnsafeUrl("Не указан адрес сервера")
    if not settings.WEBHOOK_ALLOW_PRIVATE and (
        host == "localhost" or host.endswith((".localhost", ".local", ".internal"))
    ):
        raise UnsafeUrl("Адреса внутренней сети запрещены")
    return _resolve(host, port)


class _PinnedHTTPConnection(http.client.HTTPConnection):
    def __init__(self, host: str, ip: str, **kwargs):
        super().__init__(host, **kwargs)
        self._ip = ip

    def connect(self) -> None:
        self.sock = socket.create_connection((self._ip, self.port), self.timeout)


class _PinnedHTTPSConnection(http.client.HTTPSConnection):
    def __init__(self, host: str, ip: str, **kwargs):
        super().__init__(host, context=ssl.create_default_context(), **kwargs)
        self._ip = ip

    def connect(self) -> None:
        raw = socket.create_connection((self._ip, self.port), self.timeout)
        # SNI и проверка сертификата — по имени хоста, соединение — на проверенный IP.
        self.sock = self._context.wrap_socket(raw, server_hostname=self.host)


def safe_post(url: str, body: bytes, headers: dict[str, str], *, timeout: float) -> int:
    """POST без редиректов на проверенный адрес. Возвращает HTTP-статус."""
    parts = urlsplit(validate_url(url))
    host = parts.hostname or ""
    port = parts.port or (443 if parts.scheme == "https" else 80)
    ip = _resolve(host, port)
    cls = _PinnedHTTPSConnection if parts.scheme == "https" else _PinnedHTTPConnection
    connection = cls(host, ip, port=port, timeout=timeout)
    path = parts.path or "/"
    if parts.query:
        path = f"{path}?{parts.query}"
    try:
        connection.request("POST", path, body=body, headers=headers)
        response = connection.getresponse()
        response.read(65536)
        return response.status
    finally:
        connection.close()
