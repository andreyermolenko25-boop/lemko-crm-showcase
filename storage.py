"""
Хранилище байт вложений: локальный диск или S3-совместимое (AWS / MinIO).

Ядро не знает нишу: кладёт объект по ключу и отдаёт его обратно.
Секреты только из окружения.
"""

from __future__ import annotations

from functools import lru_cache
from pathlib import Path
from typing import Protocol

from core.config import settings


class StorageError(RuntimeError):
    pass


class StorageBackend(Protocol):
    def save(self, *, key: str, data: bytes, mime_type: str) -> None: ...

    def delete(self, *, key: str) -> None: ...

    def open_path(self, *, key: str) -> Path | None:
        """Локальный путь для FileResponse. S3 возвращает None."""

    def presign_get(self, *, key: str) -> str | None:
        """Временная ссылка на объект. Локальный бэкенд — None."""


class LocalStorage:
    def __init__(self, root: Path) -> None:
        self.root = root
        self.root.mkdir(parents=True, exist_ok=True)

    def _path(self, key: str) -> Path:
        relative = Path(key)
        if relative.is_absolute() or ".." in relative.parts:
            raise StorageError("Некорректный ключ объекта")
        return self.root.joinpath(relative)

    def save(self, *, key: str, data: bytes, mime_type: str) -> None:  # noqa: ARG002
        path = self._path(key)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)

    def delete(self, *, key: str) -> None:
        path = self._path(key)
        try:
            path.unlink()
        except FileNotFoundError:
            return

    def open_path(self, *, key: str) -> Path | None:
        path = self._path(key)
        return path if path.is_file() else None

    def presign_get(self, *, key: str) -> str | None:  # noqa: ARG002
        return None


class S3Storage:
    def __init__(self) -> None:
        try:
            import boto3
            from botocore.config import Config as BotoConfig
        except ImportError as exc:
            raise StorageError(
                "Для STORAGE_BACKEND=s3 нужен пакет boto3 (pip install boto3)"
            ) from exc

        if not settings.STORAGE_S3_BUCKET:
            raise StorageError("STORAGE_S3_BUCKET не задан")
        if not settings.STORAGE_S3_ACCESS_KEY or not settings.STORAGE_S3_SECRET_KEY:
            raise StorageError("Задай STORAGE_S3_ACCESS_KEY и STORAGE_S3_SECRET_KEY")

        kwargs: dict = {
            "aws_access_key_id": settings.STORAGE_S3_ACCESS_KEY,
            "aws_secret_access_key": settings.STORAGE_S3_SECRET_KEY,
            "region_name": settings.STORAGE_S3_REGION,
            "config": BotoConfig(signature_version="s3v4"),
        }
        if settings.STORAGE_S3_ENDPOINT:
            kwargs["endpoint_url"] = settings.STORAGE_S3_ENDPOINT
        self._client = boto3.client("s3", **kwargs)
        self._bucket = settings.STORAGE_S3_BUCKET

    def save(self, *, key: str, data: bytes, mime_type: str) -> None:
        extra = {"ContentType": mime_type} if mime_type else {}
        self._client.put_object(
            Bucket=self._bucket, Key=key, Body=data, **extra
        )

    def delete(self, *, key: str) -> None:
        self._client.delete_object(Bucket=self._bucket, Key=key)

    def open_path(self, *, key: str) -> Path | None:  # noqa: ARG002
        return None

    def presign_get(self, *, key: str) -> str | None:
        return self._client.generate_presigned_url(
            "get_object",
            Params={"Bucket": self._bucket, "Key": key},
            ExpiresIn=300,
        )


@lru_cache(maxsize=1)
def get_storage() -> StorageBackend:
    backend = settings.STORAGE_BACKEND
    if backend == "local":
        return LocalStorage(settings.STORAGE_LOCAL_DIR)
    if backend == "s3":
        return S3Storage()
    raise StorageError(f"Неизвестный STORAGE_BACKEND={backend!r} (local или s3)")
