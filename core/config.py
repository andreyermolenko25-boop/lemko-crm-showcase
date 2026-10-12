"""
Конфигурация приложения: единственное место, где читается окружение.

Значения берутся из файла .env (через python-dotenv), а если переменная задана
в системном окружении (docker, CI, прод) — приоритет у него, .env её не
перетирает. Секретов в коде нет: при отсутствии обязательной переменной
приложение падает сразу на старте, а не в момент первого запроса.
"""

from __future__ import annotations

import os
from pathlib import Path
from urllib.parse import parse_qsl, quote_plus, urlencode, urlsplit, urlunsplit

from dotenv import load_dotenv

# Корень репозитория (рядом с main.py), не пакет core/.
BASE_DIR = Path(__file__).resolve().parent.parent

# override=False: системное окружение сильнее .env.
load_dotenv(BASE_DIR / ".env", override=False)

# libpq / psycopg2. require — шифрование без проверки CA (разные VM).
# verify-full — прод с своим CA (тогда нужен POSTGRES_SSLROOTCERT).
_ALLOWED_SSLMODES = frozenset(
    {"disable", "allow", "prefer", "require", "verify-ca", "verify-full"}
)


class ConfigError(RuntimeError):
    """Конфигурация неполная или некорректная."""


def _get(name: str, default: str | None = None) -> str | None:
    value = os.getenv(name)
    # Пустая строка в .env считается "не задано".
    return value if value not in (None, "") else default


def _require(name: str) -> str:
    value = _get(name)
    if value is None:
        raise ConfigError(
            f"Переменная окружения {name} не задана. "
            f"Скопируй .env.example в .env и заполни значения."
        )
    return value


def _require_int(name: str, default: int) -> int:
    raw = _get(name)
    if raw is None:
        return default
    try:
        return int(raw)
    except ValueError as exc:
        raise ConfigError(f"{name} должна быть целым числом, получено: {raw!r}") from exc


def _with_ssl_query(url: str, *, sslmode: str, sslrootcert: str | None) -> str:
    """
    Гарантирует sslmode в query-строке. Уже заданный в DATABASE_URL не трогаем:
    локальный docker без TLS может явно поставить sslmode=disable.
    """
    parts = urlsplit(url)
    query = dict(parse_qsl(parts.query, keep_blank_values=True))
    query.setdefault("sslmode", sslmode)
    if sslrootcert and "sslrootcert" not in query:
        query["sslrootcert"] = sslrootcert
    return urlunsplit(
        (parts.scheme, parts.netloc, parts.path, urlencode(query), parts.fragment)
    )


