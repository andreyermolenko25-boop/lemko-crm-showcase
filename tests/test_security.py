"""Безопасность входа: сессии, 2FA, лимиты, step-up, сброс пароля, политика, SSRF, шифрование."""

from __future__ import annotations

import re
import uuid
from datetime import datetime, timedelta, timezone

import pytest
from httpx import AsyncClient
from sqlalchemy import select, update

import models
from core import crypto, netguard
from core.auth import mfa

PASSWORD = "correct-horse-42"


async def _register(client: AsyncClient) -> dict:
    email = f"sec-{uuid.uuid4().hex[:8]}@example.com"
    response = await client.post(
        "/auth/register", json={"email": email, "password": PASSWORD, "company_name": "Secure Studio"}
    )
    assert response.status_code == 201, response.text
    return {"email": email, "company_id": response.json()["company"]["id"]}


async def _login(client: AsyncClient, email: str, password: str = PASSWORD, ua: str = "pytest-a") -> dict:
    response = await client.post(
        "/auth/login", json={"username": email, "password": password}, headers={"User-Agent": ua}
    )
    assert response.status_code == 200, response.text
    return response.json()


def _auth(token: str, ua: str = "pytest-a") -> dict[str, str]:
    return {"Authorization": f"Bearer {token}", "User-Agent": ua}


def _last_outbox_text(db_session, to: str) -> str:
    db_session.expire_all()
    rows = db_session.scalars(
        select(models.NotificationOutbox).order_by(models.NotificationOutbox.id.desc())
    ).all()
    for row in rows:
        if (row.payload or {}).get("to") == to:
            return f"{row.payload.get('subject', '')}\n{row.payload.get('text', '')}"
    raise AssertionError(f"no outbox row for {to}")


@pytest.mark.asyncio
async def test_logout_revokes_server_session(async_client: AsyncClient) -> None:
    account = await _register(async_client)
    token = (await _login(async_client, account["email"]))["access_token"]
    assert (await async_client.get("/auth/me", headers=_auth(token))).status_code == 200
    assert (await async_client.post("/auth/logout", headers=_auth(token))).status_code == 204
    after = await async_client.get("/auth/me", headers=_auth(token))
    assert after.status_code == 401
    assert after.json()["detail"]["code"] == "session_revoked"


@pytest.mark.asyncio
async def test_password_hashed_with_argon2id(async_client: AsyncClient, db_session) -> None:
    account = await _register(async_client)
    user = db_session.scalar(select(models.User).where(models.User.username == account["email"]))
    assert user.hashed_password.startswith("$argon2id$")


@pytest.mark.asyncio
async def test_login_rate_limited_per_account(async_client: AsyncClient) -> None:
    account = await _register(async_client)
    for _ in range(10):
        wrong = await async_client.post("/auth/login", json={"username": account["email"], "password": "nope-nope-1"})
        assert wrong.status_code == 401
    blocked = await async_client.post("/auth/login", json={"username": account["email"], "password": PASSWORD})
    assert blocked.status_code == 429
    assert blocked.json()["detail"]["code"] == "too_many_attempts"
    assert blocked.json()["detail"]["retry_after"] > 0


@pytest.mark.asyncio
async def test_weak_password_rejected_on_register(async_client: AsyncClient) -> None:
    response = await async_client.post(
        "/auth/register", json={"email": "weak@example.com", "password": "password123", "company_name": "Weak Co"}
    )
    assert response.status_code == 422
    assert response.json()["detail"]["code"] == "password_too_common"
    short = await async_client.post(
        "/auth/register", json={"email": "short@example.com", "password": "Ab1!xyz9", "company_name": "Short Co"}
    )
    assert short.status_code == 422
    assert short.json()["detail"]["code"] == "password_too_short"
    assert short.json()["detail"]["min_length"] == 10


