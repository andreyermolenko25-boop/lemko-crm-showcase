"""Сквозной сценарий ядра: запись к мастеру и защита от пересечений."""

from __future__ import annotations

import asyncio
from datetime import datetime, timedelta, timezone

import pytest
from httpx import AsyncClient
from sqlalchemy import func, select
from sqlalchemy.orm import Session

import models


@pytest.mark.asyncio
async def test_appointment_booking_and_conflict(
    async_client: AsyncClient,
    test_company: dict,
    auth_headers: dict[str, str],
) -> None:
    """
    Мастер + смена + визит 10:00–11:00 → OK;
    второй визит 10:30–11:30 к тому же мастеру → 409.
    """
    company_id = test_company["company"]["id"]

    master_resp = await async_client.post(
        f"/companies/{company_id}/users",
        headers=auth_headers,
        json={
            "username": "master_anna",
            "password": "master-pass-1",
            "role": "staff",
        },
    )
    assert master_resp.status_code == 201, master_resp.text
    master_id = master_resp.json()["id"]

    client_a = await async_client.post(
        f"/companies/{company_id}/clients",
        headers=auth_headers,
        json={"name": "Клиент А", "phone": "+49111111111"},
    )
    assert client_a.status_code == 201, client_a.text
    client_a_id = client_a.json()["id"]

    client_b = await async_client.post(
        f"/companies/{company_id}/clients",
        headers=auth_headers,
        json={"name": "Клиент Б", "phone": "+49222222222"},
    )
    assert client_b.status_code == 201, client_b.text
    client_b_id = client_b.json()["id"]

    day = datetime.now(timezone.utc).replace(
        hour=0, minute=0, second=0, microsecond=0
    )
    shift_resp = await async_client.post(
        f"/companies/{company_id}/work-shifts",
        headers=auth_headers,
        json={
            "user_id": master_id,
            "starts_at": (day + timedelta(hours=8)).isoformat(),
            "ends_at": (day + timedelta(hours=20)).isoformat(),
            "title": "Дневная смена",
        },
    )
    assert shift_resp.status_code == 201, shift_resp.text

    first = await async_client.post(
        f"/companies/{company_id}/appointments",
        headers=auth_headers,
        json={
            "client_id": client_a_id,
            "user_id": master_id,
            "starts_at": (day + timedelta(hours=10)).isoformat(),
            "ends_at": (day + timedelta(hours=11)).isoformat(),
            "title": "Первый визит",
        },
    )
    assert first.status_code == 201, first.text

    conflict = await async_client.post(
        f"/companies/{company_id}/appointments",
        headers=auth_headers,
        json={
            "client_id": client_b_id,
            "user_id": master_id,
            "starts_at": (day + timedelta(hours=10, minutes=30)).isoformat(),
            "ends_at": (day + timedelta(hours=11, minutes=30)).isoformat(),
            "title": "Пересечение",
        },
    )
    assert conflict.status_code == 409, conflict.text
    detail = conflict.json()["detail"]
    assert "conflicts" in detail
    assert len(detail["conflicts"]) >= 1


@pytest.mark.asyncio
async def test_appointment_race_condition_stress(
    async_client: AsyncClient,
    test_company: dict,
    auth_headers: dict[str, str],
    db_session: Session,
) -> None:
    """
    50 параллельных POST на один слот: ExcludeConstraint / app-check
    должны оставить ровно одну запись, остальные — 409.
    """
    company_id = test_company["company"]["id"]
    parallel = 50

    master_resp = await async_client.post(
        f"/companies/{company_id}/users",
        headers=auth_headers,
        json={
            "username": "master_race",
            "password": "master-pass-1",
            "role": "staff",
        },
    )
    assert master_resp.status_code == 201, master_resp.text
    master_id = master_resp.json()["id"]

    client_ids: list[int] = []
    for i in range(parallel):
        client_resp = await async_client.post(
            f"/companies/{company_id}/clients",
            headers=auth_headers,
            json={
                "name": f"Race Client {i}",
                "phone": f"+4900000{i:04d}",
            },
        )
        assert client_resp.status_code == 201, client_resp.text
        client_ids.append(client_resp.json()["id"])

    day = datetime.now(timezone.utc).replace(
        hour=0, minute=0, second=0, microsecond=0
    )
    starts_at = day + timedelta(hours=14)
    ends_at = day + timedelta(hours=15)

    shift_resp = await async_client.post(
        f"/companies/{company_id}/work-shifts",
        headers=auth_headers,
        json={
            "user_id": master_id,
            "starts_at": (day + timedelta(hours=8)).isoformat(),
            "ends_at": (day + timedelta(hours=20)).isoformat(),
            "title": "Смена для race",
        },
    )
    assert shift_resp.status_code == 201, shift_resp.text

    async def _book(client_id: int):
        return await async_client.post(
            f"/companies/{company_id}/appointments",
            headers=auth_headers,
            json={
                "client_id": client_id,
                "user_id": master_id,
                "starts_at": starts_at.isoformat(),
                "ends_at": ends_at.isoformat(),
                "title": "Race slot",
            },
        )

    responses = await asyncio.gather(
        *[_book(client_id) for client_id in client_ids]
    )
    statuses = [response.status_code for response in responses]

    successes = [code for code in statuses if code in (200, 201)]
    conflicts = [code for code in statuses if code == 409]
    other = [
        (response.status_code, response.text)
        for response in responses
        if response.status_code not in (200, 201, 409)
    ]

    assert not other, f"Неожиданные ответы: {other[:5]}"
    assert len(successes) == 1, (
        f"Ожидали ровно 1 успех, получили {len(successes)}: {statuses}"
    )
    assert len(conflicts) == parallel - 1, (
        f"Ожидали {parallel - 1} конфликтов 409, получили {len(conflicts)}"
    )

    row_count = db_session.scalar(
        select(func.count())
        .select_from(models.Appointment)
        .where(
            models.Appointment.company_id == company_id,
            models.Appointment.user_id == master_id,
            models.Appointment.starts_at == starts_at,
            models.Appointment.ends_at == ends_at,
            models.Appointment.status != models.AppointmentStatus.CANCELLED,
        )
    )
    assert int(row_count or 0) == 1
