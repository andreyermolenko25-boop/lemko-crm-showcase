"""
Фоновый воркер: доставка outbox и задачи по расписанию.

Запуск:  python -m worker           # бесконечный цикл
         python -m worker --once    # один проход (cron / отладка)

Каждый проход:
  1. outbox — забрать пачку pending (FOR UPDATE SKIP LOCKED: несколько воркеров
     не возьмут одну строку) и доставить:
       webhook — POST с HMAC-подписью X-Lemko-Signature на URL подписки;
       http    — POST на произвольный URL из payload;
       email   — письмо на адрес из payload;
       user    — письмо сотруднику (уведомления, приглашение, его визиты);
       client  — письмо клиенту о его визите;
       sms     — SMS (коды подтверждения).
     Успех → sent; постоянная ошибка (нет адреса, вебхук удалён) → failed;
     временная → снова pending через 30 с · 2^(попытка−1) (не больше часа),
     после WORKER_MAX_ATTEMPTS → failed;
  2. раз в 5 минут — напоминания о сроках (личное уведомление ответственному
     за сутки до даты записи), раз в час — недельный дайджест по понедельникам
     и очистка истёкших сессий, одноразовых кодов и окон rate limit.
"""

from __future__ import annotations

import argparse
import base64
import http.client
import logging
import signal
import smtplib
import socket
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone
from email.message import EmailMessage
from typing import Any
from zoneinfo import ZoneInfo

from sqlalchemy import delete, or_, select, update
from sqlalchemy.orm import Session

import activities
import integrations
import models
import notifications
import records
import stats
import workspace
from core import netguard, ratelimit
from core.config import settings
from core.database import SessionLocal

logger = logging.getLogger("lemko.worker")

STALE_PROCESSING = timedelta(minutes=5)
MAX_BACKOFF_SECONDS = 3600
REMINDER_EVERY = timedelta(minutes=5)
DIGEST_EVERY = timedelta(hours=1)
REMINDER_WINDOW = timedelta(hours=24)


class PermanentDeliveryError(Exception):
    """Повтор не поможет: нет адреса, канал не подключён, вебхук удалён."""


class TransientDeliveryError(Exception):
    """Сеть, таймаут, 5xx — имеет смысл повторить позже."""


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


def backoff_seconds(attempts: int) -> int:
    return min(MAX_BACKOFF_SECONDS, 30 * 2 ** max(0, attempts - 1))


# --------------------------------------------------------------------------- #
#  Каналы доставки
# --------------------------------------------------------------------------- #

def post_json(url: str, body: bytes, headers: dict[str, str]) -> None:
    """POST через core.netguard: без редиректов и без доступа во внутреннюю сеть (SSRF)."""
    try:
        code = netguard.safe_post(
            url,
            body,
            {"Content-Type": "application/json", "User-Agent": "Lemko-Webhooks/1.0", **headers},
            timeout=settings.WEBHOOK_TIMEOUT_SECONDS,
        )
    except netguard.UnsafeUrl as exc:
        raise PermanentDeliveryError(f"URL запрещён: {exc}") from exc
    except (OSError, socket.timeout, TimeoutError, ConnectionError, http.client.HTTPException) as exc:
        raise TransientDeliveryError(f"Сеть: {exc}") from exc
    if 400 <= code < 500 and code not in (408, 429):
        raise PermanentDeliveryError(f"Endpoint ответил {code}")
    if not 200 <= code < 300:
        raise TransientDeliveryError(f"Endpoint ответил {code}")


