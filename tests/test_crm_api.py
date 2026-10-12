"""Бэкенд схема-ориентированного UI: записи, воркспейс, лента, виджеты, автоматизации."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest
from httpx import AsyncClient

DEAL_STAGES = [
    {"value": "new", "label": "New"},
    {"value": "proposal", "label": "Proposal"},
    {"value": "won", "label": "Won"},
    {"value": "lost", "label": "Lost"},
]

SCHEMA = [
    {
        "key": "deals",
        "label": "Deals",
        "labelSingular": "Deal",
        "primaryField": "name",
        "stageField": "stage",
        "dateField": "closeDate",
        "amountField": "amount",
        "ownerField": "owner",
        "fields": [
            {"key": "name", "label": "Deal", "type": "text"},
            {"key": "amount", "label": "Amount", "type": "currency"},
            {"key": "stage", "label": "Stage", "type": "status", "options": DEAL_STAGES},
            {"key": "closeDate", "label": "Close date", "type": "date"},
            {"key": "owner", "label": "Owner", "type": "user"},
            {"key": "source", "label": "Source", "type": "select", "options": [
                {"value": "inbound", "label": "Inbound"}, {"value": "referral", "label": "Referral"},
            ]},
            {"key": "contact", "label": "Contact", "type": "relation", "relation": "contacts"},
        ],
    },
    {
        "key": "tasks",
        "label": "Tasks",
        "labelSingular": "Task",
        "primaryField": "title",
        "stageField": "status",
        "dateField": "due",
        "ownerField": "assignee",
        "fields": [
            {"key": "title", "label": "Title", "type": "text"},
            {"key": "status", "label": "Status", "type": "status", "options": [
                {"value": "todo", "label": "To do"}, {"value": "done", "label": "Done"},
            ]},
            {"key": "due", "label": "Due", "type": "datetime"},
            {"key": "assignee", "label": "Assignee", "type": "user"},
            {"key": "deal", "label": "Deal", "type": "relation", "relation": "deals"},
        ],
    },
    {
        "key": "contacts",
        "label": "Contacts",
        "labelSingular": "Contact",
        "primaryField": "name",
        "ownerField": "owner",
        "fields": [
            {"key": "name", "label": "Name", "type": "text"},
            {"key": "phone", "label": "Phone", "type": "phone"},
            {"key": "email", "label": "Email", "type": "email"},
            {"key": "tags", "label": "Tags", "type": "multiselect"},
            {"key": "owner", "label": "Owner", "type": "user"},
        ],
    },
]


@pytest.fixture
def base(test_company: dict) -> str:
    return f"/companies/{test_company['company']['id']}"


@pytest.fixture
def owner_id(test_company: dict) -> str:
    return f"u_{test_company['owner']['id']}"


async def _bootstrap(client: AsyncClient, base: str, headers: dict) -> None:
    response = await client.post(
        f"{base}/workspace/bootstrap",
        headers=headers,
        json={
            "config": {"enabledModules": ["core"]},
            "views": [{"entity": "deals", "name": "Pipeline", "type": "board", "columns": ["amount"]}],
            "dashboards": [{"name": "Overview", "icon": "dashboard", "widgets": [{"id": "w1", "type": "kpi"}]}],
            "reports": [{"name": "By stage", "entity": "deals", "groupBy": "stage", "metric": "sum", "metricField": "amount"}],
        },
    )
    assert response.status_code == 200, response.text
    response = await client.put(f"{base}/workspace/schema", headers=headers, json=SCHEMA)
    assert response.status_code == 204, response.text


@pytest.mark.asyncio
async def test_workspace_bootstrap_is_applied_once(async_client: AsyncClient, base: str, auth_headers: dict) -> None:
    first = await async_client.get(f"{base}/workspace", headers=auth_headers)
    assert first.json()["initialized"] is False
    await _bootstrap(async_client, base, auth_headers)
    again = await async_client.post(
        f"{base}/workspace/bootstrap",
        headers=auth_headers,
        json={"dashboards": [{"name": "Duplicate", "widgets": []}]},
    )
    body = again.json()
    assert body["initialized"] is True
    assert [d["name"] for d in body["dashboards"]] == ["Overview"]
    assert body["views"][0]["type"] == "board" and body["views"][0]["shared"] is True
    assert body["reports"][0]["metricField"] == "amount"

    patched = await async_client.patch(
        f"{base}/workspace/config",
        headers=auth_headers,
        json={"config": {"nav": {"order": ["page:home"], "hidden": []}, "junk": 1}},
    )
    assert patched.json() == {"enabledModules": ["core"], "nav": {"order": ["page:home"], "hidden": []}}


@pytest.mark.asyncio
async def test_generic_records_and_activity_feed(
    async_client: AsyncClient, base: str, auth_headers: dict, owner_id: str
) -> None:
    await _bootstrap(async_client, base, auth_headers)
    created = await async_client.post(
        f"{base}/records/deals",
        headers=auth_headers,
        json={"values": {"name": "Astra — Pilot", "amount": "1200.50", "stage": "new", "owner": owner_id}},
    )
    assert created.status_code == 201, created.text
    deal = created.json()
    assert deal["id"].startswith("r_") and deal["amount"] == 1200.5

    moved = await async_client.patch(
        f"{base}/records/deals/{deal['id']}", headers=auth_headers, json={"values": {"stage": "won"}}
    )
    assert moved.json()["stage"] == "won" and moved.json()["closedAt"]

    renamed = await async_client.patch(
        f"{base}/records/deals/{deal['id']}", headers=auth_headers, json={"values": {"amount": "1500", "source": "referral"}}
    )
    assert renamed.status_code == 200, renamed.text

    feed = (await async_client.get(f"{base}/activities", headers=auth_headers)).json()
    titles = [item["title"] for item in feed["items"]]
    assert "Stage → Won · Astra — Pilot" in titles
    assert "Deal created · Astra — Pilot" in titles
    # Свои действия сотрудник видит прочитанными.
    assert feed["unread"] == 0

    # Рядом с английским заголовком — из чего интерфейс соберёт фразу на своём языке.
    events = {item["event"]: item["params"] for item in feed["items"]}
    assert events["record.created"] == {"title": "Astra — Pilot", "noun": "Deal"}
    assert events["record.stage"] == {
        "title": "Astra — Pilot", "noun": "Deal", "field": "stage", "fieldLabel": "Stage", "to": "won", "toLabel": "Won",
    }
    updated = events["record.updated"]
    assert sorted(updated["fields"]) == ["amount", "source"]
    assert sorted(updated["fieldLabels"]) == ["Amount", "Source"]

    deleted = await async_client.delete(f"{base}/records/deals/{deal['id']}", headers=auth_headers)
    assert deleted.json() == {"record": None}
    listing = await async_client.get(f"{base}/records/deals", headers=auth_headers)
    assert listing.json()["total"] == 0


@pytest.mark.asyncio
async def test_native_records_contacts_services_products(
    async_client: AsyncClient, base: str, auth_headers: dict, owner_id: str
) -> None:
    await _bootstrap(async_client, base, auth_headers)
    contact = await async_client.post(
        f"{base}/records/contacts",
        headers=auth_headers,
        json={"values": {"name": "Elena Novak", "phone": "+48 600 100 200", "tags": ["vip"], "owner": owner_id}},
    )
    assert contact.status_code == 201, contact.text
    body = contact.json()
    assert body["id"].startswith("cl_") and body["phone"] == "+48600100200"
    assert body["tags"] == ["vip"] and body["owner"] == owner_id and body["ltv"] == 0

    dup = await async_client.post(
        f"{base}/records/contacts", headers=auth_headers, json={"values": {"name": "Copy", "phone": "+48600100200"}}
    )
    assert dup.status_code == 409 and dup.json()["detail"]["code"] == "duplicate_phone"

    service = await async_client.post(
        f"{base}/records/services", headers=auth_headers, json={"values": {"name": "Polishing", "price": 90, "duration": 45, "category": "premium"}}
    )
    assert service.json()["duration"] == 45 and service.json()["category"] == "premium"

    product = await async_client.post(
        f"{base}/records/products", headers=auth_headers, json={"values": {"name": "Wax", "stock": 10, "minStock": 3}}
    )
    product_id = product.json()["id"]
    restocked = await async_client.patch(
        f"{base}/records/products/{product_id}", headers=auth_headers, json={"values": {"stock": 2}}
    )
    assert restocked.json()["stock"] == 2 and restocked.json()["stockStatus"] == "low"
    negative = await async_client.patch(
        f"{base}/records/products/{product_id}", headers=auth_headers, json={"values": {"stock": -1}}
    )
    assert negative.status_code == 409

    removed = await async_client.delete(f"{base}/records/services/{service.json()['id']}", headers=auth_headers)
    assert removed.json() == {"record": None}
    assert (await async_client.get(f"{base}/records/services", headers=auth_headers)).json()["total"] == 0


@pytest.mark.asyncio
async def test_shifts_and_appointments_through_records(
    async_client: AsyncClient, base: str, auth_headers: dict, owner_id: str
) -> None:
    await _bootstrap(async_client, base, auth_headers)
    client = (
        await async_client.post(
            f"{base}/records/contacts", headers=auth_headers, json={"values": {"name": "Ivan", "phone": "+491234567"}}
        )
    ).json()
    day = (datetime.now(timezone.utc) + timedelta(days=1)).replace(hour=0, minute=0, second=0, microsecond=0)
    outside = await async_client.post(
        f"{base}/records/appointments",
        headers=auth_headers,
        json={"values": {"title": "Wash", "client": client["id"], "staff": owner_id, "startsAt": (day + timedelta(hours=10)).isoformat()}},
    )
    assert outside.status_code == 409 and outside.json()["detail"]["code"] == "outside_shift"

    shift = await async_client.post(
        f"{base}/records/shifts",
        headers=auth_headers,
        json={"values": {"staff": owner_id, "startsAt": (day + timedelta(hours=8)).isoformat(), "endsAt": (day + timedelta(hours=18)).isoformat()}},
    )
    assert shift.status_code == 201, shift.text

    booked = await async_client.post(
        f"{base}/records/appointments",
        headers=auth_headers,
        json={"values": {"title": "Wash", "client": client["id"], "staff": owner_id, "startsAt": (day + timedelta(hours=10)).isoformat(), "price": 50}},
    )
    assert booked.status_code == 201, booked.text
    appointment = booked.json()
    assert appointment["endsAt"].startswith((day + timedelta(hours=11)).strftime("%Y-%m-%dT%H"))

    moved = await async_client.patch(
        f"{base}/records/appointments/{appointment['id']}",
        headers=auth_headers,
        json={"values": {"startsAt": (day + timedelta(hours=12)).isoformat()}},
    )
    assert moved.json()["endsAt"].startswith((day + timedelta(hours=13)).strftime("%Y-%m-%dT%H"))

    cancelled = await async_client.delete(f"{base}/records/appointments/{appointment['id']}", headers=auth_headers)
    assert cancelled.json()["record"]["status"] == "cancelled"


@pytest.mark.asyncio
async def test_widget_formulas_and_report(
    async_client: AsyncClient, base: str, auth_headers: dict, owner_id: str
) -> None:
    await _bootstrap(async_client, base, auth_headers)
    now = datetime.now(timezone.utc)
    this_month = now.strftime("%Y-%m-15")
    last_month = (now.replace(day=1) - timedelta(days=1)).strftime("%Y-%m-15")
    for values in (
        {"name": "A", "amount": 100, "stage": "won", "closeDate": this_month, "source": "inbound", "owner": owner_id},
        {"name": "B", "amount": 300, "stage": "won", "closeDate": this_month, "source": "referral", "owner": owner_id},
        {"name": "C", "amount": 200, "stage": "won", "closeDate": last_month, "source": "inbound", "owner": owner_id},
        {"name": "D", "amount": 50, "stage": "lost", "closeDate": this_month, "source": "inbound"},
        {"name": "E", "amount": 500, "stage": "proposal", "closeDate": this_month, "source": "inbound"},
    ):
        response = await async_client.post(f"{base}/records/deals", headers=auth_headers, json={"values": values})
        assert response.status_code == 201, response.text
    for values in (
        {"title": "Call back", "status": "todo", "due": now.isoformat(), "assignee": owner_id},
        {"title": "Send quote", "status": "todo", "due": (now + timedelta(days=3)).isoformat(), "assignee": owner_id},
        {"title": "Done already", "status": "done", "due": now.isoformat(), "assignee": owner_id},
        {"title": "Someone else", "status": "todo", "due": now.isoformat()},
    ):
        response = await async_client.post(f"{base}/records/tasks", headers=auth_headers, json={"values": values})
        assert response.status_code == 201, response.text

    period = {"year": now.year, "month": now.month}
    response = await async_client.post(
        f"{base}/analytics/widgets",
        headers=auth_headers,
        json={
            "period": period,
            "widgets": [
                {"id": "revenue", "type": "kpi", "config": {"entity": "deals", "metric": "sum", "filterStage": "won"}},
                {"id": "conversion", "type": "kpi", "config": {"entity": "deals", "metric": "conversion"}},
                {"id": "open", "type": "kpi", "config": {"entity": "deals", "metric": "count", "excludeClosed": True}},
                {"id": "funnel", "type": "funnel", "config": {"entity": "deals"}},
                {"id": "board", "type": "leaderboard", "config": {"entity": "deals"}},
                {"id": "goal", "type": "goal", "config": {"entity": "deals", "target": 1000, "range": "all"}},
                {"id": "split", "type": "breakdown", "config": {"entity": "deals", "field": "source"}},
                {"id": "trend", "type": "trend", "config": {"entity": "deals", "months": 6}},
                {"id": "code", "type": "code", "config": {}},
                {"id": "day", "type": "my_day", "config": {}},
            ],
        },
    )
    assert response.status_code == 200, response.text
    results = response.json()["results"]

    revenue = results["revenue"]["data"]
    assert revenue["value"] == 600
    assert revenue["series"][-1] == 400 and revenue["series"][-2] == 200
    assert revenue["delta"] == pytest.approx(100.0)

    conversion = results["conversion"]["data"]
    assert conversion["value"] == pytest.approx(75.0)  # 3 won / (3 won + 1 lost)
    assert conversion["caption"] == {"records": 5, "won": 3, "closed": 4}

    assert results["open"]["data"]["value"] == 1 and results["open"]["data"]["caption"]["worth"] == 500

    funnel = results["funnel"]["data"]
    assert [s["count"] for s in funnel["stages"]] == [4, 4, 3]  # lost не входит
    assert funnel["conversion"] == pytest.approx(75.0)

    board = results["board"]["data"]["rows"][0]
    assert board == {"owner": owner_id, "count": 3, "won": 3, "value": 600.0}
    assert results["goal"]["data"]["pct"] == pytest.approx(60.0)
    assert {s["value"]: s["count"] for s in results["split"]["data"]["slices"]} == {"inbound": 4, "referral": 1}
    trend = results["trend"]["data"]
    assert trend["compareKind"] == "previous" and trend["points"][-1]["actual"] == 1100  # всё, кроме lost
    assert results["code"]["error"]["code"] == "unknown_widget"
    # Открытые записи на мне по всем объектам (закрытые сделки и выполненные задачи — нет).
    assert results["day"]["data"] == {"openAssigned": 2, "dueToday": 1}

    report = await async_client.post(
        f"{base}/analytics/report",
        headers=auth_headers,
        json={"entity": "deals", "groupBy": "stage", "metric": "sum", "metricField": "amount"},
    )
    assert report.json()["rows"] == [
        {"key": "proposal", "value": 500.0},
        {"key": "won", "value": 600.0},
        {"key": "lost", "value": 50.0},
    ]


@pytest.mark.asyncio
async def test_members_invite_profile_and_mentions(
    async_client: AsyncClient, base: str, auth_headers: dict, test_company: dict
) -> None:
    await _bootstrap(async_client, base, auth_headers)
    invited = await async_client.post(
        f"{base}/members/invite", headers=auth_headers, json={"email": "Kate@Example.com", "name": "Kate Smirnova", "role": "Viewer"}
    )
    assert invited.status_code == 201, invited.text
    body = invited.json()
    assert body["member"]["status"] == "invited" and body["member"]["role"] == "Viewer"
    password = body["temporaryPassword"]

    login = await async_client.post("/auth/login", json={"username": "kate@example.com", "password": password})
    assert login.status_code == 200, login.text
    kate = {"Authorization": f"Bearer {login.json()['access_token']}"}
    forbidden = await async_client.post(f"{base}/records/deals", headers=kate, json={"values": {"name": "x"}})
    assert forbidden.status_code == 403

    profile = await async_client.patch(
        f"{base}/me", headers=kate, json={"title": "Finance", "preferences": {"prefs": {"accent": "blue"}, "inboxReadAt": "x"}}
    )
    assert profile.json()["member"]["title"] == "Finance"
    assert profile.json()["preferences"] == {"prefs": {"accent": "blue"}}

    deal = (
        await async_client.post(f"{base}/records/deals", headers=auth_headers, json={"values": {"name": "Shared"}})
    ).json()
    note = await async_client.post(
        f"{base}/activities",
        headers=auth_headers,
        json={"entity": "deals", "recordId": deal["id"], "kind": "note", "body": "@Kate please check the invoice"},
    )
    assert note.status_code == 201, note.text
    feed = (await async_client.get(f"{base}/activities", headers=kate)).json()
    mention = next(item for item in feed["items"] if item["kind"] == "mention")
    assert mention["personal"] and not mention["read"]
    assert mention["event"] == "record.mention"
    assert mention["params"]["title"] == "Shared" and mention["params"]["actor"]
    logged = next(item for item in feed["items"] if item["kind"] == "note")
    assert logged["event"] == "record.logged" and logged["params"] == {"title": "Shared", "noun": "Deal"}
    assert feed["unread"] >= 1
    await async_client.post(f"{base}/activities/read-all", headers=kate)
    assert (await async_client.get(f"{base}/activities", headers=kate)).json()["unread"] == 0

    members = (await async_client.get(f"{base}/members", headers=auth_headers)).json()
    assert {m["status"] for m in members} == {"active"}


@pytest.mark.asyncio
async def test_common_errors_carry_codes(
    async_client: AsyncClient, base: str, auth_headers: dict
) -> None:
    """Ошибки, на которые натыкаются в интерфейсе, приходят с кодом — по нему интерфейс берёт текст на своём языке."""
    await _bootstrap(async_client, base, auth_headers)

    async def code_of(response) -> str:
        detail = response.json()["detail"]
        assert isinstance(detail, dict) and detail["message"], response.text
        return detail["code"]

    missing = [
        (await async_client.get(f"{base}/records/deals/r_999999", headers=auth_headers), 404, "record_not_found"),
        (await async_client.delete(f"{base}/members/u_999999", headers=auth_headers), 404, "member_not_found"),
        (await async_client.delete(f"{base}/views/999999", headers=auth_headers), 404, "not_found"),
        (await async_client.post(f"{base}/integrations/slack/sync", headers=auth_headers), 404, "integration_not_connected"),
        (await async_client.delete("/integrations/webhooks/999999", headers=auth_headers), 404, "webhook_not_found"),
    ]
    for response, status_code, code in missing:
        assert response.status_code == status_code, response.text
        assert await code_of(response) == code

    user = {"username": "twin@example.com", "password": "Sup3r-secret-pass", "role": "staff"}
    first = await async_client.post(f"{base}/users", headers=auth_headers, json=user)
    assert first.status_code == 201, first.text
    twin = await async_client.post(f"{base}/users", headers=auth_headers, json=user)
    assert twin.status_code == 409
    assert await code_of(twin) == "username_taken"
