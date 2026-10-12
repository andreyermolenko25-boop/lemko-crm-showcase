"""
Демо-воркспейс для локальной проверки: компания, владелец и двое коллег,
компании-клиенты, контакты, сделки на разных стадиях и задачи.

    docker compose exec backend python scripts/seed_demo.py

Затем вход на http://localhost:3000:  demo@lemko.dev / lemko-demo-2026
(только для локального стенда — на публичном сервере не запускай).

Записи создаются через records.create_record — тот же путь, что у интерфейса,
поэтому срабатывают те же проверки, лента и уведомления. Повторный запуск
ничего не дублирует: если владелец демо уже есть, скрипт выходит.
Все компании и люди вымышленные.
"""

from __future__ import annotations

import random
import secrets
import sys
from datetime import datetime, time, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import models  # noqa: E402
import records  # noqa: E402
from core.auth import register_studio  # noqa: E402
from core.database import SessionLocal  # noqa: E402
from core.security import hash_password  # noqa: E402

DEMO_EMAIL = "demo@lemko.dev"
DEMO_PASSWORD = "lemko-demo-2026"

COMPANIES = [
    ("Bluefin Logistics", "bluefin.example", "Logistics", 240, 18_500_000, "Gdańsk", "enterprise", 4),
    ("Acorn Health", "acornhealth.example", "Healthcare", 85, 6_200_000, "Kraków", "mid", 5),
    ("Kestrel Retail", "kestrel.example", "Retail", 1200, 54_000_000, "Berlin", "enterprise", 3),
    ("Vela Finance", "vela.example", "Finance", 60, 9_800_000, "Warsaw", "mid", 4),
    ("Harbor & Pine Hotels", "harborpine.example", "Hospitality", 320, 22_000_000, "Wrocław", "enterprise", 2),
    ("Quill Labs", "quill.example", "Technology", 24, 1_400_000, "Poznań", "smb", 5),
]

# (имя, должность, индекс компании, жизненный цикл, теги, email)
CONTACTS = [
    ("Marta Wisniewska", "Head of Operations", 0, "customer", ["vip", "decision"], "marta@bluefin.example"),
    ("Jonas Keller", "IT Manager", 0, "customer", ["tech"], "jonas@bluefin.example"),
    ("Elena Rossi", "COO", 1, "prospect", ["decision"], "elena@acornhealth.example"),
    ("Piotr Zielinski", "Procurement", 2, "customer", ["newsletter"], "piotr@kestrel.example"),
    ("Sofia Lindqvist", "CFO", 3, "prospect", ["decision", "vip"], "sofia@vela.example"),
    ("Daniel Okafor", "General Manager", 4, "lead", [], "daniel@harborpine.example"),
    ("Hanna Kowalczyk", "Founder", 5, "customer", ["vip"], "hanna@quill.example"),
    ("Lukas Brandt", "CTO", 5, "prospect", ["tech"], "lukas@quill.example"),
]

# (название, компания, контакт, сумма, стадия, шанс, сдвиг даты закрытия в днях, источник, приоритет, ответственный)
DEALS = [
    ("Fleet tracking rollout", 0, 0, 48_000, "won", 100, -120, "referral", "high", 0),
    ("Warehouse onboarding", 0, 1, 16_500, "won", 100, -75, "inbound", "medium", 1),
    ("Clinic network pilot", 1, 2, 22_000, "negotiation", 70, 12, "outbound", "high", 1),
    ("Store analytics — 40 sites", 2, 3, 96_000, "proposal", 50, 28, "partner", "high", 2),
    ("Seasonal staffing module", 2, 3, 12_000, "won", 100, -40, "inbound", "low", 2),
    ("Treasury reporting", 3, 4, 31_000, "qualification", 30, 45, "inbound", "medium", 0),
    ("Guest CRM migration", 4, 5, 54_000, "proposal", 40, 35, "outbound", "high", 1),
    ("Front desk tablets", 4, 5, 8_400, "lost", 0, -20, "inbound", "low", 2),
    ("Startup plan upgrade", 5, 6, 6_000, "won", 100, -10, "referral", "medium", 0),
    ("API integration package", 5, 7, 14_000, "negotiation", 80, 6, "partner", "medium", 0),
    ("Multi-region expansion", 0, 0, 72_000, "new", 10, 70, "referral", "high", 2),
    ("Compliance add-on", 3, 4, 9_500, "won", 100, -150, "inbound", "low", 1),
]

