"""
Шифрование полей и хэши одноразовых токенов.

encrypt_str / decrypt_str — AES-256-GCM (аутентифицированное шифрование) для
секретов, которые нужно прочитать обратно: TOTP-секрет, секрет вебхука.
Формат строки: "enc:v1:<base64url(nonce|ciphertext|tag)>". Строка без префикса
считается старым открытым значением и возвращается как есть — данные,
записанные до шифрования, продолжают работать.

token_hash — HMAC-SHA256 с ключом сервера для одноразовых кодов и ссылок
(восстановление пароля, коды SMS, резервные коды): в БД лежит только хэш,
утечка таблицы не даёт ни одного рабочего кода.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import os
import secrets
from functools import lru_cache

from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.hashes import SHA256
from cryptography.hazmat.primitives.kdf.hkdf import HKDF

from core.config import settings

PREFIX = "enc:v1:"
NONCE_BYTES = 12


def _b64d(value: str) -> bytes:
    return base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))


def _b64e(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).rstrip(b"=").decode("ascii")


def _derive(info: bytes) -> bytes:
    return HKDF(algorithm=SHA256(), length=32, salt=None, info=info).derive(
        settings.SECRET_KEY.encode("utf-8")
    )


@lru_cache(maxsize=1)
def _data_key() -> bytes:
    raw = settings.DATA_ENCRYPTION_KEY
    if raw:
        key = base64.b64decode(raw)
        if len(key) != 32:
            raise RuntimeError("DATA_ENCRYPTION_KEY должен быть 32 байта в base64")
        return key
    # Только DEBUG (config не пускает прод без ключа).
    return _derive(b"lemko-data-encryption-v1")


@lru_cache(maxsize=1)
def _pepper() -> bytes:
    return _derive(b"lemko-token-pepper-v1")


def encrypt_str(plain: str) -> str:
    nonce = os.urandom(NONCE_BYTES)
    sealed = AESGCM(_data_key()).encrypt(nonce, plain.encode("utf-8"), PREFIX.encode())
    return PREFIX + _b64e(nonce + sealed)


def decrypt_str(value: str | None) -> str | None:
    if value is None or not value.startswith(PREFIX):
        return value
    blob = _b64d(value[len(PREFIX):])
    plain = AESGCM(_data_key()).decrypt(blob[:NONCE_BYTES], blob[NONCE_BYTES:], PREFIX.encode())
    return plain.decode("utf-8")


def token_hash(token: str) -> str:
    return hmac.new(_pepper(), token.encode("utf-8"), hashlib.sha256).hexdigest()


def hashes_equal(a: str, b: str) -> bool:
    return hmac.compare_digest(a.encode("ascii"), b.encode("ascii"))


def numeric_code(digits: int = 6) -> str:
    return f"{secrets.randbelow(10 ** digits):0{digits}d}"


def url_token(nbytes: int = 32) -> str:
    return secrets.token_urlsafe(nbytes)
