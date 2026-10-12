"""
Окружение Alembic.

Отличия от шаблона по умолчанию:
  * строка подключения берётся из .env через config.py (в alembic.ini её нет);
  * target_metadata указывает на Base.metadata, поэтому autogenerate видит
    все модели и сам пишет ALTER TABLE при изменении models.py;
  * включены compare_type / compare_server_default — иначе Alembic не заметит
    смену типа колонки или значения по умолчанию.

Важно: чтобы новая таблица попала в автогенерацию, её модуль должен быть
импортирован здесь (см. `import models` ниже).
"""

from logging.config import fileConfig
from pathlib import Path
import sys

from sqlalchemy import engine_from_config, pool

from alembic import context

# Корень проекта в sys.path — иначе `import models` не сработает
# при запуске alembic из другой директории.
sys.path.append(str(Path(__file__).resolve().parents[1]))

import models  # noqa: E402  (нужен для регистрации таблиц в Base.metadata)
from core.config import settings  # noqa: E402
from core.database import Base  # noqa: E402

config = context.config

# Пароль не хранится в alembic.ini: подставляем URL из .env в рантайме.
# escape % — ConfigParser иначе воспримет его как подстановку.
config.set_main_option("sqlalchemy.url", settings.DATABASE_URL.replace("%", "%%"))

if config.config_file_name is not None:
    fileConfig(config.config_file_name)

# Цель автогенерации: описание схемы из моделей SQLAlchemy.
target_metadata = Base.metadata


def run_migrations_offline() -> None:
    """Режим offline: только генерация SQL-скрипта, без подключения к БД."""
    context.configure(
        url=config.get_main_option("sqlalchemy.url"),
        target_metadata=target_metadata,
        literal_binds=True,
        dialect_opts={"paramstyle": "named"},
        compare_type=True,
        compare_server_default=True,
    )

    with context.begin_transaction():
        context.run_migrations()


def run_migrations_online() -> None:
    """Режим online: применяем миграции к реальной базе."""
    connectable = engine_from_config(
        config.get_section(config.config_ini_section, {}),
        prefix="sqlalchemy.",
        poolclass=pool.NullPool,
    )

    with connectable.connect() as connection:
        context.configure(
            connection=connection,
            target_metadata=target_metadata,
            compare_type=True,
            compare_server_default=True,
        )

        with context.begin_transaction():
            context.run_migrations()


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