@pytest.mark.asyncio
async def test_totp_enrolment_and_two_step_login(async_client: AsyncClient, db_session) -> None:
    account = await _register(async_client)
    token = (await _login(async_client, account["email"]))["access_token"]
    setup = await async_client.post("/auth/security/totp/setup", headers=_auth(token))
    assert setup.status_code == 200, setup.text
    body = setup.json()
    assert body["qr"].startswith("data:image/svg+xml")
    secret = body["secret"].replace(" ", "")

    bad = await async_client.post("/auth/security/totp/enable", json={"code": "000000"}, headers=_auth(token))
    assert bad.status_code == 400
    enabled = await async_client.post(
        "/auth/security/totp/enable", json={"code": mfa.totp_code(secret)}, headers=_auth(token)
    )
    assert enabled.status_code == 200, enabled.text
    backup = enabled.json()["codes"]
    assert len(backup) == 10

    # Секрет в БД зашифрован.
    user = db_session.scalar(select(models.User).where(models.User.username == account["email"]))
    assert user.totp_secret.startswith("enc:v1:")
    used_step = user.totp_last_step

    step = await _login(async_client, account["email"], ua="pytest-b")
    assert step["mfa_required"] is True
    assert step["access_token"] is None
    assert "totp" in step["mfa_methods"]

    wrong = await async_client.post(
        "/auth/mfa/verify", json={"mfa_token": step["mfa_token"], "method": "totp", "code": "123456"}
    )
    assert wrong.status_code == 401
    # Уже использованный код (та же 30-секундная ступень) повторно не принимается.
    replay = await async_client.post(
        "/auth/mfa/verify",
        json={"mfa_token": step["mfa_token"], "method": "totp", "code": mfa.totp_code(secret, at=used_step * 30)},
    )
    assert replay.status_code == 401

    by_backup = await async_client.post(
        "/auth/mfa/verify", json={"mfa_token": step["mfa_token"], "method": "backup", "code": backup[0]},
        headers={"User-Agent": "pytest-b"},
    )
    assert by_backup.status_code == 200, by_backup.text
    assert by_backup.json()["access_token"]
    me = await async_client.get("/auth/me", headers=_auth(by_backup.json()["access_token"], "pytest-b"))
    assert me.json()["mfa_enabled"] is True

    # Резервный код одноразовый.
    again = await _login(async_client, account["email"], ua="pytest-c")
    reuse = await async_client.post(
        "/auth/mfa/verify", json={"mfa_token": again["mfa_token"], "method": "backup", "code": backup[0]}
    )
    assert reuse.status_code == 401


@pytest.mark.asyncio
async def test_sensitive_changes_need_recent_auth(async_client: AsyncClient, db_session) -> None:
    account = await _register(async_client)
    token = (await _login(async_client, account["email"]))["access_token"]
    old = datetime.now(timezone.utc) - timedelta(hours=1)
    db_session.execute(
        update(models.AuthSession).values(created_at=old, reauth_at=old, last_seen_at=datetime.now(timezone.utc))
    )
    db_session.commit()
    blocked = await async_client.post("/auth/security/totp/setup", headers=_auth(token))
    assert blocked.status_code == 403
    assert blocked.json()["detail"]["code"] == "reauth_required"
    wrong = await async_client.post("/auth/security/reauth", json={"password": "bad-password-1"}, headers=_auth(token))
    assert wrong.status_code == 401
    ok = await async_client.post("/auth/security/reauth", json={"password": PASSWORD}, headers=_auth(token))
    assert ok.status_code == 204
    assert (await async_client.post("/auth/security/totp/setup", headers=_auth(token))).status_code == 200


