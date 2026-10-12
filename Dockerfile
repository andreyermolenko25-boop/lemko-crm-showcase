# Образ API Lemko CRM (FastAPI + uvicorn).
FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1

WORKDIR /app

# libpq для psycopg2-binary на slim обычно не нужен; curl — для healthcheck.
RUN apt-get update \
    && apt-get install -y --no-install-recommends curl \
    && rm -rf /var/lib/apt/lists/*

# INSTALL_DEV=true — образ для pytest (сервис tests в docker-compose.yml).
ARG INSTALL_DEV=false
COPY requirements.txt requirements-dev.txt ./
RUN pip install --upgrade pip \
    && if [ "$INSTALL_DEV" = "true" ]; then pip install -r requirements-dev.txt; else pip install -r requirements.txt; fi

COPY . .

# Миграции при старте, затем API.
EXPOSE 8000
CMD ["sh", "-c", "alembic upgrade head && uvicorn main:app --host 0.0.0.0 --port 8000"]