# (заголовок, тип, статус, срок через N дней, индекс компании, индекс сделки)
TASKS = [
    ("Send revised proposal to Kestrel", "email", "todo", 1, 2, 3),
    ("Kick-off call with Acorn Health", "call", "todo", 0, 1, 2),
    ("Prepare demo for Harbor & Pine", "meeting", "progress", 3, 4, 6),
    ("Security questionnaire for Vela", "todo", "todo", 5, 3, 5),
    ("Quarterly review with Bluefin", "meeting", "done", -3, 0, 0),
    ("Follow up on API package", "call", "todo", 2, 5, 9),
]


def _member(company: models.Company, email: str, name: str, title: str, role: models.UserRole) -> models.User:
    user = models.User(
        username=email,
        email=email,
        full_name=name,
        job_title=title,
        role=role,
        # Демо-коллеги не входят в систему: случайный пароль, который никто не знает.
        hashed_password=hash_password(secrets.token_urlsafe(24)),
    )
    company.users.append(user)
    return user


def main() -> None:
    random.seed(7)
    with SessionLocal() as db:
        if db.query(models.User).filter(models.User.username == DEMO_EMAIL).first():
            print(f"Demo workspace already exists — sign in as {DEMO_EMAIL}")
            return

        result = register_studio(
            db, email=DEMO_EMAIL, password=DEMO_PASSWORD, company_name="Northwind Studio", timezone_name="Europe/Berlin"
        )
        company, owner = result.company, result.owner
        company.niche = models.Niche.OTHER
        owner.full_name, owner.job_title = "Alex Morgan", "Head of Sales"
        team = [
            owner,
            _member(company, "kate@lemko.dev", "Kate Novak", "Account Executive", models.UserRole.MANAGER),
            _member(company, "tomas@lemko.dev", "Tomas Berg", "Sales Lead", models.UserRole.MANAGER),
        ]
        db.commit()

        ctx = records.Ctx(db, company, owner, source="api")
        today = datetime.now(timezone.utc).date()
        member_ref = [f"u_{u.id}" for u in team]

        companies = []
        for name, domain, industry, size, arr, city, tier, health in COMPANIES:
            companies.append(
                records.create_record(
                    ctx,
                    "companies",
                    {
                        "name": name,
                        "domain": f"https://{domain}",
                        "industry": industry,
                        "size": size,
                        "arr": arr,
                        "city": city,
                        "tier": tier,
                        "health": health,
                        "owner": random.choice(member_ref),
                    },
                )["id"]
            )

        contacts = []
        for i, (name, title, company_idx, lifecycle, tags, email) in enumerate(CONTACTS):
            contacts.append(
                records.create_record(
                    ctx,
                    "contacts",
                    {
                        "name": name,
                        "email": email,
                        "phone": f"+48600100{i:03d}",
                        "title": title,
                        "company": companies[company_idx],
                        "lifecycle": lifecycle,
                        "tags": tags,
                        "owner": random.choice(member_ref),
                        "lastContacted": (today - timedelta(days=random.randint(1, 30))).isoformat(),
                    },
                )["id"]
            )

        deals = []
        for name, company_idx, contact_idx, amount, stage, chance, shift, source, priority, owner_idx in DEALS:
            close = today + timedelta(days=shift)
            record = records.create_record(
                ctx,
                "deals",
                {
                    "name": name,
                    "company": companies[company_idx],
                    "contact": contacts[contact_idx],
                    "amount": amount,
                    "stage": stage,
                    "probability": chance,
                    "closeDate": close.isoformat(),
                    "source": source,
                    "priority": priority,
                    "owner": member_ref[owner_idx],
                },
            )
            deals.append(record["id"])
            # Растягиваем историю на несколько месяцев, чтобы графикам было что показать.
            row = db.get(models.CrmRecord, records.ref(record["id"], "r"))
            row.created_at = datetime.combine(min(close, today) - timedelta(days=random.randint(20, 60)), time(10), timezone.utc)
            if stage in ("won", "lost"):
                row.closed_at = datetime.combine(close, time(16), timezone.utc)

        for title, kind, status, due_in, company_idx, deal_idx in TASKS:
            due = datetime.combine(today + timedelta(days=due_in), time(10, 30), timezone.utc)
            records.create_record(
                ctx,
                "tasks",
                {
                    "title": title,
                    "type": kind,
                    "status": status,
                    "due": due.isoformat(),
                    "assignee": random.choice(member_ref),
                    "related": companies[company_idx],
                    "deal": deals[deal_idx],
                    "done": status == "done",
                },
            )

        db.commit()
        print(
            f"Demo workspace ready: {len(companies)} companies, {len(contacts)} contacts, "
            f"{len(deals)} deals, {len(TASKS)} tasks.\nSign in as {DEMO_EMAIL} / {DEMO_PASSWORD}"
        )


if __name__ == "__main__":
    main()
