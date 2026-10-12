"""
Инфраструктура pytest для ядра Lemko.

Ядро — sync SQLAlchemy + psycopg2 (ExcludeConstraint / JSONB → только PostgreSQL).
HTTP в тестах — httpx.AsyncClient; get_db переопределён на TEST_DATABASE_URL.

Схему поднимаем sync-движком (тот же драйвер, что в проде). asyncpg здесь
не используем: на Windows без MSVC его часто нельзя собрать, а эндпоинты sync.
"""

from __future__ import annotations

import asyncio
import os
import uuid
from collections.abc import AsyncIterator, Iterator
from pathlib import Path

from dotenv import load_dotenv

# Поднимаемся на уровень выше из папки tests и грузим .env
env_path = Path(__file__).parent.parent / ".env"
load_dotenv(dotenv_path=env_path)

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from sqlalchemy import Engine, create_engine, text
from sqlalchemy.orm import Session, sessionmaker

import models  # noqa: E402, F401
from core.database import Base, get_db
from main import app


def _require_test_database_url() -> str:
    url = os.getenv("TEST_DATABASE_URL")
    if not url:
        pytest.fail(
            "Задай TEST_DATABASE_URL в .env (PostgreSQL lemko_crm_test). "
            "In-memory SQLite не подходит: GiST ExcludeConstraint и JSONB. "
            f"Ожидался файл: {env_path}"
        )
    return url


def _to_sync_url(url: str) -> str:
    if url.startswith("postgresql+asyncpg://"):
        return "postgresql+psycopg2://" + url.removeprefix("postgresql+asyncpg://")
    if url.startswith("postgresql+psycopg2://"):
        return url
    if url.startswith("postgresql://"):
        return "postgresql+psycopg2://" + url.removeprefix("postgresql://")
    return url


def _prepare_schema(engine: Engine) -> None:
    with engine.begin() as conn:
        conn.execute(text("CREATE EXTENSION IF NOT EXISTS btree_gist"))
        Base.metadata.drop_all(bind=conn)
        Base.metadata.create_all(bind=conn)


def _drop_schema(engine: Engine) -> None:
    with engine.begin() as conn:
        Base.metadata.drop_all(bind=conn)


@pytest.fixture(scope="session")
def test_database_url() -> str:
    return _require_test_database_url()


@pytest_asyncio.fixture(scope="session")
async def async_engine(test_database_url: str) -> AsyncIterator[Engine]:
    """
    Тестовый движок БД (session scope).

    create_all перед сессией pytest, drop_all после. Обёртка async, чтобы
    соседние async-фикстуры (async_client) жили в одном event loop; DDL
    выполняется sync psycopg2 в thread pool.
    """
    engine = create_engine(
        _to_sync_url(test_database_url),
        pool_pre_ping=True,
        pool_size=40,
        max_overflow=40,
        future=True,
    )
    await asyncio.to_thread(_prepare_schema, engine)
    yield engine
    await asyncio.to_thread(_drop_schema, engine)
    engine.dispose()


@pytest.fixture(scope="session")
def TestingSessionLocal(async_engine: Engine) -> sessionmaker[Session]:
    return sessionmaker(autocommit=False, autoflush=False, bind=async_engine)


@pytest.fixture(autouse=True)
def override_get_db(TestingSessionLocal: sessionmaker[Session]) -> Iterator[None]:
    """Все Depends(get_db) в тестах смотрят только в TEST_DATABASE_URL."""

    def _get_db() -> Iterator[Session]:
        import audit

        db = TestingSessionLocal()
        audit.attach_session(db)
        try:
            yield db
        finally:
            db.close()

    app.dependency_overrides[get_db] = _get_db
    yield
    app.dependency_overrides.pop(get_db, None)


@pytest.fixture(autouse=True)
def truncate_tables(async_engine: Engine) -> Iterator[None]:
    """Изоляция: после каждого теста — TRUNCATE CASCADE."""
    yield
    table_names = ", ".join(
        f'"{table.name}"' for table in reversed(Base.metadata.sorted_tables)
    )
    if not table_names:
        return
    with async_engine.begin() as conn:
        conn.execute(text(f"TRUNCATE {table_names} RESTART IDENTITY CASCADE"))


@pytest.fixture
def db_session(TestingSessionLocal: sessionmaker[Session]) -> Iterator[Session]:
    """Прямой SELECT в тестовую БД (минуя HTTP)."""
    db = TestingSessionLocal()
    try:
        yield db
    finally:
        db.close()


@pytest_asyncio.fixture
async def async_client() -> AsyncIterator[AsyncClient]:
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        yield client


@pytest_asyncio.fixture
async def test_company(async_client: AsyncClient) -> dict:
    """Регистрирует тенанта + владельца через публичный POST /companies."""
    suffix = uuid.uuid4().hex[:8]
    payload = {
        "name": f"Test Co {suffix}",
        "niche": "other",
        "timezone": "UTC",
        "owner": {
            "username": f"owner_{suffix}",
            "password": "test-pass-1",
            "role": "owner",
        },
    }
    response = await async_client.post("/companies", json=payload)
    assert response.status_code == 201, response.text
    body = response.json()
    return {
        "company": body["company"],
        "owner": body["owner"],
        "owner_password": payload["owner"]["password"],
        "owner_username": payload["owner"]["username"],
    }


@pytest_asyncio.fixture
async def auth_headers(async_client: AsyncClient, test_company: dict) -> dict[str, str]:
    """JWT владельца для защищённых эндпоинтов."""
    response = await async_client.post(
        "/auth/login",
        json={
            "company_id": test_company["company"]["id"],
            "username": test_company["owner_username"],
            "password": test_company["owner_password"],
        },
    )
    assert response.status_code == 200, response.text
    token = response.json()["access_token"]
    return {"Authorization": f"Bearer {token}"}