class Settings:
    """Собранная конфигурация. Экземпляр создаётся один раз при импорте."""

    def __init__(self) -> None:
        # --- База данных / TLS ---
        # По умолчанию require: канал FastAPI↔PostgreSQL шифруется (особенно
        # важно, если бэкенд и БД на разных машинах). Локальный postgres:15
        # без SSL — поставь POSTGRES_SSLMODE=disable.
        sslmode = (_get("POSTGRES_SSLMODE", "require") or "require").lower()
        if sslmode not in _ALLOWED_SSLMODES:
            raise ConfigError(
                f"POSTGRES_SSLMODE должен быть одним из: {', '.join(sorted(_ALLOWED_SSLMODES))}"
            )
        self.POSTGRES_SSLMODE: str = sslmode
        sslrootcert = _get("POSTGRES_SSLROOTCERT")
        if sslrootcert:
            cert_path = Path(sslrootcert)
            if not cert_path.is_file():
                raise ConfigError(
                    f"POSTGRES_SSLROOTCERT не найден: {sslrootcert}"
                )
            self.POSTGRES_SSLROOTCERT: str | None = str(cert_path.resolve())
        else:
            self.POSTGRES_SSLROOTCERT = None
        if sslmode in ("verify-ca", "verify-full") and not self.POSTGRES_SSLROOTCERT:
            raise ConfigError(
                f"Для sslmode={sslmode} задай POSTGRES_SSLROOTCERT (путь к CA)"
            )

        raw_url = _get("DATABASE_URL") or self._build_database_url()
        self.DATABASE_URL: str = _with_ssl_query(
            raw_url,
            sslmode=self.POSTGRES_SSLMODE,
            sslrootcert=self.POSTGRES_SSLROOTCERT,
        )

        # --- JWT ---
        self.SECRET_KEY: str = _require("SECRET_KEY")
        self.JWT_ALGORITHM: str = _get("JWT_ALGORITHM", "HS256")  # type: ignore[assignment]
        self.ACCESS_TOKEN_EXPIRE_MINUTES: int = _require_int("ACCESS_TOKEN_EXPIRE_MINUTES", 15)

        # --- Прочее ---
        self.DEBUG: bool = _get("DEBUG", "false").lower() in ("1", "true", "yes")  # type: ignore[union-attr]
        if self.JWT_ALGORITHM not in ("HS256", "HS384", "HS512"):
            raise ConfigError("JWT_ALGORITHM должен быть HS256, HS384 или HS512")
        # CORS для Next.js (через запятую). Пусто — только same-origin.
        raw_cors = _get("CORS_ORIGINS", "http://localhost:3000") or ""
        self.CORS_ORIGINS: list[str] = [
            item.strip() for item in raw_cors.split(",") if item.strip()
        ]

        # Публичный адрес API. Пусто — хост запроса.
        self.PUBLIC_API_URL: str | None = _get("PUBLIC_API_URL")

        # --- Файлы ---
        # local — диск (STORAGE_LOCAL_DIR). s3 — AWS или MinIO (STORAGE_S3_ENDPOINT).
        backend = (_get("STORAGE_BACKEND", "local") or "local").lower()
        if backend not in ("local", "s3"):
            raise ConfigError("STORAGE_BACKEND должен быть local или s3")
        self.STORAGE_BACKEND: str = backend
        local_dir = _get("STORAGE_LOCAL_DIR", "var/attachments") or "var/attachments"
        path = Path(local_dir)
        self.STORAGE_LOCAL_DIR: Path = path if path.is_absolute() else BASE_DIR / path
        self.STORAGE_MAX_BYTES: int = _require_int("STORAGE_MAX_BYTES", 20 * 1024 * 1024)
        raw_mime = _get(
            "STORAGE_ALLOWED_MIME",
            "image/jpeg,image/png,image/webp,image/heic,image/gif,application/pdf,application/dicom",
        )
        self.STORAGE_ALLOWED_MIME: tuple[str, ...] = tuple(
            item.strip().lower()
            for item in (raw_mime or "").split(",")
            if item.strip()
        )
        self.STORAGE_S3_ENDPOINT: str | None = _get("STORAGE_S3_ENDPOINT")
        self.STORAGE_S3_BUCKET: str | None = _get("STORAGE_S3_BUCKET")
        self.STORAGE_S3_ACCESS_KEY: str | None = _get("STORAGE_S3_ACCESS_KEY")
        self.STORAGE_S3_SECRET_KEY: str | None = _get("STORAGE_S3_SECRET_KEY")
        self.STORAGE_S3_REGION: str = _get("STORAGE_S3_REGION", "us-east-1") or "us-east-1"
        self.STORAGE_S3_PREFIX: str = _get("STORAGE_S3_PREFIX", "") or ""

        # --- Доставка outbox и фоновые задачи (worker.py) ---
        # SMTP — письма сотрудникам и клиентам.
        self.SMTP_HOST: str | None = _get("SMTP_HOST")
        self.SMTP_PORT: int = _require_int("SMTP_PORT", 587)
        self.SMTP_USERNAME: str | None = _get("SMTP_USERNAME")
        self.SMTP_PASSWORD: str | None = _get("SMTP_PASSWORD")
        self.SMTP_FROM: str | None = _get("SMTP_FROM") or self.SMTP_USERNAME
        self.SMTP_STARTTLS: bool = (_get("SMTP_STARTTLS", "true") or "true").lower() in ("1", "true", "yes")
        # smtp — отправлять; log — только записать в лог воркера (разработка);
        # none — письма не уходят, строка outbox падает с понятной ошибкой.
        default_email = "smtp" if self.SMTP_HOST else ("log" if self.DEBUG else "none")
        self.NOTIFY_EMAIL_BACKEND: str = (_get("NOTIFY_EMAIL_BACKEND") or default_email).lower()
        if self.NOTIFY_EMAIL_BACKEND not in ("smtp", "log", "none"):
            raise ConfigError("NOTIFY_EMAIL_BACKEND должен быть smtp, log или none")
        self.WORKER_BATCH_SIZE: int = _require_int("WORKER_BATCH_SIZE", 20)
        self.WORKER_POLL_SECONDS: int = _require_int("WORKER_POLL_SECONDS", 2)
        self.WORKER_MAX_ATTEMPTS: int = _require_int("WORKER_MAX_ATTEMPTS", 5)
        self.WEBHOOK_TIMEOUT_SECONDS: int = _require_int("WEBHOOK_TIMEOUT_SECONDS", 10)
        # Вебхуки на localhost / приватные сети (169.254.169.254 — метаданные AWS!)
        # запрещены. Разрешать только для локальной разработки.
        self.WEBHOOK_ALLOW_PRIVATE: bool = (_get("WEBHOOK_ALLOW_PRIVATE", "false") or "false").lower() in ("1", "true", "yes")

        # --- Безопасность ---
        self._init_security()

    def _init_security(self) -> None:
        # Слабый ключ подписи JWT = подделка любой сессии. В проде не стартуем.
        if not self.DEBUG and (len(self.SECRET_KEY) < 32 or "change_me" in self.SECRET_KEY):
            raise ConfigError(
                "SECRET_KEY слишком короткий (нужно ≥ 32 символов случайных данных). "
                "Сгенерируй: python -c \"import secrets; print(secrets.token_urlsafe(48))\""
            )
        # Ключ шифрования полей (TOTP-секреты, секреты вебхуков): 32 байта base64.
        # В проде — из AWS Secrets Manager / KMS. В DEBUG выводится из SECRET_KEY.
        self.DATA_ENCRYPTION_KEY: str | None = _get("DATA_ENCRYPTION_KEY")
        if not self.DEBUG and not self.DATA_ENCRYPTION_KEY:
            raise ConfigError(
                "DATA_ENCRYPTION_KEY не задан. Сгенерируй: "
                "python -c \"import base64, os; print(base64.b64encode(os.urandom(32)).decode())\""
            )
        # Прокси перед API, которым можно верить в X-Forwarded-For (BFF Next.js, ALB).
        # Чужой X-Forwarded-For игнорируется — иначе IP подделывается заголовком.
        raw_proxies = _get(
            "TRUSTED_PROXY_CIDRS",
            "127.0.0.1/32,::1/128,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16",
        ) or ""
        self.TRUSTED_PROXY_CIDRS: tuple[str, ...] = tuple(
            item.strip() for item in raw_proxies.split(",") if item.strip()
        )
        # Сессии: абсолютный срок жизни и запись last_seen не чаще раза в N секунд.
        self.SESSION_ABSOLUTE_HOURS: int = _require_int("SESSION_ABSOLUTE_HOURS", 12)
        self.SESSION_TOUCH_SECONDS: int = _require_int("SESSION_TOUCH_SECONDS", 60)
        # Привязка сессии к IP: мобильная сеть меняет IP, поэтому по умолчанию
        # проверяется только устройство (User-Agent). true — строгий режим.
        self.SESSION_BIND_IP: bool = (_get("SESSION_BIND_IP", "false") or "false").lower() in ("1", "true", "yes")

        # Адрес интерфейса: ссылки в письмах, WebAuthn origin, OAuth redirect.
        self.PUBLIC_APP_URL: str = (_get("PUBLIC_APP_URL", "http://localhost:3000") or "").rstrip("/")
        app_host = urlsplit(self.PUBLIC_APP_URL).hostname or "localhost"
        self.WEBAUTHN_RP_ID: str = _get("WEBAUTHN_RP_ID", app_host) or app_host
        self.WEBAUTHN_RP_NAME: str = _get("WEBAUTHN_RP_NAME", "Lemko CRM") or "Lemko CRM"

        # SMS: log — в лог воркера (разработка), sns — AWS SNS, twilio, none.
        default_sms = "log" if self.DEBUG else "none"
        self.SMS_BACKEND: str = (_get("SMS_BACKEND") or default_sms).lower()
        if self.SMS_BACKEND not in ("log", "sns", "twilio", "none"):
            raise ConfigError("SMS_BACKEND должен быть log, sns, twilio или none")
        self.SMS_SENDER_ID: str | None = _get("SMS_SENDER_ID")
        self.AWS_REGION: str = _get("AWS_REGION", self.STORAGE_S3_REGION) or self.STORAGE_S3_REGION
        self.TWILIO_ACCOUNT_SID: str | None = _get("TWILIO_ACCOUNT_SID")
        self.TWILIO_AUTH_TOKEN: str | None = _get("TWILIO_AUTH_TOKEN")
        self.TWILIO_FROM: str | None = _get("TWILIO_FROM")

        # Вход через Google / Microsoft / Apple (OpenID Connect). Не задан
        # client id — кнопка провайдера в интерфейсе неактивна.
        self.OAUTH_GOOGLE_CLIENT_ID: str | None = _get("OAUTH_GOOGLE_CLIENT_ID")
        self.OAUTH_GOOGLE_CLIENT_SECRET: str | None = _get("OAUTH_GOOGLE_CLIENT_SECRET")
        self.OAUTH_MICROSOFT_CLIENT_ID: str | None = _get("OAUTH_MICROSOFT_CLIENT_ID")
        self.OAUTH_MICROSOFT_CLIENT_SECRET: str | None = _get("OAUTH_MICROSOFT_CLIENT_SECRET")
        self.OAUTH_MICROSOFT_TENANT: str = _get("OAUTH_MICROSOFT_TENANT", "common") or "common"
        self.OAUTH_APPLE_CLIENT_ID: str | None = _get("OAUTH_APPLE_CLIENT_ID")
        self.OAUTH_APPLE_TEAM_ID: str | None = _get("OAUTH_APPLE_TEAM_ID")
        self.OAUTH_APPLE_KEY_ID: str | None = _get("OAUTH_APPLE_KEY_ID")
        # PEM ключа .p8; переводы строк можно передать как \n.
        raw_apple_key = _get("OAUTH_APPLE_PRIVATE_KEY")
        self.OAUTH_APPLE_PRIVATE_KEY: str | None = raw_apple_key.replace("\\n", "\n") if raw_apple_key else None

    @staticmethod
    def _build_database_url() -> str:
        user = quote_plus(_require("POSTGRES_USER"))
        password = quote_plus(_require("POSTGRES_PASSWORD"))
        db = quote_plus(_require("POSTGRES_DB"))
        host = _get("POSTGRES_HOST", "localhost") or "localhost"
        port = _get("POSTGRES_PORT", "5432") or "5432"
        # sslmode дописывает __init__ через _with_ssl_query.
        return f"postgresql+psycopg2://{user}:{password}@{host}:{port}/{db}"

    def __repr__(self) -> str:
        # Пароль и ключ в логи не попадают.
        return (
            f"<Settings db_host_ok={bool(self.DATABASE_URL)} "
            f"sslmode={self.POSTGRES_SSLMODE} algo={self.JWT_ALGORITHM}>"
        )


settings = Settings()
