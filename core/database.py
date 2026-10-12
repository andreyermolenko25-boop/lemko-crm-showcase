"""Подключение к PostgreSQL: engine, фабрика сессий, декларативная база.

DATABASE_URL уже содержит sslmode (см. config.POSTGRES_SSLMODE): трафик
до БД идёт по TLS, если sslmode не disable. Alembic берёт ту же строку.
"""

from collections.abc import Generator

from sqlalchemy import create_engine
from sqlalchemy.orm import Session, declarative_base, sessionmaker

from core.config import settings

# Строка подключения приходит из .env через config.py — в коде секретов нет.
SQLALCHEMY_DATABASE_URL = settings.DATABASE_URL

engine = create_engine(
    SQLALCHEMY_DATABASE_URL,
    pool_pre_ping=True,   # проверяет живость соединения перед выдачей из пула
    pool_size=10,
    max_overflow=20,
    future=True,
)

SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)

Base = declarative_base()


def get_db() -> Generator[Session, None, None]:
    """
    FastAPI-зависимость: одна сессия на один HTTP-запрос.

    Сессия гарантированно закрывается в finally, даже если обработчик упал.
    """
    import audit

    db = SessionLocal()
    audit.attach_session(db)
    try:
        yield db
    finally:
        db.close()
