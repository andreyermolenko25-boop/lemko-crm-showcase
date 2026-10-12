"""
Что происходит после изменения записи CRM (records.py): лента, личные
уведомления и вебхуки record.* — в той же транзакции, что и сама запись.
"""

from __future__ import annotations

import activities
import integrations
import notifications
import workspace


def record_changed(ctx, change) -> None:
    entity_def = workspace.entity_def(ctx.db, ctx.company.id, change.entity)
    activities.log_change(ctx, change, entity_def)
    notifications.on_change(ctx, change, entity_def)
    integrations.enqueue_record_webhooks(ctx.db, company_id=ctx.company.id, change=change)