@pytest.mark.asyncio
async def test_password_change_signs_out_other_sessions(async_client: AsyncClient) -> None:
    account = await _register(async_client)
    first = (await _login(async_client, account["email"], ua="device-1"))["access_token"]
    second = (await _login(async_client, account["email"], ua="device-2"))["access_token"]
    sessions = await async_client.get("/auth/sessions", headers=_auth(first, "device-1"))
    assert len(sessions.json()) == 2
    assert sum(1 for s in sessions.json() if s["current"]) == 1

    changed = await async_client.post(
        "/auth/security/password",
        json={"current_password": PASSWORD, "new_password": "brand-new-pass-77", "sign_out_others": True},
        headers=_auth(first, "device-1"),
    )
    assert changed.status_code == 204, changed.text
    assert (await async_client.get("/auth/me", headers=_auth(second, "device-2"))).status_code == 401
    assert (await async_client.get("/auth/me", headers=_auth(first, "device-1"))).status_code == 200
    await _login(async_client, account["email"], "brand-new-pass-77")


@pytest.mark.asyncio
async def test_revoke_other_sessions(async_client: AsyncClient) -> None:
    account = await _register(async_client)
    first = (await _login(async_client, account["email"], ua="device-1"))["access_token"]
    second = (await _login(async_client, account["email"], ua="device-2"))["access_token"]
    revoked = await async_client.post("/auth/sessions/revoke-others", headers=_auth(first, "device-1"))
    assert revoked.json()["revoked"] == 1
    assert (await async_client.get("/auth/me", headers=_auth(second, "device-2"))).status_code == 401


@pytest.mark.asyncio
async def test_idle_session_expires(async_client: AsyncClient, db_session) -> None:
    account = await _register(async_client)
    token = (await _login(async_client, account["email"]))["access_token"]
    db_session.execute(
        update(models.AuthSession).values(last_seen_at=datetime.now(timezone.utc) - timedelta(hours=9))
    )
    db_session.commit()
    response = await async_client.get("/auth/me", headers=_auth(token))
    assert response.status_code == 401
    assert response.json()["detail"]["code"] == "session_idle"


@pytest.mark.asyncio
async def test_password_reset_by_email_link(async_client: AsyncClient, db_session) -> None:
    account = await _register(async_client)
    token = (await _login(async_client, account["email"]))["access_token"]
    unknown = await async_client.post("/auth/password/forgot", json={"email": "nobody@example.com"})
    assert unknown.status_code == 202
    sent = await async_client.post("/auth/password/forgot", json={"email": account["email"]})
    assert sent.status_code == 202
    link = re.search(r"reset-password\?token=([\w-]+)", _last_outbox_text(db_session, account["email"])).group(1)

    weak = await async_client.post("/auth/password/reset", json={"token": link, "new_password": "short"})
    assert weak.status_code == 422
    done = await async_client.post("/auth/password/reset", json={"token": link, "new_password": "reset-pass-2026"})
    assert done.status_code == 204
    # Ссылка одноразовая, старые сессии отозваны.
    again = await async_client.post("/auth/password/reset", json={"token": link, "new_password": "reset-pass-2027"})
    assert again.status_code == 400
    assert (await async_client.get("/auth/me", headers=_auth(token))).status_code == 401
    await _login(async_client, account["email"], "reset-pass-2026")


@pytest.mark.asyncio
async def test_email_change_with_code(async_client: AsyncClient, db_session) -> None:
    account = await _register(async_client)
    token = (await _login(async_client, account["email"]))["access_token"]
    new_email = f"new-{uuid.uuid4().hex[:6]}@example.com"
    started = await async_client.post("/auth/security/email/start", json={"email": new_email}, headers=_auth(token))
    assert started.status_code == 202, started.text
    code = re.search(r"code: (\d{6})", _last_outbox_text(db_session, new_email)).group(1)
    wrong = await async_client.post("/auth/security/email/confirm", json={"code": "000000"}, headers=_auth(token))
    assert wrong.status_code == 400
    confirmed = await async_client.post("/auth/security/email/confirm", json={"code": code}, headers=_auth(token))
    assert confirmed.status_code == 200, confirmed.text
    assert confirmed.json()["email"] == new_email
    assert confirmed.json()["email_verified"] is True
    await _login(async_client, new_email)