def send_sms(*, to: str, text: str) -> None:
    backend = settings.SMS_BACKEND
    if backend == "none":
        raise PermanentDeliveryError("SMS не настроены (SMS_BACKEND)")
    if backend == "log":
        logger.info("SMS to=%s\n%s", to, text)
        return
    if backend == "sns":
        import boto3
        from botocore.exceptions import BotoCoreError, ClientError

        attributes = {"AWS.SNS.SMS.SMSType": {"DataType": "String", "StringValue": "Transactional"}}
        if settings.SMS_SENDER_ID:
            attributes["AWS.SNS.SMS.SenderID"] = {"DataType": "String", "StringValue": settings.SMS_SENDER_ID}
        try:
            boto3.client("sns", region_name=settings.AWS_REGION).publish(
                PhoneNumber=to, Message=text, MessageAttributes=attributes
            )
        except ClientError as exc:
            raise PermanentDeliveryError(f"SNS: {exc}") from exc
        except BotoCoreError as exc:
            raise TransientDeliveryError(f"SNS: {exc}") from exc
        return
    # twilio
    sid, token = settings.TWILIO_ACCOUNT_SID, settings.TWILIO_AUTH_TOKEN
    if not (sid and token and settings.TWILIO_FROM):
        raise PermanentDeliveryError("Twilio не настроен")
    request = urllib.request.Request(
        f"https://api.twilio.com/2010-04-01/Accounts/{sid}/Messages.json",
        data=urllib.parse.urlencode({"To": to, "From": settings.TWILIO_FROM, "Body": text}).encode(),
        method="POST",
        headers={
            "Authorization": "Basic " + base64.b64encode(f"{sid}:{token}".encode()).decode(),
            "Content-Type": "application/x-www-form-urlencoded",
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=15):
            pass
    except urllib.error.HTTPError as exc:
        if 400 <= exc.code < 500 and exc.code != 429:
            raise PermanentDeliveryError(f"Twilio ответил {exc.code}") from exc
        raise TransientDeliveryError(f"Twilio ответил {exc.code}") from exc
    except (urllib.error.URLError, TimeoutError) as exc:
        raise TransientDeliveryError(f"Twilio: {exc}") from exc


def send_email(*, to: str, subject: str, text: str) -> None:
    backend = settings.NOTIFY_EMAIL_BACKEND
    if backend == "none":
        raise PermanentDeliveryError("Почта не настроена (SMTP_HOST)")
    if backend == "log":
        logger.info("EMAIL to=%s subject=%r\n%s", to, subject, text)
        return
    message = EmailMessage()
    message["From"] = settings.SMTP_FROM or "lemko@localhost"
    message["To"] = to
    message["Subject"] = subject
    message.set_content(text)
    try:
        with smtplib.SMTP(settings.SMTP_HOST, settings.SMTP_PORT, timeout=15) as smtp:
            if settings.SMTP_STARTTLS:
                smtp.starttls()
            if settings.SMTP_USERNAME:
                smtp.login(settings.SMTP_USERNAME, settings.SMTP_PASSWORD or "")
            smtp.send_message(message)
    except smtplib.SMTPRecipientsRefused as exc:
        raise PermanentDeliveryError(f"Адрес отклонён: {to}") from exc
    except (smtplib.SMTPException, OSError) as exc:
        raise TransientDeliveryError(f"SMTP: {exc}") from exc


_APPOINTMENT_SUBJECTS = {
    models.NotificationEventType.APPOINTMENT_CREATED: "Appointment booked",
    models.NotificationEventType.APPOINTMENT_RESCHEDULED: "Appointment rescheduled",
    models.NotificationEventType.APPOINTMENT_CANCELLED: "Appointment cancelled",
}


def appointment_message(row: models.NotificationOutbox) -> tuple[str, str]:
    payload = row.payload or {}
    tz = ZoneInfo(payload.get("timezone") or "UTC")
    starts = datetime.fromisoformat(payload["starts_at"]).astimezone(tz) if payload.get("starts_at") else None
    when = starts.strftime("%a %d %b %Y, %H:%M") if starts else ""
    subject = _APPOINTMENT_SUBJECTS.get(row.event_type, "Appointment update")
    client = (payload.get("client") or {}).get("name", "")
    text = f"{subject}: {payload.get('title') or 'visit'} · {when}"
    if row.recipient_kind == models.NotificationRecipientKind.USER and client:
        text += f" · client {client}"
    return subject, text


def deliver(db: Session, row: models.NotificationOutbox) -> None:
    payload = row.payload or {}
    kind = row.recipient_kind
    if kind == models.NotificationRecipientKind.WEBHOOK:
        hook = db.get(models.Webhook, row.recipient_id)
        if hook is None or hook.company_id != row.company_id:
            raise PermanentDeliveryError("Вебхук удалён")
        if not hook.is_active:
            raise PermanentDeliveryError("Вебхук отключён")
        body = integrations.webhook_delivery_body(payload)
        post_json(
            hook.url,
            body,
            {
                "X-Lemko-Event": str(payload.get("event", row.event_type.value)),
                "X-Lemko-Delivery": str(row.id),
                "X-Lemko-Signature": integrations.sign_payload(integrations.webhook_secret(hook), body),
            },
        )
    elif kind == models.NotificationRecipientKind.HTTP:
        post_json(
            payload["url"],
            integrations.webhook_delivery_body(payload.get("body") or {}),
            {"X-Lemko-Event": "outbox.http", "X-Lemko-Delivery": str(row.id)},
        )
    elif kind == models.NotificationRecipientKind.EMAIL:
        send_email(to=payload["to"], subject=payload.get("subject") or "Lemko CRM", text=payload.get("text") or "")
    elif kind == models.NotificationRecipientKind.SMS:
        send_sms(to=payload["to"], text=payload.get("text") or "")
    elif kind == models.NotificationRecipientKind.USER:
        user = db.get(models.User, row.recipient_id)
        address = notifications.user_email(user) if user else None
        if not address:
            raise PermanentDeliveryError("У сотрудника нет email")
        subject, text = (
            (payload["subject"], payload.get("text") or payload["subject"])
            if "subject" in payload
            else appointment_message(row)
        )
        send_email(to=address, subject=subject, text=text)
    elif kind == models.NotificationRecipientKind.CLIENT:
        client = db.get(models.Client, row.recipient_id)
        if client is None or not client.email:
            raise PermanentDeliveryError("У клиента нет email (SMS-шлюз не подключён)")
        subject, text = appointment_message(row)
        send_email(to=client.email, subject=subject, text=text)
    else:
        raise PermanentDeliveryError(f"Неизвестный получатель: {kind}")


# --------------------------------------------------------------------------- #
#  Outbox
# --------------------------------------------------------------------------- #

def claim(db: Session, *, batch: int) -> list[int]:
    now = utcnow()
    # Строки, зависшие в processing после падения воркера, возвращаем в очередь.
    db.execute(
        update(models.NotificationOutbox)
        .where(
            models.NotificationOutbox.status == models.OutboxStatus.PROCESSING,
            models.NotificationOutbox.updated_at < now - STALE_PROCESSING,
        )
        .values(status=models.OutboxStatus.PENDING)
    )
    ids = list(
        db.scalars(
            select(models.NotificationOutbox.id)
            .where(
                models.NotificationOutbox.status == models.OutboxStatus.PENDING,
                or_(models.NotificationOutbox.retry_at.is_(None), models.NotificationOutbox.retry_at <= now),
            )
            .order_by(models.NotificationOutbox.created_at)
            .limit(batch)
            .with_for_update(skip_locked=True)
        )
    )
    if ids:
        db.execute(
            update(models.NotificationOutbox)
            .where(models.NotificationOutbox.id.in_(ids))
            .values(status=models.OutboxStatus.PROCESSING, attempts=models.NotificationOutbox.attempts + 1)
        )
    db.commit()
    return ids


def process(db: Session, row_id: int) -> str:
    row = db.get(models.NotificationOutbox, row_id)
    if row is None or row.status != models.OutboxStatus.PROCESSING:
        return "skipped"
    try:
        deliver(db, row)
    except PermanentDeliveryError as exc:
        row.status, row.processed_at, row.last_error = models.OutboxStatus.FAILED, utcnow(), str(exc)
        outcome = "failed"
    except Exception as exc:  # noqa: BLE001 — любой сбой доставки считаем временным
        row.last_error = str(exc)[:2000]
        if row.attempts >= settings.WORKER_MAX_ATTEMPTS:
            row.status, row.processed_at = models.OutboxStatus.FAILED, utcnow()
            outcome = "failed"
        else:
            row.status = models.OutboxStatus.PENDING
            row.retry_at = utcnow() + timedelta(seconds=backoff_seconds(row.attempts))
            outcome = "retry"
    else:
        row.status, row.processed_at, row.last_error = models.OutboxStatus.SENT, utcnow(), None
        outcome = "sent"
    # Коды и ссылки входа не должны оставаться в БД после доставки (или окончательной ошибки).
    if row.status != models.OutboxStatus.PENDING and (row.payload or {}).get("sensitive"):
        row.payload = {
            **row.payload,
            "text": "[redacted]",
            "subject": "[redacted]" if "subject" in row.payload else None,
        }
    db.commit()
    return outcome


def deliver_outbox(db: Session) -> int:
    ids = claim(db, batch=settings.WORKER_BATCH_SIZE)
    for row_id in ids:
        logger.debug("outbox #%s → %s", row_id, process(db, row_id))
    return len(ids)


# --------------------------------------------------------------------------- #
#  Напоминания и дайджест
# --------------------------------------------------------------------------- #

def _companies(db: Session) -> list[models.Company]:
    return list(
        db.scalars(
            select(models.Company)
            .join(models.WorkspaceSettings, models.WorkspaceSettings.company_id == models.Company.id)
            .where(models.Company.is_active.is_(True))
        )
    )


def send_due_reminders(db: Session) -> int:
    """Ответственному — за сутки до даты записи (задачи, визиты, счета…), один раз на дату."""
    now = utcnow()
    sent = 0
    for company in _companies(db):
        ctx = records.Ctx(db, company, None, source="schedule")
        for entity in workspace.entity_defs(db, company.id).values():
            owner_key, date_key = entity.get("ownerField"), entity.get("dateField")
            if not owner_key or not date_key:
                continue
            for record in records.list_records(ctx, entity["key"]):
                when = stats.parse_moment(record.get(date_key))
                user_id = notifications.member_id(record.get(owner_key))
                if not when or not user_id or not now < when <= now + REMINDER_WINDOW:
                    continue
                if not stats.is_open(entity, record):
                    continue
                already = db.scalar(
                    select(models.Activity.id).where(
                        models.Activity.company_id == company.id,
                        models.Activity.kind == "reminder",
                        models.Activity.record_id == record["id"],
                        models.Activity.recipient_user_id == user_id,
                        models.Activity.meta["due"].astext == str(record.get(date_key)),
                    )
                )
                user = db.get(models.User, user_id)
                if already or user is None or not user.is_active or user.deleted_at is not None:
                    continue
                local = when.astimezone(ZoneInfo(company.timezone or "UTC"))
                notifications.notify(
                    db,
                    company_id=company.id,
                    user=user,
                    event="reminder",
                    entity=entity["key"],
                    record_id=record["id"],
                    title=f"Due {local:%a %H:%M} · {workspace.record_title(entity, record)}",
                    body=f"{workspace.singular(entity, entity['key'])} is due {local:%A %d %b, %H:%M}.",
                    meta={"due": str(record.get(date_key))},
                    params={**activities.record_params(entity, entity["key"], record), "at": when.isoformat()},
                )
                sent += 1
        db.commit()
    return sent


def digest_summary(db: Session, company: models.Company, user: models.User, since: datetime) -> list[dict[str, Any]]:
    """Сводка по объектам: новых, выиграно (и на сумму), открытых на сотруднике."""
    ctx = records.Ctx(db, company, user, source="schedule")
    lines: list[dict[str, Any]] = []
    for entity in workspace.entity_defs(db, company.id).values():
        rows = records.list_records(ctx, entity["key"])
        created = [r for r in rows if (stats.parse_moment(r.get("createdAt")) or since) >= since]
        line: dict[str, Any] = {"entity": entity["key"], "label": entity.get("label") or entity["key"], "created": len(created)}
        if entity.get("stageField"):
            won = [r for r in rows if stats.is_won(entity, r) and (stats.parse_moment(r.get("closedAt")) or since) >= since]
            if won:
                line["won"] = len(won)
                amount = entity.get("amountField")
                if amount:
                    line["wonTotal"] = float(sum(stats.to_number(r.get(amount)) for r in won))
        owner_key = entity.get("ownerField")
        if owner_key:
            mine = [r for r in rows if r.get(owner_key) == f"u_{user.id}" and stats.is_open(entity, r)]
            if mine:
                line["mine"] = len(mine)
        lines.append(line)
    return lines


def digest_text(company: models.Company, summary: list[dict[str, Any]]) -> str:
    lines = [f"Your week in {company.name}:"]
    for item in summary:
        line = f"• {item['label']}: {item['created']} new"
        if item.get("won"):
            line += f", {item['won']} closed won" + (f" ({item['wonTotal']:,.0f})" if "wonTotal" in item else "")
        if item.get("mine"):
            line += f", {item['mine']} open assigned to you"
        lines.append(line)
    return "\n".join(lines)


def send_weekly_digests(db: Session) -> int:
    """По понедельникам с 08:00 по времени компании — сводка за неделю тем, кто её включил."""
    now = utcnow()
    sent = 0
    for company in _companies(db):
        local = now.astimezone(ZoneInfo(company.timezone or "UTC"))
        if local.weekday() != 0 or local.hour < 8:
            continue
        users = db.scalars(
            select(models.User).where(
                models.User.company_id == company.id,
                models.User.is_active.is_(True),
                models.is_alive(models.User),
            )
        )
        for user in users:
            prefs = activities.notification_prefs(user)["digest"]
            last = (user.preferences or {}).get("digestSentAt")
            if not (prefs["email"] or prefs["inApp"]) or (last and datetime.fromisoformat(last) > now - timedelta(days=6)):
                continue
            summary = digest_summary(db, company, user, now - timedelta(days=7))
            text = digest_text(company, summary)
            if prefs["inApp"]:
                activities.log(
                    db,
                    company_id=company.id,
                    entity="workspace",
                    record_id="digest",
                    kind="digest",
                    title="Weekly digest",
                    body=text,
                    recipient_user_id=user.id,
                    event="digest",
                    params={"company": company.name, "lines": summary},
                )
            if prefs["email"]:
                notifications.email_user(db, company_id=company.id, user=user, subject=f"Weekly digest · {company.name}", text=text)
            user.preferences = {**(user.preferences or {}), "digestSentAt": now.isoformat()}
            sent += 1
        db.commit()
    return sent


# --------------------------------------------------------------------------- #
#  Цикл
# --------------------------------------------------------------------------- #

class Worker:
    def __init__(self) -> None:
        self.next_reminders = utcnow()
        self.next_digest = utcnow()

    def tick(self) -> dict[str, Any]:
        done: dict[str, Any] = {}
        with SessionLocal() as db:
            done["outbox"] = deliver_outbox(db)
            now = utcnow()
            if now >= self.next_reminders:
                done["reminders"] = _safely("reminders", send_due_reminders, db)
                self.next_reminders = now + REMINDER_EVERY
            if now >= self.next_digest:
                done["digests"] = send_weekly_digests(db)
                done["cleanup"] = cleanup_security_rows(db)
                self.next_digest = now + DIGEST_EVERY
        return done


def _safely(name: str, job, db: Session) -> int:
    """Сбой одной фоновой задачи не останавливает остальные (и доставку outbox)."""
    try:
        return job(db)
    except Exception:  # noqa: BLE001
        db.rollback()
        logger.exception("%s failed", name)
        return 0


def cleanup_security_rows(db: Session) -> int:
    """Раз в час: истёкшие одноразовые проверки, старые окна лимитов и сессии."""
    now = utcnow()
    removed = db.execute(
        delete(models.AuthChallenge).where(models.AuthChallenge.expires_at < now - timedelta(days=1))
    ).rowcount or 0
    removed += ratelimit.prune(db)
    removed += db.execute(
        delete(models.AuthSession).where(models.AuthSession.expires_at < now - timedelta(days=30))
    ).rowcount or 0
    db.commit()
    return removed


def main() -> None:
    parser = argparse.ArgumentParser(description="Lemko worker: outbox, reminders, digest")
    parser.add_argument("--once", action="store_true", help="один проход и выход")
    args = parser.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")

    stopping = False

    def _stop(*_args: object) -> None:
        nonlocal stopping
        stopping = True

    signal.signal(signal.SIGTERM, _stop)
    signal.signal(signal.SIGINT, _stop)

    worker = Worker()
    logger.info("worker started (email backend: %s)", settings.NOTIFY_EMAIL_BACKEND)
    while not stopping:
        done = worker.tick()
        if args.once:
            logger.info("done: %s", done)
            break
        if not done.get("outbox"):
            time.sleep(settings.WORKER_POLL_SECONDS)
    logger.info("worker stopped")


if __name__ == "__main__":
    main()
