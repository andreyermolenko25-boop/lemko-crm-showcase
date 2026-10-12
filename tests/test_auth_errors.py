"""Ошибки авторизации отдают машинный code — по нему фронтенд показывает текст на языке интерфейса."""

from __future__ import annotations

import pytest
from httpx import AsyncClient


@pytest.mark.asyncio
async def test_wrong_password_has_code(async_client: AsyncClient, test_company: dict) -> None:
    response = await async_client.post(
        "/auth/login",
        json={"username": test_company["owner_username"], "password": "wrong-pass-1"},
    )
    assert response.status_code == 401, response.text
    detail = response.json()["detail"]
    assert detail["code"] == "invalid_credentials"
    assert detail["message"]


@pytest.mark.asyncio
async def test_email_taken_has_code(async_client: AsyncClient) -> None:
    payload = {"email": "owner-codes@example.com", "password": "test-pass-123", "company_name": "Codes Studio"}
    first = await async_client.post("/auth/register", json=payload)
    assert first.status_code == 201, first.text
    second = await async_client.post("/auth/register", json=payload)
    assert second.status_code == 400, second.text
    assert second.json()["detail"]["code"] == "email_taken"


@pytest.mark.asyncio
async def test_missing_token_has_code(async_client: AsyncClient) -> None:
    response = await async_client.get("/auth/me")
    assert response.status_code == 401, response.text
    assert response.json()["detail"]["code"] == "not_authenticated"