@pytest.mark.asyncio
async def test_policy_ip_allowlist_and_2fa_guard(async_client: AsyncClient) -> None:
    account = await _register(async_client)
    token = (await _login(async_client, account["email"]))["access_token"]
    url = f"/companies/{account['company_id']}/security-policy"
    policy = await async_client.get(url, headers=_auth(token))
    assert policy.status_code == 200
    assert policy.json()["can_edit"] is True

    lockout = await async_client.patch(url, json={"ipAllowlist": "203.0.113.0/24"}, headers=_auth(token))
    assert lockout.status_code == 422
    assert lockout.json()["detail"]["code"] == "ip_lockout"

    need_own = await async_client.patch(url, json={"require2fa": True}, headers=_auth(token))
    assert need_own.json()["detail"]["code"] == "enable_2fa_first"

    saved = await async_client.patch(url, json={"timeout": "1h", "minLength": "12"}, headers=_auth(token))
    assert saved.status_code == 200, saved.text
    assert saved.json()["timeout"] == "1h"
    assert saved.json()["minLength"] == "12"


@pytest.mark.asyncio
async def test_webhook_ssrf_blocked_and_secret_encrypted(
    async_client: AsyncClient, auth_headers: dict, db_session
) -> None:
    for url in (
        "http://169.254.169.254/latest/meta-data",
        "http://localhost:5432/",
        "http://10.0.0.5/hook",
        "http://user:pw@example.com/",
    ):
        blocked = await async_client.post(
            "/integrations/webhooks", json={"url": url, "events": ["client.created"]}, headers=auth_headers
        )
        assert blocked.status_code == 422, url
    created = await async_client.post(
        "/integrations/webhooks",
        json={"url": "https://example.com/hook", "events": ["client.created"]},
        headers=auth_headers,
    )
    assert created.status_code == 201, created.text
    plain = created.json()["secret"]
    stored = db_session.scalar(select(models.Webhook.secret))
    assert stored.startswith("enc:v1:")
    assert crypto.decrypt_str(stored) == plain


@pytest.mark.asyncio
async def test_api_key_opens_external_api_until_revoked(
    async_client: AsyncClient, auth_headers: dict, db_session
) -> None:
    created = await async_client.post("/integrations/api-keys", json={"name": "Zapier"}, headers=auth_headers)
    assert created.status_code == 201, created.text
    key = created.json()
    stored = db_session.scalar(select(models.ApiKey.key_hash).where(models.ApiKey.id == key["id"]))
    assert stored.startswith("$argon2id$") and key["token"] not in stored

    headers = {"X-API-Key": key["token"]}
    ok = await async_client.get("/api/v1/external/clients", headers=headers)
    assert ok.status_code == 200, ok.text
    assert (await async_client.get("/api/v1/external/clients", headers={"X-API-Key": key["token"] + "x"})).status_code == 401

    revoked = await async_client.delete(f"/integrations/api-keys/{key['id']}", headers=auth_headers)
    assert revoked.status_code == 200, revoked.text
    assert (await async_client.get("/api/v1/external/clients", headers=headers)).status_code == 401


def test_netguard_blocks_private_resolution() -> None:
    with pytest.raises(netguard.UnsafeUrl):
        netguard.safe_post("http://127.0.0.1:9/", b"{}", {}, timeout=1)
    with pytest.raises(netguard.UnsafeUrl):
        netguard.validate_url("http://[::ffff:169.254.169.254]/")
    assert netguard.validate_url("https://hooks.example.com/x") == "https://hooks.example.com/x"


def test_field_encryption_roundtrip() -> None:
    sealed = crypto.encrypt_str("JBSWY3DPEHPK3PXP")
    assert sealed.startswith("enc:v1:") and "JBSW" not in sealed
    assert crypto.decrypt_str(sealed) == "JBSWY3DPEHPK3PXP"
    assert crypto.decrypt_str("legacy-plain") == "legacy-plain"
    assert crypto.encrypt_str("x") != crypto.encrypt_str("x")  # случайный nonce
