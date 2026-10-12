<div align="center">

<img src="site-demo/icon.svg" width="56" height="56" alt="Lemko CRM logo">

# Lemko CRM — core edition

**A modular, multi-tenant CRM: FastAPI + PostgreSQL on the back, Next.js 16 on the front.**
One schema-driven core that reshapes itself for any niche — deals, contacts, bookings, invoices or objects you define yourself.

[![CI](https://github.com/andreyermolenko25-boop/lemko-crm-showcase/actions/workflows/ci.yml/badge.svg)](https://github.com/andreyermolenko25-boop/lemko-crm-showcase/actions/workflows/ci.yml)
![Python 3.12](https://img.shields.io/badge/Python-3.12-3776AB?logo=python&logoColor=white)
![FastAPI](https://img.shields.io/badge/FastAPI-0.141-009688?logo=fastapi&logoColor=white)
![PostgreSQL 15](https://img.shields.io/badge/PostgreSQL-15-4169E1?logo=postgresql&logoColor=white)
![Next.js 16](https://img.shields.io/badge/Next.js-16-000000?logo=nextdotjs&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-5.7-3178C6?logo=typescript&logoColor=white)
![License: view only](https://img.shields.io/badge/license-view--only-lightgrey)

[**Live landing page**](https://andreyermolenko25-boop.github.io/lemko-crm-showcase/) ·
[Run the CRM locally](#run-the-crm-locally) ·
[Architecture](docs/ARCHITECTURE.md) ·
[По-русски](README.ru.md)

</div>

![Dashboard](docs/images/dashboard.png)

## About this repository

Lemko CRM is a product I design and build on my own. This repository is a **portfolio edition of its core**:
the parts that show how the system is engineered — multi-tenancy, security, the schema-driven data layer,
analytics and the UI — with a working Docker setup, demo data and tests.

Several product modules (automations engine, shared e-mail inbox, online booking with payments, web forms,
duplicate detection, import/migration from other CRMs, document generation, the code-module studio) and the
source of the marketing site are **not published**. The [landing page](https://andreyermolenko25-boop.github.io/lemko-crm-showcase/)
is included only as a compiled static build in [`site-demo/`](site-demo).

## What's inside

| | |
|---|---|
| **Schema-driven CRM** | Every object (deals, contacts, companies, tasks, invoices, custom objects) is described by a schema. Lists, boards, calendars, record pages, search, reports and dashboard widgets work for any object automatically — including ones a user creates in the UI. |
| **Modules** | Niche packs (bookings & services, invoicing, inventory, projects, support, real estate) are pure configuration: install one and its objects appear everywhere. |
| **Hybrid storage** | Objects with real business rules live in their own tables (clients with unique phones, appointments that cannot overlap, stock that is written off). Everything else is a JSONB record — behind one `/records` API. |
| **Server-side analytics** | KPI, trend, funnel, leaderboard, goal and breakdown widgets are computed in Python for the selected period; the browser only renders them. |
| **Security** | argon2id passwords, server-side sessions behind an httpOnly cookie (the JWT never reaches JavaScript), TOTP / SMS / passkey 2FA with backup codes, OAuth sign-in, re-auth for sensitive changes, rate limiting, per-workspace policy (forced 2FA, IP allowlist, session timeout), CSP with per-request nonces. |
| **Integrations API** | API keys (hashed, shown once, revocable) for an external REST API; webhooks signed with HMAC, secrets encrypted at rest (AES-GCM), delivered by a worker from a transactional outbox with retries and exponential back-off; outbound requests guarded against SSRF. |
| **Data integrity** | Tenant isolation from the signed token, append-only audit log enforced by a trigger, soft delete with restore, PostgreSQL exclusion constraints + constraint triggers so two bookings can never take the same slot — even under concurrency. |
| **UX** | Light/dark themes, accent colours, density and text size, ⌘K command palette, drag-and-drop dashboards, inline editing, five interface languages (EN, PL, DE, UK, RU) with regional number/currency/date formats. |

### A few things worth a closer look

- **Concurrency-safe booking.** `tests/test_core_e2e.py` fires 50 parallel requests at the same time slot:
  exactly one wins, 49 get `409`. A GiST exclusion constraint, row locks and two constraint triggers
  ([migration](alembic/versions)) keep appointments inside staff shifts and shifts from shrinking under them.
- **The token never touches the browser.** The Next.js BFF (`frontend/app/api/*`) exchanges credentials for a
  server-side session and forwards `/api/backend/*` calls with the bearer token; sessions can be listed and
  revoked from the UI.
- **Outbox + worker.** Events are written in the same transaction as the change (`outbox.py`); `worker.py`
  claims rows with `FOR UPDATE SKIP LOCKED`, signs webhook payloads and retries with back-off.
- **One code path for every write.** UI, external API and the demo seeder all go through
  `records.create_record` → `events.record_changed` → activity feed, notifications, webhooks.

## Screenshots

| Pipeline board | Record page with timeline |
|---|---|
| ![Deals pipeline](docs/images/pipeline.png) | ![Deal record](docs/images/record.png) |
| **Modules catalogue** | **Security & login** |
| ![Modules](docs/images/modules.png) | ![Security settings](docs/images/security.png) |
| **Sign in** | **Landing page (static build)** |
| ![Sign in](docs/images/sign-in.png) | ![Landing page](docs/images/landing.png) |

## Run the CRM locally

Requirements: **Docker Desktop** (or Docker Engine with Compose v2) and **Git**. Nothing else needs to be installed.

```bash
git clone https://github.com/andreyermolenko25-boop/lemko-crm-showcase.git
cd lemko-crm-showcase
docker compose up --build -d
```

The first build takes a few minutes. When `docker compose ps` shows the services as healthy, load the demo workspace:

```bash
docker compose exec backend python scripts/seed_demo.py
```

Then open **http://localhost:3000** and sign in:

| Email | Password |
|---|---|
| `demo@lemko.dev` | `lemko-demo-2026` |

The seeder creates a fictional company with three team members, six client companies, eight contacts,
twelve deals in different stages and six tasks. You can also register a fresh workspace at `/register`.

| URL | What |
|---|---|
| http://localhost:3000 | The CRM (Next.js) |
| http://localhost:8000/docs | API reference (Swagger UI) |
| `localhost:5432` | PostgreSQL (`lemko_admin` / `change_me`) |

<details>
<summary><b>Ports already in use?</b></summary>

Every published port can be changed with an environment variable:

```bash
WEB_PORT=3300 API_PORT=8100 DB_PORT=5433 PUBLIC_APP_URL=http://localhost:3300 docker compose up --build -d
```

On Windows PowerShell set them first: `$env:WEB_PORT=3300; $env:API_PORT=8100; $env:DB_PORT=5433; $env:PUBLIC_APP_URL="http://localhost:3300"`.
</details>

<details>
<summary><b>Things to try</b></summary>

- Drag a deal across the pipeline, or open it and click a stage — the activity feed and dashboard update.
- **Customize** a dashboard: add widgets, resize and reorder them.
- **Settings → Objects & fields**: add a custom field or a whole new object — it gets list, board and calendar views immediately.
- **Apps**: install the *Projects* or *Support Desk* module.
- **Settings → Security & login**: set up an authenticator app (scan the QR with any TOTP app) and sign in again.
  E-mails and SMS codes are written to the worker log in this local setup: `docker compose logs -f worker`.
- **Settings → API & webhooks**: create an API key and call the external API:
  `curl -H "X-API-Key: <key>" http://localhost:8000/api/v1/external/clients`
- Switch the interface language (user menu) or the theme (moon icon in the top bar).
</details>

Stop everything with `docker compose down` (add `-v` to also delete the database).

## Run the landing page locally

The marketing site is published as a static build only (HTML, CSS and minified JS — no source).
It is live at **https://andreyermolenko25-boop.github.io/lemko-crm-showcase/**, or serve it yourself:

```bash
npx serve site-demo
```

Open the printed address (http://localhost:3000 by default; use `npx serve site-demo -l 3200` if the CRM already
runs on 3000). Requires Node.js 18+. Checkout is disabled in this build.

## Tests

The backend tests run against a real PostgreSQL (exclusion constraints and JSONB cannot be tested on SQLite):

```bash
docker compose --profile test run --rm tests
```

28 tests cover: the generic records API and activity feed, native objects (contacts, services, stock),
shifts and appointments with conflict detection, a 50-request race on one slot, analytics formulas,
members and mentions, error codes, sign-in, sessions and revocation, TOTP two-step login, re-auth,
password reset, e-mail change, workspace security policy, API keys, webhook SSRF protection and secret encryption.

Frontend checks:

```bash
cd frontend
pnpm install
pnpm typecheck
pnpm build
```

Both suites run in [GitHub Actions](.github/workflows/ci.yml) on every push, together with an
`alembic upgrade head` + `alembic check` against an empty database.

## Development without Docker

<details>
<summary>Backend (Python 3.12) and frontend (Node 22, pnpm 9)</summary>

```bash
# database only
docker compose up -d db

# API
python -m venv .venv && source .venv/bin/activate   # Windows: .venv\Scripts\activate
pip install -r requirements-dev.txt
cp .env.example .env            # set POSTGRES_SSLMODE=disable and DEBUG=true for local work
alembic upgrade head
uvicorn main:app --reload       # http://localhost:8000/docs
python worker.py                # second terminal: outbox, reminders, digests

# UI
cd frontend
cp .env.example .env.local      # API_URL=http://localhost:8000
pnpm install && pnpm dev        # http://localhost:3000
```
</details>

## Tech stack

| Layer | Technology |
|---|---|
| API | Python 3.12, FastAPI, Pydantic v2, SQLAlchemy 2.0, Alembic |
| Database | PostgreSQL 15 (JSONB, GiST exclusion constraints, constraint triggers) |
| Security | argon2id (passlib), PyJWT, WebAuthn passkeys, TOTP (RFC 6238), AES-GCM via `cryptography` |
| Background jobs | Transactional outbox + worker (`FOR UPDATE SKIP LOCKED`), SMTP / AWS SNS / Twilio adapters |
| Storage | Local disk or S3-compatible (MinIO, AWS S3) for attachments |
| Frontend | Next.js 16 (App Router, Turbopack), React 19, TypeScript, Tailwind CSS v4, Radix UI, Recharts, Motion |
| Tooling | Docker Compose, pytest + httpx, GitHub Actions |

## Project structure

```
main.py              FastAPI app: core REST endpoints (companies, staff, clients, services, stock, shifts, appointments, payments)
routers/             auth, security & sessions, records, workspace, activities, analytics, members, integrations, external API
core/                config, database, auth (sessions, MFA, OAuth, policy), security, crypto, rate limit, SSRF guard, middleware
records.py           one record API over native tables and generic JSONB records
scheduling.py        shifts and appointments: overlap and shift-coverage rules
stats.py             server-side formulas for widgets and reports
events.py            what happens after a change: feed, notifications, webhooks
outbox.py, worker.py reliable delivery of webhooks, e-mails and SMS
alembic/             schema migration (incl. hand-written constraint triggers)
scripts/             demo data seeder
tests/               pytest suite (PostgreSQL)
frontend/            Next.js app — see frontend/README.md
site-demo/           compiled landing page (static export)
docs/                architecture notes and screenshots
```

More detail on the design decisions: **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)**.

## License

Copyright © 2026 Andrii Yermolenko. **All rights reserved.**
The code is published so it can be read and evaluated (for example during a hiring process) — see [LICENSE](LICENSE).
It may not be copied, reused or deployed as a product or service without written permission.

---

Built by **Andrii Yermolenko** · [github.com/andreyermolenko25-boop](https://github.com/andreyermolenko25-boop)
